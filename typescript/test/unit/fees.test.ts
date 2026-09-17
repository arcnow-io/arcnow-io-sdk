/**
 * The residual, the field that is not there, and the four parties.
 *
 * A platform's own cut is never an input anywhere in the contracts. These tests
 * pin that both ways: the arithmetic says what the residual is, and the
 * `NewPlatform` shape has nowhere to put one. They also pin the fee model's
 * shape — creator, platform, referrer, protocol, and nobody else — and the
 * pool's own rate and split, which are the hook's constants and not the
 * curve's.
 */

import { describe, expect, it } from "vitest";

import { Bps } from "../../src/amounts.js";
import { CurveTemplate } from "../../src/curve-template.js";
import { isArcNowError } from "../../src/errors/index.js";
import {
  BPS_DENOMINATOR,
  FeeShare,
  MAX_PLATFORM_ALLOWANCE_BPS,
  POOL_CREATOR_SHARE_BPS,
  POOL_LP_FEE_PIPS,
  POOL_PLATFORM_SHARE_BPS,
  POOL_PROTOCOL_SHARE_BPS,
  POOL_TICK_SPACING,
  POOL_TOTAL_FEE_BPS,
  POOL_TRADE_FEE_BPS,
  TRADE_FEE_BPS,
  platformShareBps,
  totalOf,
  validateNewPlatform,
} from "../../src/fees.js";
import { Usdc } from "../../src/amounts.js";
import type { FeeConfig, FeeSplit, NewPlatform } from "../../src/fees.js";

const address = "0x1111111111111111111111111111111111111111" as const;

function newPlatform(creator: bigint, ref: bigint): NewPlatform {
  return {
    admin: address,
    feeRecipient: address,
    creatorShareBps: Bps.of(creator),
    refShareBps: Bps.of(ref),
    defaultMigrator: address,
    curve: CurveTemplate.arcnowDefaults(),
  };
}

describe("the platform's share is the residual", () => {
  it("reproduces arcnow.io's own shipped split", () => {
    // ArcConstants: creator 3000, ref 1000, protocol 2500, and the platform's
    // DEFAULT_PLATFORM_SHARE_BPS of 3500 falls out as the residual.
    const residual = platformShareBps(Bps.of(3000n), Bps.of(1000n));
    expect(residual.bps).toBe(3500n);

    // And the four total the whole fee.
    const protocol = 2500n;
    expect(3000n + 1000n + residual.bps + protocol).toBe(BPS_DENOMINATOR);
  });

  it("gives the platform everything it does not allocate", () => {
    expect(platformShareBps(Bps.ZERO, Bps.ZERO).bps).toBe(7500n);
    expect(platformShareBps(Bps.of(7500n), Bps.ZERO).bps).toBe(0n);
    // Zeroing ref moves those bps to the platform: the same rule that applies
    // at swap time when the ref ADDRESS is zero.
    expect(platformShareBps(Bps.of(3000n), Bps.ZERO).bps).toBe(4500n);
  });

  it("measures the allowance against the MAXIMUM protocol share, not the current one", () => {
    // 7500 = 10000 - 2500, where 2500 is MAX_PROTOCOL_SHARE_BPS. A protocol
    // admin lowering their cut widens every platform's residual and can never
    // invalidate a stored configuration.
    expect(MAX_PLATFORM_ALLOWANCE_BPS).toBe(BPS_DENOMINATOR - 2500n);
  });

  it("refuses an over-allocation and states the residual being chosen", () => {
    try {
      platformShareBps(Bps.of(6000n), Bps.of(2000n));
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("FeeSharesExceedAllowance");
      expect(error.message).toContain("8000 bps");
      expect(error.message).toMatch(/residual of -500 bps.*deficit/s);
      expect(error.message).toMatch(/bring the two down by 500 bps/i);
      // And restates the units, because this is where people get them wrong.
      expect(error.message).toMatch(/bps of the \*\*fee\*\*/);
      expect(error.details.requestedBps).toBe(8000);
      expect(error.details.allowanceBps).toBe(7500);
    }
  });

  it("allows a platform to hand its whole allowance to the creator", () => {
    // The "creator 75 / ArcNow 25" arrangement is not a special regime: it is a
    // platform allocating all 7500 bps to the creator and keeping nothing.
    expect(platformShareBps(Bps.of(7500n), Bps.ZERO).bps).toBe(0n);
  });
});

describe("NewPlatform", () => {
  it("has no platform-share field and no developer-share field at all", () => {
    const platform = newPlatform(3000n, 1000n);
    expect(Object.keys(platform).sort()).toEqual([
      "admin",
      "creatorShareBps",
      "curve",
      "defaultMigrator",
      "feeRecipient",
      "refShareBps",
    ]);
    expect(Object.keys(platform)).not.toContain("platformShareBps");
    expect(Object.keys(platform)).not.toContain("devShareBps");
    // The compile-time half of this is in test/types/brands.test-d.ts.
  });

  it("validates the split before any gas is spent", () => {
    expect(validateNewPlatform(newPlatform(3000n, 1000n)).platformShare.bps).toBe(3500n);
    expect(() => validateNewPlatform(newPlatform(7000n, 1000n)))
      .toThrow(/at most 7500/);
  });

  it("refuses a zero fee recipient with the reason rather than the rule", () => {
    const broken = { ...newPlatform(3000n, 1000n), feeRecipient: `0x${"0".repeat(40)}` as const };
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
  it("adds up, including when three shares floor to zero", () => {
    // The platform is the residual claimant, so a one-wei fee is entirely
    // the platform's and nothing is lost or created.
    const split: FeeSplit = {
      creator: address,
      platform: address,
      ref: address,
      protocol: address,
      creatorAmount: Usdc.ZERO,
      platformAmount: Usdc.fromWad(1n),
      refAmount: Usdc.ZERO,
      protocolAmount: Usdc.ZERO,
    };
    expect(totalOf(split).wad).toBe(1n);
    expect(Object.keys(split)).not.toContain("dev");
    expect(Object.keys(split)).not.toContain("devAmount");
  });

  it("is four parties: a FeeConfig has creator, platform, ref and protocol shares and nothing else", () => {
    const config: FeeConfig = {
      creatorShareBps: Bps.of(3000n),
      platformShareBps: Bps.of(3500n),
      refShareBps: Bps.of(1000n),
      protocolShareBps: Bps.of(2500n),
      platformRecipient: address,
      protocolRecipient: address,
    };
    const shares = [
      config.creatorShareBps, config.platformShareBps, config.refShareBps, config.protocolShareBps,
    ];
    expect(shares.reduce((sum, share) => sum + share.bps, 0n)).toBe(BPS_DENOMINATOR);
    expect(Object.keys(config)).not.toContain("devShareBps");
  });
});

describe("FeeShare, the enum a FeePaid / FeeDeferred log carries in its share topic", () => {
  it("is Creator 0, Platform 1, Ref 2, Protocol 3 — Protocol is 3 now that there is no developer", () => {
    expect(FeeShare.Creator).toBe(0);
    expect(FeeShare.Platform).toBe(1);
    expect(FeeShare.Ref).toBe(2);
    expect(FeeShare.Protocol).toBe(3);
    expect(Object.keys(FeeShare).filter((key) => key !== "nameOf")).toEqual(["Creator", "Platform", "Ref", "Protocol"]);
    expect(Object.keys(FeeShare)).not.toContain("Dev");
  });

  it("names a share from its topic value, and refuses 4, which was Protocol before the developer share went", () => {
    expect(FeeShare.nameOf(3)).toBe("Protocol");
    expect(FeeShare.nameOf(0)).toBe("Creator");
    expect(FeeShare.nameOf(4)).toBeUndefined();
    expect(FeeShare.nameOf(3n)).toBe("Protocol");
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

describe("a pool charges its own rate on its own split, and it is not the curve's", () => {
  it("has the hook take 80 bps — 0.80% — beside a 0.20% LP fee, 1.00% in all", () => {
    expect(POOL_TRADE_FEE_BPS).toBe(80n);
    expect(POOL_LP_FEE_PIPS).toBe(2000);
    expect(POOL_TICK_SPACING).toBe(60);
    // 2000 hundredths of a bip is 20 bps.
    expect(POOL_TRADE_FEE_BPS + BigInt(POOL_LP_FEE_PIPS) / 100n).toBe(POOL_TOTAL_FEE_BPS);
    // And that total is what the curve charged: no rise at graduation.
    expect(POOL_TOTAL_FEE_BPS).toBe(TRADE_FEE_BPS);
  });

  it("splits the hook's fee creator 5000 / platform 1875 / protocol 3125, no referrer, exactly whole", () => {
    expect(POOL_CREATOR_SHARE_BPS).toBe(5000n);
    expect(POOL_PLATFORM_SHARE_BPS).toBe(1875n);
    expect(POOL_PROTOCOL_SHARE_BPS).toBe(3125n);
    expect(POOL_CREATOR_SHARE_BPS + POOL_PLATFORM_SHARE_BPS + POOL_PROTOCOL_SHARE_BPS)
      .toBe(BPS_DENOMINATOR);
  });

  it("keeps the protocol at a quarter percent of the trade on both sides of graduation", () => {
    // 3125 / 10000 * 0.80% = 0.25%, exactly; 2500 / 10000 * 1.00% = 0.25%.
    const hookRate = Bps.of(POOL_TRADE_FEE_BPS);
    expect(Bps.of(POOL_PROTOCOL_SHARE_BPS).percentOfTrade(hookRate)).toBeCloseTo(0.25, 12);
    expect(Bps.of(2500n).percentOfTrade(Bps.of(TRADE_FEE_BPS))).toBeCloseTo(0.25, 12);
    // The creator earns MORE after graduation: 0.40% of a trade against 0.30%.
    expect(Bps.of(POOL_CREATOR_SHARE_BPS).percentOfTrade(hookRate)).toBeCloseTo(0.4, 12);
  });
});
