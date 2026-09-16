//! Money and quantity types, and the 18-versus-6 problem they exist to solve.
//!
//! # The fact that breaks everything if you get it wrong
//!
//! On Arc, **USDC is the native gas currency and `msg.value` is 18 decimals**.
//! The USDC ERC-20 interface predeploy at
//! `0x3600000000000000000000000000000000000000` is the *same asset* reporting
//! **6** decimals; it does not pay for gas, and no arcnow.io contract reads,
//! writes, calls or imports it. The two raw representations of one dollar differ
//! by a factor of `1e12`. Getting it wrong puts every amount out by a factor of
//! a trillion — in whichever direction happens to be worse.
//!
//! Every amount in every arcnow.io function signature, event, error and storage
//! slot is an 18-decimal fixed-point integer ("wad"). There is no 6-decimal
//! number anywhere in the contracts, and there is none anywhere in this SDK's
//! call path either.
//!
//! # Why these are newtypes and not `U256`
//!
//! Three quantities in this system are 256-bit unsigned integers and mean three
//! different things: native USDC, the same USDC seen through a 6-decimal
//! interface, and a launched token's supply. A plain `U256` makes all three the
//! same type, and the compiler will happily let you pay a curve a token balance.
//! So:
//!
//! * [`Usdc`] is native USDC, 18 decimals, and the **only** type any
//!   value-bearing API in this crate accepts.
//! * [`UsdcErc20`] is the 6-decimal view, and exists **only** so a wallet-facing
//!   caller can convert at the edge. Nothing in the call path accepts or returns
//!   it.
//! * [`Tokens`] is a launched-token quantity, 18 decimals, distinct from
//!   [`Usdc`] so that a token amount cannot be handed to something that wants
//!   dollars.
//!
//! # Quote tokens
//!
//! A curve is quoted in native USDC **or** in an allowlisted ERC-20 such as EURC
//! at 6 decimals. Every amount the contracts sign, emit or store is still an
//! 18-decimal wad, normalised; what the chain actually moves of an ERC-20 is
//! `wad / scale` raw units, with `scale = 10^(18 - decimals)`. So [`Usdc`] is
//! now [`QuoteAmount`] — a wad **and the quote it is denominated in** — and
//! `Usdc::from_whole`, `Usdc::parse` and the rest keep building native USDC.
//! Arithmetic across two quotes is [`Error::QuoteTokenMismatch`], and a wad an
//! ERC-20 cannot carry is refused with [`Error::QuoteAmountNotRepresentable`]
//! rather than truncated in transit.
//!
//! **There is deliberately no `From<u64>` on any of them.** A bare integer does
//! not say which scale it is in, and a constructor that guesses is a constructor
//! that is wrong half the time and silent about it. Every way into these types
//! names its scale: [`Usdc::from_whole`], [`Usdc::from_wad`], [`Usdc::parse`],
//! and the two explicitly named ERC-20 conversions.

use core::cmp::Ordering;
use core::fmt;
use core::hash::{Hash, Hasher};
use core::ops::{Add, AddAssign, Sub, SubAssign};
use core::str::FromStr;
use std::borrow::Cow;

use alloy::primitives::{Address, U256};

use crate::error::Error;

/// Decimals every arcnow.io amount is denominated in.
pub const WAD_DECIMALS: u8 = 18;

/// Decimals the USDC ERC-20 interface predeploy on Arc reports.
///
/// Mirrors `ArcConstants.USDC_ERC20_DECIMALS`.
pub const USDC_ERC20_DECIMALS: u8 = 6;

/// One whole unit in 18-decimal fixed point.
///
/// Mirrors `ArcConstants.WAD`.
pub const WAD: u128 = 1_000_000_000_000_000_000;

/// The factor between the 6-decimal ERC-20 view of USDC and the 18-decimal
/// native one.
///
/// Mirrors `ArcConstants.USDC_ERC20_SCALE`. `wad = units * USDC_ERC20_SCALE`,
/// and the reverse division **truncates towards zero**; see
/// [`Usdc::to_erc20`].
pub const USDC_ERC20_SCALE: u128 = 1_000_000_000_000;

/// Why a decimal string could not be read as an amount.
///
/// Every variant names the string it was given, because "invalid amount" with no
/// input in it is a message a caller cannot act on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AmountParseError {
    /// The string was empty, or was nothing but a decimal point.
    #[error("{input:?} is not a number. Write a decimal figure such as \"1.25\" or \"50000\".")]
    Empty {
        /// What was passed.
        input: String,
    },

    /// The string held something that is not a digit or a single decimal point.
    #[error(
        "{input:?} is not a plain decimal figure: {reason}. This parser takes digits and at most \
         one '.' — no sign, no exponent, no thousands separators and no currency symbol, because \
         every one of those is a place two readers could disagree about what was meant."
    )]
    Malformed {
        /// What was passed.
        input: String,
        /// What specifically was wrong with it.
        reason: &'static str,
    },

    /// More fractional digits than the scale can hold.
    ///
    /// Refused rather than truncated. Silently dropping the tail of an amount is
    /// how a caller ends up sending a different number from the one they typed,
    /// and finds out from a balance rather than from an error.
    #[error(
        "{input:?} has {found} fractional digits and this amount holds {decimals}. Nothing here \
         rounds an amount you wrote down: shorten it to {decimals} decimals yourself, so the \
         number that is sent is the number you chose."
    )]
    TooPrecise {
        /// What was passed.
        input: String,
        /// How many fractional digits it carried.
        found: usize,
        /// How many the type can represent.
        decimals: u8,
    },

    /// The digits do not fit in 256 bits.
    #[error("{input:?} does not fit in a 256-bit integer at {decimals} decimals.")]
    Overflow {
        /// What was passed.
        input: String,
        /// The scale it was being read at.
        decimals: u8,
    },
}

/// Parse a decimal string into a raw integer at `decimals` decimals.
fn parse_fixed(input: &str, decimals: u8) -> Result<U256, AmountParseError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AmountParseError::Empty { input: input.to_owned() });
    }
    let (whole, fraction) = match trimmed.split_once('.') {
        Some((w, f)) => {
            if f.contains('.') {
                return Err(AmountParseError::Malformed {
                    input: input.to_owned(),
                    reason: "more than one decimal point",
                });
            }
            (w, f)
        }
        None => (trimmed, ""),
    };
    if whole.is_empty() && fraction.is_empty() {
        return Err(AmountParseError::Empty { input: input.to_owned() });
    }
    for part in [whole, fraction] {
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AmountParseError::Malformed {
                input: input.to_owned(),
                reason: "it holds something that is not a digit",
            });
        }
    }
    if fraction.len() > usize::from(decimals) {
        return Err(AmountParseError::TooPrecise {
            input: input.to_owned(),
            found: fraction.len(),
            decimals,
        });
    }

    let mut digits = String::with_capacity(whole.len() + usize::from(decimals));
    digits.push_str(if whole.is_empty() { "0" } else { whole });
    digits.push_str(fraction);
    for _ in fraction.len()..usize::from(decimals) {
        digits.push('0');
    }
    U256::from_str_radix(&digits, 10)
        .map_err(|_| AmountParseError::Overflow { input: input.to_owned(), decimals })
}

/// Render a raw integer at `decimals` decimals, with no trailing zeros.
fn format_fixed(raw: U256, decimals: u8) -> String {
    let scale = U256::from(10u8).pow(U256::from(decimals));
    let whole = raw / scale;
    let fraction = raw % scale;
    if fraction.is_zero() {
        return whole.to_string();
    }
    let digits = fraction.to_string();
    let mut out = whole.to_string();
    out.push('.');
    for _ in digits.len()..usize::from(decimals) {
        out.push('0');
    }
    out.push_str(digits.trim_end_matches('0'));
    out
}

/// Generate the body of an 18-decimal quantity newtype.
macro_rules! wad_amount {
    ($name:ident, $unit:literal, $what:literal) => {
        impl $name {
            /// The scale this amount is denominated in: 18 decimals.
            pub const DECIMALS: u8 = WAD_DECIMALS;

            /// Nothing.
            pub const ZERO: Self = Self(U256::ZERO);

            /// The largest representable amount.
            ///
            /// Not a balance anyone has; it is here for bounds and for
            /// [`crate::Deadline::none`]-style opt-outs.
            pub const MAX: Self = Self(U256::MAX);

            #[doc = concat!("Build from whole ", $what, ", the unit a human says out loud.")]
            ///
            #[doc = concat!("`", stringify!($name), "::from_whole(50)` is fifty ", $what, ", i.e. `50e18` raw.")]
            #[must_use]
            pub fn from_whole(whole: u64) -> Self {
                Self(U256::from(whole) * U256::from(WAD))
            }

            /// Build from the raw 18-decimal integer, which is what the
            /// contracts, the events and the RPC all speak.
            #[must_use]
            pub const fn from_wad(wad: U256) -> Self {
                Self(wad)
            }

            #[doc = concat!("Read an exact decimal figure of ", $what, ", such as `\"1.25\"`.")]
            ///
            /// **Exact, and refuses to round.**
            ///
            /// # Errors
            ///
            /// [`AmountParseError`] when the string is not a plain decimal
            /// figure, carries more than 18 fractional digits, or does not fit
            /// in 256 bits.
            pub fn parse(input: &str) -> Result<Self, AmountParseError> {
                parse_fixed(input, Self::DECIMALS).map(Self)
            }

            /// The raw 18-decimal integer, for encoding into a call.
            #[must_use]
            pub const fn to_wad(self) -> U256 {
                self.0
            }

            /// True when this amount is nothing at all.
            #[must_use]
            pub fn is_zero(self) -> bool {
                self.0.is_zero()
            }

            /// Sum, or `None` on overflow.
            #[must_use]
            pub fn checked_add(self, other: Self) -> Option<Self> {
                self.0.checked_add(other.0).map(Self)
            }

            /// Difference, or `None` when `other` is the larger.
            #[must_use]
            pub fn checked_sub(self, other: Self) -> Option<Self> {
                self.0.checked_sub(other.0).map(Self)
            }

            /// Difference, floored at zero.
            #[must_use]
            pub fn saturating_sub(self, other: Self) -> Self {
                Self(self.0.saturating_sub(other.0))
            }

            /// This amount less `tolerance` basis points **of this amount**,
            /// floored — the slippage floor to send with a trade quoted at this
            /// size. 50 bps of 100 is 99.5.
            #[must_use]
            pub fn less_tolerance(self, tolerance: crate::Bps) -> Self {
                Self(less_tolerance(self.0, tolerance))
            }
        }

        impl fmt::Display for $name {
            #[doc = concat!("Renders a decimal figure of ", $what, ", **not** the raw integer.")]
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&format_fixed(self.0, Self::DECIMALS))
            }
        }

        impl FromStr for $name {
            type Err = AmountParseError;

            fn from_str(input: &str) -> Result<Self, Self::Err> {
                Self::parse(input)
            }
        }

        impl Add for $name {
            type Output = Self;

            /// # Panics
            ///
            /// On overflow, like every other integer addition in Rust.
            fn add(self, other: Self) -> Self {
                Self(self.0 + other.0)
            }
        }

        impl AddAssign for $name {
            fn add_assign(&mut self, other: Self) {
                self.0 += other.0;
            }
        }

        impl Sub for $name {
            type Output = Self;

            /// # Panics
            ///
            /// When `other` is the larger: there is no negative amount.
            fn sub(self, other: Self) -> Self {
                Self(self.0 - other.0)
            }
        }

        impl SubAssign for $name {
            fn sub_assign(&mut self, other: Self) {
                self.0 -= other.0;
            }
        }

        impl core::iter::Sum for $name {
            fn sum<I: Iterator<Item = Self>>(iter: I) -> Self {
                iter.fold(Self::ZERO, Add::add)
            }
        }

        // The unit is carried in the Debug output so a failing assertion says
        // which quantity it was looking at.
        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{} {}", format_fixed(self.0, Self::DECIMALS), $unit)
            }
        }
    };
}

/// `amount` less `tolerance` bps of itself, floored.
fn less_tolerance(amount: U256, tolerance: Bps) -> U256 {
    let denominator = U256::from(Bps::DENOMINATOR);
    let kept = denominator.saturating_sub(U256::from(tolerance.get()));
    amount * kept / denominator
}

// ---------------------------------------------------------------------------
// quote tokens
// ---------------------------------------------------------------------------

/// The quote address that means **native USDC**: the zero address.
///
/// Not an ERC-20 at `address(0)`. A curve quoted here is paid with `msg.value`,
/// exactly as every curve was before quote tokens existed.
pub const NATIVE_QUOTE: Address = Address::ZERO;

/// The most decimals a quote token may declare: 18, the wad itself.
///
/// Mirrors `ArcConstants.MAX_QUOTE_DECIMALS`.
pub const MAX_QUOTE_DECIMALS: u8 = 18;

/// Native USDC as a quote: the zero address, 18 decimals, paid as `msg.value`.
pub const NATIVE_USDC: QuoteTokenInfo = QuoteTokenInfo {
    address: NATIVE_QUOTE,
    symbol: Cow::Borrowed("USDC"),
    name: Cow::Borrowed("USD Coin"),
    decimals: WAD_DECIMALS,
    is_native: true,
};

/// What a curve, a pool or a launch is priced in.
///
/// `symbol` and `name` are `Cow<'static, str>` rather than `String` so that
/// [`NATIVE_USDC`], `Usdc::ZERO` and `Usdc::MAX` can stay constants. Compare
/// quotes by [`QuoteTokenInfo::address`]: the metadata is descriptive, and the
/// address is what the contracts compare.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct QuoteTokenInfo {
    /// The ERC-20, or [`NATIVE_QUOTE`] for native USDC.
    pub address: Address,
    /// Ticker, as the token (or `networks.json`) reports it.
    pub symbol: Cow<'static, str>,
    /// Name, as the token (or `networks.json`) reports it.
    pub name: Cow<'static, str>,
    /// The token's decimals. At most [`MAX_QUOTE_DECIMALS`]; 18 for native.
    pub decimals: u8,
    /// True exactly when `address` is [`NATIVE_QUOTE`].
    pub is_native: bool,
}

impl QuoteTokenInfo {
    /// An ERC-20 quote, validated.
    ///
    /// # Errors
    /// [`Error::InvalidArgument`] for the zero address (that is native USDC,
    /// [`NATIVE_USDC`]) or more than 18 decimals.
    pub fn erc20(
        address: Address,
        symbol: impl Into<Cow<'static, str>>,
        name: impl Into<Cow<'static, str>>,
        decimals: u8,
    ) -> Result<Self, Error> {
        let info =
            Self { address, symbol: symbol.into(), name: name.into(), decimals, is_native: false };
        info.validate()?;
        Ok(info)
    }

    /// Check the three rules every quote obeys: at most 18 decimals, native
    /// exactly when the address is zero, and native only at 18 decimals.
    ///
    /// # Errors
    /// [`Error::InvalidArgument`] naming the rule that failed.
    pub fn validate(&self) -> Result<(), Error> {
        let reason = if self.decimals > MAX_QUOTE_DECIMALS {
            format!(
                "{} declares {} decimals and a quote holds at most {MAX_QUOTE_DECIMALS}: every \
                 amount is an 18-decimal wad, and a 19th decimal has nowhere to go",
                self.address, self.decimals
            )
        } else if self.is_native != self.address.is_zero() {
            format!(
                "{} is marked {} and a quote is native exactly when its address is the zero \
                 address",
                self.address,
                if self.is_native { "native" } else { "an ERC-20" }
            )
        } else if self.is_native && self.decimals != WAD_DECIMALS {
            format!(
                "native USDC is 18 decimals on Arc (msg.value), and this declares {}",
                self.decimals
            )
        } else {
            return Ok(());
        };
        Err(Error::InvalidArgument { reason })
    }

    /// `10^(18 - decimals)`: what one raw unit of this token is in wad.
    ///
    /// `1` for native USDC and any 18-decimal token, `1e12` for EURC.
    #[must_use]
    pub fn scale(&self) -> U256 {
        U256::from(10u8).pow(U256::from(WAD_DECIMALS.saturating_sub(self.decimals)))
    }

    /// True when `other` is the same quote: the same address.
    #[must_use]
    pub fn same_quote(&self, other: &Self) -> bool {
        self.address == other.address
    }

    /// Refuse `actual` unless it is this quote.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`].
    pub fn require_same(&self, actual: &Self) -> Result<(), Error> {
        if self.same_quote(actual) {
            Ok(())
        } else {
            Err(Error::QuoteTokenMismatch { expected: self.address, actual: actual.address })
        }
    }
}

/// An amount of a quote token: an 18-decimal wad **and** the quote it is in.
///
/// [`Usdc`] is this type, and its constructors (`Usdc::from_whole`,
/// `Usdc::parse`, `Usdc::ZERO`, …) build **native** USDC. For any other quote
/// use [`QuoteAmount::parse_in`], [`QuoteAmount::from_raw_in`] or
/// [`QuoteAmount::from_wad_in`].
///
/// Equality compares the quote's **address** and the wad. Two amounts in
/// different quotes are never equal and are not ordered (`partial_cmp` is
/// `None`); the fallible [`QuoteAmount::add`], [`QuoteAmount::sub`],
/// [`QuoteAmount::compare`] and friends say [`Error::QuoteTokenMismatch`]
/// instead. The `+` and `-` operators panic on a mismatch, as they do on
/// overflow.
///
/// ```
/// use arcnow_sdk::{QuoteAmount, QuoteTokenInfo, Usdc};
/// use arcnow_sdk::alloy::primitives::address;
///
/// let eurc = QuoteTokenInfo::erc20(
///     address!("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"), "EURC", "EURC", 6,
/// ).unwrap();
/// let amount = QuoteAmount::parse_in(&eurc, "1.5").unwrap();
/// assert_eq!(amount.format(), "1.5 EURC");
/// assert_eq!(amount.to_raw().unwrap().to_string(), "1500000");
/// assert!(amount.add(&Usdc::from_whole(1)).is_err());
/// ```
#[derive(Clone)]
pub struct QuoteAmount {
    token: QuoteTokenInfo,
    wad: U256,
}

/// Native USDC on Arc, as an 18-decimal wad: [`QuoteAmount`] in
/// [`NATIVE_USDC`].
///
/// On Arc, USDC is the gas currency: a native buy is paid as `msg.value`, and
/// `msg.value` is 18 decimals — which is not true of the 6-decimal ERC-20 view.
/// See [`UsdcErc20`].
///
/// ```
/// use arcnow_sdk::Usdc;
///
/// assert_eq!(Usdc::from_whole(50_000).to_string(), "50000");
/// assert_eq!(Usdc::parse("1.25").unwrap().to_wad().to_string(), "1250000000000000000");
/// // Eighteen decimals is the limit, and the nineteenth is an error, never a round.
/// assert!(Usdc::parse("0.0000000000000000001").is_err());
/// ```
pub type Usdc = QuoteAmount;

impl QuoteAmount {
    /// The scale every amount is carried in: 18 decimals.
    pub const DECIMALS: u8 = WAD_DECIMALS;

    /// No native USDC.
    pub const ZERO: Self = Self { token: NATIVE_USDC, wad: U256::ZERO };

    /// The largest native amount. A bound, not a balance.
    pub const MAX: Self = Self { token: NATIVE_USDC, wad: U256::MAX };

    // ------------------------------------------------ native constructors

    /// Whole native USDC: `Usdc::from_whole(50)` is `50e18` wad.
    #[must_use]
    pub fn from_whole(whole: u64) -> Self {
        Self::from_wad(U256::from(whole) * U256::from(WAD))
    }

    /// Native USDC from its 18-decimal integer, which is what the contracts,
    /// the events and the RPC speak. No scaling.
    #[must_use]
    pub const fn from_wad(wad: U256) -> Self {
        Self { token: NATIVE_USDC, wad }
    }

    /// Read an exact decimal figure of native USDC, such as `"1.25"`.
    ///
    /// **Exact, and refuses to round**: a 19th fractional digit is an error.
    ///
    /// # Errors
    /// [`AmountParseError`] when the string is not a plain decimal figure,
    /// carries more than 18 fractional digits, or does not fit in 256 bits.
    pub fn parse(input: &str) -> Result<Self, AmountParseError> {
        Self::parse_in(&NATIVE_USDC, input)
    }

    /// Convert **up** from the 6-decimal ERC-20 view of native USDC. Exact:
    /// `units * 1e12`.
    #[must_use]
    pub fn from_erc20(units: UsdcErc20) -> Self {
        Self::from_wad(units.to_units() * U256::from(USDC_ERC20_SCALE))
    }

    /// Convert native USDC **down** to its 6-decimal ERC-20 view. **Truncates
    /// towards zero**: a wad amount can carry dust six decimals cannot express,
    /// and rounding up would promise dollars that do not exist.
    ///
    /// Use it to *display* a figure next to a wallet balance, not to decide
    /// what to send.
    ///
    /// # Errors
    /// [`Error::InvalidArgument`] for an amount in any quote but native USDC.
    pub fn to_erc20(&self) -> Result<UsdcErc20, Error> {
        if !self.token.is_native {
            return Err(Error::InvalidArgument {
                reason: format!(
                    "the 6-decimal ERC-20 view exists only for native USDC, and this amount is \
                     in {} ({})",
                    self.token.symbol, self.token.address
                ),
            });
        }
        Ok(UsdcErc20(self.wad / U256::from(USDC_ERC20_SCALE)))
    }

    // ------------------------------------------------ quote constructors

    /// An amount of `token` from its 18-decimal wad, unchecked for
    /// representability — see [`QuoteAmount::is_representable`].
    #[must_use]
    pub fn from_wad_in(token: &QuoteTokenInfo, wad: U256) -> Self {
        Self { token: token.clone(), wad }
    }

    /// An amount of `token` from its raw units, as its `balanceOf` returns
    /// them: `raw * scale`.
    ///
    /// # Errors
    /// [`Error::InvalidArgument`] when the wad does not fit in 256 bits.
    pub fn from_raw_in(token: &QuoteTokenInfo, raw: U256) -> Result<Self, Error> {
        let wad = raw.checked_mul(token.scale()).ok_or_else(|| Error::InvalidArgument {
            reason: format!("{raw} raw {} does not fit in a 256-bit wad", token.symbol),
        })?;
        Ok(Self::from_wad_in(token, wad))
    }

    /// Read an exact decimal figure of `token`, in **its own** decimals:
    /// `"1.25"` of EURC is 1,250,000 raw. More fractional digits than the token
    /// has is an error, never a rounding.
    ///
    /// # Errors
    /// [`AmountParseError`] as [`QuoteAmount::parse`], at the token's decimals.
    pub fn parse_in(token: &QuoteTokenInfo, input: &str) -> Result<Self, AmountParseError> {
        let decimals = token.decimals.min(WAD_DECIMALS);
        let raw = parse_fixed(input, decimals)?;
        let wad = raw.checked_mul(token.scale()).ok_or_else(|| AmountParseError::Overflow {
            input: input.to_owned(),
            decimals: WAD_DECIMALS,
        })?;
        Ok(Self::from_wad_in(token, wad))
    }

    /// Nothing, in `token`.
    #[must_use]
    pub fn zero_in(token: &QuoteTokenInfo) -> Self {
        Self::from_wad_in(token, U256::ZERO)
    }

    // ------------------------------------------------ reading

    /// The quote this amount is in.
    #[must_use]
    pub const fn token(&self) -> &QuoteTokenInfo {
        &self.token
    }

    /// The 18-decimal wad, for encoding into a call.
    #[must_use]
    pub const fn to_wad(&self) -> U256 {
        self.wad
    }

    /// True for native USDC.
    #[must_use]
    pub const fn is_native(&self) -> bool {
        self.token.is_native
    }

    /// True when this amount is nothing at all.
    #[must_use]
    pub fn is_zero(&self) -> bool {
        self.wad.is_zero()
    }

    /// The raw units of the token this wad is: `wad / scale`, exactly.
    ///
    /// # Errors
    /// [`Error::QuoteAmountNotRepresentable`] when `wad % scale != 0`: the token
    /// cannot move that amount, and truncating it here would send a different
    /// number from the one asked for.
    pub fn to_raw(&self) -> Result<U256, Error> {
        let scale = self.token.scale();
        if !(self.wad % scale).is_zero() {
            return Err(Error::QuoteAmountNotRepresentable {
                amount_wad: self.wad,
                quote_scale: scale,
            });
        }
        Ok(self.wad / scale)
    }

    /// True when the token can carry this wad: `wad % scale == 0`. Always true
    /// for native USDC and for 18-decimal tokens.
    #[must_use]
    pub fn is_representable(&self) -> bool {
        (self.wad % self.token.scale()).is_zero()
    }

    /// Refuse an amount the token cannot carry, before anything is sent.
    ///
    /// # Errors
    /// [`Error::QuoteAmountNotRepresentable`].
    pub fn require_representable(&self) -> Result<(), Error> {
        self.to_raw().map(drop)
    }

    /// The largest representable amount not above this one.
    #[must_use]
    pub fn floor_to_representable(&self) -> Self {
        let scale = self.token.scale();
        Self::from_wad_in(&self.token, self.wad / scale * scale)
    }

    /// The smallest representable amount not below this one. At the very top
    /// of the 256-bit range, where no such multiple exists, the floor.
    #[must_use]
    pub fn ceil_to_representable(&self) -> Self {
        let scale = self.token.scale();
        let ceiled = self.wad.div_ceil(scale).checked_mul(scale);
        ceiled.map_or_else(
            || self.floor_to_representable(),
            |wad| Self::from_wad_in(&self.token, wad),
        )
    }

    /// Format with the symbol: `"1.5 EURC"`.
    #[must_use]
    pub fn format(&self) -> String {
        format!("{} {}", format_fixed(self.wad, WAD_DECIMALS), self.token.symbol)
    }

    // ------------------------------------------------ arithmetic

    fn same(&self, other: &Self) -> Result<(), Error> {
        self.token.require_same(&other.token)
    }

    /// Sum.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] across quotes; [`Error::InvalidArgument`]
    /// on overflow.
    pub fn add(&self, other: &Self) -> Result<Self, Error> {
        self.same(other)?;
        let wad = self.wad.checked_add(other.wad).ok_or_else(|| Error::InvalidArgument {
            reason: format!("{} + {} overflows 256 bits", self.format(), other.format()),
        })?;
        Ok(Self::from_wad_in(&self.token, wad))
    }

    /// Difference.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] across quotes; [`Error::InvalidArgument`]
    /// when `other` is the larger: there is no negative amount.
    pub fn sub(&self, other: &Self) -> Result<Self, Error> {
        self.same(other)?;
        let wad = self.wad.checked_sub(other.wad).ok_or_else(|| Error::InvalidArgument {
            reason: format!(
                "{} - {} is below zero, and there is no negative amount",
                self.format(),
                other.format()
            ),
        })?;
        Ok(Self::from_wad_in(&self.token, wad))
    }

    /// Difference, floored at zero.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] across quotes.
    pub fn sub_saturating(&self, other: &Self) -> Result<Self, Error> {
        self.same(other)?;
        Ok(Self::from_wad_in(&self.token, self.wad.saturating_sub(other.wad)))
    }

    /// Sum, or `None` on overflow **or across quotes**.
    #[must_use]
    pub fn checked_add(&self, other: &Self) -> Option<Self> {
        self.add(other).ok()
    }

    /// Difference, or `None` below zero **or across quotes**.
    #[must_use]
    pub fn checked_sub(&self, other: &Self) -> Option<Self> {
        self.sub(other).ok()
    }

    /// Order two amounts of one quote.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] across quotes.
    pub fn compare(&self, other: &Self) -> Result<Ordering, Error> {
        self.same(other)?;
        Ok(self.wad.cmp(&other.wad))
    }

    /// Equal amounts of one quote.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] across quotes.
    pub fn eq(&self, other: &Self) -> Result<bool, Error> {
        self.compare(other).map(Ordering::is_eq)
    }

    /// Strictly greater, in one quote.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] across quotes.
    pub fn gt(&self, other: &Self) -> Result<bool, Error> {
        self.compare(other).map(Ordering::is_gt)
    }

    /// Strictly less, in one quote.
    ///
    /// # Errors
    /// [`Error::QuoteTokenMismatch`] across quotes.
    pub fn lt(&self, other: &Self) -> Result<bool, Error> {
        self.compare(other).map(Ordering::is_lt)
    }

    /// This amount less `tolerance` basis points **of this amount**, floored,
    /// in the same quote — the slippage floor to send with a trade quoted at
    /// this size. 50 bps of 100 is 99.5.
    #[must_use]
    pub fn less_tolerance(&self, tolerance: Bps) -> Self {
        Self::from_wad_in(&self.token, less_tolerance(self.wad, tolerance))
    }
}

impl Default for QuoteAmount {
    /// No native USDC.
    fn default() -> Self {
        Self::ZERO
    }
}

impl PartialEq for QuoteAmount {
    fn eq(&self, other: &Self) -> bool {
        self.token.address == other.token.address && self.wad == other.wad
    }
}

impl Eq for QuoteAmount {}

impl Hash for QuoteAmount {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.token.address.hash(state);
        self.wad.hash(state);
    }
}

impl PartialOrd for QuoteAmount {
    /// `None` across quotes: a euro is not more or less than a dollar here.
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        self.token.same_quote(&other.token).then(|| self.wad.cmp(&other.wad))
    }
}

impl fmt::Display for QuoteAmount {
    /// Renders a decimal figure, **not** the raw integer and without a symbol;
    /// [`QuoteAmount::format`] adds the symbol.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format_fixed(self.wad, WAD_DECIMALS))
    }
}

impl fmt::Debug for QuoteAmount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.format())
    }
}

impl FromStr for QuoteAmount {
    type Err = AmountParseError;

    /// Native USDC, as [`QuoteAmount::parse`].
    fn from_str(input: &str) -> Result<Self, Self::Err> {
        Self::parse(input)
    }
}

impl serde::Serialize for QuoteAmount {
    /// The decimal figure, as a string: a JSON number would round it.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl Add for QuoteAmount {
    type Output = Self;

    /// # Panics
    ///
    /// On overflow, and across quotes. Use [`QuoteAmount::add`] where either
    /// can happen.
    fn add(self, other: Self) -> Self {
        QuoteAmount::add(&self, &other).unwrap_or_else(|err| panic!("{err}"))
    }
}

impl AddAssign for QuoteAmount {
    /// # Panics
    ///
    /// On overflow, and across quotes.
    fn add_assign(&mut self, other: Self) {
        *self = QuoteAmount::add(self, &other).unwrap_or_else(|err| panic!("{err}"));
    }
}

impl Sub for QuoteAmount {
    type Output = Self;

    /// # Panics
    ///
    /// Below zero, and across quotes. Use [`QuoteAmount::sub`] or
    /// [`QuoteAmount::sub_saturating`].
    fn sub(self, other: Self) -> Self {
        QuoteAmount::sub(&self, &other).unwrap_or_else(|err| panic!("{err}"))
    }
}

impl SubAssign for QuoteAmount {
    /// # Panics
    ///
    /// Below zero, and across quotes.
    fn sub_assign(&mut self, other: Self) {
        *self = QuoteAmount::sub(self, &other).unwrap_or_else(|err| panic!("{err}"));
    }
}

/// A launched token's quantity, as an 18-decimal wad.
///
/// Distinct from [`QuoteAmount`] on purpose: keeping them apart is what stops a
/// token balance being passed where a price, a reserve or a payment was wanted.
/// `ArcToken` reports `decimals() == 18`, so a raw balance read off the chain
/// goes straight into [`Tokens::from_wad`].
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Tokens(U256);

wad_amount!(Tokens, "tokens", "tokens");

/// USDC seen through the 6-decimal ERC-20 interface predeploy.
///
/// **The same asset as [`Usdc`], at a different scale.** The predeploy at
/// `0x3600000000000000000000000000000000000000` reports 6 decimals, does not pay
/// for gas, and **no arcnow.io contract reads, writes, calls or imports it**.
///
/// This type exists for exactly one reason: a wallet-facing caller has a
/// 6-decimal number and needs to get to an 18-decimal one, or the other way
/// round, and that conversion should happen once, at a named boundary, rather
/// than as a stray `* 1e12` somewhere in a view layer.
///
/// **Nothing in this SDK's call path accepts or returns this type.** If you find
/// yourself wanting to pass one to a quote, a buy, a sell or a launch, that is
/// the signal that a conversion is missing, not that the API is.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct UsdcErc20(U256);

impl UsdcErc20 {
    /// The scale this amount is denominated in: 6 decimals.
    pub const DECIMALS: u8 = USDC_ERC20_DECIMALS;

    /// Nothing.
    pub const ZERO: Self = Self(U256::ZERO);

    /// Build from the raw 6-decimal integer an ERC-20 `balanceOf` returns.
    #[must_use]
    pub const fn from_units(units: U256) -> Self {
        Self(units)
    }

    /// Build from whole dollars.
    #[must_use]
    pub fn from_whole(whole: u64) -> Self {
        Self(U256::from(whole) * U256::from(10u64.pow(u32::from(Self::DECIMALS))))
    }

    /// Read an exact decimal figure, such as `"1.25"`.
    ///
    /// # Errors
    ///
    /// [`AmountParseError`] when the string is not a plain decimal figure or
    /// carries more than 6 fractional digits. As with [`Usdc::parse`], excess
    /// precision is refused rather than rounded away.
    pub fn parse(input: &str) -> Result<Self, AmountParseError> {
        parse_fixed(input, Self::DECIMALS).map(Self)
    }

    /// The raw 6-decimal integer.
    #[must_use]
    pub const fn to_units(self) -> U256 {
        self.0
    }

    /// True when this amount is nothing at all.
    #[must_use]
    pub fn is_zero(self) -> bool {
        self.0.is_zero()
    }

    /// Convert **up** to the native 18-decimal amount. Exact.
    ///
    /// Spelled both ways round — here and as [`QuoteAmount::from_erc20`] —
    /// because a caller holding one of the two should find the conversion on the
    /// type they have, not on the one they are trying to get to.
    #[must_use]
    pub fn to_native(self) -> Usdc {
        Usdc::from_erc20(self)
    }
}

impl fmt::Display for UsdcErc20 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&format_fixed(self.0, Self::DECIMALS))
    }
}

impl fmt::Debug for UsdcErc20 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} USDC (6dp ERC-20 view)", format_fixed(self.0, Self::DECIMALS))
    }
}

impl FromStr for UsdcErc20 {
    type Err = AmountParseError;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        Self::parse(input)
    }
}

/// Basis points, one ten-thousandth each.
///
/// # `of_fee`, and the single easiest mistake in this design
///
/// **Every share in arcnow.io's fee split is in basis points _of the fee_, never
/// of the trade.** A creator share of 3000 bps is **30% of the 1% fee**, which
/// is **0.30% of the trade**. It is not 30% of the trade, and it is not 0.0003%
/// either. The two framings differ by exactly the trade fee, and a reader who
/// takes one for the other is out by a hundredfold in whichever direction is
/// more embarrassing.
///
/// So the constructors are named for what the number is a share *of*:
///
/// * [`Bps::of_fee`] — a slice of the 1% trade fee. Creator, platform, ref, dev
///   and protocol shares are all of these, and the five total exactly 10000.
/// * [`Bps::of_trade`] — a slice of the trade itself. There is exactly one of
///   these in the whole system: the trade fee, 100 bps, 1%.
///
/// [`Bps::of_trade_equivalent`] converts the first into the second, which is the
/// number to show a human.
///
/// ```
/// use arcnow_sdk::Bps;
///
/// let creator = Bps::of_fee(3_000);
/// let trade_fee = Bps::of_trade(100);
/// // 30% of a 1% fee is 0.30% of the trade: 30 bps.
/// assert_eq!(creator.of_trade_equivalent(trade_fee), Bps::of_trade(30));
/// ```
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Bps(u32);

impl Bps {
    /// The denominator: 10000 basis points make a whole.
    ///
    /// Mirrors `ArcConstants.BPS_DENOMINATOR`.
    pub const DENOMINATOR: u32 = 10_000;

    /// Zero.
    pub const ZERO: Self = Self(0);

    /// The whole thing: 10000 bps.
    pub const WHOLE: Self = Self(Self::DENOMINATOR);

    /// A share **of the 1% trade fee** — the framing every share in
    /// [`crate::FeeConfig`] and [`crate::NewPlatform`] uses.
    ///
    /// 3000 here is 30% of the fee and 0.30% of a trade.
    #[must_use]
    pub const fn of_fee(bps: u32) -> Self {
        Self(bps)
    }

    /// A share **of a trade**. The trade fee itself is the only one of these:
    /// 100 bps, 1%, immutable on the launchpad and identical for every platform.
    #[must_use]
    pub const fn of_trade(bps: u32) -> Self {
        Self(bps)
    }

    /// The raw basis-point count.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }

    /// The raw count as the contracts carry it.
    #[must_use]
    pub fn to_u256(self) -> U256 {
        U256::from(self.0)
    }

    /// Read a bps value that came off the chain as a `uint256`.
    ///
    /// # Errors
    ///
    /// [`crate::Error::ImplausibleBps`] when the value does not fit in a `u32`.
    /// Every bps quantity in these contracts is bounded by 10000; one that is
    /// not is a decoding mistake, and saturating it would hide that.
    pub fn from_u256(value: U256) -> Result<Self, Error> {
        u32::try_from(value)
            .map(Self)
            .map_err(|_| Error::ImplausibleBps { value: value.to_string() })
    }

    /// This share of the fee, restated as a share of the trade.
    ///
    /// `self * trade_fee / 10000`, floored. With the shipped 100-bps trade fee,
    /// a 3000-bps creator share comes back as 30 bps — 0.30%.
    #[must_use]
    pub const fn of_trade_equivalent(self, trade_fee: Bps) -> Self {
        Self(self.0 * trade_fee.0 / Self::DENOMINATOR)
    }

    /// Take this many basis points of an amount, floored, in the amount's own
    /// quote. The same as [`Bps::apply_to_quote`].
    #[must_use]
    pub fn take(self, amount: &QuoteAmount) -> QuoteAmount {
        self.apply_to_quote(amount)
    }

    /// Take this many basis points of an amount, floored on the wad, keeping
    /// the amount's quote token.
    ///
    /// Floored on the **wad**: this is how the curve's own fee arithmetic works.
    /// A v4 pool's hook computes its fee on raw units instead; see
    /// [`crate::pool::buy_fee_from_quote_in`].
    #[must_use]
    pub fn apply_to_quote(self, amount: &QuoteAmount) -> QuoteAmount {
        QuoteAmount::from_wad_in(
            amount.token(),
            amount.to_wad() * self.to_u256() / U256::from(Self::DENOMINATOR),
        )
    }

    /// The percentage this many basis points is, as an exact decimal string —
    /// `"30.00"` for 3000, `"0.30"` for 30.
    ///
    /// Exact rather than an `f64`, because a percentage that renders as
    /// `0.30000000000000004` in somebody's UI is a support ticket.
    #[must_use]
    pub fn percent_string(self) -> String {
        format!("{}.{:02}", self.0 / 100, self.0 % 100)
    }
}

impl fmt::Display for Bps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} bps", self.0)
    }
}

impl fmt::Debug for Bps {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} bps", self.0)
    }
}
