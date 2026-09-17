/**
 * The reference curve templates: what they are, and where they come from.
 *
 * # A template is not a constant
 *
 * A curve template is per-platform state, replaceable by its admin at any time
 * and snapshotted onto every curve at launch. A platform moved from a 1e9 supply
 * to 1e6 on 2026-09-13 with every price bit-identical, and a user was shown a
 * figure wrong by 1000x. So the values are not written in TypeScript: they live
 * in `curve-templates.json`, the maintainers' template gate reads the live platform
 * and fails on a difference, and this file checks the parts that need no network
 * — including that the snapshots equal the templates in the contracts' own
 * pinned `vectors.json`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { Tokens, Usdc } from "../../src/amounts.js";
import { CurveMath } from "../../src/curve-math.js";
import { CurveTemplate } from "../../src/curve-template.js";
import { isArcNowError } from "../../src/errors/index.js";
import generated from "../../src/generated/curve-templates.json" with { type: "json" };

const template = CurveTemplate.arcnowDefaults();
const WAD = 10n ** 18n;

const raw = (generated as unknown as {
  templates: Record<string, Record<string, string | number | null>>;
}).templates;

const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/vectors.json"), "utf8"),
) as { templates: Record<string, string>[] };
const vectorTemplate = (id: string): Record<string, string> => {
  const found = vectors.templates.find((t) => t.id === id);
  if (!found) throw new Error(`vectors.json has no template ${id}`);
  return found;
};

describe("arcnow.io's template on Arc testnet", () => {
  it("is the preset's reference", () => {
    expect(CurveTemplate.referenceFor("arc-testnet")).toEqual(template);
  });

  it("is denominated in native USDC", () => {
    expect(template.quoteToken.isNative).toBe(true);
    expect(template.target.format()).toBe("50 USDC");
    expect(raw["arc-testnet"]?.quote).toBe("0x0000000000000000000000000000000000000000");
  });

  it("carries the six values the platform serves, and no kind", () => {
    expect(template.totalSupply.wad).toBe(1_000_000n * WAD);
    expect(template.curveSupply.wad).toBe(790_931_776_678_561_246_309_959n);
    expect(template.y0.wad).toBe(1_075_119_882_918_585_400_293_717n);
    expect(template.r0.wad).toBe(17_965_399_457_930_722_779n);
    expect(template.target.wad).toBe(50n * WAD);
    expect(template.initialPrice.wad).toBe(16_710_135_998_192n);
    expect(template).not.toHaveProperty("kind");
    expect(template).not.toHaveProperty("k");
  });

  it("opens at 0.000016710135998192 and graduates at 0.000239156382570519, 79.09% sold", () => {
    const fresh = {
      params: CurveTemplate.params(template),
      reserveWad: template.r0.wad,
      tokensSoldWad: 0n,
      targetQuoteWad: template.target.wad,
      curveSupplyWad: template.curveSupply.wad,
      tradeFeeBps: 100n,
    };
    expect(Usdc.fromWad(CurveMath.spotPriceWad(fresh)).toString()).toBe("0.000016710135998192");
    const done = { ...fresh, tokensSoldWad: template.curveSupply.wad };
    expect(Usdc.fromWad(CurveMath.spotPriceWad(done)).toString()).toBe("0.000239156382570519");
    expect(template.curveSupply.wad * 10_000n / template.totalSupply.wad).toBe(7_909n);
    expect(CurveTemplate.heldBack(template).wad * 10_000n / template.totalSupply.wad).toBe(2_090n);
  });

  it("equals the contracts' own pinned 'testnet' template, field for field", () => {
    const t = vectorTemplate("testnet");
    expect(template.totalSupply.wad).toBe(BigInt(t.totalSupplyWad as string));
    expect(template.curveSupply.wad).toBe(BigInt(t.curveSupplyWad as string));
    expect(template.y0.wad).toBe(BigInt(t.y0Wad as string));
    expect(template.r0.wad).toBe(BigInt(t.r0Wad as string));
    expect(template.target.wad).toBe(BigInt(t.targetUsdcWad as string));
    expect(template.initialPrice.wad).toBe(BigInt(t.initialPriceWad as string));
  });

  it("names the platform it was read off", () => {
    expect(raw["arc-testnet"]?.platform).toBe("0x912898e51f78e92f0a0d6efdefdee83fe7e8f4a4");
    expect(raw["arc-testnet"]?.platformVersion).toBe("arcnow/platform-config@4.0.0");
  });
});

describe("the reference template (1e9 / 50,000 USDC), which arcnow.io's mainnet platform serves", () => {
  const reference = CurveTemplate.reference();

  it("is the arc-mainnet snapshot, read off arcnow.io's mainnet platform", () => {
    expect(CurveTemplate.referenceFor("arc-mainnet")).toEqual(reference);
    expect(raw["arc-mainnet"]?.platform).toBe("0xe3c7cd3e98af47de518740c7cfef9fc7064b2ef9");
    expect(raw["arc-mainnet"]?.platformVersion).toBe("arcnow/platform-config@4.0.0");
    expect(raw["arc-mainnet"]?.vectorsTemplate).toBe("reference");
    expect(raw).not.toHaveProperty("cpmm-reference");
  });

  it("differs from the testnet template by exactly a thousand times in supply and target", () => {
    expect(reference.totalSupply.wad).toBe(template.totalSupply.wad * 1000n);
    expect(reference.target.wad).toBe(template.target.wad * 1000n);
  });

  it("equals the contracts' 'reference' template and prices like the testnet one", () => {
    const t = vectorTemplate("reference");
    expect(reference.totalSupply.wad).toBe(BigInt(t.totalSupplyWad as string));
    expect(reference.curveSupply.wad).toBe(BigInt(t.curveSupplyWad as string));
    expect(reference.y0.wad).toBe(BigInt(t.y0Wad as string));
    expect(reference.r0.wad).toBe(BigInt(t.r0Wad as string));
    expect(reference.target.wad).toBe(50_000n * WAD);
    // A thousand times the supply and the target; the same opening price.
    expect(reference.initialPrice.wad).toBe(template.initialPrice.wad);
  });
});

describe("encoding and decoding", () => {
  it("encodes with y0Wad and never kWad", () => {
    const keys = Object.keys(CurveTemplate.encode(template));
    expect(keys).toContain("y0Wad");
    expect(keys).not.toContain("kWad");
  });

  it("round-trips without moving a wei", () => {
    expect(CurveTemplate.decode(CurveTemplate.encode(template))).toEqual(template);
  });

  it("gives the curve parameters a launch would snapshot", () => {
    expect(CurveTemplate.params(template))
      .toEqual({ r0Wad: template.r0.wad, y0Wad: template.y0.wad });
  });

  it("returns a fresh object each time", () => {
    expect(CurveTemplate.arcnowDefaults()).not.toBe(CurveTemplate.arcnowDefaults());
  });

  it("has a snapshot for each live network, and none for a name nothing describes", () => {
    expect(CurveTemplate.referenceFor("arc-mainnet")).toEqual(CurveTemplate.reference());
    expect(CurveTemplate.referenceFor("arc-testnet")).toEqual(CurveTemplate.arcnowDefaults());
    expect(CurveTemplate.referenceFor("no-such-network")).toBeUndefined();
  });
});

describe("the cheap local checks", () => {
  it("accepts both shipped templates", () => {
    expect(() => CurveTemplate.checkSupplies(template)).not.toThrow();
    expect(() => CurveTemplate.checkSupplies(CurveTemplate.reference())).not.toThrow();
  });

  it("refuses a template that puts the whole supply on the curve", () => {
    try {
      CurveTemplate.checkSupplies({ ...template, curveSupply: template.totalSupply });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.message).toMatch(/strictly below/);
    }
  });

  it("refuses zero supplies", () => {
    expect(() => CurveTemplate.checkSupplies({ ...template, curveSupply: Tokens.ZERO }))
      .toThrow(/non-zero/);
    expect(() => CurveTemplate.checkSupplies({ ...template, totalSupply: Tokens.ZERO }))
      .toThrow(/non-zero/);
  });
});

describe("provenance: one source for two languages", () => {
  it("stores every wad as a string, because none of them fits a double", () => {
    for (const id of ["arc-testnet", "arc-mainnet"]) {
      const entry = raw[id];
      for (const key of [
        "totalSupplyWad", "curveSupplyWad", "y0Wad", "r0Wad", "targetQuoteWad", "initialPriceWad",
      ]) {
        expect(typeof entry?.[key], `${id}.${key}`).toBe("string");
      }
      expect(entry).not.toHaveProperty("kWad");
      expect(entry).not.toHaveProperty("kind");
    }
    const y0 = raw["arc-testnet"]?.y0Wad as string;
    expect(BigInt(Number(y0))).not.toBe(BigInt(y0));
  });
});
