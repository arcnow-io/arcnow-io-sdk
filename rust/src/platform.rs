//! Platforms: the fee split, the residual that is never an input, and creating
//! one.
//!
//! # bps **of the fee**, never of the trade
//!
//! Every share in this module is in basis points of the 1% trade fee. A creator
//! share of 3000 bps is 30% of the fee and **0.30% of the trade**. This is the
//! single easiest mistake in the design and the most expensive to find in
//! production; [`crate::Bps`] carries the same warning on the type.
//!
//! # Four parties
//!
//! A fee is split between the **creator**, the **platform**, a **referrer**
//! and the **protocol** — [`FeeShare`], in the contracts' own order. arcnow.io's
//! own platform splits the curve's 1.00% as creator 3000 / ref 1000 / platform
//! 3500 / protocol 2500 bps of the fee. There is no developer share: the model
//! that carried one was retired with the multi-quote (v3) stack, and its 1000
//! bps fell to the platform, because the platform is what the residual is.
//!
//! # The platform's own cut is a residual
//!
//! **[`NewPlatform`] has no platform-share field, and that is the point.** A
//! platform allocates at most 7500 bps across creator and ref, and whatever it
//! does not allocate is its own share:
//!
//! ```text
//! platform = 10000 - protocol - creator - ref
//! ```
//!
//! computed on demand, never stored as an input anywhere in the contracts. Two
//! things fall out of that, both deliberate:
//!
//! 1. Setting ref to zero moves those bps to the platform — which is *exactly*
//!    the rule that applies at swap time when the ref **address** is `None`.
//!    One rule, stated once.
//! 2. The 7500 allowance is measured against the protocol's **maximum** share
//!    (2500), not its current one. So a protocol admin lowering the protocol
//!    share widens every platform's residual automatically, and no
//!    protocol-share change within its bounds can invalidate a stored platform
//!    configuration or stop it launching. The alternative — three explicit
//!    shares checked against the current protocol share — makes a routine
//!    protocol change a platform-wide launch outage.
//!
//! [`platform_share_bps`] computes the residual without deploying anything, and
//! [`NewPlatform::validate`] refuses an over-allocation client-side, before a
//! transaction is sent, with the residual the caller is actually choosing.
//!
//! # Registering a platform is the protocol admin's alone
//!
//! **[`PlatformRegistry::register_platform`] is callable only by the registry's
//! `protocolAdmin`.** An ordinary caller gets [`crate::Error::NotProtocolAdmin`].
//! This is the single most likely surprise in this API, so it is said here, on
//! the method, and in the error's own message.
//!
//! The registry **deploys** the `PlatformConfig` rather than registering an
//! address somebody hands it. That is the difference between a platform being a
//! configuration and a platform being arbitrary code: a registry that accepted a
//! supplied address would be accepting a contract that can answer one thing to a
//! validation call and another to the launch that follows it.

use core::fmt;

use alloy::primitives::{Address, B256};
use alloy::providers::DynProvider;
use alloy::sol_types::SolEvent;

use crate::amount::{Bps, QuoteAmount};
use crate::bindings::platform_config::PlatformConfig as ConfigAbi;
use crate::bindings::platform_registry::PlatformRegistry as RegistryAbi;
use crate::client::Client;
use crate::constants::{CurveTemplate, MAX_PLATFORM_ALLOWANCE_BPS};
use crate::curve_math;
use crate::error::Error;

/// Who a fee share is paid to: `IFeeConfig.FeeShare`, in the contracts' order.
///
/// The value a `FeePaid` or `FeeDeferred` log carries in its indexed `share`
/// topic, so an indexer can attribute a payout without decoding anything else.
/// `Protocol` is 3: the developer share that sat between `Ref` and `Protocol`
/// in the retired multi-quote (v3) stack is gone, and every value after it
/// moved down by one. A share whose amount floors to zero writes no log at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum FeeShare {
    /// The token's creator, read off its creator seat at swap time.
    Creator = 0,
    /// The platform's own residual — and every unaddressed share.
    Platform = 1,
    /// The referrer a curve trade named. A pool has none.
    Ref = 2,
    /// The arcnow.io protocol.
    Protocol = 3,
}

impl FeeShare {
    /// The four parties, in enum order.
    pub const ALL: [Self; 4] = [Self::Creator, Self::Platform, Self::Ref, Self::Protocol];

    /// The party a `share` topic names, or `None` for a value the enum does
    /// not have.
    #[must_use]
    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Creator),
            1 => Some(Self::Platform),
            2 => Some(Self::Ref),
            3 => Some(Self::Protocol),
            _ => None,
        }
    }
}

impl TryFrom<u8> for FeeShare {
    type Error = u8;

    /// The offending value comes back as the error.
    fn try_from(value: u8) -> Result<Self, u8> {
        Self::from_u8(value).ok_or(value)
    }
}

impl fmt::Display for FeeShare {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Creator => "creator",
            Self::Platform => "platform",
            Self::Ref => "ref",
            Self::Protocol => "protocol",
        })
    }
}

/// A complete, validated four-way split, as one curve and one token snapshotted
/// it at creation — or as the fee hook wrote it for a pool.
///
/// The four bps fields total exactly 10000. On a curve `platform_share` is a
/// **residual**, materialised here so a reader of the snapshot never has to
/// recompute it; on a pool it is one of three stated inputs and `ref_share` is
/// zero (see [`crate::Pool::fee_config`]).
///
/// Only two recipients live here: the creator and the referrer are resolved
/// *per swap* — the creator from the token's creator seat, read live, and the
/// referrer from the argument of the trade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeConfig {
    /// The creator's share, in bps **of the fee**.
    pub creator_share: Bps,
    /// The platform's own share: the residual, and the destination of every
    /// share whose address is unset at swap time.
    pub platform_share: Bps,
    /// The referrer's share, in bps of the fee.
    pub ref_share: Bps,
    /// The protocol's share. Protocol-controlled; a platform cannot change it.
    pub protocol_share: Bps,
    /// Where the platform's own share is sent. Fixed at creation, never zero.
    pub platform_recipient: Address,
    /// Where the protocol's share is sent. Fixed at creation, never zero.
    pub protocol_recipient: Address,
}

impl FeeConfig {
    pub(crate) fn from_abi(
        creator: alloy::primitives::U256,
        platform: alloy::primitives::U256,
        ref_share: alloy::primitives::U256,
        protocol: alloy::primitives::U256,
        platform_recipient: Address,
        protocol_recipient: Address,
    ) -> Result<Self, Error> {
        Ok(Self {
            creator_share: Bps::from_u256(creator)?,
            platform_share: Bps::from_u256(platform)?,
            ref_share: Bps::from_u256(ref_share)?,
            protocol_share: Bps::from_u256(protocol)?,
            platform_recipient,
            protocol_recipient,
        })
    }

    /// The four shares, totalled. Always exactly 10000 on a valid config.
    #[must_use]
    pub fn total(&self) -> Bps {
        Bps::of_fee(
            self.creator_share.get()
                + self.platform_share.get()
                + self.ref_share.get()
                + self.protocol_share.get(),
        )
    }

    /// The share of one party, by [`FeeShare`].
    #[must_use]
    pub const fn share(&self, party: FeeShare) -> Bps {
        match party {
            FeeShare::Creator => self.creator_share,
            FeeShare::Platform => self.platform_share,
            FeeShare::Ref => self.ref_share,
            FeeShare::Protocol => self.protocol_share,
        }
    }
}

/// One fee, resolved into the four amounts and the four addresses that will
/// actually receive them.
///
/// The four amounts total the fee **exactly**, at every size including a fee of
/// one wei. The three proportional shares are floored and the rounding dust — at
/// most three wei — lands in `platform_amount`, which is computed as the
/// residual.
///
/// A consequence worth stating: **`platform_share == 0` does not mean the
/// platform is never paid.** A platform that allocated its whole allowance away
/// still receives the three floors' worth of dust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeSplit {
    /// The creator's recipient — the token's creator seat, read at swap time.
    pub creator: Address,
    /// The platform's recipient.
    pub platform: Address,
    /// The referrer, or the platform recipient when none was named.
    pub referrer: Address,
    /// The protocol's recipient.
    pub protocol: Address,
    /// The creator's amount, in the fee's quote.
    pub creator_amount: QuoteAmount,
    /// The platform's amount, including the rounding dust.
    pub platform_amount: QuoteAmount,
    /// The referrer's amount. Keeps its identity even when it is paid to the
    /// platform, so referral reporting does not silently become platform
    /// revenue.
    pub referrer_amount: QuoteAmount,
    /// The protocol's amount.
    pub protocol_amount: QuoteAmount,
}

impl FeeSplit {
    /// The four amounts, totalled. Equals the fee exactly.
    ///
    /// # Panics
    ///
    /// Never for a split this crate built: all four are in the fee's quote.
    #[must_use]
    pub fn total(&self) -> QuoteAmount {
        self.creator_amount.clone()
            + self.platform_amount.clone()
            + self.referrer_amount.clone()
            + self.protocol_amount.clone()
    }

    /// The recipient and amount of one party, by [`FeeShare`].
    #[must_use]
    pub fn part(&self, party: FeeShare) -> (Address, &QuoteAmount) {
        match party {
            FeeShare::Creator => (self.creator, &self.creator_amount),
            FeeShare::Platform => (self.platform, &self.platform_amount),
            FeeShare::Ref => (self.referrer, &self.referrer_amount),
            FeeShare::Protocol => (self.protocol, &self.protocol_amount),
        }
    }
}

/// A platform to create.
///
/// **There is no platform-share field.** The platform's own cut is the residual
/// of whatever it does not allocate here; see the module documentation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPlatform {
    /// The platform's first admin. Two-step handover thereafter.
    pub admin: Address,
    /// Where the platform's own share of the fee goes — and where any creator
    /// or ref share with no address goes too. Must not be zero.
    pub fee_recipient: Address,
    /// The creator's share, in bps **of the fee**. arcnow.io's own is 3000.
    pub creator_share_bps: Bps,
    /// The referrer's share, in bps of the fee. Zero sends those bps to the
    /// platform. arcnow.io's own is 1000.
    pub ref_share_bps: Bps,
    /// The migrator this platform's tokens graduate to by default. Must be
    /// registered in the migrator registry.
    pub default_migrator: Address,
    /// The **native USDC** bonding-curve template the platform is registered
    /// with. Templates in other quotes are set afterwards by the platform's
    /// admin, one per quote.
    pub curve: CurveTemplate,
}

impl NewPlatform {
    /// Check the allocation before sending anything.
    ///
    /// # Errors
    ///
    /// [`Error::FeeSharesExceedAllowance`] when creator + ref exceeds 7500 bps,
    /// with a message naming the residual the caller is actually choosing —
    /// which is the number they were reasoning about even if they did not write
    /// it down.
    pub fn validate(&self) -> Result<(), Error> {
        let requested = self.creator_share_bps.get() + self.ref_share_bps.get();
        if requested <= MAX_PLATFORM_ALLOWANCE_BPS.get() {
            return Ok(());
        }
        Err(Error::FeeSharesExceedAllowance {
            creator: self.creator_share_bps,
            ref_share: self.ref_share_bps,
            requested: Bps::of_fee(requested),
            allowance: MAX_PLATFORM_ALLOWANCE_BPS,
            residual: format!(
                "{} bps short of anything at all",
                requested - MAX_PLATFORM_ALLOWANCE_BPS.get()
            ),
        })
    }

    /// What this platform's own share would be, against the current protocol
    /// share.
    ///
    /// See [`platform_share_bps`] for the arithmetic and its caveat.
    #[must_use]
    pub fn platform_share_bps(&self, protocol_share: Bps) -> Bps {
        platform_share_bps(self.creator_share_bps, self.ref_share_bps, protocol_share)
    }
}

/// The platform's own cut: `10000 - protocol - creator - ref`.
///
/// Pure; it deploys nothing and reads nothing. Call it to see your own share
/// before registering anything.
///
/// `protocol_share` is the registry's *current* protocol share — read it with
/// [`PlatformRegistry::protocol_share_bps`]. Note the asymmetry that makes the
/// whole design work: the **allowance** a platform is checked against is
/// measured at the protocol's maximum (2500), while the **residual** it actually
/// receives is computed from whatever the protocol's share is at the moment of
/// the launch. Lowering the protocol share can only ever widen this number.
///
/// Returns zero rather than wrapping if the three shares somehow exceed 10000,
/// which a validated configuration cannot.
#[must_use]
pub fn platform_share_bps(creator: Bps, ref_share: Bps, protocol_share: Bps) -> Bps {
    let allocated = protocol_share.get() + creator.get() + ref_share.get();
    Bps::of_fee(Bps::DENOMINATOR.saturating_sub(allocated))
}

/// The protocol's registry of platforms.
#[derive(Debug, Clone, Copy)]
pub struct PlatformRegistry<'a> {
    client: &'a Client,
    address: Address,
}

impl<'a> PlatformRegistry<'a> {
    pub(crate) fn new(client: &'a Client, address: Address) -> Self {
        Self { client, address }
    }

    /// The registry's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    fn contract(&self) -> RegistryAbi::PlatformRegistryInstance<DynProvider> {
        RegistryAbi::new(self.address, self.client.provider().clone())
    }

    /// The registry's `VERSION()`, verbatim.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn version(&self) -> Result<String, Error> {
        self.contract()
            .VERSION()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform registry's VERSION()"))
    }

    /// Refuse a registry that is not `arcnow/platform-registry@4.x.x`, whose
    /// platforms hold one template per quote and split a fee four ways.
    async fn check_version(&self) -> Result<(), Error> {
        curve_math::check_registry_version(&self.version().await?)
    }

    /// The protocol's share of every fee, in bps of the fee.
    ///
    /// Protocol-controlled and **identical for every platform**. This is the
    /// invariant that makes multi-platform work: a platform chooses how the other
    /// 7500 bps are spent and never how much the protocol takes.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or [`Error::ImplausibleBps`].
    pub async fn protocol_share_bps(&self) -> Result<Bps, Error> {
        let raw = self
            .contract()
            .protocolShareBps()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the protocol share"))?;
        Bps::from_u256(raw)
    }

    /// Where the protocol's share is sent.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn protocol_recipient(&self) -> Result<Address, Error> {
        self.contract()
            .protocolRecipient()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the protocol recipient"))
    }

    /// The account that may register and deregister platforms.
    ///
    /// Worth reading before [`PlatformRegistry::register_platform`], which is
    /// this account's alone.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn protocol_admin(&self) -> Result<Address, Error> {
        self.contract()
            .protocolAdmin()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the protocol admin"))
    }

    /// True if `platform` is a config this registry deployed and has not
    /// deregistered.
    ///
    /// A launch checks the same thing **at inclusion**, so a platform that was
    /// live when you signed can still be refused.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn is_platform(&self, platform: Address) -> Result<bool, Error> {
        self.contract()
            .isPlatform(platform)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "checking whether an address is a platform"))
    }

    /// How many platforms this registry has ever created.
    ///
    /// A creation counter, **not a live count**: it includes deregistered ones,
    /// and it is what [`PlatformRegistry::platform_at`] indexes into.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn platform_count(&self) -> Result<u64, Error> {
        let raw = self
            .contract()
            .platformCount()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the platform count"))?;
        u64::try_from(raw).map_err(|_| {
            Error::abi("reading the platform count", "the count does not fit in a u64")
        })
    }

    /// The `index`-th platform this registry created, in creation order.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or a revert if `index` is past
    /// [`PlatformRegistry::platform_count`].
    pub async fn platform_at(&self, index: u64) -> Result<Address, Error> {
        self.contract()
            .platformAt(alloy::primitives::U256::from(index))
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform by index"))
    }

    /// The complete fee split a launch on `platform` would snapshot right now.
    ///
    /// **The single assembly point.** The platform supplies its two allocations
    /// and its own recipient; the registry supplies the protocol share and
    /// recipient from its own storage. The result is validated here — four shares
    /// totalling exactly 10000, both fixed recipients non-zero — before it is
    /// returned, so a launch never has to trust either half. It is also what
    /// stops a platform naming itself as the protocol recipient.
    ///
    /// # Errors
    /// [`Error::PlatformNotRegistered`] for an unknown or deregistered platform.
    pub async fn fee_config_for(&self, platform: Address) -> Result<FeeConfig, Error> {
        let config = self
            .contract()
            .feeConfigFor(platform)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform's fee config"))?;
        FeeConfig::from_abi(
            config.creatorShareBps,
            config.platformShareBps,
            config.refShareBps,
            config.protocolShareBps,
            config.platformRecipient,
            config.protocolRecipient,
        )
    }

    /// Deploy and register a new platform.
    ///
    /// **Callable only by the registry's `protocolAdmin`.** An ordinary caller
    /// gets [`Error::NotProtocolAdmin`], and that is the single most likely
    /// surprise in this API — the method is here because reading it, quoting it
    /// and understanding it are useful to everyone, not because everyone can call
    /// it. Read [`PlatformRegistry::protocol_admin`] to see who can.
    ///
    /// The allocation is checked **client-side first**, so an over-allocation
    /// costs nothing and the error names the residual you were actually choosing.
    /// The curve template is then validated by the config's own constructor: a
    /// set that cannot satisfy the `Y0`/`V0` relationships is refused here rather
    /// than deployed and discovered by the first launch.
    ///
    /// # Errors
    ///
    /// * [`Error::SignerRequired`] on a read-only client, before any RPC.
    /// * [`Error::FeeSharesExceedAllowance`] client-side, before any RPC.
    /// * [`Error::InvalidArgument`] for a template in any quote but native
    ///   USDC, before any RPC: a platform is registered with its native
    ///   template.
    /// * [`Error::UnknownCurveVersion`] for a registry that is not
    ///   `arcnow/platform-registry@4.x.x`, before anything is sent.
    /// * [`Error::NotProtocolAdmin`] from the chain.
    /// * [`Error::MigratorNotRegistered`] when the default migrator is not in
    ///   the migrator registry.
    /// * [`Error::InitialPriceMismatch`], [`Error::GraduationTargetMismatch`],
    ///   [`Error::CurveNotPriceable`], [`Error::InvalidSupplies`] or
    ///   [`Error::PoolReserveMismatch`] when the template does not hold together.
    pub async fn register_platform(
        &self,
        platform: &NewPlatform,
    ) -> Result<(Address, B256), Error> {
        let from = self.client.require_signer("PlatformRegistry::register_platform")?;
        platform.validate()?;
        if !platform.curve.quote_token.is_native {
            return Err(Error::InvalidArgument {
                reason: format!(
                    "a platform is registered with its native USDC template, and this one is in \
                     {} ({}); set templates in other quotes with the platform's own \
                     setCurveParameters(quote, ..) after it exists",
                    platform.curve.quote_token.symbol, platform.curve.quote_token.address
                ),
            });
        }
        self.check_version().await?;

        let t = &platform.curve;
        let pending = self
            .contract()
            .registerPlatform(
                platform.admin,
                platform.fee_recipient,
                platform.creator_share_bps.to_u256(),
                platform.ref_share_bps.to_u256(),
                platform.default_migrator,
                crate::bindings::platform_registry::IPlatformConfig::CurveParameters {
                    totalSupplyWad: t.total_supply.to_wad(),
                    curveSupplyWad: t.curve_supply.to_wad(),
                    y0Wad: t.y0.to_wad(),
                    r0Wad: t.r0.to_wad(),
                    targetQuoteWad: t.target.to_wad(),
                    initialPriceWad: t.initial_price.to_wad(),
                },
            )
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "registering a platform"))?;
        let receipt = pending
            .get_receipt()
            .await
            .map_err(|err| Error::rpc("waiting for the registration receipt", err))?;
        let tx_hash = receipt.transaction_hash;
        if !receipt.status() {
            return Err(Error::TransactionReverted { tx_hash });
        }
        for log in receipt.inner.logs() {
            if let Ok(event) = RegistryAbi::PlatformRegistered::decode_log(&log.inner) {
                return Ok((event.platform, tx_hash));
            }
        }
        Err(Error::MissingLog { tx_hash, event: "PlatformRegistered" })
    }

    /// The template a launch on `platform` in `quote` would get. See
    /// [`PlatformConfigHandle::curve_parameters_for`].
    ///
    /// # Errors
    /// As [`PlatformConfigHandle::curve_parameters_for`].
    pub async fn curve_parameters_for(
        &self,
        platform: Address,
        quote: Address,
    ) -> Result<CurveTemplate, Error> {
        self.client.platform(platform).curve_parameters_for(quote).await
    }

    /// Whether `platform` has a template in `quote`, which a launch in that
    /// quote needs. See [`PlatformConfigHandle::has_curve_parameters`].
    ///
    /// # Errors
    /// As [`PlatformConfigHandle::has_curve_parameters`].
    pub async fn has_curve_parameters(
        &self,
        platform: Address,
        quote: Address,
    ) -> Result<bool, Error> {
        self.client.platform(platform).has_curve_parameters(quote).await
    }
}

/// One platform's `PlatformConfig`.
///
/// Everything on it is a **template for the next launch, never a control over a
/// launched one**. A launch reads this contract once, copies the result into the
/// curve's and the token's immutables, and never looks at it again. An admin
/// changing every value here cannot move one wei of an already-launched curve.
#[derive(Debug, Clone, Copy)]
pub struct PlatformConfigHandle<'a> {
    client: &'a Client,
    address: Address,
}

impl<'a> PlatformConfigHandle<'a> {
    pub(crate) fn new(client: &'a Client, address: Address) -> Self {
        Self { client, address }
    }

    /// The config's address, which is the platform's identity everywhere else in
    /// this system.
    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    fn contract(&self) -> ConfigAbi::PlatformConfigInstance<DynProvider> {
        ConfigAbi::new(self.address, self.client.provider().clone())
    }

    /// The account permitted to change this platform's settings.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn admin(&self) -> Result<Address, Error> {
        self.contract()
            .admin()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform's admin"))
    }

    /// Where this platform's own share of the fee is sent.
    ///
    /// Also the destination of any creator or ref share whose address is unset
    /// at swap time.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn fee_recipient(&self) -> Result<Address, Error> {
        self.contract()
            .feeRecipient()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform's fee recipient"))
    }

    /// The migrator every new token of this platform graduates to, unless its
    /// creator picks another registered one.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn default_migrator(&self) -> Result<Address, Error> {
        self.contract()
            .defaultMigrator()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform's default migrator"))
    }

    /// The complete fee split a launch would snapshot right now.
    ///
    /// Assembled from this platform's two allocations and its recipient, plus
    /// the protocol share and recipient read from the registry. **The protocol
    /// half is not this contract's to supply.**
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or a revert if the assembled split
    /// does not total 10000.
    pub async fn fee_config(&self) -> Result<FeeConfig, Error> {
        let config = self
            .contract()
            .feeConfig()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform's fee config"))?;
        FeeConfig::from_abi(
            config.creatorShareBps,
            config.platformShareBps,
            config.refShareBps,
            config.protocolShareBps,
            config.platformRecipient,
            config.protocolRecipient,
        )
    }

    /// The platform's `VERSION()`, verbatim.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn version(&self) -> Result<String, Error> {
        self.contract()
            .VERSION()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform's VERSION()"))
    }

    /// Refuse a platform that is not `arcnow/platform-config@4.x.x`, which holds
    /// one template per quote. The version is read once per client.
    async fn check_version(&self) -> Result<(), Error> {
        let version = self.client.version_of(self.address, async { self.version().await }).await?;
        curve_math::check_platform_version(&version)
    }

    /// The bonding-curve template a new launch on this platform **in `quote`**
    /// would get: `curveParametersFor(quote)`, with the reserves, target and
    /// prices in that quote. [`crate::NATIVE_QUOTE`] for native USDC.
    ///
    /// **The version is read first**, and anything but
    /// `arcnow/platform-config@4.x.x` is refused.
    ///
    /// # Errors
    /// `NoCurveParameters(quote)`, decoded, when the platform has no template
    /// in that quote; [`Error::UnknownCurveVersion`]; [`Error::Rpc`].
    pub async fn curve_parameters_for(&self, quote: Address) -> Result<CurveTemplate, Error> {
        self.check_version().await?;
        let raw = self
            .contract()
            .curveParametersFor(quote)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a platform's curve template"))?;
        let quote_token = self.client.quote_token_info(quote).await?;
        Ok(CurveTemplate::decode(&raw, quote_token))
    }

    /// Whether this platform has a template in `quote`. A launch in a quote the
    /// platform has no template for is refused.
    ///
    /// # Errors
    /// [`Error::UnknownCurveVersion`]; [`Error::Rpc`] if the endpoint fails.
    pub async fn has_curve_parameters(&self, quote: Address) -> Result<bool, Error> {
        self.check_version().await?;
        self.contract()
            .hasCurveParameters(quote)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "checking a platform's curve template"))
    }

    /// Check a candidate curve template without storing it and without sending a
    /// transaction.
    ///
    /// The same validation `setCurveParameters` applies. It **reverts with the
    /// specific error** rather than returning false, so the caller learns *which*
    /// relationship failed — which is the whole value of asking.
    ///
    /// # Errors
    ///
    /// [`Error::InitialPriceMismatch`], [`Error::GraduationTargetMismatch`],
    /// [`Error::CurveNotPriceable`], [`Error::InvalidSupplies`] or
    /// [`Error::PoolReserveMismatch`], each naming what it found;
    /// [`Error::UnknownCurveVersion`] for a platform that is not
    /// `arcnow/platform-config@4.x.x`.
    pub async fn check_curve_parameters(&self, template: &CurveTemplate) -> Result<(), Error> {
        self.check_version().await?;
        self.contract()
            .checkCurveParameters(template.to_abi())
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "checking a curve template"))?;
        Ok(())
    }
}
