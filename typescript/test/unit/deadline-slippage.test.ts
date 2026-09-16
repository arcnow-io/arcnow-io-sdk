/**
 * Deadlines and slippage floors: the two arguments a caller is most tempted to
 * leave at their most dangerous value.
 */

import { describe, expect, it, vi } from "vitest";

import { Bps, Tokens, Usdc } from "../../src/amounts.js";
import { Deadline } from "../../src/deadline.js";
import { minTokensOutFromQuote, minQuoteOutFromQuote } from "../../src/slippage.js";
import type { BuyQuote, SellQuote } from "../../src/types.js";

describe("Deadline", () => {
  it("is unix SECONDS, not milliseconds", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const now = 1_767_225_600n; // 2026-01-01T00:00:00Z in seconds
      expect(Deadline.inSeconds(0).unixSeconds).toBe(now);
      expect(Deadline.inMinutes(5).unixSeconds).toBe(now + 300n);
      // Date.now() is milliseconds and is three orders of magnitude larger.
      // The named constructors are what stop that becoming a deadline ~50,000
      // years out, which is to say no deadline at all, silently.
      expect(Deadline.inMinutes(5).unixSeconds).toBeLessThan(BigInt(Date.now()));
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes an absolute instant", () => {
    expect(Deadline.at(1_700_000_000n).unixSeconds).toBe(1_700_000_000n);
    expect(Deadline.at(1_700_000_000).unixSeconds).toBe(1_700_000_000n);
    expect(Deadline.at(1_700_000_000n).toDate()?.toISOString())
      .toBe("2023-11-14T22:13:20.000Z");
  });

  it("opts out with uint256 max, and says so rather than printing a huge number", () => {
    const none = Deadline.none();
    expect(none.unixSeconds).toBe(2n ** 256n - 1n);
    expect(none.isNone).toBe(true);
    expect(none.toDate()).toBeUndefined();
    expect(none.toString()).toBe("no deadline");
  });
});

describe("slippage floors", () => {
  const buy: BuyQuote = {
    tokensOut: Tokens.fromWhole(1_000n),
    fee: Usdc.parse("0.1"),
    quoteSpent: Usdc.parse("10"),
    refund: Usdc.ZERO,
    newReserve: Usdc.parse("3765"),
    newTokensSold: Tokens.fromWhole(1_000n),
    newPrice: Usdc.fromWad(13_500_000_000_000n),
    graduates: false,
  };

  const sell: SellQuote = {
    quoteOut: Usdc.parse("9.8"),
    fee: Usdc.parse("0.1"),
    gross: Usdc.parse("9.9"),
    newReserve: Usdc.parse("3755"),
    newTokensSold: Tokens.ZERO,
    newPrice: Usdc.fromWad(13_488_642_643_250n),
  };

  it("takes a tolerance off the quote, flooring", () => {
    expect(minTokensOutFromQuote(buy, Bps.of(50n)).toString()).toBe("995"); // 0.5%
    expect(minTokensOutFromQuote(buy, Bps.of(100n)).toString()).toBe("990"); // 1%
    expect(minQuoteOutFromQuote(sell, Bps.of(50n)).toString()).toBe("9.751");
  });

  it("a zero tolerance is the quote itself — an exact-or-revert order", () => {
    expect(minTokensOutFromQuote(buy, Bps.ZERO).eq(buy.tokensOut)).toBe(true);
  });

  it("a 10000 bps tolerance is zero, which is the donation the docs warn about", () => {
    expect(minTokensOutFromQuote(buy, Bps.of(10_000n)).isZero()).toBe(true);
  });
});
