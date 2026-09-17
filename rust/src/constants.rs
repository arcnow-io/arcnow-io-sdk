//! Chain facts, and a reference curve template that is checked rather than
//! trusted.
//!
//! # Two kinds of number live here, and they are not alike
//!
//! The chain facts — the chain id, the predeploys, the fee bounds, the launch
//! fee — are **immutable on the deployed contracts**. Raising the trade fee
//! means deploying a new launchpad; every token already launched keeps what it
//! was launched with. They are copied from
//! `arcnow-io/contracts/src/libraries/ArcConstants.sol` at the commit
//! `../pins.json` names, and the ABI pin is what keeps that honest.
//!
//! [`CurveTemplate::arcnow_defaults`] is **not that kind of number**. A curve
//! template is per-platform state, replaceable by that platform's admin in one
//! transaction, and it moved on 2026-09-13: the supply fell from 1e9 to 1e6 and
//! the graduation target from 50,000 USDC to 50. Nothing caught it. The
//! contracts could not — `checkCurveParameters` only checks a template against
//! itself, and the old one is internally self-consistent to this day. The ABI
//! pin could not — not a byte of ABI changed. So the stale figure sat in this
//! crate and in a user-facing error message, wrong by a factor of 1000.
//!
//! The template therefore is not written here at all. It lives in
//! `../curve-templates.json`, projected into `generated/` alongside
//! `networks.json`, and the maintainers' template gate reads
//! `curveParametersFor(quote)` off the live platform and **fails** on any difference.
//! their preflight runs that before it compiles anything.
//!
//! # Prefer the chain to any of it
//!
//! [`crate::PlatformConfigHandle::curve_parameters_for`] answers what a new
//! launch in a given quote gets. [`crate::Curve::state`] answers what an existing token got, which is a
//! different question with a different answer: a curve keeps the template it
//! snapshotted at launch for life.
//!
//! `Y0` and `V0` are *placed* integers — chosen by arcnow-io/contracts so that
//! the pool-reserve rule closes, not merely rounded. A value recomputed in `f64`
//! would be correct to about fifteen digits and would be refused by
//! `PlatformConfig`'s constructor with `PoolReserveMismatch`, which is a long
//! way from the line that recomputed it. So the reference is copied, never
//! derived.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use alloy::primitives::{Address, U256, address};
use serde::Deserialize;

use crate::amount::{Bps, NATIVE_USDC, QuoteAmount, QuoteTokenInfo, Tokens};
use crate::bindings::platform_config::IPlatformConfig;
use crate::curve_math::CurveParams;

/// Chain id of Arc testnet.
///
/// `ArcConstants.ARC_TESTNET_CHAIN_ID`.
pub const ARC_TESTNET_CHAIN_ID: u64 = 5_042_002;

/// The ERC-20 interface to native USDC, a predeploy on Arc.
///
/// `ArcConstants.USDC_ERC20_PREDEPLOY`. **It reports 6 decimals and no
/// arcnow.io contract touches it.** It is here so a wallet-facing caller can
/// name the address it read a balance from; see [`crate::UsdcErc20`].
pub const USDC_ERC20_PREDEPLOY: Address = address!("0x3600000000000000000000000000000000000000");

/// Multicall3, a predeploy on Arc.
///
/// `ArcConstants.MULTICALL3`. Used by [`crate::Curve::state`] to fetch the whole
/// of a curve's live state in one round trip. Never called by the contracts.
pub const MULTICALL3: Address = address!("0xcA11bde05977b3631167028862bE2a173976CA11");

/// The trade fee, in basis points **of a trade**: 1%.
///
/// `ArcConstants.TRADE_FEE_BPS`. Immutable on the launchpad and copied onto
/// every curve and token it deploys. **It is not platform-configurable**: what a
/// platform chooses is how the 1% is divided, never how large it is. Raising it
/// means deploying a new launchpad, and every token already launched keeps the
/// rate it was launched with, forever.
///
/// Read from the chain with [`crate::Launchpad::trade_fee_bps`] rather than
/// assumed; this constant is what the shipped deployment answers.
pub const TRADE_FEE_BPS: Bps = Bps::of_trade(100);

/// The flat launch fee: 2 USDC.
///
/// `ArcConstants.LAUNCH_FEE_WAD`. Immutable on the launchpad. Read it from the
/// chain with [`crate::Launchpad::launch_fee`]; this is the shipped value.
pub const LAUNCH_FEE_WAD: u128 = 2_000_000_000_000_000_000;

/// The most of the fee a platform may allocate across creator, ref and dev:
/// 7500 bps.
///
/// `ArcConstants.MAX_PLATFORM_ALLOWANCE_BPS` — `10000 - MAX_PROTOCOL_SHARE_BPS`.
///
/// **Measured against the protocol's _maximum_ share, never its current one.**
/// That is what makes a stored platform configuration durable: a protocol admin
/// lowering the protocol share widens every platform's residual and can never
/// invalidate a configuration or stop it launching.
pub const MAX_PLATFORM_ALLOWANCE_BPS: Bps = Bps::of_fee(7_500);

/// The ceiling on the protocol's share of the fee: 2500 bps.
///
/// `ArcConstants.MAX_PROTOCOL_SHARE_BPS`. Deliberately equal to the shipped
/// default: **the protocol may lower its cut, never raise it.**
pub const MAX_PROTOCOL_SHARE_BPS: Bps = Bps::of_fee(2_500);

/// The floor on the protocol's share of the fee: 1000 bps.
///
/// `ArcConstants.MIN_PROTOCOL_SHARE_BPS`. It exists so that a compromised or
/// careless protocol admin cannot zero the protocol's revenue in one
/// transaction.
pub const MIN_PROTOCOL_SHARE_BPS: Bps = Bps::of_fee(1_000);

/// The six numbers that define a bonding curve, as `PlatformConfig` stores them.
///
/// This is `IPlatformConfig.CurveParameters`, plus the quote it is set for: a
/// platform holds one template per quote, and a template's reserves, target and
/// prices are wads **in that quote**. **All six numbers move together and five
/// of them constrain the sixth**, which is why they are one struct and are set
/// in one call.
///
/// `PlatformConfig`'s constructor re-derives the relationships and **refuses**
/// a template that does not satisfy them, with an error naming which one failed:
/// [`crate::Error::InitialPriceMismatch`], [`crate::Error::GraduationTargetMismatch`],
/// [`crate::Error::CurveNotPriceable`], [`crate::Error::InvalidSupplies`] and
/// [`crate::Error::PoolReserveMismatch`] — the last being the rule that the
/// held-back supply is exactly what the graduating reserve buys at the curve's
/// last price.
///
/// Check a candidate without sending a transaction with
/// [`crate::PlatformConfigHandle::check_curve_parameters`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurveTemplate {
    /// The quote this template prices in. [`NATIVE_USDC`] for the template a
    /// platform is registered with.
    pub quote_token: QuoteTokenInfo,
    /// Fixed supply minted to every new token.
    pub total_supply: Tokens,
    /// Tokens the curve sells over its whole life. Strictly below
    /// `total_supply`; the difference is the inventory the migrator opens the
    /// market with.
    pub curve_supply: Tokens,
    /// `Y0`, the virtual token reserve at launch: `k = r0 · y0`.
    pub y0: Tokens,
    /// `V0`, the virtual starting quote reserve.
    ///
    /// An accounting fiction that gives the first token a positive price. **It
    /// is never payable to anyone** and is not counted towards graduation.
    pub r0: QuoteAmount,
    /// Real quote the curve must collect before it graduates and stops trading:
    /// `targetQuoteWad`.
    pub target: QuoteAmount,
    /// The declared price of the first token, in quote per token.
    pub initial_price: QuoteAmount,
}

impl CurveTemplate {
    /// arcnow.io's own template, as its platform was serving it when
    /// `../curve-templates.json` was last read off the chain.
    ///
    /// **This is a snapshot, not an authority.** A curve template is
    /// per-platform state and its admin can replace it in one transaction; on
    /// 2026-09-13 a platform's did, by a factor of 1000, and nothing noticed. So
    /// ask the chain for anything that matters: what a new launch will get is
    /// [`crate::PlatformConfigHandle::curve_parameters_for`]; what an existing
    /// token got is [`crate::Curve::state`].
    ///
    /// What this is for is giving somebody registering a platform of their own a
    /// template to start from. The integers were placed, not rounded; **do not
    /// recompute them** in floating point.
    ///
    /// | field | value |
    /// | --- | --- |
    /// | `total_supply` | 1,000,000 tokens |
    /// | `curve_supply` | 790,931.776678561246309959 tokens (79.09%) |
    /// | `y0` | 1,075,119.882918585400293717 |
    /// | `r0` | 17.965399457930722779 USDC |
    /// | `target` | 50 USDC |
    /// | `initial_price` | 0.000016710135998192 USDC |
    ///
    /// Native USDC: [`CurveTemplate::quote_token`] is [`NATIVE_USDC`].
    ///
    /// The graduation price is 0.000239156382570519, a 14.31x rise, and the
    /// 209,068.22 tokens held back are exactly what 50 USDC buys at it.
    /// The maintainers' template gate reads the live platform and **fails** on
    /// any difference.
    ///
    /// # Panics
    ///
    /// Never, in a checkout whose generated file is intact.
    #[must_use]
    pub fn arcnow_defaults() -> Self {
        Self::reference_for(crate::network::ARC_TESTNET).expect(
            "curve-templates.json must carry the arc-testnet template; run \
             the projection sync at the repository root",
        )
    }

    /// The reference snapshot for a named preset, or `None` where there is no
    /// deployment to have read one from — `arc-mainnet`, deliberately.
    #[must_use]
    pub fn reference_for(network: &str) -> Option<Self> {
        references()
            .values()
            .find(|entry| entry.network.as_deref() == Some(network) && entry.platform.is_some())
            .and_then(ReferenceTemplate::template)
    }

    /// arcnow-io/contracts' **reference** template: 1e9 tokens and a 50,000
    /// USDC target, the same prices as [`CurveTemplate::arcnow_defaults`] at a
    /// thousand times the scale. No live platform serves it.
    ///
    /// # Panics
    ///
    /// Never, in a checkout whose generated file is intact.
    #[must_use]
    pub fn reference() -> Self {
        references()
            .get("cpmm-reference")
            .and_then(ReferenceTemplate::template)
            .expect("curve-templates.json must carry cpmm-reference; re-run the projection sync")
    }

    /// A template read off the chain, in `quote_token`.
    #[must_use]
    pub fn decode(raw: &IPlatformConfig::CurveParameters, quote_token: QuoteTokenInfo) -> Self {
        Self {
            total_supply: Tokens::from_wad(raw.totalSupplyWad),
            curve_supply: Tokens::from_wad(raw.curveSupplyWad),
            y0: Tokens::from_wad(raw.y0Wad),
            r0: QuoteAmount::from_wad_in(&quote_token, raw.r0Wad),
            target: QuoteAmount::from_wad_in(&quote_token, raw.targetQuoteWad),
            initial_price: QuoteAmount::from_wad_in(&quote_token, raw.initialPriceWad),
            quote_token,
        }
    }

    /// The six numbers as `PlatformConfig` takes them.
    pub(crate) fn to_abi(&self) -> IPlatformConfig::CurveParameters {
        IPlatformConfig::CurveParameters {
            totalSupplyWad: self.total_supply.to_wad(),
            curveSupplyWad: self.curve_supply.to_wad(),
            y0Wad: self.y0.to_wad(),
            r0Wad: self.r0.to_wad(),
            targetQuoteWad: self.target.to_wad(),
            initialPriceWad: self.initial_price.to_wad(),
        }
    }

    /// The curve parameters a launch under this template snapshots.
    #[must_use]
    pub fn params(&self) -> CurveParams {
        CurveParams { r0_wad: self.r0.to_wad(), y0_wad: self.y0.to_wad() }
    }

    /// What this template holds back from its curve for the pool:
    /// `total_supply - curve_supply`. **Read it off the template in hand**,
    /// which for a launched token means [`crate::Curve::state`].
    #[must_use]
    pub fn held_back(&self) -> Tokens {
        self.total_supply.saturating_sub(self.curve_supply)
    }
}

/// `curve-templates.json`, byte-identical to the copy the TypeScript SDK
/// carries. Projected from the repository root; checked against the chain by
/// the maintainers' template gate.
const CURVE_TEMPLATES_JSON: &str = include_str!("generated/curve-templates.json");

/// One snapshot in `curve-templates.json`. Every wad is a **string**: `y0Wad`
/// does not fit in a double and JSON has no integers.
// The `_wad` suffixes are the JSON keys, which are the contracts' own names.
#[allow(clippy::struct_field_names)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceTemplate {
    network: Option<String>,
    platform: Option<String>,
    total_supply_wad: Option<String>,
    curve_supply_wad: Option<String>,
    y0_wad: Option<String>,
    r0_wad: Option<String>,
    quote: Option<String>,
    target_quote_wad: Option<String>,
    initial_price_wad: Option<String>,
}

impl ReferenceTemplate {
    /// The template, or `None` for an entry with nothing in it, or in a quote
    /// its network's `quoteTokens` does not describe.
    fn template(&self) -> Option<CurveTemplate> {
        let quote: Address = self.quote.as_deref()?.parse().ok()?;
        let quote_token = if quote.is_zero() {
            NATIVE_USDC
        } else {
            let network = crate::network::Network::from_id(self.network.as_deref()?).ok()?;
            network.config().quote_token(quote)?.clone()
        };
        Some(CurveTemplate {
            total_supply: Tokens::from_wad(parse_wad(self.total_supply_wad.as_deref()?)),
            curve_supply: Tokens::from_wad(parse_wad(self.curve_supply_wad.as_deref()?)),
            y0: Tokens::from_wad(parse_wad(self.y0_wad.as_deref()?)),
            r0: QuoteAmount::from_wad_in(&quote_token, parse_wad(self.r0_wad.as_deref()?)),
            target: QuoteAmount::from_wad_in(
                &quote_token,
                parse_wad(self.target_quote_wad.as_deref()?),
            ),
            initial_price: QuoteAmount::from_wad_in(
                &quote_token,
                parse_wad(self.initial_price_wad.as_deref()?),
            ),
            quote_token,
        })
    }
}

#[derive(Deserialize)]
struct ReferenceFile {
    templates: BTreeMap<String, ReferenceTemplate>,
}

fn references() -> &'static BTreeMap<String, ReferenceTemplate> {
    static TEMPLATES: OnceLock<BTreeMap<String, ReferenceTemplate>> = OnceLock::new();
    TEMPLATES.get_or_init(|| {
        serde_json::from_str::<ReferenceFile>(CURVE_TEMPLATES_JSON)
            .expect(
                "src/generated/curve-templates.json is a generated, checked file and must \
                 parse. If this panics the projection has drifted: run \
                 the projection sync and the pin gate.",
            )
            .templates
    })
}

/// A decimal wad from the reference file.
///
/// # Panics
///
/// On anything that is not a decimal integer, which in a checkout whose
/// generated file has not been hand-edited cannot happen.
fn parse_wad(text: &str) -> U256 {
    text.parse().unwrap_or_else(|_| {
        panic!(
            "{text:?} in src/generated/curve-templates.json is not a decimal wad. That file is \
             generated from ../curve-templates.json; do not edit it."
        )
    })
}
