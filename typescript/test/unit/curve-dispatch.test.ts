/**
 * The curve handle and the front door accept one curve version,
 * `arcnow/bonding-curve@2.x.x`, and refuse every other by name.
 *
 * A scripted transport stands in for three curves: a constant-product one, a
 * retired `@1.0.0` one and one from a version this SDK has never heard of. It
 * records every function the SDK calls, so the refusals are proved to happen
 * **before** anything is quoted, simulated or sent — not merely to happen.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Abi, Address, Hex } from "viem";
import { custom, decodeFunctionData, encodeFunctionResult } from "viem";
import { describe, expect, it } from "vitest";

import { Tokens, Usdc } from "../../src/amounts.js";
import { createArcNowClient } from "../../src/client.js";
import { Deadline } from "../../src/deadline.js";
import { isArcNowError } from "../../src/errors/index.js";
import { CurveTemplate } from "../../src/curve-template.js";
import { arcTokenAbi, bondingCurveAbi, platformConfigAbi } from "../../src/generated/abi/index.js";

type Row = Record<string, string>;
const cpmmVectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../vectors/vectors.json"), "utf8"),
) as { templates: Row[]; states: Row[]; vectors: Row[] };

const RETIRED: Address = "0x00000000000000000000000000000000000000a1";
const CPMM: Address = "0x00000000000000000000000000000000000000a2";
const FUTURE: Address = "0x00000000000000000000000000000000000000a3";
const TOKEN: Address = "0x00000000000000000000000000000000000000b3";
/** A token whose curve is the retired @1.0.0 one. */
const RETIRED_TOKEN: Address = "0x00000000000000000000000000000000000000b4";
const SIGNER: Address = "0x00000000000000000000000000000000000000c0";
/** An address with no code: every eth_call returns no data. */
const NO_CODE: Address = "0x00000000000000000000000000000000000000e1";
/** A contract whose VERSION() reverts with no data. */
const REVERTS: Address = "0x00000000000000000000000000000000000000e2";
/** An address the transport cannot reach: the call never gets an answer. */
const UNREACHABLE: Address = "0x00000000000000000000000000000000000000e3";
/** A PlatformConfig of the retired linear curve's version. */
const RETIRED_PLATFORM: Address = "0x00000000000000000000000000000000000000f1";

interface Fake {
  answers: Record<string, unknown>;
  /** How every call to this address fails, instead of answering. */
  fails?: "no-data" | "revert" | "transport";
}

function curveAnswers(options: {
  version: string;
  reserveWad: bigint;
  tokensSoldWad: bigint;
  r0Wad: bigint;
  y0Wad: bigint;
  targetUsdcWad: bigint;
  curveSupplyWad: bigint;
  spotPriceWad: bigint;
  graduated?: boolean;
}): Fake {
  return {
    answers: {
      VERSION: options.version,
      token: TOKEN,
      creator: SIGNER,
      migrator: "0x00000000000000000000000000000000000000d0",
      spotPriceWad: options.spotPriceWad,
      tokensSoldWad: options.tokensSoldWad,
      tokensRemainingWad: options.curveSupplyWad - options.tokensSoldWad,
      realReserveWad: options.reserveWad - options.r0Wad,
      virtualReserveWad: options.reserveWad,
      targetQuoteWad: options.targetUsdcWad,
      quoteToken: "0x0000000000000000000000000000000000000000",
      quoteDecimals: 18,
      graduationProgressBps: 0n,
      graduated: options.graduated ?? false,
      migrated: false,
      r0Wad: options.r0Wad,
      y0Wad: options.y0Wad,
      curveSupplyWad: options.curveSupplyWad,
      tradeFeeBps: 100n,
    },
  };
}

const testnet = cpmmVectors.templates.find((t) => t.id === "testnet") as Row;
const cpmmState = cpmmVectors.states.find((s) => s.templateId === "testnet" && s.id === "mid") as Row;
const cpmmRow = cpmmVectors.vectors.find(
  (v) => v.templateId === "testnet" && v.stateId === "mid" && v.side === "sell"
    && v.amountInWad !== "0",
) as Row;
const cpmmBuyRow = cpmmVectors.vectors.find(
  (v) => v.templateId === "testnet" && v.stateId === "mid" && v.side === "buy"
    && v.amountInWad !== "0",
) as Row;

const B = (value: string | undefined): bigint => BigInt(value as string);

function fakes(graduated = false): Record<string, Fake> {
  const cpmm = {
    reserveWad: B(cpmmState.reserveWad),
    tokensSoldWad: B(cpmmState.tokensSoldWad),
    r0Wad: B(testnet.r0Wad),
    y0Wad: B(testnet.y0Wad),
    targetUsdcWad: B(testnet.targetUsdcWad),
    curveSupplyWad: B(testnet.curveSupplyWad),
    spotPriceWad: B(cpmmState.spotPriceWad),
  };
  return {
    [CPMM]: curveAnswers({ version: "arcnow/bonding-curve@3.0.0", ...cpmm, graduated }),
    // The same getters and numbers as a live curve, under the version-2 curve's
    // version, which predates quote tokens: the only thing that may refuse it is
    // the version.
    [RETIRED]: curveAnswers({ version: "arcnow/bonding-curve@2.0.0", ...cpmm }),
    [FUTURE]: curveAnswers({ version: "arcnow/bonding-curve@4.0.0", ...cpmm }),
    [TOKEN]: {
      answers: {
        VERSION: "arcnow/arc-token@1.0.0",
        curve: FUTURE,
        migratedPool: "0x0000000000000000000000000000000000000000",
      },
    },
    [RETIRED_TOKEN]: {
      answers: {
        VERSION: "arcnow/arc-token@1.0.0",
        curve: RETIRED,
        migratedPool: "0x0000000000000000000000000000000000000000",
      },
    },
    [RETIRED_PLATFORM]: {
      answers: {
        VERSION: "arcnow/platform-config@2.0.0",
        admin: SIGNER,
        feeRecipient: SIGNER,
        creatorShareBps: 3000n,
        refShareBps: 1000n,
        devShareBps: 1000n,
        platformShareBps: 2500n,
        defaultMigrator: "0x00000000000000000000000000000000000000d0",
        curveParameters: {
          totalSupplyWad: 1n, curveSupplyWad: 1n, y0Wad: 1n, r0Wad: 1n,
          targetQuoteWad: 1n, initialPriceWad: 1n,
        },
        checkCurveParameters: undefined,
      },
    },
    [NO_CODE]: { answers: {}, fails: "no-data" },
    [REVERTS]: { answers: {}, fails: "revert" },
    [UNREACHABLE]: { answers: {}, fails: "transport" },
  };
}

/** A transport that answers only the reads a curve has, and records every call. */
function scripted(curves: Record<string, Fake>, seen: string[]) {
  const abis = [bondingCurveAbi, arcTokenAbi, platformConfigAbi] as unknown as Abi[];
  return custom({
    request: ({ method, params }): Promise<unknown> => {
      if (method === "eth_chainId") return Promise.resolve("0x4cef52");
      if (method !== "eth_call") {
        seen.push(method);
        throw new Error(`unscripted RPC method ${method}`);
      }
      const call = (params as [{ to: Address; data: Hex }])[0];
      const fake = curves[call.to.toLowerCase()];
      if (!fake) throw new Error(`unscripted call to ${call.to}`);
      if (fake.fails === "no-data") {
        seen.push("eth_call(no code)");
        return Promise.resolve("0x");
      }
      if (fake.fails === "revert") {
        seen.push("eth_call(revert)");
        return Promise.reject(Object.assign(new Error("execution reverted"), { code: 3, data: "0x" }));
      }
      if (fake.fails === "transport") {
        seen.push("eth_call(unreachable)");
        return Promise.reject(new Error("fetch failed: connect ECONNREFUSED"));
      }
      for (const abi of abis) {
        let functionName: string;
        try {
          ({ functionName } = decodeFunctionData({ abi, data: call.data }));
        } catch {
          continue;
        }
        seen.push(functionName);
        if (!(functionName in fake.answers)) {
          throw new Error(`${call.to} has no ${functionName}()`);
        }
        return Promise.resolve(
          encodeFunctionResult({ abi, functionName, result: fake.answers[functionName] }),
        );
      }
      throw new Error(`undecodable call to ${call.to}`);
    },
  });
}

function client(seen: string[], graduated = false) {
  return createArcNowClient({
    network: "arc-testnet",
    transport: scripted(fakes(graduated), seen),
    multicallAddress: null,
    account: SIGNER,
  });
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (!isArcNowError(error)) throw error;
    return { code: String(error.code), message: error.message };
  }
  throw new Error("expected a refusal");
}

describe("a constant-product curve", () => {
  it("reads {r0Wad, y0Wad} and prices locally exactly as its vectors do", async () => {
    const seen: string[] = [];
    const curve = client(seen).curve(CPMM);
    expect(await curve.params()).toEqual({ r0Wad: B(testnet.r0Wad), y0Wad: B(testnet.y0Wad) });
    expect(seen).toContain("y0Wad");

    const state = await curve.state();
    expect(state).not.toHaveProperty("kind");
    expect(state).not.toHaveProperty("stack");
    expect(state.version).toBe("arcnow/bonding-curve@3.0.0");
    expect(state.quoteToken.isNative).toBe(true);
    expect(state.curveSupply.wad).toBe(B(testnet.curveSupplyWad));
    expect(state.tradeFeeBps.bps).toBe(100n);
    const sell = await curve.quoteSellLocal(Tokens.fromWad(B(cpmmRow.amountInWad)), state);
    expect(sell.quoteOut.wad).toBe(B(cpmmRow.amountOutWad));
    expect(sell.fee.wad).toBe(B(cpmmRow.feeUsdcWad));
    expect(sell.newPrice.wad).toBe(B(cpmmRow.newPriceWad));
    const buy = await curve.quoteBuyLocal(Usdc.fromWad(B(cpmmBuyRow.amountInWad)));
    expect(buy.tokensOut.wad).toBe(B(cpmmBuyRow.amountOutWad));
    expect(buy.graduates).toBe(cpmmBuyRow.graduates);
  });

  it("refuses a local quote on a graduated curve, as the chain does", async () => {
    const refused = await refusal(() => client([], true).curve(CPMM).quoteBuyLocal(Usdc.parse("1")));
    expect(refused.code).toBe("CurveGraduated");
  });
});

describe("a curve of any other version, including the version-2 curve that predates quote tokens", () => {
  it.each([
    [RETIRED, RETIRED_TOKEN, "arcnow/bonding-curve@2.0.0"],
    [FUTURE, TOKEN, "arcnow/bonding-curve@4.0.0"],
  ] as const)("%s is refused by name, everywhere, before any maths or trade", async (address, token, version) => {
    const seen: string[] = [];
    const sdk = client(seen);
    const curve = sdk.curve(address);
    const attempts: [string, () => Promise<unknown>][] = [
      ["version check via params", () => curve.params()],
      ["state", () => curve.state()],
      ["quoteBuy", () => curve.quoteBuy(Usdc.parse("1"))],
      ["quoteSell", () => curve.quoteSell(Tokens.parse("1"))],
      ["quoteBuyLocal", () => curve.quoteBuyLocal(Usdc.parse("1"))],
      ["quoteSellLocal", () => curve.quoteSellLocal(Tokens.parse("1"))],
      ["buy", () => curve.buy({
        quoteIn: Usdc.parse("1"), minTokensOut: Tokens.ZERO, deadline: Deadline.inMinutes(5),
      })],
      ["sell", () => curve.sell({
        tokensIn: Tokens.parse("1"), minQuoteOut: Usdc.ZERO, deadline: Deadline.inMinutes(5),
      })],
      ["migrate", () => curve.migrate()],
      ["trade.quoteBuy", () => sdk.trade(token).quoteBuy(Usdc.parse("1"))],
      ["trade.buy", () => sdk.trade(token).buy({
        quoteIn: Usdc.parse("1"), minTokensOut: Tokens.ZERO, deadline: Deadline.inMinutes(5),
      })],
    ];
    for (const [name, attempt] of attempts) {
      const refused = await refusal(attempt);
      expect(refused.code, name).toBe("UnknownCurveVersion");
      expect(refused.message, name).toContain(version);
      expect(refused.message.toLowerCase(), name).toContain(address);
    }
    // The only things ever asked of that curve: its version, and the token's
    // curve / migratedPool reads the front door needs to find it. No quote, no
    // simulation, no transaction, no state read.
    const asked = new Set(seen);
    for (const forbidden of [
      "quoteBuy", "quoteSell", "buy", "sell", "migrate", "virtualReserveWad", "y0Wad", "r0Wad",
      "eth_estimateGas", "eth_sendTransaction",
    ]) {
      expect(asked.has(forbidden), forbidden).toBe(false);
    }
  });
});

describe("a platform of the version-2 stack", () => {
  it("is refused by name before its template is read or checked", async () => {
    const seen: string[] = [];
    const sdk = client(seen);
    for (const [name, attempt] of [
      ["settings", () => sdk.platforms.settings(RETIRED_PLATFORM)],
      ["checkCurveTemplate", () =>
        sdk.platforms.checkCurveTemplate(CurveTemplate.arcnowDefaults(), RETIRED_PLATFORM)],
    ] as [string, () => Promise<unknown>][]) {
      const error = await caught(attempt);
      expect(error.code, name).toBe("UnknownCurveVersion");
      expect(error.details.version, name).toBe("arcnow/platform-config@2.0.0");
      expect(error.details.component, name).toBe("platform-config");
    }
    expect(seen).not.toContain("curveParameters");
    expect(seen).not.toContain("curveParametersFor");
    expect(seen).not.toContain("checkCurveParameters");
  });
});

describe("an address that is not a bonding curve at all", () => {
  it("a token is AddressIsNotACurve, named as the token it says it is — not an unknown curve version", async () => {
    const seen: string[] = [];
    const curve = client(seen).curve(TOKEN);
    for (const [name, attempt] of [
      ["state", () => curve.state()],
      ["params", () => curve.params()],
      ["quoteBuy", () => curve.quoteBuy(Usdc.parse("1"))],
    ] as [string, () => Promise<unknown>][]) {
      const refused = await refusal(attempt);
      expect(refused.code, name).toBe("AddressIsNotACurve");
      expect(refused.message, name).toContain("arcnow/arc-token@1.0.0");
      expect(refused.message, name).toMatch(/a token, not a curve/);
    }
    expect(seen).not.toContain("quoteBuy");
  });

  it("an address with no code, or whose VERSION() reverts, is AddressIsNotACurve with its address", async () => {
    for (const address of [NO_CODE, REVERTS]) {
      const error = await caught(() => client([]).curve(address).state());
      expect(error.code, address).toBe("AddressIsNotACurve");
      expect(String(error.details.address).toLowerCase(), address).toBe(address);
      expect(error.message.toLowerCase(), address).toContain(address);
    }
  });

  it("a transport failure is still a transport failure, never AddressIsNotACurve", async () => {
    const error = await caught(() => client([]).curve(UNREACHABLE).state());
    expect(error.code).toBe("RpcFailure");
  });
});

async function caught(run: () => Promise<unknown>): Promise<{
  code: string; message: string; details: Readonly<Record<string, unknown>>;
}> {
  try {
    await run();
  } catch (error) {
    if (!isArcNowError(error)) throw error;
    return { code: String(error.code), message: error.message, details: error.details };
  }
  throw new Error("expected a refusal");
}
