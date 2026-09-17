/**
 * One curve: `arcnow/bonding-curve@4.x.x`, the fee-model constant-product
 * curve. Every other bonding-curve version — the retired multi-quote `@3.x.x`
 * stack, the version-2 native-only curve and the `@1.x.x` linear curve — is
 * refused by name and never priced, and an address that is not a bonding curve
 * at all is told apart from all of them.
 */

import { describe, expect, it } from "vitest";

import {
  assertCurveVersion,
  assertHookVersion,
  assertLaunchpadVersion,
  assertPlatformVersion,
  assertQuoteRegistryVersion,
  assertRegistryVersion,
} from "../../src/curve-version.js";
import { isArcNowError } from "../../src/errors/index.js";

function refusal(run: () => unknown): {
  code: string; message: string; version: unknown; component: unknown; address: unknown;
} {
  try {
    run();
  } catch (error) {
    if (!isArcNowError(error)) throw error;
    return {
      code: String(error.code),
      message: error.message,
      version: error.details.version,
      component: error.details.component,
      address: error.details.address,
    };
  }
  throw new Error("expected a refusal");
}

describe("a bonding curve's version", () => {
  it("accepts @4.x.x, the fee-model constant-product curve", () => {
    expect(() => assertCurveVersion("arcnow/bonding-curve@4.0.0")).not.toThrow();
    expect(() => assertCurveVersion("arcnow/bonding-curve@4.1.3")).not.toThrow();
  });

  it.each([
    "arcnow/bonding-curve@3.0.0",
    "arcnow/bonding-curve@3.9.9",
    "arcnow/bonding-curve@2.0.0",
    "arcnow/bonding-curve@1.0.0",
    "arcnow/bonding-curve@5.0.0",
    "arcnow/bonding-curve@0.9.0",
    "arcnow/bonding-curve@4",
    "arcnow/bonding-curve@4.0",
    "arcnow/bonding-curve@4.0.0-rc1",
    "arcnow/bonding-curve@",
  ])("refuses the bonding-curve version %j as unknown, naming it, never pricing it", (version) => {
    const refused = refusal(() => assertCurveVersion(version, "the curve at 0xa1", "0xa1"));
    expect(refused.code).toBe("UnknownCurveVersion");
    expect(refused.version).toBe(version);
    expect(refused.component).toBe("bonding-curve");
    expect(refused.address).toBe("0xa1");
    expect(refused.message).toContain(JSON.stringify(version));
    expect(refused.message).toContain("arcnow/bonding-curve@4.x.x");
    expect(refused.message).toMatch(/No local maths and\s+no trade/);
    expect(refused.message).not.toMatch(/linear/i);
  });

  it("refuses a @3.x.x curve by name: the retired multi-quote stack, whose data was wiped", () => {
    const refused = refusal(() => assertCurveVersion("arcnow/bonding-curve@3.0.0"));
    expect(refused.code).toBe("UnknownCurveVersion");
    expect(refused.message).toMatch(/retired/);
    expect(refused.message).toMatch(/multi-quote/);
    expect(refused.message).toMatch(/developer share/);
    expect(refused.message).not.toMatch(/predates quote tokens/);
  });

  it("says why a version-2 curve is refused: it predates quote tokens", () => {
    const refused = refusal(() => assertCurveVersion("arcnow/bonding-curve@2.0.0"));
    expect(refused.message).toMatch(/quote token/);
    expect(refused.message).not.toMatch(/retired multi-quote/);
  });

  it.each([
    ["arcnow/arc-token@1.0.0", "arc-token"],
    ["arcnow/curve-factory@4.0.0", "curve-factory"],
    ["arcnow/platform-config@4.0.0", "platform-config"],
    ["arcnow/uniswap-v4-migrator@2.0.0", "uniswap-v4-migrator"],
    [" arcnow/bonding-curve@4.0.0", undefined],
    ["", undefined],
    ["UniswapV4Router04", undefined],
  ])("refuses %j as AddressIsNotACurve, naming what it says it is", (version, component) => {
    const refused = refusal(() => assertCurveVersion(version));
    expect(refused.code).toBe("AddressIsNotACurve");
    expect(refused.version).toBe(version);
    expect(refused.component).toBe(component);
    expect(refused.message).toContain(JSON.stringify(version));
    expect(refused.message).toMatch(/not a bonding curve/);
  });

  it("tells a caller who passed a token where its curve is", () => {
    const refused = refusal(() => assertCurveVersion("arcnow/arc-token@1.0.0", "0xb3"));
    expect(refused.message).toMatch(/a token, not a curve/);
    expect(refused.message).toMatch(/token\.curve\(\)|client\.trade\(/);
  });
});

describe("the other components' versions", () => {
  it("accepts the fee-model stack's majors", () => {
    expect(() => assertPlatformVersion("arcnow/platform-config@4.0.0")).not.toThrow();
    expect(() => assertRegistryVersion("arcnow/platform-registry@4.3.1")).not.toThrow();
    expect(() => assertHookVersion("arcnow/arc-now-fee-hook@4.0.0")).not.toThrow();
    expect(() => assertQuoteRegistryVersion("arcnow/quote-registry@1.0.0")).not.toThrow();
    expect(() => assertLaunchpadVersion("arcnow/launchpad@3.0.0")).not.toThrow();
  });

  it.each([
    ["platform", assertPlatformVersion, "arcnow/platform-config@3.0.0"],
    ["registry", assertRegistryVersion, "arcnow/platform-registry@3.0.0"],
    ["hook", assertHookVersion, "arcnow/arc-now-fee-hook@3.0.0"],
  ] as const)("refuses a %s of the retired @3.x.x stack by name", (_which, assert, version) => {
    const refused = refusal(() => assert(version));
    expect(refused.version).toBe(version);
    expect(refused.message).toMatch(/retired multi-quote/);
  });

  it.each([
    ["platform", "arcnow/platform-config@3.0.0", "platform-config", "UnknownCurveVersion"],
    ["platform", "arcnow/platform-config@2.0.0", "platform-config", "UnknownCurveVersion"],
    ["platform", "arcnow/platform-config@1.0.0", "platform-config", "UnknownCurveVersion"],
    ["platform", "arcnow/bonding-curve@4.0.0", "platform-config", "UnknownCurveVersion"],
    ["registry", "arcnow/platform-registry@3.0.0", "platform-registry", "UnknownCurveVersion"],
    ["registry", "arcnow/platform-registry@2.0.0", "platform-registry", "UnknownCurveVersion"],
    ["registry", "arcnow/platform-config@4.0.0", "platform-registry", "UnknownCurveVersion"],
    ["hook", "arcnow/arc-now-fee-hook@3.0.0", "arc-now-fee-hook", "UnknownHookVersion"],
    ["hook", "arcnow/arc-now-fee-hook@2.0.0", "arc-now-fee-hook", "UnknownHookVersion"],
    ["quote registry", "arcnow/quote-registry@2.0.0", "quote-registry", "UnknownCurveVersion"],
    ["launchpad", "arcnow/launchpad@2.0.0", "launchpad", "UnknownCurveVersion"],
  ] as const)("refuses a %s answering %j", (which, version, component, code) => {
    const assert = {
      "platform": assertPlatformVersion,
      "registry": assertRegistryVersion,
      "hook": assertHookVersion,
      "quote registry": assertQuoteRegistryVersion,
      "launchpad": assertLaunchpadVersion,
    }[which];
    const refused = refusal(() => assert(version));
    expect(refused.code).toBe(code);
    expect(refused.version).toBe(version);
    expect(refused.component).toBe(component);
  });
});
