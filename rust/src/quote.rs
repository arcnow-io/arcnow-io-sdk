//! Quote tokens: what a curve, a pool or a launch is priced in, the allowance
//! an ERC-20 quote needs, and the on-chain allowlist of them.
//!
//! # Native USDC needs nothing; an ERC-20 quote needs an allowance
//!
//! A native curve is paid with `msg.value`, and there is nothing to approve. A
//! curve quoted in EURC pulls EURC from the buyer with `transferFrom`, so the
//! buyer's allowance to the **curve** (or the launchpad, or the v4 router) must
//! cover the amount first. [`QuoteToken::ensure_allowance`] is that step:
//!
//! * native: nothing to do, and no RPC at all;
//! * ERC-20: read the allowance; if it already covers the amount send nothing;
//!   otherwise approve **exactly** the amount — never an unlimited approval —
//!   and wait for the receipt.
//!
//! Every buy and launch in this crate calls it for you on an ERC-20 quote.
//!
//! # RPC economy
//!
//! The public Arc endpoint is rate-limited. Quote metadata comes from
//! `networks.json` first, then one Multicall3 read that is cached per client
//! (a failed read is never cached). A balance and an allowance that are needed
//! together travel in ONE Multicall3 call ([`QuoteToken::spend_state`]).
//! [`QuoteRegistry::list`] takes at most three `eth_call`s whatever the length
//! of the list.

use std::future::Future;

use alloy::primitives::{Address, B256, U256};
use alloy::providers::DynProvider;
use alloy::rpc::types::state::{StateOverride, StateOverridesBuilder};
use alloy::sol_types::SolCall;

use crate::amount::{QuoteAmount, QuoteTokenInfo};
use crate::bindings::erc20::IERC20Metadata;
use crate::bindings::multicall3::IMulticall3;
use crate::bindings::quote_registry::QuoteRegistry as RegistryAbi;
use crate::client::Client;
use crate::constants::MULTICALL3;
use crate::curve_math;
use crate::error::{Error, decode_revert};

/// The share of the node's gas estimate added on top for an ERC-20 trade, in
/// basis points: a fifth.
pub const QUOTE_TRANSFER_GAS_HEADROOM_BPS: u64 = 2_000;

/// The least gas added on top of the estimate for an ERC-20 trade.
pub const QUOTE_TRANSFER_GAS_HEADROOM_MIN: u64 = 150_000;

/// The least gas added on top of the estimate for a swap in an ERC-20-quoted pool.
pub const POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN: u64 = 400_000;

/// The gas limit a swap in an ERC-20-quoted pool is sent with, given the node's
/// estimate: a fifth more, and never less than 400,000 more.
///
/// More than a curve trade gets (review L-1): a swap's estimate can miss the fee
/// hook redeeming and distributing its accrued fee — an accrual that was zero
/// when estimated, until a front-running dust swap made it not — and every
/// ERC-20 share it then pushes needs 111,587 gas left before it.
#[must_use]
pub const fn with_pool_quote_transfer_headroom(estimate: u64) -> u64 {
    with_headroom(estimate, POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN)
}

/// The gas limit this SDK sends an ERC-20 trade with, given the node's estimate.
#[must_use]
pub const fn with_quote_transfer_headroom(estimate: u64) -> u64 {
    with_headroom(estimate, QUOTE_TRANSFER_GAS_HEADROOM_MIN)
}

/// `estimate` plus a fifth of it, and never less than `min` more.
const fn with_headroom(estimate: u64, min: u64) -> u64 {
    // A fifth, computed without overflowing: whole ten-thousandths, then the rest.
    let share = (estimate / 10_000) * QUOTE_TRANSFER_GAS_HEADROOM_BPS
        + (estimate % 10_000) * QUOTE_TRANSFER_GAS_HEADROOM_BPS / 10_000;
    let extra = if share > min { share } else { min };
    estimate.saturating_add(extra)
}

/// The gas limit to send a non-graduating ERC-20-quoted trade or launch with:
/// `max(limit, estimate + headroom)`.
///
/// arcnow.io's contracts push every ERC-20 fee share through a gas guard that
/// reverts with no data when too little gas remains, and a node's estimate can
/// land right at that edge. So the node's estimate plus
/// [`with_quote_transfer_headroom`] is the least this SDK sends: a caller's
/// `limit` below it is raised to it, never refused, and one above it is kept.
/// An estimate that reverts empty is [`Error::QuoteTransferOutOfGas`].
pub(crate) async fn erc20_trade_gas<P, D>(
    call: &alloy::contract::CallBuilder<P, D>,
    limit: Option<u64>,
    quote: &QuoteTokenInfo,
    context: &str,
    headroom: fn(u64) -> u64,
) -> Result<u64, Error>
where
    P: alloy::providers::Provider + Clone,
    D: alloy::contract::CallDecoder + Clone,
{
    let safe = call
        .estimate_gas()
        .await
        .map(headroom)
        .map_err(|err| Error::from_contract(err, context).on_erc20_quote(quote, None))?;
    Ok(limit.map_or(safe, |limit| limit.max(safe)))
}

/// A state override granting `spender` an unlimited allowance of `owner`'s
/// `quote`, for simulating a spend before it has been approved.
///
/// `None` for native USDC (nothing to approve) and for an ERC-20 whose
/// allowance mapping slot `networks.json` does not record — the simulation is
/// then skipped rather than run against a guessed slot.
#[must_use]
pub fn allowance_override(
    client: &Client,
    quote: &QuoteTokenInfo,
    owner: Address,
    spender: Address,
) -> Option<StateOverride> {
    if quote.is_native {
        return None;
    }
    let slot = client.network().quote_allowance_slot(quote.address)?;
    Some(
        StateOverridesBuilder::default()
            .with_state_diff(
                quote.address,
                [(crate::pool::erc20_allowance_slot(owner, spender, slot), B256::from(U256::MAX))],
            )
            .build(),
    )
}

// ---------------------------------------------------------------------------
// one Multicall3 round trip, with every call's own revert kept
// ---------------------------------------------------------------------------

/// Calls to send in one `aggregate3`, each allowed to fail on its own so that
/// its revert decodes as itself rather than as "Multicall3: call failed".
#[derive(Default)]
pub(crate) struct Batch {
    calls: Vec<IMulticall3::Call3>,
}

impl Batch {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Queue `call` on `target`, returning its index in the answers.
    pub(crate) fn push<C: SolCall>(&mut self, target: Address, call: &C) -> usize {
        self.calls.push(IMulticall3::Call3 {
            target,
            allowFailure: true,
            callData: call.abi_encode().into(),
        });
        self.calls.len() - 1
    }

    /// Send the batch as ONE `eth_call`. An empty batch sends nothing.
    pub(crate) async fn run(self, client: &Client, context: &str) -> Result<Answers, Error> {
        if self.calls.is_empty() {
            return Ok(Answers(Vec::new()));
        }
        let results = IMulticall3::new(MULTICALL3, client.provider().clone())
            .aggregate3(self.calls)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, context))?;
        Ok(Answers(results))
    }
}

/// What a [`Batch`] answered, call by call.
pub(crate) struct Answers(Vec<IMulticall3::Result>);

impl Answers {
    /// Decode call `index` as `C`, or the revert it answered with.
    pub(crate) fn decode<C: SolCall>(
        &self,
        index: usize,
        context: &str,
    ) -> Result<C::Return, Error> {
        let answer = self.0.get(index).ok_or_else(|| {
            Error::abi(context, format!("Multicall3 answered no result at index {index}"))
        })?;
        if !answer.success {
            return Err(decode_revert(&answer.returnData));
        }
        C::abi_decode_returns(&answer.returnData).map_err(|err| Error::abi(context, err))
    }
}

/// Queue `symbol`, `name` and `decimals` of `token`, returning their indices.
fn push_metadata(batch: &mut Batch, token: Address) -> [usize; 3] {
    [
        batch.push(token, &IERC20Metadata::symbolCall {}),
        batch.push(token, &IERC20Metadata::nameCall {}),
        batch.push(token, &IERC20Metadata::decimalsCall {}),
    ]
}

/// Decode what [`push_metadata`] queued into a validated ERC-20 quote.
fn decode_metadata(
    answers: &Answers,
    token: Address,
    [symbol, name, decimals]: [usize; 3],
) -> Result<QuoteTokenInfo, Error> {
    let context = "reading a quote token's symbol, name and decimals";
    QuoteTokenInfo::erc20(
        token,
        answers.decode::<IERC20Metadata::symbolCall>(symbol, context)?,
        answers.decode::<IERC20Metadata::nameCall>(name, context)?,
        answers.decode::<IERC20Metadata::decimalsCall>(decimals, context)?,
    )
}

/// An ERC-20's metadata in one Multicall3 call. Uncached; see
/// [`Client::quote_token_info`], which caches.
pub(crate) async fn read_metadata(
    client: &Client,
    token: Address,
) -> Result<QuoteTokenInfo, Error> {
    let mut batch = Batch::new();
    let indices = push_metadata(&mut batch, token);
    let answers = batch.run(client, "reading a quote token's metadata").await?;
    decode_metadata(&answers, token, indices)
}

// ---------------------------------------------------------------------------
// the token handle
// ---------------------------------------------------------------------------

/// What [`QuoteToken::ensure_allowance`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsureAllowance {
    /// True when an approval was sent and mined.
    pub approved: bool,
    /// The approval transaction, when one was sent.
    pub tx_hash: Option<B256>,
    /// The allowance the spender has now: what was read when it already
    /// covered the amount, the approved amount otherwise. `None` for native
    /// USDC, which has no allowance.
    pub allowance: Option<QuoteAmount>,
}

/// A balance and, optionally, an allowance, read together in one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendState {
    /// The owner's balance of the quote.
    pub balance: QuoteAmount,
    /// The owner's allowance to the spender asked about. `None` for native
    /// USDC and when no spender was named.
    pub allowance: Option<QuoteAmount>,
}

/// One quote token: native USDC or an ERC-20. Get one with
/// [`Client::quote_token`] or [`Client::quote_token_for`].
#[derive(Debug, Clone)]
pub struct QuoteToken<'a> {
    client: &'a Client,
    info: QuoteTokenInfo,
}

impl<'a> QuoteToken<'a> {
    pub(crate) fn new(client: &'a Client, info: QuoteTokenInfo) -> Self {
        Self { client, info }
    }

    /// The token's description.
    #[must_use]
    pub fn info(&self) -> &QuoteTokenInfo {
        &self.info
    }

    /// The token's address; the zero address for native USDC.
    #[must_use]
    pub fn address(&self) -> Address {
        self.info.address
    }

    fn contract(&self) -> IERC20Metadata::IERC20MetadataInstance<DynProvider> {
        IERC20Metadata::new(self.info.address, self.client.provider().clone())
    }

    fn refuse_native(&self, what: &str) -> Result<(), Error> {
        if self.info.is_native {
            return Err(Error::InvalidArgument {
                reason: format!(
                    "native USDC has no {what}: it is paid as the transaction's value, and no \
                     arcnow.io call needs an approval for it"
                ),
            });
        }
        Ok(())
    }

    /// `account`'s balance: `eth_getBalance` for native USDC, `balanceOf`
    /// scaled up to a wad for an ERC-20.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn balance_of(&self, account: Address) -> Result<QuoteAmount, Error> {
        if self.info.is_native {
            return self.client.balance(account).await;
        }
        let raw = self
            .contract()
            .balanceOf(account)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a quote token balance"))?;
        QuoteAmount::from_raw_in(&self.info, raw)
    }

    /// What `owner` has approved `spender` to pull. ERC-20 only.
    ///
    /// # Errors
    /// [`Error::InvalidArgument`] for native USDC, before any RPC;
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn allowance(&self, owner: Address, spender: Address) -> Result<QuoteAmount, Error> {
        self.refuse_native("allowance")?;
        let raw = self
            .contract()
            .allowance(owner, spender)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a quote token allowance"))?;
        QuoteAmount::from_raw_in(&self.info, raw)
    }

    /// Approve `spender` to pull **exactly** `amount` of the signer's quote.
    ///
    /// # Errors
    /// Before any RPC: [`Error::SignerRequired`]; [`Error::InvalidArgument`] for
    /// native USDC; [`Error::QuoteTokenMismatch`] for an amount in another
    /// quote; [`Error::QuoteAmountNotRepresentable`]. Then any revert, decoded.
    pub async fn approve(&self, spender: Address, amount: &QuoteAmount) -> Result<B256, Error> {
        let from = self.client.require_signer("QuoteToken::approve")?;
        self.refuse_native("approval")?;
        self.info.require_same(amount.token())?;
        let raw = amount.to_raw()?;
        let pending = self
            .contract()
            .approve(spender, raw)
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "approving a quote token spender"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the quote approval receipt", err))?;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
        }
        Ok(receipt.transaction_hash)
    }

    /// Make sure `spender` may pull `amount` of the signer's quote.
    ///
    /// Native USDC: nothing to do, answered with no RPC. An ERC-20: the
    /// allowance is read, and when it already covers `amount` nothing is sent;
    /// otherwise **exactly** `amount` is approved (never an unlimited approval)
    /// and the receipt is waited for.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] and [`Error::QuoteAmountNotRepresentable`]
    /// before any RPC; [`Error::SignerRequired`] on a read-only client for an
    /// ERC-20; then anything [`QuoteToken::approve`] returns.
    pub async fn ensure_allowance(
        &self,
        spender: Address,
        amount: &QuoteAmount,
    ) -> Result<EnsureAllowance, Error> {
        self.ensure_allowance_after(spender, amount, || async { Ok(()) }).await
    }

    /// [`QuoteToken::ensure_allowance`], running `before_approve` only when an
    /// approval is about to be sent, and sending nothing if it fails.
    ///
    /// The SDK's own write paths pass a simulation of the spend here, with the
    /// allowance overridden ([`allowance_override`]), so a spend that would
    /// revert is refused by name **before** an approval is left behind for it.
    ///
    /// # Errors
    /// As [`QuoteToken::ensure_allowance`], plus whatever `before_approve`
    /// returns.
    pub async fn ensure_allowance_after<F, Fut>(
        &self,
        spender: Address,
        amount: &QuoteAmount,
        before_approve: F,
    ) -> Result<EnsureAllowance, Error>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), Error>>,
    {
        self.info.require_same(amount.token())?;
        if self.info.is_native {
            return Ok(EnsureAllowance { approved: false, tx_hash: None, allowance: None });
        }
        let owner = self.client.require_signer("QuoteToken::ensure_allowance")?;
        let needed = amount.to_raw()?;
        let current = self.allowance(owner, spender).await?;
        if current.to_wad() >= amount.to_wad() {
            return Ok(EnsureAllowance {
                approved: false,
                tx_hash: None,
                allowance: Some(current),
            });
        }
        debug_assert!(needed > U256::ZERO);
        before_approve().await?;
        let tx_hash = self.approve(spender, amount).await?;
        Ok(EnsureAllowance {
            approved: true,
            tx_hash: Some(tx_hash),
            allowance: Some(amount.clone()),
        })
    }

    /// `owner`'s balance and, for an ERC-20 with a `spender` named, its
    /// allowance to that spender — in ONE Multicall3 `eth_call`. Native USDC's
    /// balance is read through `Multicall3.getEthBalance`.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or a decoded revert.
    pub async fn spend_state(
        &self,
        owner: Address,
        spender: Option<Address>,
    ) -> Result<SpendState, Error> {
        let context = "reading a quote balance and allowance";
        let mut batch = Batch::new();
        if self.info.is_native {
            let balance = batch.push(MULTICALL3, &IMulticall3::getEthBalanceCall { addr: owner });
            let answers = batch.run(self.client, context).await?;
            let wad = answers.decode::<IMulticall3::getEthBalanceCall>(balance, context)?;
            return Ok(SpendState {
                balance: QuoteAmount::from_wad_in(&self.info, wad),
                allowance: None,
            });
        }
        let balance =
            batch.push(self.info.address, &IERC20Metadata::balanceOfCall { account: owner });
        let allowance = spender.map(|spender| {
            batch.push(self.info.address, &IERC20Metadata::allowanceCall { owner, spender })
        });
        let answers = batch.run(self.client, context).await?;
        let balance = QuoteAmount::from_raw_in(
            &self.info,
            answers.decode::<IERC20Metadata::balanceOfCall>(balance, context)?,
        )?;
        let allowance = match allowance {
            Some(index) => Some(QuoteAmount::from_raw_in(
                &self.info,
                answers.decode::<IERC20Metadata::allowanceCall>(index, context)?,
            )?),
            None => None,
        };
        Ok(SpendState { balance, allowance })
    }
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

/// One quote as the registry records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteInfo {
    /// The decimals the registry recorded.
    pub decimals: u8,
    /// The flat launch fee in this quote.
    pub launch_fee: QuoteAmount,
    /// True when a launch may use this quote now.
    pub active: bool,
}

/// One entry of [`QuoteRegistry::list`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteTokenListing {
    /// The quote, with its metadata.
    pub token: QuoteTokenInfo,
    /// The flat launch fee in this quote.
    pub launch_fee: QuoteAmount,
    /// True when a launch may use this quote now; deregistered quotes stay
    /// listed, inactive.
    pub active: bool,
}

/// The on-chain allowlist of quote tokens, `arcnow/quote-registry@1.x.x`. Get
/// one with [`Client::quote_registry`].
#[derive(Debug, Clone, Copy)]
pub struct QuoteRegistry<'a> {
    client: &'a Client,
    address: Address,
}

impl<'a> QuoteRegistry<'a> {
    pub(crate) fn new(client: &'a Client, address: Address) -> Self {
        Self { client, address }
    }

    /// The registry's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    fn contract(&self) -> RegistryAbi::QuoteRegistryInstance<DynProvider> {
        RegistryAbi::new(self.address, self.client.provider().clone())
    }

    /// The registry's `VERSION()`, refused unless it is
    /// `arcnow/quote-registry@1.x.x`. Read once per client.
    ///
    /// # Errors
    /// [`Error::UnknownCurveVersion`] for another major; [`Error::Rpc`].
    pub async fn version(&self) -> Result<String, Error> {
        let version = self
            .client
            .version_of(self.address, async {
                self.contract().VERSION().call().await.map_err(|err| {
                    Error::from_contract(err, "reading the quote registry's VERSION()")
                })
            })
            .await?;
        curve_math::check_quote_registry_version(&version)?;
        Ok(version)
    }

    /// How many quotes were ever registered, inactive ones included.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn count(&self) -> Result<u64, Error> {
        let raw = self
            .contract()
            .quoteTokenCount()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the quote token count"))?;
        count_to_u64(raw)
    }

    /// The `index`-th quote ever registered.
    ///
    /// # Errors
    /// [`Error::Rpc`], or a revert past [`QuoteRegistry::count`].
    pub async fn at(&self, index: u64) -> Result<Address, Error> {
        self.contract()
            .quoteTokenAt(U256::from(index))
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a quote token by index"))
    }

    /// True when `quote` is registered **and active**: a launch may use it.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn is_quote_token(&self, quote: Address) -> Result<bool, Error> {
        self.contract().isQuoteToken(quote).call().await.map_err(|err| {
            Error::from_contract(err, "checking whether an address is a quote token")
        })
    }

    /// What the registry records for `quote`, with the launch fee in that
    /// quote. One `eth_call` (plus the metadata of a quote nothing has
    /// described yet, in the same call).
    ///
    /// # Errors
    /// `QuoteTokenNotRegistered`, decoded, for a quote never registered;
    /// [`Error::UnknownCurveVersion`] for a registry of another major.
    pub async fn info(&self, quote: Address) -> Result<QuoteInfo, Error> {
        let context = "reading a quote token's registry entry";
        let mut batch = Batch::new();
        let version = self.push_version(&mut batch);
        let info = batch.push(self.address, &RegistryAbi::quoteInfoCall { quote });
        let known = self.client.known_quote(quote);
        let metadata = known.is_none().then(|| push_metadata(&mut batch, quote));
        let answers = batch.run(self.client, context).await?;
        self.check_version(&answers, version, context)?;
        let entry = answers.decode::<RegistryAbi::quoteInfoCall>(info, context)?;
        let token = self.resolve_token(quote, known, &answers, metadata)?;
        Ok(QuoteInfo {
            decimals: entry.decimals,
            launch_fee: QuoteAmount::from_wad_in(&token, entry.launchFeeWad),
            active: entry.active,
        })
    }

    /// Every quote ever registered, with its metadata, launch fee and whether
    /// it is active — in at most three `eth_call`s: the count, every address,
    /// then every entry and any metadata not already known.
    ///
    /// # Errors
    /// [`Error::UnknownCurveVersion`] for a registry of another major;
    /// [`Error::Rpc`]; any revert, decoded.
    pub async fn list(&self) -> Result<Vec<QuoteTokenListing>, Error> {
        let context = "listing quote tokens";
        let mut first = Batch::new();
        let version = self.push_version(&mut first);
        let count = first.push(self.address, &RegistryAbi::quoteTokenCountCall {});
        let answers = first.run(self.client, context).await?;
        self.check_version(&answers, version, context)?;
        let count =
            count_to_u64(answers.decode::<RegistryAbi::quoteTokenCountCall>(count, context)?)?;
        if count == 0 {
            return Ok(Vec::new());
        }

        let mut second = Batch::new();
        for index in 0..count {
            second.push(self.address, &RegistryAbi::quoteTokenAtCall { i: U256::from(index) });
        }
        let answers = second.run(self.client, context).await?;
        let addresses = (0..count)
            .map(|index| {
                answers.decode::<RegistryAbi::quoteTokenAtCall>(
                    usize::try_from(index).unwrap_or(usize::MAX),
                    context,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut third = Batch::new();
        let mut plans = Vec::with_capacity(addresses.len());
        for quote in &addresses {
            let info = third.push(self.address, &RegistryAbi::quoteInfoCall { quote: *quote });
            let known = self.client.known_quote(*quote);
            let metadata = known.is_none().then(|| push_metadata(&mut third, *quote));
            plans.push((*quote, info, known, metadata));
        }
        let answers = third.run(self.client, context).await?;
        plans
            .into_iter()
            .map(|(quote, info, known, metadata)| {
                let entry = answers.decode::<RegistryAbi::quoteInfoCall>(info, context)?;
                let token = self.resolve_token(quote, known, &answers, metadata)?;
                Ok(QuoteTokenListing {
                    launch_fee: QuoteAmount::from_wad_in(&token, entry.launchFeeWad),
                    active: entry.active,
                    token,
                })
            })
            .collect()
    }

    /// Queue `VERSION()` unless this client already knows it.
    fn push_version(&self, batch: &mut Batch) -> Option<usize> {
        self.client
            .cached_version(self.address)
            .is_none()
            .then(|| batch.push(self.address, &RegistryAbi::VERSIONCall {}))
    }

    fn check_version(
        &self,
        answers: &Answers,
        index: Option<usize>,
        context: &str,
    ) -> Result<(), Error> {
        let version = match index {
            Some(index) => {
                let version = answers.decode::<RegistryAbi::VERSIONCall>(index, context)?;
                self.client.remember_version(self.address, version.clone());
                version
            }
            None => self.client.cached_version(self.address).unwrap_or_default(),
        };
        curve_math::check_quote_registry_version(&version)
    }

    fn resolve_token(
        &self,
        quote: Address,
        known: Option<QuoteTokenInfo>,
        answers: &Answers,
        metadata: Option<[usize; 3]>,
    ) -> Result<QuoteTokenInfo, Error> {
        if let Some(known) = known {
            return Ok(known);
        }
        let indices =
            metadata.ok_or_else(|| Error::abi("listing quote tokens", "no metadata was read"))?;
        let info = decode_metadata(answers, quote, indices)?;
        self.client.remember_quote(info.clone());
        Ok(info)
    }
}

fn count_to_u64(raw: U256) -> Result<u64, Error> {
    u64::try_from(raw)
        .map_err(|_| Error::abi("reading the quote token count", "the count does not fit in a u64"))
}
