//! The bonding curve's maths, in pure integers, wei-exact against the vectors
//! the contracts generate.
//!
//! # One curve
//!
//! Every arcnow.io bonding curve is the **constant-product** curve,
//! `arcnow/bonding-curve@4.x.x`, quoted in native USDC or an allowlisted ERC-20:
//! `k = r0 · y0`, `Y = y0 - sold`,
//! `C(Y) = ceil(k / Y)`. No transcendentals — one 512-bit multiply and one
//! divide per reserve.
//!
//! [`check_curve_version`] is the one place that decides whether a
//! `VERSION()` is a curve this crate prices. Anything but a `@4.x.x` bonding
//! curve — **including the retired multi-quote `@3.x.x` one, whose trades took
//! a developer address this ABI does not have, and the single-quote `@2.x.x`**
//! — is refused with [`Error::UnknownCurveVersion`], naming the version,
//! because pricing an unknown curve with these formulas is a price the chain
//! will not honour. The maths did not change between 3 and 4; the fee model
//! and the call signatures did.
//!
//! # Why a local port at all
//!
//! [`crate::Curve::quote_buy`] asks the curve itself, and that stays the
//! authority. This module is for everything that cannot make a round trip per
//! number — a price chart, a slider that re-quotes on every keystroke, an
//! indexer replaying history — and for proving, in the fork tests, that the
//! local answer, the chain's quote and the fill are the same integer.
//!
//! Every reserve and amount here is an 18-decimal wad **in the curve's quote**,
//! whatever that quote's own decimals: the curve normalises, and pays out
//! `floor(wad / scale)` raw units of an ERC-20.
//!
//! # Rounding
//!
//! Every rounding favours the curve, exactly as the contracts round: both
//! reserves ceiled, spot prices floored, both fees ceiled. The functions return
//! [`MathError`] wherever the Solidity reverts, with the contracts' own error
//! names.

use alloy::primitives::U256;
use alloy::primitives::aliases::U512;

use crate::curve::CurveState;
use crate::error::Error;

// ---------------------------------------------------------------------------
// which versions are priced
// ---------------------------------------------------------------------------

/// Accept `arcnow/bonding-curve@4.x.x` and nothing else.
///
/// # Errors
///
/// [`Error::UnknownCurveVersion`], naming the string, for a bonding curve of
/// any other version — `@3.x.x` (the retired multi-quote curve, with a
/// developer share), `@2.x.x` (the single-quote curve), `@1.x.x` (the retired
/// linear curve), a missing part, a pre-release suffix. [`Error::AddressIsNotACurve`] for a
/// string that is not a bonding curve's version at all: another component's
/// (`arcnow/arc-token@2.0.0` is a token), or no arcnow.io version.
pub fn check_curve_version(version: &str) -> Result<(), Error> {
    if !version.starts_with("arcnow/bonding-curve@") {
        return Err(Error::AddressIsNotACurve { address: None, version: Some(version.to_owned()) });
    }
    check_component_version("bonding-curve", 4, version)
}

/// Accept `arcnow/platform-config@4.x.x`: a platform with one template per
/// quote, read with `curveParametersFor(quote)`, and a two-share
/// `setFeeShares(creator, ref)`.
///
/// # Errors
/// [`Error::UnknownCurveVersion`] for anything else.
pub fn check_platform_version(version: &str) -> Result<(), Error> {
    check_component_version("platform-config", 4, version)
}

/// Accept `arcnow/platform-registry@4.x.x`: a registry that registers
/// platforms with a creator share, a ref share and a native `targetQuoteWad`
/// template.
///
/// # Errors
/// [`Error::UnknownCurveVersion`] for anything else.
pub fn check_registry_version(version: &str) -> Result<(), Error> {
    check_component_version("platform-registry", 4, version)
}

/// Accept `arcnow/quote-registry@1.x.x`, the allowlist of quote tokens.
///
/// # Errors
/// [`Error::UnknownCurveVersion`] for anything else.
pub fn check_quote_registry_version(version: &str) -> Result<(), Error> {
    check_component_version("quote-registry", 1, version)
}

/// Accept `arcnow/launchpad@3.x.x`, whose `LaunchParams` carry a quote token and
/// a maximum launch fee.
///
/// # Errors
/// [`Error::UnknownCurveVersion`] for anything else.
pub fn check_launchpad_version(version: &str) -> Result<(), Error> {
    check_component_version("launchpad", 3, version)
}

/// Accept `arcnow/uniswap-v4-migrator@2.x.x`, which seeds a pool in either
/// currency order.
///
/// # Errors
/// [`Error::UnknownCurveVersion`] for anything else.
pub fn check_v4_migrator_version(version: &str) -> Result<(), Error> {
    check_component_version("uniswap-v4-migrator", 2, version)
}

fn check_component_version(component: &str, major: u64, version: &str) -> Result<(), Error> {
    if major_of(component, version) == Some(major) {
        Ok(())
    } else {
        Err(Error::UnknownCurveVersion { version: version.to_owned() })
    }
}

/// The major of `arcnow/<component>@MAJOR.MINOR.PATCH`, or `None`.
pub(crate) fn major_of(component: &str, version: &str) -> Option<u64> {
    let rest = version.strip_prefix("arcnow/")?.strip_prefix(component)?.strip_prefix('@')?;
    let mut parts = rest.split('.');
    let major = parts.next()?;
    let minor = parts.next()?;
    let patch = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    for part in [major, minor, patch] {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    major.parse().ok()
}

/// A curve's immutable pricing parameters. The names are the contracts' own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CurveParams {
    /// `V0`, the virtual USDC reserve at launch, wad USDC.
    pub r0_wad: U256,
    /// `Y0`, the virtual token reserve at launch, wad tokens. `k = r0 · y0`.
    pub y0_wad: U256,
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/// Where the contracts' maths would revert, named as they name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum MathError {
    /// `InvalidReserve()`: a zero reserve or parameter.
    #[error("InvalidReserve(): a reserve or a curve parameter is zero, or below R0")]
    InvalidReserve,
    /// `InsufficientReserve(reserve, usdcOut)`.
    #[error(
        "InsufficientReserve({reserve_wad}, {usdc_out_wad}): the payout reaches the whole reserve"
    )]
    InsufficientReserve {
        /// The reserve.
        reserve_wad: U256,
        /// The payout asked for.
        usdc_out_wad: U256,
    },
    /// `InsufficientTokenReserve(tokenReserve, tokensOut)`.
    #[error(
        "InsufficientTokenReserve({token_reserve_wad}, {tokens_out_wad}): the purchase reaches \
         the whole token reserve"
    )]
    InsufficientTokenReserve {
        /// The virtual token reserve.
        token_reserve_wad: U256,
        /// The tokens asked for.
        tokens_out_wad: U256,
    },
    /// `MathOverflow()`: a quotient or sum that does not fit a word.
    #[error("MathOverflow(): an intermediate value does not fit in 256 bits")]
    MathOverflow,
    /// A checked Solidity operation that would `Panic(0x11)`.
    #[error("Panic(0x11): arithmetic underflow or overflow")]
    ArithmeticPanic,
}

type Math<T> = Result<T, MathError>;

// ---------------------------------------------------------------------------
// integer helpers
// ---------------------------------------------------------------------------

/// One whole unit, 18-decimal fixed point.
pub const WAD: U256 = U256::from_limbs([1_000_000_000_000_000_000, 0, 0, 0]);

/// The basis-point denominator.
pub const BPS_DENOMINATOR: U256 = U256::from_limbs([10_000, 0, 0, 0]);

fn add(a: U256, b: U256) -> Math<U256> {
    a.checked_add(b).ok_or(MathError::ArithmeticPanic)
}

fn sub(a: U256, b: U256) -> Math<U256> {
    a.checked_sub(b).ok_or(MathError::ArithmeticPanic)
}

fn mul(a: U256, b: U256) -> Math<U256> {
    a.checked_mul(b).ok_or(MathError::ArithmeticPanic)
}

/// `floor(x * y / d)` at 512 bits, `MathOverflow` when the quotient does not
/// fit — the contracts' guarded `_mulDivDown`.
fn mul_div_down(x: U256, y: U256, d: U256) -> Math<U256> {
    if d.is_zero() {
        return Err(MathError::ArithmeticPanic);
    }
    let product: U512 = x.widening_mul(y);
    narrow(product / U512::from(d))
}

/// `ceil(x * y / d)` at 512 bits — the contracts' guarded `_mulDivUp`.
fn mul_div_up(x: U256, y: U256, d: U256) -> Math<U256> {
    let down = mul_div_down(x, y, d)?;
    let product: U512 = x.widening_mul(y);
    if (product % U512::from(d)).is_zero() {
        Ok(down)
    } else {
        down.checked_add(U256::from(1)).ok_or(MathError::MathOverflow)
    }
}

fn narrow(wide: U512) -> Math<U256> {
    let limbs = wide.as_limbs();
    if limbs[4..].iter().any(|limb| *limb != 0) {
        return Err(MathError::MathOverflow);
    }
    Ok(U256::from_limbs([limbs[0], limbs[1], limbs[2], limbs[3]]))
}

/// `ceil(amount * bps / 10_000)` — the trade fee, rounded up.
///
/// # Errors
/// [`MathError::ArithmeticPanic`] where the Solidity would overflow.
pub fn fee_up(amount_wad: U256, bps: U256) -> Math<U256> {
    Ok(add(mul(amount_wad, bps)?, BPS_DENOMINATOR - U256::from(1))? / BPS_DENOMINATOR)
}

/// `ceil(net * 10_000 / (10_000 - bps))` — the smallest gross whose net after
/// [`fee_up`] is at least `net`.
///
/// # Errors
/// [`MathError::ArithmeticPanic`] where the Solidity would overflow or `bps`
/// reaches the denominator.
pub fn gross_for_net_up(net_wad: U256, bps: U256) -> Math<U256> {
    let denominator = sub(BPS_DENOMINATOR, bps)?;
    if denominator.is_zero() {
        return Err(MathError::ArithmeticPanic);
    }
    Ok(add(mul(net_wad, BPS_DENOMINATOR)?, denominator - U256::from(1))? / denominator)
}

// ---------------------------------------------------------------------------
// CurveMath, function for function
// ---------------------------------------------------------------------------

/// `C(Y) = ceil(r0 · y0 / Y)`, the USDC reserve the curve holds at token
/// reserve `Y`. Rounds up.
///
/// # Errors
/// `InvalidReserve` for a zero argument; `MathOverflow`.
pub fn usdc_reserve_at(r0_wad: U256, y0_wad: U256, token_reserve_wad: U256) -> Math<U256> {
    if r0_wad.is_zero() || y0_wad.is_zero() || token_reserve_wad.is_zero() {
        return Err(MathError::InvalidReserve);
    }
    mul_div_up(r0_wad, y0_wad, token_reserve_wad)
}

/// `Y(V) = ceil(r0 · y0 / V)`. Rounds up.
///
/// # Errors
/// `InvalidReserve` for a zero argument; `MathOverflow`.
pub fn token_reserve_at(r0_wad: U256, y0_wad: U256, usdc_reserve_wad: U256) -> Math<U256> {
    if r0_wad.is_zero() || y0_wad.is_zero() || usdc_reserve_wad.is_zero() {
        return Err(MathError::InvalidReserve);
    }
    mul_div_up(r0_wad, y0_wad, usdc_reserve_wad)
}

/// `floor(C(Y) · 1e18 / Y)` at a token reserve `Y`. Rounds down.
///
/// # Errors
/// As [`usdc_reserve_at`].
pub fn spot_price_at_reserve_wad(
    r0_wad: U256,
    y0_wad: U256,
    token_reserve_wad: U256,
) -> Math<U256> {
    mul_div_down(usdc_reserve_at(r0_wad, y0_wad, token_reserve_wad)?, WAD, token_reserve_wad)
}

/// `Y - ceil(k / (C(Y) + Δ))`. Rounds down.
///
/// # Errors
/// As [`usdc_reserve_at`]; `MathOverflow` when `C(Y) + Δ` wraps.
pub fn tokens_out_for_usdc_in(
    r0_wad: U256,
    y0_wad: U256,
    token_reserve_wad: U256,
    usdc_in_wad: U256,
) -> Math<U256> {
    let reserve = usdc_reserve_at(r0_wad, y0_wad, token_reserve_wad)?;
    let new_reserve = reserve.checked_add(usdc_in_wad).ok_or(MathError::MathOverflow)?;
    sub(token_reserve_wad, mul_div_up(r0_wad, y0_wad, new_reserve)?)
}

/// `C(Y) - C(Y + t)`. Rounds down.
///
/// # Errors
/// As [`usdc_reserve_at`]; `MathOverflow` when `Y + t` wraps.
pub fn usdc_out_for_tokens_in(
    r0_wad: U256,
    y0_wad: U256,
    token_reserve_wad: U256,
    tokens_in_wad: U256,
) -> Math<U256> {
    let reserve = usdc_reserve_at(r0_wad, y0_wad, token_reserve_wad)?;
    let new_token_reserve =
        token_reserve_wad.checked_add(tokens_in_wad).ok_or(MathError::MathOverflow)?;
    sub(reserve, mul_div_up(r0_wad, y0_wad, new_token_reserve)?)
}

/// `C(Y - t) - C(Y)`. Rounds up.
///
/// # Errors
/// `InsufficientTokenReserve` when `t >= Y`; as [`usdc_reserve_at`].
pub fn usdc_in_for_tokens_out(
    r0_wad: U256,
    y0_wad: U256,
    token_reserve_wad: U256,
    tokens_out_wad: U256,
) -> Math<U256> {
    if tokens_out_wad >= token_reserve_wad {
        return Err(MathError::InsufficientTokenReserve { token_reserve_wad, tokens_out_wad });
    }
    let reserve = usdc_reserve_at(r0_wad, y0_wad, token_reserve_wad)?;
    sub(mul_div_up(r0_wad, y0_wad, token_reserve_wad - tokens_out_wad)?, reserve)
}

/// `ceil(k / (C(Y) - u)) - Y`, zero for `u == 0`. Rounds up.
///
/// # Errors
/// `InsufficientReserve` when `u >= C(Y)`; as [`usdc_reserve_at`].
pub fn tokens_in_for_usdc_out(
    r0_wad: U256,
    y0_wad: U256,
    token_reserve_wad: U256,
    usdc_out_wad: U256,
) -> Math<U256> {
    let reserve = usdc_reserve_at(r0_wad, y0_wad, token_reserve_wad)?;
    if usdc_out_wad >= reserve {
        return Err(MathError::InsufficientReserve { reserve_wad: reserve, usdc_out_wad });
    }
    if usdc_out_wad.is_zero() {
        return Ok(U256::ZERO);
    }
    sub(mul_div_up(r0_wad, y0_wad, reserve - usdc_out_wad)?, token_reserve_wad)
}

// ---------------------------------------------------------------------------
// CurveQuote
// ---------------------------------------------------------------------------

/// Everything about a curve a fill depends on: `CurveQuote.CurveState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveSnapshot {
    /// The curve's immutable pricing parameters.
    pub params: CurveParams,
    /// The virtual quote reserve: `r0` plus the real quote in the curve, wad.
    pub reserve_wad: U256,
    /// Tokens sold so far.
    pub tokens_sold_wad: U256,
    /// Real quote required to graduate, wad.
    pub target_quote_wad: U256,
    /// Tokens the curve sells over its life.
    pub curve_supply_wad: U256,
    /// The trade fee, in basis points, charged on both sides.
    pub trade_fee_bps: U256,
}

impl CurveSnapshot {
    /// A curve nobody has traded: reserve `r0`, nothing sold. What
    /// `Launchpad.quoteLaunch` prices an initial buy against.
    #[must_use]
    pub const fn fresh(
        params: CurveParams,
        target_quote_wad: U256,
        curve_supply_wad: U256,
        trade_fee_bps: U256,
    ) -> Self {
        Self {
            params,
            reserve_wad: params.r0_wad,
            tokens_sold_wad: U256::ZERO,
            target_quote_wad,
            curve_supply_wad,
            trade_fee_bps,
        }
    }

    /// The snapshot of a curve's state as [`crate::Curve::state`] read it.
    #[must_use]
    pub fn from_state(state: &CurveState) -> Self {
        Self {
            params: state.params,
            reserve_wad: state.virtual_reserve.to_wad(),
            tokens_sold_wad: state.tokens_sold.to_wad(),
            target_quote_wad: state.target.to_wad(),
            curve_supply_wad: state.curve_supply.to_wad(),
            trade_fee_bps: state.trade_fee_bps.to_u256(),
        }
    }

    fn token_reserve(&self) -> Math<U256> {
        sub(self.params.y0_wad, self.tokens_sold_wad)
    }
}

/// A priced buy: `IBondingCurve.BuyQuote`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawBuyQuote {
    /// Tokens delivered.
    pub tokens_out_wad: U256,
    /// The trade fee, wad quote.
    pub fee_quote_wad: U256,
    /// Gross quote consumed, fee included, wad.
    pub quote_spent_wad: U256,
    /// Gross quote handed back because the buy was capped, wad.
    pub refund_wad: U256,
    /// The virtual reserve after the trade.
    pub new_reserve_wad: U256,
    /// Tokens sold after the trade.
    pub new_tokens_sold_wad: U256,
    /// The spot price after the trade.
    pub new_price_wad: U256,
    /// True when the trade reaches the target or clears the inventory.
    pub graduates: bool,
}

/// A priced sell: `IBondingCurve.SellQuote`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawSellQuote {
    /// Quote paid out, net of fee, wad.
    pub quote_out_wad: U256,
    /// The trade fee, wad quote.
    pub fee_quote_wad: U256,
    /// Quote leaving the reserve before the fee, wad.
    pub gross_quote_wad: U256,
    /// The virtual reserve after the trade.
    pub new_reserve_wad: U256,
    /// Tokens sold after the trade.
    pub new_tokens_sold_wad: U256,
    /// The spot price after the trade.
    pub new_price_wad: U256,
}

/// A priced launch: `ILaunchpad.quoteLaunch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawLaunchQuote {
    /// The exact `msg.value` a launch requires: launch fee plus initial buy.
    pub total_cost_wad: U256,
    /// Tokens the initial buy delivers.
    pub tokens_out_wad: U256,
    /// The trade fee the initial buy pays, on top of the launch fee.
    pub trade_fee_wad: U256,
}

/// The spot price of a curve in this state, wad USDC per wad token.
///
/// # Errors
/// Where the contracts' `spotPriceWad` reverts.
pub fn spot_price_wad(s: &CurveSnapshot) -> Math<U256> {
    spot_price_at_reserve_wad(s.params.r0_wad, s.params.y0_wad, s.token_reserve()?)
}

/// `graduationProgressBps()`: `realReserve * 10_000 / target`, capped at 10,000.
///
/// # Errors
/// [`MathError::ArithmeticPanic`] for a zero target or a reserve below `r0`.
pub fn progress_bps(s: &CurveSnapshot) -> Math<U256> {
    if s.target_quote_wad.is_zero() {
        return Err(MathError::ArithmeticPanic);
    }
    let real = sub(s.reserve_wad, s.params.r0_wad)?;
    let progress = mul(real, BPS_DENOMINATOR)? / s.target_quote_wad;
    Ok(progress.min(BPS_DENOMINATOR))
}

/// `CurveQuote.maxNetIn`: the lesser of the target headroom and the cost of
/// every token the curve still holds.
///
/// # Errors
/// Where the Solidity reverts.
pub fn max_net_in(s: &CurveSnapshot) -> Math<U256> {
    let real = sub(s.reserve_wad, s.params.r0_wad)?;
    let headroom = s.target_quote_wad.saturating_sub(real);
    let remaining = s.curve_supply_wad.saturating_sub(s.tokens_sold_wad);
    if remaining.is_zero() {
        return Ok(U256::ZERO);
    }
    let inventory_cost =
        usdc_in_for_tokens_out(s.params.r0_wad, s.params.y0_wad, s.token_reserve()?, remaining)?;
    Ok(headroom.min(inventory_cost))
}

/// Price a buy of `usdc_in_wad` gross USDC: `CurveQuote.quoteBuy`.
///
/// A zero input prices to zero, as the vectors say. A live curve rejects a zero
/// **buy** with `ZeroAmount` and refuses every trade once graduated; this
/// prices, and nothing else.
///
/// # Errors
/// Where the contracts' quote reverts.
pub fn quote_buy(s: &CurveSnapshot, usdc_in_wad: U256) -> Math<RawBuyQuote> {
    let CurveParams { r0_wad, y0_wad } = s.params;
    let mut fee = fee_up(usdc_in_wad, s.trade_fee_bps)?;
    let mut net = sub(usdc_in_wad, fee)?;
    let cap = max_net_in(s)?;
    let mut gross_used = usdc_in_wad;
    if net > cap {
        net = cap;
        gross_used = gross_for_net_up(net, s.trade_fee_bps)?;
        fee = sub(gross_used, net)?;
    }
    let remaining = sub(s.curve_supply_wad, s.tokens_sold_wad)?;
    let tokens_out = if net.is_zero() {
        U256::ZERO
    } else {
        tokens_out_for_usdc_in(r0_wad, y0_wad, s.token_reserve()?, net)?
    }
    .min(remaining);
    let new_reserve = add(s.reserve_wad, net)?;
    let new_sold = add(s.tokens_sold_wad, tokens_out)?;
    Ok(RawBuyQuote {
        tokens_out_wad: tokens_out,
        fee_quote_wad: fee,
        quote_spent_wad: gross_used,
        refund_wad: sub(usdc_in_wad, gross_used)?,
        new_reserve_wad: new_reserve,
        new_tokens_sold_wad: new_sold,
        new_price_wad: spot_price_at_reserve_wad(r0_wad, y0_wad, sub(y0_wad, new_sold)?)?,
        graduates: sub(new_reserve, r0_wad)? >= s.target_quote_wad
            || new_sold >= s.curve_supply_wad,
    })
}

/// Price a sell of `tokens_in_wad` tokens: `CurveQuote.quoteSell`.
///
/// # Errors
/// Where the contracts' quote reverts — including an underflow when
/// `tokens_in_wad` exceeds the tokens sold, which the curve itself reports as
/// `ExceedsTokensSold` before it prices anything.
pub fn quote_sell(s: &CurveSnapshot, tokens_in_wad: U256) -> Math<RawSellQuote> {
    let CurveParams { r0_wad, y0_wad } = s.params;
    let token_reserve = s.token_reserve()?;
    let gross = usdc_out_for_tokens_in(r0_wad, y0_wad, token_reserve, tokens_in_wad)?;
    let fee = fee_up(gross, s.trade_fee_bps)?;
    Ok(RawSellQuote {
        quote_out_wad: sub(gross, fee)?,
        fee_quote_wad: fee,
        gross_quote_wad: gross,
        new_reserve_wad: sub(s.reserve_wad, gross)?,
        new_tokens_sold_wad: sub(s.tokens_sold_wad, tokens_in_wad)?,
        new_price_wad: spot_price_at_reserve_wad(
            r0_wad,
            y0_wad,
            add(token_reserve, tokens_in_wad)?,
        )?,
    })
}

/// Price a launch: the flat fee plus an ordinary buy of `initial_buy_wad`
/// against the fresh curve `fresh` — `ILaunchpad.quoteLaunch`.
///
/// # Errors
/// Where the contracts' quote reverts.
pub fn quote_launch(
    fresh: &CurveSnapshot,
    launch_fee_wad: U256,
    initial_buy_wad: U256,
) -> Math<RawLaunchQuote> {
    let buy = quote_buy(fresh, initial_buy_wad)?;
    Ok(RawLaunchQuote {
        total_cost_wad: add(launch_fee_wad, initial_buy_wad)?,
        tokens_out_wad: buy.tokens_out_wad,
        trade_fee_wad: buy.fee_quote_wad,
    })
}
