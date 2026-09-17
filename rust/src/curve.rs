//! The bonding curve: read it, quote it, trade it, and what happens when it
//! graduates.
//!
//! # A sell needs no allowance. Ever.
//!
//! This is the single most important thing on this page, so it is at the top.
//!
//! The curve pulls a seller's tokens with `IArcToken.curveTransferFrom`, a
//! privileged path callable only by the token's own curve, which **reads no
//! allowance at all**. A holder who has approved nobody can sell. An allowance
//! granted to the curve is not spent by a sell and is still there afterwards. An
//! approved spender still cannot use the curve's path. Selling is one
//! transaction with no approve step, and it is a deliberate, tested guarantee —
//! `contracts/test/unit/TokenCurveSell.t.sol` exists for nothing else.
//!
//! **So this SDK never emits an approve and never checks an allowance before a
//! sell.** If you are looking for an "approve if needed" helper, there is none,
//! and adding one would be getting it exactly wrong.
//!
//! The token *does* have ordinary `approve`/`allowance`/`transferFrom` for
//! everyone else — routers, other spenders — and after migration the venue's
//! canonical router, where one was registered, is auto-approved over every
//! holder. That is a separate system from the curve's privilege and the two must
//! not be confused: an allowance can be spent by whoever holds it, and the
//! curve's privilege is checked against `msg.sender` on every call.
//!
//! **And it does not rescue a post-graduation sell.** Uniswap v4 registers no
//! canonical router — its `PoolManager` settles from balances a router already
//! transferred in — so on every arcnow.io token that address is zero and a sell
//! into the graduated pool needs a real `approve`. See [`crate::pool`].
//!
//! # Buying: `msg.value` on a native curve, an allowance on an ERC-20 curve
//!
//! A curve is quoted in one token for life — [`Curve::quote_token`]. On a
//! **native USDC** curve a buy is paid as the transaction's value: no
//! allowance, no token transfer from the buyer. On an **ERC-20** curve (EURC,
//! say) the curve pulls the quote with `transferFrom`, so [`Curve::buy`] first
//! makes sure the buyer's allowance to the curve covers the amount — reading it,
//! and approving **exactly** the amount only when it does not — and then calls
//! `buyWithQuote` with no value. Every amount is an 18-decimal wad in the
//! curve's quote; an ERC-20 amount must be a whole number of the token's raw
//! units, and one that is not is refused before anything is sent. The fee
//! is taken off the input before anything enters the reserve, and the remainder
//! is integrated along the curve — so the buyer pays a rising price across their
//! own order, which is what makes an immediate round trip unprofitable.
//!
//! # Graduation
//!
//! A curve retires **permanently** once it has collected its target in *real*
//! reserve — [`CurveState::target`], this curve's own, snapshotted from its
//! platform's template at launch and immutable since. [`CurveState::graduated`] is
//! then true and every further buy and sell reverts with
//! [`Error::CurveGraduated`]. There is no admin who can reopen it.
//!
//! **The graduating buy migrates the curve itself, in the same transaction**,
//! under a bounded gas budget with its failure caught. Callers do not have to do
//! anything and nobody has to poll. [`Curve::migrate`] is the **retry** path, not
//! the normal one: when the instant migration succeeded it reverts with
//! [`Error::AlreadyMigrated`], and when it failed — the curve logged
//! `InstantMigrationFailed` — it stays open to anyone, so a stuck migrator can
//! never strand a curve.
//!
//! The buy that fills the curve is **capped at remaining inventory** and the
//! unspent USDC is **refunded** — or credited to
//! [`Curve::pending_withdrawal`] if that transfer fails. [`BuyQuote::refund`] and
//! [`BuyQuote::graduates`] let a caller see this coming.
//!
//! Where a curve graduates *to* is its own snapshotted [`CurveState::migrator`],
//! chosen at launch and immutable. On Arc testnet that is the Uniswap v4
//! migrator; v2, v3 and escrow are not deployed there. **Ask the curve, not a
//! network-wide list** — deregistering a migrator bars the next launch and
//! reaches nothing that already exists.
//!
//! After migration a trade still costs 1.00%, but the pool's own way:
//! `ArcNowFeeHook` takes 0.80% inside the v4 pool's swaps, in the pool's quote
//! token, split three ways on the pool's own split, and Uniswap's 0.20% LP fee
//! is the rest. A pool has no referrer; see [`crate::pool`].

use alloy::primitives::{Address, B256, U256};
use alloy::providers::{DynProvider, Provider};

use crate::amount::{Bps, QuoteAmount, QuoteTokenInfo, Tokens};
use crate::bindings::curve::BondingCurve as Abi;
use crate::client::{Client, cached, remember};
use crate::curve_math::{self, CurveParams, CurveSnapshot};
use crate::deadline::Deadline;
use crate::error::Error;
use crate::platform::FeeSplit;
use crate::quote::{Batch, erc20_trade_gas, with_quote_transfer_headroom as curve_headroom};

/// Everything worth knowing about a curve right now, in one batched read.
///
/// **The version comes first.** [`Curve::state`] reads the curve's `VERSION()`
/// and refuses anything but `arcnow/bonding-curve@4.x.x` before it reads
/// another word, so every number here is a fee-model constant-product
/// curve's, and every amount is in [`CurveState::quote_token`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurveState {
    /// The curve's `VERSION()`, verbatim — `arcnow/bonding-curve@4.0.0`, say.
    pub version: String,
    /// What this curve is priced and paid in, for life. Immutable.
    pub quote_token: QuoteTokenInfo,
    /// The curve's immutable pricing parameters, `{r0_wad, y0_wad}`.
    pub params: CurveParams,
    /// Tokens the curve sells over its whole life. Immutable.
    pub curve_supply: Tokens,
    /// The trade fee this curve charges, in bps of a trade. Immutable.
    pub trade_fee_bps: Bps,
    /// The token this curve trades. Immutable.
    pub token: Address,
    /// Who receives the creator share of every fee.
    ///
    /// Read through to the token's creator seat, which is transferable by its
    /// holder — so a creator whose address is blocklisted on Arc has somewhere
    /// to go. The creator holds no privilege over the curve: no mint, no pause,
    /// no fee switch, no upgrade, and no ability to change the size of its own
    /// share.
    pub creator: Address,
    /// Where the curve's assets go on migration. **Immutable, snapshotted at
    /// launch.** This is the authoritative answer to "where does this token
    /// graduate to"; a network-wide venue list is not.
    pub migrator: Address,
    /// The marginal price of the next token, `floor(C(Y) · 1e18 / Y)` with
    /// `Y = y0 - tokens_sold`.
    ///
    /// **Not the price a trade of any size fills at.** The curve integrates
    /// along its own slope, so a buy pays a rising price across its own order.
    /// Use [`Curve::quote_buy`] and [`Curve::quote_sell`] for a fill.
    pub spot_price: QuoteAmount,
    /// Tokens sold so far. Never exceeds the curve's supply.
    pub tokens_sold: Tokens,
    /// Tokens the curve still holds for sale. A buy is capped at this.
    pub tokens_remaining: Tokens,
    /// Real USDC the curve owes its holders: `virtual_reserve - V0`.
    ///
    /// **This is the number compared against `target` for graduation.** After
    /// migration the money is at the migrator, not here — read `migrated` before
    /// treating it as custodied.
    pub real_reserve: QuoteAmount,
    /// The virtual USDC reserve `V`, which starts at `V0` rather than at zero.
    ///
    /// `V0` is an accounting fiction that gives the first token a positive
    /// price. It is never payable to anyone and is not counted towards
    /// graduation.
    /// After migration this is **not** rewound: it stays the permanent record of
    /// what the curve collected over its life.
    pub virtual_reserve: QuoteAmount,
    /// Real quote the curve must collect to graduate. Immutable.
    pub target: QuoteAmount,
    /// Progress towards the target, in basis points, capped at 10000.
    pub progress_bps: Bps,
    /// True once the curve reached its target. **Terminal**: every further buy
    /// and sell reverts.
    pub graduated: bool,
    /// True once the assets have been forwarded to the migrator.
    ///
    /// Usually true in the same transaction that set `graduated`, because the
    /// graduating buy attempts the migration itself. `graduated && !migrated` is
    /// the case [`Curve::migrate`] exists for.
    pub migrated: bool,
}

/// A priced buy, as the curve would fill it right now. Every amount is in the
/// curve's quote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuyQuote {
    /// Tokens the buyer receives, rounded down.
    pub tokens_out: Tokens,
    /// The 1% trade fee, taken from the input before anything enters the
    /// reserve.
    pub fee: QuoteAmount,
    /// Quote actually consumed, fee included.
    pub quote_spent: QuoteAmount,
    /// Quote handed back because the curve ran out of inventory.
    ///
    /// Zero unless this buy fills the curve. A buy is capped at the remaining
    /// inventory: the curve will not take a wei more than reaches its target, so
    /// the last buy on a curve is routinely sent more than it can spend. If the
    /// refund transfer itself fails — a blocklisted buyer — the amount is
    /// credited to [`Curve::pending_withdrawal`] instead of reverting the trade.
    pub refund: QuoteAmount,
    /// The virtual reserve after the trade.
    pub new_reserve: QuoteAmount,
    /// Tokens sold after the trade.
    pub new_tokens_sold: Tokens,
    /// Spot price after the trade.
    pub new_price: QuoteAmount,
    /// True if this trade takes the curve to its target and ends trading.
    ///
    /// It also means the migration will be attempted in the same transaction.
    pub graduates: bool,
}

impl BuyQuote {
    /// The typed form of a raw [`crate::curve_math::RawBuyQuote`], in `quote`.
    #[must_use]
    pub fn from_raw(raw: &curve_math::RawBuyQuote, quote: &QuoteTokenInfo) -> Self {
        Self {
            tokens_out: Tokens::from_wad(raw.tokens_out_wad),
            fee: QuoteAmount::from_wad_in(quote, raw.fee_quote_wad),
            quote_spent: QuoteAmount::from_wad_in(quote, raw.quote_spent_wad),
            refund: QuoteAmount::from_wad_in(quote, raw.refund_wad),
            new_reserve: QuoteAmount::from_wad_in(quote, raw.new_reserve_wad),
            new_tokens_sold: Tokens::from_wad(raw.new_tokens_sold_wad),
            new_price: QuoteAmount::from_wad_in(quote, raw.new_price_wad),
            graduates: raw.graduates,
        }
    }

    /// A slippage floor `tolerance` below this quote's `tokens_out`.
    ///
    /// The floor is what stops the fill being worse than you agreed to. **Zero
    /// is a donation on a public mempool**, so this is the helper rather than
    /// the default. 50 bps — half a percent — is a reasonable starting point on
    /// a quiet curve and far too tight on a busy one.
    #[must_use]
    pub fn min_tokens_out(&self, tolerance: Bps) -> Tokens {
        self.tokens_out.less_tolerance(tolerance)
    }
}

/// A priced sell, as the curve would fill it right now. Every amount is in the
/// curve's quote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellQuote {
    /// Quote the seller receives, net of fee, rounded down.
    pub quote_out: QuoteAmount,
    /// The 1% trade fee, taken from the proceeds.
    pub fee: QuoteAmount,
    /// Quote leaving the reserve before the fee.
    pub gross: QuoteAmount,
    /// The virtual reserve after the trade.
    pub new_reserve: QuoteAmount,
    /// Tokens sold after the trade.
    pub new_tokens_sold: Tokens,
    /// Spot price after the trade.
    pub new_price: QuoteAmount,
}

impl SellQuote {
    /// The typed form of a raw [`crate::curve_math::RawSellQuote`], in `quote`.
    #[must_use]
    pub fn from_raw(raw: &curve_math::RawSellQuote, quote: &QuoteTokenInfo) -> Self {
        Self {
            quote_out: QuoteAmount::from_wad_in(quote, raw.quote_out_wad),
            fee: QuoteAmount::from_wad_in(quote, raw.fee_quote_wad),
            gross: QuoteAmount::from_wad_in(quote, raw.gross_quote_wad),
            new_reserve: QuoteAmount::from_wad_in(quote, raw.new_reserve_wad),
            new_tokens_sold: Tokens::from_wad(raw.new_tokens_sold_wad),
            new_price: QuoteAmount::from_wad_in(quote, raw.new_price_wad),
        }
    }

    /// A slippage floor `tolerance` below this quote's `quote_out`.
    #[must_use]
    pub fn min_quote_out(&self, tolerance: Bps) -> QuoteAmount {
        self.quote_out.less_tolerance(tolerance)
    }
}

/// A buy, spelled out.
///
/// On a native curve `quote_in` is the transaction's **value**. On an ERC-20
/// curve it is pulled from the buyer, after [`Curve::buy`] has made sure the
/// allowance covers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuyRequest {
    /// Quote to spend, fee inclusive, in the curve's quote token.
    pub quote_in: QuoteAmount,
    /// The slippage floor. **Required, not optional**: passing
    /// [`Tokens::ZERO`] on a public mempool is a donation. Derive one with
    /// [`BuyQuote::min_tokens_out`].
    pub min_tokens_out: Tokens,
    /// When this transaction stops being acceptable.
    pub deadline: Deadline,
    /// A referrer to credit out of the fee, or `None`.
    ///
    /// `None` sends the ref share to the platform recipient — the same rule that
    /// applies to a zero configured share. The referrer is **not validated**: it
    /// is the caller's own choice of who to credit out of the fee they are
    /// paying, the amounts are fixed by the curve's snapshotted split, and naming
    /// a bad address costs the caller nothing extra and cannot enlarge anyone's
    /// share. Naming your own address is allowed and simply rebates that part of
    /// the fee.
    pub referrer: Option<Address>,
    /// An explicit gas limit, or `None` to let the node estimate one.
    ///
    /// **Set this on a buy that might graduate the curve, and only then.** The
    /// graduating buy attempts the migration in the same transaction under a
    /// budget of up to 6,000,000 gas — but `eth_estimateGas` searches for the
    /// *lowest* limit at which the transaction succeeds, and the buy succeeds
    /// either way, because a migration that runs out of gas is caught, logged as
    /// `InstantMigrationFailed` and left to the permissionless retry. So an
    /// estimated limit is the one where the migration does **not** fit, and the
    /// instant migration you were promised quietly never happens.
    ///
    /// Nothing is lost when it does — the buyer keeps their tokens, the curve is
    /// graduated, every asset is still there and [`Curve::migrate`] is open to
    /// anyone — but somebody has to send that second transaction, which is the
    /// whole thing instant migration exists to avoid. Roughly 8,000,000 covers
    /// the buy plus the most expensive migration this protocol ships a migrator
    /// for; gas is charged for what is used, so the headroom is free when the
    /// migration is cheap or does not happen.
    ///
    /// [`BuyQuote::graduates`] tells you in advance whether this buy is that
    /// buy.
    pub gas_limit: Option<u64>,
}

impl BuyRequest {
    /// A buy of `quote_in` with a floor of `min_tokens_out`, five minutes to
    /// live, crediting nobody, with the gas limit left to the node.
    #[must_use]
    pub fn new(quote_in: QuoteAmount, min_tokens_out: Tokens) -> Self {
        Self {
            quote_in,
            min_tokens_out,
            deadline: Deadline::in_minutes(5),
            referrer: None,
            gas_limit: None,
        }
    }

    /// Send this buy with an explicit gas limit. See [`BuyRequest::gas_limit`]
    /// for the one case where you need to.
    #[must_use]
    pub fn gas_limit(mut self, limit: u64) -> Self {
        self.gas_limit = Some(limit);
        self
    }

    /// Set the deadline.
    #[must_use]
    pub fn deadline(mut self, deadline: Deadline) -> Self {
        self.deadline = deadline;
        self
    }

    /// Credit a referrer out of the fee.
    #[must_use]
    pub fn referrer(mut self, referrer: Address) -> Self {
        self.referrer = Some(referrer);
        self
    }
}

/// A sell, spelled out.
///
/// **No approval is involved anywhere in this struct or in the call it makes.**
/// See the module documentation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellRequest {
    /// Tokens to sell.
    pub tokens_in: Tokens,
    /// The slippage floor, net of fee, in the curve's quote. **Required**;
    /// derive one with [`SellQuote::min_quote_out`].
    pub min_quote_out: QuoteAmount,
    /// When this transaction stops being acceptable.
    pub deadline: Deadline,
    /// A referrer to credit out of the fee, or `None`. Same rules as on a buy.
    pub referrer: Option<Address>,
}

impl SellRequest {
    /// A sell of `tokens_in` with a floor of `min_quote_out`, five minutes to
    /// live, crediting nobody.
    #[must_use]
    pub fn new(tokens_in: Tokens, min_quote_out: QuoteAmount) -> Self {
        Self { tokens_in, min_quote_out, deadline: Deadline::in_minutes(5), referrer: None }
    }

    /// Set the deadline.
    #[must_use]
    pub fn deadline(mut self, deadline: Deadline) -> Self {
        self.deadline = deadline;
        self
    }

    /// Credit a referrer out of the fee.
    #[must_use]
    pub fn referrer(mut self, referrer: Address) -> Self {
        self.referrer = Some(referrer);
        self
    }
}

/// What a buy actually did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuyResult {
    /// Tokens delivered.
    pub tokens_out: Tokens,
    /// Quote consumed, fee included.
    pub quote_spent: QuoteAmount,
    /// Quote returned to the buyer, or credited to them if the transfer failed.
    pub refund: QuoteAmount,
    /// Whether the curve migrated **in this very transaction**.
    ///
    /// Read from the `Migrated` log in this buy's own receipt, not from a later
    /// read of the chain — by the time you could read the chain, somebody else
    /// may have called [`Curve::migrate`] and you would be answering a different
    /// question.
    ///
    /// **This is the only way to tell the two graduation outcomes apart, and
    /// they are easy to confuse.** A graduating buy attempts the migration
    /// itself, under a bounded gas budget, with its failure caught. When that
    /// attempt does not run or does not succeed, the buy still succeeds, the
    /// curve still graduates, the refund is still exactly right and every asset
    /// is still there — the *only* observable difference is this flag and the
    /// curve's `InstantMigrationFailed` log. Somebody then has to send a second
    /// transaction, which is the whole thing instant migration exists to avoid.
    ///
    /// So: if [`BuyQuote::graduates`] was true and this is false, the instant
    /// migration did not happen. The overwhelmingly likely reason is an
    /// estimated gas limit — see [`BuyRequest::gas_limit`]. Call
    /// [`Curve::migrate`], which is permissionless and stays open precisely for
    /// this.
    ///
    /// False on every ordinary buy, which does not graduate anything.
    pub migrated_in_this_transaction: bool,
    /// The canonical pool the migrator reported, when this transaction migrated
    /// the curve and the migrator created a market.
    ///
    /// `None` in two quite different cases, which
    /// `migrated_in_this_transaction` tells apart: this buy did not migrate the
    /// curve at all, or it did and the migrator created no market — an escrow
    /// migration reports `address(0)` and the token then taxes nothing.
    pub pool: Option<Address>,
    /// The transaction.
    pub tx_hash: B256,
    /// The exact approval this buy sent first, on an ERC-20 curve whose
    /// allowance did not already cover the amount. `None` otherwise.
    pub approval_tx_hash: Option<B256>,
}

/// What a sell actually did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellResult {
    /// Quote paid to the seller, or credited to them if the transfer failed.
    pub quote_out: QuoteAmount,
    /// The transaction.
    pub tx_hash: B256,
}

/// One bonding curve.
#[derive(Debug, Clone, Copy)]
pub struct Curve<'a> {
    client: &'a Client,
    address: Address,
}

impl<'a> Curve<'a> {
    pub(crate) fn new(client: &'a Client, address: Address) -> Self {
        Self { client, address }
    }

    /// The curve's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    fn contract(&self) -> Abi::BondingCurveInstance<DynProvider> {
        Abi::new(self.address, self.client.provider().clone())
    }

    /// Everything about the curve right now, in **one** batched round trip
    /// (after its `VERSION()`, which is read once per client).
    ///
    /// Batched through Multicall3, which is a predeploy on Arc. Eighteen separate
    /// `eth_call`s would not only be eighteen round trips, they would be
    /// eighteen *different blocks* on a busy chain — a state snapshot whose
    /// fields disagree with each other is worse than a slow one. The quote
    /// token's metadata comes from `networks.json` or this client's cache.
    ///
    /// If the chain has no Multicall3 (a bare local chain, say) this falls back
    /// to sequential reads and says nothing about it, because the fallback is
    /// correct and merely slower.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or any revert, decoded.
    pub async fn state(&self) -> Result<CurveState, Error> {
        let version = self.version().await?;
        curve_math::check_curve_version(&version).map_err(|err| self.locate(err))?;
        let c = self.contract();
        let batched = self
            .client
            .provider()
            .multicall()
            .add(c.r0Wad())
            .add(c.y0Wad())
            .add(c.curveSupplyWad())
            .add(c.tradeFeeBps())
            .add(c.quoteToken())
            .add(c.quoteDecimals())
            .add(c.token())
            .add(c.creator())
            .add(c.migrator())
            .add(c.spotPriceWad())
            .add(c.tokensSoldWad())
            .add(c.tokensRemainingWad())
            .add(c.realReserveWad())
            .add(c.virtualReserveWad())
            .add(c.targetQuoteWad())
            .add(c.graduationProgressBps())
            .add(c.graduated())
            .add(c.migrated())
            .aggregate()
            .await;

        let (
            r0_wad,
            y0_wad,
            curve_supply,
            trade_fee,
            quote_address,
            quote_decimals,
            token,
            creator,
            migrator,
            spot,
            sold,
            remaining,
            real,
            virt,
            target,
            progress,
            graduated,
            migrated,
        ) = match batched {
            Ok(values) => values,
            Err(_) => Box::pin(self.state_sequentially()).await?,
        };
        let quote = self.resolve_quote(quote_address, quote_decimals).await?;

        Ok(CurveState {
            version,
            params: CurveParams { r0_wad, y0_wad },
            curve_supply: Tokens::from_wad(curve_supply),
            trade_fee_bps: Bps::from_u256(trade_fee)?,
            token,
            creator,
            migrator,
            spot_price: QuoteAmount::from_wad_in(&quote, spot),
            tokens_sold: Tokens::from_wad(sold),
            tokens_remaining: Tokens::from_wad(remaining),
            real_reserve: QuoteAmount::from_wad_in(&quote, real),
            virtual_reserve: QuoteAmount::from_wad_in(&quote, virt),
            target: QuoteAmount::from_wad_in(&quote, target),
            progress_bps: Bps::from_u256(progress)?,
            graduated,
            migrated,
            quote_token: quote,
        })
    }

    /// The fallback for a chain with no Multicall3.
    #[allow(clippy::type_complexity)]
    async fn state_sequentially(
        &self,
    ) -> Result<
        (
            U256,
            U256,
            U256,
            U256,
            Address,
            u8,
            Address,
            Address,
            Address,
            U256,
            U256,
            U256,
            U256,
            U256,
            U256,
            U256,
            bool,
            bool,
        ),
        Error,
    > {
        let c = self.contract();
        let context = "reading curve state";
        let e = |err| Error::from_contract(err, context);
        Ok((
            c.r0Wad().call().await.map_err(e)?,
            c.y0Wad().call().await.map_err(e)?,
            c.curveSupplyWad().call().await.map_err(e)?,
            c.tradeFeeBps().call().await.map_err(e)?,
            c.quoteToken().call().await.map_err(e)?,
            c.quoteDecimals().call().await.map_err(e)?,
            c.token().call().await.map_err(e)?,
            c.creator().call().await.map_err(e)?,
            c.migrator().call().await.map_err(e)?,
            c.spotPriceWad().call().await.map_err(e)?,
            c.tokensSoldWad().call().await.map_err(e)?,
            c.tokensRemainingWad().call().await.map_err(e)?,
            c.realReserveWad().call().await.map_err(e)?,
            c.virtualReserveWad().call().await.map_err(e)?,
            c.targetQuoteWad().call().await.map_err(e)?,
            c.graduationProgressBps().call().await.map_err(e)?,
            c.graduated().call().await.map_err(e)?,
            c.migrated().call().await.map_err(e)?,
        ))
    }

    /// What this curve is priced and paid in: `quoteToken()` and
    /// `quoteDecimals()`, both immutable, read in one call and cached for the
    /// life of the client along with the token's metadata.
    ///
    /// # Errors
    /// [`Error::UnknownCurveVersion`] or [`Error::AddressIsNotACurve`], as
    /// every read here; [`Error::Abi`] when the curve's `quoteDecimals()`
    /// disagrees with the token's own; [`Error::Rpc`].
    pub async fn quote_token(&self) -> Result<QuoteTokenInfo, Error> {
        if let Some(quote) = cached(&self.client.cache().curve_quotes, &self.address) {
            return Ok(quote);
        }
        self.check_version().await?;
        let context = "reading a curve's quote token";
        let mut batch = Batch::new();
        let address = batch.push(self.address, &Abi::quoteTokenCall {});
        let decimals = batch.push(self.address, &Abi::quoteDecimalsCall {});
        let answers = batch.run(self.client, context).await?;
        self.resolve_quote(
            answers.decode::<Abi::quoteTokenCall>(address, context)?,
            answers.decode::<Abi::quoteDecimalsCall>(decimals, context)?,
        )
        .await
    }

    /// Describe the quote a curve reported, check it against the curve's own
    /// decimals, and remember it.
    async fn resolve_quote(&self, address: Address, decimals: u8) -> Result<QuoteTokenInfo, Error> {
        let quote = self.client.quote_token_info(address).await?;
        if quote.decimals != decimals {
            return Err(Error::abi(
                "reading a curve's quote token",
                format!(
                    "the curve at {} records {decimals} decimals for its quote {address}, and the \
                     token describes itself with {}",
                    self.address, quote.decimals
                ),
            ));
        }
        remember(&self.client.cache().curve_quotes, self.address, quote.clone());
        Ok(quote)
    }

    /// The curve's `VERSION()`, verbatim.
    ///
    /// # Errors
    /// [`Error::AddressIsNotACurve`] with no version when the address answers no
    /// `VERSION()` — the call reverts or returns nothing, as an address with no
    /// code or a contract that is not arcnow.io's does; [`Error::Rpc`] if the
    /// endpoint fails, which is not evidence about the address either way.
    pub async fn version(&self) -> Result<String, Error> {
        if let Some(version) = self.client.cached_version(self.address) {
            return Ok(version);
        }
        match self.contract().VERSION().call().await {
            Ok(version) => {
                self.client.remember_version(self.address, version.clone());
                Ok(version)
            }
            Err(alloy::contract::Error::ZeroData(..) | alloy::contract::Error::AbiError(_)) => {
                Err(Error::AddressIsNotACurve { address: Some(self.address), version: None })
            }
            Err(err) => match Error::from_contract(err, "reading a curve's VERSION()") {
                rpc @ Error::Rpc { .. } => Err(rpc),
                _reverted => {
                    Err(Error::AddressIsNotACurve { address: Some(self.address), version: None })
                }
            },
        }
    }

    /// Put this curve's address on a [`Error::AddressIsNotACurve`] that came from a
    /// version string alone.
    fn locate(&self, err: Error) -> Error {
        match err {
            Error::AddressIsNotACurve { address: None, version } => {
                Error::AddressIsNotACurve { address: Some(self.address), version }
            }
            other => other,
        }
    }

    /// Refuse anything but a `@4.x.x` bonding curve, naming what the address is.
    ///
    /// Every quote and trade on this handle asks this first, so a curve this SDK
    /// does not know — a retired `@1.x.x` curve included — is refused before
    /// anything is priced or sent.
    async fn check_version(&self) -> Result<(), Error> {
        curve_math::check_curve_version(&self.version().await?).map_err(|err| self.locate(err))
    }

    /// The curve's immutable pricing parameters: `r0Wad` and `y0Wad`.
    ///
    /// # Errors
    /// [`Error::UnknownCurveVersion`], naming the version, for a bonding curve
    /// of any other version; [`Error::AddressIsNotACurve`], naming the address
    /// and what it says it is, for an address that is not a bonding curve at all
    /// — a token, say; [`Error::Rpc`] if the endpoint fails.
    pub async fn params(&self) -> Result<CurveParams, Error> {
        self.check_version().await?;
        let context = "reading a curve's parameters";
        let contract = self.contract();
        let r0_wad =
            contract.r0Wad().call().await.map_err(|err| Error::from_contract(err, context))?;
        let y0_wad =
            contract.y0Wad().call().await.map_err(|err| Error::from_contract(err, context))?;
        Ok(CurveParams { r0_wad, y0_wad })
    }

    /// Price a buy **locally**, with this curve's own maths, from one read of
    /// its state.
    ///
    /// The same integers [`Curve::quote_buy`] gets from the chain — the fork
    /// tests hold the two, and the fill, equal to the wei — at
    /// the cost of one [`Curve::state`] rather than one call per quote. Use
    /// [`crate::curve_math::quote_buy`] with a [`CurveSnapshot`] you already
    /// hold to quote with no round trip at all.
    ///
    /// # Errors
    /// [`Error::UnknownCurveVersion`]; [`Error::CurveGraduated`] on a graduated
    /// curve, as the chain refuses; [`Error::CurveMath`] where the curve's maths
    /// would revert.
    pub async fn quote_buy_local(&self, quote_in: QuoteAmount) -> Result<BuyQuote, Error> {
        let state = Box::pin(self.state()).await?;
        state.quote_token.require_same(quote_in.token())?;
        if state.graduated {
            return Err(Error::CurveGraduated);
        }
        let quote = curve_math::quote_buy(&CurveSnapshot::from_state(&state), quote_in.to_wad())?;
        Ok(BuyQuote::from_raw(&quote, &state.quote_token))
    }

    /// Price a sell **locally**. See [`Curve::quote_buy_local`].
    ///
    /// # Errors
    /// As [`Curve::quote_buy_local`], and [`Error::ExceedsTokensSold`] for more
    /// tokens than the curve has sold, as the chain refuses.
    pub async fn quote_sell_local(&self, tokens_in: Tokens) -> Result<SellQuote, Error> {
        let state = Box::pin(self.state()).await?;
        if state.graduated {
            return Err(Error::CurveGraduated);
        }
        if tokens_in > state.tokens_sold {
            return Err(Error::ExceedsTokensSold {
                tokens_sold: state.tokens_sold,
                amount: tokens_in,
            });
        }
        let quote = curve_math::quote_sell(&CurveSnapshot::from_state(&state), tokens_in.to_wad())?;
        Ok(SellQuote::from_raw(&quote, &state.quote_token))
    }

    /// The token this curve trades.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn token(&self) -> Result<Address, Error> {
        self.contract()
            .token()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a curve's token"))
    }

    /// Price a buy of `quote_in` without executing it.
    ///
    /// The same code path settles the buy, so a quote and the fill that follows
    /// cannot disagree except by a state change in between — somebody else's
    /// trade, which is exactly what the slippage floor is for.
    ///
    /// # Errors
    ///
    /// [`Error::QuoteTokenMismatch`] for an amount in another quote than the
    /// curve's; [`Error::CurveGraduated`] on a graduated curve, so an interface
    /// cannot display a quote for a trade that cannot happen;
    /// [`Error::ZeroAmount`] for a zero input.
    pub async fn quote_buy(&self, quote_in: QuoteAmount) -> Result<BuyQuote, Error> {
        self.check_version().await?;
        let quote_token = self.quote_token().await?;
        quote_token.require_same(quote_in.token())?;
        let quote = self
            .contract()
            .quoteBuy(quote_in.to_wad())
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "quoting a buy"))?;
        let q = &quote_token;
        Ok(BuyQuote {
            tokens_out: Tokens::from_wad(quote.tokensOutWad),
            fee: QuoteAmount::from_wad_in(q, quote.feeQuoteWad),
            quote_spent: QuoteAmount::from_wad_in(q, quote.quoteSpentWad),
            refund: QuoteAmount::from_wad_in(q, quote.refundWad),
            new_reserve: QuoteAmount::from_wad_in(q, quote.newReserveWad),
            new_tokens_sold: Tokens::from_wad(quote.newTokensSoldWad),
            new_price: QuoteAmount::from_wad_in(q, quote.newPriceWad),
            graduates: quote.graduates,
        })
    }

    /// Price a sell of `tokens_in` without executing it.
    ///
    /// # Errors
    /// [`Error::CurveGraduated`], [`Error::ZeroAmount`], or a transport failure.
    pub async fn quote_sell(&self, tokens_in: Tokens) -> Result<SellQuote, Error> {
        self.check_version().await?;
        let q = &self.quote_token().await?;
        let quote = self
            .contract()
            .quoteSell(tokens_in.to_wad())
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "quoting a sell"))?;
        Ok(SellQuote {
            quote_out: QuoteAmount::from_wad_in(q, quote.quoteOutWad),
            fee: QuoteAmount::from_wad_in(q, quote.feeQuoteWad),
            gross: QuoteAmount::from_wad_in(q, quote.grossQuoteWad),
            new_reserve: QuoteAmount::from_wad_in(q, quote.newReserveWad),
            new_tokens_sold: Tokens::from_wad(quote.newTokensSoldWad),
            new_price: QuoteAmount::from_wad_in(q, quote.newPriceWad),
        })
    }

    /// Split a fee exactly as a swap with this `referrer` would.
    ///
    /// The same arithmetic the swap settles with. The three proportional shares
    /// are floored and the platform's share is the **residual**, so the four
    /// always total the fee exactly — at every size, including a fee of one wei,
    /// where three shares are zero and the platform takes it all. The rounding
    /// dust is at most three wei and it goes to the platform, which is where
    /// every unaddressed share goes too.
    ///
    /// A `None` referrer resolves to the platform recipient. That is the same
    /// rule a zero configured share follows, stated once.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn preview_fee_split(
        &self,
        fee: QuoteAmount,
        referrer: Option<Address>,
    ) -> Result<FeeSplit, Error> {
        let split = self
            .contract()
            .previewFeeSplit(fee.to_wad(), referrer.unwrap_or(Address::ZERO))
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "previewing a fee split"))?;
        Ok(FeeSplit {
            creator: split.creator,
            platform: split.platform,
            referrer: split.r#ref,
            protocol: split.protocol,
            creator_amount: QuoteAmount::from_wad_in(fee.token(), split.creatorWad),
            platform_amount: QuoteAmount::from_wad_in(fee.token(), split.platformWad),
            referrer_amount: QuoteAmount::from_wad_in(fee.token(), split.refWad),
            protocol_amount: QuoteAmount::from_wad_in(fee.token(), split.protocolWad),
        })
    }

    /// Buy tokens with the curve's quote.
    ///
    /// **Native USDC**: `request.quote_in` is sent as the transaction's value;
    /// there is no allowance to grant. **An ERC-20 quote**: the amount must be a
    /// whole number of the token's raw units, the buyer's allowance to the curve
    /// is read and topped up with an **exact** approval only when it does not
    /// already cover the amount ([`crate::QuoteToken::ensure_allowance`]), and
    /// then `buyWithQuote` is sent with no value.
    ///
    /// If this buy would take more tokens than the curve holds, the fill is
    /// capped at the remainder, the curve graduates, the migration is attempted
    /// in the same transaction, and the unspent quote comes back — see
    /// [`BuyResult::refund`].
    ///
    /// **A graduating buy needs an explicit gas limit**, because an estimated
    /// one is exactly the limit at which the migration does not fit. Read
    /// [`BuyRequest::gas_limit`] before sending a buy whose quote says
    /// `graduates`, and check [`BuyResult::migrated_in_this_transaction`]
    /// afterwards.
    ///
    /// # Errors
    ///
    /// Before any RPC: [`Error::SignerRequired`] on a read-only client and
    /// [`Error::QuoteAmountNotRepresentable`]. Then
    /// [`Error::QuoteTokenMismatch`] for an amount in another quote,
    /// [`Error::CurveGraduated`], [`Error::SlippageExceeded`],
    /// [`Error::DeadlineExpired`], [`Error::ZeroAmount`].
    pub async fn buy(&self, request: BuyRequest) -> Result<BuyResult, Error> {
        let from = self.client.require_signer("Curve::buy")?;
        request.quote_in.require_representable()?;
        self.check_version().await?;
        let quote = self.quote_token().await?;
        quote.require_same(request.quote_in.token())?;

        let contract = self.contract();
        let referrer = request.referrer.unwrap_or(Address::ZERO);
        let (pending, approval_tx_hash) = if quote.is_native {
            // The three-argument overload always, with zero where nobody was
            // named: the two-argument one is exactly this call with zero.
            let call = contract
                .buy_0(request.min_tokens_out.to_wad(), request.deadline.to_u256(), referrer)
                .from(from)
                .value(request.quote_in.to_wad());
            let call = match request.gas_limit {
                Some(limit) => call.gas(limit),
                None => call,
            };
            (call.send().await.map_err(|err| Error::from_contract(err, "sending a buy"))?, None)
        } else {
            let (quote_ref, request_ref) = (&quote, &request);
            let preflight = move || self.preflight_buy_with_quote(request_ref, quote_ref, from);
            let approval = self
                .client
                .quote_token_for(quote.clone())
                .ensure_allowance_after(self.address, &request.quote_in, preflight)
                .await?;
            let call = contract
                .buyWithQuote(
                    request.quote_in.to_wad(),
                    request.min_tokens_out.to_wad(),
                    request.deadline.to_u256(),
                    referrer,
                )
                .from(from);
            let (limit, context) = (request.gas_limit, "sending a buy");
            let gas = erc20_trade_gas(&call, limit, &quote, context, curve_headroom).await?;
            let pending = call.gas(gas).send().await.map_err(|err| {
                Error::from_contract(err, "sending a buy").on_erc20_quote(&quote, Some(gas))
            })?;
            (pending, approval.tx_hash)
        };
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the buy receipt", err))?;
        let tx_hash = receipt.transaction_hash;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash });
        }

        // `buy` returns three values, and a mined transaction returns nothing:
        // the numbers come out of the logs instead. `Trade` carries what was
        // spent and delivered; `BuyRefunded` carries the refund and is written
        // only when there was one; `Migrated` is written only when the curve
        // migrated inside this transaction, which is the one fact a later read
        // of the chain cannot answer — by then somebody else may have called
        // `migrate`.
        let mut result = BuyResult {
            tokens_out: Tokens::ZERO,
            quote_spent: QuoteAmount::zero_in(&quote),
            refund: QuoteAmount::zero_in(&quote),
            migrated_in_this_transaction: false,
            pool: None,
            tx_hash,
            approval_tx_hash,
        };
        let mut saw_refund = false;
        let mut saw_trade = false;
        for log in receipt.inner.logs() {
            if log.address() != self.address {
                continue;
            }
            if let Ok(trade) = <Abi::Trade as alloy::sol_types::SolEvent>::decode_log(&log.inner) {
                result.tokens_out = Tokens::from_wad(trade.tokenAmountWad);
                result.quote_spent = QuoteAmount::from_wad_in(&quote, trade.quoteAmountWad);
                saw_trade = true;
            } else if let Ok(refund) =
                <Abi::BuyRefunded as alloy::sol_types::SolEvent>::decode_log(&log.inner)
            {
                result.refund = QuoteAmount::from_wad_in(&quote, refund.refundWad);
                saw_refund = true;
            } else if let Ok(migrated) =
                <Abi::Migrated as alloy::sol_types::SolEvent>::decode_log(&log.inner)
            {
                result.migrated_in_this_transaction = true;
                // `address(0)` is a migrator that created no market — an escrow
                // — and is not a pool anybody can trade at.
                result.pool = (migrated.pool != Address::ZERO).then_some(migrated.pool);
            }
        }
        if !saw_trade {
            return Err(Error::MissingLog { tx_hash, event: "Trade" });
        }
        if !saw_refund && !quote.is_native {
            // An ERC-20 buy pulls only what it spends and transfers no refund:
            // the rest of the offer was never taken.
            result.refund = request.quote_in.sub_saturating(&result.quote_spent)?;
        }
        Ok(result)
    }

    /// Simulate `buyWithQuote` as `from`, with the curve's allowance of the
    /// quote overridden, so a buy that would revert is refused by name before an
    /// approval is sent for it. Skipped when `networks.json` records no
    /// allowance slot for the quote.
    async fn preflight_buy_with_quote(
        &self,
        request: &BuyRequest,
        quote: &QuoteTokenInfo,
        from: Address,
    ) -> Result<(), Error> {
        let Some(overrides) =
            crate::quote::allowance_override(self.client, quote, from, self.address)
        else {
            return Ok(());
        };
        self.contract()
            .buyWithQuote(
                request.quote_in.to_wad(),
                request.min_tokens_out.to_wad(),
                request.deadline.to_u256(),
                request.referrer.unwrap_or(Address::ZERO),
            )
            .from(from)
            .state(overrides)
            .call()
            .await
            .map(|_| ())
            .map_err(|err| Error::from_contract(err, "simulating a buy before approving it"))
    }

    /// Sell tokens back to the curve for its quote.
    ///
    /// **No approval is needed and none is emitted.** The curve pulls the tokens
    /// through `curveTransferFrom`, a path callable only by the token's own
    /// curve that reads no allowance at all — so a holder who has approved
    /// nobody can sell, and an allowance granted to the curve is untouched by
    /// this call. If you are reaching for `approve` before calling this, you are
    /// fixing the wrong thing; see the module documentation.
    ///
    /// If the payout transfer fails — which on Arc means the seller is
    /// blocklisted — the sale still completes and the proceeds are credited to
    /// [`Curve::pending_withdrawal`] for the seller to pull to another address.
    /// One blocklisted seller cannot wedge the curve for anyone else.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`] before any RPC on a read-only client;
    /// [`Error::QuoteTokenMismatch`] for a floor in another quote;
    /// [`Error::InsufficientTokenBalance`] (which says plainly that no approval
    /// is involved), [`Error::CurveGraduated`], [`Error::SlippageExceeded`],
    /// [`Error::DeadlineExpired`].
    pub async fn sell(&self, request: SellRequest) -> Result<SellResult, Error> {
        let from = self.client.require_signer("Curve::sell")?;
        self.check_version().await?;
        let quote = self.quote_token().await?;
        quote.require_same(request.min_quote_out.token())?;
        let contract = self.contract();
        // The four-argument overload always, with zero where nobody was named:
        // the three-argument one is exactly this call with zero.
        let call = contract
            .sell_1(
                request.tokens_in.to_wad(),
                request.min_quote_out.to_wad(),
                request.deadline.to_u256(),
                request.referrer.unwrap_or(Address::ZERO),
            )
            .from(from);
        // An ERC-20 payout's fee shares pass a gas guard: never the bare estimate.
        let call = if quote.is_native {
            call
        } else {
            let gas =
                erc20_trade_gas(&call, None, &quote, "sending a sell", curve_headroom).await?;
            call.gas(gas)
        };
        let pending = call.send().await.map_err(|err| {
            Error::from_contract(err, "sending a sell").on_erc20_quote(&quote, None)
        })?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the sell receipt", err))?;
        let tx_hash = receipt.transaction_hash;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash });
        }
        for log in receipt.inner.logs() {
            if log.address() != self.address {
                continue;
            }
            if let Ok(trade) = <Abi::Trade as alloy::sol_types::SolEvent>::decode_log(&log.inner) {
                return Ok(SellResult {
                    quote_out: QuoteAmount::from_wad_in(&quote, trade.quoteAmountWad),
                    tx_hash,
                });
            }
        }
        Err(Error::MissingLog { tx_hash, event: "Trade" })
    }

    /// Forward a graduated curve's USDC and remaining tokens to its migrator.
    ///
    /// **This is the retry path, not the normal one.** The graduating buy
    /// attempts the migration itself under a bounded gas budget, with its failure
    /// caught, so the buyer does not have to send a second transaction and nobody
    /// has to poll. When that attempt succeeded this reverts with
    /// [`Error::AlreadyMigrated`], which is the *good* outcome. When it failed —
    /// the curve logged `InstantMigrationFailed` — this stays open to anyone and
    /// forwards all remaining gas, so a stuck migrator can never strand a curve
    /// with no path out.
    ///
    /// Permissionless: any account may call it.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`]; [`Error::NotGraduated`] before the target is
    /// reached; [`Error::AlreadyMigrated`] when there is nothing left to do.
    pub async fn migrate(&self) -> Result<B256, Error> {
        let from = self.client.require_signer("Curve::migrate")?;
        self.check_version().await?;
        let pending = self
            .contract()
            .migrate()
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "migrating a curve"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the migration receipt", err))?;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
        }
        Ok(receipt.transaction_hash)
    }

    /// Quote credited to `account` after a payout that could not be delivered.
    ///
    /// A credit appears when a sale payout, a buy refund or a fee share could not
    /// be sent — on Arc that means a blocklisted address, or a recipient whose
    /// `receive()` wants more than the 30,000-gas stipend fee payouts are given.
    /// The trade still completed; the money is here and is claimable with
    /// [`Curve::withdraw`] to any address.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn pending_withdrawal(&self, account: Address) -> Result<QuoteAmount, Error> {
        let quote = self.quote_token().await?;
        let raw = self
            .contract()
            .pendingWithdrawalWad(account)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a pending withdrawal"))?;
        Ok(QuoteAmount::from_wad_in(&quote, raw))
    }

    /// Pull the caller's deferred payout to an address of their choosing.
    ///
    /// The escape hatch for Arc's blocklist: the credit belongs to the signer,
    /// who names a recipient that can actually receive it. If that address cannot
    /// receive either, the call reverts with [`Error::TransferFailed`] and the
    /// credit is left intact for another attempt.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`]; [`Error::NothingToWithdraw`] when the signer
    /// has no credit; [`Error::TransferFailed`] when `to` cannot receive.
    pub async fn withdraw(&self, to: Address) -> Result<B256, Error> {
        let from = self.client.require_signer("Curve::withdraw")?;
        let pending = self
            .contract()
            .withdraw(to)
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "withdrawing a deferred payout"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the withdrawal receipt", err))?;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
        }
        Ok(receipt.transaction_hash)
    }

    /// The four-way fee split this curve snapshotted at construction.
    ///
    /// `immutable`, and identical to the one on its token. **No admin anywhere —
    /// platform, protocol, creator — can change what a launched curve charges or
    /// who it pays.** That is the whole reason this design carries no timelock.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or [`Error::ImplausibleBps`].
    pub async fn fee_config(&self) -> Result<crate::platform::FeeConfig, Error> {
        let config = self
            .contract()
            .feeConfig()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a curve's fee config"))?;
        crate::platform::FeeConfig::from_abi(
            config.creatorShareBps,
            config.platformShareBps,
            config.refShareBps,
            config.protocolShareBps,
            config.platformRecipient,
            config.protocolRecipient,
        )
    }

    /// The trade fee this curve charges, in basis points of a trade. Immutable.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or [`Error::ImplausibleBps`].
    pub async fn trade_fee_bps(&self) -> Result<Bps, Error> {
        let raw = self
            .contract()
            .tradeFeeBps()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a curve's trade fee"))?;
        Bps::from_u256(raw)
    }
}
