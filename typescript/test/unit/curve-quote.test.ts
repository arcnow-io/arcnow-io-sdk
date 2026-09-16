/**
 * A curve priced in its own quote token: native USDC paid as value, or an
 * ERC-20 pulled with an allowance through `buyWithQuote`.
 *
 * The failures pinned here are all quiet ones: sending value to an ERC-20 curve
 * (reverts, money safe, but nothing works), approving more than the buy, an
 * amount the curve cannot represent, a USDC amount handed to a EURC curve, and
 * labelling a EURC payout as USDC.
 */

import type { Address } from "viem";
import { erc20Abi, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_QUOTE, QuoteAmount, Tokens, Usdc } from "../../src/amounts.js";
import { createArcNowClient } from "../../src/client.js";
import { Deadline } from "../../src/deadline.js";
import { isArcNowError } from "../../src/errors/index.js";
import { bondingCurveAbi } from "../../src/generated/abi/index.js";
import { resolveNetwork } from "../../src/networks.js";
import type { FakeContract } from "./support/fake-chain.js";
import { FakeChain, fakeErc20, Revert } from "./support/fake-chain.js";

const PRESET = resolveNetwork("arc-testnet");
const EURC = PRESET.quoteTokens.find((token) => token.symbol === "EURC")!;
const EURC_ADDRESS = EURC.address;
const CURVE: Address = "0x00000000000000000000000000000000000c0001";
const TOKEN: Address = "0x00000000000000000000000000000000000a0001";
const BUYER: Address = "0x00000000000000000000000000000000000000c0";
const WAD = 10n ** 18n;

interface CurveBehaviour {
  revertBuyWithQuote?: boolean;
  spendFraction?: bigint;
  /** Revert buyWithQuote with NO data, as contracts#23's fee-share gas guard does. */
  emptyRevertBuyWithQuote?: boolean;
}

function curve(
  quote: Address,
  decimals: number,
  version = "arcnow/bonding-curve@3.0.0",
  behaviour: CurveBehaviour = {},
): FakeContract {
  const trade = (isBuy: boolean, quoteWad: bigint, tokens: bigint, fee: bigint) => ({
    address: CURVE,
    abi: bondingCurveAbi,
    eventName: "Trade",
    args: {
      curve: CURVE, token: TOKEN, trader: BUYER, isBuy, quoteAmountWad: quoteWad,
      tokenAmountWad: tokens, feeQuoteWad: fee, newVirtualReserveWad: 20n * WAD,
      newTokensSold: tokens, newPriceWad: 17n * 10n ** 12n,
    },
  });
  return {
    label: "curve",
    abi: bondingCurveAbi,
    reads: {
      VERSION: () => version,
      quoteToken: () => quote,
      quoteDecimals: () => decimals,
      quoteScale: () => 10n ** BigInt(18 - decimals),
      token: () => TOKEN,
      creator: () => BUYER,
      migrator: () => "0x00000000000000000000000000000000000000d0",
      spotPriceWad: () => 16_710_135_998_192n,
      tokensSoldWad: () => 0n,
      tokensRemainingWad: () => 790_931n * WAD,
      realReserveWad: () => 0n,
      virtualReserveWad: () => 17n * WAD,
      targetQuoteWad: () => 50n * WAD,
      graduationProgressBps: () => 0n,
      graduated: () => false,
      migrated: () => false,
      r0Wad: () => 17n * WAD,
      y0Wad: () => 1_075_119n * WAD,
      curveSupplyWad: () => 790_931n * WAD,
      tradeFeeBps: () => 100n,
      quoteBuy: ([quoteIn]) => ({
        tokensOutWad: 1_000n * WAD, feeQuoteWad: (quoteIn as bigint) / 100n, quoteSpentWad: quoteIn,
        refundWad: 0n, newReserveWad: 20n * WAD, newTokensSoldWad: 1_000n * WAD,
        newPriceWad: 17n * 10n ** 12n, graduates: false,
      }),
    },
    writes: {
      buy: (_args, context) => ({
        result: [1_000n * WAD, context.value, 0n],
        logs: [trade(true, context.value, 1_000n * WAD, context.value / 100n)],
      }),
      buyWithQuote: ([quoteIn]) => {
        if (behaviour.revertBuyWithQuote === true) {
          throw new Revert(bondingCurveAbi, "WrongQuotePath");
        }
        if (behaviour.emptyRevertBuyWithQuote === true) {
          throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        }
        const spent = ((quoteIn as bigint) * (behaviour.spendFraction ?? 100n)) / 100n;
        return {
          result: [1_000n * WAD, spent, 0n],
          logs: [trade(true, spent, 1_000n * WAD, spent / 100n)],
        };
      },
      sell: ([tokensIn]) => ({
        result: 3n * WAD,
        logs: [trade(false, 3n * WAD, tokensIn as bigint, 3n * 10n ** 16n)],
      }),
    },
  };
}

function eurcCurve(allowance: bigint, behaviour: CurveBehaviour = {}) {
  const eurc = fakeErc20({
    label: "eurc", address: EURC_ADDRESS, abi: erc20Abi, symbol: "EURC", name: "EURC", decimals: 6,
    balances: { [BUYER]: 1_000_000_000n },
    allowances: { [`${BUYER}:${CURVE}`]: allowance },
  });
  const chain = new FakeChain({
    [CURVE]: curve(EURC_ADDRESS, 6, "arcnow/bonding-curve@3.0.0", behaviour),
    [EURC_ADDRESS]: eurc,
  });
  const client = createArcNowClient({
    network: PRESET, transport: chain.transport(), account: BUYER,
  });
  return { chain, eurc, client };
}

function nativeCurve() {
  const chain = new FakeChain({ [CURVE]: curve(NATIVE_QUOTE, 18) });
  const client = createArcNowClient({
    network: PRESET, transport: chain.transport(), account: BUYER,
  });
  return { chain, client };
}

const deadline = Deadline.at(4_000_000_000n);

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (!isArcNowError(error)) throw error;
    return { code: String(error.code), message: error.message };
  }
  throw new Error("expected a refusal");
}

describe("a curve's quote token", () => {
  it("is read off the curve, labelled from networks.json, and cached", async () => {
    const { chain, client } = eurcCurve(0n);
    const handle = client.curve(CURVE);
    expect(await handle.quoteToken()).toEqual(EURC);
    expect(await handle.quoteToken()).toEqual(EURC);
    expect(chain.calls.filter((c) => c === "curve.quoteToken")).toHaveLength(1);
  });

  it("denominates the whole state in it, read in the same batch", async () => {
    const { chain, client } = eurcCurve(0n);
    const state = await client.curve(CURVE).state();
    expect(state.quoteToken).toEqual(EURC);
    expect(state.target.format()).toBe("50 EURC");
    expect(state.virtualReserve.token).toEqual(EURC);
    expect(state.spotPrice.token.symbol).toBe("EURC");
    // VERSION, then one batch of the state including quoteToken/quoteDecimals.
    expect(chain.count("eth_call")).toBeLessThanOrEqual(2);
  });
});

describe("buying on a native USDC curve", () => {
  it("pays with value through the payable buy, and asks for no allowance", async () => {
    const { chain, client } = nativeCurve();
    const result = await client.curve(CURVE).buy({
      quoteIn: Usdc.parse("10"), minTokensOut: Tokens.ZERO, deadline,
    });
    expect(chain.sends()).toEqual(["curve.buy"]);
    expect(chain.sent[0]?.value).toBe(10n * WAD);
    expect(chain.calls.some((c) => c.includes("allowance"))).toBe(false);
    expect(result.quoteSpent.eq(Usdc.parse("10"))).toBe(true);
    expect(result.approvalTxHash).toBeUndefined();
  });
});

describe("buying on an ERC-20 (EURC) curve", () => {
  it("sends buyWithQuote with no value when the allowance already covers it", async () => {
    const { chain, client } = eurcCurve(10_000_000n);
    const result = await client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "10"), minTokensOut: Tokens.parse("900"), deadline,
    });
    expect(chain.sends()).toEqual(["curve.buyWithQuote"]);
    expect(chain.sent[0]?.value).toBe(0n);
    expect(chain.sent[0]?.args)
      .toEqual([10n * WAD, 900n * WAD, deadline.unixSeconds, zeroAddress, zeroAddress]);
    expect(result.quoteSpent.format()).toBe("10 EURC");
    expect(result.fee.format()).toBe("0.1 EURC");
    expect(result.approvalTxHash).toBeUndefined();
  });

  it("approves exactly the buy first when the allowance is short", async () => {
    const { chain, eurc, client } = eurcCurve(1n);
    const result = await client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "12.5"), minTokensOut: Tokens.ZERO, deadline,
    });
    expect(chain.sends()).toEqual(["eurc.approve", "curve.buyWithQuote"]);
    expect(chain.sent[0]?.args).toEqual([CURVE, 12_500_000n]);
    expect(eurc.allowances.get(`${BUYER}:${CURVE}`.toLowerCase())).toBe(12_500_000n);
    expect(result.approvalTxHash).toBe(chain.sent[0]?.hash);
  });

  it("refuses an amount with dust below one raw unit before any RPC", async () => {
    const { chain, client } = eurcCurve(0n);
    const refused = await refusal(() => client.curve(CURVE).buy({
      quoteIn: QuoteAmount.fromWad(EURC, 10n * WAD + 1n), minTokensOut: Tokens.ZERO, deadline,
    }));
    expect(refused.code).toBe("QuoteAmountNotRepresentable");
    expect(chain.rpc).toEqual([]);
  });

  it("refuses a native USDC amount handed to a EURC curve, and sends nothing", async () => {
    const { chain, client } = eurcCurve(10n ** 30n);
    const refused = await refusal(() => client.curve(CURVE).buy({
      quoteIn: Usdc.parse("10"), minTokensOut: Tokens.ZERO, deadline,
    }));
    expect(refused.code).toBe("QuoteTokenMismatch");
    expect(refused.message).toMatch(/EURC/);
    expect(chain.sent).toEqual([]);
  });

  it("refuses the mismatch on a quote too", async () => {
    const { client } = eurcCurve(0n);
    expect((await refusal(() => client.curve(CURVE).quoteBuy(Usdc.parse("1")))).code)
      .toBe("QuoteTokenMismatch");
    const quote = await client.curve(CURVE).quoteBuy(QuoteAmount.parse(EURC, "4"));
    expect(quote.quoteSpent.format()).toBe("4 EURC");
    expect(quote.fee.format()).toBe("0.04 EURC");
  });

  it("labels a sell's payout in EURC and takes a EURC floor", async () => {
    const { chain, client } = eurcCurve(0n);
    const result = await client.curve(CURVE).sell({
      tokensIn: Tokens.parse("500"), minQuoteOut: QuoteAmount.parse(EURC, "2"), deadline,
    });
    expect(chain.sends()).toEqual(["curve.sell"]);
    expect(chain.sent[0]?.args)
      .toEqual([500n * WAD, 2n * WAD, deadline.unixSeconds, zeroAddress, zeroAddress]);
    expect(result.quoteOut.format()).toBe("3 EURC");
    expect((await refusal(() => client.curve(CURVE).sell({
      tokensIn: Tokens.parse("1"), minQuoteOut: Usdc.parse("1"), deadline,
    }))).code).toBe("QuoteTokenMismatch");
  });
});

describe("review: simulate before approving, and the ERC-20 refund", () => {
  it("simulates the buy with the curve's allowance overridden BEFORE approving", async () => {
    const { chain, client } = eurcCurve(0n);
    await client.curve(CURVE).buy({ quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline });
    const first = chain.simulations[0];
    expect(first?.functionName).toBe("buyWithQuote");
    expect(Object.keys(first?.stateOverride ?? {})).toContain(EURC_ADDRESS);
    expect(chain.sends()).toEqual(["eurc.approve", "curve.buyWithQuote"]);
  });

  it("sends NO approve when the buy would revert anyway", async () => {
    const { chain, client } = eurcCurve(0n, { revertBuyWithQuote: true });
    const refused = await refusal(() => client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline,
    }));
    expect(refused.code).toBe("WrongQuotePath");
    expect(chain.sent).toEqual([]);
  });

  it("reports the unspent part of an ERC-20 buy as its refund, never pulled", async () => {
    const { client } = eurcCurve(10n ** 30n, { spendFraction: 90n });
    const result = await client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "10"), minTokensOut: Tokens.ZERO, deadline,
    });
    expect(result.quoteSpent.format()).toBe("9 EURC");
    expect(result.refund.format()).toBe("1 EURC");
  });
});

describe("a version-2 curve", () => {
  it("is refused before its quote is read or anything is sent", async () => {
    const chain = new FakeChain({ [CURVE]: curve(NATIVE_QUOTE, 18, "arcnow/bonding-curve@2.0.0") });
    const client = createArcNowClient({
      network: PRESET, transport: chain.transport(), account: BUYER,
    });
    const refused = await refusal(() => client.curve(CURVE).buy({
      quoteIn: Usdc.parse("1"), minTokensOut: Tokens.ZERO, deadline,
    }));
    expect(refused.code).toBe("UnknownCurveVersion");
    expect(chain.sent).toEqual([]);
    expect(chain.calls).not.toContain("curve.quoteToken");
  });
});

describe("contracts#23's gas guard on ERC-20 fee shares", () => {
  const covered = 10n ** 12n;

  it("sends an ERC-20 buy at the estimate plus a fifth, at least 150,000 more", async () => {
    const { chain, client } = eurcCurve(covered);
    await client.curve(CURVE).buy({ quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline });
    expect(chain.sends()).toEqual(["curve.buyWithQuote"]);
    expect(chain.sent[0]?.gas).toBe(250_000n);
  });

  it("raises a caller's gasLimit below the safe minimum on an ERC-20 buy", async () => {
    const { chain, client } = eurcCurve(covered);
    await client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline, gasLimit: 100_000n,
    });
    expect(chain.sent[0]?.gas).toBe(250_000n);
  });

  it("keeps a caller's gasLimit above the safe minimum on an ERC-20 buy", async () => {
    const { chain, client } = eurcCurve(covered);
    await client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline, gasLimit: 400_000n,
    });
    expect(chain.sent[0]?.gas).toBe(400_000n);
  });

  it("names an empty revert with a caller's gasLimit QuoteTransferOutOfGas, and sends nothing", async () => {
    const { chain, client } = eurcCurve(covered, { emptyRevertBuyWithQuote: true });
    const refused = await refusal(() => client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline, gasLimit: 300_000n,
    }));
    expect(refused.code).toBe("QuoteTransferOutOfGas");
    expect(refused.message).toMatch(/300000/);
    expect(chain.sent).toEqual([]);
  });

  it("names an empty revert while estimating the same way", async () => {
    const { chain, client } = eurcCurve(covered, { emptyRevertBuyWithQuote: true });
    const refused = await refusal(() => client.curve(CURVE).buy({
      quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline,
    }));
    expect(refused.code).toBe("QuoteTransferOutOfGas");
    expect(chain.sent).toEqual([]);
  });

  it("sends an ERC-20 sell with the same headroom", async () => {
    const { chain, client } = eurcCurve(covered);
    await client.curve(CURVE).sell({
      tokensIn: Tokens.fromWad(WAD), minQuoteOut: QuoteAmount.parse(EURC, "1"), deadline,
    });
    expect(chain.sends()).toEqual(["curve.sell"]);
    expect(chain.sent[0]?.gas).toBe(250_000n);
  });

  it("leaves a native buy's gas to the node, as before", async () => {
    const { chain, client } = nativeCurve();
    await client.curve(CURVE).buy({
      quoteIn: Usdc.fromWhole(1n), minTokensOut: Tokens.ZERO, deadline,
    });
    expect(chain.sent[0]?.gas).toBeUndefined();
  });
});
