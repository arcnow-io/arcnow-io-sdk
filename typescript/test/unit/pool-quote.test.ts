/**
 * A graduated token's v4 pool, priced in its quote token, in **both** currency
 * orders.
 *
 * A v4 pool key sorts its currencies by address: `currency0 = min(quote, token)`.
 * Native USDC is `address(0)` and always sorts first, which is the only case
 * the SDK used to know. An ERC-20 quote such as EURC sits at an effectively
 * random position against an ArcToken's address, so roughly half of all pools
 * put the token first. Get the order wrong and a buy is encoded as a sell, a
 * quote reads the token leg as the money, and a fill is labelled in the wrong
 * currency — every one of them a plausible number.
 *
 * And v4 amounts are **raw units** of each currency: 1 EURC is 1,000,000 in a
 * `BalanceDelta`, a `Swap` log and the hook's fee, and 1e18 in every SDK amount.
 */

import type { Address, Hex, Log } from "viem";
import { erc20Abi, pad } from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_QUOTE, QuoteAmount, Tokens, Usdc } from "../../src/amounts.js";
import { createArcNowClient } from "../../src/client.js";
import { Deadline } from "../../src/deadline.js";
import { isArcNowError } from "../../src/errors/index.js";
import { arcNowFeeHookAbi, arcTokenAbi, uniswapV4MigratorAbi } from "../../src/generated/abi/index.js";
import { uniswapV4Router04Abi } from "../../src/generated/abi/external/uniswapV4Router04.js";
import type { NetworkConfig } from "../../src/networks.js";
import { resolveNetwork } from "../../src/networks.js";
import type { PoolFillSource } from "../../src/pool.js";
import {
  buyFeeFromQuoteIn,
  poolManagerSwapEventAbi,
  quoteFillFromLogs,
  sellFeeFromQuoteOut,
  unpackBalanceDelta,
} from "../../src/pool.js";
import type { EmittedLog, FakeContract } from "./support/fake-chain.js";
import { encodeLog, FakeChain, fakeErc20 } from "./support/fake-chain.js";

const PRESET = resolveNetwork("arc-testnet");
const EURC = PRESET.quoteTokens.find((token) => token.symbol === "EURC")!;
const ROUTER: Address = "0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e";
const MANAGER: Address = "0x06110b57dd9b82dd846ee0325fb81b284e1c6dd0";
const MIGRATOR: Address = "0x00000000000000000000000000000000000000cc";
const HOOK: Address = "0x00000000000000000000000000000000000020cc";
const TRADER: Address = "0x00000000000000000000000000000000000000c0";
const POOL_ID: Hex = pad("0x01");
const WAD = 10n ** 18n;

/** Below EURC's address: the token sorts first, the quote is currency1. */
const TOKEN_FIRST: Address = "0x00000000000000000000000000000000000aa001";
/** Above EURC's address: the quote sorts first, the token is currency1. */
const QUOTE_FIRST: Address = "0xf0000000000000000000000000000000000aa002";

const NETWORK: NetworkConfig = { ...PRESET, contracts: { ...PRESET.contracts, v4Router: ROUTER } };

const TOKENS_OUT = 4_321n * WAD;
const QUOTE_OUT_RAW_EURC = 2_970_000n; // 2.97 EURC
const QUOTE_OUT_WAD_NATIVE = 297n * 10n ** 16n; // 2.97 USDC

function packDelta(amount0: bigint, amount1: bigint): bigint {
  return BigInt.asIntN(256, (BigInt.asUintN(128, amount0) << 128n) | BigInt.asUintN(128, amount1));
}

interface KeyArg {
  currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address;
}

/** A pool whose quote is `quote` and whose token is `token`, sorted the way v4 sorts. */
function pool(
  token: Address,
  quote: Address,
  options: { tokenAllowance?: bigint; hookVersion?: string; migratorVersion?: string } = {},
) {
  const [currency0, currency1] = BigInt(quote) < BigInt(token) ? [quote, token] : [token, quote];
  const decimals = quote === NATIVE_QUOTE ? 18 : 6;

  const quoteOut = decimals === 18 ? QUOTE_OUT_WAD_NATIVE : QUOTE_OUT_RAW_EURC;
  const swapLogs = (
    key: KeyArg, zeroForOne: boolean, amountIn: bigint, receiver: Address,
  ): EmittedLog[] => {
    const inputIsQuote = (zeroForOne ? key.currency0 : key.currency1) === quote;
    const out = inputIsQuote ? TOKENS_OUT : quoteOut;
    // The hook's 0.80% on the quote leg, in raw units, outside the pool's own leg.
    const fee = inputIsQuote ? (amountIn * 80n) / 10_000n : (out * 80n) / 9_920n;
    const poolIn = inputIsQuote ? -(amountIn - fee) : -amountIn;
    const poolOut = inputIsQuote ? out : out + fee;
    const [amount0, amount1] = zeroForOne ? [poolIn, poolOut] : [poolOut, poolIn];
    return [
      { address: HOOK, abi: arcNowFeeHookAbi, eventName: "HookFeeTaken",
        args: {
          poolId: POOL_ID, token, payer: ROUTER, currency: quote, feeAmount: fee,
          onInput: inputIsQuote,
        } },
      { address: MANAGER, abi: poolManagerSwapEventAbi, eventName: "Swap",
        args: {
          id: POOL_ID, sender: ROUTER, amount0, amount1,
          sqrtPriceX96: 1n << 96n, liquidity: 1n, tick: 0, fee: 2000,
        } },
      inputIsQuote
        ? {
            address: token, abi: arcTokenAbi, eventName: "Transfer",
            args: { from: MANAGER, to: receiver, value: TOKENS_OUT },
          }
        : {
            address: token, abi: arcTokenAbi, eventName: "Transfer",
            args: { from: TRADER, to: MANAGER, value: amountIn },
          },
    ];
  };

  const contracts: Record<string, FakeContract> = {
    [token]: {
      label: "token",
      abi: arcTokenAbi,
      reads: {
        migrator: () => MIGRATOR,
        migratedPool: () => MANAGER,
        allowance: () => options.tokenAllowance ?? 10n ** 30n,
      },
    },
    [MIGRATOR]: {
      label: "migrator",
      abi: uniswapV4MigratorAbi,
      reads: {
        poolKey: () => ({ currency0, currency1, fee: 2000, tickSpacing: 60, hooks: HOOK }),
        poolIdOf: () => POOL_ID,
        poolManager: () => MANAGER,
        VERSION: () => options.migratorVersion ?? "arcnow/uniswap-v4-migrator@2.0.0",
      },
    },
    [ROUTER]: {
      label: "router",
      abi: uniswapV4Router04Abi,
      reads: { poolManager: () => MANAGER },
      writes: {
        swapExactTokensForTokens: (args) => {
          const [amountIn, , zeroForOne, key, , receiver]
            = args as [bigint, bigint, boolean, KeyArg, Hex, Address];
          const inputIsQuote = (zeroForOne ? key.currency0 : key.currency1) === quote;
          const out = inputIsQuote ? TOKENS_OUT : quoteOut;
          const [amount0, amount1] = zeroForOne ? [-amountIn, out] : [out, -amountIn];
          return {
            result: packDelta(amount0, amount1),
            logs: swapLogs(key, zeroForOne, amountIn, receiver),
          };
        },
      },
    },
    [HOOK]: {
      label: "hook",
      abi: arcNowFeeHookAbi,
      reads: {
        VERSION: () => options.hookVersion ?? "arcnow/arc-now-fee-hook@4.0.0",
        accruedFee: () => 12_345n,
      },
    },
  };
  let eurc: ReturnType<typeof fakeErc20> | undefined;
  if (quote !== NATIVE_QUOTE) {
    eurc = fakeErc20({
      label: "eurc", address: quote, abi: erc20Abi, symbol: "EURC", name: "EURC", decimals: 6,
      balances: { [TRADER]: 10n ** 12n },
    });
    contracts[quote] = eurc;
  }
  const chain = new FakeChain(contracts);
  const client = createArcNowClient({
    network: NETWORK, transport: chain.transport(), account: TRADER,
  });
  return { chain, client, eurc, currency0, currency1 };
}

const deadline = Deadline.at(4_000_000_000n);

interface Refused { code: string; message: string; details: Record<string, unknown> }

async function refusal(run: () => Promise<unknown>): Promise<Refused> {
  try {
    await run();
  } catch (error) {
    if (!isArcNowError(error)) throw error;
    return { code: String(error.code), message: error.message, details: { ...error.details } };
  }
  throw new Error("expected a refusal");
}

type SwapArgs = [bigint, bigint, boolean, KeyArg, Hex, Address, bigint];

function swapArgs(chain: FakeChain, index = -1): SwapArgs {
  const swaps = chain.sent.filter((tx) => tx.functionName === "swapExactTokensForTokens");
  const tx = swaps.at(index);
  if (!tx) throw new Error("no swap was sent");
  return tx.args as SwapArgs;
}

describe.each([
  ["the token sorts first, so the quote is currency1", TOKEN_FIRST, false],
  ["the quote sorts first, so it is currency0", QUOTE_FIRST, true],
] as const)("a EURC pool where %s", (_, token, quoteIsCurrency0) => {
  it("knows its quote and its order from the key alone", async () => {
    const { chain, client, currency0 } = pool(token, EURC.address);
    const handle = client.pool(token);
    expect(await handle.quoteToken()).toEqual(EURC);
    expect(await handle.quoteIsCurrency0()).toBe(quoteIsCurrency0);
    expect(currency0 === EURC.address).toBe(quoteIsCurrency0);
    expect(chain.calls.filter((c) => c.startsWith("eurc."))).toEqual([]);
  });

  it("quotes a buy in raw EURC, in the quote's direction, with no value", async () => {
    const { client } = pool(token, EURC.address);
    const quote = await client.pool(token).quoteBuy(QuoteAmount.parse(EURC, "1"));
    expect(quote.quoteIn.format()).toBe("1 EURC");
    expect(quote.tokensOut.eq(Tokens.fromWad(TOKENS_OUT))).toBe(true);
    expect(quote.feeQuote.format()).toBe("0.008 EURC");
  });

  it("quotes a sell, reading the quote leg out of the right half of the delta", async () => {
    const { client } = pool(token, EURC.address);
    const quote = await client.pool(token).quoteSell(Tokens.parse("100"), { from: TRADER });
    expect(quote.quoteOut.format()).toBe("2.97 EURC");
    expect(quote.tokensIn.toString()).toBe("100");
  });

  it("buys: approves the router for exactly the raw spend, then swaps with no value", async () => {
    const { chain, client, eurc } = pool(token, EURC.address);
    const result = await client.pool(token).buy({
      quoteIn: QuoteAmount.parse(EURC, "1"), minTokensOut: Tokens.parse("4000"), deadline,
    });
    expect(chain.sends()).toEqual(["eurc.approve", "router.swapExactTokensForTokens"]);
    expect(chain.sent[0]?.args).toEqual([ROUTER, 1_000_000n]);
    expect(eurc?.allowances.get(`${TRADER}:${ROUTER}`)).toBe(1_000_000n);
    const [amountIn, minOut, zeroForOne, key] = swapArgs(chain);
    expect(amountIn).toBe(1_000_000n);
    expect(minOut).toBe(4_000n * WAD);
    expect(zeroForOne).toBe(quoteIsCurrency0);
    expect(key.currency0 === EURC.address).toBe(quoteIsCurrency0);
    expect(chain.sent[1]?.value).toBe(0n);
    expect(result.quote.format()).toBe("1 EURC");
    expect(result.feeQuote.format()).toBe("0.008 EURC");
    expect(result.tokens.eq(Tokens.fromWad(TOKENS_OUT))).toBe(true);
    expect(result.approvalTxHash).toBe(chain.sent[0]?.hash);
  });

  it("sells: the token into the router, the EURC floor in raw units, the payout read exactly", async () => {
    const { chain, client } = pool(token, EURC.address);
    const result = await client.pool(token).sell({
      tokensIn: Tokens.parse("100"), minQuoteOut: QuoteAmount.parse(EURC, "2.5"), deadline,
    });
    expect(chain.sends()).toEqual(["router.swapExactTokensForTokens"]);
    const [amountIn, minOut, zeroForOne] = swapArgs(chain);
    expect(amountIn).toBe(100n * WAD);
    expect(minOut).toBe(2_500_000n);
    expect(zeroForOne).toBe(!quoteIsCurrency0);
    expect(result.quote.format()).toBe("2.97 EURC");
    expect(result.feeQuote.token).toEqual(EURC);
  });

  it("sends the ERC-20 buy and sell swaps at the estimate plus pool headroom (contracts#23, L-1)", async () => {
    const { chain, client } = pool(token, EURC.address);
    await client.pool(token).buy({ quoteIn: QuoteAmount.parse(EURC, "3"), minTokensOut: Tokens.ZERO, deadline });
    await client.pool(token).sell({
      tokensIn: Tokens.fromWad(WAD), minQuoteOut: QuoteAmount.parse(EURC, "1"), deadline,
    });
    const swaps = chain.sent.filter((tx) => tx.functionName === "swapExactTokensForTokens");
    // Review L-1: at least 400,000 over the estimate on an ERC-20-quoted pool.
    expect(swaps.map((tx) => tx.gas)).toEqual([500_000n, 500_000n]);
  });

  it("reads the hook's accrued fee as raw EURC", async () => {
    const { client } = pool(token, EURC.address);
    const fee = await client.pool(token).accruedHookFee();
    expect(fee.token).toEqual(EURC);
    expect(fee.toRaw()).toBe(12_345n);
    expect(fee.wad).toBe(12_345n * 10n ** 12n);
  });
});

describe("a native USDC pool", () => {
  it("still pays a buy as value, quote first, with no approve", async () => {
    const { chain, client } = pool(TOKEN_FIRST, NATIVE_QUOTE);
    expect(await client.pool(TOKEN_FIRST).quoteIsCurrency0()).toBe(true);
    const result = await client.pool(TOKEN_FIRST).buy({ quoteIn: Usdc.parse("1"), minTokensOut: Tokens.ZERO, deadline });
    expect(chain.sends()).toEqual(["router.swapExactTokensForTokens"]);
    expect(chain.sent[0]?.value).toBe(WAD);
    expect(swapArgs(chain)[2]).toBe(true);
    expect(result.quote.eq(Usdc.parse("1"))).toBe(true);
    expect(result.approvalTxHash).toBeUndefined();
  });
});

describe("refusals before anything is sent", () => {
  it("refuses dust below one raw EURC unit, before any RPC", async () => {
    const { chain, client } = pool(QUOTE_FIRST, EURC.address);
    const refused = await refusal(() => client.pool(QUOTE_FIRST).buy({
      quoteIn: QuoteAmount.fromWad(EURC, WAD + 1n), minTokensOut: Tokens.ZERO, deadline,
    }));
    expect(refused.code).toBe("QuoteAmountNotRepresentable");
    expect(chain.rpc).toEqual([]);
  });

  it("refuses a native USDC amount on a EURC pool", async () => {
    const { chain, client } = pool(QUOTE_FIRST, EURC.address);
    expect((await refusal(() => client.pool(QUOTE_FIRST).quoteBuy(Usdc.parse("1")))).code).toBe("QuoteTokenMismatch");
    expect((await refusal(() => client.pool(QUOTE_FIRST).sell({
      tokensIn: Tokens.parse("1"), minQuoteOut: Usdc.parse("1"), deadline,
    }))).code).toBe("QuoteTokenMismatch");
    expect(chain.sent).toEqual([]);
  });

  it("refuses a fee hook that is not arcnow/arc-now-fee-hook@4.x.x", async () => {
    const { chain, client } = pool(QUOTE_FIRST, EURC.address, { hookVersion: "arcnow/arc-now-fee-hook@2.0.0" });
    const refused = await refusal(() => client.pool(QUOTE_FIRST).accruedHookFee());
    expect(refused.code).toBe("UnknownHookVersion");
    expect(chain.calls).not.toContain("hook.accruedFee");
  });
});

describe("review: what a quote and a trade carry, and what they refuse", () => {
  it("prices a EURC buy with no value and the router's EURC allowance overridden", async () => {
    const { chain, client } = pool(QUOTE_FIRST, EURC.address);
    await client.pool(QUOTE_FIRST).quoteBuy(QuoteAmount.parse(EURC, "1"), { from: TRADER });
    const sim = chain.simulations.find((s) => s.functionName === "swapExactTokensForTokens");
    expect(sim?.value ?? 0n).toBe(0n);
    expect(Object.keys(sim?.stateOverride ?? {})).toContain(EURC.address);
  });

  it("prices a native buy WITH the value, and no token override", async () => {
    const { chain, client } = pool(TOKEN_FIRST, NATIVE_QUOTE);
    await client.pool(TOKEN_FIRST).quoteBuy(Usdc.parse("1"));
    const sim = chain.simulations.find((s) => s.functionName === "swapExactTokensForTokens");
    expect(sim?.value).toBe(WAD);
  });

  it.each([
    ["a version-2 fee hook", { hookVersion: "arcnow/arc-now-fee-hook@2.0.0" }, "UnknownHookVersion"],
    ["a version-1 v4 migrator", { migratorVersion: "arcnow/uniswap-v4-migrator@1.0.0" }, "UnknownCurveVersion"],
  ] as const)("refuses every pool quote and trade on %s, before any swap is simulated", async (_, options, code) => {
    const { chain, client } = pool(QUOTE_FIRST, EURC.address, options);
    const handle = client.pool(QUOTE_FIRST);
    for (const [name, run] of [
      ["quoteBuy", () => handle.quoteBuy(QuoteAmount.parse(EURC, "1"), { from: TRADER })],
      ["quoteSell", () => handle.quoteSell(Tokens.parse("1"), { from: TRADER })],
      ["buy", () => handle.buy({ quoteIn: QuoteAmount.parse(EURC, "1"), minTokensOut: Tokens.ZERO, deadline })],
      ["sell", () => handle.sell({ tokensIn: Tokens.parse("1"), minQuoteOut: QuoteAmount.zero(EURC), deadline })],
    ] as [string, () => Promise<unknown>][]) {
      expect((await refusal(run)).code, name).toBe(code);
    }
    expect(chain.simulations).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  it("rounds a EURC sell floor UP to a raw unit, never loosening it", async () => {
    const { chain, client } = pool(QUOTE_FIRST, EURC.address);
    await client.pool(QUOTE_FIRST).sell({
      tokensIn: Tokens.parse("100"), minQuoteOut: QuoteAmount.fromWad(EURC, 2_500_000n * 10n ** 12n + 1n), deadline,
    });
    expect(swapArgs(chain)[1]).toBe(2_500_001n);
  });
});

describe("a fill read out of its receipt, in raw units of the quote", () => {
  const HASH: Hex = `0x${"ef".repeat(32)}`;
  const where = (side: "buy" | "sell", quoteIsCurrency0: boolean): PoolFillSource => ({
    side, poolManager: MANAGER, hook: HOOK, poolId: POOL_ID, hash: HASH,
    quoteToken: EURC, quoteIsCurrency0,
  });
  const toLog = (log: EmittedLog): Log => ({
    ...encodeLog(log), blockHash: `0x${"00".repeat(32)}`, blockNumber: 1n, logIndex: 0,
    transactionHash: `0x${"ef".repeat(32)}`, transactionIndex: 0, removed: false,
  }) as Log;
  const swap = (amount0: bigint, amount1: bigint) => toLog({
    address: MANAGER, abi: poolManagerSwapEventAbi, eventName: "Swap",
    args: {
      id: POOL_ID, sender: ROUTER, amount0, amount1,
      sqrtPriceX96: 1n, liquidity: 1n, tick: 0, fee: 2000,
    },
  });
  const fee = (amount: bigint, currency: Address) => toLog({
    address: HOOK, abi: arcNowFeeHookAbi, eventName: "HookFeeTaken",
    args: {
      poolId: POOL_ID, token: QUOTE_FIRST, payer: ROUTER, currency, feeAmount: amount,
      onInput: true,
    },
  });

  it("takes the quote leg from amount0 when the quote is currency0, and scales it to WAD", () => {
    const fill = quoteFillFromLogs([fee(8_000n, EURC.address), swap(-992_000n, 5n * WAD)], where("buy", true));
    expect(fill.quote.format()).toBe("1 EURC");
    expect(fill.feeQuote.toRaw()).toBe(8_000n);
  });

  it("takes it from amount1 when the token is currency0", () => {
    const fill = quoteFillFromLogs([fee(8_000n, EURC.address), swap(5n * WAD, -992_000n)], where("buy", false));
    expect(fill.quote.format()).toBe("1 EURC");
  });

  it("counts only the hook fee taken in the pool's quote currency", () => {
    const fill = quoteFillFromLogs(
      [fee(8_000n, EURC.address), fee(777n, NATIVE_QUOTE), swap(-992_000n, 5n * WAD)],
      where("buy", true),
    );
    expect(fill.feeQuote.toRaw()).toBe(8_000n);
  });

  it("refuses a quote leg whose sign contradicts the side, in either order", () => {
    expect(() => quoteFillFromLogs([swap(990_000n, -5n)], where("buy", true))).toThrow(/buy/);
    expect(() => quoteFillFromLogs([swap(-5n, -990_000n)], where("sell", false))).toThrow(/sell/);
  });
});

describe("the hook's 0.80%, on raw units the way the hook computes it", () => {
  it("floors a buy's fee in raw units, so dust below 125 raw units is fee-free", () => {
    expect(buyFeeFromQuoteIn(QuoteAmount.parse(EURC, "1")).toRaw()).toBe(8_000n);
    expect(buyFeeFromQuoteIn(QuoteAmount.fromRaw(EURC, 124n)).isZero()).toBe(true);
    expect(buyFeeFromQuoteIn(QuoteAmount.fromRaw(EURC, 125n)).toRaw()).toBe(1n);
    expect(buyFeeFromQuoteIn(Usdc.parse("100")).toString()).toBe("0.8");
  });

  it("grosses a sell's payout back up in raw units", () => {
    expect(sellFeeFromQuoteOut(QuoteAmount.parse(EURC, "99.2")).format()).toBe("0.8 EURC");
  });

  it("unpacks a delta whose legs are raw units of two different decimals", () => {
    expect(unpackBalanceDelta(packDelta(-1_000_000n, TOKENS_OUT)))
      .toEqual({ amount0: -1_000_000n, amount1: TOKENS_OUT });
  });
});
