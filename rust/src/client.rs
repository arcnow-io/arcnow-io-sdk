//! The client: a provider, a network, and optionally a signer.
//!
//! # Reading needs no key
//!
//! Every read method in this crate works on a client built from an RPC URL and
//! nothing else. That is not a convenience, it is the shape of the system: quotes,
//! state, fee splits and addresses are all `eth_call`, and an SDK that demanded a
//! private key to answer "what would this buy cost" would be asking for a
//! credential to do arithmetic.
//!
//! A **write** on a client with no signer fails with [`Error::SignerRequired`]
//! **before any RPC happens**, naming the method. The alternative — building the
//! transaction, sending it, and having the node refuse it — costs a round trip
//! and produces an error about `from` being unset.
//!
//! # Two ways to be able to write
//!
//! [`ClientBuilder::signer`] holds a key and signs locally, which is what a real
//! integration does. [`ClientBuilder::sender`] holds **no key** and lets the node
//! sign — which is what an unlocked or impersonated account on a development node
//! is, and is the only way to transact as an account nobody has the key for. The
//! forked-chain tests in this crate use the second, because on a fork the
//! accounts that can safely be *paid* are real chain accounts and nobody holds
//! their keys.
//!
//! # Where the addresses come from
//!
//! [`Network::ArcTestnet`] carries them, compiled in from `networks.json`.
//! [`Network::Custom`] is a first-class path for a fork, a private deployment or
//! a chain with no preset — not a fallback. And [`ClientBuilder::rpc_url`]
//! overrides a preset's endpoint while keeping its addresses, which is exactly
//! what talking to a local fork of Arc testnet needs.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex, PoisonError};

use alloy::network::EthereumWallet;
use alloy::primitives::{Address, U256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;

use crate::amount::QuoteTokenInfo;
use crate::curve::Curve;
use crate::error::Error;
use crate::launchpad::Launchpad;
use crate::migrator_registry::MigratorRegistry;
use crate::network::{Network, NetworkConfig};
use crate::platform::{PlatformConfigHandle, PlatformRegistry};
use crate::pool::{Pool, Trade};
use crate::quote::{QuoteRegistry, QuoteToken};
use crate::token::Token;

/// A connection to one arcnow.io deployment.
///
/// Cheap to clone: the provider inside is reference-counted, so a clone shares
/// the same connection pool rather than opening a second one — and the same
/// cache of immutable facts.
///
/// # What is cached, and what never is
///
/// The public Arc endpoint is rate-limited, so facts that cannot change are
/// read once per client: a contract's `VERSION()`, a curve's quote token, an
/// ERC-20 quote's metadata, the launchpad's quote registry, a graduated token's
/// pool key. Anything that can change — balances, allowances, reserves, whether
/// a token has migrated yet — is read every time. **A failed read is never
/// cached.**
#[derive(Clone, Debug)]
pub struct Client {
    provider: DynProvider,
    config: NetworkConfig,
    sender: Option<Address>,
    cache: Arc<Cache>,
}

/// The immutable facts a client has already read. See [`Client`].
#[derive(Debug, Default)]
pub(crate) struct Cache {
    pub(crate) quotes: Mutex<HashMap<Address, QuoteTokenInfo>>,
    pub(crate) versions: Mutex<HashMap<Address, String>>,
    pub(crate) quote_registry: Mutex<Option<Address>>,
    pub(crate) curve_quotes: Mutex<HashMap<Address, QuoteTokenInfo>>,
    pub(crate) markets: Mutex<HashMap<Address, crate::pool::Market>>,
    pub(crate) router_pool_managers: Mutex<HashMap<Address, Address>>,
}

/// A cached value, if there is one.
pub(crate) fn cached<K: Eq + Hash, V: Clone>(map: &Mutex<HashMap<K, V>>, key: &K) -> Option<V> {
    map.lock().unwrap_or_else(PoisonError::into_inner).get(key).cloned()
}

/// Remember a value that was read successfully.
pub(crate) fn remember<K: Eq + Hash, V>(map: &Mutex<HashMap<K, V>>, key: K, value: V) {
    map.lock().unwrap_or_else(PoisonError::into_inner).insert(key, value);
}

impl Client {
    /// A client on a provider built elsewhere — the tests' in-memory endpoint.
    #[cfg(test)]
    pub(crate) fn from_parts(
        provider: DynProvider,
        config: NetworkConfig,
        sender: Option<Address>,
    ) -> Self {
        Self { provider, config, sender, cache: Arc::default() }
    }

    pub(crate) fn cache(&self) -> &Cache {
        &self.cache
    }

    /// `address`'s `VERSION()`, read with `read` the first time and cached.
    pub(crate) async fn version_of(
        &self,
        address: Address,
        read: impl Future<Output = Result<String, Error>>,
    ) -> Result<String, Error> {
        if let Some(version) = self.cached_version(address) {
            return Ok(version);
        }
        let version = read.await?;
        self.remember_version(address, version.clone());
        Ok(version)
    }

    pub(crate) fn cached_version(&self, address: Address) -> Option<String> {
        cached(&self.cache.versions, &address)
    }

    pub(crate) fn remember_version(&self, address: Address, version: String) {
        remember(&self.cache.versions, address, version);
    }

    /// A quote's metadata when it is known without RPC: `networks.json`, or
    /// already read by this client.
    pub(crate) fn known_quote(&self, address: Address) -> Option<QuoteTokenInfo> {
        self.config.quote_token(address).cloned().or_else(|| cached(&self.cache.quotes, &address))
    }

    pub(crate) fn remember_quote(&self, info: QuoteTokenInfo) {
        remember(&self.cache.quotes, info.address, info);
    }

    /// A quote token's description: `networks.json` first, with no RPC, then
    /// ONE Multicall3 read of `symbol`, `name` and `decimals`, cached for the
    /// life of this client. The zero address is native USDC.
    ///
    /// # Errors
    /// [`Error::InvalidArgument`] when the token's answers cannot describe a
    /// quote (more than 18 decimals); [`Error::Rpc`] if the endpoint fails,
    /// which is not cached.
    pub async fn quote_token_info(&self, address: Address) -> Result<QuoteTokenInfo, Error> {
        if let Some(known) = self.known_quote(address) {
            return Ok(known);
        }
        let info = crate::quote::read_metadata(self, address).await?;
        self.remember_quote(info.clone());
        Ok(info)
    }

    /// A handle on the quote token at `address` — native USDC for the zero
    /// address — with its metadata resolved as [`Client::quote_token_info`]
    /// does.
    ///
    /// # Errors
    /// As [`Client::quote_token_info`].
    pub async fn quote_token(&self, address: Address) -> Result<QuoteToken<'_>, Error> {
        Ok(QuoteToken::new(self, self.quote_token_info(address).await?))
    }

    /// A handle on a quote token you already have the description of. No RPC.
    #[must_use]
    pub fn quote_token_for(&self, info: QuoteTokenInfo) -> QuoteToken<'_> {
        QuoteToken::new(self, info)
    }

    /// The quote token allowlist: `contracts.quoteRegistry` from the network,
    /// or else the launchpad's immutable `quoteTokenRegistry()`, read once per
    /// client.
    ///
    /// # Errors
    /// [`Error::ContractNotDeployed`] when the network names neither a quote
    /// registry nor a launchpad; [`Error::Rpc`] if the endpoint fails.
    pub async fn quote_registry(&self) -> Result<QuoteRegistry<'_>, Error> {
        let address = match self.config.contracts.quote_registry {
            Some(address) => address,
            None => self.launchpad()?.quote_token_registry().await?,
        };
        Ok(QuoteRegistry::new(self, address))
    }

    /// Start building a client.
    #[must_use]
    pub fn builder() -> ClientBuilder {
        ClientBuilder::default()
    }

    /// A read-only client against a preset network, using the preset's own
    /// public RPC endpoint.
    ///
    /// The endpoint in `networks.json` is a default and a public one: it is
    /// rate-limited and is nobody's production dependency. For anything serious,
    /// pass your own with [`ClientBuilder::rpc_url`].
    ///
    /// # Errors
    ///
    /// Anything [`ClientBuilder::build`] can return.
    pub async fn connect(network: Network) -> Result<Self, Error> {
        ClientBuilder::default().network(network).build().await
    }

    /// The network this client is pointed at, addresses and all.
    #[must_use]
    pub fn network(&self) -> &NetworkConfig {
        &self.config
    }

    /// The underlying alloy provider, for anything this crate does not wrap.
    #[must_use]
    pub fn provider(&self) -> &DynProvider {
        &self.provider
    }

    /// The address this client transacts as, if it can transact at all.
    #[must_use]
    pub fn sender(&self) -> Option<Address> {
        self.sender
    }

    /// The address this client transacts as, or a refusal naming `method`.
    ///
    /// Every write in this crate starts here, so a read-only client refuses
    /// before it builds a transaction rather than after the node rejects one.
    ///
    /// # Errors
    ///
    /// [`Error::SignerRequired`] on a read-only client.
    pub fn require_signer(&self, method: &'static str) -> Result<Address, Error> {
        self.sender.ok_or(Error::SignerRequired { method })
    }

    /// An account's native USDC balance. For any quote token, use
    /// [`QuoteToken::balance_of`].
    ///
    /// **18 decimals**, because this is `eth_getBalance` and on Arc that is
    /// native USDC. It is the same asset the 6-decimal ERC-20 predeploy reports,
    /// at a different scale; see [`crate::UsdcErc20`].
    ///
    /// # Errors
    ///
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn balance(&self, account: Address) -> Result<crate::Usdc, Error> {
        let raw: U256 = self
            .provider
            .get_balance(account)
            .await
            .map_err(|err| Error::rpc(format!("reading the balance of {account}"), err))?;
        Ok(crate::Usdc::from_wad(raw))
    }

    /// The launchpad handle: quote a launch, predict its addresses, launch.
    ///
    /// # Errors
    ///
    /// [`Error::ContractNotDeployed`] when this network has no launchpad.
    pub fn launchpad(&self) -> Result<Launchpad<'_>, Error> {
        Ok(Launchpad::new(self, self.config.launchpad()?))
    }

    /// The platform registry handle: read the protocol's half of the fee split,
    /// enumerate platforms, register one.
    ///
    /// # Errors
    ///
    /// [`Error::ContractNotDeployed`] when this network has no platform
    /// registry.
    pub fn platform_registry(&self) -> Result<PlatformRegistry<'_>, Error> {
        Ok(PlatformRegistry::new(self, self.config.platform_registry()?))
    }

    /// The migrator registry handle: which graduation targets exist, and what
    /// each declared.
    ///
    /// # Errors
    ///
    /// [`Error::ContractNotDeployed`] when this network has no migrator
    /// registry.
    pub fn migrator_registry(&self) -> Result<MigratorRegistry<'_>, Error> {
        Ok(MigratorRegistry::new(self, self.config.migrator_registry()?))
    }

    /// A handle on one platform's `PlatformConfig`.
    ///
    /// Addressed, so it needs nothing from the network preset and works on a
    /// client built from a bare RPC URL.
    #[must_use]
    pub fn platform(&self, address: Address) -> PlatformConfigHandle<'_> {
        PlatformConfigHandle::new(self, address)
    }

    /// A handle on one bonding curve: read it, quote it, trade it.
    ///
    /// Addressed, so it needs nothing from the network preset. A curve's address
    /// comes from [`crate::LaunchResult::curve`], from the `Launched` log, or
    /// from [`Token::curve`].
    #[must_use]
    pub fn curve(&self, address: Address) -> Curve<'_> {
        Curve::new(self, address)
    }

    /// A handle on one launched token, as an ordinary ERC-20 and as an
    /// `ArcToken`.
    #[must_use]
    pub fn token(&self, address: Address) -> Token<'_> {
        Token::new(self, address)
    }

    /// A handle on one **graduated** token's Uniswap v4 market: its key, its
    /// pool id, quotes, swaps and the router approval a sell needs.
    ///
    /// Addressed by the **token**, because a v4 pool has no address of its own —
    /// it is a `PoolId` inside one `PoolManager`'s storage. Every quote and
    /// trade refuses a token that has not migrated, refuses everything while
    /// the network configures no router (`contracts.v4Router`), and refuses a
    /// pool in a `PoolManager` the configured router is not bound to.
    #[must_use]
    pub fn pool(&self, token: Address) -> Pool<'_> {
        Pool::new(self, token)
    }

    /// The front door: one token, whichever of the two venues it trades at.
    ///
    /// [`Trade::venue`] reads which, and the quote and trade methods dispatch on
    /// it. Reach for this when the code does not already know whether a token
    /// has graduated; reach for [`Client::curve`] or [`Client::pool`] when it
    /// does.
    #[must_use]
    pub fn trade(&self, token: Address) -> Trade<'_> {
        Trade::new(self, token)
    }
}

/// Builds a [`Client`].
///
/// ```no_run
/// # async fn f() -> Result<(), arcnow_sdk::Error> {
/// use arcnow_sdk::{Client, Network};
///
/// // Read-only: no key anywhere, every read method works.
/// let reader = Client::builder().network(Network::ArcTestnet).build().await?;
///
/// // The same addresses, a different endpoint — a local fork, say.
/// let forked = Client::builder()
///     .network(Network::ArcTestnet)
///     .rpc_url("http://127.0.0.1:8545")
///     .build()
///     .await?;
/// # Ok(()) }
/// ```
pub struct ClientBuilder {
    network: Option<Network>,
    rpc_url: Option<String>,
    wallet: Option<(EthereumWallet, Address)>,
    sender: Option<Address>,
    check_chain_id: bool,
}

impl Default for ClientBuilder {
    /// Nothing configured, and the chain-id check **on**. A safety check that is
    /// off by default is a safety check nobody has.
    fn default() -> Self {
        Self { network: None, rpc_url: None, wallet: None, sender: None, check_chain_id: true }
    }
}

impl std::fmt::Debug for ClientBuilder {
    /// Deliberately does not print the wallet: a signer that shows up in a debug
    /// rendering is a signer in a log aggregator. The signer's **address** is
    /// printed, because that is public and is the thing you actually want when
    /// you are working out why a transaction went out from the wrong account.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientBuilder")
            .field("network", &self.network.as_ref().map(Network::id))
            .field("rpc_url", &self.rpc_url)
            .field("sender", &self.sender)
            .field("holds_a_key", &self.wallet.is_some())
            .field("check_chain_id", &self.check_chain_id)
            .finish_non_exhaustive()
    }
}

impl ClientBuilder {
    /// Start fresh. Chain-id verification is on by default.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Which deployment to talk to.
    ///
    /// Without this, and with only [`ClientBuilder::rpc_url`], the client has an
    /// endpoint and no contract addresses: every *addressed* handle
    /// ([`Client::curve`], [`Client::token`], [`Client::platform`]) works, and
    /// the registry handles report which contract they are missing.
    #[must_use]
    pub fn network(mut self, network: Network) -> Self {
        self.network = Some(network);
        self
    }

    /// The JSON-RPC endpoint, overriding whatever the preset names.
    ///
    /// This is how a preset's **addresses** are used against a **different**
    /// endpoint — a local anvil fork of Arc testnet being the obvious case, and
    /// the one the integration tests in this crate run against.
    #[must_use]
    pub fn rpc_url(mut self, url: impl Into<String>) -> Self {
        self.rpc_url = Some(url.into());
        self
    }

    /// Sign with this local private key.
    ///
    /// The key is held in memory for the life of the client and is never
    /// printed, logged or included in a `Debug` rendering.
    #[must_use]
    pub fn signer(self, signer: PrivateKeySigner) -> Self {
        let address = signer.address();
        self.wallet_with(EthereumWallet::from(signer), address)
    }

    /// Sign with an alloy wallet you assembled yourself — a hardware signer, a
    /// remote KMS, a multi-key wallet.
    ///
    /// `address` is the account transactions are sent from; it must be one the
    /// wallet can actually sign for.
    #[must_use]
    pub fn wallet_with(mut self, wallet: EthereumWallet, address: Address) -> Self {
        self.sender = Some(address);
        self.wallet = Some((wallet, address));
        self
    }

    /// Transact as `address` and let the **node** sign, holding no key here.
    ///
    /// This is `eth_sendTransaction` with `from` set, which a node honours only
    /// for an account it has unlocked or been told to impersonate. On anvil that
    /// is `anvil_impersonateAccount`; on a production endpoint it is nothing at
    /// all, and the node will refuse.
    ///
    /// It exists because on a **fork** the only accounts that can safely receive
    /// money are accounts the forked chain already knows about — see the
    /// forked-chain tests in this crate — and nobody holds their keys. Do not
    /// reach for it against a real endpoint; use [`ClientBuilder::signer`].
    ///
    /// Calling it after [`ClientBuilder::signer`] replaces the sender address but
    /// keeps the wallet, which is almost certainly not what you meant; set one or
    /// the other.
    #[must_use]
    pub fn sender(mut self, address: Address) -> Self {
        self.sender = Some(address);
        self
    }

    /// Skip the chain-id check performed when the client is built.
    ///
    /// The check is one `eth_chainId` and it catches an endpoint pointed at the
    /// wrong chain — including an anvil fork that silently fell back to 31337
    /// instead of forking, which otherwise surfaces much later as an address
    /// with no code. Turn it off only when you have a reason.
    #[must_use]
    pub fn skip_chain_id_check(mut self) -> Self {
        self.check_chain_id = false;
        self
    }

    /// Connect.
    ///
    /// # Errors
    ///
    /// * [`Error::NetworkNotDeployed`] when the network has one of the core
    ///   contracts missing, naming every gap. Both presets are fully deployed,
    ///   so this is a [`Network::Custom`] configuration's answer.
    /// * [`Error::Rpc`] when no endpoint was given, or the URL will not parse,
    ///   or the endpoint cannot be reached.
    /// * [`Error::ChainIdMismatch`] when the endpoint is on a different chain
    ///   from the one the preset describes.
    pub async fn build(self) -> Result<Client, Error> {
        let network = self.network.unwrap_or_else(|| {
            Network::Custom(Box::new(NetworkConfig::custom(
                "custom",
                0,
                String::new(),
                crate::ContractAddresses::default(),
            )))
        });

        // A preset is a claim that a deployment is there. Check it once, here,
        // rather than letting six separate accessors each discover it.
        let is_preset = !matches!(network, Network::Custom(_));
        if is_preset {
            network.config().require_deployed()?;
        }

        let mut config = network.config().clone();
        if let Some(url) = self.rpc_url {
            config.rpc_url = Some(url);
        }
        let Some(url) = config.rpc_url.clone().filter(|url| !url.is_empty()) else {
            return Err(Error::rpc(
                "building a client",
                "no RPC endpoint: this network preset names none, and none was passed to \
                 ClientBuilder::rpc_url",
            ));
        };
        let parsed =
            url.parse().map_err(|err| Error::rpc(format!("parsing the RPC URL {url:?}"), err))?;

        let sender = self.sender;
        // SIMPLE nonce management, not alloy's cached default, and this is not a
        // preference. The cached manager advances its local nonce *before*
        // broadcast and, in alloy's own words, "does not resynchronize
        // automatically". A transaction that fails during filling — which on
        // this SDK means any revert a caller could reasonably hit: a slippage
        // floor missed, a deadline passed, a curve that graduated a block ago —
        // therefore burns a nonce that the chain never sees, and **every
        // subsequent transaction from that client sits in the mempool forever
        // behind a gap that nothing closes**. The symptom is a write that neither
        // succeeds nor fails: it just never mines, which is the worst failure
        // shape there is.
        //
        // Reverts are routine here; this crate has a whole module about reading
        // them. So the client pays one `eth_getTransactionCount` per
        // transaction and stays correct across them. The cost of that trade is
        // that two *concurrent* writes from one address can be handed the same
        // nonce — if you send transactions in parallel from a single account,
        // sequence them yourself.
        let provider = match self.wallet {
            Some((wallet, _)) => ProviderBuilder::new()
                .with_simple_nonce_management()
                .wallet(wallet)
                .connect_http(parsed)
                .erased(),
            None => {
                ProviderBuilder::new().with_simple_nonce_management().connect_http(parsed).erased()
            }
        };

        let reported = provider
            .get_chain_id()
            .await
            .map_err(|err| Error::rpc(format!("asking {url} for its chain id"), err))?;
        match config.chain_id {
            Some(expected) if expected != 0 && self.check_chain_id && expected != reported => {
                return Err(Error::ChainIdMismatch {
                    network: config.name.clone(),
                    expected,
                    actual: reported,
                });
            }
            // A client built from a bare URL learns the chain id rather than
            // asserting one: there was nothing to assert against.
            _ => config.chain_id = Some(reported),
        }

        Ok(Client { provider, config, sender, cache: Arc::default() })
    }
}
