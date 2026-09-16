//! Network presets: which chain, which addresses, and which contracts are not
//! there at all.
//!
//! The presets are `networks.json`, compiled into the crate with `include_str!`
//! so that a published `arcnow-sdk` carries them and a caller needs no file, no
//! fetch and no environment variable to reach Arc testnet. The same file is the
//! source for the TypeScript SDK; `../scripts/check-pins.sh` fails if the two
//! copies drift apart, because two SDKs that each kept their own address list
//! would eventually disagree about one address, in one language, on one chain,
//! and nothing would say which was right.
//!
//! # `null` is not the zero address
//!
//! A `null` address in `networks.json` means **not deployed on this chain**. It
//! is not `0x0000…0000`, which on Arc is a real account that would send money
//! nowhere at all. So every accessor here returns a `Result` and the error names
//! the contract, rather than handing back a zero that encodes cleanly and
//! settles into the void.
//!
//! # The mainnet gap, on purpose
//!
//! [`Network::ArcMainnet`] **resolves** — [`Network::config`] finds it, complete
//! in shape — and **refuses to be used**, with an error naming the contracts
//! that are missing. That is deliberate and it is the whole reason the entry
//! exists:
//!
//! * a preset that were simply *absent* gets a caller a "no such network" error,
//!   which reads as "the SDK is behind" and is worked around by pasting
//!   addresses from somewhere;
//! * a preset with *plausible* addresses in it gets them a transaction to an
//!   account that does not exist;
//! * a preset that is present, complete in shape and null in every address gets
//!   them an error that says exactly what is true: nothing is deployed here,
//!   pass your own addresses if you know better.
//!
//! Nobody invents an address to fill it in. When arcnow.io deploys to a mainnet
//! the values arrive in `networks.json` from the deployment record, with the
//! contracts commit that produced them.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::OnceLock;

use alloy::primitives::{Address, U256};
use serde::Deserialize;

use crate::amount::{NATIVE_USDC, QuoteTokenInfo};
use crate::error::Error;

/// `networks.json`, byte-identical to the copy the TypeScript SDK carries.
const NETWORKS_JSON: &str = include_str!("generated/networks.json");

/// The preset identifier for Arc testnet.
pub const ARC_TESTNET: &str = "arc-testnet";

/// The preset identifier for Arc mainnet, which is present and undeployed.
pub const ARC_MAINNET: &str = "arc-mainnet";

/// Which deployment to talk to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Network {
    /// Arc testnet, chain id 5042002. The one deployment that exists.
    ArcTestnet,
    /// Arc mainnet. Resolves, and refuses; see the module documentation.
    ArcMainnet,
    /// Addresses and an RPC endpoint of your own.
    ///
    /// **A first-class path, not a fallback.** A local fork, a private
    /// deployment, a chain arcnow.io has not published a preset for, or Arc
    /// testnet reached through a different endpoint are all this. Build one with
    /// [`NetworkConfig::custom`].
    Custom(Box<NetworkConfig>),
}

impl Network {
    /// The preset's identifier — `"arc-testnet"`, `"arc-mainnet"`, or the name
    /// a custom config gave itself.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::ArcTestnet => ARC_TESTNET,
            Self::ArcMainnet => ARC_MAINNET,
            Self::Custom(config) => &config.name,
        }
    }

    /// Look a preset up by its identifier.
    ///
    /// # Errors
    ///
    /// [`Error::UnknownNetwork`] for a name that is in no preset. Note that
    /// `"arc-mainnet"` is *not* this error: it resolves, and fails later when
    /// something tries to use it.
    pub fn from_id(id: &str) -> Result<Self, Error> {
        match id {
            ARC_TESTNET => Ok(Self::ArcTestnet),
            ARC_MAINNET => Ok(Self::ArcMainnet),
            other => Err(Error::UnknownNetwork {
                requested: other.to_owned(),
                known: presets().keys().cloned().collect(),
            }),
        }
    }

    /// This network's configuration.
    ///
    /// Always succeeds. Resolving a network and being able to *use* one are two
    /// different questions, and they have two different answers for
    /// [`Network::ArcMainnet`]; see [`NetworkConfig::require_deployed`].
    #[must_use]
    pub fn config(&self) -> &NetworkConfig {
        match self {
            Self::ArcTestnet => &presets()[ARC_TESTNET],
            Self::ArcMainnet => &presets()[ARC_MAINNET],
            Self::Custom(config) => config,
        }
    }

    /// Every preset this crate was compiled with.
    #[must_use]
    pub fn presets() -> Vec<Network> {
        vec![Self::ArcTestnet, Self::ArcMainnet]
    }
}

/// One deployment: which chain, where to reach it, and what is on it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "NetworkConfigFile")]
pub struct NetworkConfig {
    /// The preset's identifier.
    pub name: String,
    /// EIP-155 chain id. `None` on a preset for a chain that does not exist yet.
    pub chain_id: Option<u64>,
    /// A public JSON-RPC endpoint, if the preset names one.
    ///
    /// It is a default, not a requirement: pass your own to
    /// [`crate::ClientBuilder::rpc_url`] and this is ignored. A public endpoint
    /// is rate-limited and is nobody's production dependency.
    pub rpc_url: Option<String>,
    /// A block explorer, if one exists.
    ///
    /// `None` on Arc testnet, and left `None` rather than guessed: a wrong link
    /// in an error message is worse than no link.
    pub explorer_url: Option<String>,
    /// The block the deployment landed in, for an indexer that wants a start
    /// height rather than genesis.
    pub deployed_at_block: Option<u64>,
    /// The `arcnow-io/contracts` commit these addresses were deployed from.
    ///
    /// The ABIs this crate encodes with are pinned to the same commit in
    /// `../pins.json`. If the two ever diverge, an encoded call succeeds against
    /// a selector that does something else, which is the failure that pin exists
    /// to prevent.
    pub contracts_commit: Option<String>,
    /// The native gas currency. On Arc it is USDC at 18 decimals.
    pub native: NativeCurrency,
    /// The 6-decimal ERC-20 view of the same asset.
    pub usdc_erc20: UsdcErc20Info,
    /// The quotes a curve on this deployment can be priced in: native USDC
    /// first, then the allowlisted ERC-20s `networks.json` records, with their
    /// metadata — so a known quote costs no RPC to describe.
    ///
    /// `networks.json` `quoteTokens[]`; `native` there is
    /// [`QuoteTokenInfo::is_native`] here. A network that lists none is native
    /// USDC only. **Not the allowlist itself**, which is the chain's
    /// `QuoteRegistry`; see [`crate::Client::quote_registry`].
    pub quote_tokens: Vec<QuoteTokenInfo>,
    /// The storage slot of each ERC-20 quote's allowance mapping, where
    /// `networks.json` records one (`quoteTokens[].allowanceSlot`).
    ///
    /// Used for one thing only: to state-override the router's allowance when
    /// **quoting** a pool buy in that quote, so a buy can be priced before it
    /// is approved. A quote with no slot is priced only for a buyer who has
    /// already approved the router. See [`NetworkConfig::quote_allowance_slot`].
    pub quote_allowance_slots: BTreeMap<Address, U256>,
    /// The deployment's contracts: the ones a launch goes to, and the ones
    /// [`crate::Client::launchpad`], [`crate::Client::platform_registry`] and
    /// [`crate::Client::migrator_registry`] talk to. A `None` means not
    /// deployed on this chain.
    pub contracts: ContractAddresses,
    /// The build at each of `contracts`' addresses, as the deployed contracts
    /// answered `VERSION()` — `"arcnow/launchpad@3.0.0"` and so on, keyed by the
    /// `networks.json` contract name. `None` where the address answered nothing.
    #[serde(default)]
    pub contract_versions: BTreeMap<String, Option<String>>,
    /// Where a graduated token is actually traded. Empty on a chain with no
    /// Uniswap v4 deployment.
    pub v4: V4Addresses,
    /// Which graduation venues this deployment offers.
    pub venues: Venues,
}

/// `networks.json`'s shape for one network, before its quote tokens are
/// validated and split into metadata and allowance slots.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkConfigFile {
    name: String,
    chain_id: Option<u64>,
    rpc_url: Option<String>,
    explorer_url: Option<String>,
    deployed_at_block: Option<u64>,
    contracts_commit: Option<String>,
    native: NativeCurrency,
    usdc_erc20: UsdcErc20Info,
    #[serde(default)]
    quote_tokens: Option<Vec<QuoteTokenEntry>>,
    contracts: ContractAddresses,
    #[serde(default)]
    contract_versions: BTreeMap<String, Option<String>>,
    #[serde(default)]
    v4: V4Addresses,
    venues: Venues,
}

/// One `quoteTokens[]` entry.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuoteTokenEntry {
    address: Address,
    symbol: String,
    name: String,
    decimals: u8,
    native: bool,
    #[serde(default)]
    allowance_slot: Option<SlotNumber>,
}

/// A storage slot, written as a JSON number or as a decimal or `0x` string.
#[derive(Deserialize)]
#[serde(untagged)]
enum SlotNumber {
    Number(u64),
    Text(String),
}

impl SlotNumber {
    fn value(&self) -> Result<U256, String> {
        match self {
            Self::Number(n) => Ok(U256::from(*n)),
            Self::Text(text) => match text.strip_prefix("0x") {
                Some(hex) => U256::from_str_radix(hex, 16),
                None => U256::from_str_radix(text, 10),
            }
            .map_err(|err| format!("allowanceSlot {text:?} is not a slot number: {err}")),
        }
    }
}

impl TryFrom<NetworkConfigFile> for NetworkConfig {
    type Error = String;

    fn try_from(file: NetworkConfigFile) -> Result<Self, String> {
        let mut quote_tokens = Vec::new();
        let mut quote_allowance_slots = BTreeMap::new();
        for entry in file.quote_tokens.unwrap_or_default() {
            let info = QuoteTokenInfo {
                address: entry.address,
                symbol: Cow::Owned(entry.symbol),
                name: Cow::Owned(entry.name),
                decimals: entry.decimals,
                is_native: entry.native,
            };
            info.validate().map_err(|err| format!("{}: quoteTokens: {err}", file.name))?;
            if let Some(slot) = entry.allowance_slot {
                quote_allowance_slots.insert(info.address, slot.value()?);
            }
            quote_tokens.push(info);
        }
        if quote_tokens.is_empty() {
            quote_tokens.push(NATIVE_USDC);
        }
        Ok(Self {
            name: file.name,
            chain_id: file.chain_id,
            rpc_url: file.rpc_url,
            explorer_url: file.explorer_url,
            deployed_at_block: file.deployed_at_block,
            contracts_commit: file.contracts_commit,
            native: file.native,
            usdc_erc20: file.usdc_erc20,
            quote_tokens,
            quote_allowance_slots,
            contracts: file.contracts,
            contract_versions: file.contract_versions,
            v4: file.v4,
            venues: file.venues,
        })
    }
}

impl NetworkConfig {
    /// Build a configuration of your own.
    ///
    /// Everything optional is left unset: no explorer, no deployment block, no
    /// contracts commit, and the venue flags all false. The native currency is
    /// assumed to be USDC at 18 decimals, because that is what makes a chain one
    /// these contracts can run on at all.
    #[must_use]
    pub fn custom(
        name: impl Into<String>,
        chain_id: u64,
        rpc_url: impl Into<String>,
        contracts: ContractAddresses,
    ) -> Self {
        Self {
            name: name.into(),
            chain_id: Some(chain_id),
            rpc_url: Some(rpc_url.into()),
            explorer_url: None,
            deployed_at_block: None,
            contracts_commit: None,
            native: NativeCurrency { symbol: "USDC".to_owned(), decimals: 18 },
            usdc_erc20: UsdcErc20Info {
                address: Some(crate::constants::USDC_ERC20_PREDEPLOY),
                decimals: 6,
            },
            quote_tokens: vec![NATIVE_USDC],
            quote_allowance_slots: BTreeMap::new(),
            contracts,
            contract_versions: BTreeMap::new(),
            v4: V4Addresses::default(),
            venues: Venues::default(),
        }
    }

    /// Build a configuration of your own that also names a Uniswap v4 venue.
    ///
    /// Separate from [`NetworkConfig::custom`] rather than an extra argument to
    /// it: the overwhelming majority of custom configurations are a fork or a
    /// private deployment with no v4 addresses at all, and a caller who has to
    /// pass `V4Addresses::default()` to say "none" is a caller who will
    /// eventually pass something else.
    #[must_use]
    pub fn custom_with_v4(
        name: impl Into<String>,
        chain_id: u64,
        rpc_url: impl Into<String>,
        contracts: ContractAddresses,
        v4: V4Addresses,
    ) -> Self {
        Self { v4, ..Self::custom(name, chain_id, rpc_url, contracts) }
    }

    /// The Uniswap v4 router this SDK swaps graduated tokens through, or the
    /// refusal every pool quote and trade returns without one.
    ///
    /// `contracts.v4Router` in `networks.json`. It is arcnow.io's own
    /// deployment of `UniswapV4Router04` (z0r0z/v4-router, unmodified), bound to
    /// arcnow.io's own `PoolManager` — see [`V4Addresses`] for why arcnow.io
    /// deploys a router rather than using one already on the chain. It is
    /// `null` on every preset until that deployment is broadcast.
    ///
    /// # Errors
    /// [`Error::NoRouterDeployed`] when this network names no router.
    pub fn v4_router(&self) -> Result<Address, Error> {
        self.contracts
            .v4_router
            .ok_or(Error::NoRouterDeployed { chain_id: self.chain_id.unwrap_or_default() })
    }

    /// The `PoolManager` arcnow.io's migrator opens pools in, or an error
    /// naming it.
    ///
    /// **This is a preset's claim, not the authority.** The migrator and the
    /// router both hold their `poolManager` immutable and [`crate::Pool`] asks
    /// both of them, so a preset that went stale cannot turn into a call that
    /// reverts inside a contract that never heard of the pool. This accessor is
    /// for callers who want the address without a round trip.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when this chain has none.
    pub fn v4_pool_manager(&self) -> Result<Address, Error> {
        self.require(self.v4.pool_manager, "v4.poolManager")
    }

    /// The quote token `networks.json` records at `address`, if any. Native
    /// USDC is always known.
    #[must_use]
    pub fn quote_token(&self, address: Address) -> Option<&QuoteTokenInfo> {
        if address.is_zero() {
            return Some(self.quote_tokens.iter().find(|q| q.is_native).unwrap_or(&NATIVE_USDC));
        }
        self.quote_tokens.iter().find(|q| q.address == address)
    }

    /// The storage slot of `quote`'s ERC-20 allowance mapping, where
    /// `networks.json` records one. See [`NetworkConfig::quote_allowance_slots`].
    #[must_use]
    pub fn quote_allowance_slot(&self, quote: Address) -> Option<U256> {
        self.quote_allowance_slots.get(&quote).copied()
    }

    /// Check that the core contracts this SDK needs are deployed here.
    ///
    /// # Errors
    ///
    /// [`Error::NetworkNotDeployed`], naming every missing contract, when one or
    /// more of the five required addresses is `null`. This is what
    /// [`Network::ArcMainnet`] answers.
    pub fn require_deployed(&self) -> Result<(), Error> {
        let missing = self.contracts.missing_core();
        if missing.is_empty() {
            return Ok(());
        }
        Err(Error::NetworkNotDeployed { network: self.name.clone(), missing })
    }

    /// The launchpad, or an error naming it.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when this chain has none.
    pub fn launchpad(&self) -> Result<Address, Error> {
        self.require(self.contracts.launchpad, "launchpad")
    }

    /// The token factory, or an error naming it.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when this chain has none.
    pub fn token_factory(&self) -> Result<Address, Error> {
        self.require(self.contracts.token_factory, "tokenFactory")
    }

    /// The curve factory, or an error naming it.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when this chain has none.
    pub fn curve_factory(&self) -> Result<Address, Error> {
        self.require(self.contracts.curve_factory, "curveFactory")
    }

    /// The migrator registry, or an error naming it.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when this chain has none.
    pub fn migrator_registry(&self) -> Result<Address, Error> {
        self.require(self.contracts.migrator_registry, "migratorRegistry")
    }

    /// The platform registry, or an error naming it.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when this chain has none.
    pub fn platform_registry(&self) -> Result<Address, Error> {
        self.require(self.contracts.platform_registry, "platformRegistry")
    }

    /// arcnow.io's own `PlatformConfig` — the platform a launch defaults to.
    ///
    /// **Not a privileged singleton.** It is one platform among however many the
    /// registry admits; it is simply the one whose address is known before you
    /// have read a log. Name any other registered platform in
    /// [`crate::LaunchParams::platform`] and the launch snapshots that one's fee
    /// split, curve template and default migrator instead.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when this chain has none.
    pub fn arcnow_platform(&self) -> Result<Address, Error> {
        self.require(self.contracts.arcnow_platform, "arcnowPlatform")
    }

    fn require(&self, value: Option<Address>, which: &'static str) -> Result<Address, Error> {
        value.ok_or_else(|| Error::ContractNotDeployed {
            contract: which,
            network: self.name.clone(),
        })
    }
}

/// The native gas currency of a chain.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NativeCurrency {
    /// Ticker. `"USDC"` on Arc — and that is not a wrapper or a stand-in, it is
    /// the gas currency itself.
    pub symbol: String,
    /// Decimals `msg.value` is denominated in. **18 on Arc**, which is the fact
    /// the whole of [`crate::amount`] exists to protect.
    pub decimals: u8,
}

/// The ERC-20 view of native USDC.
///
/// Present only so a wallet-facing caller can convert at the edge. **No
/// arcnow.io contract reads this address**, and nothing in this SDK's call path
/// does either.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UsdcErc20Info {
    /// The predeploy, where the chain has one.
    pub address: Option<Address>,
    /// Decimals it reports: 6. The scale between this and
    /// [`NativeCurrency::decimals`] is `1e12`.
    pub decimals: u8,
}

/// Every contract address a deployment publishes.
///
/// `None` means **not deployed on this chain**, which is a perfectly healthy
/// state for the optional four: `escrow_migrator`, `v2_migrator`, `v3_migrator`
/// and `fee_hook`. Arc testnet has no escrow migrator precisely *because* it has
/// a real venue to graduate into, and no v2 or v3 migrator because neither could
/// be built without a wrapped-native token the chain does not publish.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractAddresses {
    /// The only orchestrator: takes the launch fee, deploys a token and its
    /// curve bound to each other, and performs the initial buy. Required.
    pub launchpad: Option<Address>,
    /// Deploys `ArcToken`s for the launchpad. Required.
    pub token_factory: Option<Address>,
    /// Deploys `BondingCurve`s for the launchpad. Required.
    pub curve_factory: Option<Address>,
    /// The `QuoteRegistry`: which quote tokens a launch may use, and each
    /// one's launch fee. Optional here: `None` means ask the launchpad's
    /// immutable `quoteTokenRegistry()`, once per client.
    #[serde(default)]
    pub quote_registry: Option<Address>,
    /// The protocol's list of graduation targets. Required.
    pub migrator_registry: Option<Address>,
    /// Creates platforms and holds the protocol's half of every fee. Required.
    pub platform_registry: Option<Address>,
    /// arcnow.io's own `PlatformConfig`, the default to launch under. Required.
    pub arcnow_platform: Option<Address>,
    /// The custodial fallback migrator. Optional, and its absence is the better
    /// state.
    pub escrow_migrator: Option<Address>,
    /// Uniswap v2 graduation target. Optional.
    pub v2_migrator: Option<Address>,
    /// Uniswap v3 graduation target. Optional.
    pub v3_migrator: Option<Address>,
    /// Uniswap v4 graduation target. Optional.
    pub v4_migrator: Option<Address>,
    /// The v4 hook that takes the 1% inside a post-graduation swap. Optional.
    pub fee_hook: Option<Address>,
    /// `UniswapV4Router04`, deployed by arcnow.io against its own `PoolManager`.
    /// Optional — and while it is `None`, no graduated token can be quoted or
    /// traded through this SDK: every pool method refuses with
    /// [`Error::NoRouterDeployed`]. See [`NetworkConfig::v4_router`].
    pub v4_router: Option<Address>,
}

impl ContractAddresses {
    /// The core contracts, in the order they are reported as missing.
    const CORE: [CoreContract; 6] = [
        ("launchpad", |c| c.launchpad),
        ("tokenFactory", |c| c.token_factory),
        ("curveFactory", |c| c.curve_factory),
        ("migratorRegistry", |c| c.migrator_registry),
        ("platformRegistry", |c| c.platform_registry),
        ("arcnowPlatform", |c| c.arcnow_platform),
    ];

    /// Which required contracts are not deployed here. Empty means all of them
    /// are.
    #[must_use]
    pub fn missing_core(&self) -> Vec<&'static str> {
        Self::CORE.iter().filter(|(_, get)| get(self).is_none()).map(|(name, _)| *name).collect()
    }
}

/// One required contract: the name `networks.json` gives it, and how to read it.
type CoreContract = (&'static str, fn(&ContractAddresses) -> Option<Address>);

/// Where a graduated token is actually traded.
///
/// # A v4 pool has no address
///
/// It is a `PoolId` inside **one** `PoolManager`'s storage. So a pool is
/// identified by the manager that holds it plus the key that hashes to its id,
/// and `token.migratedPool()` — which returns the manager, identically for every
/// token on a deployment — is a "has this migrated, and into which manager"
/// answer rather than a per-token address. Nothing in this crate treats it as
/// one.
///
/// # arcnow.io stays on its own `PoolManager`, and deploys a router for it
///
/// Arc testnet carries a second, unrelated `PoolManager`, with a third-party
/// router bound to it. arcnow.io uses **neither**. Every token that graduates
/// has its liquidity in [`V4Addresses::pool_manager`] **permanently**: the
/// migrator's positions are burned and its `poolManager` is immutable, so a
/// second manager would only split arcnow.io's liquidity across two disjoint
/// markets.
///
/// So arcnow.io deploys its own copy of `UniswapV4Router04` from z0r0z/v4-router,
/// unmodified, bound to this manager — `arcnow-io/contracts`
/// `script/DeployV4Router.s.sol`, CREATE2 with salt zero, which puts it at
/// `0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e` on Arc testnet. Its address is
/// [`ContractAddresses::v4_router`], `null` until it is broadcast, and one router
/// serves every graduated token.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V4Addresses {
    /// The `PoolManager` arcnow.io's v4 migrator opens pools in.
    pub pool_manager: Option<Address>,
}

/// Which graduation venues a deployment actually offers.
///
/// Informational. **A token graduates into the migrator its own curve
/// snapshotted at launch**, which is immutable and may be a venue this list no
/// longer advertises — deregistering a migrator bars the next launch and reaches
/// nothing that exists. So ask the curve
/// ([`crate::CurveState::migrator`]) for a particular token; ask this for what a
/// *new* launch could choose.
// Four independent flags describing four independent venues. Collapsing them
// into a bitset or an enum would be a worse description of the thing.
#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Venues {
    /// The custodial escrow fallback.
    pub escrow: bool,
    /// Uniswap v2. Charges no arcnow fee after graduation.
    pub uniswap_v2: bool,
    /// Uniswap v3. Charges no arcnow fee after graduation.
    pub uniswap_v3: bool,
    /// Uniswap v4. **The only venue that can charge anything after
    /// graduation**, through `ArcNowFeeHook`, in the pool's quote token.
    pub uniswap_v4: bool,
}

#[derive(Deserialize)]
struct NetworksFile {
    networks: BTreeMap<String, NetworkConfig>,
}

fn presets() -> &'static BTreeMap<String, NetworkConfig> {
    static PRESETS: OnceLock<BTreeMap<String, NetworkConfig>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        let file: NetworksFile = serde_json::from_str(NETWORKS_JSON).expect(
            "src/generated/networks.json is a generated, pinned file and must parse. If this \
             panics, the projection has drifted from networks.json: run \
             ../scripts/sync-artifacts.sh and ../scripts/check-pins.sh.",
        );
        file.networks
    })
}
