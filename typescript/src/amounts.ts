/**
 * The quantities this SDK deals in, as types the compiler will not let you swap
 * for one another: a quote-token amount ({@link QuoteAmount}, with {@link Usdc}
 * for native USDC), a token quantity, basis points, and the 6-decimal USDC
 * interface view.
 *
 * **Why this file is a wall and not a type alias.** On Arc, USDC *is* the gas
 * currency and `msg.value` is an 18-decimal integer. The USDC ERC-20 interface
 * predeploy at `0x3600…0000` is the *same asset* reporting **6** decimals. The
 * two raw representations of one dollar differ by a factor of `1e12`, and every
 * amount in every arcnow.io function signature, event, error and storage slot
 * is the 18-decimal one. There is no 6-decimal number anywhere in the
 * contracts.
 *
 * A `bigint` cannot tell you which of the two it is. So the SDK refuses to
 * accept one: every value-bearing API takes a {@link Usdc} or a {@link Tokens},
 * both of which can only be built by naming a scale out loud. A caller who
 * reaches for `parseUnits(x, 6)` out of habit gets a type error at the call
 * site instead of a transaction that is out by a trillion.
 *
 * Each class carries a `declare private` brand field. It is erased at runtime —
 * there is no per-instance cost — and it is what makes these classes
 * *nominally* typed: TypeScript refuses to relate two classes with private
 * members declared in different places, so `Tokens` is not a `Usdc` however
 * identical their shapes are.
 *
 * @module
 */

import type { Address } from "viem";

import { ArcNowError } from "./errors/error.js";

/** Decimals every internal arcnow.io amount uses. `ArcConstants.WAD_DECIMALS`. */
export const WAD_DECIMALS = 18;

/** One whole unit in 18-decimal fixed point. `ArcConstants.WAD`. */
export const WAD = 10n ** 18n;

/** Decimals the USDC ERC-20 interface predeploy reports. `ArcConstants.USDC_ERC20_DECIMALS`. */
export const USDC_ERC20_DECIMALS = 6;

/**
 * Multiplier between the 6-decimal ERC-20 view and the 18-decimal native view
 * of the same dollar. `ArcConstants.USDC_ERC20_SCALE`.
 */
export const USDC_ERC20_SCALE = 10n ** 12n;

/**
 * Thrown when a decimal string cannot be turned into an exact fixed-point
 * integer.
 *
 * Its own class rather than a plain `Error` so that the parsers can be used on
 * user input — a form field, an argv — and the caller can tell "you typed that
 * wrong" apart from "the chain said no". {@link ArcNowError} wraps it when it
 * surfaces through a client call.
 */
export class AmountParseError extends Error {
  override readonly name = "AmountParseError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Parse a decimal string into a fixed-point integer of `decimals` places,
 * **exactly**.
 *
 * Rejects more fractional digits than the scale can hold rather than truncating
 * them. Truncating is how `"1.0000000000000000009"` silently becomes a
 * different amount than the one that was typed, and an amount a user did not
 * choose is not an amount this SDK will send.
 */
function parseFixed(value: string, decimals: number, typeName: string): bigint {
  const trimmed = value.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new AmountParseError(
      `${typeName}.parse(${JSON.stringify(value)}): that is not a decimal number. `
      + "Write it the way you would say it, for example \"1.25\" or \"50000\". "
      + "If you already hold a raw integer, use fromWad instead — it is the one "
      + "constructor that does not guess a scale.",
    );
  }
  const [, sign, whole = "", fraction = ""] = match;
  if (sign === "-") {
    throw new AmountParseError(
      `${typeName}.parse(${JSON.stringify(value)}): amounts on Arc are unsigned. `
      + "A negative value has no encoding in any arcnow.io function signature; if "
      + "you meant a subtraction, do it with .sub() and handle the underflow.",
    );
  }
  if (fraction.length > decimals) {
    throw new AmountParseError(
      `${typeName}.parse(${JSON.stringify(value)}): ${fraction.length} fractional digits, `
      + `and ${typeName} holds ${decimals}. Nothing here rounds for you: round it `
      + "yourself to the precision you meant, so that the number you send is the "
      + "number you chose.",
    );
  }
  const padded = fraction.padEnd(decimals, "0");
  return BigInt(`${whole === "" ? "0" : whole}${padded}`);
}

/**
 * Render a fixed-point integer as the decimal figure a human reads, with no
 * trailing-zero noise and no exponent.
 */
function formatFixed(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = raw % unit;
  if (fraction === 0n) return whole.toString();
  const digits = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${digits}`;
}

function requireNonNegative(raw: bigint, typeName: string): bigint {
  if (raw < 0n) {
    throw new AmountParseError(
      `${typeName}: ${raw} is negative, and every amount in the arcnow.io contracts `
      + "is a uint256. Encoding this would revert at best and wrap at worst.",
    );
  }
  return raw;
}

/**
 * The quote token the curve Launchpad credits with native value: `address(0)`.
 * `ArcConstants.NATIVE_QUOTE`. Not an account anything is sent to — on Arc the
 * zero address is a real account — but the spelling every multi-quote contract
 * uses for "native USDC, paid as msg.value".
 */
export const NATIVE_QUOTE: Address = "0x0000000000000000000000000000000000000000";

/** The most decimals a quote token may have. `ArcConstants.MAX_QUOTE_DECIMALS`. */
export const MAX_QUOTE_DECIMALS = 18;

/**
 * What a curve is priced in: native USDC, or an allowlisted ERC-20.
 *
 * Metadata only. Whether a quote is **accepted** is the quote registry's answer
 * (`QuoteRegistry.isQuoteToken`), never this record's.
 */
export interface QuoteTokenInfo {
  /** The token, lower-cased. {@link NATIVE_QUOTE} for native USDC. */
  readonly address: Address;
  /** The ticker, for display: `"USDC"`, `"EURC"`. */
  readonly symbol: string;
  /** The token's name. */
  readonly name: string;
  /** Its decimals, at most {@link MAX_QUOTE_DECIMALS}. 18 for native USDC. */
  readonly decimals: number;
  /**
   * True for native USDC only: paid as `msg.value`, needing no allowance. Every
   * other quote is pulled with an ERC-20 allowance, in raw units.
   */
  readonly isNative: boolean;
}

/** Native USDC as a quote: the zero address at 18 decimals. */
export const NATIVE_USDC: QuoteTokenInfo = Object.freeze({
  address: NATIVE_QUOTE,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 18,
  isNative: true,
});

/**
 * Build a validated {@link QuoteTokenInfo}. `isNative` is derived from the
 * address, so the two can never disagree.
 *
 * @throws {ArcNowError} `InvalidArgument` for a malformed address, more than 18
 *   decimals (the contracts refuse such a quote), or native USDC at anything but
 *   18.
 */
export function quoteTokenInfo(fields: {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly isNative?: boolean | undefined;
}): QuoteTokenInfo {
  const address = fields.address.toLowerCase();
  const invalid = (why: string): never => {
    throw new ArcNowError({
      code: "InvalidArgument",
      message: `quote token ${JSON.stringify(fields.symbol)} at ${fields.address}: ${why}`,
      details: { address: fields.address, decimals: fields.decimals },
    });
  };
  if (!/^0x[0-9a-f]{40}$/.test(address)) invalid("that is not a 20-byte hex address.");
  const { decimals } = fields;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_QUOTE_DECIMALS) {
    invalid(
      `${fields.decimals} decimals, and a quote may have at most ${MAX_QUOTE_DECIMALS}: the curve `
      + "keeps every amount in 18-decimal WAD and scales down to raw units, never up.",
    );
  }
  const isNative = address === NATIVE_QUOTE;
  if (fields.isNative !== undefined && fields.isNative !== isNative) {
    invalid("isNative must be true for the zero address and for nothing else.");
  }
  if (isNative && fields.decimals !== MAX_QUOTE_DECIMALS) {
    invalid("native USDC is msg.value, which is 18 decimals on Arc.");
  }
  return Object.freeze({
    address: address as Address,
    symbol: fields.symbol,
    name: fields.name,
    decimals: fields.decimals,
    isNative,
  });
}

/**
 * `10^(18 - decimals)`: WAD per raw unit of the quote. 1 for native USDC and
 * any 18-decimal token, `1e12` for EURC. `BondingCurve.quoteScale()`.
 */
export function quoteScaleOf(token: QuoteTokenInfo): bigint {
  return 10n ** BigInt(MAX_QUOTE_DECIMALS - token.decimals);
}

/** True when two quote records name the same token. */
export function sameQuote(left: QuoteTokenInfo, right: QuoteTokenInfo): boolean {
  return left.address.toLowerCase() === right.address.toLowerCase();
}

/**
 * An amount of a curve's quote token: an 18-decimal WAD **and the token it is
 * denominated in**. **The type every value-bearing arcnow.io API takes.**
 *
 * Every `*Wad` field of every multi-quote contract is WAD whatever the quote;
 * an ERC-20 quote moves `wad / 10^(18 - decimals)` raw units of itself. So:
 *
 * - **two quotes never mix.** Arithmetic or comparison across tokens throws
 *   `QuoteTokenMismatch` — 1 EURC plus 1 USDC has no answer.
 * - **a WAD that does not divide into whole raw units is named, not rounded.**
 *   {@link QuoteAmount.toRaw} throws `QuoteAmountNotRepresentable`; round it
 *   yourself with {@link QuoteAmount.floorToRepresentable} or
 *   {@link QuoteAmount.ceilToRepresentable}, so the amount sent is one you chose.
 *
 * For native USDC, see {@link Usdc}, which builds these with the token filled in.
 *
 * @example
 * ```ts
 * const eurc = client.config.quoteTokens.find((q) => q.symbol === "EURC")!;
 * QuoteAmount.parse(eurc, "25")   // 25 EURC: wad 25e18, raw 25_000_000
 * Usdc.parse("25")                // 25 native USDC
 * ```
 */
export class QuoteAmount {
  declare private readonly __brand: "QuoteAmount";

  /** The quote token this amount is denominated in. */
  readonly token: QuoteTokenInfo;

  /** The 18-decimal WAD, which is what every multi-quote contract function takes. */
  readonly wad: bigint;

  private constructor(token: QuoteTokenInfo, wad: bigint) {
    this.token = token;
    this.wad = wad;
  }

  /** Build from the 18-decimal WAD the contracts and events speak. */
  static fromWad(token: QuoteTokenInfo, wad: bigint): QuoteAmount {
    return new QuoteAmount(token, requireNonNegative(wad, typeNameOf(token)));
  }

  /** Build from raw units of the token — what an ERC-20 `balanceOf` returns. Exact. */
  static fromRaw(token: QuoteTokenInfo, raw: bigint): QuoteAmount {
    return new QuoteAmount(token, requireNonNegative(raw, typeNameOf(token)) * quoteScaleOf(token));
  }

  /** Build from whole units: `fromWhole(eurc, 50n)` is 50 EURC. */
  static fromWhole(token: QuoteTokenInfo, whole: bigint): QuoteAmount {
    return new QuoteAmount(token, requireNonNegative(whole, typeNameOf(token)) * WAD);
  }

  /**
   * Parse a decimal figure **exactly in the token's own decimals**. More
   * fractional digits than the token has is a rejection, never a truncation, so
   * a parsed amount is always representable.
   */
  static parse(token: QuoteTokenInfo, value: string): QuoteAmount {
    const raw = parseFixed(value, token.decimals, typeNameOf(token));
    return new QuoteAmount(token, raw * quoteScaleOf(token));
  }

  /** Zero of the token. */
  static zero(token: QuoteTokenInfo): QuoteAmount {
    return new QuoteAmount(token, 0n);
  }

  /** WAD per raw unit of this amount's token. */
  get scale(): bigint {
    return quoteScaleOf(this.token);
  }

  /** True when the WAD divides into whole raw units of the token. Always true at 18 decimals. */
  isRepresentable(): boolean {
    return this.wad % this.scale === 0n;
  }

  /**
   * The raw units of the token this amount moves: `wad / 10^(18 - decimals)`.
   *
   * @throws {ArcNowError} `QuoteAmountNotRepresentable` when the WAD carries dust
   *   below one raw unit. The contract refuses such an amount with the same
   *   error; this names it before anything is sent.
   */
  toRaw(): bigint {
    if (!this.isRepresentable()) {
      throw new ArcNowError({
        code: "QuoteAmountNotRepresentable",
        message:
          `${this.wad} wad of ${this.token.symbol} is not a whole number of its raw units `
          + `(${this.token.decimals} decimals, ${this.scale} wad each), so it cannot be moved and `
          + "the curve refuses it. Nothing was sent. Round it to the amount you mean with "
          + "floorToRepresentable() or ceilToRepresentable().",
        details: { amountWad: this.wad, quoteScale: this.scale, quoteToken: this.token.address },
      });
    }
    return this.wad / this.scale;
  }

  /** The largest representable amount not above this one. */
  floorToRepresentable(): QuoteAmount {
    return new QuoteAmount(this.token, this.wad - (this.wad % this.scale));
  }

  /** The smallest representable amount not below this one. */
  ceilToRepresentable(): QuoteAmount {
    const rest = this.wad % this.scale;
    return rest === 0n ? this : new QuoteAmount(this.token, this.wad + this.scale - rest);
  }

  /**
   * Convert native USDC **down** to the 6-decimal ERC-20 interface view,
   * **truncating toward zero**. Only meaningful for native USDC; see
   * {@link UsdcErc20}.
   *
   * @throws {ArcNowError} `InvalidArgument` for any other quote.
   */
  toErc20(): UsdcErc20 {
    if (!this.token.isNative) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          `${this.format()} is not native USDC, so it has no view through the USDC ERC-20 `
          + "interface at 0x3600…0000. Use toRaw() for its own raw units.",
        details: { quoteToken: this.token.address },
      });
    }
    return UsdcErc20.fromRaw(this.wad / USDC_ERC20_SCALE);
  }

  /** Sum. Refuses another quote. */
  add(other: QuoteAmount): QuoteAmount {
    this.requireSameQuote(other, "add");
    return new QuoteAmount(this.token, this.wad + other.wad);
  }

  /**
   * Difference. Throws {@link AmountParseError} on underflow rather than
   * wrapping, and refuses another quote. Use {@link subSaturating} when zero is
   * the answer you want.
   */
  sub(other: QuoteAmount): QuoteAmount {
    this.requireSameQuote(other, "sub");
    return new QuoteAmount(this.token, requireNonNegative(this.wad - other.wad, `${typeNameOf(this.token)}.sub`));
  }

  /** Difference, floored at zero. Refuses another quote. */
  subSaturating(other: QuoteAmount): QuoteAmount {
    this.requireSameQuote(other, "subSaturating");
    return new QuoteAmount(this.token, this.wad > other.wad ? this.wad - other.wad : 0n);
  }

  /** `-1`, `0` or `1`. Refuses another quote. */
  compare(other: QuoteAmount): -1 | 0 | 1 {
    this.requireSameQuote(other, "compare");
    return this.wad < other.wad ? -1 : this.wad > other.wad ? 1 : 0;
  }

  /** True when both hold the same WAD. Refuses another quote rather than answering false. */
  eq(other: QuoteAmount): boolean {
    this.requireSameQuote(other, "eq");
    return this.wad === other.wad;
  }

  /** True when this is strictly larger. Refuses another quote. */
  gt(other: QuoteAmount): boolean {
    this.requireSameQuote(other, "gt");
    return this.wad > other.wad;
  }

  /** True when this is strictly smaller. Refuses another quote. */
  lt(other: QuoteAmount): boolean {
    this.requireSameQuote(other, "lt");
    return this.wad < other.wad;
  }

  /** True for exactly zero. */
  isZero(): boolean {
    return this.wad === 0n;
  }

  /**
   * The decimal figure, in the token's own decimals — or all 18 when the WAD
   * carries dust below one raw unit, so the dust is shown rather than hidden.
   */
  toString(): string {
    return this.isRepresentable()
      ? formatFixed(this.wad / this.scale, this.token.decimals)
      : formatFixed(this.wad, WAD_DECIMALS);
  }

  /** The decimal figure with the quote's ticker: `"1.25 EURC"`. */
  format(): string {
    return `${this.toString()} ${this.token.symbol}`;
  }

  /** JSON round-trips as the decimal figure. */
  toJSON(): string {
    return this.toString();
  }

  private requireSameQuote(other: QuoteAmount, operation: string): void {
    if (sameQuote(this.token, other.token)) return;
    throw new ArcNowError({
      code: "QuoteTokenMismatch",
      message:
        `${operation} of ${this.format()} and ${other.format()}: those are two different quote `
        + `tokens (${this.token.address} and ${other.token.address}), and an amount of one has no `
        + "meaning in the other. Convert at a rate you chose, outside this SDK.",
      details: { left: this.token.address, right: other.token.address, operation },
    });
  }
}

function typeNameOf(token: QuoteTokenInfo): string {
  return token.isNative ? "Usdc" : `QuoteAmount(${token.symbol})`;
}

/**
 * **Native USDC**: a {@link QuoteAmount} whose token is {@link NATIVE_USDC}.
 *
 * Kept as the native alias. `Usdc` is the same type as `QuoteAmount` — the
 * compiler cannot tell a native amount from an ERC-20 one, so a method that
 * needs native USDC checks `amount.token.isNative` — and these constructors
 * always build native amounts.
 *
 * @example
 * ```ts
 * Usdc.fromWhole(50n)            // fifty dollars
 * Usdc.parse("1.25")             // exact; rejects a 19th decimal place
 * Usdc.fromWad(50n * 10n ** 18n) // a graduation target, as the chain stores it
 * ```
 */
export type Usdc = QuoteAmount;

/** Constructors for native USDC amounts. See {@link Usdc}. */
export const Usdc = {
  /** Zero native USDC. */
  ZERO: QuoteAmount.zero(NATIVE_USDC),
  /** Build from the raw 18-decimal integer: `msg.value`, `eth_getBalance`, every `*Wad`. */
  fromWad: (wad: bigint): QuoteAmount => QuoteAmount.fromWad(NATIVE_USDC, wad),
  /** Build from whole dollars. */
  fromWhole: (whole: bigint): QuoteAmount => QuoteAmount.fromWhole(NATIVE_USDC, whole),
  /** Parse a decimal USDC figure exactly. More than 18 fractional digits is a rejection. */
  parse: (value: string): QuoteAmount => QuoteAmount.parse(NATIVE_USDC, value),
  /** Convert **up** from the 6-decimal ERC-20 interface view. Exact: `x * 1e12`. */
  fromErc20: (amount: UsdcErc20): QuoteAmount =>
    QuoteAmount.fromWad(NATIVE_USDC, amount.raw * USDC_ERC20_SCALE),
} as const;

/**
 * The **same asset** as {@link Usdc}, seen through the 6-decimal ERC-20
 * interface predeploy at `0x3600000000000000000000000000000000000000`.
 *
 * **This type exists only so a caller can convert at the edge.** The predeploy
 * does not pay for gas and no arcnow.io contract reads, writes, calls or
 * imports it; nothing in this SDK's call path accepts or returns a
 * `UsdcErc20`. If you are holding one and about to send a transaction, you have
 * one conversion left to do: {@link Usdc.fromErc20}.
 */
export class UsdcErc20 {
  declare private readonly __brand: "UsdcErc20";

  /** The raw 6-decimal integer, as the predeploy reports it. */
  readonly raw: bigint;

  private constructor(raw: bigint) {
    this.raw = raw;
  }

  /** Zero. */
  static readonly ZERO: UsdcErc20 = new UsdcErc20(0n);

  /** Build from the raw 6-decimal integer an ERC-20 `balanceOf` returns. */
  static fromRaw(raw: bigint): UsdcErc20 {
    return new UsdcErc20(requireNonNegative(raw, "UsdcErc20"));
  }

  /** Build from whole dollars. */
  static fromWhole(whole: bigint): UsdcErc20 {
    return new UsdcErc20(requireNonNegative(whole, "UsdcErc20") * 10n ** 6n);
  }

  /** Parse a decimal figure exactly. More than 6 fractional digits is rejected. */
  static parse(value: string): UsdcErc20 {
    return new UsdcErc20(parseFixed(value, USDC_ERC20_DECIMALS, "UsdcErc20"));
  }

  /** Convert **up** to the native 18-decimal view. Exact. */
  toNative(): Usdc {
    return Usdc.fromErc20(this);
  }

  /** The decimal figure, for display. */
  toString(): string {
    return formatFixed(this.raw, USDC_ERC20_DECIMALS);
  }

  /** The decimal figure with the ticker. */
  format(): string {
    return `${this.toString()} USDC`;
  }

  /** JSON round-trips as the decimal figure. */
  toJSON(): string {
    return this.toString();
  }
}

/**
 * A quantity of a launched arcnow.io token, 18 decimals.
 *
 * Distinct from {@link Usdc} so that a token quantity cannot be handed to
 * something that wants money. The two are both 18-decimal wads and would be
 * freely interchangeable as `bigint`s — and `sell(minUsdcOut, tokensIn)` with
 * the arguments the wrong way round is a trade that either reverts on slippage
 * or fills at a price nobody chose.
 */
export class Tokens {
  declare private readonly __brand: "Tokens";

  /** The raw 18-decimal integer, which is what gets encoded into a call. */
  readonly wad: bigint;

  private constructor(wad: bigint) {
    this.wad = wad;
  }

  /** Zero tokens. */
  static readonly ZERO: Tokens = new Tokens(0n);

  /** Build from the raw 18-decimal integer the contracts and events carry. */
  static fromWad(wad: bigint): Tokens {
    return new Tokens(requireNonNegative(wad, "Tokens"));
  }

  /** Build from whole tokens. `Tokens.fromWhole(1_000_000n)` is a whole million. */
  static fromWhole(whole: bigint): Tokens {
    return new Tokens(requireNonNegative(whole, "Tokens") * WAD);
  }

  /** Parse a decimal token figure exactly. More than 18 fractional digits is rejected. */
  static parse(value: string): Tokens {
    return new Tokens(parseFixed(value, WAD_DECIMALS, "Tokens"));
  }

  /** Sum. */
  add(other: Tokens): Tokens {
    return new Tokens(this.wad + other.wad);
  }

  /** Difference; throws on underflow. */
  sub(other: Tokens): Tokens {
    return new Tokens(requireNonNegative(this.wad - other.wad, "Tokens.sub"));
  }

  /** Difference, floored at zero. */
  subSaturating(other: Tokens): Tokens {
    return new Tokens(this.wad > other.wad ? this.wad - other.wad : 0n);
  }

  /** `-1`, `0` or `1`. */
  compare(other: Tokens): -1 | 0 | 1 {
    return this.wad < other.wad ? -1 : this.wad > other.wad ? 1 : 0;
  }

  /** True when both hold the same raw wad. */
  eq(other: Tokens): boolean {
    return this.wad === other.wad;
  }

  /** True when this is strictly larger. */
  gt(other: Tokens): boolean {
    return this.wad > other.wad;
  }

  /** True when this is strictly smaller. */
  lt(other: Tokens): boolean {
    return this.wad < other.wad;
  }

  /** True for exactly zero. */
  isZero(): boolean {
    return this.wad === 0n;
  }

  /** The decimal token figure, for display. */
  toString(): string {
    return formatFixed(this.wad, WAD_DECIMALS);
  }

  /** The decimal figure with a symbol, for a line of output. */
  format(symbol?: string): string {
    return symbol === undefined ? this.toString() : `${this.toString()} ${symbol}`;
  }

  /** JSON round-trips as the decimal figure. */
  toJSON(): string {
    return this.toString();
  }
}

/**
 * Basis points — one hundredth of a percent.
 *
 * **Read every fee share on this platform as bps *of the fee*, never of the
 * trade.** The trade fee is a flat 1% and is not a platform's to change; what a
 * platform configures is how that 1% is divided. So a creator share of 3000 bps
 * is **30% of the fee** and **0.30% of the trade**. Getting those two the wrong
 * way round is the single easiest mistake in this design and the most expensive
 * to find in production, which is why the conversion lives on the type:
 * {@link Bps.percentOfFee} and {@link Bps.percentOfTrade}.
 *
 * The one place bps means something else is {@link CurveState.progressBps},
 * which is progress toward the graduation target out of 10,000. It is not a fee
 * share and nothing splits it.
 */
export class Bps {
  declare private readonly __brand: "Bps";

  /** The raw basis points, as the contracts store them. */
  readonly bps: bigint;

  private constructor(bps: bigint) {
    this.bps = bps;
  }

  /** The denominator: 10,000 bps is the whole of whatever is being divided. */
  static readonly DENOMINATOR = 10_000n;

  /** Zero. */
  static readonly ZERO: Bps = new Bps(0n);

  /** Build from raw basis points. */
  static of(bps: bigint | number): Bps {
    const raw = typeof bps === "number" ? BigInt(bps) : bps;
    if (raw < 0n) {
      throw new AmountParseError(`Bps: ${raw} is negative; basis points are a uint256.`);
    }
    return new Bps(raw);
  }

  /**
   * Build from a percentage **of the fee**, which is the framing every share in
   * `IFeeConfig` uses. `Bps.ofFee(30)` is 3000 bps — 30% of the fee, 0.30% of
   * the trade at the shipped 1%.
   */
  static ofFee(percentOfFee: number): Bps {
    return Bps.of(BigInt(Math.round(percentOfFee * 100)));
  }

  /** This share as a percentage **of the fee**. 3000 bps -> `30`. */
  percentOfFee(): number {
    return Number(this.bps) / 100;
  }

  /**
   * This share as a percentage **of the trade**, given the trade fee. With the
   * shipped 100 bps fee, 3000 bps -> `0.3`.
   */
  percentOfTrade(tradeFee: Bps): number {
    return (Number(this.bps) * Number(tradeFee.bps)) / (100 * Number(Bps.DENOMINATOR));
  }

  /** Apply this share to a quote amount, flooring — the way the contracts do. Keeps the quote. */
  applyToQuote(amount: QuoteAmount): QuoteAmount {
    return QuoteAmount.fromWad(amount.token, (amount.wad * this.bps) / Bps.DENOMINATOR);
  }

  /** Apply this share to a token amount, flooring. */
  applyToTokens(amount: Tokens): Tokens {
    return Tokens.fromWad((amount.wad * this.bps) / Bps.DENOMINATOR);
  }

  /** Sum, for totalling a split. */
  add(other: Bps): Bps {
    return new Bps(this.bps + other.bps);
  }

  /** True when both are the same. */
  eq(other: Bps): boolean {
    return this.bps === other.bps;
  }

  /** `"3000 bps"`. Deliberately not `"30%"`: which 30% is exactly the ambiguity. */
  toString(): string {
    return `${this.bps} bps`;
  }

  /** JSON round-trips as the raw number, which is what an API would carry. */
  toJSON(): number {
    return Number(this.bps);
  }
}
