/**
 * Money in whichever quote a curve was launched against.
 *
 * A curve's quote is native USDC (18 decimals, paid as msg.value) or an
 * allowlisted ERC-20 such as EURC (6 decimals, pulled with an allowance). The
 * contracts keep every amount in 18-decimal WAD whatever the quote, and move
 * `wad / 10^(18 - decimals)` raw units of an ERC-20. So an amount is a WAD
 * **plus the token it is denominated in**, and the one thing that must never
 * happen silently is a WAD that does not divide into whole raw units, or two
 * quotes added together.
 */

import { describe, expect, it } from "vitest";

import {
  AmountParseError,
  Bps,
  MAX_QUOTE_DECIMALS,
  NATIVE_QUOTE,
  NATIVE_USDC,
  QuoteAmount,
  quoteScaleOf,
  quoteTokenInfo,
  Usdc,
  UsdcErc20,
} from "../../src/amounts.js";
import { isArcNowError } from "../../src/errors/index.js";

const EURC = quoteTokenInfo({
  address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  symbol: "EURC",
  name: "EURC",
  decimals: 6,
});

/** An 18-decimal ERC-20 quote: scale 1, like native, but pulled rather than sent. */
const WETH_LIKE = quoteTokenInfo({
  address: "0x00000000000000000000000000000000000e7418",
  symbol: "W18",
  name: "Eighteen",
  decimals: 18,
});

interface Refused { code: string; details: Record<string, unknown>; message: string }

function refusal(run: () => unknown): Refused {
  try {
    run();
  } catch (error) {
    if (!isArcNowError(error)) throw error;
    return { code: String(error.code), details: { ...error.details }, message: error.message };
  }
  throw new Error("expected a refusal");
}

describe("QuoteTokenInfo", () => {
  it("names native USDC as the zero address at 18 decimals", () => {
    expect(NATIVE_QUOTE).toBe("0x0000000000000000000000000000000000000000");
    expect(NATIVE_USDC).toEqual({
      address: NATIVE_QUOTE, symbol: "USDC", name: "USD Coin", decimals: 18, isNative: true,
    });
    expect(MAX_QUOTE_DECIMALS).toBe(18);
  });

  it("derives the scale from the decimals: 1 for 18, 1e12 for 6", () => {
    expect(quoteScaleOf(NATIVE_USDC)).toBe(1n);
    expect(quoteScaleOf(EURC)).toBe(10n ** 12n);
    expect(quoteScaleOf(WETH_LIKE)).toBe(1n);
  });

  it("normalises the address and derives isNative from it", () => {
    expect(EURC.address).toBe("0x89b50855aa3be2f677cd6303cec089b5f319d72a");
    expect(EURC.isNative).toBe(false);
    expect(WETH_LIKE.isNative).toBe(false);
    expect(quoteTokenInfo({ address: NATIVE_QUOTE, symbol: "USDC", name: "USD Coin", decimals: 18 }))
      .toEqual(NATIVE_USDC);
  });

  it("refuses a quote the contracts refuse: more than 18 decimals", () => {
    const refused = refusal(() => quoteTokenInfo({ ...EURC, decimals: 19 }));
    expect(refused.code).toBe("InvalidArgument");
    expect(refused.message).toMatch(/18/);
  });

  it("refuses native USDC at anything but 18 decimals, and a malformed address", () => {
    expect(refusal(() => quoteTokenInfo({ ...NATIVE_USDC, decimals: 6 })).code).toBe("InvalidArgument");
    expect(refusal(() => quoteTokenInfo({ ...EURC, address: "0x1234" })).code)
      .toBe("InvalidArgument");
  });
});

describe("a native USDC amount", () => {
  it("is every Usdc there is: the alias builds native amounts", () => {
    const amount = Usdc.parse("2.5");
    expect(amount).toBeInstanceOf(QuoteAmount);
    expect(amount.token).toEqual(NATIVE_USDC);
    expect(amount.wad).toBe(25n * 10n ** 17n);
    expect(Usdc.fromWhole(3n).eq(QuoteAmount.parse(NATIVE_USDC, "3"))).toBe(true);
    expect(Usdc.ZERO.token.isNative).toBe(true);
  });

  it("is always representable, raw is the wad itself", () => {
    const dust = Usdc.fromWad(1n);
    expect(dust.isRepresentable()).toBe(true);
    expect(dust.toRaw()).toBe(1n);
  });

  it("still converts to and from the 6-decimal USDC interface at the edge", () => {
    expect(Usdc.fromErc20(UsdcErc20.parse("1")).wad).toBe(10n ** 18n);
    expect(Usdc.parse("1.2345678").toErc20().raw).toBe(1_234_567n);
  });
});

describe("a 6-decimal ERC-20 amount (EURC)", () => {
  it("holds WAD, and moves wad / 1e12 raw units", () => {
    const amount = QuoteAmount.parse(EURC, "1.25");
    expect(amount.wad).toBe(1_250_000_000_000_000_000n);
    expect(amount.toRaw()).toBe(1_250_000n);
    expect(QuoteAmount.fromRaw(EURC, 1n).wad).toBe(10n ** 12n);
    expect(QuoteAmount.fromWhole(EURC, 50n).toRaw()).toBe(50_000_000n);
  });

  it("parses exactly in the quote's own decimals, refusing a 7th digit", () => {
    expect(() => QuoteAmount.parse(EURC, "1.1234567")).toThrow(AmountParseError);
    expect(() => QuoteAmount.parse(EURC, "1.1234567")).toThrow(/7 fractional digits/);
    expect(() => QuoteAmount.parse(EURC, "1.1234567")).toThrow(/EURC/);
  });

  it("refuses to name a raw amount for a WAD that does not divide into whole raw units", () => {
    const dusty = QuoteAmount.fromWad(EURC, 10n ** 12n + 1n);
    expect(dusty.isRepresentable()).toBe(false);
    const refused = refusal(() => dusty.toRaw());
    expect(refused.code).toBe("QuoteAmountNotRepresentable");
    expect(refused.details).toMatchObject({ amountWad: 10n ** 12n + 1n, quoteScale: 10n ** 12n });
    expect(refused.message).toMatch(/floorToRepresentable|ceilToRepresentable/);
  });

  it("rounds down or up to a representable amount, and leaves one alone", () => {
    const dusty = QuoteAmount.fromWad(EURC, 3n * 10n ** 12n + 5n);
    expect(dusty.floorToRepresentable().wad).toBe(3n * 10n ** 12n);
    expect(dusty.ceilToRepresentable().wad).toBe(4n * 10n ** 12n);
    const exact = QuoteAmount.parse(EURC, "7");
    expect(exact.floorToRepresentable().eq(exact)).toBe(true);
    expect(exact.ceilToRepresentable().eq(exact)).toBe(true);
    expect(dusty.floorToRepresentable().token).toEqual(EURC);
  });

  it("renders in its own decimals and symbol, and shows dust rather than hiding it", () => {
    expect(QuoteAmount.parse(EURC, "1.250000").toString()).toBe("1.25");
    expect(QuoteAmount.parse(EURC, "1.25").format()).toBe("1.25 EURC");
    expect(QuoteAmount.fromWad(EURC, 1n).toString()).toBe("0.000000000000000001");
    expect(JSON.stringify({ amount: QuoteAmount.parse(EURC, "3.5") })).toBe("{\"amount\":\"3.5\"}");
  });

  it("has no 6-decimal USDC view, because it is not USDC", () => {
    expect(refusal(() => QuoteAmount.parse(EURC, "1").toErc20()).code).toBe("InvalidArgument");
  });
});

describe("an 18-decimal ERC-20 amount", () => {
  it("has scale 1, so every WAD is representable, and is not native", () => {
    const amount = QuoteAmount.parse(WETH_LIKE, "0.000000000000000003");
    expect(amount.toRaw()).toBe(3n);
    expect(amount.isRepresentable()).toBe(true);
    expect(amount.token.isNative).toBe(false);
    expect(amount.format()).toBe("0.000000000000000003 W18");
  });
});

describe("two quotes never mix", () => {
  it("refuses arithmetic and comparison across quotes", () => {
    const eur = QuoteAmount.parse(EURC, "1");
    const usd = Usdc.parse("1");
    for (const [name, run] of [
      ["add", () => eur.add(usd)],
      ["sub", () => eur.sub(usd)],
      ["subSaturating", () => eur.subSaturating(usd)],
      ["compare", () => eur.compare(usd)],
      ["eq", () => eur.eq(usd)],
      ["gt", () => eur.gt(usd)],
      ["lt", () => usd.lt(eur)],
    ] as [string, () => unknown][]) {
      const refused = refusal(run);
      expect(refused.code, name).toBe("QuoteTokenMismatch");
      expect(refused.message, name).toMatch(/EURC/);
      expect(refused.message, name).toMatch(/USDC/);
    }
  });

  it("treats the same quote under a different address case as the same quote", () => {
    const upper = quoteTokenInfo({ ...EURC, address: "0x89B50855AA3BE2F677CD6303CEC089B5F319D72A" });
    expect(QuoteAmount.parse(EURC, "1").add(QuoteAmount.parse(upper, "2")).toString()).toBe("3");
  });

  it("keeps sub's underflow refusal", () => {
    expect(() => QuoteAmount.parse(EURC, "1").sub(QuoteAmount.parse(EURC, "2"))).toThrow(/negative/);
  });
});

describe("Bps applied to a quote", () => {
  it("floors, the way the contracts do, and keeps the quote", () => {
    const share = Bps.of(3000n).applyToQuote(QuoteAmount.parse(EURC, "100"));
    expect(share.toString()).toBe("30");
    expect(share.token).toEqual(EURC);
    expect(Bps.of(3000n).applyToQuote(Usdc.fromWad(1n)).wad).toBe(0n);
  });
});
