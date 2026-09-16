/**
 * The constant-product curve, priced locally, against the vectors the contracts
 * generated.
 *
 * `vectors/vectors.json` (schema 2) prices `arcnow/bonding-curve@2.x.x`, copied
 * from arcnow-io/contracts and pinned in pins.json. Every number here is an
 * integer and every comparison is exact: a port that is one wei out is a port
 * that disagrees with the chain.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { CurveSnapshot } from "../../src/curve-math.js";
import { CurveMath } from "../../src/curve-math.js";

type Row = Record<string, string>;
interface VectorRow {
  id: string;
  templateId?: string;
  stateId: string;
  side: "buy" | "sell";
  reserveWad: string;
  tokensSoldWad: string;
  amountInWad: string;
  amountOutWad: string;
  feeUsdcWad: string;
  newReserveWad: string;
  newTokensSoldWad: string;
  newPriceWad: string;
  reserveDeltaWad: string;
  usdcSpentWad: string;
  refundWad: string;
  graduates: boolean;
}
interface StateRow {
  templateId?: string;
  id: string;
  reserveWad: string;
  tokensSoldWad: string;
  spotPriceWad: string;
  history: { side: "buy" | "sell"; amountWad: string }[];
}

function load(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../vectors", name), "utf8"),
  ) as Record<string, unknown>;
}

const cpmm = load("vectors.json") as {
  schemaVersion: number;
  curve: { kind: string };
  constants: Row;
  helpers: { feeUp: Row[]; grossForNetUp: Row[] };
  templates: (Row & { shapeProgressBps: string[]; shapePriceWad: string[] })[];
  mathRows: Row[];
  states: StateRow[];
  launchVectors: Row[];
  vectors: VectorRow[];
};

const B = (value: string | undefined): bigint => BigInt(value as string);
const FEE_BPS = 100n;

/* ------------------------------------------------------------------------ *
 * Snapshots
 * ------------------------------------------------------------------------ */

function cpmmTemplate(id: string): Row {
  const template = cpmm.templates.find((t) => t.id === id);
  if (!template) throw new Error(`no template ${id}`);
  return template;
}

function cpmmSnapshot(
  templateId: string,
  reserveWad: bigint,
  tokensSoldWad: bigint,
): CurveSnapshot {
  const t = cpmmTemplate(templateId);
  return {
    params: { r0Wad: B(t.r0Wad), y0Wad: B(t.y0Wad) },
    reserveWad,
    tokensSoldWad,
    targetQuoteWad: B(t.targetUsdcWad),
    curveSupplyWad: B(t.curveSupplyWad),
    tradeFeeBps: FEE_BPS,
  };
}

/** Every field a vector row pins. */
function priceRow(snapshot: CurveSnapshot, row: VectorRow): Record<string, unknown> {
  if (row.side === "buy") {
    const q = CurveMath.quoteBuy(snapshot, B(row.amountInWad));
    return {
      amountOutWad: q.tokensOutWad.toString(),
      feeUsdcWad: q.feeQuoteWad.toString(),
      newReserveWad: q.newReserveWad.toString(),
      newTokensSoldWad: q.newTokensSoldWad.toString(),
      newPriceWad: q.newPriceWad.toString(),
      reserveDeltaWad: (q.newReserveWad - snapshot.reserveWad).toString(),
      usdcSpentWad: q.quoteSpentWad.toString(),
      refundWad: q.refundWad.toString(),
      graduates: q.graduates,
    };
  }
  const q = CurveMath.quoteSell(snapshot, B(row.amountInWad));
  return {
    amountOutWad: q.quoteOutWad.toString(),
    feeUsdcWad: q.feeQuoteWad.toString(),
    newReserveWad: q.newReserveWad.toString(),
    newTokensSoldWad: q.newTokensSoldWad.toString(),
    newPriceWad: q.newPriceWad.toString(),
    reserveDeltaWad: q.grossQuoteWad.toString(),
    usdcSpentWad: "0",
    refundWad: "0",
    graduates: false,
  };
}

function expected(row: VectorRow): Record<string, unknown> {
  return {
    amountOutWad: row.amountOutWad,
    feeUsdcWad: row.feeUsdcWad,
    newReserveWad: row.newReserveWad,
    newTokensSoldWad: row.newTokensSoldWad,
    newPriceWad: row.newPriceWad,
    reserveDeltaWad: row.reserveDeltaWad,
    usdcSpentWad: row.usdcSpentWad,
    refundWad: row.refundWad,
    graduates: row.graduates,
  };
}

/** Replay a state's published history from a fresh curve. */
function replay(start: CurveSnapshot, history: StateRow["history"]): CurveSnapshot {
  let s = start;
  for (const step of history) {
    if (step.side === "buy") {
      const q = CurveMath.quoteBuy(s, B(step.amountWad));
      s = { ...s, reserveWad: q.newReserveWad, tokensSoldWad: q.newTokensSoldWad };
    } else {
      const q = CurveMath.quoteSell(s, B(step.amountWad));
      s = { ...s, reserveWad: q.newReserveWad, tokensSoldWad: q.newTokensSoldWad };
    }
  }
  return s;
}

/* ------------------------------------------------------------------------ *
 * The constant-product curve
 * ------------------------------------------------------------------------ */

describe("the constant-product curve (vectors.json, schema 2)", () => {
  it("is the file this suite thinks it is", () => {
    expect(cpmm.schemaVersion).toBe(2);
    expect(cpmm.curve.kind).toBe("constant-product");
    expect(cpmm.vectors).toHaveLength(504);
  });

  it("feeUp and grossForNetUp, row for row", () => {
    for (const row of cpmm.helpers.feeUp) {
      expect(CurveMath.feeUp(B(row.amountWad), FEE_BPS)).toBe(B(row.feeWad));
    }
    for (const row of cpmm.helpers.grossForNetUp) {
      expect(CurveMath.grossForNetUp(B(row.netWad), FEE_BPS)).toBe(B(row.grossWad));
    }
  });

  it("every CurveMath function, on k = 21 and on the reference curve", () => {
    const fns = CurveMath as unknown as Record<string, (...a: bigint[]) => bigint>;
    for (const row of cpmm.mathRows) {
      // The vectors call the reserve-level spot price `spotPriceWad`; CurveMath
      // keeps that name for the snapshot-level price and calls this one
      // spotPriceAtReserveWad.
      const name = row.fn === "spotPriceWad" ? "spotPriceAtReserveWad" : row.fn as string;
      const fn = fns[name];
      expect(fn, `CurveMath.${name} exists`).toBeTypeOf("function");
      const reserveFn = row.fn === "usdcReserveAt" || row.fn === "tokenReserveAt"
        || row.fn === "spotPriceWad";
      const got = reserveFn
        ? fn!(B(row.r0Wad), B(row.y0Wad), B(row.argWad))
        : fn!(B(row.r0Wad), B(row.y0Wad), B(row.argWad), B(row.amountWad));
      expect(got, JSON.stringify(row)).toBe(B(row.resultWad));
    }
  });

  it("each template's launch and graduation price, and its shape samples", () => {
    for (const t of cpmm.templates) {
      const fresh = cpmmSnapshot(t.id as string, B(t.r0Wad), 0n);
      expect(CurveMath.spotPriceWad(fresh)).toBe(B(t.initialPriceWad));
      const done = { ...fresh, tokensSoldWad: B(t.curveSupplyWad) };
      expect(CurveMath.spotPriceWad(done)).toBe(B(t.graduationPriceWad));
      // A fee-free buy of each fraction of the target into a fresh curve.
      t.shapeProgressBps.forEach((bps, i) => {
        const feeFree = { ...fresh, tradeFeeBps: 0n };
        const spend = (B(t.targetUsdcWad) * BigInt(bps)) / 10_000n;
        const q = CurveMath.quoteBuy(feeFree, spend);
        const price = spend === 0n ? CurveMath.spotPriceWad(fresh) : q.newPriceWad;
        expect(price, `${t.id} at ${bps} bps`).toBe(B(t.shapePriceWad[i]));
      });
    }
  });

  it("every state, replayed from a fresh curve through its published history", () => {
    expect(cpmm.states).toHaveLength(32);
    for (const state of cpmm.states) {
      const t = cpmmTemplate(state.templateId as string);
      const s = replay(cpmmSnapshot(t.id as string, B(t.r0Wad), 0n), state.history);
      expect(s.reserveWad, `${state.templateId}/${state.id}`).toBe(B(state.reserveWad));
      expect(s.tokensSoldWad).toBe(B(state.tokensSoldWad));
      expect(CurveMath.spotPriceWad(s)).toBe(B(state.spotPriceWad));
    }
  });

  it("all 504 priced trades, to the wei, and the identities", () => {
    for (const row of cpmm.vectors) {
      const snapshot = cpmmSnapshot(
        row.templateId as string, B(row.reserveWad), B(row.tokensSoldWad),
      );
      expect(priceRow(snapshot, row), row.id).toEqual(expected(row));
      if (row.side === "buy") {
        expect(B(row.reserveDeltaWad))
          .toBe(B(row.amountInWad) - B(row.refundWad) - B(row.feeUsdcWad));
      } else {
        const p = snapshot.params;
        const before = p.y0Wad - B(row.tokensSoldWad);
        const after = p.y0Wad - B(row.newTokensSoldWad);
        expect(B(row.reserveDeltaWad)).toBe(
          CurveMath.usdcReserveAt(p.r0Wad, p.y0Wad, before)
          - CurveMath.usdcReserveAt(p.r0Wad, p.y0Wad, after),
        );
      }
    }
  });

  it("launch quotes on the reference template", () => {
    const t = cpmmTemplate("reference");
    for (const row of cpmm.launchVectors) {
      const q = CurveMath.quoteLaunch(
        cpmmSnapshot("reference", B(t.r0Wad), 0n),
        B(row.initialBuyWad),
        B(cpmm.constants.launchFeeWad),
      );
      expect(q.totalCostWad, row.initialBuyWad).toBe(B(row.totalCostWad));
      expect(q.tokensOutWad).toBe(B(row.tokensOutWad));
      expect(q.tradeFeeWad).toBe(B(row.tradeFeeWad));
    }
  });

  it("progress is real USDC over the target in bps, capped at 10,000", () => {
    const t = cpmmTemplate("testnet");
    const fresh = cpmmSnapshot("testnet", B(t.r0Wad), 0n);
    expect(CurveMath.progressBps(fresh)).toBe(0n);
    const half = { ...fresh, reserveWad: B(t.r0Wad) + B(t.targetUsdcWad) / 2n };
    expect(CurveMath.progressBps(half)).toBe(5_000n);
    const over = { ...fresh, reserveWad: B(t.r0Wad) + B(t.targetUsdcWad) * 2n };
    expect(CurveMath.progressBps(over)).toBe(10_000n);
  });
});
