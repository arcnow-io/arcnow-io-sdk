//! Launching a token: what it costs, where it will land, and doing it.
//!
//! One transaction deploys a token, deploys its bonding curve bound to it, takes
//! the launch fee — **zero on arcnow.io's deployments: launching is free** —
//! and performs the creator's optional initial buy. There is no window in which
//! a token exists without its curve, and none in which somebody can front-run
//! the creator's first buy.
//!
//! # Two charges, not one — and the first is zero
//!
//! **The initial buy is an ordinary buy** and pays the ordinary 1% trade fee, on
//! top of the launch fee. The launch fee is the quote registry's per quote, its
//! admin can set one, and arcnow.io's registries charge 0 for native USDC and
//! for EURC on both networks; this crate reads it rather than assuming it.
//! There is no fee-free entry into the curve, and
//! that is deliberate: a second, cheaper pricing path is both a code path that
//! can disagree with the quote a user was shown and a route a creator could push
//! volume through. [`Launchpad::quote_launch`] reports the two charges
//! separately so an interface can name both.
//!
//! # The launch's quote is its initial buy's
//!
//! A token is launched **in a quote token** — native USDC or an allowlisted
//! ERC-20 — and its curve is priced in that quote for life. The quote is
//! [`LaunchParams::initial_buy`]'s token; a launch with no initial buy says
//! which quote with `QuoteAmount::zero_in(&quote)`. The launch fee, if the
//! registry charges one, is in the same quote.
//!
//! # Exact payment
//!
//! On a **native** launch `msg.value` must equal the launch fee plus the initial
//! buy **exactly**; the launchpad has no refund path. On an **ERC-20** launch no
//! value is sent: the launchpad pulls the fee plus the initial buy, so
//! [`Launchpad::launch`] first makes sure the creator's allowance to the
//! launchpad covers [`LaunchQuote::total_cost`], approving exactly that amount
//! only when it does not.
//!
//! # A fee raised while you wait
//!
//! The launch fee is admin-mutable. [`LaunchParams::max_launch_fee`] caps what
//! a launch will pay and defaults to the fee just quoted, so a fee raised while
//! the transaction is pending reverts `LaunchFeeAboveMaximum` rather than
//! charging more than was shown.

use alloy::primitives::{Address, B256, U256};
use alloy::sol_types::SolEvent;

use crate::amount::{Bps, QuoteAmount, QuoteTokenInfo, Tokens, Usdc};
use crate::bindings::curve::BondingCurve as CurveAbi;
use crate::bindings::launchpad::ILaunchpad;
use crate::bindings::launchpad::Launchpad as Abi;
use crate::bindings::platform_config::PlatformConfig as PlatformAbi;
use crate::client::Client;
use crate::constants::CurveTemplate;
use crate::curve_math;
use crate::error::Error;
use crate::quote::Batch;

/// The gas limit this SDK sends for a launch whose initial buy will graduate the
/// curve: 8,000,000.
///
/// The curve budgets `INSTANT_MIGRATION_GAS_LIMIT` (6,000,000) for the migrator
/// and keeps `POST_MIGRATION_GAS_RESERVE` (100,000) back for itself, and the
/// launch deploys a token and a curve before any of that runs. 8,000,000 clears
/// all of it with room, and is the figure this SDK's fork tests use on the buy
/// path. **A ceiling, not a charge**: unused gas is not paid for.
///
/// Measured on an Arc fork: a launch whose initial buy
/// graduates used **5,298,297** and migrates instantly only above **≈5,880,000**
/// (this clears it by 36%); a graduating buy used **741,432** and migrates only
/// above **≈845,500**. It is sized for the heaviest venue a curve could
/// graduate into (v3, 5,478,413 for the buy alone), not for v4.
///
/// See [`LaunchParams::gas_limit`] for why nothing smaller can be estimated into
/// existence.
pub const GRADUATION_GAS_LIMIT: u64 = 8_000_000;

/// The lowest gas limit this SDK will send on a launch the quote says will
/// graduate: 6,200,000.
///
/// **Derived, not measured**: `INSTANT_MIGRATION_GAS_LIMIT` (6,000,000) +
/// `POST_MIGRATION_GAS_RESERVE` (100,000) + 100,000 of margin — the budget below
/// which the heaviest venue could not migrate at all. Below it the transaction
/// would succeed, the token would graduate and the pool would silently never be
/// created. An explicit limit under this is refused with
/// [`Error::LaunchGasLimitTooLow`] rather than sent.
///
/// Checked against the measurements, and it clears them: a graduating launch
/// migrates only above ≈5,880,000 (5.4% under this floor) and a graduating buy
/// above ≈845,500. `tests/fork.rs` sends a graduating launch at exactly this
/// limit and requires it to migrate in its own transaction.
pub const GRADUATION_GAS_FLOOR: u64 = 6_200_000;

/// What to launch.
///
/// ```
/// use arcnow_sdk::{LaunchParams, Tokens, Usdc};
///
/// let params = LaunchParams::new("Example", "EXMPL", "ipfs://Qm...")
///     .initial_buy(Usdc::from_whole(10))
///     .min_tokens_out(Tokens::from_whole(500_000));
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchParams {
    /// Human-readable token name. Must not be empty.
    pub name: String,
    /// Ticker symbol. Must not be empty.
    pub symbol: String,
    /// URI of the off-chain metadata document. Must not be empty.
    pub metadata_uri: String,
    /// Quote to spend on the creator's first buy. May be zero.
    ///
    /// **Its token is the launch's quote**: the curve is priced in it for life
    /// and the launch fee is charged in it. A launch in EURC with no initial buy
    /// is `QuoteAmount::zero_in(&eurc)`.
    ///
    /// **An ordinary buy**: it pays the 1% trade fee on top of the launch fee
    /// (zero, on arcnow.io's deployments), and it fills along the curve exactly
    /// as anyone else's buy would.
    pub initial_buy: QuoteAmount,
    /// Slippage floor for the initial buy.
    ///
    /// Meaningful even though the launch is atomic, and more so than it looks: a
    /// platform admin can move its curve template at any time, and this
    /// transaction may sit in the mempool. The floor pins the creator's
    /// expectation against the template changing between signing and inclusion.
    ///
    /// Zero is accepted and is a donation on a public mempool. Derive one from
    /// [`Launchpad::quote_launch`] instead.
    pub min_tokens_out: Tokens,
    /// The `PlatformConfig` to launch under.
    ///
    /// `None` means the network's `arcnowPlatform` — arcnow.io's own platform,
    /// which is the default and **not** a privileged singleton. Any address here
    /// must be registered in the platform registry **at inclusion**, not merely
    /// at signing.
    ///
    /// The platform's fee split, curve template and default migrator are
    /// snapshotted onto the new curve and token, and nothing that platform does
    /// afterwards reaches them.
    pub platform: Option<Address>,
    /// The graduation target, chosen from the migrator registry.
    ///
    /// `None` takes the platform's default, **which is what almost every launch
    /// does**. A creator picks from the protocol's registered list and no wider;
    /// the alternative is a creator pointing their own buyers' liquidity at an
    /// address they control.
    ///
    /// Whatever is chosen is snapshotted onto the curve and is immutable for
    /// life.
    pub migrator: Option<Address>,
    /// The most launch fee this launch will pay, in the launch's quote.
    ///
    /// `None` takes the fee [`Launchpad::launch`] has just quoted, so an admin
    /// raising the fee while this transaction is pending makes it revert
    /// `LaunchFeeAboveMaximum` rather than overcharge.
    pub max_launch_fee: Option<QuoteAmount>,
    /// An explicit gas limit for the launch transaction, instead of letting the
    /// node estimate one.
    ///
    /// **You should not normally need this.** [`Launchpad::launch`] reads
    /// [`LaunchQuote::graduates`] before it sends and supplies
    /// [`GRADUATION_GAS_LIMIT`] itself when the initial buy would graduate the
    /// curve, because the estimate is exactly wrong in that case and leaving a
    /// caller to know was a footgun rather than a feature. Set this to override
    /// that, or to raise the limit on an ordinary launch.
    ///
    /// # Why the estimate is wrong
    ///
    /// A launch whose *initial buy* reaches the graduation target graduates the
    /// curve inside the launch transaction, and the curve then attempts the
    /// migration under a bounded budget and **catches its failure**, logging
    /// `InstantMigrationFailed` rather than reverting. So the launch succeeds
    /// whether or not the migration runs, and `eth_estimateGas` — which searches
    /// for the lowest limit at which the transaction still succeeds — converges
    /// on precisely the limit that starves it: a token with no market, and no
    /// error anywhere.
    ///
    /// A limit below [`GRADUATION_GAS_FLOOR`] on a launch the quote says will
    /// graduate is **refused** with [`Error::LaunchGasLimitTooLow`] rather than
    /// sent: it is not a limit that makes the launch fail, it is one that makes
    /// it succeed and do half the job.
    ///
    /// Spelled `gasLimit` in the TypeScript SDK's `LaunchParams`, and the same
    /// concept. Compare [`crate::BuyRequest::gas_limit`], which is the same trap
    /// on the buy path.
    pub gas_limit: Option<u64>,
}

impl LaunchParams {
    /// The three required strings. Everything else takes a documented default:
    /// no initial buy, no slippage floor, the network's platform, the platform's
    /// migrator.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        symbol: impl Into<String>,
        metadata_uri: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            symbol: symbol.into(),
            metadata_uri: metadata_uri.into(),
            initial_buy: Usdc::ZERO,
            min_tokens_out: Tokens::ZERO,
            platform: None,
            migrator: None,
            max_launch_fee: None,
            gas_limit: None,
        }
    }

    /// Spend this much on the creator's first buy — **and launch in its
    /// quote**.
    #[must_use]
    pub fn initial_buy(mut self, amount: QuoteAmount) -> Self {
        self.initial_buy = amount;
        self
    }

    /// Refuse the launch if the initial buy would deliver less than this.
    #[must_use]
    pub fn min_tokens_out(mut self, floor: Tokens) -> Self {
        self.min_tokens_out = floor;
        self
    }

    /// Launch under a specific platform rather than the network's default.
    #[must_use]
    pub fn platform(mut self, platform: Address) -> Self {
        self.platform = Some(platform);
        self
    }

    /// Graduate to a specific registered migrator rather than the platform's
    /// default.
    #[must_use]
    pub fn migrator(mut self, migrator: Address) -> Self {
        self.migrator = Some(migrator);
        self
    }

    /// Pay at most this launch fee. See [`LaunchParams::max_launch_fee`].
    #[must_use]
    pub fn max_launch_fee(mut self, fee: QuoteAmount) -> Self {
        self.max_launch_fee = Some(fee);
        self
    }

    /// The quote this launch is in: the initial buy's token.
    #[must_use]
    pub fn quote_token(&self) -> &QuoteTokenInfo {
        self.initial_buy.token()
    }

    /// Send the launch with an explicit gas limit.
    ///
    /// Rarely needed: [`Launchpad::launch`] already sends
    /// [`GRADUATION_GAS_LIMIT`] on a launch its quote says will graduate. See
    /// [`LaunchParams::gas_limit`].
    #[must_use]
    pub fn gas_limit(mut self, limit: u64) -> Self {
        self.gas_limit = Some(limit);
        self
    }

    /// Refuse, before any RPC, what cannot be launched: an initial buy the quote
    /// cannot carry, or a maximum fee in another quote.
    fn check(&self) -> Result<(), Error> {
        self.initial_buy.require_representable()?;
        if let Some(max) = &self.max_launch_fee {
            self.quote_token().require_same(max.token())?;
        }
        Ok(())
    }

    /// Encode for the contract, resolving the platform default.
    fn encode(
        &self,
        default_platform: Address,
        max_launch_fee_wad: U256,
    ) -> ILaunchpad::LaunchParams {
        ILaunchpad::LaunchParams {
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            metadataURI: self.metadata_uri.clone(),
            initialBuyWad: self.initial_buy.to_wad(),
            minTokensOutWad: self.min_tokens_out.to_wad(),
            platform: self.platform.unwrap_or(default_platform),
            // address(0) is the contract's own spelling of "the platform's
            // default migrator". It is not a missing address.
            migrator: self.migrator.unwrap_or(Address::ZERO),
            quoteToken: self.initial_buy.token().address,
            maxLaunchFeeWad: max_launch_fee_wad,
        }
    }
}

/// What a launch would cost and deliver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchQuote {
    /// The quote the launch is in: the initial buy's token.
    pub quote_token: QuoteTokenInfo,
    /// The launch fee, in the quote, as the registry charges it now (zero on
    /// arcnow.io's deployments).
    pub launch_fee: QuoteAmount,
    /// The initial buy, as asked.
    pub initial_buy: QuoteAmount,
    /// What the launch costs in the quote: the launch fee plus the initial buy.
    pub total_cost: QuoteAmount,
    /// The **exact** `msg.value` the launch requires: `total_cost` for a
    /// native launch, zero for an ERC-20 launch, whose cost is pulled instead.
    ///
    /// Not "at least". The launchpad reverts with
    /// [`Error::IncorrectPayment`] on an overpayment as readily as on an
    /// underpayment; it has no refund path and will not strand your change.
    pub native_value: Usdc,
    /// Tokens the initial buy would deliver. Zero if there is no initial buy.
    pub tokens_out: Tokens,
    /// The 1% trade fee the initial buy would pay, **on top of** the launch fee,
    /// and already included in `total_cost`.
    ///
    /// Reported separately so an interface can name both charges rather than
    /// showing one number a user cannot reconcile.
    pub trade_fee: QuoteAmount,
    /// True when the initial buy alone would take the new curve to its
    /// graduation target — so the launch deploys a token, graduates it and
    /// attempts its migration, all in one transaction.
    ///
    /// **Not an exotic case.** The target is whatever the platform's live
    /// template says, and on arcnow.io's own platform it is 50 USDC; an initial
    /// buy of 60 does it.
    ///
    /// The launchpad's `quoteLaunch` reports cost and fill and throws this flag
    /// away, so [`Launchpad::quote_launch`] reconstructs it from the platform's
    /// **live** curve template in the launch's quote (`curveParametersFor`) — read from the chain, never from
    /// [`crate::CurveTemplate::arcnow_defaults`] — and the curve's own rule: a
    /// buy graduates when the reserve it leaves behind reaches the target, or
    /// when it clears the curve's whole inventory.
    ///
    /// When it is true, [`Launchpad::launch`] sends [`GRADUATION_GAS_LIMIT`]
    /// rather than an estimate. See [`LaunchParams::gas_limit`].
    pub graduates: bool,
}

/// What a launch produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchResult {
    /// The deployed token.
    pub token: Address,
    /// Its bonding curve, bound to it for life.
    pub curve: Address,
    /// Tokens the initial buy delivered. Zero if there was no initial buy.
    pub tokens_out: Tokens,
    /// True when the initial buy took the new curve straight to its target, so
    /// the token graduated in the transaction that created it and will never
    /// trade on its curve again.
    ///
    /// Read from the `Graduated` log in the launch's **own** receipt.
    pub graduated: bool,
    /// True when a migration was attempted inside this launch and did not
    /// succeed.
    ///
    /// Not an error and deliberately not a revert: the token exists, the
    /// creator holds their tokens, the curve is graduated and every asset is
    /// still on it. What it means is that somebody should call
    /// [`crate::Curve::migrate`], which stays permissionless and forwards an
    /// unbounded gas budget.
    ///
    /// **The most likely cause is a gas limit estimated rather than chosen** —
    /// see [`LaunchParams::gas_limit`]. It is what was observed live on Arc
    /// testnet before the SDK supplied a limit of its own.
    pub instant_migration_failed: bool,
    /// True when the curve's assets reached the migrator **in this very
    /// transaction** — the `Migrated` log is in the launch's own receipt.
    ///
    /// This is the question worth asking, and it is not the same as "is the
    /// curve migrated now". A launch that graduates and whose migration runs out
    /// of gas still succeeds, and `migrate()` stays open to anyone, so a later
    /// read of the chain can say `migrated` about a curve a stranger rescued
    /// minutes afterwards. Only this distinguishes the instant path from the
    /// retry path, and the difference is whether the token had a market the
    /// moment it was created.
    ///
    /// False on every ordinary launch, which graduates nothing.
    pub migrated_in_this_transaction: bool,
    /// The canonical pool the migrator reported, when this launch migrated the
    /// curve.
    ///
    /// `None` when the launch did not migrate, and also when the migrator
    /// created no market at all — an escrow migration reports the zero address.
    pub pool: Option<Address>,
    /// The transaction.
    pub tx_hash: B256,
    /// The exact approval sent first on an ERC-20 launch whose allowance did
    /// not already cover the cost. `None` otherwise.
    pub approval_tx_hash: Option<B256>,
}

/// The launchpad: the only orchestrator.
#[derive(Debug, Clone, Copy)]
pub struct Launchpad<'a> {
    client: &'a Client,
    address: Address,
}

impl<'a> Launchpad<'a> {
    pub(crate) fn new(client: &'a Client, address: Address) -> Self {
        Self { client, address }
    }

    /// The launchpad's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    fn contract(&self) -> Abi::LaunchpadInstance<alloy::providers::DynProvider> {
        Abi::new(self.address, self.client.provider().clone())
    }

    /// Refuse a launchpad that is not `arcnow/launchpad@3.x.x`. Read once per
    /// client.
    async fn check_version(&self) -> Result<(), Error> {
        let version =
            self.client
                .version_of(self.address, async {
                    self.contract().VERSION().call().await.map_err(|err| {
                        Error::from_contract(err, "reading the launchpad's VERSION()")
                    })
                })
                .await?;
        curve_math::check_launchpad_version(&version)
    }

    /// The launch fee in `quote` ([`crate::NATIVE_QUOTE`] for native USDC):
    /// `QuoteRegistry.quoteInfo(quote).launchFeeWad`. Zero for every quote
    /// arcnow.io's registries list today.
    ///
    /// Admin-mutable, so read from the chain rather than assumed.
    ///
    /// # Errors
    /// `QuoteTokenNotRegistered`, decoded, for a quote never registered;
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn launch_fee(&self, quote: Address) -> Result<QuoteAmount, Error> {
        Ok(self.client.quote_registry().await?.info(quote).await?.launch_fee)
    }

    /// The quote token registry this launchpad checks quotes and fees against:
    /// its immutable `quoteTokenRegistry()`, read once per client.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn quote_token_registry(&self) -> Result<Address, Error> {
        if let Some(address) = *self
            .client
            .cache()
            .quote_registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            return Ok(address);
        }
        let address =
            self.contract().quoteTokenRegistry().call().await.map_err(|err| {
                Error::from_contract(err, "reading the launchpad's quote registry")
            })?;
        *self
            .client
            .cache()
            .quote_registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(address);
        Ok(address)
    }

    /// The trade fee, in basis points **of a trade**: 100, one percent.
    ///
    /// Immutable, and **the same for every platform**. What a platform chooses is
    /// how the 1% is divided across four recipients, never how large it is.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or [`Error::ImplausibleBps`] if the
    /// answer is not a basis-point quantity.
    pub async fn trade_fee_bps(&self) -> Result<Bps, Error> {
        let raw = self
            .contract()
            .tradeFeeBps()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the trade fee"))?;
        Bps::from_u256(raw)
    }

    /// Where the flat launch fee is sent. Immutable.
    ///
    /// **Only the launch fee** — which is zero on arcnow.io's deployments, so
    /// nothing reaches it today. Trade fees never touch this address: they are
    /// split four ways by each curve, to recipients that curve snapshotted from
    /// its platform.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn fee_recipient(&self) -> Result<Address, Error> {
        self.contract()
            .feeRecipient()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the launch fee recipient"))
    }

    /// How many launches `creator` has performed.
    ///
    /// Feeds the CREATE2 salt, so a creator's launches cannot collide with each
    /// other or be squatted by anyone else — and so
    /// [`Launchpad::predict_addresses`] is only valid for the nonce that is
    /// current right now.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn launch_nonce(&self, creator: Address) -> Result<U256, Error> {
        self.contract()
            .launchNonce(creator)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a launch nonce"))
    }

    /// What a launch would cost and deliver, without executing it.
    ///
    /// One batched `eth_call`: the launchpad's `quoteLaunch` and the platform's
    /// live template in the launch's quote (plus the platform's `VERSION()` the
    /// first time), after the launchpad's own `VERSION()` the first time.
    ///
    /// # Errors
    ///
    /// Before any RPC: [`Error::QuoteTokenMismatch`] for a maximum fee in another
    /// quote. Then [`Error::ContractNotDeployed`] when `params.platform` is
    /// `None` and this network has no `arcnowPlatform`; any revert the launchpad
    /// or the platform raises, decoded — [`Error::PlatformNotRegistered`],
    /// `QuoteTokenNotSupported`, `QuoteNotEnabledOnPlatform`,
    /// `NoCurveParameters`; [`Error::UnknownCurveVersion`] for a launchpad or
    /// platform of another major.
    pub async fn quote_launch(&self, params: &LaunchParams) -> Result<LaunchQuote, Error> {
        if let Some(max) = &params.max_launch_fee {
            params.quote_token().require_same(max.token())?;
        }
        self.check_version().await?;
        let platform =
            params.platform.map_or_else(|| self.client.network().arcnow_platform(), Ok)?;
        let quote = params.quote_token().clone();
        let max_fee = params.max_launch_fee.as_ref().map_or(U256::MAX, QuoteAmount::to_wad);

        let context = "quoting a launch";
        let mut batch = Batch::new();
        let launch = batch
            .push(self.address, &Abi::quoteLaunchCall { params: params.encode(platform, max_fee) });
        let platform_version = self
            .client
            .cached_version(platform)
            .is_none()
            .then(|| batch.push(platform, &PlatformAbi::VERSIONCall {}));
        let template =
            batch.push(platform, &PlatformAbi::curveParametersForCall { quote: quote.address });
        let answers = batch.run(self.client, context).await?;

        let quoted = answers.decode::<Abi::quoteLaunchCall>(launch, context)?;
        if let Some(index) = platform_version {
            let version = answers.decode::<PlatformAbi::VERSIONCall>(index, context)?;
            self.client.remember_version(platform, version);
        }
        curve_math::check_platform_version(
            &self.client.cached_version(platform).unwrap_or_default(),
        )?;
        let template = CurveTemplate::decode(
            &answers.decode::<PlatformAbi::curveParametersForCall>(template, context)?,
            quote.clone(),
        );

        let launch_fee = QuoteAmount::from_wad_in(&quote, quoted.launchFeeWad);
        let total_cost = launch_fee.add(&params.initial_buy)?;
        let tokens_out = Tokens::from_wad(quoted.tokensOutWad);
        let trade_fee = QuoteAmount::from_wad_in(&quote, quoted.tradeFeeWad);
        let graduates = Self::would_graduate(&template, params, &trade_fee, tokens_out);
        Ok(LaunchQuote {
            quote_token: quote,
            launch_fee,
            initial_buy: params.initial_buy.clone(),
            total_cost,
            native_value: Usdc::from_wad(quoted.nativeValueWad),
            tokens_out,
            trade_fee,
            graduates,
        })
    }

    /// The migrator registry this launchpad validates a launch's migrator
    /// against, read off the launchpad itself.
    ///
    /// It is the registry a launch **actually** uses, and on a network whose
    /// configuration is right it is [`crate::Client::migrator_registry`]'s.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn migrator_registry(&self) -> Result<Address, Error> {
        self.contract()
            .migratorRegistry()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the launchpad's migrator registry"))
    }

    /// Whether the initial buy alone would take the new curve to its target.
    ///
    /// The launchpad's `quoteLaunch` reports cost and fill and discards the
    /// graduation flag, so this reconstructs it from the platform's **live**
    /// curve template and the rule `CurveQuote` itself applies: a buy graduates
    /// when the reserve it leaves behind reaches the target, **or** when it
    /// clears the curve's whole inventory. On a fresh curve that reserve is
    /// exactly the input net of its fee, and the quote reports both.
    ///
    /// The template is read from the chain and never from
    /// [`crate::CurveTemplate::arcnow_defaults`]. A platform admin can change a
    /// template at any time — arcnow.io's moved by a factor of 1000 on
    /// 2026-09-13 — and a constant here would decide, silently and wrongly,
    /// whether this launch gets a gas limit that lets its migration run.
    ///
    /// A launch that buys nothing collects nothing and cannot graduate.
    fn would_graduate(
        template: &CurveTemplate,
        params: &LaunchParams,
        trade_fee: &QuoteAmount,
        tokens_out: Tokens,
    ) -> bool {
        if params.initial_buy.is_zero() {
            return false;
        }
        let reserve_after = params.initial_buy.to_wad().saturating_sub(trade_fee.to_wad());
        reserve_after >= template.target.to_wad() || tokens_out >= template.curve_supply
    }

    /// The gas limit to send, given what the quote says.
    ///
    /// Three cases, and the middle one is the whole point:
    ///
    /// * an explicit [`LaunchParams::gas_limit`] is honoured, with one refusal;
    /// * no limit on a launch the quote says will **graduate** gets
    ///   [`GRADUATION_GAS_LIMIT`], because `eth_estimateGas` returns the limit
    ///   at which the migration inside the launch does not fit. The launch
    ///   succeeds either way — a starved migration is caught and logged rather
    ///   than reverting — so the estimator's search converges on exactly the
    ///   wrong number. A default that is right beats a footgun that is
    ///   documented;
    /// * no limit on an ordinary launch gets nothing, and the node estimates as
    ///   usual. That estimate is correct and cheaper.
    ///
    /// The refusal: an explicit limit below [`GRADUATION_GAS_FLOOR`] on a
    /// graduating launch is rejected before anything is sent.
    fn gas_for(params: &LaunchParams, graduates: bool) -> Result<Option<u64>, Error> {
        match params.gas_limit {
            None if graduates => Ok(Some(GRADUATION_GAS_LIMIT)),
            None => Ok(None),
            Some(limit) if graduates && limit < GRADUATION_GAS_FLOOR => {
                Err(Error::LaunchGasLimitTooLow {
                    limit,
                    floor: GRADUATION_GAS_FLOOR,
                    suggested: GRADUATION_GAS_LIMIT,
                })
            }
            Some(limit) => Ok(Some(limit)),
        }
    }

    /// The gas an ERC-20-quoted launch is sent with. Its fee shares pass a gas
    /// guard, so a caller's limit is only ever raised: to [`GRADUATION_GAS_LIMIT`]
    /// on a graduating launch (the floor was enforced by [`Self::gas_for`]), to
    /// the estimate plus headroom on an ordinary one.
    async fn erc20_launch_gas<P, D>(
        call: &alloy::contract::CallBuilder<P, D>,
        gas: Option<u64>,
        quote: &LaunchQuote,
        params: &LaunchParams,
    ) -> Result<u64, Error>
    where
        P: alloy::providers::Provider + Clone,
        D: alloy::contract::CallDecoder + Clone,
    {
        if quote.graduates {
            return Ok(gas.map_or(GRADUATION_GAS_LIMIT, |limit| limit.max(GRADUATION_GAS_LIMIT)));
        }
        crate::quote::erc20_trade_gas(
            call,
            gas,
            &quote.quote_token,
            "sending a launch",
            crate::quote::with_quote_transfer_headroom,
        )
        .await
        .map_err(|err| {
            err.with_launch_breakdown(quote.launch_fee.clone(), params.initial_buy.clone())
        })
    }

    /// The addresses `creator`'s next launch of exactly these parameters would
    /// produce. With no [`LaunchParams::max_launch_fee`] the fee is quoted
    /// first, as [`Launchpad::launch`] would.
    ///
    /// Pure prediction; it deploys nothing. **Valid only for that creator's
    /// current [`Launchpad::launch_nonce`] and only for exactly these
    /// parameters** — the salt is derived from both, so a different name, a
    /// launch in between, or anybody else launching the same token elsewhere all
    /// produce different addresses.
    ///
    /// # Errors
    /// Any revert the launchpad raises, decoded.
    pub async fn predict_addresses(
        &self,
        creator: Address,
        params: &LaunchParams,
    ) -> Result<(Address, Address), Error> {
        let max_fee = match &params.max_launch_fee {
            Some(max) => max.to_wad(),
            None => self.quote_launch(params).await?.launch_fee.to_wad(),
        };
        let platform =
            params.platform.map_or_else(|| self.client.network().arcnow_platform(), Ok)?;
        let encoded = params.encode(platform, max_fee);
        let predicted = self
            .contract()
            .predictAddresses(creator, encoded)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "predicting launch addresses"))?;
        Ok((predicted.token, predicted.curve))
    }

    /// Launch: deploy the token and its curve, pay the fee, perform the initial
    /// buy — in the initial buy's quote.
    ///
    /// Quotes first. A **native** launch sends exactly
    /// [`LaunchQuote::native_value`] as value. An **ERC-20** launch makes sure
    /// the creator's allowance to the launchpad covers
    /// [`LaunchQuote::total_cost`] — approving exactly that when it does not —
    /// and sends no value. The maximum launch fee defaults to the fee just
    /// quoted.
    ///
    /// **A launch whose initial buy reaches the graduation target is sent with
    /// an explicit gas limit, chosen here.** The quote already says whether that
    /// will happen, and an estimate is precisely the limit at which the
    /// migration inside the launch is starved and caught. See
    /// [`LaunchParams::gas_limit`] and [`GRADUATION_GAS_LIMIT`].
    ///
    /// Everything in [`LaunchResult`] is read out of the launch's **own
    /// receipt**.
    ///
    /// # Errors
    ///
    /// * Before any RPC: [`Error::SignerRequired`] on a read-only client,
    ///   [`Error::QuoteAmountNotRepresentable`] for an initial buy the quote
    ///   cannot carry, [`Error::QuoteTokenMismatch`] for a maximum fee in
    ///   another quote.
    /// * [`Error::LaunchGasLimitTooLow`] when an explicit gas limit cannot fit
    ///   the migration this launch will attempt — before anything is sent.
    /// * [`Error::IncorrectPayment`] — with the fee-plus-buy breakdown filled in
    ///   — if a native cost moved between the quote and inclusion.
    /// * [`Error::PlatformNotRegistered`], [`Error::MigratorNotRegistered`],
    ///   [`Error::InvalidLaunchParameters`], [`Error::SlippageExceeded`],
    ///   `LaunchFeeAboveMaximum`, `QuoteTokenNotSupported`, or anything the
    ///   platform's own template validation raises.
    pub async fn launch(&self, params: &LaunchParams) -> Result<LaunchResult, Error> {
        let from = self.client.require_signer("Launchpad::launch")?;
        params.check()?;
        let quote = self.quote_launch(params).await?;
        let gas = Self::gas_for(params, quote.graduates)?;

        let platform =
            params.platform.map_or_else(|| self.client.network().arcnow_platform(), Ok)?;
        let max_fee = params.max_launch_fee.as_ref().unwrap_or(&quote.launch_fee).to_wad();
        let encoded = params.encode(platform, max_fee);
        let (value, approval_tx_hash) = if quote.quote_token.is_native {
            (quote.native_value.to_wad(), None)
        } else {
            let (contract, encoded_ref, token) = (self.contract(), &encoded, &quote.quote_token);
            let contract_ref = &contract;
            let preflight = move || async move {
                let Some(overrides) =
                    crate::quote::allowance_override(self.client, token, from, self.address)
                else {
                    return Ok(());
                };
                contract_ref
                    .launch(encoded_ref.clone())
                    .from(from)
                    .state(overrides)
                    .call()
                    .await
                    .map(|_| ())
                    .map_err(|err| {
                        Error::from_contract(err, "simulating a launch before approving it")
                    })
            };
            let approval = self
                .client
                .quote_token_for(quote.quote_token.clone())
                .ensure_allowance_after(self.address, &quote.total_cost, preflight)
                .await?;
            (U256::ZERO, approval.tx_hash)
        };
        let contract = self.contract();
        let call = contract.launch(encoded).from(from).value(value);
        // Set only when this SDK chose one. Without it the node estimates, and
        // on a graduating launch the estimate is the limit that starves the
        // migration.
        let call = if quote.quote_token.is_native {
            match gas {
                Some(limit) => call.gas(limit),
                None => call,
            }
        } else {
            let limit = Self::erc20_launch_gas(&call, gas, &quote, params).await?;
            call.gas(limit)
        };
        let pending = call.send().await.map_err(|err| {
            Error::from_contract(err, "sending a launch")
                .on_erc20_quote(&quote.quote_token, None)
                .with_launch_breakdown(quote.launch_fee.clone(), params.initial_buy.clone())
        })?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the launch receipt", err))?;
        let tx_hash = receipt.transaction_hash;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash });
        }

        // The launch's own log is the only place that records what the launch
        // cost and delivered; neither factory knows.
        let logs = receipt.inner.logs();
        let launched = logs
            .iter()
            .find_map(|log| Abi::Launched::decode_log(&log.inner).ok())
            .ok_or(Error::MissingLog { tx_hash, event: "Launched" })?;

        // And the curve's own logs, in this same receipt, are the only place
        // that records whether the token had a market the moment it existed.
        // Filtered by address: the launch touches the token, both factories and
        // the migrator, and a `Migrated` from anywhere but this curve would be a
        // different curve's business.
        let mut result = LaunchResult {
            token: launched.token,
            curve: launched.curve,
            tokens_out: Tokens::from_wad(launched.tokensOutWad),
            graduated: false,
            instant_migration_failed: false,
            migrated_in_this_transaction: false,
            pool: None,
            tx_hash,
            approval_tx_hash,
        };
        for log in logs.iter().filter(|log| log.address() == launched.curve) {
            if CurveAbi::Graduated::decode_log(&log.inner).is_ok() {
                result.graduated = true;
            } else if CurveAbi::InstantMigrationFailed::decode_log(&log.inner).is_ok() {
                result.instant_migration_failed = true;
            } else if let Ok(migrated) = CurveAbi::Migrated::decode_log(&log.inner) {
                result.migrated_in_this_transaction = true;
                // `address(0)` is a migrator that created no market — an escrow
                // — and is not a pool anybody can trade at, so it is not one
                // here either.
                result.pool = (migrated.pool != Address::ZERO).then_some(migrated.pool);
            }
        }
        Ok(result)
    }

    /// Push the launch fees accrued in `quote` to the immutable fee recipient.
    ///
    /// Permissionless, and can only ever send to
    /// [`Launchpad::fee_recipient`]. Fees accrue rather than being pushed on
    /// every launch for the same reason trade fees can be deferred: a
    /// blocklisted or reverting fee recipient must not be able to make every
    /// launch fail.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`] on a read-only client; [`Error::NoFeesToCollect`]
    /// when nothing has accrued.
    pub async fn collect_launch_fees(&self, quote: Address) -> Result<B256, Error> {
        let from = self.client.require_signer("Launchpad::collect_launch_fees")?;
        let pending = self
            .contract()
            .collectLaunchFees(quote)
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "collecting launch fees"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the fee-collection receipt", err))?;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
        }
        Ok(receipt.transaction_hash)
    }

    /// Launch fees taken in `quote` and not yet pushed.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn accrued_fees(&self, quote: Address) -> Result<QuoteAmount, Error> {
        let info = self.client.quote_token_info(quote).await?;
        let raw = self
            .contract()
            .accruedFeesWad(quote)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading accrued launch fees"))?;
        Ok(QuoteAmount::from_wad_in(&info, raw))
    }
}

#[cfg(test)]
mod tests {
    //! The gas limit a launch is sent with, decided without a chain.
    //!
    //! A launch whose *initial buy* reaches the graduation target graduates the
    //! curve inside the launch transaction, and the curve attempts the migration
    //! there and **catches its failure** — logging `InstantMigrationFailed`
    //! rather than reverting. So the launch succeeds whether or not the
    //! migration runs, and `eth_estimateGas`, which searches for the lowest
    //! limit at which the transaction still succeeds, converges on exactly the
    //! limit that starves it.
    //!
    //! That happened on Arc testnet: a token that graduated the moment it was
    //! created, no pool, and no error anywhere, until a bystander's
    //! permissionless `migrate()` rescued it.
    //!
    //! What it takes a fork to prove — that 8,000,000 is actually enough — is in
    //! `tests/fork.rs`.

    use super::{GRADUATION_GAS_FLOOR, GRADUATION_GAS_LIMIT, LaunchParams, Launchpad};
    use crate::amount::Usdc;
    use crate::error::Error;

    fn params() -> LaunchParams {
        LaunchParams::new("Example", "EXMPL", "ipfs://example").initial_buy(Usdc::from_whole(60))
    }

    #[test]
    fn an_ordinary_launch_is_left_to_the_node() {
        // Where the estimate is correct it is also cheaper, and an SDK that
        // pinned 8,000,000 onto every launch would be asking every caller to
        // reserve gas for a migration that is not going to happen.
        assert_eq!(Launchpad::gas_for(&params(), false).unwrap(), None);
    }

    #[test]
    fn a_graduating_launch_gets_a_sufficient_limit_without_being_asked() {
        // THE FIX. Not "documents that you should pass one": supplies it. A
        // caller has no way to know from anything in front of them that this
        // launch is the one where estimation is wrong, and the quote knows.
        assert_eq!(Launchpad::gas_for(&params(), true).unwrap(), Some(GRADUATION_GAS_LIMIT));
        // 6,000,000 for the migrator plus the curve's own 100,000 reserve, and
        // two deployments before either of those runs.
        const { assert!(GRADUATION_GAS_LIMIT > GRADUATION_GAS_FLOOR) };
        const { assert!(GRADUATION_GAS_FLOOR > 6_100_000) };
    }

    #[test]
    fn an_explicit_limit_is_honoured() {
        let asked = params().gas_limit(9_000_000);
        assert_eq!(Launchpad::gas_for(&asked, true).unwrap(), Some(9_000_000));
        let small = params().gas_limit(500_000);
        assert_eq!(Launchpad::gas_for(&small, false).unwrap(), Some(500_000));
    }

    #[test]
    fn a_limit_that_would_starve_the_migration_is_refused() {
        // Refused rather than sent, because it is not a limit that makes the
        // launch FAIL. It makes it succeed and quietly do half the job, and
        // there is no error afterwards to read.
        let starved = params().gas_limit(GRADUATION_GAS_FLOOR - 1);
        let err = Launchpad::gas_for(&starved, true).unwrap_err();
        assert!(
            matches!(err, Error::LaunchGasLimitTooLow { floor: GRADUATION_GAS_FLOOR, .. }),
            "{err:?}"
        );
        assert!(err.to_string().contains("would still SUCCEED"), "{err}");
    }

    #[test]
    fn the_floor_clears_every_measured_graduation() {
        // The floor is the migration budget
        // plus the curve's reserve plus margin, and it must stay above every
        // limit below which a graduating transaction was measured to skip its
        // instant migration — otherwise the SDK would accept a limit that
        // succeeds and quietly does half the job.
        const INSTANT_MIGRATION_GAS_LIMIT: u64 = 6_000_000;
        const POST_MIGRATION_GAS_RESERVE: u64 = 100_000;
        const V2_LAUNCH_MIGRATES_ABOVE: u64 = 5_880_000;
        const V2_LAUNCH_GAS_USED: u64 = 5_298_297;
        const V2_BUY_MIGRATES_ABOVE: u64 = 845_500;
        const V2_BUY_GAS_USED: u64 = 741_432;
        const {
            assert!(
                GRADUATION_GAS_FLOOR
                    == INSTANT_MIGRATION_GAS_LIMIT + POST_MIGRATION_GAS_RESERVE + 100_000
            );
        };
        for threshold in
            [V2_LAUNCH_MIGRATES_ABOVE, V2_LAUNCH_GAS_USED, V2_BUY_MIGRATES_ABOVE, V2_BUY_GAS_USED]
        {
            assert!(GRADUATION_GAS_FLOOR > threshold, "the floor must clear {threshold}");
            assert!(GRADUATION_GAS_LIMIT > threshold, "the default must clear {threshold}");
        }
        // 5.4% of headroom over the tightest threshold, as measured.
        const { assert!(GRADUATION_GAS_FLOOR * 1000 / V2_LAUNCH_MIGRATES_ABOVE >= 1054) };
    }

    #[test]
    fn mirrors_the_contracts_sdk_gas_limits() {
        // arcnow-io/contracts pins the same two numbers in its GraduationGasFloor
        // tests (SdkGasLimits.FLOOR and SdkGasLimits.LIMIT) and proves an instant
        // migration succeeds at the floor. Moving either on one side only is the
        // drift this test and that one exist to catch.
        assert_eq!(GRADUATION_GAS_FLOOR, 6_200_000, "SdkGasLimits.FLOOR");
        assert_eq!(GRADUATION_GAS_LIMIT, 8_000_000, "SdkGasLimits.LIMIT");
    }

    #[test]
    fn the_floor_is_a_floor_and_not_a_fence() {
        let exact = params().gas_limit(GRADUATION_GAS_FLOOR);
        assert_eq!(Launchpad::gas_for(&exact, true).unwrap(), Some(GRADUATION_GAS_FLOOR));
    }

    #[test]
    fn a_small_limit_on_a_launch_that_graduates_nothing_is_not_second_guessed() {
        // The refusal is about one specific silent failure. A caller capping gas
        // on an ordinary launch is doing something ordinary.
        let capped = params().gas_limit(100_000);
        assert_eq!(Launchpad::gas_for(&capped, false).unwrap(), Some(100_000));
    }
}
