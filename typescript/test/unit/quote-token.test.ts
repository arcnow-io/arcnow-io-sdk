/**
 * A quote token as something you hold, approve and spend.
 *
 * Native USDC is paid as msg.value and has no allowance; an ERC-20 quote is
 * pulled, so a spend needs an allowance first. Two properties are pinned here
 * because both fail silently: the approve is **exact**, never unlimited, and
 * **nothing is sent when the allowance already covers the spend**. The RPC cost
 * is pinned too, because the public Arc endpoint rate-limits.
 */

import type { Address } from "viem";
import { erc20Abi } from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_USDC, QuoteAmount, Usdc } from "../../src/amounts.js";
import { createArcNowClient } from "../../src/client.js";
import { isArcNowError } from "../../src/errors/index.js";
import { resolveNetwork } from "../../src/networks.js";
import { FakeChain, fakeErc20 } from "./support/fake-chain.js";

const EURC_ADDRESS: Address = "0x89b50855aa3be2f677cd6303cec089b5f319d72a";
const OWNER: Address = "0x00000000000000000000000000000000000000c0";
const SPENDER: Address = "0x00000000000000000000000000000000000000d1";

const config = resolveNetwork("arc-testnet");
const EURC = config.quoteTokens.find((token) => token.symbol === "EURC")!;

function setup(allowance: bigint, balance = 100_000_000n) {
  const eurc = fakeErc20({
    label: "eurc", address: EURC_ADDRESS, abi: erc20Abi, symbol: "EURC", name: "EURC", decimals: 6,
    balances: { [OWNER]: balance },
    allowances: { [`${OWNER}:${SPENDER}`]: allowance },
  });
  const chain = new FakeChain({ [EURC_ADDRESS]: eurc });
  chain.balances.set(OWNER.toLowerCase(), 7n * 10n ** 18n);
  const client = createArcNowClient({ network: "arc-testnet", transport: chain.transport(), account: OWNER });
  return { chain, eurc, client };
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

describe("balances", () => {
  it("reads native USDC with eth_getBalance, as an 18-decimal amount", async () => {
    const { chain, client } = setup(0n);
    const balance = await client.quoteToken(NATIVE_USDC).balanceOf(OWNER);
    expect(balance.eq(Usdc.fromWhole(7n))).toBe(true);
    expect(chain.rpc).toEqual(["eth_getBalance"]);
  });

  it("reads an ERC-20 with balanceOf, raw units scaled to WAD", async () => {
    const { chain, client } = setup(0n, 12_500_000n);
    const balance = await client.quoteToken(EURC).balanceOf(OWNER);
    expect(balance.format()).toBe("12.5 EURC");
    expect(balance.toRaw()).toBe(12_500_000n);
    expect(chain.calls).toEqual(["eurc.balanceOf"]);
  });

  it("reads balance and allowance together in ONE eth_call", async () => {
    const { chain, client } = setup(3_000_000n, 9_000_000n);
    const state = await client.quoteToken(EURC_ADDRESS).spendState(OWNER, SPENDER);
    expect(state.balance.format()).toBe("9 EURC");
    expect(state.allowance?.format()).toBe("3 EURC");
    expect(chain.count("eth_call")).toBe(1);
  });

  it("reads a native balance through Multicall3 too, with no allowance at all", async () => {
    const { chain, client } = setup(0n);
    const state = await client.quoteToken(NATIVE_USDC).spendState(OWNER, SPENDER);
    expect(state.balance.eq(Usdc.fromWhole(7n))).toBe(true);
    expect(state.allowance).toBeUndefined();
    expect(chain.count("eth_call")).toBe(1);
    expect(chain.calls).toContain("multicall.getEthBalance");
  });
});

describe("the allowance flow", () => {
  it("sends nothing when the allowance already covers the spend", async () => {
    const { chain, client } = setup(5_000_000n);
    const outcome = await client.quoteToken(EURC).ensureAllowance(SPENDER, QuoteAmount.parse(EURC, "5"));
    expect(outcome.approved).toBe(false);
    expect(outcome.txHash).toBeUndefined();
    expect(outcome.allowance.format()).toBe("5 EURC");
    expect(chain.sent).toEqual([]);
    expect(chain.count("eth_sendTransaction")).toBe(0);
  });

  it("approves EXACTLY the spend when it does not, never an unlimited amount", async () => {
    const { chain, eurc, client } = setup(1_000_000n);
    const outcome = await client.quoteToken(EURC).ensureAllowance(SPENDER, QuoteAmount.parse(EURC, "25.5"));
    expect(outcome.approved).toBe(true);
    expect(outcome.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.sends()).toEqual(["eurc.approve"]);
    expect(chain.sent[0]?.args).toEqual([SPENDER, 25_500_000n]);
    expect(chain.sent[0]?.value).toBe(0n);
    expect(eurc.allowances.get(`${OWNER}:${SPENDER}`)).toBe(25_500_000n);
    expect(outcome.allowance.format()).toBe("25.5 EURC");
    expect(chain.rpc).toContain("eth_getTransactionReceipt");
  });

  it("needs no allowance for native USDC and asks nobody", async () => {
    const { chain, client } = setup(0n);
    const outcome = await client.quoteToken(NATIVE_USDC).ensureAllowance(SPENDER, Usdc.parse("100"));
    expect(outcome.approved).toBe(false);
    expect(chain.rpc).toEqual([]);
    const refused = await refusal(() => client.quoteToken(NATIVE_USDC).allowance(OWNER, SPENDER));
    expect(refused.code).toBe("InvalidArgument");
    expect(refused.message).toMatch(/msg\.value/);
  });

  it("refuses to approve an amount with dust below one raw unit, before any RPC", async () => {
    const { chain, client } = setup(0n);
    const dusty = QuoteAmount.fromWad(EURC, 10n ** 12n + 1n);
    expect((await refusal(() => client.quoteToken(EURC).ensureAllowance(SPENDER, dusty))).code)
      .toBe("QuoteAmountNotRepresentable");
    expect((await refusal(() => client.quoteToken(EURC).approve(SPENDER, dusty))).code)
      .toBe("QuoteAmountNotRepresentable");
    expect(chain.rpc).toEqual([]);
  });

  it("refuses an amount in another quote", async () => {
    const { chain, client } = setup(0n);
    const refused = await refusal(() => client.quoteToken(EURC).ensureAllowance(SPENDER, Usdc.parse("1")));
    expect(refused.code).toBe("QuoteTokenMismatch");
    expect(chain.rpc).toEqual([]);
  });

  it("refuses a write on a read-only client", async () => {
    const eurc = fakeErc20({ label: "eurc", address: EURC_ADDRESS, abi: erc20Abi, symbol: "EURC", name: "EURC", decimals: 6 });
    const chain = new FakeChain({ [EURC_ADDRESS]: eurc });
    const client = createArcNowClient({ network: "arc-testnet", transport: chain.transport() });
    expect((await refusal(() => client.quoteToken(EURC).ensureAllowance(SPENDER, QuoteAmount.parse(EURC, "1")))).code)
      .toBe("ReadOnlyClient");
  });
});

describe("review: a reverted approve is not an approval", () => {
  it("throws when the approve's receipt says reverted", async () => {
    const eurc = fakeErc20({ label: "eurc", address: EURC_ADDRESS, abi: erc20Abi, symbol: "EURC", name: "EURC", decimals: 6 });
    const approve = eurc.writes?.approve;
    const chain = new FakeChain({
      [EURC_ADDRESS]: {
        ...eurc,
        writes: { approve: (args, ctx) => ({ ...approve?.(args, ctx), reverted: true }) },
      },
    });
    const client = createArcNowClient({ network: "arc-testnet", transport: chain.transport(), account: OWNER });
    const refused = await refusal(() => client.quoteToken(EURC).ensureAllowance(SPENDER, QuoteAmount.parse(EURC, "1")));
    expect(refused.code).toBe("RpcFailure");
    expect(refused.message).toMatch(/revert/);
  });
});

describe("quote token metadata", () => {
  it("comes from networks.json with no RPC for a quote it lists", async () => {
    const { chain, client } = setup(0n);
    expect(await client.quoteTokenInfo("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")).toEqual(EURC);
    expect(await client.quoteTokenInfo(NATIVE_USDC.address)).toEqual(NATIVE_USDC);
    expect(chain.rpc).toEqual([]);
  });

  it("is read on chain in ONE eth_call for a quote it does not, and cached for the process", async () => {
    const UNKNOWN: Address = "0x00000000000000000000000000000000000e7401";
    const token = fakeErc20({ label: "gbp", address: UNKNOWN, abi: erc20Abi, symbol: "GBPT", name: "Pound", decimals: 8 });
    const chain = new FakeChain({ [UNKNOWN]: token });
    const first = createArcNowClient({ network: "arc-testnet", transport: chain.transport() });
    expect(await first.quoteTokenInfo(UNKNOWN)).toEqual({
      address: UNKNOWN, symbol: "GBPT", name: "Pound", decimals: 8, isNative: false,
    });
    expect(chain.count("eth_call")).toBe(1);

    // A second client on the same chain asks nobody.
    const second = createArcNowClient({ network: "arc-testnet", transport: chain.transport() });
    expect((await second.quoteTokenInfo(UNKNOWN)).symbol).toBe("GBPT");
    expect(chain.count("eth_call")).toBe(1);
  });

  it("never caches a failed read", async () => {
    const UNKNOWN: Address = "0x00000000000000000000000000000000000e7402";
    const token = fakeErc20({ label: "chf", address: UNKNOWN, abi: erc20Abi, symbol: "CHFT", name: "Franc", decimals: 6 });
    const chain = new FakeChain({ [UNKNOWN]: token });
    const client = createArcNowClient({ network: "arc-testnet", transport: chain.transport() });
    chain.failCalls = true;
    expect((await refusal(() => client.quoteTokenInfo(UNKNOWN))).code).toBe("RpcFailure");
    chain.failCalls = false;
    expect((await client.quoteTokenInfo(UNKNOWN)).symbol).toBe("CHFT");
  });
});
