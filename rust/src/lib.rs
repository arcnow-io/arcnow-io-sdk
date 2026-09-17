//! Launch, trade and read [arcnow.io](https://arcnow.io) bonding-curve tokens on
//! [Arc](https://docs.arc.io/), by talking to the contracts over JSON-RPC. No
//! arcnow.io backend is involved.
//!
//! # The one fact to get right
//!
//! **On Arc, USDC is the native gas currency and `msg.value` is 18 decimals.**
//! The USDC ERC-20 interface predeploy at
//! `0x3600000000000000000000000000000000000000` is the *same asset* reporting
//! **6** decimals; it does not pay for gas, and no arcnow.io contract reads,
//! writes, calls or imports it. The two raw representations of one dollar differ
//! by `1e12`.
//!
//! Every amount in every arcnow.io signature, event, error and storage slot is
//! 18-decimal wad. This crate makes that hard to get wrong with three distinct
//! types — [`Usdc`], [`UsdcErc20`] and [`Tokens`] — that do not convert into one
//! another implicitly and have no constructor that guesses a scale. See
//! [`amount`].
//!
//! # A tour
//!
//! ```no_run
//! # async fn f() -> Result<(), arcnow_sdk::Error> {
//! use arcnow_sdk::{BuyRequest, Client, Network, Bps, Usdc};
//!
//! // Reading needs no key at all.
//! let client = Client::builder().network(Network::ArcTestnet).build().await?;
//!
//! let curve = client.curve("0x…".parse().unwrap());
//! let state = curve.state().await?;
//! println!("{} of {} raised, spot {}", state.real_reserve.format(), state.target.format(), state.spot_price);
//!
//! let quote = curve.quote_buy(Usdc::from_whole(25)).await?;
//! println!("25 USDC buys {} tokens, fee {}", quote.tokens_out, quote.fee);
//!
//! // Writing needs one. A write on a read-only client fails before any RPC.
//! let floor = quote.min_tokens_out(Bps::of_trade(50)); // half a percent
//! let filled = curve.buy(BuyRequest::new(Usdc::from_whole(25), floor)).await?;
//! println!("bought {} for {}", filled.tokens_out, filled.quote_spent);
//! # Ok(()) }
//! ```
//!
//! # Selling to a curve needs no approval
//!
//! It is worth saying on the front page because it is the thing integrators get
//! wrong: **a sell to a bonding curve is one transaction and there is no approve
//! step.** The curve pulls tokens through a privileged path that reads no
//! allowance at all. This crate never emits an approve and never checks an
//! allowance before a curve sell. See [`curve`] for why, and for what the
//! token's ordinary `approve`/`allowance`/`transferFrom` *are* for.
//!
//! **After graduation this reverses**, and that is the one asymmetry worth
//! carrying in your head. A graduated token trades in a Uniswap v4 pool through
//! a router, the router pulls the token leg with `transferFrom`, and
//! `ArcToken.canonicalRouter()` is `address(0)` on every arcnow.io token — so a
//! pool sell is **two** transactions and [`Pool::sell`] refuses without the
//! first. See [`pool`].
//!
//! # After graduation
//!
//! `curve.buy` and `curve.sell` revert permanently once a curve reaches its
//! target. [`Trade`] is the front door that reads which venue a token is at and
//! dispatches, and [`Pool`] is the venue itself: the `PoolKey`, quotes by
//! simulating the real swap, the router approval, and a clear refusal while the
//! network names no router or names one bound to a different `PoolManager`. A
//! migrated trade still costs 1.00%, as the hook's 0.80% plus a 0.20% LP fee;
//! see [`pool`].
//!
//! # What is pinned, and where it came from
//!
//! The ABIs under `src/generated/abi/` and the network presets in
//! `src/generated/networks.json` are copies, pinned by SHA-256 in `../pins.json`
//! to a commit of `arcnow-io/contracts`, and compiled into the crate so a
//! published `arcnow-sdk` needs no file, no fetch and no Solidity toolchain.
//! The maintainers' pin gate fails if one is edited or goes stale. Do not edit
//! them here; fix them where they are generated and move the pin.
//!
//! # Modules
//!
//! * [`amount`] — [`QuoteAmount`] (and its native alias [`Usdc`]),
//!   [`QuoteTokenInfo`], [`UsdcErc20`], [`Tokens`], [`Bps`], and the 18/6
//!   problem.
//! * [`quote`] — quote tokens: the allowance an ERC-20 quote needs, and the
//!   on-chain allowlist of them.
//! * [`network`] — the Arc testnet and Arc mainnet presets, and custom deployments.
//! * [`client`] — connecting, with or without a signer.
//! * [`launchpad`] — quoting and performing a launch.
//! * [`curve`] — state, quotes, buying, selling, graduation.
//! * [`curve_math`] — the curve's maths, local and wei-exact, and the one
//!   place that decides whether a `VERSION()` is a curve this crate prices.
//! * [`platform`] — the fee split, the residual, creating a platform.
//! * [`pool`] — the Uniswap v4 market a graduated token trades in, and the
//!   front door that dispatches on venue.
//! * [`token`] — the launched ERC-20.
//! * [`migrator_registry`] — graduation targets and their tax modes.
//! * [`error`] — one error type, and the revert decoder behind it.
//! * [`constants`] — chain facts and the shipped curve template.
//! * [`bindings`] — the raw `alloy` contract bindings, for anything this crate
//!   does not wrap.

#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]
#![allow(clippy::missing_errors_doc)]
// `Error` is one enum carrying decoded revert parameters, and the largest
// variant is a little over clippy's 128-byte threshold. The alternative it
// suggests — boxing the error inside every `Result` — would put a `Box` between
// a caller and `match err { Error::CurveGraduated => .. }`, which is the thing
// this type exists to make easy. One error type per SDK was the requirement;
// paying a pointer-sized copy on the unhappy path is the price.
#![allow(clippy::result_large_err)]

/// The exact `alloy` this crate was built against, re-exported.
///
/// An SDK that takes `Address` and `U256` in its signatures and leaves callers
/// to pick their own `alloy` version is an SDK that fails to compile for half of
/// them, with a type error naming two identical-looking types. Depend on this
/// one: `arcnow_sdk::alloy::primitives::Address`.
pub use alloy;

pub mod amount;
pub mod bindings;
pub mod client;
pub mod constants;
pub mod curve;
pub mod curve_math;
pub mod deadline;
pub mod error;
pub mod launchpad;
pub mod migrator_registry;
pub mod network;
pub mod platform;
pub mod pool;
pub mod quote;
pub mod token;

#[cfg(test)]
mod test_rpc;

pub use amount::{
    AmountParseError, Bps, MAX_QUOTE_DECIMALS, NATIVE_QUOTE, NATIVE_USDC, QuoteAmount,
    QuoteTokenInfo, Tokens, Usdc, UsdcErc20,
};
pub use client::{Client, ClientBuilder};
pub use constants::CurveTemplate;
pub use curve::{
    BuyQuote, BuyRequest, BuyResult, Curve, CurveState, SellQuote, SellRequest, SellResult,
};
pub use curve_math::{CurveParams, CurveSnapshot, MathError};
pub use deadline::Deadline;
pub use error::{Error, decode_revert};
pub use launchpad::{
    GRADUATION_GAS_FLOOR, GRADUATION_GAS_LIMIT, LaunchParams, LaunchQuote, LaunchResult, Launchpad,
};
pub use migrator_registry::{MigratorInfo, MigratorRegistry, TaxMode};
pub use network::{ContractAddresses, Network, NetworkConfig, V4Addresses, Venues};
pub use platform::{
    FeeConfig, FeeShare, FeeSplit, NewPlatform, PlatformConfigHandle, PlatformRegistry,
    platform_share_bps,
};
pub use pool::{
    ARC_TOKEN_ALLOWANCE_SLOT, POOL_CREATOR_SHARE_BPS, POOL_LP_FEE_PIPS, POOL_PLATFORM_SHARE_BPS,
    POOL_PROTOCOL_SHARE_BPS, POOL_TICK_SPACING, POOL_TOTAL_FEE_BPS, POOL_TRADE_FEE_BPS, Pool,
    PoolBuyQuote, PoolBuyRequest, PoolKey, PoolSellQuote, PoolSellRequest, PoolTradeResult, Trade,
    TradeBuyQuote, TradeBuyRequest, TradeBuyResult, TradeSellQuote, TradeSellRequest,
    TradeSellResult, Venue, arc_token_allowance_slot, buy_fee_from_quote_in, erc20_allowance_slot,
    pool_currencies, quote_and_token_legs, quote_is_currency0, sell_fee_from_quote_out,
    sell_gross_from_quote_out, sell_quote_out_from_fee, unpack_balance_delta, zero_for_one,
};
pub use quote::{
    EnsureAllowance, POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN, QUOTE_TRANSFER_GAS_HEADROOM_BPS,
    QUOTE_TRANSFER_GAS_HEADROOM_MIN, QuoteInfo, QuoteRegistry, QuoteToken, QuoteTokenListing,
    SpendState, with_pool_quote_transfer_headroom, with_quote_transfer_headroom,
};
pub use token::Token;
