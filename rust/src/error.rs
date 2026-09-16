//! One error type, and the revert decoder behind it.
//!
//! # Why a revert has to be decoded at all
//!
//! A custom Solidity error arrives over JSON-RPC as four bytes of selector and
//! some ABI-encoded arguments. Left alone it reaches a caller as
//! `execution reverted: 0x0dc10197...`, which is a true statement that helps
//! nobody. Decoded, it is `SlippageExceeded { min_out, actual_out }`, and the
//! caller can tell that apart from a deadline they missed, a curve that has
//! graduated, and an address that is not a registered platform — four failures
//! that look identical as hex.
//!
//! # Every ABI, not just the one being called
//!
//! The decoder is built from **every** ABI in `src/generated/abi/`, keyed by
//! selector. That matters because a call to one contract routinely reverts with
//! another's error: a launch goes through `Launchpad`, `PlatformRegistry`,
//! `PlatformConfig`, `TokenFactory`, `CurveFactory` and `BondingCurve` in one
//! transaction, and can fail in any of them. `solc` folds inherited interface
//! errors into the concrete ABI, so `BondingCurve.json` already carries every
//! error a curve can throw — but nothing folds `PlatformConfig`'s errors into
//! `Launchpad`'s, and those are exactly the ones a launch hits.
//!
//! # Messages that say what to do
//!
//! Each curated variant's message says what to change, not what happened. A
//! caller reading `CurveGraduated` does not need to be told the call reverted;
//! they need to be told the curve retired permanently at its target and that the
//! token trades at its graduation venue now, and that `curve.state().migrator`
//! says which.
//!
//! # What is not curated
//!
//! An error that is in an ABI but has no variant of its own arrives as
//! [`Error::NamedRevert`], with its name, its full signature and its decoded
//! arguments — readable, matchable, and honest about being generic. A selector
//! in no ABI at all arrives as [`Error::UnknownRevert`], which prints the
//! selector plainly so it can be looked up, rather than as a bare hex blob with
//! no framing.
//!
//! The three non-custom shapes are handled too, because they are what most
//! *non*-arcnow reverts look like: [`Error::ErrorString`] (`Error(string)`, an
//! old-style `require`), [`Error::Panic`] (`Panic(uint256)`, a compiler-inserted
//! assertion — overflow, division by zero, an out-of-bounds index), and
//! [`Error::EmptyRevert`], which is usually an out-of-gas or a call to an
//! address with no code rather than a deliberate revert at all.

use std::collections::HashMap;
use std::sync::OnceLock;

use alloy::dyn_abi::{DynSolValue, ErrorExt};
use alloy::json_abi::JsonAbi;
use alloy::primitives::{Address, B256, Bytes, Selector, U256};

use crate::amount::{Bps, Tokens, Usdc};

/// The selector of the built-in `Error(string)` revert.
const ERROR_STRING_SELECTOR: [u8; 4] = [0x08, 0xc3, 0x79, 0xa0];

/// The selector of the built-in `Panic(uint256)` revert.
const PANIC_SELECTOR: [u8; 4] = [0x4e, 0x48, 0x7b, 0x71];

/// The selector of Uniswap v4's `WrappedError(address,bytes4,bytes,bytes)`.
const WRAPPED_ERROR_SELECTOR: [u8; 4] = [0x90, 0xbf, 0xb8, 0x65];

/// Every ABI this crate decodes errors from, as the pinned JSON.
///
/// The four venue migrators and the fee hook are here although this SDK calls
/// none of them directly: a curve's graduating buy calls its migrator, and the
/// hook charges the fee on every post-graduation swap, so their errors are
/// reachable from a transaction a caller sent.
/// v4-core's `CurrencyLibrary.NativeTransferFailed()`,
/// `CurrencyLibrary.ERC20TransferFailed()` and `Hooks.HookCallFailed()`: the
/// `details` v4 attaches to a wrapped native transfer, token transfer and hook
/// call.
const V4_CORE_ERRORS_JSON: &str = r#"[
  {"type": "error", "name": "NativeTransferFailed", "inputs": []},
  {"type": "error", "name": "ERC20TransferFailed", "inputs": []},
  {"type": "error", "name": "HookCallFailed", "inputs": []}
]"#;

/// `NativeTransferFailed()`.
const NATIVE_TRANSFER_FAILED_SELECTOR: [u8; 4] = [0xf4, 0xb3, 0xb1, 0xbc];

const ABIS: &[(&str, &str)] = &[
    ("Launchpad", include_str!("generated/abi/Launchpad.json")),
    ("QuoteRegistry", include_str!("generated/abi/QuoteRegistry.json")),
    ("BondingCurve", include_str!("generated/abi/BondingCurve.json")),
    ("ArcToken", include_str!("generated/abi/ArcToken.json")),
    ("PlatformRegistry", include_str!("generated/abi/PlatformRegistry.json")),
    ("PlatformConfig", include_str!("generated/abi/PlatformConfig.json")),
    ("MigratorRegistry", include_str!("generated/abi/MigratorRegistry.json")),
    ("TokenFactory", include_str!("generated/abi/TokenFactory.json")),
    ("CurveFactory", include_str!("generated/abi/CurveFactory.json")),
    ("EscrowMigrator", include_str!("generated/abi/EscrowMigrator.json")),
    ("UniswapV2Migrator", include_str!("generated/abi/UniswapV2Migrator.json")),
    ("UniswapV3Migrator", include_str!("generated/abi/UniswapV3Migrator.json")),
    ("UniswapV4Migrator", include_str!("generated/abi/UniswapV4Migrator.json")),
    ("ArcNowFeeHook", include_str!("generated/abi/ArcNowFeeHook.json")),
    // Uniswap v4-core's own errors that arrive as a `WrappedError`'s `details`:
    // not in any exported ABI, so declared here to decode by name.
    ("Uniswap v4-core", V4_CORE_ERRORS_JSON),
    // The router is the one contract in this list that arcnow.io did not write,
    // and it is last so that a shared error name is attributed to an arcnow.io
    // contract first. Its errors are reachable the moment anybody swaps a
    // graduated token: see [`crate::pool`].
    ("UniswapV4Router04", include_str!("generated/abi/external/UniswapV4Router04.json")),
];

/// Everything that can go wrong, in one enum.
///
/// Three families live here and they are worth telling apart when you match:
///
/// * **Refusals before anything is sent** — [`Error::SignerRequired`],
///   [`Error::NetworkNotDeployed`], [`Error::FeeSharesExceedAllowance`],
///   [`Error::ChainIdMismatch`]. These cost nothing and are the ones worth
///   surfacing to a user as a form error.
/// * **Decoded contract reverts** — the bulk of this enum. Something reached the
///   chain and the chain said no, by name.
/// * **Transport and decoding trouble** — [`Error::Rpc`], [`Error::Abi`],
///   [`Error::MissingLog`]. The call may or may not have happened.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
// Variants carry the amounts they are about, each naming its quote token; boxing
// them would cost every caller a pattern-match through a Box for an error path.
// The crate already allows `result_large_err` for the same reason.
#[allow(clippy::large_enum_variant)]
pub enum Error {
    // ---------------------------------------------------------------- config
    /// The network preset exists and nothing is deployed on it.
    ///
    /// This is what `arc-mainnet` answers. It is deliberately not an "unknown
    /// network" error: the preset is real, its shape is complete, and every
    /// address in it is `null` because arcnow.io is not on that chain.
    #[error(
        "the {network} preset resolves and has no deployment behind it: {} {} not deployed there. \
         Nothing in this crate will invent an address for a chain it has not been told about, and \
         the zero address is a real account on Arc that would send money nowhere. Either target \
         arc-testnet, or build a client from Network::Custom with the addresses you know.",
        missing.join(", "),
        if missing.len() == 1 { "is" } else { "are" }
    )]
    NetworkNotDeployed {
        /// The preset asked for.
        network: String,
        /// Which required contracts are `null` there.
        missing: Vec<&'static str>,
    },

    /// One contract this call needs is not deployed on this chain.
    #[error(
        "{network} has no {contract}, so this call cannot be built. A null address in \
         networks.json means 'not deployed on this chain' — it is not the zero address, which on \
         Arc is a real account. If you know of one, pass it through Network::Custom."
    )]
    ContractNotDeployed {
        /// The contract that is missing, spelled as `networks.json` spells it.
        contract: &'static str,
        /// The network it is missing from.
        network: String,
    },

    /// A preset by that name does not exist.
    #[error("there is no network preset called {requested:?}. This crate knows: {}.", known.join(", "))]
    UnknownNetwork {
        /// The name asked for.
        requested: String,
        /// The names that would have worked.
        known: Vec<String>,
    },

    /// A write was attempted on a read-only client.
    ///
    /// Raised **before any RPC happens**, so a missing signer costs a round trip
    /// to nobody. Reading needs no key at all: a client built from an RPC URL
    /// alone answers every read method in this crate.
    #[error(
        "{method} sends a transaction and this client has no signer. Build it with \
         ClientBuilder::signer(..) — a private key, or any alloy signer — or stay on the read \
         methods, which need no key."
    )]
    SignerRequired {
        /// The method that needed one.
        method: &'static str,
    },

    /// The chain answered with a different chain id from the one the preset
    /// names.
    ///
    /// Checked once, when the client is built. It is the cheap way to catch an
    /// RPC URL pointed at the wrong chain, and an anvil fork that silently fell
    /// back to its own id of 31337 instead of forking — a failure that otherwise
    /// surfaces much later, as an address with no code.
    #[error(
        "this endpoint reports chain id {actual}, and the {network} preset is chain id {expected}. \
         Every address in the preset belongs to {expected}; on {actual} they are accounts with no \
         code. Point the client at the right endpoint, or use Network::Custom if you meant this \
         one."
    )]
    ChainIdMismatch {
        /// The network preset in use.
        network: String,
        /// What the preset says.
        expected: u64,
        /// What the endpoint answered.
        actual: u64,
    },

    /// A platform's three allocations add up to more than it is allowed to give
    /// away. Checked client-side, before anything is sent.
    #[error(
        "a platform may allocate at most {allowance} across creator, ref and dev, and \
         {creator} + {ref_share} + {dev} is {requested}. What it does not allocate is its own \
         share, so this configuration leaves the platform {residual} — and the registry will \
         refuse it with FeeSharesExceedAllowance rather than deploy it. Note the allowance is \
         measured against the protocol's MAXIMUM share (2500 bps), not its current one, so this \
         limit does not move when the protocol admin lowers their cut."
    )]
    FeeSharesExceedAllowance {
        /// The creator share asked for.
        creator: Bps,
        /// The ref share asked for.
        ref_share: Bps,
        /// The dev share asked for.
        dev: Bps,
        /// The three, totalled.
        requested: Bps,
        /// The most a platform may allocate: 7500 bps.
        allowance: Bps,
        /// What that leaves the platform — negative here, rendered as the
        /// shortfall.
        residual: String,
    },

    /// An argument this crate refuses before anything is sent: an amount in the
    /// wrong kind of quote for the call, a quote token description that
    /// contradicts itself, arithmetic that has no answer.
    #[error("{reason}. Nothing was sent.")]
    InvalidArgument {
        /// What was wrong, in words.
        reason: String,
    },

    /// Two amounts, or an amount and the thing it was handed to, are in
    /// different quote tokens.
    ///
    /// SDK-side, raised before any transaction: arithmetic across two quotes,
    /// or a buy, sell or launch whose amount is not in the quote of the curve,
    /// pool or launch it was handed to. A euro amount sent to a dollar curve
    /// would otherwise be encoded as a wad and read by the curve as dollars.
    #[error(
        "this needs an amount in quote token {expected} and was given one in {actual} ({} is \
         native USDC). Amounts carry their quote token and are never converted: build the amount \
         with QuoteAmount::parse_in(&the_quote, ..), where the quote comes from curve.quote_token(), \
         pool.quote_token() or the launch's initial_buy.",
        crate::amount::NATIVE_QUOTE
    )]
    QuoteTokenMismatch {
        /// The quote the call is denominated in.
        expected: Address,
        /// The quote of the amount it was given.
        actual: Address,
    },

    /// A gas limit was given for a launch that will graduate, and it is too
    /// small for the migration inside it. Checked client-side, before anything
    /// is sent.
    ///
    /// **Not a limit that would make the launch fail** — one that would make it
    /// succeed and quietly do half the job. See
    /// [`crate::LaunchParams::gas_limit`].
    #[error(
        "this launch's initial buy graduates the curve, and a gas limit of {limit} is below the \
         {floor} the migration needs. The transaction would still SUCCEED: the curve attempts \
         the migration under a bounded budget and catches its failure, so you would get a token \
         that graduated the moment it was created, with no market and no error anywhere. Leave \
         the gas limit unset and the SDK sends {suggested}, or ask for at least {floor} — it is \
         a ceiling, not a charge, and unused gas is not paid for."
    )]
    LaunchGasLimitTooLow {
        /// What was asked for.
        limit: u64,
        /// The least that can work: `GRADUATION_GAS_FLOOR`.
        floor: u64,
        /// What the SDK would have sent: `GRADUATION_GAS_LIMIT`.
        suggested: u64,
    },

    /// A contract answered a `VERSION()` this SDK cannot price.
    ///
    /// Raised before any curve maths and before any trade is sent. This crate
    /// prices one bonding curve, the multi-quote constant-product
    /// `arcnow/bonding-curve@3.x.x`; any other version — the single-quote
    /// `@2.x.x` included — would be priced or paid wrongly, silently, so it is
    /// refused by name. A platform, platform registry, launchpad, quote
    /// registry or v4 migrator of another major is refused the same way.
    #[error(
        "{version:?} is not a version this SDK can price. It speaks the multi-quote stack: \
         arcnow/bonding-curve@3.x.x, arcnow/platform-config@3.x.x, arcnow/platform-registry@3.x.x, \
         arcnow/launchpad@3.x.x, arcnow/quote-registry@1.x.x and arcnow/uniswap-v4-migrator@2.x.x; \
         anything else encodes different amounts, events or templates and would be read wrongly \
         without an error, so it is refused. Nothing was sent. {}Upgrade the SDK if arcnow.io \
         has deployed a new stack.",
        predates_quote_tokens_note(version)
    )]
    UnknownCurveVersion {
        /// The version string, verbatim.
        version: String,
    },

    /// The address is **not a bonding curve at all**: its `VERSION()` names
    /// another contract — most often a token, handed over where its curve was
    /// wanted — or it answers no `VERSION()`: no code, or not arcnow.io's.
    ///
    /// Distinct from [`Error::UnknownCurveVersion`], which is a bonding curve
    /// (`arcnow/bonding-curve@…`) of a version this SDK does not know. A caller
    /// resolving an address a user pasted can branch on this one to try the
    /// address as a token instead.
    ///
    /// Raised by the SDK before any trade call. **Not** the migrators' contract
    /// error `NotACurve(address caller)`, which still decodes under its own name
    /// as [`Error::NamedRevert`]; the two are deliberately spelled differently.
    #[error("{}", not_a_curve_message(address.as_ref(), version.as_deref()))]
    AddressIsNotACurve {
        /// The address asked, when the refusal came from reading one.
        address: Option<Address>,
        /// What it answered to `VERSION()`, verbatim; `None` when it answered
        /// nothing.
        version: Option<String>,
    },

    /// The local curve maths refused, where the contract would revert.
    #[error("the curve maths refused this trade: {0}. The chain would revert the same call.")]
    CurveMath(#[from] crate::MathError),

    /// A pool's fee hook answers a `VERSION()` that is not
    /// `arcnow/arc-now-fee-hook@3.x.x`.
    ///
    /// The fee-hook counterpart of [`Error::UnknownCurveVersion`]: how a hook
    /// books its fee decides what "accrued" and "distributed" mean, so a hook
    /// this SDK does not know is refused by name rather than read as the nearest
    /// one.
    #[error(
        "the fee hook at {hook} answers VERSION() {version:?}, which is not \
         arcnow/arc-now-fee-hook@3.x.x, the hook that accrues its fee as PoolManager claims in the \
         pool's quote currency, in raw units. How \
         another build books its fees cannot be guessed, so nothing was read from it or sent to \
         it. Upgrade the SDK if arcnow.io has deployed a new hook."
    )]
    UnknownHookVersion {
        /// The hook, from the pool's key.
        hook: Address,
        /// Its `VERSION()`, verbatim.
        version: String,
    },

    /// A decimal amount could not be read.
    #[error(transparent)]
    Amount(#[from] crate::amount::AmountParseError),

    /// A basis-point value off the chain was not a plausible one.
    #[error(
        "{value} is not a basis-point quantity: every bps value in these contracts is bounded by \
         10000. This is a decoding mistake, not a configuration one."
    )]
    ImplausibleBps {
        /// The value as it was read.
        value: String,
    },

    // ------------------------------------------------------------- transport
    /// The RPC endpoint, the transport or the node itself failed.
    #[error("{context}: {message}")]
    Rpc {
        /// What this crate was trying to do.
        context: String,
        /// What the transport said.
        message: String,
    },

    /// A return value or a log could not be decoded against the pinned ABI.
    ///
    /// If this fires against a live arcnow.io deployment it means the ABI pin
    /// and the deployed bytecode have diverged — which is the exact failure
    /// `../pins.json` and `../scripts/check-pins.sh` exist to prevent.
    #[error(
        "{context}: {message}. This crate's ABIs are pinned to arcnow-io/contracts at the commit \
         in ../pins.json; a decode failure against a live deployment means that pin and the \
         deployed bytecode have diverged."
    )]
    Abi {
        /// What this crate was trying to decode.
        context: String,
        /// What the decoder said.
        message: String,
    },

    /// A transaction succeeded and did not carry the log its result is read
    /// from.
    #[error(
        "transaction {tx_hash} succeeded but carries no {event} log, so there is nothing to read \
         the result out of. Either the address called is not the contract this crate thinks it is, \
         or the receipt's logs were filtered in transit."
    )]
    MissingLog {
        /// The transaction.
        tx_hash: B256,
        /// The event that should have been there.
        event: &'static str,
    },

    /// A transaction was mined and reverted, and the node gave no reason.
    #[error(
        "transaction {tx_hash} was mined and reverted, and the receipt carries no revert reason. \
         Re-run the same call as an eth_call against that block to get the error: a simulated call \
         returns the revert data, a mined receipt only records the status."
    )]
    TransactionReverted {
        /// The transaction.
        tx_hash: B256,
    },

    // --------------------------------------------------- launchpad (reverts)
    /// `msg.value` was not exactly the launch fee plus the initial buy.
    #[error(
        "a launch costs exactly {expected} USDC{} and this sent {actual}. The launchpad takes \
         exact payment, not at-least: it has no refund path and will not strand your change. Call \
         quote_launch and send its total_cost.",
        match (launch_fee, initial_buy) {
            (Some(fee), Some(buy)) => format!(" ({fee} fee + {buy} initial buy)"),
            _ => String::new(),
        }
    )]
    IncorrectPayment {
        /// What the launch costs.
        expected: Usdc,
        /// What was sent.
        actual: Usdc,
        /// The flat launch fee, when this crate was the one that built the call
        /// and therefore knows the breakdown.
        launch_fee: Option<Usdc>,
        /// The initial buy, likewise.
        initial_buy: Option<Usdc>,
    },

    /// The platform named is not live in the registry.
    #[error(
        "{platform} is not a registered platform, so a launch under it is refused. The check runs \
         at inclusion, not at signing: a platform deregistered while your transaction sat in the \
         mempool stops being launchable even though it was live when you signed. Read \
         platform_registry().is_platform(..) first, or launch under the network's arcnowPlatform."
    )]
    PlatformNotRegistered {
        /// The address that was refused.
        platform: Address,
    },

    /// The migrator named is not in the registry.
    #[error(
        "{migrator} is not a registered migrator. A creator chooses a graduation target from the \
         protocol's list, never from the whole address space — the alternative is a creator \
         pointing their own buyers' liquidity at an address they control. Pass None to take the \
         platform's default, which is what almost every launch does."
    )]
    MigratorNotRegistered {
        /// The address that was refused.
        migrator: Address,
    },

    /// Name, symbol or metadata URI was empty.
    #[error(
        "a launch needs a non-empty name, symbol and metadata URI. One of the three was empty."
    )]
    InvalidLaunchParameters,

    /// `collectLaunchFees` found nothing accrued.
    #[error("there are no accrued launch fees to collect.")]
    NoFeesToCollect,

    // ------------------------------------------------------- curve (reverts)
    /// The curve has reached its target and retired.
    #[error(
        "this curve reached its target and stopped trading permanently. Graduation is terminal: \
         every further buy and sell reverts, and there is no admin who can reopen it. Trade the \
         token at its graduation venue instead — curve.state().migrator says which one this \
         curve snapshotted at launch."
    )]
    CurveGraduated,

    /// `migrate()` was called before the curve graduated.
    #[error(
        "this curve has not reached its target yet, so there is nothing to migrate. Watch \
         curve.state().progress_bps, or just trade: the buy that fills the curve migrates it in \
         the same transaction and nobody has to call migrate at all."
    )]
    NotGraduated,

    /// `migrate()` was called and the assets have already moved.
    ///
    /// **Usually the good outcome.** The graduating buy attempts the migration
    /// in its own transaction; when that succeeds there is nothing left for
    /// `migrate()` to do. It is only the *retry* path, for the case where the
    /// instant attempt failed and logged `InstantMigrationFailed`.
    #[error(
        "this curve has already migrated, so there is nothing left to forward. That is the normal \
         outcome, not a problem: the graduating buy migrates the curve in the same transaction, \
         and migrate() is only the permissionless retry for when that attempt failed and logged \
         InstantMigrationFailed."
    )]
    AlreadyMigrated,

    /// An amount whose wad the quote token cannot carry: `amount_wad` is not a
    /// whole multiple of `quote_scale = 10^(18 - decimals)`.
    ///
    /// Raised by this SDK before sending, and also the contracts' own error of
    /// the same name, which decodes as this variant. The chain moves
    /// `wad / scale` raw units of an ERC-20, so a wad with dust below one raw
    /// unit would pay a different amount from the one asked for.
    #[error(
        "{amount_wad} wad is not a whole number of raw units of this quote token, whose scale is \
         {quote_scale} (10^(18 - decimals)). The token can only move multiples of that. Round the \
         amount with floor_to_representable() or ceil_to_representable() first. Nothing was sent."
    )]
    QuoteAmountNotRepresentable {
        /// The wad that was refused.
        amount_wad: U256,
        /// The quote token's scale.
        quote_scale: U256,
    },

    /// A zero-value buy or a zero-token sell.
    #[error(
        "a trade of zero is refused rather than treated as a no-op, so that an integration bug \
         surfaces here instead of as an event stream full of empty trades."
    )]
    ZeroAmount,

    /// The transaction was mined after the deadline it carried.
    #[error(
        "this transaction sat in the mempool past its deadline of {deadline} and was included at \
         {timestamp}, {} seconds late. Nothing was traded. Re-quote and send it again — the point \
         of the deadline is that a stalled transaction is refused rather than filled at a price \
         you never saw.",
        timestamp.saturating_sub(*deadline)
    )]
    DeadlineExpired {
        /// The deadline the caller set, in unix seconds.
        deadline: u64,
        /// The block timestamp that exceeded it.
        timestamp: u64,
    },

    /// The fill would have delivered less than the caller's floor.
    ///
    /// The two amounts are raw 18-decimal wads because the unit depends on the
    /// side: tokens on a buy, USDC on a sell.
    #[error(
        "the fill moved to {actual_out} against your floor of {min_out} (both 18-decimal wad: \
         tokens on a buy, USDC on a sell). Nothing was traded. Re-quote and retry — the curve's \
         price rises across your own order, so a large buy always fills worse than the spot price \
         suggests, and somebody else's trade in between moves it further."
    )]
    SlippageExceeded {
        /// The caller's floor.
        min_out: U256,
        /// What the trade would have delivered.
        actual_out: U256,
    },

    /// The seller offered more tokens than they hold.
    #[error(
        "{seller} holds {balance} and offered {amount}. **No approval is involved here**: the \
         curve pulls tokens through a privileged path that reads no allowance at all, so a caller \
         who reaches for approve() is fixing the wrong thing. Sell what you hold."
    )]
    InsufficientTokenBalance {
        /// The account selling.
        seller: Address,
        /// What they hold.
        balance: Tokens,
        /// What they offered.
        amount: Tokens,
    },

    /// A sell offered more tokens than the curve has ever sold.
    #[error(
        "the curve has sold {tokens_sold} tokens and this sell offers {amount}. Unreachable \
         through the token, which cannot mint — this guards an accounting bug rather than a user."
    )]
    ExceedsTokensSold {
        /// What the curve believes is outstanding.
        tokens_sold: Tokens,
        /// What was offered.
        amount: Tokens,
    },

    /// `withdraw` found no deferred credit.
    #[error(
        "this account has no deferred payout to withdraw. A credit appears only when a payout \
         could not be delivered — a blocklisted address, or a recipient whose receive() wants more \
         than the 30,000-gas stipend. Read pending_withdrawal(account) first."
    )]
    NothingToWithdraw,

    /// A native USDC transfer failed where failure could not be deferred.
    #[error(
        "the curve could not send {amount} USDC to {to}. On Arc this is what a blocklisted address \
         looks like. The credit is left intact, so call withdraw again naming an address that can \
         receive."
    )]
    TransferFailed {
        /// The intended recipient.
        to: Address,
        /// The amount attempted.
        amount: Usdc,
    },

    /// A re-entrant call was refused.
    #[error("a re-entrant call was refused by the contract's reentrancy latch.")]
    Reentrancy,

    /// A constructor argument that must be non-zero was zero.
    #[error(
        "a required address argument was the zero address. On Arc that is a real account that \
         would send money nowhere at all, which is why it is refused rather than accepted as a \
         'none'."
    )]
    ZeroAddress,

    /// The curve's immutable parameters are inconsistent.
    #[error(
        "the curve parameters are inconsistent — a zero Y0 or R0, a zero target or curve supply, or \
         a fee above the permitted maximum. Validate the template with \
         PlatformConfig::check_curve_parameters before registering a platform with it."
    )]
    InvalidParameters,

    // ---------------------------------------------------- fee config (reverts)
    /// A fee split reached a constructor without totalling 10000.
    #[error(
        "a fee split reached a constructor with shares that do not total exactly 10000, or with a \
         zero platform or protocol recipient. A split that does not add up either loses fee wei or \
         promises more than was taken, on every trade, forever — so it is refused before the \
         numbers become immutable."
    )]
    InvalidFeeConfig,

    /// The five shares do not total 10000.
    #[error(
        "the five fee shares total {total} and must total exactly 10000 bps of the fee. Remember \
         the platform's own share is the residual and is never an input: it is \
         10000 - protocol - creator - ref - dev."
    )]
    FeeSharesNotWhole {
        /// What they actually totalled.
        total: Bps,
    },

    /// One share on its own exceeds the denominator.
    #[error("a single fee share of {share} exceeds the 10000 bps denominator.")]
    ShareExceedsDenominator {
        /// The offending share.
        share: Bps,
    },

    /// A fee recipient that must be set is the zero address.
    #[error(
        "the platform and protocol fee recipients must both be non-zero. They are the two that \
         cannot be resolved at swap time — creator, ref and dev may be zero, and their shares go \
         to the platform. On Arc a native transfer to the zero address reverts, so a zero \
         recipient does not lose money quietly, it bricks every trade on every token that platform \
         launches."
    )]
    ZeroFeeRecipient,

    // ------------------------------------------------ platform registry/config
    /// The caller is not the registry's protocol admin.
    #[error(
        "{caller} is not the protocol admin, and registering or deregistering a platform, setting \
         the protocol share and setting the protocol recipient are the protocol admin's alone. \
         **This is the single most likely surprise in this API**: register_platform is not open to \
         ordinary callers. Read platform_registry().protocol_admin() to see who it is."
    )]
    NotProtocolAdmin {
        /// The rejected caller.
        caller: Address,
    },

    /// The caller is not the account offered the protocol-admin role.
    #[error("{caller} is not the pending protocol admin, so there is nothing here to accept.")]
    NotPendingProtocolAdmin {
        /// The rejected caller.
        caller: Address,
    },

    /// The caller is not this contract's admin.
    #[error(
        "{caller} is not the admin of this contract. A platform's settings are its admin's alone, \
         and so is a migrator registry's list."
    )]
    NotAdmin {
        /// The rejected caller.
        caller: Address,
    },

    /// The caller is not the account offered the admin role.
    #[error("{caller} is not the pending admin, so there is nothing here to accept.")]
    NotPendingAdmin {
        /// The rejected caller.
        caller: Address,
    },

    /// The protocol share was set outside its band.
    #[error(
        "a protocol share of {share} is outside [{minimum}, {maximum}]. The floor stops a \
         compromised admin zeroing the protocol's revenue; the ceiling is equal to the shipped \
         default, so the protocol may lower its cut and never raise it — which is what lets every \
         platform's stored configuration stay valid."
    )]
    ProtocolShareOutOfBounds {
        /// The rejected share.
        share: Bps,
        /// The floor, inclusive.
        minimum: Bps,
        /// The ceiling, inclusive.
        maximum: Bps,
    },

    /// A platform already barred was barred again.
    #[error(
        "{platform} is already deregistered. There is deliberately no re-registration path: a \
         platform that should trade again gets a fresh config, so 'deregistered' is terminal for \
         one address and cannot be toggled underneath an integrator."
    )]
    PlatformAlreadyDeregistered {
        /// The address.
        platform: Address,
    },

    // ------------------------------------------------- curve template (reverts)
    /// `floor(R0 · 1e18 / Y0)` is not the declared opening price.
    #[error(
        "this template declares an opening price of {expected} and its Y0 and R0 produce {actual}. \
         A configuration that fails this quotes one price to its users and charges another. The \
         tolerance is one wei and it is directional: a template may declare a price one wei ABOVE \
         floor(R0 * 1e18 / Y0), where the curve rounds in the buyer's favour, and never one below. \
         Take CurveTemplate::arcnow_defaults() rather than deriving your own in floating point."
    )]
    InitialPriceMismatch {
        /// The declared price.
        expected: Usdc,
        /// What `floor(R0 · 1e18 / Y0)` actually is.
        actual: Usdc,
    },

    /// `C(Y0 - S) - R0`, what the curve collects selling its whole supply, is not
    /// the declared target.
    #[error(
        "this template declares a graduation target of {expected} USDC and its parameters would \
         actually collect {actual}. A curve built from it would graduate somewhere other than \
         where it claims to. The band is one part in 1e12."
    )]
    GraduationTargetMismatch {
        /// The declared target.
        expected: Usdc,
        /// What the parameters would collect.
        actual: Usdc,
    },

    /// The template cannot be priced at all.
    ///
    /// The error's second word is `y0Wad`, the virtual token reserve at launch.
    #[error(
        "this template cannot be priced: its Y0 is {y0} and the curve supply is {curve_supply}. \
         Y0 must be strictly above the curve supply and at most 2^128 - 1 wad, with R0 and the \
         target inside the same bound. Such a curve could not be priced over its whole life, and \
         one that floors its last price to zero launches, trades, graduates and can then never \
         migrate."
    )]
    CurveNotPriceable {
        /// The offending curve supply.
        curve_supply: Tokens,
        /// The offending `Y0`.
        y0: Tokens,
    },

    /// The template's supplies are unusable.
    #[error(
        "a total supply of {total_supply} against a curve supply of {curve_supply} is not usable. \
         The curve supply must be non-zero and STRICTLY below the total: what is left over is the \
         inventory the migrator opens the market with, and a pool cannot be opened with one side \
         empty. A template that puts the whole supply on the curve does not risk an empty \
         migration, it guarantees one."
    )]
    InvalidSupplies {
        /// The offending total supply.
        total_supply: Tokens,
        /// The offending curve supply.
        curve_supply: Tokens,
    },

    /// What the template holds back is not what the graduating reserve buys.
    #[error(
        "this template holds back {held_back} tokens and the reserve it graduates with buys \
         {required} at the curve's last price. The two must match, within one part in 1e12 upwards \
         and not one wei downwards: the goal is that ALL the USDC raised and ALL the tokens not \
         sold go into the DEX at the curve's final price. Hold back too few and a v2 migration \
         burns the USDC the price cannot absorb; hold back too many and it burns the tokens. \
         CurveTemplate::arcnow_defaults() satisfies this exactly — do not re-derive it in floating \
         point, the integers were placed at eighty digits."
    )]
    PoolReserveMismatch {
        /// `total_supply - curve_supply`.
        held_back: Tokens,
        /// What the graduating reserve buys at the last price.
        required: Tokens,
    },

    // --------------------------------------------------------- token (reverts)
    /// A privileged token path was called by something other than the curve.
    #[error(
        "{caller} is not this token's curve, and curveTransferFrom and burnFrom are the curve's \
         alone. That privilege is what makes a sell need no approval, and it is checked against \
         msg.sender on every call — it is not an allowance and cannot be granted to anyone."
    )]
    NotCurve {
        /// The rejected caller.
        caller: Address,
    },

    /// An ordinary ERC-20 `transferFrom` without enough allowance.
    ///
    /// **Nothing to do with selling to a curve**, which reads no allowance at
    /// all. This is a third party trying to move somebody's tokens — including
    /// the v4 router on a post-graduation sell, which pulls the token leg this
    /// way and *does* need an approval. See [`crate::Pool::approve_router`].
    #[error(
        "{spender} has an allowance of {allowance} over {owner} and needs {needed}. This is the \
         ordinary ERC-20 path, used by routers and other spenders — it is NOT the path a sell to \
         the CURVE takes, which needs no approval and never reads an allowance. A sell into a \
         graduated token's v4 pool goes through the router and does need one."
    )]
    InsufficientAllowance {
        /// Whose tokens.
        owner: Address,
        /// Who is trying to move them.
        spender: Address,
        /// What they are allowed.
        allowance: Tokens,
        /// What the transfer needed.
        needed: Tokens,
    },

    /// An ERC-20 transfer for more than the holder has.
    #[error("{holder} holds {balance} and this needs {needed}.")]
    InsufficientBalance {
        /// The holder.
        holder: Address,
        /// What they hold.
        balance: Tokens,
        /// What was needed.
        needed: Tokens,
    },

    /// A transfer to the zero address.
    #[error(
        "a transfer to the zero address is refused. Burning is not something this token offers to \
         holders."
    )]
    TransferToZeroAddress,

    /// An approval to the zero address.
    #[error(
        "an approval to the zero address is refused: nothing can ever spend it, so it can only be \
         a mistake — a miscomputed spender, or an unfilled struct field."
    )]
    ApproveToZeroAddress,

    /// The token's migrated pool has already been recorded.
    #[error("{pool} is already recorded as this token's migrated pool, and it is recorded once.")]
    PoolAlreadyRecorded {
        /// The pool.
        pool: Address,
    },

    /// The caller is not the token's creator.
    #[error("{caller} is not this token's creator seat.")]
    NotCreator {
        /// The rejected caller.
        caller: Address,
    },

    /// The caller is not the account offered the creator seat.
    #[error("{caller} is not the pending creator, so there is nothing here to accept.")]
    NotPendingCreator {
        /// The rejected caller.
        caller: Address,
    },

    /// An EIP-2612 permit was presented after its deadline.
    #[error("this permit expired at {deadline}. Sign a fresh one.")]
    PermitExpired {
        /// The permit's deadline.
        deadline: u64,
    },

    /// An EIP-2612 permit signature did not recover to the owner.
    #[error(
        "this permit's signature does not recover to the owner. Check the domain separator, the \
         nonce and the chain id — a permit signed for another chain verifies as invalid here \
         rather than as a wrong chain."
    )]
    InvalidPermitSignature,

    // ------------------------------------------------- the post-graduation pool
    /// This network names no Uniswap v4 router, so no graduated token can be
    /// quoted or traded through this SDK.
    ///
    /// Raised by every pool quote and trade — and by
    /// [`crate::Pool::router_allowance`] and [`crate::Pool::approve_router`] —
    /// **before any RPC**, while `contracts.v4Router` is `null`. The pools
    /// exist and hold liquidity; what is missing is the contract that swaps
    /// through them on a caller's behalf, and building a call to nothing would
    /// fail with a far worse message.
    ///
    /// arcnow.io deploys that router itself, against its own `PoolManager`:
    /// `UniswapV4Router04` from z0r0z/v4-router, unmodified, via
    /// `arcnow-io/contracts` `script/DeployV4Router.s.sol`. When it is
    /// broadcast its address arrives in `networks.json` and this stops. Until
    /// then, a caller who has deployed it themselves (on a fork, say) passes
    /// it through [`crate::Network::Custom`] with
    /// [`crate::ContractAddresses::v4_router`] set.
    ///
    /// [`crate::Pool::is_reachable`] answers `Ok(false)` in this state rather
    /// than raising this.
    #[error(
        "no Uniswap v4 router is deployed for this network (chain id {chain_id}) yet, so \
         graduated tokens cannot be traded. It is deployed by arcnow-io/contracts \
         script/DeployV4Router.s.sol; once it is, its address goes in networks.json as \
         contracts.v4Router, or pass one through Network::Custom with ContractAddresses::v4_router."
    )]
    NoRouterDeployed {
        /// The chain the client is connected to. `0` only for a preset that
        /// names no chain id at all, which no built client can have.
        chain_id: u64,
    },

    /// The configured router serves a different `PoolManager` from the one
    /// this token's pool is in, so it cannot reach the pool.
    ///
    /// A Uniswap v4 pool has no address of its own — it is a `PoolId` inside
    /// **one** `PoolManager`'s storage — and a router holds its `poolManager`
    /// immutable, as does the migrator that opened the pool. So a router bound
    /// to any other manager answers the correct `PoolKey` with
    /// `PoolNotInitialized()` (`0x486aa307`): from where it stands the pool
    /// does not exist. This variant is raised instead of that four bytes.
    ///
    /// **With arcnow.io's own deployment this should not arise for an arcnow.io
    /// token**: its router is deployed against the same `PoolManager` its
    /// migrator uses. Seeing it means the network was configured with some
    /// other router, or the token graduated through a migrator bound to some
    /// other manager. Retrying will not help; a router bound to
    /// `pool_manager` will.
    #[error(
        "{token}'s pool is in the Uniswap v4 PoolManager at {pool_manager}, and the router this \
         network is configured with ({router}) is bound to {router_pool_manager}. A v4 pool has \
         no address: it is a PoolId inside ONE manager's storage, and both bindings are \
         immutable, so that router cannot reach this pool and retrying will not change it. \
         Configure a router deployed against {pool_manager} — arcnow.io's own router is, so for \
         an arcnow.io token this points at a misconfigured network."
    )]
    PoolUnreachable {
        /// The token whose pool cannot be reached.
        token: Address,
        /// The `PoolManager` its migrator is bound to.
        pool_manager: Address,
        /// The router this SDK would have swapped through.
        router: Address,
        /// The `PoolManager` that router is immutably bound to.
        router_pool_manager: Address,
    },

    /// A pool operation on a token that has not migrated yet.
    #[error(
        "{token} has not migrated: it still trades on its bonding curve, and there is no v4 pool \
         to quote. Use Curve::quote_buy / Curve::buy, or Trade, which reads the venue first. \
         ArcToken.migratedPool() is zero until a curve reaches its target and its migrator seeds \
         the pool."
    )]
    TokenNotMigrated {
        /// The token asked about.
        token: Address,
    },

    /// A request built for one venue was handed to a token trading at the other.
    ///
    /// The two venues are not interchangeable and the request types say so: a
    /// curve trade credits a referrer and a developer and ignores any recipient,
    /// a pool trade pays a named receiver and has nobody to credit. Rather than
    /// silently dropping the fields that do not apply, the front door refuses.
    #[error(
        "{token} trades at the {actual} and this is a {requested} request. They are not \
         interchangeable: a curve trade credits a referrer and a developer and always pays the \
         sender, a pool trade pays a named receiver and credits nobody. Ask Trade::venue (or read \
         the venue off the quote) and build the matching request."
    )]
    VenueMismatch {
        /// The token traded.
        token: Address,
        /// Where it actually trades.
        actual: crate::pool::Venue,
        /// The venue the request was built for.
        requested: crate::pool::Venue,
    },

    /// A pool sell with no allowance for the router to pull the token leg.
    ///
    /// Refused before anything is sent. Unlike a curve sell — which reads no
    /// allowance at all — the router moves the token with `transferFrom`, and
    /// `ArcToken.canonicalRouter()` is `address(0)` on every arcnow.io token, so
    /// there is no standing allowance to fall back on.
    #[error(
        "{owner} has approved the v4 router {router} {allowance} of {token} and this sell needs \
         {needed}. A sell into a graduated token's pool is TWO transactions: approve the router, \
         then swap. This is the one place an approval is required — selling to a bonding curve \
         never needs one — and canonicalRouter() is the zero address on every arcnow.io token, so \
         nothing was auto-approved. Call Pool::approve_router first."
    )]
    RouterApprovalRequired {
        /// The token being sold.
        token: Address,
        /// The seller.
        owner: Address,
        /// The router that has to pull the tokens.
        router: Address,
        /// What it is allowed today. `Tokens::MAX` is the unlimited sentinel.
        allowance: Tokens,
        /// What this sell needs.
        needed: Tokens,
    },

    /// The router filled below the caller's floor.
    ///
    /// Distinct from [`Error::SlippageExceeded`] because the router's
    /// `SlippageExceeded()` carries **no amounts**: it says the bound was missed
    /// and nothing else. Reporting zeros in the curve's variant would be a
    /// fabricated number in a message a human reads.
    #[error(
        "the v4 router refused the swap: the fill would have been worse than the floor you \
         passed. The router's error carries no amounts, so there is nothing to report about how \
         much worse. Nothing was traded. Re-quote and retry — somebody else's swap in between \
         moves the price, and a pool's depth is not the curve's."
    )]
    PoolSlippageExceeded,

    /// A pool trade was mined after the deadline it carried.
    ///
    /// Distinct from [`Error::DeadlineExpired`] because the router's
    /// `DeadlinePassed(uint256)` reports the deadline and **not** the block
    /// timestamp that exceeded it.
    #[error(
        "this swap sat in the mempool past its deadline of {deadline} (unix seconds) and was \
         refused. Nothing was traded. The router's error does not carry the block timestamp, so \
         there is no 'how late' to report. Re-quote and send it again."
    )]
    PoolDeadlineExpired {
        /// The deadline the caller set, in unix seconds.
        deadline: u64,
    },

    /// The router could not pull the token leg of a sell.
    #[error(
        "the v4 router could not move {token} out of the seller's account. The overwhelmingly \
         likely reason is the allowance: the router pulls the token leg with transferFrom, and \
         nothing about an arcnow.io token auto-approves it. Check Pool::router_allowance, and \
         check the seller actually holds what they offered."
    )]
    RouterCouldNotPullToken {
        /// The token the router failed to move.
        token: Address,
    },

    // --------------------------------------------------------------- generic
    /// A custom error this crate knows by name but has no dedicated variant
    /// for.
    ///
    /// Decoded from the ABIs all the same: the name, the full signature and the
    /// arguments are all here. Most of these come from the venue migrators and
    /// the fee hook, which this SDK does not call directly but a graduating buy
    /// does.
    #[error("{name} reverted the call{}{}",
        if arguments.is_empty() { String::new() } else { format!(" with ({})", arguments.join(", ")) },
        format!(". Its full signature is {signature}, declared in {source_abi}.")
    )]
    NamedRevert {
        /// The error's name.
        name: String,
        /// Its full Solidity signature, as the selector was hashed from.
        signature: String,
        /// The ABI it was found in.
        source_abi: &'static str,
        /// The decoded arguments, rendered.
        arguments: Vec<String>,
    },

    /// A plain `require(cond, "message")` revert.
    #[error("the call reverted with the message {message:?}.")]
    ErrorString {
        /// The string the contract carried.
        message: String,
    },

    /// A compiler-inserted `Panic(uint256)`.
    #[error("the call hit a Solidity panic: {}. (code {code})", panic_meaning(*code))]
    Panic {
        /// The panic code.
        code: U256,
    },

    /// The call reverted with no data at all.
    #[error(
        "the call reverted with no data. That is usually not a deliberate revert: it is what an \
         out-of-gas looks like, and what a call to an address with no code looks like. Check the \
         address actually holds the contract you think it does, and that the gas limit is enough — \
         a graduating buy attempts the migration in the same transaction and needs room for it."
    )]
    EmptyRevert,

    /// An ERC-20-quoted trade or launch reverted with no data: its fee-share
    /// transfers ran out of gas.
    #[error(
        "the call reverted with no data on a path that pays {symbol} fee shares{}. arcnow.io's \
         contracts push every ERC-20 fee share through a gas guard \
         (QuoteTransfer.tryPushBounded) that reverts with no data when less than about 111,600 \
         gas remains for it, so this is a gas limit too tight for the transfers rather than a \
         rejection. Leave the gas limit unset and the SDK sends the node's estimate plus a fifth \
         (at least 150,000 more), or raise it; a graduating trade needs GRADUATION_GAS_LIMIT.",
        gas_limit_note(*gas_limit)
    )]
    QuoteTransferOutOfGas {
        /// The quote token whose transfers the guard protects.
        symbol: String,
        /// The gas limit the trade was simulated or sent with, when one was set.
        gas_limit: Option<u64>,
    },

    /// Uniswap v4's `WrappedError(address,bytes4,bytes,bytes)`, whose inner
    /// revert could not be decoded.
    ///
    /// The `PoolManager` wraps every revert from a hook — and from a few other
    /// external calls — in this error, so an `ArcNowFeeHook` refusal inside a
    /// swap arrives as `0x90bfb865…` rather than as itself. [`decode_revert`]
    /// unwraps it and returns the **inner** error whenever that is a custom error
    /// in a pinned ABI, an `Error(string)` or a `Panic` — so a hook's
    /// `PoolNotRegistered` reads as `NamedRevert { name: "PoolNotRegistered" }`,
    /// not as this. This variant is what is left when the inner revert is empty
    /// or in no ABI this crate carries.
    ///
    /// **Selector `0x00000000` with `NativeTransferFailed()` as `details` is a
    /// native transfer, not a function call**: v4-core's `Currency.transfer`
    /// wraps a failed native payment as `WrappedError(recipient, bytes4(0), "",
    /// NativeTransferFailed())`. Inside a hook's callback it is a genuine second
    /// layer — the `PoolManager` could not pay native USDC to that address — and
    /// the message says so in those words.
    #[error("{}", wrapped_revert_message(target, *selector, reason, details))]
    WrappedRevert {
        /// The contract whose call failed — on a swap, the pool's hook.
        target: Address,
        /// The selector of the function called on it, e.g. `beforeSwap`.
        selector: alloy::primitives::FixedBytes<4>,
        /// The inner revert data, verbatim.
        reason: Bytes,
        /// The context v4 attached, e.g. `HookCallFailed()`'s selector.
        details: Bytes,
    },

    /// A selector in none of the pinned ABIs.
    #[error(
        "the call reverted with selector {selector}, which is in none of this crate's pinned \
         ABIs. Look it up — a selector is the first four bytes of keccak256 of the error's \
         signature, and public databases index them. Full revert data: {data}. If this came from \
         an arcnow.io contract, the ABI pin in ../pins.json has drifted from the deployed \
         bytecode."
    )]
    UnknownRevert {
        /// The four-byte selector, as hex.
        selector: String,
        /// The whole revert payload, as hex.
        data: Bytes,
    },
}

/// The multi-quote stack's major version for each component this SDK gates.
const MULTI_QUOTE_MAJORS: [(&str, u64); 7] = [
    ("bonding-curve", 3),
    ("platform-config", 3),
    ("platform-registry", 3),
    ("launchpad", 3),
    ("arc-now-fee-hook", 3),
    ("quote-registry", 1),
    ("uniswap-v4-migrator", 2),
];

/// "This build predates quote tokens" for a known component at an older major
/// than the multi-quote stack's — the live version-2 stack — and nothing for any
/// other version, including a newer build or another contract's `VERSION()`.
fn predates_quote_tokens_note(version: &str) -> &'static str {
    let older = version
        .strip_prefix("arcnow/")
        .and_then(|rest| rest.split_once('@'))
        .and_then(|(component, semver)| {
            let major = semver.split('.').next()?.parse::<u64>().ok()?;
            let wanted = MULTI_QUOTE_MAJORS.iter().find(|(name, _)| *name == component)?.1;
            Some(major < wanted)
        })
        .unwrap_or(false);
    if older {
        "This build predates quote tokens: it is the version-2 stack, which this SDK no longer \
         speaks. "
    } else {
        ""
    }
}

fn gas_limit_note(gas_limit: Option<u64>) -> String {
    gas_limit.map_or_else(String::new, |limit| format!(" at a gas limit of {limit}"))
}

impl Error {
    /// Build an [`Error::Rpc`] with context.
    pub(crate) fn rpc(context: impl Into<String>, message: impl std::fmt::Display) -> Self {
        Self::Rpc { context: context.into(), message: message.to_string() }
    }

    /// Build an [`Error::Abi`] with context.
    pub(crate) fn abi(context: impl Into<String>, message: impl std::fmt::Display) -> Self {
        Self::Abi { context: context.into(), message: message.to_string() }
    }

    /// Turn an alloy contract error into this crate's error, decoding any revert
    /// data it carries.
    ///
    /// `context` is what the SDK was doing — it ends up in front of a transport
    /// failure, where "connection refused" on its own says nothing about which
    /// call died.
    /// An [`Error::EmptyRevert`] on a path paying an ERC-20 quote's fee shares
    /// is that quote's gas guard: named as [`Error::QuoteTransferOutOfGas`].
    /// Anything else, and any native path, passes through unchanged.
    #[must_use]
    pub(crate) fn on_erc20_quote(
        self,
        quote: &crate::amount::QuoteTokenInfo,
        gas_limit: Option<u64>,
    ) -> Self {
        match self {
            Self::EmptyRevert if !quote.is_native => {
                Self::QuoteTransferOutOfGas { symbol: quote.symbol.to_string(), gas_limit }
            }
            other => other,
        }
    }

    pub(crate) fn from_contract(error: alloy::contract::Error, context: &str) -> Self {
        if let alloy::contract::Error::TransportError(transport) = &error
            && let Some(payload) = transport.as_error_resp()
        {
            if let Some(data) = payload.as_revert_data() {
                return decode_revert(&data);
            }
            // A node that says "reverted" and carries nothing is reporting an
            // empty revert, which has its own meaning and its own message.
            if payload.message.contains("revert") {
                return Self::EmptyRevert;
            }
        }
        Self::rpc(context.to_owned(), error)
    }

    /// Attach the launch-cost breakdown to an [`Error::IncorrectPayment`].
    ///
    /// The revert carries only `expected` and `actual`; the caller who built the
    /// transaction is the only one who knows how the expected figure split
    /// between the flat fee and the initial buy, so it is added here rather than
    /// invented in the decoder.
    #[must_use]
    pub(crate) fn with_launch_breakdown(self, fee: Usdc, buy: Usdc) -> Self {
        match self {
            Self::IncorrectPayment { expected, actual, .. } => Self::IncorrectPayment {
                expected,
                actual,
                launch_fee: Some(fee),
                initial_buy: Some(buy),
            },
            other => other,
        }
    }
}

/// Decode raw revert data into an [`Error`].
///
/// Public because revert data reaches callers from places this crate does not
/// own — a raw `eth_call` through another library, a trace, a simulation
/// service — and an arcnow.io error should read the same wherever it was
/// caught.
///
/// ```
/// use arcnow_sdk::{decode_revert, Error};
///
/// // CurveGraduated() — keccak256("CurveGraduated()")[0..4].
/// let data = arcnow_sdk::alloy::hex::decode("025ac17e").unwrap();
/// assert!(matches!(decode_revert(&data), Error::CurveGraduated));
///
/// // Nothing at all is not "unknown", it is its own answer.
/// assert!(matches!(decode_revert(&[]), Error::EmptyRevert));
/// ```
#[must_use]
pub fn decode_revert(data: &[u8]) -> Error {
    if data.is_empty() {
        return Error::EmptyRevert;
    }
    if data.len() < 4 {
        return Error::UnknownRevert {
            selector: format!("0x{}", alloy::hex::encode(data)),
            data: Bytes::copy_from_slice(data),
        };
    }
    let selector: Selector = Selector::from_slice(&data[..4]);

    if selector[..] == ERROR_STRING_SELECTOR {
        return match <(String,) as alloy::sol_types::SolValue>::abi_decode(&data[4..]) {
            Ok((message,)) => Error::ErrorString { message },
            Err(_) => unknown(selector, data),
        };
    }
    if selector[..] == PANIC_SELECTOR {
        return match <(U256,) as alloy::sol_types::SolValue>::abi_decode(&data[4..]) {
            Ok((code,)) => Error::Panic { code },
            Err(_) => unknown(selector, data),
        };
    }
    if selector[..] == WRAPPED_ERROR_SELECTOR {
        return unwrap_wrapped_error(selector, data);
    }

    let Some(entry) = registry().get(&selector) else {
        return unknown(selector, data);
    };
    let Ok(decoded) = entry.error.decode_error(data) else {
        // The selector is one of ours and the body did not decode. Saying so
        // plainly beats pretending it is an unknown selector.
        return Error::Abi {
            context: format!("decoding a {} revert", entry.error.name),
            message: format!(
                "the selector matches {} but its arguments did not decode",
                entry.error.signature()
            ),
        };
    };
    curate(entry, &decoded.body)
}

/// `WrappedError(address target, bytes4 selector, bytes reason, bytes details)`
/// from v4-core's `CustomRevert`: the inner revert when it decodes, else
/// [`Error::WrappedRevert`].
///
/// Recursive, because a wrapped revert can wrap another: the innermost error
/// that decodes wins, and a chain whose innermost revert is unknown reports the
/// deepest wrapper, which names the contract closest to the failure.
fn unwrap_wrapped_error(selector: Selector, data: &[u8]) -> Error {
    type Wrapped = (Address, alloy::primitives::FixedBytes<4>, Bytes, Bytes);
    let Ok((target, called, reason, details)) =
        <Wrapped as alloy::sol_types::SolValue>::abi_decode_params(&data[4..])
    else {
        return unknown(selector, data);
    };
    match decode_revert(&reason) {
        Error::UnknownRevert { .. } | Error::EmptyRevert | Error::Abi { .. } => {
            Error::WrappedRevert { target, selector: called, reason, details }
        }
        inner => inner,
    }
}

fn unknown(selector: Selector, data: &[u8]) -> Error {
    Error::UnknownRevert {
        selector: format!("0x{}", alloy::hex::encode(selector)),
        data: Bytes::copy_from_slice(data),
    }
}

/// The message of [`Error::AddressIsNotACurve`]: what the address says it is.
fn not_a_curve_message(address: Option<&Address>, version: Option<&str>) -> String {
    let who = address.map_or_else(|| "this contract".to_owned(), ToString::to_string);
    let Some(version) = version else {
        return format!(
            "{who} answers no VERSION() at all, so it is not an arcnow.io bonding curve: an \
             address with no code, a contract that is not arcnow.io's, or the wrong chain. Nothing \
             was priced or sent."
        );
    };
    let component =
        version.strip_prefix("arcnow/").and_then(|rest| rest.split_once('@')).map(|(name, _)| name);
    let what = match component {
        Some("arc-token") => "an arcnow.io token, not its bonding curve. A token's curve is \
                              Token::curve(), and Client::trade(token) trades a token on whichever \
                              venue it is on"
            .to_owned(),
        Some(other) => format!("an arcnow.io {other}, not a bonding curve"),
        None => "no arcnow.io version, so not an arcnow.io bonding curve".to_owned(),
    };
    format!("{who} answers VERSION() {version:?}: {what}. Nothing was priced or sent.")
}

/// The message of [`Error::WrappedRevert`].
fn wrapped_revert_message(
    target: &Address,
    selector: alloy::primitives::FixedBytes<4>,
    reason: &Bytes,
    details: &Bytes,
) -> String {
    let details_name = details
        .get(..4)
        .and_then(|head| registry().get(&Selector::from_slice(head)))
        .map(|entry| entry.error.name.clone());
    if selector.0 == [0; 4] && details.get(..4) == Some(&NATIVE_TRANSFER_FAILED_SELECTOR[..]) {
        return format!(
            "the Uniswap v4 PoolManager could not pay native USDC to {target}: WrappedError with \
             selector 0x00000000 and NativeTransferFailed() is v4-core's Currency.transfer failing \
             a native payment{}. The PoolManager held less native USDC than it was asked to pay \
             out, or the recipient refused it; a smaller trade may succeed.",
            if reason.is_empty() {
                String::new()
            } else {
                format!(" (the recipient reverted with {reason})")
            }
        );
    }
    format!(
        "the Uniswap v4 PoolManager reverted with WrappedError: the call to {target} (function \
         selector {selector}) failed with {} and context {details}{}. The inner revert is in none \
         of this crate's ABIs{}; look up its selector. When the target is a pool's hook, this is \
         the hook refusing the swap.",
        if reason.is_empty() { "no data".to_owned() } else { reason.to_string() },
        details_name.map_or_else(String::new, |name| format!(" ({name})")),
        if reason.is_empty() { " (it is empty: an out-of-gas or a bare revert)" } else { "" }
    )
}

/// What a Solidity panic code means, in the words of the language reference.
fn panic_meaning(code: U256) -> &'static str {
    match code.to::<u64>() {
        0x00 => "a generic compiler-inserted panic",
        0x01 => "an assert() that was false",
        0x11 => "arithmetic overflowed or underflowed outside an unchecked block",
        0x12 => "a division or modulo by zero",
        0x21 => "a value converted to an enum was out of range",
        0x22 => "a storage byte array was incorrectly encoded",
        0x31 => "pop() on an empty array",
        0x32 => "an array index out of bounds",
        0x41 => "too much memory, or an array that is too large",
        0x51 => "a zero-initialised internal function variable was called",
        _ => "an unrecognised panic code",
    }
}

struct Entry {
    error: alloy::json_abi::Error,
    source_abi: &'static str,
}

/// Selector to error, built once from every pinned ABI.
fn registry() -> &'static HashMap<Selector, Entry> {
    static REGISTRY: OnceLock<HashMap<Selector, Entry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut map: HashMap<Selector, Entry> = HashMap::new();
        for (name, json) in ABIS {
            let abi: JsonAbi = serde_json::from_str(json).unwrap_or_else(|err| {
                panic!(
                    "src/generated/abi/{name}.json is a generated, pinned file and must parse as \
                     an ABI: {err}. Run ../scripts/sync-artifacts.sh and ../scripts/check-pins.sh."
                )
            });
            for error in abi.errors.into_values().flatten() {
                // First ABI to declare a selector wins. The order in ABIS puts
                // the contracts this SDK actually calls first, so a shared error
                // is attributed to the one a caller is most likely looking at.
                map.entry(error.selector()).or_insert(Entry { error, source_abi: name });
            }
        }
        map
    })
}

// ---------------------------------------------------------------------------
// mapping decoded bodies onto curated variants
// ---------------------------------------------------------------------------

fn u256_at(body: &[DynSolValue], index: usize) -> U256 {
    body.get(index).and_then(DynSolValue::as_uint).map_or(U256::ZERO, |(value, _)| value)
}

fn usdc_at(body: &[DynSolValue], index: usize) -> Usdc {
    Usdc::from_wad(u256_at(body, index))
}

fn tokens_at(body: &[DynSolValue], index: usize) -> Tokens {
    Tokens::from_wad(u256_at(body, index))
}

fn bps_at(body: &[DynSolValue], index: usize) -> Bps {
    Bps::of_fee(u32::try_from(u256_at(body, index)).unwrap_or(u32::MAX))
}

fn u64_at(body: &[DynSolValue], index: usize) -> u64 {
    u64::try_from(u256_at(body, index)).unwrap_or(u64::MAX)
}

fn address_at(body: &[DynSolValue], index: usize) -> Address {
    body.get(index).and_then(DynSolValue::as_address).unwrap_or(Address::ZERO)
}

/// Map a decoded error onto its curated variant, or onto
/// [`Error::NamedRevert`].
///
/// One flat dispatch table, deliberately. Splitting it by source contract would
/// hide the thing that makes it readable — that every error this SDK has an
/// opinion about is in one place, in one order, and anything missing falls
/// through the bottom.
#[allow(clippy::too_many_lines)]
fn curate(entry: &Entry, body: &[DynSolValue]) -> Error {
    let name = entry.error.name.as_str();
    match name {
        // launchpad
        "IncorrectPayment" => Error::IncorrectPayment {
            expected: usdc_at(body, 0),
            actual: usdc_at(body, 1),
            launch_fee: None,
            initial_buy: None,
        },
        "PlatformNotRegistered" => Error::PlatformNotRegistered { platform: address_at(body, 0) },
        "MigratorNotRegistered" => Error::MigratorNotRegistered { migrator: address_at(body, 0) },
        "InvalidLaunchParameters" => Error::InvalidLaunchParameters,
        "NoFeesToCollect" => Error::NoFeesToCollect,

        // curve
        "CurveGraduated" => Error::CurveGraduated,
        "NotGraduated" => Error::NotGraduated,
        "AlreadyMigrated" => Error::AlreadyMigrated,
        "ZeroAmount" => Error::ZeroAmount,
        "DeadlineExpired" => {
            Error::DeadlineExpired { deadline: u64_at(body, 0), timestamp: u64_at(body, 1) }
        }
        // `SlippageExceeded(uint256,uint256)` on the curve, which says by how
        // much. The v4 router's is `SlippageExceeded()` and says nothing, so it
        // gets its own variant rather than two invented zeros — see the guard.
        "SlippageExceeded" if body.len() == 2 => {
            Error::SlippageExceeded { min_out: u256_at(body, 0), actual_out: u256_at(body, 1) }
        }
        "SlippageExceeded" => Error::PoolSlippageExceeded,
        "InsufficientTokenBalance" => Error::InsufficientTokenBalance {
            seller: address_at(body, 0),
            balance: tokens_at(body, 1),
            amount: tokens_at(body, 2),
        },
        "ExceedsTokensSold" => {
            Error::ExceedsTokensSold { tokens_sold: tokens_at(body, 0), amount: tokens_at(body, 1) }
        }
        // `NothingToWithdraw()` on the curve; the fee hook's takes an address.
        "NothingToWithdraw" if body.is_empty() => Error::NothingToWithdraw,
        "TransferFailed" => {
            Error::TransferFailed { to: address_at(body, 0), amount: usdc_at(body, 1) }
        }
        "Reentrancy" => Error::Reentrancy,
        "ZeroAddress" => Error::ZeroAddress,
        "InvalidParameters" => Error::InvalidParameters,
        "QuoteAmountNotRepresentable" => Error::QuoteAmountNotRepresentable {
            amount_wad: u256_at(body, 0),
            quote_scale: u256_at(body, 1),
        },

        // fee config
        "InvalidFeeConfig" => Error::InvalidFeeConfig,
        "FeeSharesNotWhole" => Error::FeeSharesNotWhole { total: bps_at(body, 0) },
        "ShareExceedsDenominator" => Error::ShareExceedsDenominator { share: bps_at(body, 0) },
        "ZeroFeeRecipient" => Error::ZeroFeeRecipient,
        "FeeSharesExceedAllowance" => {
            let requested = bps_at(body, 0);
            let allowance = bps_at(body, 1);
            Error::FeeSharesExceedAllowance {
                creator: Bps::ZERO,
                ref_share: Bps::ZERO,
                dev: Bps::ZERO,
                requested,
                allowance,
                residual: format!("{} bps short", requested.get().saturating_sub(allowance.get())),
            }
        }

        // registries and admin roles
        "NotProtocolAdmin" => Error::NotProtocolAdmin { caller: address_at(body, 0) },
        "NotPendingProtocolAdmin" => Error::NotPendingProtocolAdmin { caller: address_at(body, 0) },
        "NotAdmin" => Error::NotAdmin { caller: address_at(body, 0) },
        "NotPendingAdmin" => Error::NotPendingAdmin { caller: address_at(body, 0) },
        "ProtocolShareOutOfBounds" => Error::ProtocolShareOutOfBounds {
            share: bps_at(body, 0),
            minimum: bps_at(body, 1),
            maximum: bps_at(body, 2),
        },
        "PlatformAlreadyDeregistered" => {
            Error::PlatformAlreadyDeregistered { platform: address_at(body, 0) }
        }

        // curve template
        "InitialPriceMismatch" => {
            Error::InitialPriceMismatch { expected: usdc_at(body, 0), actual: usdc_at(body, 1) }
        }
        "GraduationTargetMismatch" => {
            Error::GraduationTargetMismatch { expected: usdc_at(body, 0), actual: usdc_at(body, 1) }
        }
        "CurveNotPriceable" => {
            Error::CurveNotPriceable { curve_supply: tokens_at(body, 0), y0: tokens_at(body, 1) }
        }
        "InvalidSupplies" => Error::InvalidSupplies {
            total_supply: tokens_at(body, 0),
            curve_supply: tokens_at(body, 1),
        },
        "PoolReserveMismatch" => Error::PoolReserveMismatch {
            held_back: tokens_at(body, 0),
            required: tokens_at(body, 1),
        },

        // token
        "NotCurve" => Error::NotCurve { caller: address_at(body, 0) },
        "InsufficientAllowance" => Error::InsufficientAllowance {
            owner: address_at(body, 0),
            spender: address_at(body, 1),
            allowance: tokens_at(body, 2),
            needed: tokens_at(body, 3),
        },
        "InsufficientBalance" => Error::InsufficientBalance {
            holder: address_at(body, 0),
            balance: tokens_at(body, 1),
            needed: tokens_at(body, 2),
        },
        "TransferToZeroAddress" => Error::TransferToZeroAddress,
        "ApproveToZeroAddress" => Error::ApproveToZeroAddress,
        "PoolAlreadyRecorded" => Error::PoolAlreadyRecorded { pool: address_at(body, 0) },
        "NotCreator" => Error::NotCreator { caller: address_at(body, 0) },
        "NotPendingCreator" => Error::NotPendingCreator { caller: address_at(body, 0) },
        "PermitExpired" => Error::PermitExpired { deadline: u64_at(body, 0) },
        "InvalidPermitSignature" => Error::InvalidPermitSignature,

        // the v4 router
        "DeadlinePassed" => Error::PoolDeadlineExpired { deadline: u64_at(body, 0) },
        "SafeERC20FailedOperation" => Error::RouterCouldNotPullToken { token: address_at(body, 0) },

        _ => Error::NamedRevert {
            name: name.to_owned(),
            signature: entry.error.signature(),
            source_abi: entry.source_abi,
            arguments: body.iter().map(render).collect(),
        },
    }
}

/// Render a decoded argument for a message a human reads.
fn render(value: &DynSolValue) -> String {
    match value {
        DynSolValue::Address(address) => address.to_string(),
        DynSolValue::Uint(value, _) => value.to_string(),
        DynSolValue::Int(value, _) => value.to_string(),
        DynSolValue::Bool(value) => value.to_string(),
        DynSolValue::String(value) => format!("{value:?}"),
        DynSolValue::Bytes(bytes) => format!("0x{}", alloy::hex::encode(bytes)),
        DynSolValue::FixedBytes(bytes, size) => {
            format!("0x{}", alloy::hex::encode(&bytes[..*size]))
        }
        other => format!("{other:?}"),
    }
}
