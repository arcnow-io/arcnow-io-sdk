/**
 * The residual, and the field that is not there.
 *
 * A platform's own cut is never an input anywhere in the contracts. These tests
 * pin that both ways: the arithmetic says what the residual is, and the
 * `NewPlatform` shape has nowhere to put one.
 */

import { describe, expect, it } from "vitest";

import { Bps } from "../../src/amounts.js";
import { CurveTemplate } from "../../src/curve-template.js";
import { isArcNowError } from "../../src/errors/index.js";
import {
  BPS_DENOMINATOR,
  MAX_PLATFORM_ALLOWANCE_BPS,
  TRADE_FEE_BPS,
  platformShareBps,
  totalOf,
  validateNewPlatform,
} from "../../src/fees.js";
import { Usdc } from "../../src/amounts.js";
import type { NewPlatform } from "../../src/fees.js";

const address = "0x1111111111111111111111111111111111111111" as const;

function newPlatform(creator: bigint, ref: bigint, dev: bigint): NewPlatform {
  return {
    admin: address,
    feeRecipient: address,
    creatorShareBps: Bps.of(creator),
    refShareBps: Bps.of(ref),
    devShareBps: Bps.of(dev),
    defaultMigrator: address,
    curve: CurveTemplate.arcnowDefaults(),
  };
}

describe("the platform's share is the residual", () => {
  it("reproduces arcnow.io's own shipped split", () => {
    // ArcConstants: creator 3000, ref 1000, dev 1000, protocol 2500, and the
    // platform's DEFAULT_PLATFORM_SHARE_BPS of 2500 falls out as the residual.
    const residual = platformShareBps(Bps.of(3000n), Bps.of(1000n), Bps.of(1000n));
    expect(residual.bps).toBe(2500n);

    // And the five total the whole fee.
    const protocol = 2500n;
    expect(3000n + 1000n + 1000n + residual.bps + protocol).toBe(BPS_DENOMINATOR);
  });

  it("gives the platform everything it does not allocate", () => {
    expect(platformShareBps(Bps.ZERO, Bps.ZERO, Bps.ZERO).bps).toBe(7500n);
    expect(platformShareBps(Bps.of(7500n), Bps.ZERO, Bps.ZERO).bps).toBe(0n);
    // Zeroing ref and dev moves those bps to the platform: the same rule that
    // applies at swap time when a ref or dev ADDRESS is zero.
    expect(platformShareBps(Bps.of(3000n), Bps.ZERO, Bps.ZERO).bps).toBe(4500n);
  });

  it("measures the allowance against the MAXIMUM protocol share, not the current one", () => {
    // 7500 = 10000 - 2500, where 2500 is MAX_PROTOCOL_SHARE_BPS. A protocol
    // admin lowering their cut widens every platform's residual and can never
    // invalidate a stored configuration.
    expect(MAX_PLATFORM_ALLOWANCE_BPS).toBe(BPS_DENOMINATOR - 2500n);
  });

  it("refuses an over-allocation and states the residual being chosen", () => {
    try {
      platformShareBps(Bps.of(5000n), Bps.of(2000n), Bps.of(1000n));
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("FeeSharesExceedAllowance");
      expect(error.message).toContain("8000 bps");
      expect(error.message).toMatch(/residual of -500 bps.*deficit/s);
      expect(error.message).toMatch(/bring the three down by 500 bps/i);
      // And restates the units, because this is where people get them wrong.
      expect(error.message).toMatch(/bps of the \*\*fee\*\*/);
      expect(error.details.requestedBps).toBe(8000);
      expect(error.details.allowanceBps).toBe(7500);
    }
  });

  it("allows a platform to hand its whole allowance to the creator", () => {
    // The "creator 75 / ArcNow 25" arrangement is not a special regime: it is a
    // platform allocating all 7500 bps to the creator and keeping nothing.
    expect(platformShareBps(Bps.of(7500n), Bps.ZERO, Bps.ZERO).bps).toBe(0n);
  });
});

describe("NewPlatform", () => {
  it("has no platform-share field at all", () => {
    const platform = newPlatform(3000n, 1000n, 1000n);
    expect(Object.keys(platform).sort()).toEqual([
      "admin",
      "creatorShareBps",
      "curve",
      "defaultMigrator",
      "devShareBps",
      "feeRecipient",
      "refShareBps",
    ]);
    expect(Object.keys(platform)).not.toContain("platformShareBps");
    // The compile-time half of this is in test/types/brands.test-d.ts.
  });

  it("validates the split before any gas is spent", () => {
    expect(validateNewPlatform(newPlatform(3000n, 1000n, 1000n)).platformShare.bps).toBe(2500n);
    expect(() => validateNewPlatform(newPlatform(6000n, 1000n, 1000n)))
      .toThrow(/at most 7500/);
  });

  it("refuses a zero fee recipient with the reason rather than the rule", () => {
    const broken = { ...newPlatform(3000n, 1000n, 1000n), feeRecipient: `0x${"0".repeat(40)}` as const };
    try {
      validateNewPlatform(broken);
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.message).toMatch(/send its whole cut nowhere, on every trade, forever/);
    }
  });
});

describe("a fee split totals the fee exactly", () => {
  it("adds up, including when four shares floor to zero", () => {
    // The platform is the residual claimant, so a one-wei fee is entirely
    // the platform's and nothing is lost or created.
    const split = {
      creator: address,
      platform: address,
      ref: address,
      dev: address,
      protocol: address,
      creatorAmount: Usdc.ZERO,
      platformAmount: Usdc.fromWad(1n),
      refAmount: Usdc.ZERO,
      devAmount: Usdc.ZERO,
      protocolAmount: Usdc.ZERO,
    };
    expect(totalOf(split).wad).toBe(1n);
  });
});

describe("the trade fee is not a platform's to change", () => {
  it("is a flat 100 bps — 1% — on both sides", () => {
    expect(TRADE_FEE_BPS).toBe(100n);
    // 3000 bps of the fee is 0.30% of the trade, which is the confusion this
    // whole module exists to prevent.
    expect(Bps.of(3000n).percentOfTrade(Bps.of(TRADE_FEE_BPS))).toBeCloseTo(0.3, 12);
  });
});
