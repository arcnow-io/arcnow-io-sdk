/**
 * The 18/6 wall, tested from both sides.
 *
 * These are the tests that matter most in the package and they need no chain at
 * all: if `Usdc` and `UsdcErc20` ever start agreeing with each other, every
 * amount this SDK sends is out by a factor of a trillion and nothing else here
 * would notice.
 */

import { describe, expect, it } from "vitest";

import {
  AmountParseError,
  Bps,
  Tokens,
  Usdc,
  UsdcErc20,
  USDC_ERC20_SCALE,
  WAD,
} from "../../src/amounts.js";

describe("Usdc", () => {
  it("is 18 decimals, because that is what msg.value is on Arc", () => {
    expect(Usdc.fromWhole(1n).wad).toBe(10n ** 18n);
    expect(WAD).toBe(10n ** 18n);
    expect(Usdc.fromWhole(50_000n).wad).toBe(50_000n * 10n ** 18n);
  });

  it("parses a decimal figure exactly", () => {
    expect(Usdc.parse("1.25").wad).toBe(1_250_000_000_000_000_000n);
    expect(Usdc.parse("0.000000000000000001").wad).toBe(1n);
    expect(Usdc.parse("50000").wad).toBe(50_000n * 10n ** 18n);
    expect(Usdc.parse(".5").wad).toBe(5n * 10n ** 17n);
    expect(Usdc.parse("2.").wad).toBe(2n * 10n ** 18n);
  });

  it("rejects a 19th fractional digit rather than truncating it", () => {
    // Truncating is how an amount a user did not choose gets sent.
    expect(() => Usdc.parse("1.0000000000000000009")).toThrow(AmountParseError);
    expect(() => Usdc.parse("1.0000000000000000009")).toThrow(/19 fractional digits/);
  });

  it("rejects things that are not numbers, and negatives", () => {
    expect(() => Usdc.parse("")).toThrow(AmountParseError);
    expect(() => Usdc.parse("1.2.3")).toThrow(AmountParseError);
    expect(() => Usdc.parse("ten")).toThrow(AmountParseError);
    expect(() => Usdc.parse("-1")).toThrow(/unsigned/);
    expect(() => Usdc.fromWad(-1n)).toThrow(/negative/);
  });

  it("renders a decimal figure, never the raw integer", () => {
    expect(Usdc.fromWhole(50_000n).toString()).toBe("50000");
    expect(Usdc.parse("1.25").toString()).toBe("1.25");
    expect(Usdc.fromWad(1n).toString()).toBe("0.000000000000000001");
    expect(Usdc.parse("1.250000").toString()).toBe("1.25");
    expect(Usdc.ZERO.format()).toBe("0 USDC");
  });

  it("adds, subtracts and compares", () => {
    const a = Usdc.parse("10");
    const b = Usdc.parse("2.5");
    expect(a.add(b).toString()).toBe("12.5");
    expect(a.sub(b).toString()).toBe("7.5");
    expect(() => b.sub(a)).toThrow(/negative/);
    expect(b.subSaturating(a).isZero()).toBe(true);
    expect(a.compare(b)).toBe(1);
    expect(b.compare(a)).toBe(-1);
    expect(a.compare(Usdc.parse("10"))).toBe(0);
    expect(a.gt(b)).toBe(true);
    expect(b.lt(a)).toBe(true);
    expect(a.eq(Usdc.parse("10.0"))).toBe(true);
  });
});

describe("UsdcErc20 — the same asset through the 6-decimal interface", () => {
  it("scales up exactly: one ERC-20 dollar is one native dollar", () => {
    const erc20 = UsdcErc20.parse("1");
    expect(erc20.raw).toBe(1_000_000n);
    expect(Usdc.fromErc20(erc20).wad).toBe(10n ** 18n);
    expect(USDC_ERC20_SCALE).toBe(10n ** 12n);
  });

  it("scales down by TRUNCATING toward zero, never rounding up", () => {
    // A wad amount can carry dust six decimals cannot express. Rounding up
    // would promise dollars that do not exist.
    expect(Usdc.parse("1.2345678").toErc20().raw).toBe(1_234_567n);
    expect(Usdc.parse("1.9999999").toErc20().toString()).toBe("1.999999");
    expect(Usdc.fromWad(999_999_999_999n).toErc20().raw).toBe(0n);
  });

  it("round-trips only when the wad amount fits in six decimals", () => {
    const exact = Usdc.parse("1.5");
    expect(Usdc.fromErc20(exact.toErc20()).eq(exact)).toBe(true);

    const dusty = Usdc.parse("1.5000001234");
    expect(Usdc.fromErc20(dusty.toErc20()).eq(dusty)).toBe(false);
  });

  it("rejects a 7th fractional digit", () => {
    expect(() => UsdcErc20.parse("1.1234567")).toThrow(/7 fractional digits/);
  });

  it("is not a Usdc and holds a different raw number for the same money", () => {
    const native = Usdc.parse("1");
    const erc20 = UsdcErc20.parse("1");
    expect(native.wad).not.toBe(erc20.raw);
    expect(native.wad / erc20.raw).toBe(USDC_ERC20_SCALE);
    // Same money, same rendering. The confusion is in the raw integers only.
    expect(native.toString()).toBe(erc20.toString());
  });
});

describe("Tokens", () => {
  it("is 18 decimals and parses exactly", () => {
    expect(Tokens.fromWhole(1_000_000_000n).wad).toBe(1_000_000_000n * 10n ** 18n);
    expect(Tokens.parse("0.5").wad).toBe(5n * 10n ** 17n);
    expect(() => Tokens.parse("1.0000000000000000001")).toThrow(AmountParseError);
  });

  it("carries the same raw wad as the equivalent Usdc, which is exactly why it is a "
    + "separate type", () => {
    expect(Tokens.fromWhole(5n).wad).toBe(Usdc.fromWhole(5n).wad);
    // Structurally identical, nominally distinct: the compiler test in
    // test/types/brands.test-d.ts proves one cannot be passed for the other.
  });

  it("formats with an optional symbol", () => {
    expect(Tokens.parse("1234.5").format("ARC")).toBe("1234.5 ARC");
    expect(Tokens.parse("1234.5").format()).toBe("1234.5");
  });
});

describe("Bps — of the fee, never of the trade", () => {
  it("converts both ways and keeps the two straight", () => {
    const creatorShare = Bps.of(3000n);
    expect(creatorShare.percentOfFee()).toBe(30);
    expect(creatorShare.percentOfTrade(Bps.of(100n))).toBeCloseTo(0.3, 12);
    expect(Bps.ofFee(30).bps).toBe(3000n);
  });

  it("floors when applied, the way the contracts do", () => {
    // 3000 bps of a 1 wei fee is zero. Four such shares are zero and the
    // platform's residual takes the lot.
    expect(Bps.of(3000n).applyToQuote(Usdc.fromWad(1n)).wad).toBe(0n);
    expect(Bps.of(3000n).applyToQuote(Usdc.fromWhole(100n)).toString()).toBe("30");
    expect(Bps.of(100n).applyToTokens(Tokens.fromWhole(1000n)).toString()).toBe("10");
  });

  it("renders as bps rather than as a percentage, because which percentage is the "
    + "whole ambiguity", () => {
    expect(Bps.of(3000n).toString()).toBe("3000 bps");
  });

  it("refuses a negative", () => {
    expect(() => Bps.of(-1n)).toThrow(/negative/);
  });
});
