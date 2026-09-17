//! The protocol's list of graduation targets.
//!
//! A platform picks a default from this list and a creator may pick another from
//! it — and from nothing wider, because the alternative is a creator pointing
//! their own buyers' liquidity at an address they control.
//!
//! # What is recorded here, and when
//!
//! A migrator's **tax mode** and its **canonical router** are read and recorded
//! once, at registration, and never re-read. A migrator that could change its
//! answer could switch the fee on every future trade of an already-launched token
//! on or off; one that could revert would brick every launch that named it. A
//! venue whose mode changed is a different contract, and re-registering the same
//! address is refused permanently.
//!
//! # Deregistration reaches nothing that exists
//!
//! A curve already bound to a migrator still migrates to it. A token that already
//! recorded a pool keeps the mode recorded against it. Deregistration stops the
//! *next* launch from choosing it, and nothing else — which is why
//! [`crate::CurveState::migrator`], not this list, is the authoritative answer
//! for a particular token.

use alloy::primitives::Address;
use alloy::providers::DynProvider;

use crate::bindings::migrator_registry::MigratorRegistry as Abi;
use crate::client::Client;
use crate::error::Error;

/// Where, if anywhere, arcnow.io's fee is taken once a token has migrated.
///
/// Recorded at registration, snapshotted onto each curve at launch, and written
/// onto the token at migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaxMode {
    /// **Nobody takes an arcnow fee.** Trading costs whatever the pool charges
    /// natively and none of it reaches an arcnow recipient. This is Uniswap v2,
    /// Uniswap v3 and the escrow fallback: none of them can run our code inside
    /// a swap, and a fee collected by a router of our own would be skipped by
    /// anyone calling the pool directly.
    None,
    /// **A v4 hook takes the pool's own 0.80% in the quote inside the swap** and
    /// splits it three ways — creator, platform, protocol — on the pool's own
    /// split; with Uniswap's 0.20% LP fee the trade costs the same 1.00% the
    /// curve charged. This is Uniswap v4, and it is the only mode under which a
    /// platform earns anything after graduation.
    ///
    /// The fee is taken in USDC and never in the token, which is what lets the
    /// token stay a plain ERC-20 that any router can handle — and therefore what
    /// lets the LP be burned rather than escrowed.
    HookFee,
}

impl TaxMode {
    fn from_u8(value: u8) -> Result<Self, Error> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::HookFee),
            other => Err(Error::abi(
                "reading a migrator's tax mode",
                format!("{other} is not a value of IMigrator.TaxMode"),
            )),
        }
    }
}

/// One graduation target, as a creator choosing a venue needs to see it.
///
/// Assembled rather than read: the registry stores a tax mode and a router and
/// nothing else, so the label comes off the migrator and the reachability is a
/// comparison this crate makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigratorInfo {
    /// The migrator's address — what [`crate::LaunchParams::migrator`] takes.
    pub address: Address,
    /// Whether anything is charged after graduation, and by what.
    pub tax_mode: TaxMode,
    /// The canonical router, or `Address::ZERO` when the venue has none.
    ///
    /// **Zero is the normal, safe value** and it means *nobody* is
    /// auto-approved, not "the zero address is". Uniswap v4 records zero: its
    /// `PoolManager` settles from balances a router already transferred in, so
    /// there is no single router to privilege.
    pub router: Address,
    /// What the registry was handed as this migrator's label, recovered.
    ///
    /// **There is no `labelOf` on the contract.** The label appears only in the
    /// `MigratorRegistered` event and is not stored, so this reads `VERSION()`
    /// off the migrator itself — which is what `Deploy.s.sol` passes as the
    /// label. A migrator that does not answer `VERSION()` gets an empty string
    /// here rather than failing the whole list: an unlabelled venue is still a
    /// venue.
    pub label: String,
    /// Whether a token graduating here would land in a pool this SDK can trade
    /// on this network.
    ///
    /// The same question [`crate::Pool::is_reachable`] asks, one step earlier:
    ///
    /// * **a v4 migrator** (it answers `poolManager()`): `true` if and only if
    ///   this network configures a router (`contracts.v4Router`) **and** that
    ///   router's own immutable `poolManager()` is this migrator's. `false`
    ///   while no router is configured — which is every preset until arcnow.io's
    ///   router is broadcast — because until then nothing here can trade the
    ///   pool, even though the pool itself will be fine;
    /// * **any other migrator** (no `poolManager()` — an escrow, a v2 or v3
    ///   venue): `true`, because the question does not apply to it.
    ///
    /// A UI offering venue choice can grey a `false` out. With arcnow.io's own
    /// router configured, arcnow.io's own v4 migrator reads `true`.
    pub reachable: bool,
}

impl MigratorInfo {
    /// Whether a migrator bound to `migrator_pool_manager` graduates into a pool
    /// the configured router can reach.
    ///
    /// `router_pool_manager` is the `poolManager()` of this network's
    /// configured router, or `None` when the network configures no router.
    /// Split out and public because it is the whole of the judgement:
    ///
    /// * the migrator names no `PoolManager` — not a v4 venue, so the question
    ///   does not apply and the answer is `true`;
    /// * the migrator names one and there is no router — nothing can trade the
    ///   pool, so the answer is `false`;
    /// * both are known — they must match.
    #[must_use]
    pub fn reachability(
        migrator_pool_manager: Option<Address>,
        router_pool_manager: Option<Address>,
    ) -> bool {
        match (migrator_pool_manager, router_pool_manager) {
            (None, _) => true,
            (Some(_), None) => false,
            (Some(migrator), Some(router)) => migrator == router,
        }
    }
}

/// The registry of graduation targets.
#[derive(Debug, Clone, Copy)]
pub struct MigratorRegistry<'a> {
    client: &'a Client,
    address: Address,
}

impl<'a> MigratorRegistry<'a> {
    pub(crate) fn new(client: &'a Client, address: Address) -> Self {
        Self { client, address }
    }

    /// The registry's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    fn contract(&self) -> Abi::MigratorRegistryInstance<DynProvider> {
        Abi::new(self.address, self.client.provider().clone())
    }

    /// True if `migrator` may currently be chosen as a graduation target.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn is_registered(&self, migrator: Address) -> Result<bool, Error> {
        self.contract()
            .isRegistered(migrator)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "checking whether a migrator is registered"))
    }

    /// The tax mode `migrator` declared when it was registered.
    ///
    /// # Errors
    ///
    /// [`Error::MigratorNotRegistered`] for an address that was never
    /// registered. It **reverts** rather than answering
    /// [`TaxMode::None`] — the enum's zero value — because that would make an
    /// address nobody ever vetted indistinguishable from a registered venue that
    /// charges no fee.
    pub async fn tax_mode_of(&self, migrator: Address) -> Result<TaxMode, Error> {
        let raw = self
            .contract()
            .taxModeOf(migrator)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a migrator's tax mode"))?;
        TaxMode::from_u8(raw)
    }

    /// Whether `migrator` can graduate a curve quoted in `quote`.
    ///
    /// `supportsQuote(migrator, quote)`, which answers `false` for a migrator
    /// that reverts rather than raising. A launch in a quote its migrator does
    /// not support is refused with `MigratorDoesNotSupportQuote`.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn supports_quote(&self, migrator: Address, quote: Address) -> Result<bool, Error> {
        self.contract().supportsQuote(migrator, quote).call().await.map_err(|err| {
            Error::from_contract(err, "checking whether a migrator supports a quote")
        })
    }

    /// The canonical router recorded for `migrator`, or the zero address if its
    /// venue has none.
    ///
    /// **This is the only source of a token's canonical router in the whole
    /// protocol.** A launch reads it here, snapshots it onto the curve as an
    /// immutable, and the curve hands that snapshot to the token at migration. No
    /// creator, platform admin, migrator or token can name it, and nothing can
    /// change it after registration — which matters, because this is the address
    /// that gets a standing maximum allowance over every holder.
    ///
    /// # Errors
    /// [`Error::MigratorNotRegistered`] for an unregistered address, symmetric
    /// with [`MigratorRegistry::tax_mode_of`].
    pub async fn router_of(&self, migrator: Address) -> Result<Address, Error> {
        self.contract()
            .routerOf(migrator)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a migrator's canonical router"))
    }

    /// How many migrators this registry has ever registered, deregistered ones
    /// included.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn migrator_count(&self) -> Result<u64, Error> {
        let raw = self
            .contract()
            .migratorCount()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the migrator count"))?;
        u64::try_from(raw).map_err(|_| {
            Error::abi("reading the migrator count", "the count does not fit in a u64")
        })
    }

    /// The `index`-th migrator ever registered, in registration order.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails, or a revert past the count.
    pub async fn migrator_at(&self, index: u64) -> Result<Address, Error> {
        self.contract()
            .migratorAt(alloy::primitives::U256::from(index))
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a migrator by index"))
    }

    /// Every graduation target a launch may currently choose, described.
    ///
    /// **Currently registered only.** The index this walks includes every
    /// migrator ever registered, deregistered ones among them, and a deregistered
    /// migrator is exactly what a launch may not name — so it is filtered out
    /// here. That is not the same question as "which migrator does this token
    /// have": ask [`crate::CurveState::migrator`] for that, because
    /// deregistration reaches nothing that already exists.
    ///
    /// This is what a creator choosing a venue at launch needs, and the contract
    /// alone cannot answer it: the label is not stored anywhere and reachability
    /// is a comparison against the configured router's `PoolManager`, read once
    /// per call when a router is configured. See [`MigratorInfo::reachable`].
    ///
    /// One `eth_call` per field per migrator, in a loop. The list is short — Arc
    /// testnet has one entry — and a batched version that hid a per-migrator
    /// failure would be a worse trade than a few extra round trips.
    ///
    /// # Errors
    ///
    /// [`Error::Rpc`] if the endpoint fails, or a decoded revert from the
    /// registry or from the configured router's `poolManager()` — a configured
    /// router that does not answer is a misconfigured network, not a venue to
    /// grey out. A migrator that will not answer `VERSION()` or `poolManager()`
    /// is **not** an error: those two are optional and their absence is
    /// described rather than raised.
    pub async fn list(&self) -> Result<Vec<MigratorInfo>, Error> {
        let router_pool_manager = match self.client.network().contracts.v4_router {
            None => None,
            Some(router) => Some(
                crate::bindings::router::UniswapV4Router04::new(
                    router,
                    self.client.provider().clone(),
                )
                .poolManager()
                .call()
                .await
                .map_err(|err| Error::from_contract(err, "reading the router's PoolManager"))?,
            ),
        };
        let count = self.migrator_count().await?;
        let mut migrators = Vec::new();
        for index in 0..count {
            let address = self.migrator_at(index).await?;
            if !self.is_registered(address).await? {
                continue;
            }
            let venue = crate::bindings::v4_migrator::UniswapV4Migrator::new(
                address,
                self.client.provider().clone(),
            );
            // A migrator that REVERTS on VERSION() or poolManager() lacks it, and
            // that is described rather than raised. A TRANSPORT failure is not an
            // answer about the migrator at all: read as "no poolManager()", it
            // made a v4 venue report reachable with no router configured, so it
            // is raised instead.
            let label = optional(venue.VERSION().call().await, "reading a migrator's VERSION()")?;
            let pool_manager =
                optional(venue.poolManager().call().await, "reading a migrator's PoolManager")?;
            migrators.push(MigratorInfo {
                address,
                tax_mode: self.tax_mode_of(address).await?,
                router: self.router_of(address).await?,
                label: label.unwrap_or_default(),
                reachable: MigratorInfo::reachability(pool_manager, router_pool_manager),
            });
        }
        Ok(migrators)
    }
}

/// `Some(value)` for an answer and `None` for anything the contract itself said
/// — a revert, or an empty return from a venue without the function — while a
/// transport failure, which is no answer from the contract at all, is raised.
fn optional<T>(
    result: Result<T, alloy::contract::Error>,
    context: &str,
) -> Result<Option<T>, Error> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(err) => {
            let transport_failure = matches!(
                &err,
                alloy::contract::Error::TransportError(transport)
                    if !transport.as_error_resp().is_some_and(|payload| {
                        payload.as_revert_data().is_some() || payload.message.contains("revert")
                    })
            );
            if transport_failure { Err(Error::from_contract(err, context)) } else { Ok(None) }
        }
    }
}
