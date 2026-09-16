/**
 * The constant-product bonding curve, priced locally, to the wei.
 *
 * arcnow.io's one curve is `arcnow/bonding-curve@2.x.x`: a constant product
 * `k = r0Wad · y0Wad` over the virtual token reserve `Y = y0Wad − sold`, with
 * the USDC reserve the ceiled hyperbola `C(Y) = ceil(k / Y)`. Parameters
 * `{ r0Wad, y0Wad }`. Integer multiply and divide only.
 *
 * **What this is for.** The chain is the authority: `curve.quoteBuy` asks the
 * curve itself. This module answers the same question without a round trip — a
 * price that updates on every keystroke, a what-if on a state you already hold —
 * and the fork suite holds it equal to the chain's quote and to the fill. It is
 * only ever handed a curve whose `VERSION()` was checked first; see
 * `./curve-version.js`.
 *
 * Every function is a faithful port of arcnow-io/contracts' `CurveMath` and
 * `CurveQuote` (`src/libraries/`), including every rounding direction and every
 * cap. Where the contract reverts, this throws an {@link ArcNowError} whose
 * `code` is the contract's error name.
 *
 * @module
 */

import { ArcNowError } from "./errors/error.js";

/**
 * A curve's immutable parameters: the virtual USDC reserve at launch `r0Wad`
 * (`V0`) and the virtual token reserve at launch `y0Wad` (`Y0`).
 */
export interface CurveParams {
  readonly r0Wad: bigint;
  readonly y0Wad: bigint;
}

/** Everything a quote needs: the parameters, the position, and the caps. All wad. */
export interface CurveSnapshot {
  readonly params: CurveParams;
  /** The stored virtual USDC reserve, `virtualReserveWad()`. */
  readonly reserveWad: bigint;
  readonly tokensSoldWad: bigint;
  readonly targetQuoteWad: bigint;
  readonly curveSupplyWad: bigint;
  /** The trade fee in basis points: 100 on every arcnow.io curve. */
  readonly tradeFeeBps: bigint;
}

/** `IBondingCurve.BuyQuote`, as raw wads. */
export interface RawBuyQuote {
  readonly tokensOutWad: bigint;
  readonly feeQuoteWad: bigint;
  readonly quoteSpentWad: bigint;
  readonly refundWad: bigint;
  readonly newReserveWad: bigint;
  readonly newTokensSoldWad: bigint;
  readonly newPriceWad: bigint;
  readonly graduates: boolean;
}

/** `IBondingCurve.SellQuote`, as raw wads. */
export interface RawSellQuote {
  readonly quoteOutWad: bigint;
  readonly feeQuoteWad: bigint;
  readonly grossQuoteWad: bigint;
  readonly newReserveWad: bigint;
  readonly newTokensSoldWad: bigint;
  readonly newPriceWad: bigint;
}

/** `ILaunchpad.quoteLaunch`, as raw wads. */
export interface RawLaunchQuote {
  /** Exactly the `msg.value` `launch()` requires: the launch fee plus the initial buy. */
  readonly totalCostWad: bigint;
  readonly tokensOutWad: bigint;
  readonly tradeFeeWad: bigint;
}

/* -------------------------------------------------------------------------- *
 * uint256 arithmetic, checked the way Solidity 0.8 checks it
 * -------------------------------------------------------------------------- */

const WAD = 10n ** 18n;
const U256_MAX = (1n << 256n) - 1n;
const BPS_DENOMINATOR = 10_000n;

function revert(code: string, message: string, args: Record<string, unknown> = {}): never {
  throw new ArcNowError({
    code,
    message: `${message} (the contract reverts ${code} here; this local port refuses the same input).`,
    args,
  });
}

function panic(code: bigint, reason: string): never {
  throw new ArcNowError({
    code: "Panic",
    message: `Panic(0x${code.toString(16).padStart(2, "0")}) — ${reason}, as the contract's checked arithmetic would.`,
    details: { panicCode: `0x${code.toString(16).padStart(2, "0")}` },
  });
}

function add(a: bigint, b: bigint): bigint {
  const z = a + b;
  if (z > U256_MAX) panic(0x11n, "arithmetic overflowed");
  return z;
}

function sub(a: bigint, b: bigint): bigint {
  if (b > a) panic(0x11n, "arithmetic underflowed");
  return a - b;
}

function mul(a: bigint, b: bigint): bigint {
  const z = a * b;
  if (z > U256_MAX) panic(0x11n, "arithmetic overflowed");
  return z;
}

function div(a: bigint, b: bigint): bigint {
  if (b === 0n) panic(0x12n, "a division by zero");
  return a / b;
}

/** The contracts' guarded 512-bit `mulDiv`, rounding down. */
function mulDivDown(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) panic(0x12n, "a division by zero");
  const z = (x * y) / d;
  if (z > U256_MAX) revert("MathOverflow", "the quotient does not fit a uint256");
  return z;
}

/** The same, rounding up. */
function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  let z = mulDivDown(x, y, d);
  if ((x * y) % d !== 0n) {
    z += 1n;
    if (z > U256_MAX) revert("MathOverflow", "the rounded-up quotient does not fit a uint256");
  }
  return z;
}

/* -------------------------------------------------------------------------- *
 * The fee
 * -------------------------------------------------------------------------- */

/** `ceil(amount · bps / 10000)`: the fee, rounded in the curve's favour. */
function feeUp(amountWad: bigint, bps: bigint): bigint {
  return div(add(mul(amountWad, bps), BPS_DENOMINATOR - 1n), BPS_DENOMINATOR);
}

/**
 * `ceil(net · 10000 / (10000 − bps))`: the smallest gross whose net after
 * {@link feeUp} is at least `net`.
 */
function grossForNetUp(netWad: bigint, bps: bigint): bigint {
  const denominator = sub(BPS_DENOMINATOR, bps);
  return div(add(mul(netWad, BPS_DENOMINATOR), denominator - 1n), denominator);
}

/* -------------------------------------------------------------------------- *
 * The constant-product curve (src/libraries/CurveMath.sol)
 * -------------------------------------------------------------------------- */

const primitives = {
  /** `C(Y) = ceil(r0 · y0 / Y)`: the USDC reserve the curve holds at token reserve `Y`. */
  usdcReserveAt(r0Wad: bigint, y0Wad: bigint, tokenReserveWad: bigint): bigint {
    if (r0Wad === 0n || y0Wad === 0n || tokenReserveWad === 0n) {
      revert("InvalidReserve", "a zero reserve or parameter");
    }
    return mulDivUp(r0Wad, y0Wad, tokenReserveWad);
  },

  /** `ceil(r0 · y0 / V)`: the smallest token reserve whose USDC reserve is at most `V`. */
  tokenReserveAt(r0Wad: bigint, y0Wad: bigint, usdcReserveWad: bigint): bigint {
    if (r0Wad === 0n || y0Wad === 0n || usdcReserveWad === 0n) {
      revert("InvalidReserve", "a zero reserve or parameter");
    }
    return mulDivUp(r0Wad, y0Wad, usdcReserveWad);
  },

  /** `floor(C(Y) · 1e18 / Y)`. */
  spotPriceAtReserveWad(r0Wad: bigint, y0Wad: bigint, tokenReserveWad: bigint): bigint {
    const reserveWad = primitives.usdcReserveAt(r0Wad, y0Wad, tokenReserveWad);
    return mulDivDown(reserveWad, WAD, tokenReserveWad);
  },

  /** `Y − ceil(k / (C(Y) + d))`. */
  tokensOutForUsdcIn(
    r0Wad: bigint, y0Wad: bigint, tokenReserveWad: bigint, usdcInWad: bigint,
  ): bigint {
    const reserveWad = primitives.usdcReserveAt(r0Wad, y0Wad, tokenReserveWad);
    const newReserveWad = reserveWad + usdcInWad;
    if (newReserveWad > U256_MAX) revert("MathOverflow", "C(Y) + d does not fit a uint256");
    return sub(tokenReserveWad, mulDivUp(r0Wad, y0Wad, newReserveWad));
  },

  /** `C(Y) − C(Y + t)`. */
  usdcOutForTokensIn(
    r0Wad: bigint, y0Wad: bigint, tokenReserveWad: bigint, tokensInWad: bigint,
  ): bigint {
    const reserveWad = primitives.usdcReserveAt(r0Wad, y0Wad, tokenReserveWad);
    const newTokenReserveWad = tokenReserveWad + tokensInWad;
    if (newTokenReserveWad > U256_MAX) revert("MathOverflow", "Y + t does not fit a uint256");
    return sub(reserveWad, mulDivUp(r0Wad, y0Wad, newTokenReserveWad));
  },

  /** `C(Y − t) − C(Y)`: the least net USDC that buys at least `t` tokens. */
  usdcInForTokensOut(
    r0Wad: bigint, y0Wad: bigint, tokenReserveWad: bigint, tokensOutWad: bigint,
  ): bigint {
    if (tokensOutWad >= tokenReserveWad) {
      revert("InsufficientTokenReserve", "the curve does not hold that many tokens", {
        tokenReserveWad,
        tokensOutWad,
      });
    }
    const reserveWad = primitives.usdcReserveAt(r0Wad, y0Wad, tokenReserveWad);
    return sub(mulDivUp(r0Wad, y0Wad, tokenReserveWad - tokensOutWad), reserveWad);
  },

  /** `ceil(k / (C(Y) − u)) − Y`: the least sell that pays at least `u` gross. */
  tokensInForUsdcOut(
    r0Wad: bigint, y0Wad: bigint, tokenReserveWad: bigint, quoteOutWad: bigint,
  ): bigint {
    const reserveWad = primitives.usdcReserveAt(r0Wad, y0Wad, tokenReserveWad);
    if (quoteOutWad >= reserveWad) {
      revert("InsufficientReserve", "the curve does not hold that much USDC", {
        reserveWad,
        quoteOutWad,
      });
    }
    if (quoteOutWad === 0n) return 0n;
    return sub(mulDivUp(r0Wad, y0Wad, reserveWad - quoteOutWad), tokenReserveWad);
  },
} as const;

/* -------------------------------------------------------------------------- *
 * CurveQuote (src/libraries/CurveQuote.sol)
 * -------------------------------------------------------------------------- */

function remaining(s: CurveSnapshot): bigint {
  return s.curveSupplyWad > s.tokensSoldWad ? s.curveSupplyWad - s.tokensSoldWad : 0n;
}

function headroom(s: CurveSnapshot): bigint {
  const real = sub(s.reserveWad, s.params.r0Wad);
  return s.targetQuoteWad > real ? s.targetQuoteWad - real : 0n;
}

/** The most net USDC a buy may put in: the target's headroom or the inventory's cost. */
function maxNetIn(s: CurveSnapshot): bigint {
  const { r0Wad, y0Wad } = s.params;
  const room = headroom(s);
  const left = remaining(s);
  if (left === 0n) return 0n;
  const tokenReserveWad = sub(y0Wad, s.tokensSoldWad);
  const inventoryCost = primitives.usdcInForTokensOut(r0Wad, y0Wad, tokenReserveWad, left);
  return room < inventoryCost ? room : inventoryCost;
}

function spotPriceAt(p: CurveParams, tokensSoldWad: bigint): bigint {
  return primitives.spotPriceAtReserveWad(p.r0Wad, p.y0Wad, sub(p.y0Wad, tokensSoldWad));
}

function quoteBuy(s: CurveSnapshot, usdcInWad: bigint): RawBuyQuote {
  const p = s.params;
  let feeWad = feeUp(usdcInWad, s.tradeFeeBps);
  let netWad = sub(usdcInWad, feeWad);
  const cap = maxNetIn(s);
  let grossUsedWad = usdcInWad;
  if (netWad > cap) {
    netWad = cap;
    grossUsedWad = grossForNetUp(netWad, s.tradeFeeBps);
    feeWad = sub(grossUsedWad, netWad);
  }
  const left = sub(s.curveSupplyWad, s.tokensSoldWad);
  let tokensOutWad = netWad === 0n
    ? 0n
    : primitives.tokensOutForUsdcIn(p.r0Wad, p.y0Wad, sub(p.y0Wad, s.tokensSoldWad), netWad);
  if (tokensOutWad > left) tokensOutWad = left;
  const newReserveWad = add(s.reserveWad, netWad);
  const newTokensSoldWad = add(s.tokensSoldWad, tokensOutWad);
  return {
    tokensOutWad,
    feeQuoteWad: feeWad,
    quoteSpentWad: grossUsedWad,
    refundWad: sub(usdcInWad, grossUsedWad),
    newReserveWad,
    newTokensSoldWad,
    newPriceWad: spotPriceAt(p, newTokensSoldWad),
    graduates:
      sub(newReserveWad, p.r0Wad) >= s.targetQuoteWad || newTokensSoldWad >= s.curveSupplyWad,
  };
}

function quoteSell(s: CurveSnapshot, tokensInWad: bigint): RawSellQuote {
  const p = s.params;
  const grossWad = primitives.usdcOutForTokensIn(
    p.r0Wad, p.y0Wad, sub(p.y0Wad, s.tokensSoldWad), tokensInWad,
  );
  const feeWad = feeUp(grossWad, s.tradeFeeBps);
  const newReserveWad = sub(s.reserveWad, grossWad);
  const newTokensSoldWad = sub(s.tokensSoldWad, tokensInWad);
  return {
    grossQuoteWad: grossWad,
    feeQuoteWad: feeWad,
    quoteOutWad: grossWad - feeWad,
    newReserveWad,
    newTokensSoldWad,
    newPriceWad: spotPriceAt(p, newTokensSoldWad),
  };
}

/**
 * The curve's pricing.
 *
 * @example
 * ```ts
 * const state = await client.curve(address).state();
 * const quote = CurveMath.quoteBuy(curveSnapshotOf(state), Usdc.parse("5").wad);
 * ```
 */
export const CurveMath = {
  /** Price a buy of `usdcInWad` gross, capped at the inventory and the target. */
  quoteBuy,
  /** Price a sell of `tokensInWad`. */
  quoteSell,
  /** The spot price at the snapshot's position, `floor(C(Y) · 1e18 / Y)`, wad USDC per token. */
  spotPriceWad(snapshot: CurveSnapshot): bigint {
    return spotPriceAt(snapshot.params, snapshot.tokensSoldWad);
  },
  /** `graduationProgressBps()`: real USDC over the target, in bps, capped at 10,000. */
  progressBps(snapshot: CurveSnapshot): bigint {
    if (snapshot.targetQuoteWad === 0n) return 10_000n;
    const real = sub(snapshot.reserveWad, snapshot.params.r0Wad);
    if (real >= snapshot.targetQuoteWad) return 10_000n;
    return (real * 10_000n) / snapshot.targetQuoteWad;
  },
  /**
   * `ILaunchpad.quoteLaunch`: the flat launch fee plus an ordinary buy into a
   * fresh curve of this template. `fresh` must have `reserveWad = r0Wad` and
   * nothing sold.
   */
  quoteLaunch(fresh: CurveSnapshot, initialBuyWad: bigint, launchFeeWad: bigint): RawLaunchQuote {
    const totalCostWad = add(launchFeeWad, initialBuyWad);
    if (initialBuyWad === 0n) return { totalCostWad, tokensOutWad: 0n, tradeFeeWad: 0n };
    const q = quoteBuy(fresh, initialBuyWad);
    return { totalCostWad, tokensOutWad: q.tokensOutWad, tradeFeeWad: q.feeQuoteWad };
  },
  feeUp,
  grossForNetUp,
  ...primitives,
} as const;
