//! Trading a token **after** it has graduated: the Uniswap v4 pool it landed
//! in, and one front door that knows which of the two venues a token is at.
//!
//! # Where the market went
//!
//! A curve retires permanently at its target and every further `buy` and `sell`
//! on it reverts with [`Error::CurveGraduated`]. The token is still tradeable —
//! its migrator seeded a Uniswap v4 pool with the collected quote and the unsold
//! inventory — but nothing about that pool is reachable through the curve. This
//! module is the other half.
//!
//! # A v4 pool has no address
//!
//! It is a `PoolId` inside **one** `PoolManager`'s storage. There is no pool
//! contract to call, no pair address to look up and nothing to pass around.
//! `ArcToken.migratedPool()` and the curve's `Migrated` event both return **the
//! `PoolManager` address**, identically for every token on a deployment. Read
//! it as *"has this token migrated, and into which manager"* and never as a
//! per-token pool. [`Trade::venue`] is that question asked properly.
//!
//! What identifies the market is the [`PoolKey`], and this crate **reads** it
//! from the token's own migrator rather than assembling one from constants.
//! Every field of a hard-coded key is a way to hash to a `PoolId` that does not
//! exist, which on this chain fails as `PoolNotInitialized()` — see
//! [`Error::PoolUnreachable`]. A graduated token's key is immutable, so it is
//! read once per client.
//!
//! # Either currency order, in raw units
//!
//! A pool pairs the token with its curve's quote: native USDC or an ERC-20 such
//! as EURC. Uniswap v4 sorts the two currencies, so `currency0 = min(quote,
//! token)` — always the quote for native USDC (`address(0)`), and **either one**
//! for an ERC-20 quote. [`quote_is_currency0`] says which; a buy swaps
//! [`zero_for_one`] exactly when the quote is `currency0`; the `BalanceDelta`
//! and `Swap` legs are picked by the same flag ([`quote_and_token_legs`]).
//!
//! **Pool amounts are raw units of each currency**, not wads: 1 EURC is
//! 1,000,000 in a `BalanceDelta`, a `Swap` log and the hook's own events. This
//! module converts them to [`QuoteAmount`] wads by the quote's scale, and sends
//! raw amounts to the router.
//!
//! # The router, and the two refusals
//!
//! arcnow.io stays on its **own** `PoolManager` and deploys its own
//! `UniswapV4Router04` against it; see [`crate::network::V4Addresses`]. The
//! router's address is `contracts.v4Router`:
//!
//! * **no router configured** — every quote and trade refuses with
//!   [`Error::NoRouterDeployed`], before any RPC.
//! * **a router configured** — its immutable `poolManager()` is read (once per
//!   client) and compared with the token's migrator's. Equal, and the pool is
//!   traded; different, and it is refused with [`Error::PoolUnreachable`].
//!
//! [`Pool::is_reachable`] asks the same question without raising.
//!
//! # There is no quoter on this chain, so a quote is a simulated swap
//!
//! A quote is an `eth_call` of the **real swap**, against the router, read back
//! as the `BalanceDelta` it returns — the trader's own delta, with the hook's
//! 1% already inside it. The call needs state it does not have, and gets it from
//! **`eth_call` state overrides**:
//!
//! * a **native** buy is quoted from a probe account given the value to pay;
//! * an **ERC-20** buy is quoted from a real buyer who holds the quote. Its
//!   balance is never overridden; its allowance to the router is overridden
//!   through `networks.json`'s `quoteTokens[].allowanceSlot` when that slot is
//!   known, and otherwise the buyer must already have approved the router;
//! * a sell is quoted from the seller, with the token allowance overridden at
//!   [`ARC_TOKEN_ALLOWANCE_SLOT`].
//!
//! # The 1% is charged in the quote, inside the swap
//!
//! `ArcNowFeeHook` takes 1% of the **gross quote leg** of every swap, in raw
//! units of the quote, and books it as a `PoolManager` claim paid out five ways
//! later. Because it is already inside the delta the router returns, a quote
//! does not add it on: the fee is *derived* from the quote by the identity for
//! that side, on raw units as the hook computes it. See
//! [`buy_fee_from_quote_in`] and [`sell_fee_from_quote_out`].
//!
//! # Buying with an ERC-20 quote needs an allowance; selling always does
//!
//! The router pulls an ERC-20 input with `transferFrom`. So an ERC-20 pool buy
//! first makes sure the buyer's allowance to the router covers the amount
//! ([`crate::QuoteToken::ensure_allowance`], an exact approval only when short)
//! and swaps with no value; a native buy pays `msg.value`. A pool **sell** pulls
//! the token leg, so a seller must approve the router first —
//! [`Pool::approve_router`] — and [`Pool::sell`] refuses without it.
//! `ArcToken.canonicalRouter()` is `address(0)` on every arcnow.io token.

use core::fmt;

use alloy::network::Ethereum;
use alloy::primitives::aliases::{I24, U24};
use alloy::primitives::{Address, B256, Bytes, I256, U256, address, keccak256};
use alloy::providers::{DynProvider, PendingTransactionBuilder};
use alloy::rpc::types::state::{StateOverride, StateOverridesBuilder};
use alloy::rpc::types::{Log, TransactionReceipt};
use alloy::sol_types::SolEvent;

use crate::amount::{Bps, QuoteAmount, QuoteTokenInfo, Tokens};
use crate::bindings::fee_hook::ArcNowFeeHook as HookAbi;
use crate::bindings::pool_manager::IPoolManager;
use crate::bindings::router::UniswapV4Router04 as RouterAbi;
use crate::bindings::token::ArcToken as TokenAbi;
use crate::bindings::v4_migrator::UniswapV4Migrator as MigratorAbi;
use crate::client::{Client, cached, remember};
use crate::curve::{BuyQuote, BuyRequest, BuyResult, Curve, SellQuote, SellRequest, SellResult};
use crate::curve_math;
use crate::deadline::Deadline;
use crate::error::Error;
use crate::quote::Batch;

// ---------------------------------------------------------------------------
// constants and the pure arithmetic
// ---------------------------------------------------------------------------

/// The fee `ArcNowFeeHook` takes out of every swap, in basis points of the
/// **gross quote leg**. 1%, the same rate the curve charges, and not
/// configurable.
pub const POOL_TRADE_FEE_BPS: Bps = Bps::of_trade(100);

/// The storage slot of `ArcToken._allowance`.
///
/// From `forge inspect ArcToken storage` at the pinned contracts commit: slot 0
/// `name`, 1 `symbol`, 2 `metadataURI`, 3 `totalSupply`, 4 `creator`, 5
/// `pendingCreator`, 6 `migratedPool`+`poolTaxMode`, 7 `migrator`, 8
/// `canonicalRouter`, 9 `balanceOf`, 10 `nonces`, **11 `_allowance`**. Pinned by
/// `tests/pool_fork.rs`, which overrides the slot on a fork and reads
/// `allowance()` back through the ABI.
pub const ARC_TOKEN_ALLOWANCE_SLOT: u64 = 11;

/// The account a **native** buy is quoted from when nobody in particular is
/// asking. Its code is overridden to empty in the same call.
const QUOTE_PROBE: Address = address!("0x00000000000000000000000000000000000ac0de");

/// Native USDC handed to a quoting account for gas: an override, not a
/// transfer.
fn quote_gas_headroom() -> U256 {
    U256::from(10_000_000_000_000_000_000_u128)
}

/// Split a Uniswap v4 `BalanceDelta` into its two signed halves,
/// `(amount0, amount1)`.
///
/// A `BalanceDelta` is one packed `int256`: `amount0 = int128(delta >> 128)` and
/// `amount1 = int128(delta)`, **both two's-complement `int128`**, in **raw
/// units** of each currency. The sign is the trader's: negative is paid,
/// positive is received. Which half is the quote depends on the pool's
/// currency order; see [`quote_and_token_legs`].
///
/// ```
/// use arcnow_sdk::alloy::primitives::I256;
/// use arcnow_sdk::pool::unpack_balance_delta;
///
/// // amount0 = -1, amount1 = +2: the low 128 bits are 2, the high are -1.
/// let packed = (I256::MINUS_ONE << 128) | I256::unchecked_from(2);
/// assert_eq!(unpack_balance_delta(packed), (-1, 2));
/// ```
#[must_use]
pub fn unpack_balance_delta(delta: I256) -> (i128, i128) {
    let bytes = delta.into_raw().to_be_bytes::<32>();
    let mut high = [0_u8; 16];
    let mut low = [0_u8; 16];
    high.copy_from_slice(&bytes[..16]);
    low.copy_from_slice(&bytes[16..]);
    (i128::from_be_bytes(high), i128::from_be_bytes(low))
}

/// True when `quote` sorts below `token`, making it the pool's `currency0`.
/// Always true for native USDC, the zero address.
#[must_use]
pub fn quote_is_currency0(quote: Address, token: Address) -> bool {
    quote < token
}

/// A pool's `(currency0, currency1)` for `quote` and `token`: the two sorted.
#[must_use]
pub fn pool_currencies(quote: Address, token: Address) -> (Address, Address) {
    if quote_is_currency0(quote, token) { (quote, token) } else { (token, quote) }
}

/// The swap direction: a buy pays the quote, so it goes zero-for-one exactly
/// when the quote is `currency0`; a sell the other way.
#[must_use]
pub const fn zero_for_one(buy: bool, quote_is_currency0: bool) -> bool {
    buy == quote_is_currency0
}

/// A `BalanceDelta`'s `(quote, token)` legs, picked by the pool's currency
/// order. Both are raw units of their currency, signed from the trader's side.
#[must_use]
pub fn quote_and_token_legs(delta: I256, quote_is_currency0: bool) -> (i128, i128) {
    let (amount0, amount1) = unpack_balance_delta(delta);
    if quote_is_currency0 { (amount0, amount1) } else { (amount1, amount0) }
}

/// The storage slot holding `allowance(owner, spender)` in a Solidity
/// `mapping(address => mapping(address => uint256))` laid out at `slot`:
/// `keccak256(spender ‖ keccak256(owner ‖ slot))`, every element left-padded to
/// 32 bytes.
///
/// The layout of `ArcToken` ([`ARC_TOKEN_ALLOWANCE_SLOT`]) and of `FiatToken`'s
/// `allowed` (EURC, slot 10, as `networks.json` records it).
#[must_use]
pub fn erc20_allowance_slot(owner: Address, spender: Address, slot: U256) -> B256 {
    let inner = mapping_slot(owner.into_word(), B256::from(slot));
    mapping_slot(spender.into_word(), inner)
}

/// The storage slot holding `allowance(owner, spender)` on an `ArcToken`.
///
/// This exists so a **sell can be quoted before it has been approved**. The
/// override is confined to the simulation; [`Pool::sell`] reads the real
/// allowance and refuses without one.
///
/// ```
/// use arcnow_sdk::alloy::primitives::address;
/// use arcnow_sdk::pool::arc_token_allowance_slot;
///
/// let owner = address!("0x1111111111111111111111111111111111111111");
/// let spender = address!("0x2222222222222222222222222222222222222222");
/// // `cast index address 0x2222… $(cast index address 0x1111… 11)`
/// assert_eq!(
///     arc_token_allowance_slot(owner, spender).to_string(),
///     "0x1fea054c7d0690543ba713a5c01750aeaa4f1a8a691692b98c3791549f750066"
/// );
/// ```
#[must_use]
pub fn arc_token_allowance_slot(owner: Address, spender: Address) -> B256 {
    erc20_allowance_slot(owner, spender, U256::from(ARC_TOKEN_ALLOWANCE_SLOT))
}

/// `keccak256(key ‖ slot)`, the address of one element of a Solidity mapping.
fn mapping_slot(key: B256, slot: B256) -> B256 {
    let mut buffer = [0_u8; 64];
    buffer[..32].copy_from_slice(key.as_slice());
    buffer[32..].copy_from_slice(slot.as_slice());
    keccak256(buffer)
}

/// `raw * scale` in `quote`. Raw pool amounts are bounded by `int128`, so this
/// cannot overflow for any real pool; a value that did would saturate.
fn from_raw(quote: &QuoteTokenInfo, raw: U256) -> QuoteAmount {
    QuoteAmount::from_wad_in(quote, raw.saturating_mul(quote.scale()))
}

/// The raw units of `amount`, floored.
fn raw_floor(amount: &QuoteAmount) -> U256 {
    amount.to_wad() / amount.token().scale()
}

/// The hook's fee on a **buy**, derived from what the trader pays.
///
/// On an exact-input buy the quote leg the trader names *is* the gross: the hook
/// takes its cut in `beforeSwap`. Computed on **raw units**, as the hook does:
/// `fee_raw = raw_in * 100 / 10_000`, floored, then scaled back to a wad.
#[must_use]
pub fn buy_fee_from_quote_in(quote_in: &QuoteAmount) -> QuoteAmount {
    let fee_raw = raw_floor(quote_in) * POOL_TRADE_FEE_BPS.to_u256() / U256::from(Bps::DENOMINATOR);
    from_raw(quote_in.token(), fee_raw)
}

/// The gross quote a **sell** moved out of the pool, derived from what the
/// trader received: `gross_raw = raw_out * 10_000 / 9_900`, on raw units.
#[must_use]
pub fn sell_gross_from_quote_out(quote_out: &QuoteAmount) -> QuoteAmount {
    let gross_raw = raw_floor(quote_out) * U256::from(Bps::DENOMINATOR)
        / U256::from(Bps::DENOMINATOR - POOL_TRADE_FEE_BPS.get());
    from_raw(quote_out.token(), gross_raw)
}

/// An **estimate** of what a sell paid the trader, from the fee the hook logged
/// and nothing else — a lower bound, never the figure a fill reports:
/// `raw_fee * 9_900 / 100`, on raw units.
///
/// [`Pool::sell`] does not use this: it reads the payout exactly, out of the
/// `PoolManager`'s `Swap` log. **Up to 99 raw units under the truth.**
#[must_use]
pub fn sell_quote_out_from_fee(fee: &QuoteAmount) -> QuoteAmount {
    let out_raw = raw_floor(fee) * U256::from(Bps::DENOMINATOR - POOL_TRADE_FEE_BPS.get())
        / POOL_TRADE_FEE_BPS.to_u256();
    from_raw(fee.token(), out_raw)
}

/// The hook's fee on a **sell**, derived from what the trader received:
/// `gross_raw * 100 / 10_000` where `gross_raw` is
/// [`sell_gross_from_quote_out`]'s. The two steps are separate because the
/// rounding happens in both.
#[must_use]
pub fn sell_fee_from_quote_out(quote_out: &QuoteAmount) -> QuoteAmount {
    let gross_raw = raw_floor(&sell_gross_from_quote_out(quote_out));
    from_raw(
        quote_out.token(),
        gross_raw * POOL_TRADE_FEE_BPS.to_u256() / U256::from(Bps::DENOMINATOR),
    )
}

// ---------------------------------------------------------------------------
// the venue, and what identifies a pool
// ---------------------------------------------------------------------------

/// Which of the two markets a token trades at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Venue {
    /// The bonding curve.
    Curve,
    /// The Uniswap v4 pool the token graduated into.
    Pool,
}

impl fmt::Display for Venue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Curve => f.write_str("bonding curve"),
            Self::Pool => f.write_str("Uniswap v4 pool"),
        }
    }
}

/// The five fields that identify a Uniswap v4 market.
///
/// **Read from the token's migrator, never assembled from constants.**
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PoolKey {
    /// The lower-sorted currency: the quote or the token, whichever address is
    /// lower. Native USDC (`address(0)`) always sorts first.
    pub currency0: Address,
    /// The higher-sorted currency.
    pub currency1: Address,
    /// The pool's LP fee, in hundredths of a basis point (`3000` is 0.30%).
    /// **Not** the arcnow.io fee, which is the hook's and is charged separately.
    pub fee: u32,
    /// The tick spacing the pool was initialised with.
    pub tick_spacing: i32,
    /// `ArcNowFeeHook`, which takes the 1% in the quote inside the swap.
    pub hooks: Address,
}

impl PoolKey {
    /// True when `currency0` is native USDC.
    #[must_use]
    pub fn has_native_quote(&self) -> bool {
        self.currency0.is_zero()
    }

    /// The currency this key pairs `token` with — the quote — or `None` when
    /// the key does not hold `token` at all.
    #[must_use]
    pub fn quote_currency(&self, token: Address) -> Option<Address> {
        if self.currency0 == token {
            Some(self.currency1)
        } else if self.currency1 == token {
            Some(self.currency0)
        } else {
            None
        }
    }

    /// True when the quote is `currency0`, which is to say `token` is
    /// `currency1`.
    #[must_use]
    pub fn quote_is_currency0(&self, token: Address) -> bool {
        self.currency1 == token
    }

    fn from_abi(key: &MigratorAbi::PoolKey) -> Self {
        Self {
            currency0: key.currency0,
            currency1: key.currency1,
            fee: key.fee.to::<u32>(),
            tick_spacing: i24_to_i32(key.tickSpacing),
            hooks: key.hooks,
        }
    }

    fn to_router_abi(self) -> RouterAbi::PoolKey {
        RouterAbi::PoolKey {
            currency0: self.currency0,
            currency1: self.currency1,
            fee: U24::from(self.fee),
            tickSpacing: I24::unchecked_from(self.tick_spacing),
            hooks: self.hooks,
        }
    }
}

/// Sign-extend a 24-bit two's-complement integer into an `i32`.
fn i24_to_i32(value: I24) -> i32 {
    let raw = value.into_raw().to::<u32>();
    if raw & 0x0080_0000 == 0 { raw.cast_signed() } else { (raw | 0xFF00_0000).cast_signed() }
}

// ---------------------------------------------------------------------------
// quotes, requests and results
// ---------------------------------------------------------------------------

/// A priced buy in the pool, as the router would fill it right now. Amounts
/// are in the pool's quote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolBuyQuote {
    /// Quote the buyer pays, fee inclusive.
    pub quote_in: QuoteAmount,
    /// Tokens the buyer receives.
    pub tokens_out: Tokens,
    /// The hook's 1%, already inside this quote rather than added to it. See
    /// [`buy_fee_from_quote_in`].
    pub fee_quote: QuoteAmount,
}

impl PoolBuyQuote {
    /// Where this quote came from. Always [`Venue::Pool`].
    #[must_use]
    pub const fn venue(&self) -> Venue {
        Venue::Pool
    }

    /// A slippage floor `tolerance` below this quote's `tokens_out`.
    #[must_use]
    pub fn min_tokens_out(&self, tolerance: Bps) -> Tokens {
        self.tokens_out.less_tolerance(tolerance)
    }
}

/// A priced sell in the pool, as the router would fill it right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolSellQuote {
    /// Tokens the seller offers. The router pulls these with `transferFrom`.
    pub tokens_in: Tokens,
    /// Quote the seller receives, **net of the hook's fee**.
    pub quote_out: QuoteAmount,
    /// The hook's 1% of the gross the pool paid out. See
    /// [`sell_fee_from_quote_out`].
    pub fee_quote: QuoteAmount,
}

impl PoolSellQuote {
    /// Where this quote came from. Always [`Venue::Pool`].
    #[must_use]
    pub const fn venue(&self) -> Venue {
        Venue::Pool
    }

    /// A slippage floor `tolerance` below this quote's `quote_out`.
    #[must_use]
    pub fn min_quote_out(&self, tolerance: Bps) -> QuoteAmount {
        self.quote_out.less_tolerance(tolerance)
    }
}

/// What a pool trade actually did, **exact to the raw unit**.
///
/// Every figure is read out of **this transaction's own logs**:
///
/// * `tokens` — summed from the **token's own `Transfer` logs**: into the
///   receiver on a buy, out of the payer on a sell.
/// * `fee_quote` — the `feeAmount` of every `ArcNowFeeHook.HookFeeTaken` from
///   the pool key's hook, for this pool's `PoolId`, **in the pool's quote
///   currency**, scaled to a wad.
/// * `quote` — the `PoolManager`'s own `Swap` log for this `PoolId`, the quote
///   leg picked by currency order, with that fee put back:
///   `|Σ Swap.quoteLeg − Σ feeAmount|`, scaled to a wad.
///
/// `Swap` is emitted with the **pool's** delta before `afterSwap` folds the
/// hook's in, and signed from the swapper's side; the hook takes its fee in the
/// quote currency as a positive delta in all four swap shapes. So on a buy the
/// pool swapped `quote − fee` and on a sell it paid out the gross and the hook
/// kept `fee`. `tests/pool_fork.rs` checks the figures against balances.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolTradeResult {
    /// Quote: spent on a buy, received on a sell.
    pub quote: QuoteAmount,
    /// Tokens: received on a buy, sold on a sell.
    pub tokens: Tokens,
    /// The hook's 1%, as it was charged in this transaction. Accrued as a
    /// `PoolManager` claim and paid out later; see [`Pool::accrued_hook_fee`].
    pub fee_quote: QuoteAmount,
    /// Fees charged by **earlier** transactions that this trade's swap paid out,
    /// from the hook's `FeesDistributed` log for this pool and quote. Not paid
    /// by the trader.
    pub fees_distributed: QuoteAmount,
    /// The transaction.
    pub tx_hash: B256,
    /// The exact approval an ERC-20 buy sent first, when the router's allowance
    /// did not already cover it. `None` otherwise.
    pub approval_tx_hash: Option<B256>,
}

impl PoolTradeResult {
    /// Where this trade happened. Always [`Venue::Pool`].
    #[must_use]
    pub const fn venue(&self) -> Venue {
        Venue::Pool
    }
}

/// A buy in the pool, spelled out.
///
/// Unlike a [`BuyRequest`] it pays a named receiver, credits nobody, cannot
/// graduate anything, and takes its deadline at construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolBuyRequest {
    /// Quote to spend, fee inclusive, in the pool's quote token. Sent as value
    /// for native USDC; pulled by the router for an ERC-20.
    pub quote_in: QuoteAmount,
    /// The slippage floor. **Required, not optional**.
    pub min_tokens_out: Tokens,
    /// When this swap stops being acceptable. **Required.**
    pub deadline: Deadline,
    /// Who receives the tokens, or `None` for the sender.
    pub recipient: Option<Address>,
    /// An explicit gas limit, or `None` to let the node estimate one.
    pub gas_limit: Option<u64>,
}

impl PoolBuyRequest {
    /// A buy of `quote_in` with a floor of `min_tokens_out`, expiring at
    /// `deadline`, paying the sender.
    #[must_use]
    pub fn new(quote_in: QuoteAmount, min_tokens_out: Tokens, deadline: Deadline) -> Self {
        Self { quote_in, min_tokens_out, deadline, recipient: None, gas_limit: None }
    }

    /// Send the tokens somewhere other than the sender.
    #[must_use]
    pub fn recipient(mut self, recipient: Address) -> Self {
        self.recipient = Some(recipient);
        self
    }

    /// Replace the deadline.
    #[must_use]
    pub fn deadline(mut self, deadline: Deadline) -> Self {
        self.deadline = deadline;
        self
    }

    /// Send with an explicit gas limit.
    #[must_use]
    pub fn gas_limit(mut self, limit: u64) -> Self {
        self.gas_limit = Some(limit);
        self
    }
}

/// A sell in the pool, spelled out. **This one needs an approval** — see
/// [`Pool::approve_router`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolSellRequest {
    /// Tokens to sell. The router pulls them with `transferFrom`.
    pub tokens_in: Tokens,
    /// The slippage floor, net of the hook's fee, in the pool's quote. Floored
    /// to a whole raw unit before it is sent.
    pub min_quote_out: QuoteAmount,
    /// When this swap stops being acceptable. **Required.**
    pub deadline: Deadline,
    /// Who receives the quote, or `None` for the sender.
    pub recipient: Option<Address>,
    /// An explicit gas limit, or `None` to let the node estimate one.
    pub gas_limit: Option<u64>,
}

impl PoolSellRequest {
    /// A sell of `tokens_in` with a floor of `min_quote_out`, expiring at
    /// `deadline`, paying the sender.
    #[must_use]
    pub fn new(tokens_in: Tokens, min_quote_out: QuoteAmount, deadline: Deadline) -> Self {
        Self { tokens_in, min_quote_out, deadline, recipient: None, gas_limit: None }
    }

    /// Send the quote somewhere other than the sender.
    #[must_use]
    pub fn recipient(mut self, recipient: Address) -> Self {
        self.recipient = Some(recipient);
        self
    }

    /// Replace the deadline.
    #[must_use]
    pub fn deadline(mut self, deadline: Deadline) -> Self {
        self.deadline = deadline;
        self
    }

    /// Send with an explicit gas limit.
    #[must_use]
    pub fn gas_limit(mut self, limit: u64) -> Self {
        self.gas_limit = Some(limit);
        self
    }
}

// ---------------------------------------------------------------------------
// the pool handle
// ---------------------------------------------------------------------------

/// What identifies one graduated token's pool, read off its migrator. Needs no
/// router, and never changes once the token has migrated, so it is cached.
#[derive(Debug, Clone)]
pub(crate) struct Market {
    key: PoolKey,
    pool_id: B256,
    pool_manager: Address,
    quote: QuoteTokenInfo,
    quote_is_currency0: bool,
}

/// A market plus the router that would trade it.
#[derive(Debug, Clone)]
struct Resolved {
    market: Market,
    router: Address,
    router_pool_manager: Address,
}

impl Resolved {
    fn reachable(&self) -> bool {
        self.market.pool_manager == self.router_pool_manager
    }
}

/// One graduated token's Uniswap v4 market. Get one with [`Client::pool`].
#[derive(Debug, Clone, Copy)]
pub struct Pool<'a> {
    client: &'a Client,
    token: Address,
}

impl<'a> Pool<'a> {
    pub(crate) fn new(client: &'a Client, token: Address) -> Self {
        Self { client, token }
    }

    /// The token this pool trades.
    #[must_use]
    pub fn token(&self) -> Address {
        self.token
    }

    fn provider(&self) -> &DynProvider {
        self.client.provider()
    }

    fn token_contract(&self) -> TokenAbi::ArcTokenInstance<DynProvider> {
        TokenAbi::new(self.token, self.provider().clone())
    }

    /// The router this SDK swaps through on this network: `contracts.v4Router`.
    ///
    /// # Errors
    /// [`Error::NoRouterDeployed`] when the network names none.
    pub fn router(&self) -> Result<Address, Error> {
        self.client.network().v4_router()
    }

    /// The migrator this token's curve snapshotted at launch.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn migrator(&self) -> Result<Address, Error> {
        self.token_contract()
            .migrator()
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a token's migrator"))
    }

    /// The token's [`PoolKey`], read from its migrator (once per client).
    ///
    /// # Errors
    /// [`Error::TokenNotMigrated`] while the token still trades on its curve;
    /// [`Error::UnknownCurveVersion`] for a migrator that is not
    /// `arcnow/uniswap-v4-migrator@2.x.x`; [`Error::Rpc`].
    pub async fn key(&self) -> Result<PoolKey, Error> {
        Ok(self.market().await?.key)
    }

    /// The token's `PoolId`, read from its migrator.
    ///
    /// # Errors
    /// As [`Pool::key`].
    pub async fn pool_id(&self) -> Result<B256, Error> {
        Ok(self.market().await?.pool_id)
    }

    /// The `PoolManager` whose storage holds this pool.
    ///
    /// # Errors
    /// As [`Pool::key`].
    pub async fn pool_manager(&self) -> Result<Address, Error> {
        Ok(self.market().await?.pool_manager)
    }

    /// The quote this pool pairs the token with: the key's other currency, with
    /// its metadata from `networks.json` or this client's cache.
    ///
    /// # Errors
    /// As [`Pool::key`], and [`Error::Abi`] for a key that does not hold the
    /// token.
    pub async fn quote_token(&self) -> Result<QuoteTokenInfo, Error> {
        Ok(self.market().await?.quote)
    }

    /// True when the quote is the pool's `currency0`.
    ///
    /// # Errors
    /// As [`Pool::quote_token`].
    pub async fn quote_is_currency0(&self) -> Result<bool, Error> {
        Ok(self.market().await?.quote_is_currency0)
    }

    /// Whether this network's router can reach this pool.
    ///
    /// `Ok(false)` without any RPC when no router is configured.
    ///
    /// # Errors
    /// With a router configured: [`Error::TokenNotMigrated`]; [`Error::Rpc`].
    pub async fn is_reachable(&self) -> Result<bool, Error> {
        let Some(router) = self.client.network().contracts.v4_router else {
            return Ok(false);
        };
        Ok(self.resolve(router).await?.reachable())
    }

    /// Price a buy of `quote_in` without executing it.
    ///
    /// A native buy is quoted from a probe account. An ERC-20 buy needs a buyer
    /// who holds the quote, and is quoted as this client's sender; see
    /// [`Pool::quote_buy_as`] to name one.
    ///
    /// # Errors
    /// As [`Pool::quote_buy_as`], and [`Error::InvalidArgument`] for an ERC-20
    /// pool on a client with no sender.
    pub async fn quote_buy(&self, quote_in: QuoteAmount) -> Result<PoolBuyQuote, Error> {
        self.quote_buy_from(quote_in, None).await
    }

    /// Price a buy of `quote_in` by `buyer` without executing it.
    ///
    /// An `eth_call` of the real swap against the router, read back as the
    /// trader's own `BalanceDelta`. On an ERC-20 pool the buyer's quote balance
    /// is **never** overridden — `buyer` must hold `quote_in` — and its
    /// allowance to the router is overridden only when `networks.json` records
    /// the quote's `allowanceSlot`; without one, `buyer` must already have
    /// approved the router. On a native pool `buyer` is ignored and a probe
    /// account is given the value.
    ///
    /// # Errors
    /// [`Error::ZeroAmount`]; [`Error::QuoteAmountNotRepresentable`], before
    /// any RPC; [`Error::NoRouterDeployed`]; [`Error::TokenNotMigrated`];
    /// [`Error::PoolUnreachable`]; [`Error::QuoteTokenMismatch`] for an amount in
    /// another quote; anything the swap itself reverts with, decoded.
    pub async fn quote_buy_as(
        &self,
        quote_in: QuoteAmount,
        buyer: Address,
    ) -> Result<PoolBuyQuote, Error> {
        self.quote_buy_from(quote_in, Some(buyer)).await
    }

    async fn quote_buy_from(
        &self,
        quote_in: QuoteAmount,
        buyer: Option<Address>,
    ) -> Result<PoolBuyQuote, Error> {
        if quote_in.is_zero() {
            return Err(Error::ZeroAmount);
        }
        let raw = quote_in.to_raw()?;
        let resolved = self.reachable_or_refuse().await?;
        let market = &resolved.market;
        market.quote.require_same(quote_in.token())?;

        let (caller, value, overrides) = if market.quote.is_native {
            let overrides = StateOverridesBuilder::default()
                .with_balance(QUOTE_PROBE, raw + quote_gas_headroom())
                .with_code(QUOTE_PROBE, Bytes::new())
                .build();
            (QUOTE_PROBE, raw, overrides)
        } else {
            let buyer = buyer.or(self.client.sender()).ok_or_else(|| Error::InvalidArgument {
                reason: format!(
                    "a buy in {}'s pool pays {} from a real account, and a quote is simulated \
                     from one: name the buyer with Pool::quote_buy_as, or give the client a sender",
                    self.token, market.quote.symbol
                ),
            })?;
            let mut builder =
                StateOverridesBuilder::default().with_balance(buyer, quote_gas_headroom());
            if let Some(slot) = self.client.network().quote_allowance_slot(market.quote.address) {
                builder = builder.with_state_diff(
                    market.quote.address,
                    [(erc20_allowance_slot(buyer, resolved.router, slot), B256::from(U256::MAX))],
                );
            }
            (buyer, U256::ZERO, builder.build())
        };
        let delta = self
            .simulate(
                &resolved,
                raw,
                zero_for_one(true, market.quote_is_currency0),
                caller,
                value,
                overrides,
            )
            .await?;

        let (quote_leg, token_leg) = quote_and_token_legs(delta, market.quote_is_currency0);
        let paid = leg_paid(quote_leg, "the quote leg of a buy")?;
        let received = leg_received(token_leg, "the token leg of a buy")?;
        let quote_in = from_raw(&market.quote, paid);
        Ok(PoolBuyQuote {
            fee_quote: buy_fee_from_quote_in(&quote_in),
            quote_in,
            tokens_out: Tokens::from_wad(received),
        })
    }

    /// Price a sell of `tokens_in` by `seller` without executing it.
    ///
    /// `seller` must hold the tokens; the token **allowance** is supplied as a
    /// state override, so a sell can be quoted before it has been approved.
    ///
    /// # Errors
    /// [`Error::ZeroAmount`]; [`Error::NoRouterDeployed`];
    /// [`Error::TokenNotMigrated`]; [`Error::PoolUnreachable`];
    /// [`Error::InsufficientBalance`]; anything else the swap reverts with.
    pub async fn quote_sell(
        &self,
        tokens_in: Tokens,
        seller: Address,
    ) -> Result<PoolSellQuote, Error> {
        if tokens_in.is_zero() {
            return Err(Error::ZeroAmount);
        }
        let resolved = self.reachable_or_refuse().await?;
        let market = &resolved.market;
        let overrides = StateOverridesBuilder::default()
            .with_balance(seller, quote_gas_headroom())
            .with_state_diff(
                self.token,
                [(arc_token_allowance_slot(seller, resolved.router), B256::from(U256::MAX))],
            )
            .build();
        let delta = self
            .simulate(
                &resolved,
                tokens_in.to_wad(),
                zero_for_one(false, market.quote_is_currency0),
                seller,
                U256::ZERO,
                overrides,
            )
            .await?;

        let (quote_leg, token_leg) = quote_and_token_legs(delta, market.quote_is_currency0);
        let received = leg_received(quote_leg, "the quote leg of a sell")?;
        let paid = leg_paid(token_leg, "the token leg of a sell")?;
        let quote_out = from_raw(&market.quote, received);
        Ok(PoolSellQuote {
            tokens_in: Tokens::from_wad(paid),
            fee_quote: sell_fee_from_quote_out(&quote_out),
            quote_out,
        })
    }

    /// Buy tokens out of the pool with its quote.
    ///
    /// Native USDC: `request.quote_in` is the transaction's value. An ERC-20
    /// quote: the router's allowance is topped up with an exact approval only
    /// when short, and the swap sends no value. The router is sent raw units.
    ///
    /// # Errors
    /// Before any RPC: [`Error::SignerRequired`], [`Error::ZeroAmount`],
    /// [`Error::QuoteAmountNotRepresentable`]. Then
    /// [`Error::NoRouterDeployed`]; [`Error::TokenNotMigrated`];
    /// [`Error::PoolUnreachable`]; [`Error::QuoteTokenMismatch`];
    /// [`Error::PoolSlippageExceeded`]; [`Error::PoolDeadlineExpired`].
    pub async fn buy(&self, request: PoolBuyRequest) -> Result<PoolTradeResult, Error> {
        let from = self.client.require_signer("Pool::buy")?;
        if request.quote_in.is_zero() {
            return Err(Error::ZeroAmount);
        }
        let raw = request.quote_in.to_raw()?;
        let resolved = self.reachable_or_refuse().await?;
        let market = &resolved.market;
        market.quote.require_same(request.quote_in.token())?;
        let receiver = request.recipient.unwrap_or(from);

        let (value, approval_tx_hash) = if market.quote.is_native {
            (raw, None)
        } else {
            let (resolved_ref, request_ref) = (&resolved, &request);
            let preflight = move || async move {
                let market = &resolved_ref.market;
                let Some(overrides) = crate::quote::allowance_override(
                    self.client,
                    &market.quote,
                    from,
                    resolved_ref.router,
                ) else {
                    return Ok(());
                };
                self.router_contract(resolved_ref)
                    .swapExactTokensForTokens(
                        raw,
                        request_ref.min_tokens_out.to_wad(),
                        zero_for_one(true, market.quote_is_currency0),
                        market.key.to_router_abi(),
                        Bytes::new(),
                        receiver,
                        request_ref.deadline.to_u256(),
                    )
                    .from(from)
                    .state(overrides)
                    .call()
                    .await
                    .map(|_| ())
                    .map_err(|err| {
                        Error::from_contract(err, "simulating a pool buy before approving it")
                    })
            };
            let approval = self
                .client
                .quote_token_for(market.quote.clone())
                .ensure_allowance_after(resolved.router, &request.quote_in, preflight)
                .await?;
            (U256::ZERO, approval.tx_hash)
        };
        let router = self.router_contract(&resolved);
        let call = router
            .swapExactTokensForTokens(
                raw,
                request.min_tokens_out.to_wad(),
                zero_for_one(true, market.quote_is_currency0),
                market.key.to_router_abi(),
                Bytes::new(),
                receiver,
                request.deadline.to_u256(),
            )
            .from(from)
            .value(value);
        let call = if market.quote.is_native {
            match request.gas_limit {
                Some(limit) => call.gas(limit),
                None => call,
            }
        } else {
            let gas = crate::quote::erc20_trade_gas(
                &call,
                request.gas_limit,
                &market.quote,
                "sending a pool buy",
                crate::quote::with_pool_quote_transfer_headroom,
            )
            .await?;
            call.gas(gas)
        };
        let pending = call.send().await.map_err(|err| {
            Error::from_contract(err, "sending a pool buy").on_erc20_quote(&market.quote, None)
        })?;
        let receipt = mined(pending, "the pool buy").await?;

        let tokens = self.tokens_moved(&receipt, |log| log.to == receiver)?;
        let (quote, fee_quote) = fill_from_receipt(&receipt, &resolved, Side::Buy)?;
        Ok(PoolTradeResult {
            quote,
            tokens,
            fee_quote,
            fees_distributed: fees_distributed_from_logs(receipt.inner.logs(), market),
            tx_hash: receipt.transaction_hash,
            approval_tx_hash,
        })
    }

    /// Sell tokens into the pool for its quote.
    ///
    /// **Needs an approval**: the router pulls the tokens with `transferFrom`,
    /// and a missing one is [`Error::RouterApprovalRequired`] before anything is
    /// sent. The floor is rounded up to a whole raw unit of the quote, so the
    /// trade never accepts less than was named.
    ///
    /// # Errors
    /// [`Error::SignerRequired`]; [`Error::ZeroAmount`];
    /// [`Error::NoRouterDeployed`]; [`Error::TokenNotMigrated`];
    /// [`Error::PoolUnreachable`]; [`Error::QuoteTokenMismatch`];
    /// [`Error::RouterApprovalRequired`]; [`Error::PoolSlippageExceeded`];
    /// [`Error::PoolDeadlineExpired`].
    pub async fn sell(&self, request: PoolSellRequest) -> Result<PoolTradeResult, Error> {
        let from = self.client.require_signer("Pool::sell")?;
        if request.tokens_in.is_zero() {
            return Err(Error::ZeroAmount);
        }
        let resolved = self.reachable_or_refuse().await?;
        let market = &resolved.market;
        market.quote.require_same(request.min_quote_out.token())?;

        let allowance = self.router_allowance(from).await?;
        if allowance < request.tokens_in {
            return Err(Error::RouterApprovalRequired {
                token: self.token,
                owner: from,
                router: resolved.router,
                allowance,
                needed: request.tokens_in,
            });
        }

        let receiver = request.recipient.unwrap_or(from);
        // Rounded UP: a floor rounded down would accept less than the caller named.
        let min_raw = request.min_quote_out.ceil_to_representable().to_raw()?;
        let router = self.router_contract(&resolved);
        let call = router
            .swapExactTokensForTokens(
                request.tokens_in.to_wad(),
                min_raw,
                zero_for_one(false, market.quote_is_currency0),
                market.key.to_router_abi(),
                Bytes::new(),
                receiver,
                request.deadline.to_u256(),
            )
            .from(from);
        let call = if market.quote.is_native {
            match request.gas_limit {
                Some(limit) => call.gas(limit),
                None => call,
            }
        } else {
            let gas = crate::quote::erc20_trade_gas(
                &call,
                request.gas_limit,
                &market.quote,
                "sending a pool sell",
                crate::quote::with_pool_quote_transfer_headroom,
            )
            .await?;
            call.gas(gas)
        };
        let pending = call.send().await.map_err(|err| {
            Error::from_contract(err, "sending a pool sell").on_erc20_quote(&market.quote, None)
        })?;
        let receipt = mined(pending, "the pool sell").await?;

        let tokens = self.tokens_moved(&receipt, |log| log.from == from)?;
        let (quote, fee_quote) = fill_from_receipt(&receipt, &resolved, Side::Sell)?;
        Ok(PoolTradeResult {
            quote,
            tokens,
            fee_quote,
            fees_distributed: fees_distributed_from_logs(receipt.inner.logs(), market),
            tx_hash: receipt.transaction_hash,
            approval_tx_hash: None,
        })
    }

    /// The `VERSION()` of this pool's fee hook, verbatim. Every quote and trade
    /// refuses a hook that is not `arcnow/arc-now-fee-hook@3.x.x`.
    ///
    /// # Errors
    /// [`Error::TokenNotMigrated`]; [`Error::Rpc`] if the endpoint fails.
    pub async fn hook_version(&self) -> Result<String, Error> {
        let hook = self.market().await?.key.hooks;
        self.read_hook_version(hook).await
    }

    /// Fees this pool has charged and not yet paid out: `accruedFee(poolId)`,
    /// raw units of the quote, scaled to a wad.
    ///
    /// # Errors
    /// [`Error::TokenNotMigrated`]; [`Error::UnknownHookVersion`];
    /// [`Error::Rpc`].
    pub async fn accrued_hook_fee(&self) -> Result<QuoteAmount, Error> {
        let market = self.market().await?;
        self.check_hook(market.key.hooks).await?;
        let raw = HookAbi::new(market.key.hooks, self.provider().clone())
            .accruedFee(market.pool_id)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading a pool's accrued hook fee"))?;
        Ok(from_raw(&market.quote, raw))
    }

    /// Pay out this pool's accrued hook fees now: `distributeFees(key)`.
    /// **Permissionless**; the fee goes to the pool's five recipients.
    ///
    /// Returns what was distributed, in the quote, and the transaction.
    ///
    /// # Errors
    /// [`Error::SignerRequired`]; [`Error::TokenNotMigrated`];
    /// [`Error::UnknownHookVersion`], before anything is sent.
    pub async fn distribute_hook_fees(&self) -> Result<(QuoteAmount, B256), Error> {
        let from = self.client.require_signer("Pool::distribute_hook_fees")?;
        let market = self.market().await?;
        self.check_hook(market.key.hooks).await?;
        let key = HookAbi::PoolKey {
            currency0: market.key.currency0,
            currency1: market.key.currency1,
            fee: U24::from(market.key.fee),
            tickSpacing: I24::unchecked_from(market.key.tick_spacing),
            hooks: market.key.hooks,
        };
        let pending = HookAbi::new(market.key.hooks, self.provider().clone())
            .distributeFees(key)
            .from(from)
            .send()
            .await
            .map_err(|err| Error::from_contract(err, "distributing a pool's hook fees"))?;
        let receipt = mined(pending, "the fee distribution").await?;
        Ok((fees_distributed_from_logs(receipt.inner.logs(), &market), receipt.transaction_hash))
    }

    /// What `owner` has approved the router to move. [`Tokens::MAX`] is the
    /// unlimited sentinel.
    ///
    /// # Errors
    /// [`Error::NoRouterDeployed`]; [`Error::Rpc`] if the endpoint fails.
    pub async fn router_allowance(&self, owner: Address) -> Result<Tokens, Error> {
        let router = self.router()?;
        let raw = self
            .token_contract()
            .allowance(owner, router)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "reading the router's allowance"))?;
        Ok(Tokens::from_wad(raw))
    }

    /// Whether this token has migrated at all.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn is_migrated(&self) -> Result<bool, Error> {
        Ok(!self.client.token(self.token).migrated_pool().await?.is_zero())
    }

    /// Approve the router to move `amount` of the signer's tokens — the first of
    /// the two transactions a sell takes.
    ///
    /// # Errors
    /// [`Error::SignerRequired`]; [`Error::NoRouterDeployed`].
    pub async fn approve_router(&self, amount: Tokens) -> Result<B256, Error> {
        let router = self.router()?;
        self.client.token(self.token).approve(router, amount.to_wad()).await
    }

    // ------------------------------------------------------------- internals

    fn router_contract(
        &self,
        resolved: &Resolved,
    ) -> RouterAbi::UniswapV4Router04Instance<DynProvider> {
        RouterAbi::new(resolved.router, self.provider().clone())
    }

    /// The token's key, pool id, `PoolManager` and quote, read off its migrator
    /// in one call (after one call for whether it has migrated) and cached once
    /// it has.
    async fn market(&self) -> Result<Market, Error> {
        if let Some(market) = cached(&self.client.cache().markets, &self.token) {
            return Ok(market);
        }
        let context = "reading a token's pool";
        let mut first = Batch::new();
        let pool = first.push(self.token, &TokenAbi::migratedPoolCall {});
        let migrator = first.push(self.token, &TokenAbi::migratorCall {});
        let answers = first.run(self.client, context).await?;
        if answers.decode::<TokenAbi::migratedPoolCall>(pool, context)?.is_zero() {
            return Err(Error::TokenNotMigrated { token: self.token });
        }
        let migrator = answers.decode::<TokenAbi::migratorCall>(migrator, context)?;

        let mut second = Batch::new();
        let key = second.push(migrator, &MigratorAbi::poolKeyCall { token: self.token });
        let pool_id = second.push(migrator, &MigratorAbi::poolIdOfCall { token: self.token });
        let manager = second.push(migrator, &MigratorAbi::poolManagerCall {});
        let version = self
            .client
            .cached_version(migrator)
            .is_none()
            .then(|| second.push(migrator, &MigratorAbi::VERSIONCall {}));
        let answers = second.run(self.client, context).await?;
        if let Some(index) = version {
            let version = answers.decode::<MigratorAbi::VERSIONCall>(index, context)?;
            self.client.remember_version(migrator, version);
        }
        curve_math::check_v4_migrator_version(
            &self.client.cached_version(migrator).unwrap_or_default(),
        )?;
        let key = PoolKey::from_abi(&answers.decode::<MigratorAbi::poolKeyCall>(key, context)?);
        let quote_address = key.quote_currency(self.token).ok_or_else(|| {
            Error::abi(
                context,
                format!(
                    "the migrator's pool key for {} does not contain that token: {key:?}",
                    self.token
                ),
            )
        })?;
        let market = Market {
            key,
            pool_id: answers.decode::<MigratorAbi::poolIdOfCall>(pool_id, context)?,
            pool_manager: answers.decode::<MigratorAbi::poolManagerCall>(manager, context)?,
            quote: self.client.quote_token_info(quote_address).await?,
            quote_is_currency0: key.quote_is_currency0(self.token),
        };
        remember(&self.client.cache().markets, self.token, market.clone());
        Ok(market)
    }

    /// The market, plus the `PoolManager` `router` is immutably bound to (read
    /// once per client).
    async fn resolve(&self, router: Address) -> Result<Resolved, Error> {
        let market = self.market().await?;
        let router_pool_manager =
            if let Some(manager) = cached(&self.client.cache().router_pool_managers, &router) {
                manager
            } else {
                let manager = RouterAbi::new(router, self.provider().clone())
                    .poolManager()
                    .call()
                    .await
                    .map_err(|err| Error::from_contract(err, "reading the router's PoolManager"))?;
                remember(&self.client.cache().router_pool_managers, router, manager);
                manager
            };
        Ok(Resolved { market, router, router_pool_manager })
    }

    /// Resolve, and refuse rather than build a swap that cannot settle: no
    /// router, a router bound to another `PoolManager`, or a hook this SDK does
    /// not know.
    async fn reachable_or_refuse(&self) -> Result<Resolved, Error> {
        let router = self.router()?;
        let resolved = self.resolve(router).await?;
        if !resolved.reachable() {
            return Err(Error::PoolUnreachable {
                token: self.token,
                pool_manager: resolved.market.pool_manager,
                router: resolved.router,
                router_pool_manager: resolved.router_pool_manager,
            });
        }
        self.check_hook(resolved.market.key.hooks).await?;
        Ok(resolved)
    }

    async fn read_hook_version(&self, hook: Address) -> Result<String, Error> {
        self.client
            .version_of(hook, async {
                HookAbi::new(hook, self.provider().clone())
                    .VERSION()
                    .call()
                    .await
                    .map_err(|err| Error::from_contract(err, "reading a fee hook's VERSION()"))
            })
            .await
    }

    async fn check_hook(&self, hook: Address) -> Result<(), Error> {
        check_hook_version(hook, &self.read_hook_version(hook).await?)
    }

    /// `eth_call` the swap and hand back the `BalanceDelta` it returned.
    async fn simulate(
        &self,
        resolved: &Resolved,
        amount_in: U256,
        zero_for_one: bool,
        caller: Address,
        value: U256,
        overrides: StateOverride,
    ) -> Result<I256, Error> {
        self.router_contract(resolved)
            .swapExactTokensForTokens(
                amount_in,
                // No floor on a quote: the floor belongs on the trade.
                U256::ZERO,
                zero_for_one,
                resolved.market.key.to_router_abi(),
                Bytes::new(),
                caller,
                Deadline::none().to_u256(),
            )
            .from(caller)
            .value(value)
            .state(overrides)
            .call()
            .await
            .map_err(|err| Error::from_contract(err, "quoting a pool swap"))
    }

    /// Sum the token's own `Transfer` logs in this receipt that `matches`.
    fn tokens_moved(
        &self,
        receipt: &TransactionReceipt,
        matches: impl Fn(&TokenAbi::Transfer) -> bool,
    ) -> Result<Tokens, Error> {
        let mut total = U256::ZERO;
        let mut seen = false;
        for log in receipt.inner.logs() {
            if log.address() != self.token {
                continue;
            }
            if let Ok(transfer) = TokenAbi::Transfer::decode_log(&log.inner)
                && matches(&transfer)
            {
                total += transfer.value;
                seen = true;
            }
        }
        if !seen {
            return Err(Error::MissingLog { tx_hash: receipt.transaction_hash, event: "Transfer" });
        }
        Ok(Tokens::from_wad(total))
    }
}

/// Which way a pool trade went, for reading its receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    /// Quote into the pool.
    Buy,
    /// Quote out of the pool.
    Sell,
}

impl fmt::Display for Side {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Buy => f.write_str("buy"),
            Self::Sell => f.write_str("sell"),
        }
    }
}

/// [`quote_fill_from_logs`] on a mined receipt, for the pool `resolved` names.
fn fill_from_receipt(
    receipt: &TransactionReceipt,
    resolved: &Resolved,
    side: Side,
) -> Result<(QuoteAmount, QuoteAmount), Error> {
    quote_fill_from_logs(
        receipt.inner.logs(),
        receipt.transaction_hash,
        resolved.market.pool_manager,
        &resolved.market,
        side,
    )
}

/// The trader's exact quote leg and the hook's fee, as `(quote, fee)` wads,
/// read out of one transaction's logs. See [`PoolTradeResult`].
///
/// `Swap` by the **`PoolManager`'s address and the `PoolId`**, its quote leg
/// picked by currency order; `HookFeeTaken` by the **hook's address, the
/// `PoolId` and the quote currency**. **Not** `HookFeeTaken.payer` or
/// `Swap.sender`, which are both the router. Matches are summed.
///
/// # Errors
/// [`Error::MissingLog`] when no `Swap` for this pool is in the logs — never a
/// zero. [`Error::Abi`] when the trader's leg points the wrong way for `side`.
fn quote_fill_from_logs(
    logs: &[Log],
    tx_hash: B256,
    pool_manager: Address,
    market: &Market,
    side: Side,
) -> Result<(QuoteAmount, QuoteAmount), Error> {
    let (hook, pool_id, currency) = (market.key.hooks, market.pool_id, market.quote.address);
    let mut pool_leg = I256::ZERO;
    let mut swapped = false;
    let mut fee = U256::ZERO;
    for log in logs {
        if log.address() == pool_manager
            && let Ok(swap) = IPoolManager::Swap::decode_log(&log.inner)
            && swap.id == pool_id
        {
            let leg = if market.quote_is_currency0 { swap.amount0 } else { swap.amount1 };
            pool_leg += I256::unchecked_from(leg);
            swapped = true;
        }
        if log.address() == hook
            && let Ok(taken) = HookAbi::HookFeeTaken::decode_log(&log.inner)
            && taken.poolId == pool_id
            && taken.currency == currency
        {
            fee += taken.feeAmount;
        }
    }
    if !swapped {
        return Err(Error::MissingLog { tx_hash, event: "Swap" });
    }

    // The hook's fee went through `SafeCast.toInt128` before it could be taken,
    // so it is far inside an `I256`.
    let trader = pool_leg - I256::from_raw(fee);
    let wrong_way = match side {
        Side::Buy => trader.is_positive(),
        Side::Sell => trader.is_negative(),
    };
    if wrong_way {
        return Err(Error::abi(
            "reading a pool trade's receipt",
            format!(
                "transaction {tx_hash} was read as a {side}, and its quote leg for pool {pool_id} \
                 moved {trader} raw units the other way (Swap leg {pool_leg}, fee {fee}). This \
                 receipt is not the trade it was read for."
            ),
        ));
    }
    Ok((from_raw(&market.quote, trader.unsigned_abs()), from_raw(&market.quote, fee)))
}

/// Σ `FeesDistributed.amount` for this pool, from its own hook, in its quote
/// currency, in one transaction's logs, as a wad. Zero when there is none.
fn fees_distributed_from_logs(logs: &[Log], market: &Market) -> QuoteAmount {
    let total = logs
        .iter()
        .filter(|log| log.address() == market.key.hooks)
        .filter_map(|log| HookAbi::FeesDistributed::decode_log(&log.inner).ok())
        .filter(|event| event.poolId == market.pool_id && event.currency == market.quote.address)
        .fold(U256::ZERO, |sum, event| sum + event.amount);
    from_raw(&market.quote, total)
}

/// A `BalanceDelta` leg the trader **paid**: strictly negative, returned as its
/// magnitude.
fn leg_paid(amount: i128, what: &'static str) -> Result<U256, Error> {
    if amount >= 0 {
        return Err(Error::abi(
            "reading a pool quote",
            format!(
                "{what} came back as {amount}, and a leg the trader pays is negative in a \
                 BalanceDelta. Either the currency order was read wrongly or the router's return \
                 shape has changed."
            ),
        ));
    }
    Ok(U256::from(amount.unsigned_abs()))
}

/// A `BalanceDelta` leg the trader **received**: strictly positive.
fn leg_received(amount: i128, what: &'static str) -> Result<U256, Error> {
    if amount <= 0 {
        return Err(Error::abi(
            "reading a pool quote",
            format!(
                "{what} came back as {amount}, and a leg the trader receives is positive in a \
                 BalanceDelta. A zero here is a swap that moved nothing, which is not a quote."
            ),
        ));
    }
    Ok(U256::from(amount.unsigned_abs()))
}

/// Wait for a sent swap and insist on a mined, successful receipt.
async fn mined(
    pending: PendingTransactionBuilder<Ethereum>,
    waiting: &'static str,
) -> Result<TransactionReceipt, Error> {
    let receipt = pending
        .get_receipt()
        .await
        .map_err(|err| Error::rpc(format!("waiting for {waiting} receipt"), err))?;
    if !receipt.status() {
        return Err(Error::TransactionReverted { tx_hash: receipt.transaction_hash });
    }
    Ok(receipt)
}

// ---------------------------------------------------------------------------
// the front door
// ---------------------------------------------------------------------------

/// One token, whichever venue it trades at. Get one with [`Client::trade`].
///
/// **Read the venue before building a request.** A request built for the wrong
/// venue is refused with [`Error::VenueMismatch`], not quietly reshaped.
#[derive(Debug, Clone, Copy)]
pub struct Trade<'a> {
    client: &'a Client,
    token: Address,
}

impl<'a> Trade<'a> {
    pub(crate) fn new(client: &'a Client, token: Address) -> Self {
        Self { client, token }
    }

    /// The token being traded.
    #[must_use]
    pub fn token(&self) -> Address {
        self.token
    }

    /// This token's pool handle, whether or not it has migrated.
    #[must_use]
    pub fn pool(&self) -> Pool<'a> {
        Pool::new(self.client, self.token)
    }

    /// This token's curve handle.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn curve(&self) -> Result<Curve<'a>, Error> {
        Ok(self.client.curve(self.client.token(self.token).curve().await?))
    }

    /// What this token is priced in, read from its curve — the same before and
    /// after graduation, since the pool pairs the token with the curve's quote.
    ///
    /// # Errors
    /// As [`Curve::quote_token`].
    pub async fn quote_token(&self) -> Result<QuoteTokenInfo, Error> {
        self.curve().await?.quote_token().await
    }

    /// Where this token trades **right now**: `ArcToken.migratedPool()`,
    /// non-zero meaning migrated.
    ///
    /// # Errors
    /// [`Error::Rpc`] if the endpoint fails.
    pub async fn venue(&self) -> Result<Venue, Error> {
        let pool = self.client.token(self.token).migrated_pool().await?;
        Ok(if pool.is_zero() { Venue::Curve } else { Venue::Pool })
    }

    /// Price a buy of `quote_in` at whichever venue this token trades at.
    ///
    /// # Errors
    /// Whatever the venue's own quote returns.
    pub async fn quote_buy(&self, quote_in: QuoteAmount) -> Result<TradeBuyQuote, Error> {
        match self.venue().await? {
            Venue::Curve => {
                Ok(TradeBuyQuote::Curve(self.curve().await?.quote_buy(quote_in).await?))
            }
            Venue::Pool => Ok(TradeBuyQuote::Pool(self.pool().quote_buy(quote_in).await?)),
        }
    }

    /// Price a sell of `tokens_in` by `seller` at whichever venue this token
    /// trades at. `seller` is ignored on a curve and load-bearing in a pool.
    ///
    /// # Errors
    /// Whatever the venue's own quote returns.
    pub async fn quote_sell(
        &self,
        tokens_in: Tokens,
        seller: Address,
    ) -> Result<TradeSellQuote, Error> {
        match self.venue().await? {
            Venue::Curve => {
                Ok(TradeSellQuote::Curve(self.curve().await?.quote_sell(tokens_in).await?))
            }
            Venue::Pool => {
                Ok(TradeSellQuote::Pool(self.pool().quote_sell(tokens_in, seller).await?))
            }
        }
    }

    /// Buy at whichever venue this token trades at.
    ///
    /// # Errors
    /// [`Error::VenueMismatch`] when the request was built for the other venue,
    /// refused before anything is sent; otherwise whatever that venue's own buy
    /// returns.
    pub async fn buy(&self, request: impl Into<TradeBuyRequest>) -> Result<TradeBuyResult, Error> {
        let request = request.into();
        match (self.venue().await?, request) {
            (Venue::Curve, TradeBuyRequest::Curve(inner)) => {
                Ok(TradeBuyResult::Curve(self.curve().await?.buy(inner).await?))
            }
            (Venue::Pool, TradeBuyRequest::Pool(inner)) => {
                Ok(TradeBuyResult::Pool(self.pool().buy(inner).await?))
            }
            (actual, given) => {
                Err(Error::VenueMismatch { token: self.token, actual, requested: given.venue() })
            }
        }
    }

    /// Sell at whichever venue this token trades at.
    ///
    /// # Errors
    /// [`Error::VenueMismatch`]; otherwise whatever that venue's own sell
    /// returns.
    pub async fn sell(
        &self,
        request: impl Into<TradeSellRequest>,
    ) -> Result<TradeSellResult, Error> {
        let request = request.into();
        match (self.venue().await?, request) {
            (Venue::Curve, TradeSellRequest::Curve(inner)) => {
                Ok(TradeSellResult::Curve(self.curve().await?.sell(inner).await?))
            }
            (Venue::Pool, TradeSellRequest::Pool(inner)) => {
                Ok(TradeSellResult::Pool(self.pool().sell(inner).await?))
            }
            (actual, given) => {
                Err(Error::VenueMismatch { token: self.token, actual, requested: given.venue() })
            }
        }
    }
}

/// A buy quote from either venue.
#[derive(Debug, Clone, PartialEq, Eq)]
// Both venues' variants carry quote amounts; boxing one would only move the size.
#[allow(clippy::large_enum_variant)]
pub enum TradeBuyQuote {
    /// The bonding curve's, which also says whether this buy graduates it.
    Curve(BuyQuote),
    /// The pool's.
    Pool(PoolBuyQuote),
}

impl TradeBuyQuote {
    /// Which venue priced this.
    #[must_use]
    pub const fn venue(&self) -> Venue {
        match self {
            Self::Curve(_) => Venue::Curve,
            Self::Pool(_) => Venue::Pool,
        }
    }

    /// Tokens the buyer receives, whichever venue filled it.
    #[must_use]
    pub const fn tokens_out(&self) -> Tokens {
        match self {
            Self::Curve(quote) => quote.tokens_out,
            Self::Pool(quote) => quote.tokens_out,
        }
    }

    /// The 1% arcnow.io fee, in the quote.
    #[must_use]
    pub const fn fee(&self) -> &QuoteAmount {
        match self {
            Self::Curve(quote) => &quote.fee,
            Self::Pool(quote) => &quote.fee_quote,
        }
    }

    /// A slippage floor `tolerance` below this quote's `tokens_out`.
    #[must_use]
    pub fn min_tokens_out(&self, tolerance: Bps) -> Tokens {
        self.tokens_out().less_tolerance(tolerance)
    }
}

/// A sell quote from either venue.
#[derive(Debug, Clone, PartialEq, Eq)]
// Both venues' variants carry quote amounts; boxing one would only move the size.
#[allow(clippy::large_enum_variant)]
pub enum TradeSellQuote {
    /// The bonding curve's.
    Curve(SellQuote),
    /// The pool's.
    Pool(PoolSellQuote),
}

impl TradeSellQuote {
    /// Which venue priced this.
    #[must_use]
    pub const fn venue(&self) -> Venue {
        match self {
            Self::Curve(_) => Venue::Curve,
            Self::Pool(_) => Venue::Pool,
        }
    }

    /// Quote the seller receives, net of fee.
    #[must_use]
    pub const fn quote_out(&self) -> &QuoteAmount {
        match self {
            Self::Curve(quote) => &quote.quote_out,
            Self::Pool(quote) => &quote.quote_out,
        }
    }

    /// The 1% arcnow.io fee.
    #[must_use]
    pub const fn fee(&self) -> &QuoteAmount {
        match self {
            Self::Curve(quote) => &quote.fee,
            Self::Pool(quote) => &quote.fee_quote,
        }
    }

    /// A slippage floor `tolerance` below this quote's `quote_out`.
    #[must_use]
    pub fn min_quote_out(&self, tolerance: Bps) -> QuoteAmount {
        self.quote_out().less_tolerance(tolerance)
    }
}

/// A buy built for one venue or the other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TradeBuyRequest {
    /// A curve buy.
    Curve(BuyRequest),
    /// A pool buy.
    Pool(PoolBuyRequest),
}

impl TradeBuyRequest {
    /// Which venue this request is for.
    #[must_use]
    pub const fn venue(&self) -> Venue {
        match self {
            Self::Curve(_) => Venue::Curve,
            Self::Pool(_) => Venue::Pool,
        }
    }
}

impl From<BuyRequest> for TradeBuyRequest {
    fn from(request: BuyRequest) -> Self {
        Self::Curve(request)
    }
}

impl From<PoolBuyRequest> for TradeBuyRequest {
    fn from(request: PoolBuyRequest) -> Self {
        Self::Pool(request)
    }
}

/// A sell built for one venue or the other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TradeSellRequest {
    /// A curve sell: no approval anywhere.
    Curve(SellRequest),
    /// A pool sell: needs an approval to the router first.
    Pool(PoolSellRequest),
}

impl TradeSellRequest {
    /// Which venue this request is for.
    #[must_use]
    pub const fn venue(&self) -> Venue {
        match self {
            Self::Curve(_) => Venue::Curve,
            Self::Pool(_) => Venue::Pool,
        }
    }
}

impl From<SellRequest> for TradeSellRequest {
    fn from(request: SellRequest) -> Self {
        Self::Curve(request)
    }
}

impl From<PoolSellRequest> for TradeSellRequest {
    fn from(request: PoolSellRequest) -> Self {
        Self::Pool(request)
    }
}

/// What a buy did, at whichever venue it happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TradeBuyResult {
    /// The curve's.
    Curve(BuyResult),
    /// The pool's.
    Pool(PoolTradeResult),
}

impl TradeBuyResult {
    /// Which venue filled this.
    #[must_use]
    pub const fn venue(&self) -> Venue {
        match self {
            Self::Curve(_) => Venue::Curve,
            Self::Pool(_) => Venue::Pool,
        }
    }

    /// Tokens delivered.
    #[must_use]
    pub const fn tokens_out(&self) -> Tokens {
        match self {
            Self::Curve(result) => result.tokens_out,
            Self::Pool(result) => result.tokens,
        }
    }

    /// Quote consumed.
    #[must_use]
    pub const fn quote_spent(&self) -> &QuoteAmount {
        match self {
            Self::Curve(result) => &result.quote_spent,
            Self::Pool(result) => &result.quote,
        }
    }

    /// The transaction.
    #[must_use]
    pub const fn tx_hash(&self) -> B256 {
        match self {
            Self::Curve(result) => result.tx_hash,
            Self::Pool(result) => result.tx_hash,
        }
    }
}

/// What a sell did, at whichever venue it happened.
#[derive(Debug, Clone, PartialEq, Eq)]
// Both venues' variants carry quote amounts; boxing one would only move the size.
#[allow(clippy::large_enum_variant)]
pub enum TradeSellResult {
    /// The curve's.
    Curve(SellResult),
    /// The pool's.
    Pool(PoolTradeResult),
}

impl TradeSellResult {
    /// Which venue filled this.
    #[must_use]
    pub const fn venue(&self) -> Venue {
        match self {
            Self::Curve(_) => Venue::Curve,
            Self::Pool(_) => Venue::Pool,
        }
    }

    /// Quote paid to the seller.
    #[must_use]
    pub const fn quote_out(&self) -> &QuoteAmount {
        match self {
            Self::Curve(result) => &result.quote_out,
            Self::Pool(result) => &result.quote,
        }
    }

    /// The transaction.
    #[must_use]
    pub const fn tx_hash(&self) -> B256 {
        match self {
            Self::Curve(result) => result.tx_hash,
            Self::Pool(result) => result.tx_hash,
        }
    }
}

/// Refuse a fee hook that is not `arcnow/arc-now-fee-hook@3.x.x`, the hook that
/// books its fee in the pool's quote, in raw units.
fn check_hook_version(hook: Address, version: &str) -> Result<(), Error> {
    if curve_math::major_of("arc-now-fee-hook", version) == Some(3) {
        Ok(())
    } else {
        Err(Error::UnknownHookVersion { hook, version: version.to_owned() })
    }
}

#[cfg(test)]
mod tests {
    //! Reading a pool fill's quote leg out of its receipt, in both currency
    //! orders and in raw units, with no chain.

    use alloy::primitives::aliases::{I24, U24};
    use alloy::primitives::{Address, B256, LogData, U160, U256, address, b256};
    use alloy::rpc::types::Log;
    use alloy::sol_types::SolEvent;

    use super::{
        Market, PoolKey, Side, check_hook_version, quote_fill_from_logs, sell_quote_out_from_fee,
    };
    use crate::amount::{NATIVE_USDC, QuoteAmount, QuoteTokenInfo, Usdc};
    use crate::bindings::fee_hook::ArcNowFeeHook as HookAbi;
    use crate::bindings::pool_manager::IPoolManager;
    use crate::error::Error;

    const MANAGER: Address = address!("0x06110b57dd9b82DD846ee0325fB81B284E1C6dD0");
    const HOOK: Address = address!("0xeEf5955ddF990455E0Cb1Cac256A500B94cE20cC");
    const ROUTER: Address = address!("0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e");
    const TOKEN: Address = address!("0x00000000000000000000000000000000000070c3");
    const EURC: Address = address!("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
    const LOW_QUOTE: Address = address!("0x0000000000000000000000000000000000000042");
    const POOL_ID: B256 =
        b256!("0xfb4d91443a9b700371ff88a0c86c171b541aed24920922593a2d314e6a48d083");
    const OTHER_POOL_ID: B256 =
        b256!("0xabababababababababababababababababababababababababababababababab");
    const TX: B256 = b256!("0x6eb10f6b1b477e395aca1c050f01190dcaf1bb3558e5cf3bb68c586d32ff7423");

    fn market(quote: QuoteTokenInfo) -> Market {
        let (currency0, currency1) = super::pool_currencies(quote.address, TOKEN);
        let key = PoolKey { currency0, currency1, fee: 3_000, tick_spacing: 60, hooks: HOOK };
        Market {
            quote_is_currency0: key.quote_is_currency0(TOKEN),
            key,
            pool_id: POOL_ID,
            pool_manager: MANAGER,
            quote,
        }
    }

    fn eurc() -> QuoteTokenInfo {
        QuoteTokenInfo::erc20(EURC, "EURC", "EURC", 6).unwrap()
    }

    fn low18() -> QuoteTokenInfo {
        QuoteTokenInfo::erc20(LOW_QUOTE, "LOW", "Low", 18).unwrap()
    }

    fn rpc_log(address: Address, data: LogData) -> Log {
        Log { inner: alloy::primitives::Log { address, data }, ..Log::default() }
    }

    fn swap_at(at: Address, id: B256, amount0: i128, amount1: i128) -> Log {
        rpc_log(
            at,
            IPoolManager::Swap {
                id,
                sender: ROUTER,
                amount0,
                amount1,
                sqrtPriceX96: U160::from(5_591_840_213_126_229_927_066_759_898_408_u128),
                liquidity: 3_598_610_843_089_325_200_392,
                tick: I24::unchecked_from(85_138),
                fee: U24::from(3_000_u32),
            }
            .encode_log_data(),
        )
    }

    fn swap(amount0: i128, amount1: i128) -> Log {
        swap_at(MANAGER, POOL_ID, amount0, amount1)
    }

    fn fee_at(at: Address, pool_id: B256, currency: Address, amount: u128, on_input: bool) -> Log {
        rpc_log(
            at,
            HookAbi::HookFeeTaken {
                poolId: pool_id,
                token: TOKEN,
                // Always the router: whoever called `PoolManager.swap`.
                payer: ROUTER,
                currency,
                feeAmount: U256::from(amount),
                onInput: on_input,
            }
            .encode_log_data(),
        )
    }

    fn fee(amount: u128, on_input: bool) -> Log {
        fee_at(HOOK, POOL_ID, Address::ZERO, amount, on_input)
    }

    fn read(logs: &[Log], side: Side) -> Result<(Usdc, Usdc), Error> {
        quote_fill_from_logs(logs, TX, MANAGER, &market(NATIVE_USDC), side)
    }

    fn wei(amount: u128) -> Usdc {
        Usdc::from_wad(U256::from(amount))
    }

    fn euros(text: &str) -> QuoteAmount {
        QuoteAmount::parse_in(&eurc(), text).unwrap()
    }

    #[test]
    fn the_swap_event_is_v4_cores_own() {
        assert_eq!(
            IPoolManager::Swap::SIGNATURE_HASH,
            b256!("0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f")
        );
    }

    #[test]
    fn a_live_pool_buy_reads_back_as_exactly_what_was_sent() {
        // 1 USDC sent, 0.01 taken in beforeSwap, so the pool swapped 0.99.
        let logs = [fee(10_000_000_000_000_000, true), swap(-990_000_000_000_000_000, 5_013)];
        let (quote, fee_quote) = read(&logs, Side::Buy).unwrap();
        assert_eq!(quote, Usdc::from_whole(1));
        assert_eq!(fee_quote, Usdc::parse("0.01").unwrap());
    }

    #[test]
    fn a_sell_is_exact_where_the_fee_alone_only_bounds_it() {
        let logs = [swap(10_199, -7), fee(101, false)];
        assert_eq!(read(&logs, Side::Sell).unwrap(), (wei(10_098), wei(101)));
        assert_eq!(sell_quote_out_from_fee(&wei(101)), wei(9_999));
    }

    #[test]
    fn a_trade_too_small_to_be_charged_is_exact_with_no_fee_log() {
        assert_eq!(read(&[swap(-99, 496_000)], Side::Buy).unwrap(), (wei(99), Usdc::ZERO));
        assert_eq!(read(&[swap(42, -200_000)], Side::Sell).unwrap(), (wei(42), Usdc::ZERO));
    }

    #[test]
    fn another_pools_logs_and_look_alikes_from_other_addresses_are_ignored() {
        let logs = [
            swap_at(MANAGER, OTHER_POOL_ID, -5_000_000_000_000_000_000, 1),
            fee_at(HOOK, OTHER_POOL_ID, Address::ZERO, 70_000_000_000_000_000, true),
            swap_at(TOKEN, POOL_ID, -3_000_000_000_000_000_000, 1),
            fee_at(TOKEN, POOL_ID, Address::ZERO, 90_000_000_000_000_000, true),
            fee(10_000_000_000_000_000, true),
            swap(-990_000_000_000_000_000, 5),
        ];
        let (quote, fee_quote) = read(&logs, Side::Buy).unwrap();
        assert_eq!(quote, Usdc::from_whole(1));
        assert_eq!(fee_quote, Usdc::parse("0.01").unwrap());
    }

    #[test]
    fn a_token_first_eurc_pool_reads_its_quote_leg_from_amount1_in_raw_units() {
        // EURC sorts above the token, so the TOKEN is currency0. A 1 EURC buy:
        // the hook took 10,000 raw (0.01 EURC) and the pool swapped 990,000.
        let m = market(eurc());
        assert!(!m.quote_is_currency0);
        let logs = [
            fee_at(HOOK, POOL_ID, EURC, 10_000, true),
            swap(123_000_000_000_000_000_000, -990_000),
        ];
        let (quote, fee_quote) = quote_fill_from_logs(&logs, TX, MANAGER, &m, Side::Buy).unwrap();
        assert_eq!(quote, euros("1"));
        assert_eq!(fee_quote, euros("0.01"));
        assert_eq!(quote.token(), &eurc());
        // A sell: the pool paid out 1,000,000 raw gross, the hook kept 10,000.
        let logs = [
            swap(-50_000_000_000_000_000_000, 1_000_000),
            fee_at(HOOK, POOL_ID, EURC, 10_000, false),
        ];
        let (quote, fee_quote) = quote_fill_from_logs(&logs, TX, MANAGER, &m, Side::Sell).unwrap();
        assert_eq!((quote, fee_quote), (euros("0.99"), euros("0.01")));
    }

    #[test]
    fn a_quote_first_erc20_pool_reads_amount0() {
        let m = market(low18());
        assert!(m.quote_is_currency0);
        let logs = [fee_at(HOOK, POOL_ID, LOW_QUOTE, 100, true), swap(-9_900, 77)];
        let (quote, fee_quote) = quote_fill_from_logs(&logs, TX, MANAGER, &m, Side::Buy).unwrap();
        assert_eq!(quote.to_wad(), U256::from(10_000));
        assert_eq!(fee_quote.to_wad(), U256::from(100));
    }

    #[test]
    fn a_fee_in_another_currency_is_not_this_pools_fee() {
        let m = market(eurc());
        let logs = [
            fee_at(HOOK, POOL_ID, Address::ZERO, 777, true),
            fee_at(HOOK, POOL_ID, TOKEN, 555, true),
            fee_at(HOOK, POOL_ID, EURC, 10_000, true),
            swap(1, -990_000),
        ];
        let (_, fee_quote) = quote_fill_from_logs(&logs, TX, MANAGER, &m, Side::Buy).unwrap();
        assert_eq!(fee_quote, euros("0.01"));
    }

    fn distributed_at(at: Address, pool_id: B256, currency: Address, amount: u128) -> Log {
        rpc_log(
            at,
            HookAbi::FeesDistributed {
                poolId: pool_id,
                caller: ROUTER,
                currency,
                amount: U256::from(amount),
            }
            .encode_log_data(),
        )
    }

    #[test]
    fn a_distribution_is_reported_in_the_pools_quote_and_does_not_move_the_fill() {
        let m = market(eurc());
        let logs = [
            distributed_at(HOOK, POOL_ID, EURC, 7_000),
            distributed_at(HOOK, POOL_ID, Address::ZERO, 1),
            distributed_at(HOOK, OTHER_POOL_ID, EURC, 1),
            distributed_at(TOKEN, POOL_ID, EURC, 2),
            fee_at(HOOK, POOL_ID, EURC, 10_000, true),
            swap(5_013, -990_000),
        ];
        assert_eq!(
            quote_fill_from_logs(&logs, TX, MANAGER, &m, Side::Buy).unwrap(),
            (euros("1"), euros("0.01"))
        );
        assert_eq!(super::fees_distributed_from_logs(&logs, &m), euros("0.007"));
        assert_eq!(super::fees_distributed_from_logs(&logs[4..], &m), euros("0"));
    }

    #[test]
    fn no_swap_for_this_pool_is_a_missing_log_not_a_zero() {
        let err = read(&[fee(1, true)], Side::Buy).unwrap_err();
        assert!(
            matches!(err, Error::MissingLog { tx_hash, event: "Swap" } if tx_hash == TX),
            "{err:?}"
        );
    }

    #[test]
    fn a_leg_pointing_the_wrong_way_for_its_side_is_refused() {
        let err = read(&[swap(1_000_000_000_000_000_000, -1)], Side::Buy).unwrap_err();
        assert!(err.to_string().contains("buy"), "{err}");
        let err = read(&[swap(-1_000_000_000_000_000_000, 1)], Side::Sell).unwrap_err();
        assert!(err.to_string().contains("sell"), "{err}");
    }

    #[test]
    fn only_a_version_3_hook_is_accepted() {
        let hook = Address::repeat_byte(0x44);
        assert!(check_hook_version(hook, "arcnow/arc-now-fee-hook@3.0.0").is_ok());
        assert!(check_hook_version(hook, "arcnow/arc-now-fee-hook@3.3.1").is_ok());
        for refused in [
            "arcnow/arc-now-fee-hook@2.0.0",
            "arcnow/arc-now-fee-hook@1.0.0",
            "arcnow/arc-now-fee-hook@4.0.0",
            "arcnow/arc-token@1.0.0",
        ] {
            let err = check_hook_version(hook, refused).unwrap_err();
            assert!(
                matches!(&err, Error::UnknownHookVersion { hook: h, version } if *h == hook && version == refused),
                "{refused}: {err:?}"
            );
        }
    }
}
