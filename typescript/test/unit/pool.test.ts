/**
 * The things about post-graduation trading that can be wrong without anyone
 * noticing, pinned without a chain.
 *
 * 1. **Unpacking a `BalanceDelta`.** Two `int128`s packed into an `int256`.
 *    Read with the wrong width or the wrong sign it still produces a number, and
 *    a number is exactly what a quote is expected to be.
 * 2. **The allowance storage slot.** A hand-derived slot used to build an
 *    `eth_call` override. Wrong, it prices nothing; nothing about the failure
 *    says "slot".
 * 3. **The fee identities.** The buy and the sell derive the same 1% from
 *    different sides of the swap, and using one where the other belongs is
 *    wrong by 1% of the fee — plausible in both directions.
 * 4. **The two refusals.** No router configured for the network must refuse
 *    with `NoRouterDeployed`; a router bound to a different PoolManager from the
 *    token's must refuse with `PoolUnreachable` — both before a swap is encoded,
 *    and the second decided by the router's own answer rather than the preset.
 * 5. **The dispatch.** A trade must go to the venue the token is actually on.
 *
 * The transport here answers a small script of `eth_call`s and nothing else, so
 * a test that reached for anything unscripted fails loudly rather than
 * silently passing against a real endpoint.
 */

import type { Abi, AbiEvent, Address, Hex, Log } from "viem";
import {
  concat,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  pad,
  toEventSelector,
} from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_USDC, Tokens, Usdc } from "../../src/amounts.js";
import { createArcNowClient } from "../../src/client.js";
import { Deadline } from "../../src/deadline.js";
import { isArcNowError } from "../../src/errors/index.js";
import { POOL_LP_FEE_PIPS, POOL_TRADE_FEE_BPS, TRADE_FEE_BPS } from "../../src/fees.js";
import { arcNowFeeHookAbi, arcTokenAbi, bondingCurveAbi, uniswapV4MigratorAbi }
  from "../../src/generated/abi/index.js";
import { uniswapV4Router04Abi }
  from "../../src/generated/abi/external/uniswapV4Router04.js";
import type { CustomNetwork, NetworkConfig } from "../../src/networks.js";
import { rawNetwork, resolveNetwork } from "../../src/networks.js";
import {
  ARC_TOKEN_ALLOWANCE_SLOT,
  arcTokenAllowanceSlot,
  buyFeeFromQuoteIn,
  poolManagerSwapEventAbi,
  sellFeeFromQuoteOut,
  sellQuoteOutFromFee,
  unpackBalanceDelta,
  quoteFillFromLogs,
} from "../../src/pool.js";

/** Where arcnow-io/contracts' deterministic router deployment lands. */
const ROUTER: Address = "0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e";

/* -------------------------------------------------------------------------- *
 * BalanceDelta
 * -------------------------------------------------------------------------- */

/** Pack two `int128`s the way v4 does, so the unpacker is tested against its inverse. */
function packBalanceDelta(amount0: bigint, amount1: bigint): bigint {
  const raw = (BigInt.asUintN(128, amount0) << 128n) | BigInt.asUintN(128, amount1);
  // viem hands an int256 back as a SIGNED bigint, so that is what the unpacker
  // must accept -- and the top bit of amount0 is what makes it negative.
  return BigInt.asIntN(256, raw);
}

const INT128_MAX = 2n ** 127n - 1n;
const INT128_MIN = -(2n ** 127n);

describe("unpacking a BalanceDelta", () => {
  it("reads a buy: USDC out of the trader, tokens in", () => {
    // currency0 is native USDC, currency1 is the token, and the delta is the
    // TRADER's. On a buy they pay currency0 and receive currency1.
    const packed = packBalanceDelta(-25n * 10n ** 18n, 1_234n * 10n ** 18n);
    const { amount0, amount1 } = unpackBalanceDelta(packed);
    expect(amount0).toBe(-25n * 10n ** 18n);
    expect(amount1).toBe(1_234n * 10n ** 18n);
  });

  it("reads a sell: tokens out of the trader, USDC in", () => {
    const packed = packBalanceDelta(9_900n * 10n ** 15n, -1_000n * 10n ** 18n);
    const { amount0, amount1 } = unpackBalanceDelta(packed);
    expect(amount0).toBe(9_900n * 10n ** 15n);
    expect(amount1).toBe(-1_000n * 10n ** 18n);
  });

  it("truncates amount1 to 128 bits instead of taking the whole remainder", () => {
    // THE TRAP. `packed & ((1n << 128n) - 1n)` read as unsigned gives 2^128
    // minus the real value -- about 3.4e38 -- for every negative token leg,
    // which is every sell. It looks like a quote; it is off by 20 orders of
    // magnitude.
    const packed = packBalanceDelta(1n, -1n);
    const { amount1 } = unpackBalanceDelta(packed);
    expect(amount1).toBe(-1n);
    expect(amount1).not.toBe(2n ** 128n - 1n);
  });

  it("does not sign-extend the whole int256 into amount0", () => {
    // The other half of the trap: `packed >> 128n` on a NEGATIVE bigint keeps
    // shifting in ones forever, so a delta whose amount0 is -1 reads as -1 by
    // luck and one whose amount0 is a large negative reads as something else.
    const packed = packBalanceDelta(-3n, 7n);
    expect(unpackBalanceDelta(packed)).toEqual({ amount0: -3n, amount1: 7n });
  });

  it("round-trips both int128 extremes, in every sign combination", () => {
    const corners: [bigint, bigint][] = [
      [INT128_MAX, INT128_MAX],
      [INT128_MIN, INT128_MIN],
      [INT128_MAX, INT128_MIN],
      [INT128_MIN, INT128_MAX],
      [0n, 0n],
      [-1n, INT128_MAX],
    ];
    for (const [a0, a1] of corners) {
      expect(unpackBalanceDelta(packBalanceDelta(a0, a1)), `${a0}/${a1}`)
        .toEqual({ amount0: a0, amount1: a1 });
    }
  });

  it("accepts the unsigned form too, because a raw eth_call return is unsigned", () => {
    // Decoding the same 32 bytes as a uint256 rather than an int256 gives a
    // different bigint for the same delta. Both must unpack identically, or a
    // caller who decoded the return themselves gets a different answer than
    // this SDK does.
    const signed = packBalanceDelta(-25n * 10n ** 18n, 1_234n * 10n ** 18n);
    const unsigned = BigInt.asUintN(256, signed);
    expect(signed).not.toBe(unsigned);
    expect(unpackBalanceDelta(unsigned)).toEqual(unpackBalanceDelta(signed));
  });
});

/* -------------------------------------------------------------------------- *
 * The allowance slot
 * -------------------------------------------------------------------------- */

describe("the ArcToken allowance storage slot", () => {
  const owner: Address = "0x1111111111111111111111111111111111111111";
  const router = ROUTER;

  it("is slot 11, and says so out loud", () => {
    // `forge inspect ArcToken storage` on the pinned contracts commit. The fork
    // suite writes this slot and reads the value back through allowance(),
    // which is what keeps this number honest.
    expect(ARC_TOKEN_ALLOWANCE_SLOT).toBe(11n);
  });

  it("nests the two mapping hashes in the order Solidity does", () => {
    // Derived a second time, by hand, with concat+pad rather than
    // encodeAbiParameters. Two implementations that agree is the point: an
    // assertion written with the same helper as the code would pass even if
    // both were wrong.
    const inner = keccak256(concat([pad(owner), pad("0x0b")]));
    const expected = keccak256(concat([pad(router), inner]));
    expect(arcTokenAllowanceSlot(owner, router)).toBe(expected);
  });

  it("matches the value verified live against the Arc endpoint", () => {
    // An eth_call of an arcnow.io token's allowance(owner, router) on
    // rpc.testnet.arc.io, with exactly this slot overridden, read the override back. Pinned so a
    // refactor of the derivation cannot quietly move it.
    expect(arcTokenAllowanceSlot(owner, router))
      .toBe("0x24badc56149d4a7decc63bc0a0731a6dcb596a16f2cf879d85645d2b1a4ba6a0");
  });

  it("is different for every (owner, spender) pair, in both directions", () => {
    const other: Address = "0x2222222222222222222222222222222222222222";
    const slots = new Set([
      arcTokenAllowanceSlot(owner, router),
      arcTokenAllowanceSlot(other, router),
      arcTokenAllowanceSlot(owner, other),
      // Swapped: owner and spender are NOT interchangeable, and a derivation
      // that hashed them in the wrong order would still be deterministic.
      arcTokenAllowanceSlot(router, owner),
    ]);
    expect(slots.size).toBe(4);
  });
});

/* -------------------------------------------------------------------------- *
 * The fee identities
 * -------------------------------------------------------------------------- */

describe("the hook's 0.80%, derived from a quote", () => {
  it("is 80 bps of the trade, not the curve's 100: the pool's 0.20% LP fee makes up the rest", () => {
    expect(POOL_TRADE_FEE_BPS).toBe(80n);
    expect(POOL_TRADE_FEE_BPS).not.toBe(TRADE_FEE_BPS);
    expect(POOL_TRADE_FEE_BPS + BigInt(POOL_LP_FEE_PIPS) / 100n).toBe(TRADE_FEE_BPS);
  });

  it("takes it off the input on a buy", () => {
    // The hook charges before the pool sees the money, so the pool swaps 99.2%
    // of what the trader pays and the fee is a plain 0.80% of the input.
    expect(buyFeeFromQuoteIn(Usdc.parse("100")).toString()).toBe("0.8");
    expect(buyFeeFromQuoteIn(Usdc.parse("25")).toString()).toBe("0.2");
    expect(buyFeeFromQuoteIn(Usdc.ZERO).isZero()).toBe(true);
  });

  it("grosses back up on a sell, because the trader already sees 99.2%", () => {
    // The pool quotes the USDC and the hook takes its cut out of the payout, so
    // usdcOut is 99.2% of the gross and the fee is 0.80% of that gross.
    expect(sellFeeFromQuoteOut(Usdc.parse("99.2")).toString()).toBe("0.8");
    expect(sellFeeFromQuoteOut(Usdc.ZERO).isZero()).toBe(true);
  });

  it("closes: gross = out + fee, for every gross in a wide range", () => {
    for (const whole of [1n, 7n, 50n, 12_345n, 1_000_000n]) {
      const gross = Usdc.fromWhole(whole);
      const out = Usdc.fromWad((gross.wad * 9_920n) / 10_000n);
      const fee = sellFeeFromQuoteOut(out);
      // Integer division at two steps, so allow the wei it can lose; what must
      // not happen is a systematic error.
      const reconstructed = out.add(fee).wad;
      expect(reconstructed, `gross ${gross.toString()}`)
        .toBeGreaterThanOrEqual(gross.wad - 2n);
      expect(reconstructed).toBeLessThanOrEqual(gross.wad + 2n);
    }
  });

  it("runs backwards from the fee the hook logged, to within 124 wei", () => {
    // The hook emits the feeWad it actually took, so a sell's payout can be
    // recovered from the receipt instead of from a simulation. The fee was
    // FLOORED, so this recovers the bottom of the window of grosses that would
    // have produced it -- every gross in [feeWad*125, feeWad*125 + 124].
    for (const gross of [
      Usdc.parse("1").wad,
      Usdc.parse("37.5").wad,
      Usdc.parse("0.0001").wad,
      123_456_789_012_345_678n,
    ]) {
      const feeWad = (gross * 80n) / 10_000n;
      const settled = gross - feeWad;
      const recovered = sellQuoteOutFromFee(Usdc.fromWad(feeWad)).wad;
      expect(recovered, `gross ${gross}`).toBeLessThanOrEqual(settled);
      expect(settled - recovered, `gross ${gross}`).toBeLessThanOrEqual(124n);
    }
  });

  it("recovers exactly when the gross happens to land on the boundary", () => {
    // 100 USDC exactly: the fee is 0.8 USDC with nothing floored away, so there
    // is no window and the recovery is an equality.
    const fee = Usdc.parse("0.8").wad;
    expect(sellQuoteOutFromFee(Usdc.fromWad(fee)).wad).toBe(Usdc.parse("99.2").wad);
  });

  it("recovers zero from zero, which is the dust case the hook does not log", () => {
    // A swap too small to charge for emits no HookFeeTaken at all, and the SDK
    // falls back to the simulated delta rather than reading this as a payout.
    expect(sellQuoteOutFromFee(Usdc.ZERO).isZero()).toBe(true);
  });

  it("is NOT the buy identity applied to the sell's output", () => {
    // The mistake this pair exists to prevent. Using usdcOut * 0.80% under-reports
    // the fee by 0.80% of itself -- 0.0064 on a 99.2 USDC payout. Both numbers
    // look like a fee; only one is the one the hook took.
    const out = Usdc.parse("99.2");
    expect(sellFeeFromQuoteOut(out).wad).toBeGreaterThan(buyFeeFromQuoteIn(out).wad);
    expect(sellFeeFromQuoteOut(out).sub(buyFeeFromQuoteIn(out)).toString()).toBe("0.0064");
  });
});

/* -------------------------------------------------------------------------- *
 * A chain, scripted
 * -------------------------------------------------------------------------- */

const TOKEN: Address = "0x00000000000000000000000000000000000000aa";
const CURVE: Address = "0x00000000000000000000000000000000000000bb";
const MIGRATOR: Address = "0x00000000000000000000000000000000000000cc";
/** arcnow.io's own PoolManager: `networks.json`'s `v4.poolManager`, and what the router serves. */
const OURS: Address = "0x06110b57dd9b82DD846ee0325fB81B284E1C6dD0";
/** Some other PoolManager. Synthetic: nothing here should care which. */
const ELSEWHERE: Address = getAddress("0x00000000000000000000000000000000000e15e0");
const SIGNER: Address = "0x1111111111111111111111111111111111111111";

interface Script {
  /** What `token.migratedPool()` answers. The zero address means "still on its curve". */
  migratedPool: Address;
  /** What the migrator's `poolManager()` answers. */
  poolManager: Address;
  /**
   * What the ROUTER's own `poolManager()` answers. Defaults to {@link OURS},
   * which is the planned deployment.
   */
  routerPoolManager?: Address;
  /** What the pool key's fee hook answers to `VERSION()`. Defaults to `@4.0.0`. */
  hookVersion?: string;
}

/** The fee hook the scripted pool key names. */
const HOOK_ADDRESS: Address = "0x00000000000000000000000000000000000020cc";
const SIGNER_PLATFORM: Address = "0x00000000000000000000000000000000000000f1";
const SIGNER_PROTOCOL: Address = "0x00000000000000000000000000000000000000f2";

/**
 * A transport that answers exactly the reads these tests script, and throws on
 * anything else.
 *
 * Decoding the calldata against the real pinned ABIs rather than matching
 * selectors by hand means a test cannot pass against an SDK that called a
 * function these fixtures do not implement. Router calls are recorded as
 * `router.<name>`, so a test can tell the two `poolManager()`s apart.
 */
function scripted(script: Script, calls: string[] = []) {
  const abis: Record<string, Abi> = {
    [TOKEN.toLowerCase()]: arcTokenAbi,
    [CURVE.toLowerCase()]: bondingCurveAbi,
    [MIGRATOR.toLowerCase()]: uniswapV4MigratorAbi,
    [ROUTER.toLowerCase()]: uniswapV4Router04Abi,
    [HOOK_ADDRESS.toLowerCase()]: arcNowFeeHookAbi,
  };

  return custom({
    request: ({ method, params }): Promise<Hex> => {
      if (method === "eth_chainId") return Promise.resolve("0x4cef52");
      if (method !== "eth_call") {
        throw new Error(`unscripted RPC method ${method}`);
      }
      const call = (params as [{ to: Address; data: Hex }])[0];
      const abi = abis[call.to.toLowerCase()];
      if (!abi) throw new Error(`unscripted call to ${call.to}`);
      const { functionName } = decodeFunctionData({ abi, data: call.data });
      const toRouter = call.to.toLowerCase() === ROUTER.toLowerCase();
      calls.push(toRouter ? `router.${functionName}` : functionName);

      const answer = (result: unknown): Promise<Hex> =>
        Promise.resolve(encodeFunctionResult({ abi, functionName, result }));

      switch (functionName) {
        case "migrator": return answer(MIGRATOR);
        case "curve": return answer(CURVE);
        case "migratedPool": return answer(script.migratedPool);
        case "poolManager":
          // The same function name on two contracts, and the SDK must ask the
          // RIGHT one: the migrator says where the pool IS, the router says
          // where it can REACH.
          return answer(toRouter ? (script.routerPoolManager ?? OURS) : script.poolManager);
        case "poolIdOf": return answer(pad("0x01"));
        case "poolKey":
          return answer([pad("0x00", { size: 20 }), TOKEN, 2000, 60, HOOK_ADDRESS]);
        case "swapExactTokensForTokens":
          // A buy's delta: 1 USDC paid, 4,321 tokens received.
          return answer(
            BigInt.asIntN(
              256,
              (BigInt.asUintN(128, -(10n ** 18n)) << 128n) | (4_321n * 10n ** 18n),
            ),
          );
        // The curve's version: the front door asks it before any curve quote.
        // The hook's: the claim-only pool methods ask it before any read.
        case "VERSION":
          return answer(call.to.toLowerCase() === HOOK_ADDRESS.toLowerCase()
            ? (script.hookVersion ?? "arcnow/arc-now-fee-hook@4.0.0")
            : call.to.toLowerCase() === MIGRATOR.toLowerCase()
              ? "arcnow/uniswap-v4-migrator@2.0.0"
              : "arcnow/bonding-curve@4.0.0");
        case "accruedFee": return answer(12_345n);
        case "feeBps": return answer(80n);
        case "feeConfigOf":
          return answer({
            creatorShareBps: 5_000n, platformShareBps: 1_875n, refShareBps: 0n,
            protocolShareBps: 3_125n,
            platformRecipient: SIGNER_PLATFORM, protocolRecipient: SIGNER_PROTOCOL,
          });
        // The curve's quote: native USDC, read by the front door's curve quote.
        case "quoteToken": return answer("0x0000000000000000000000000000000000000000");
        case "quoteDecimals": return answer(18);
        case "quoteBuy":
          return answer([
            777n * 10n ** 18n, // tokensOutWad
            10n ** 16n, // feeQuoteWad
            10n ** 18n, // quoteSpentWad
            0n, // refundWad
            10n ** 18n, // newReserveWad
            777n * 10n ** 18n, // newTokensSoldWad
            10n ** 12n, // newPriceWad
            false, // graduates
          ]);
        default:
          throw new Error(`unscripted call to ${functionName}`);
      }
    },
  });
}

/** The arc-testnet preset as it ships, with the router arcnow.io deployed. */
const PRESET = resolveNetwork("arc-testnet");

/**
 * The arc-testnet preset with its router taken away.
 *
 * The refusal tests below used to run against the unmodified preset, because
 * the preset's router WAS null until the router was broadcast. That made them
 * a statement about one day's deployment instead of about the SDK: the moment
 * the router existed, every one of them failed while the behaviour they guard
 * was still correct. They now build the no-router case explicitly, so they
 * keep proving that a network with no router refuses — whatever arc-testnet
 * happens to have.
 */
const NO_ROUTER: NetworkConfig = {
  ...PRESET,
  contracts: { ...PRESET.contracts, v4Router: undefined },
};

/** The arc-testnet preset with the router configured, as it will be once one is broadcast. */
function withRouter(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return { ...PRESET, ...overrides, contracts: { ...PRESET.contracts, v4Router: ROUTER } };
}

/** A client on the preset with a router configured — the case most tests are about. */
const clientFor = (script: Script, calls?: string[], account?: Address) =>
  createArcNowClient({
    network: withRouter(), transport: scripted(script, calls), account, multicallAddress: null,
  });

/** A client on the arc-testnet preset with no router configured. */
const presetClientFor = (script: Script, calls?: string[], account?: Address) =>
  createArcNowClient({
    network: NO_ROUTER, transport: scripted(script, calls), account, multicallAddress: null,
  });

/** Every pool quote and trade, by name, so a refusal can be asserted across all of them. */
function everyPoolCall(client: ReturnType<typeof createArcNowClient>) {
  const pool = client.pool(TOKEN);
  const deadline = Deadline.inMinutes(5);
  const cases: [string, () => Promise<unknown>][] = [
    ["quoteBuy", () => pool.quoteBuy(Usdc.parse("1"))],
    ["quoteSell", () => pool.quoteSell(Tokens.parse("1"))],
    ["buy", () => pool.buy({ quoteIn: Usdc.parse("1"), minTokensOut: Tokens.ZERO, deadline })],
    ["sell", () => pool.sell({ tokensIn: Tokens.parse("1"), minQuoteOut: Usdc.ZERO, deadline })],
  ];
  return cases;
}

/* -------------------------------------------------------------------------- *
 * Refusal one: no router
 * -------------------------------------------------------------------------- */

describe("a network with no v4 router configured", () => {
  const graduated: Script = { migratedPool: OURS, poolManager: OURS };

  it("is not arc-testnet any more: the preset names the router arcnow.io deployed", () => {
    // It was null until the router was broadcast, deliberately: the address is
    // predictable before it exists — CREATE2 with salt zero — but a predictable
    // address with no code at it is not a router. It now has code, verified by
    // codehash against the pinned upstream build.
    const deployed = "0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e";
    expect(rawNetwork("arc-testnet").contracts.v4Router?.toLowerCase()).toBe(deployed);
    expect(PRESET.contracts.v4Router?.toLowerCase()).toBe(deployed);
    // …and the no-router case the rest of this block exercises is explicit.
    expect(NO_ROUTER.contracts.v4Router).toBeUndefined();
  });

  it("reports every pool unreachable without throwing and without a round trip", async () => {
    // So a UI can ask before it renders a trade button, and a price page does
    // not pay an RPC per token to learn a fact about the network.
    const calls: string[] = [];
    expect(await presetClientFor(graduated, calls).pool(TOKEN).isReachable()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("REFUSES every quote and trade with NoRouterDeployed, before any eth_call", async () => {
    const calls: string[] = [];
    const client = presetClientFor(graduated, calls, SIGNER);
    const cases = [
      ...everyPoolCall(client),
      ["approveRouter", () => client.pool(TOKEN).approveRouter(Tokens.parse("1"))],
      ["routerAllowance", () => client.pool(TOKEN).routerAllowance(SIGNER)],
    ] as [string, () => Promise<unknown>][];
    for (const [name, run] of cases) {
      try {
        await run();
        expect.unreachable(`${name} must refuse with no router configured`);
      } catch (error) {
        if (!isArcNowError(error)) throw error;
        expect(error.code, name).toBe("NoRouterDeployed");
        expect(error.message, name).toMatch(/no Uniswap v4 router is deployed for arc-testnet/);
        expect(error.message, name).toMatch(/graduated tokens cannot be traded/);
        expect(error.message, name).toMatch(/script\/DeployV4Router\.s\.sol/);
        expect(error.details.network, name).toBe("arc-testnet");
      }
    }
    // A property of the network needs nothing from the chain to be known.
    expect(calls).toEqual([]);
  });

  it("refuses through the front door too, once it has found the token on its pool", async () => {
    const client = presetClientFor(graduated, [], SIGNER);
    await expect(client.trade(TOKEN).quoteBuy(Usdc.parse("1")))
      .rejects.toMatchObject({ code: "NoRouterDeployed" });
    await expect(client.trade(TOKEN).sell({
      tokensIn: Tokens.parse("1"), minQuoteOut: Usdc.ZERO, deadline: Deadline.inMinutes(5),
    })).rejects.toMatchObject({ code: "NoRouterDeployed" });
  });

  it("leaves a token still on its curve alone: the curve needs no router", async () => {
    const client = presetClientFor({
      migratedPool: "0x0000000000000000000000000000000000000000",
      poolManager: OURS,
    });
    const quote = await client.trade(TOKEN).quoteBuy(Usdc.parse("1"));
    expect(quote.venue).toBe("curve");
  });

  it("treats a custom network's missing or zero v4Router the same way", async () => {
    const anywhere: Address = "0x1111111111111111111111111111111111111111";
    const contracts = {
      launchpad: anywhere,
      tokenFactory: anywhere,
      curveFactory: anywhere,
      migratorRegistry: anywhere,
      platformRegistry: anywhere,
      arcnowPlatform: anywhere,
    };
    const networks: CustomNetwork[] = [
      { rpcUrl: "http://127.0.0.1:8545", chainId: 31337, contracts },
      // The zero address is a real account on Arc, not "none" by coincidence.
      {
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 31337,
        contracts: { ...contracts, v4Router: `0x${"0".repeat(40)}` },
      },
    ];
    for (const network of networks) {
      const client = createArcNowClient({ network, transport: scripted(graduated) });
      await expect(client.pool(TOKEN).quoteBuy(Usdc.parse("10")))
        .rejects.toMatchObject({ code: "NoRouterDeployed" });
      expect(await client.pool(TOKEN).isReachable()).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * With a router: reachable
 * -------------------------------------------------------------------------- */

describe("a router that serves the token's PoolManager", () => {
  const graduated: Script = { migratedPool: OURS, poolManager: OURS };

  it("is reachable, and a quote goes to contracts.v4Router", async () => {
    const calls: string[] = [];
    const pool = clientFor(graduated, calls).pool(TOKEN);
    expect(await pool.isReachable()).toBe(true);

    const quote = await pool.quoteBuy(Usdc.parse("1"));
    expect(quote.venue).toBe("pool");
    expect(quote.quoteIn.toString()).toBe("1");
    expect(quote.tokensOut.toString()).toBe("4321");
    expect(quote.feeQuote.toString()).toBe("0.008");
    expect(calls).toContain("router.swapExactTokensForTokens");
  });

  it("refuses a token that has not migrated at all, and points at the curve", async () => {
    const client = clientFor({
      migratedPool: "0x0000000000000000000000000000000000000000",
      poolManager: OURS,
    });
    try {
      await client.pool(TOKEN).quoteBuy(Usdc.parse("10"));
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("PoolNotMigrated");
      expect(error.message).toMatch(/client\.trade/);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Refusal two: a router bound somewhere else
 * -------------------------------------------------------------------------- */

describe("a router that serves a different PoolManager from the token's", () => {
  const elsewhere: Script = { migratedPool: ELSEWHERE, poolManager: ELSEWHERE };

  it("reports itself unreachable without throwing, so a UI can ask first", async () => {
    const pool = clientFor(elsewhere).pool(TOKEN);
    expect(await pool.isReachable()).toBe(false);
    // And the diagnostics still work: this is a real pool, just not one this
    // router can see.
    expect((await pool.poolManager()).toLowerCase()).toBe(ELSEWHERE.toLowerCase());
    expect((await pool.key()).currency1.toLowerCase()).toBe(TOKEN.toLowerCase());
  });

  it("refuses a buy quote with PoolUnreachable, naming both managers and the router", async () => {
    try {
      await clientFor(elsewhere).pool(TOKEN).quoteBuy(Usdc.parse("10"));
      expect.unreachable("a pool the router cannot see must be refused");
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("PoolUnreachable");
      expect(error.message).toContain(ELSEWHERE);
      // The ROUTER's own answer, not the preset's copy of it.
      expect(error.message).toContain(OURS);
      expect(error.message).toContain(ROUTER);
      expect(error.message).toMatch(/asked of the router itself/);
      expect(error.message).toMatch(/should not happen for an arcnow\.io token/);
      expect(error.message).not.toMatch(/legacy/i);
      expect(error.details).toEqual({
        token: TOKEN,
        poolManager: ELSEWHERE,
        routerPoolManager: OURS,
        router: ROUTER,
      });
    }
  });

  it("refuses a sell quote and both trades the same way", async () => {
    for (const [name, run] of everyPoolCall(clientFor(elsewhere, [], SIGNER))) {
      try {
        await run();
        expect.unreachable(`${name} should have refused`);
      } catch (error) {
        if (!isArcNowError(error)) throw error;
        expect(error.code, name).toBe("PoolUnreachable");
      }
    }
  });

  it("ASKS THE ROUTER, so a drifted v4.poolManager in the preset cannot decide it", async () => {
    // THE WHOLE POINT OF ASKING THE CHAIN. A check that compared one bundled
    // address against another could be made to pass by a single stale entry.
    //
    // Drifted one way: the preset names DRIFTED, the migrator is in DRIFTED,
    // and the router actually serves OURS. Compare preset against migrator and
    // this pool looks fine; ask the router and it is refused.
    const DRIFTED: Address = getAddress("0x00000000000000000000000000000000000d21f7");
    const drifted = createArcNowClient({
      network: withRouter({ v4: { poolManager: DRIFTED } }),
      transport: scripted({ migratedPool: DRIFTED, poolManager: DRIFTED, routerPoolManager: OURS }),
    });
    expect(await drifted.pool(TOKEN).isReachable()).toBe(false);
    await expect(drifted.pool(TOKEN).quoteBuy(Usdc.parse("10")))
      .rejects.toMatchObject({
        code: "PoolUnreachable",
        details: { routerPoolManager: OURS, poolManager: DRIFTED },
      });

    // And the other way: the preset names DRIFTED, but the migrator and the
    // router agree on OURS. The router's answer wins, so this is tradeable.
    const stale = createArcNowClient({
      network: withRouter({ v4: { poolManager: DRIFTED } }),
      transport: scripted({ migratedPool: OURS, poolManager: OURS, routerPoolManager: OURS }),
    });
    expect(await stale.pool(TOKEN).isReachable()).toBe(true);
    expect((await stale.pool(TOKEN).quoteBuy(Usdc.parse("1"))).venue).toBe("pool");
  });

  it("reads the router's poolManager once per client, not once per token", async () => {
    // It is immutable, and a per-token read would be one extra round trip on
    // every token a price page renders.
    const calls: string[] = [];
    const client = clientFor(elsewhere, calls);
    await client.pool(TOKEN).isReachable();
    await client.pool(TOKEN).isReachable();
    await client.pool("0x00000000000000000000000000000000000000ab").isReachable()
      .catch(() => undefined);
    expect(calls.filter((name) => name === "router.poolManager")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- *
 * The dispatch
 * -------------------------------------------------------------------------- */

describe("Trade dispatches on the venue the token is actually on", () => {
  const onCurve = {
    migratedPool: "0x0000000000000000000000000000000000000000" as Address,
    poolManager: OURS,
  };
  const onPool = { migratedPool: OURS, poolManager: OURS };

  it("says curve while migratedPool is zero", async () => {
    expect(await clientFor(onCurve).trade(TOKEN).venue()).toBe("curve");
  });

  it("says pool once it is not", async () => {
    expect(await clientFor(onPool).trade(TOKEN).venue()).toBe("pool");
  });

  it("quotes a buy on the curve, tagged so the two cannot be confused", async () => {
    const quote = await clientFor(onCurve).trade(TOKEN).quoteBuy(Usdc.parse("1"));
    expect(quote.venue).toBe("curve");
    if (quote.venue !== "curve") return expect.unreachable();
    // The curve's own quote fields survive the tagging: `graduates` and
    // `refund` have no pool analogue and are why the union is discriminated.
    expect(quote.tokensOut.toString()).toBe("777");
    expect(quote.graduates).toBe(false);
    expect(quote.refund.isZero()).toBe(true);
  });

  it("re-reads the venue while it is a curve, and stops once it is a pool", async () => {
    // Migration happens once and never reverses, so "pool" is cacheable
    // forever. "curve" is not: a token can graduate in the next block, and a
    // cached "curve" would send a buy to a curve that has stopped trading.
    const curveCalls: string[] = [];
    const stillOnCurve = clientFor(onCurve, curveCalls).trade(TOKEN);
    await stillOnCurve.venue();
    await stillOnCurve.venue();
    expect(curveCalls.filter((name) => name === "migratedPool")).toHaveLength(2);

    const poolCalls: string[] = [];
    const graduated = clientFor(onPool, poolCalls).trade(TOKEN);
    await graduated.venue();
    await graduated.venue();
    expect(poolCalls.filter((name) => name === "migratedPool")).toHaveLength(1);
  });

  it("refuses a recipient on a curve trade rather than paying somebody else", async () => {
    const client = clientFor(onCurve, [], SIGNER);
    try {
      await client.trade(TOKEN).buy({
        quoteIn: Usdc.parse("1"),
        minTokensOut: Tokens.ZERO,
        deadline: Deadline.inMinutes(5),
        recipient: "0x2222222222222222222222222222222222222222",
      });
      expect.unreachable("a curve pays msg.sender and has no recipient argument");
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toMatch(/pool-only/);
      expect(error.details.venue).toBe("curve");
    }
  });

  it("refuses a referrer on a pool trade rather than promising a share", async () => {
    const client = clientFor(onPool, [], SIGNER);
    try {
      await client.trade(TOKEN).buy({
        quoteIn: Usdc.parse("1"),
        minTokensOut: Tokens.ZERO,
        deadline: Deadline.inMinutes(5),
        referrer: "0x2222222222222222222222222222222222222222",
      });
      expect.unreachable("a pool swap has no referrer argument");
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toMatch(/curve-only/);
      expect(error.message).toMatch(/hookData/);
      expect(error.details.refused).toEqual(["referrer"]);
    }
  });

  it("names every curve-only option it refused, not just the first", async () => {
    const client = clientFor(onPool, [], SIGNER);
    try {
      await client.trade(TOKEN).buy({
        quoteIn: Usdc.parse("1"),
        minTokensOut: Tokens.ZERO,
        deadline: Deadline.inMinutes(5),
        referrer: "0x2222222222222222222222222222222222222222",
        gasLimit: 8_000_000n,
      });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.details.refused).toEqual(["referrer", "gasLimit"]);
    }
  });

  it("still refuses a write with no signer, before any of that", async () => {
    try {
      await clientFor(onPool).pool(TOKEN).approveRouter(Tokens.parse("1"));
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("ReadOnlyClient");
      expect(error.message).toContain("pool.approveRouter");
    }
  });
});

/* -------------------------------------------------------------------------- *
 * The fee hook's version
 * -------------------------------------------------------------------------- */

describe("the fee hook's version", () => {
  const graduated: Script = { migratedPool: OURS, poolManager: OURS };
  const SIGNER: Address = "0x00000000000000000000000000000000000000c0";

  it("reads the accrued fee of an arcnow/arc-now-fee-hook@4.x.x hook", async () => {
    const calls: string[] = [];
    const fee = await clientFor(graduated, calls).pool(TOKEN).accruedHookFee();
    expect(fee.wad).toBe(12_345n);
    expect(calls).toContain("accruedFee");
  });

  it("reads the hook's own rate off the hook: 80 bps, the pool's fee and not the curve's", async () => {
    const calls: string[] = [];
    const pool = clientFor(graduated, calls).pool(TOKEN);
    const rate = await pool.hookFeeBps();
    expect(rate.bps).toBe(80n);
    expect(rate.bps).toBe(POOL_TRADE_FEE_BPS);
    expect(calls).toContain("feeBps");
  });

  it("reads the pool's own split off the hook: creator 5000 / platform 1875 / protocol 3125, no referrer", async () => {
    const calls: string[] = [];
    const pool = clientFor(graduated, calls).pool(TOKEN);
    const config = await pool.feeConfig();
    expect(config.creatorShareBps.bps).toBe(5_000n);
    expect(config.platformShareBps.bps).toBe(1_875n);
    expect(config.refShareBps.bps).toBe(0n);
    expect(config.protocolShareBps.bps).toBe(3_125n);
    expect(config.platformRecipient.toLowerCase()).toBe(SIGNER_PLATFORM);
    expect(config.protocolRecipient.toLowerCase()).toBe(SIGNER_PROTOCOL);
    expect(config).not.toHaveProperty("devShareBps");
    expect(calls).toContain("feeConfigOf");
  });

  it("describes what a migrated trade costs: the hook's 0.80% plus the key's 0.20% LP fee", async () => {
    const pool = clientFor(graduated, []).pool(TOKEN);
    const fees = await pool.fees();
    expect(fees.hookFeeBps.bps).toBe(80n);
    expect(fees.lpFeePips).toBe(POOL_LP_FEE_PIPS);
    expect(fees.totalBps.bps).toBe(TRADE_FEE_BPS);
    expect((await pool.key()).fee).toBe(2000);
  });

  it("refuses a hook of the retired 3.x stack by name", async () => {
    const client = clientFor({ ...graduated, hookVersion: "arcnow/arc-now-fee-hook@3.0.0" }, [], SIGNER);
    try {
      await client.pool(TOKEN).accruedHookFee();
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("UnknownHookVersion");
      expect(error.message).toMatch(/retired multi-quote/);
      expect(error.message).toContain("arcnow/arc-now-fee-hook@4.x.x");
    }
  });

  it.each([
    "arcnow/arc-now-fee-hook@1.0.0",
    "arcnow/arc-now-fee-hook@2.0.0",
    "arcnow/arc-now-fee-hook@3",
    "UniswapV4Hook",
  ])("refuses a hook answering %j with UnknownHookVersion, before reading or sending", async (version) => {
    const calls: string[] = [];
    const client = clientFor({ ...graduated, hookVersion: version }, calls, SIGNER);
    for (const [name, attempt] of [
      ["accruedHookFee", () => client.pool(TOKEN).accruedHookFee()],
      ["distributeHookFees", () => client.pool(TOKEN).distributeHookFees()],
    ] as [string, () => Promise<unknown>][]) {
      try {
        await attempt();
        expect.unreachable(`${name} must refuse ${version}`);
      } catch (error) {
        if (!isArcNowError(error)) throw error;
        expect(error.code, name).toBe("UnknownHookVersion");
        expect(error.details.version, name).toBe(version);
        expect(String(error.details.hook).toLowerCase(), name).toBe(HOOK_ADDRESS);
        expect(error.message, name).not.toMatch(/version-1|in-swap/i);
      }
    }
    expect(calls).not.toContain("accruedFee");
    expect(calls).not.toContain("distributeFees");
  });
});

/* -------------------------------------------------------------------------- *
 * A fill, read out of its own receipt
 * -------------------------------------------------------------------------- */

describe("reading a native-quoted pool fill out of its receipt", () => {
  const MANAGER: Address = "0x06110b57dd9b82DD846ee0325fB81B284E1C6dD0";
  const HOOK: Address = "0x4A4602b14F798F08d81fA33b77a4AdBfd1CB20CC";
  const TOKEN_ADDRESS: Address = "0x00000000000000000000000000000000000000b7";
  const POOL_ID: Hex = `0x${"cd".repeat(32)}`;
  const OTHER_POOL_ID: Hex = `0x${"ab".repeat(32)}`;
  const HASH: Hex = `0x${"ef".repeat(32)}`;
  const where = (side: "buy" | "sell") =>
    ({
      side, poolManager: MANAGER, hook: HOOK, poolId: POOL_ID, hash: HASH,
      quoteToken: NATIVE_USDC, quoteIsCurrency0: true,
    }) as const;

  /** Encode one event the way a node would hand it back in a receipt. */
  function logOf(
    address: Address,
    abi: Abi,
    eventName: string,
    args: Record<string, unknown>,
  ): Log {
    const item = abi.find((entry): entry is AbiEvent =>
      entry.type === "event" && entry.name === eventName);
    if (item === undefined) throw new Error(`no event ${eventName}`);
    const topics = encodeEventTopics({ abi: [item], eventName, args });
    const unindexed = item.inputs.filter((input) => input.indexed !== true);
    const data = encodeAbiParameters(
      unindexed,
      unindexed.map((input) => args[input.name ?? ""]),
    );
    return {
      address,
      topics: topics as [Hex, ...Hex[]],
      data,
      blockHash: `0x${"00".repeat(32)}`,
      blockNumber: 1n,
      logIndex: 0,
      transactionHash: HASH,
      transactionIndex: 0,
      removed: false,
    };
  }

  const ROUTER_AS_SENDER: Address = "0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e";

  function swap(amount0: bigint, amount1: bigint, id: Hex = POOL_ID, at: Address = MANAGER): Log {
    return logOf(at, poolManagerSwapEventAbi, "Swap", {
      id,
      sender: ROUTER_AS_SENDER,
      amount0,
      amount1,
      sqrtPriceX96: 5_591_840_213_126_229_927_066_759_898_408n,
      liquidity: 3_598_610_843_089_325_200_392n,
      tick: 85_138,
      fee: 3_000,
    });
  }

  function feeTaken(
    feeWad: bigint,
    onInput: boolean,
    poolId: Hex = POOL_ID,
    at: Address = HOOK,
  ): Log {
    return logOf(at, arcNowFeeHookAbi, "HookFeeTaken", {
      poolId,
      token: TOKEN_ADDRESS,
      // Always the router: whoever called PoolManager.swap. Never the trader.
      payer: ROUTER_AS_SENDER,
      currency: "0x0000000000000000000000000000000000000000",
      feeAmount: feeWad,
      onInput,
    });
  }

  it("decodes v4-core's own Swap event, topic for topic", () => {
    // The keccak256 of Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24),
    // as emitted by the PoolManager at 0x06110b57... on every swap.
    expect(toEventSelector(poolManagerSwapEventAbi[0]))
      .toBe("0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
  });

  it("reads a buy exactly: Swap.amount0 is the pool's leg, the hook's fee is on top", () => {
    // The trader sent 1 USDC; the hook took 0.008 in beforeSwap, so the pool
    // swapped 0.992, and the Swap log -- emitted before afterSwap folds the
    // hook's delta back in -- says -0.992.
    const logs = [
      feeTaken(8_000_000_000_000_000n, true),
      swap(-992_000_000_000_000_000n, 5_013_839_205_774_463_870_681n),
    ];
    const fill = quoteFillFromLogs(logs, where("buy"));
    expect(fill.quote.wad).toBe(1_000_000_000_000_000_000n);
    expect(fill.feeQuote.wad).toBe(8_000_000_000_000_000n);
  });

  it("reads a sell exactly where the fee alone can only bound it", () => {
    // A gross of 12,624 wei: the hook takes floor(12,624 * 80 / 10,000) = 100
    // and the trader receives 12,524. From the fee alone, 100 * 124 = 12,400 --
    // 124 wei short, which is the defect this function replaces.
    const logs = [swap(12_624n, -7n * 10n ** 18n), feeTaken(100n, false)];
    const fill = quoteFillFromLogs(logs, where("sell"));
    expect(fill.quote.wad).toBe(12_524n);
    expect(fill.feeQuote.wad).toBe(100n);
    expect(sellQuoteOutFromFee(Usdc.fromWad(100n)).wad).toBe(12_400n);
  });

  it("reads a buy too small to be charged: no HookFeeTaken at all, and still exact", () => {
    const fill = quoteFillFromLogs([swap(-99n, 496_000n)], where("buy"));
    expect(fill.quote.wad).toBe(99n);
    expect(fill.feeQuote.isZero()).toBe(true);
  });

  it("reads a sell too small to be charged, exactly", () => {
    const fill = quoteFillFromLogs([swap(42n, -200_000n)], where("sell"));
    expect(fill.quote.wad).toBe(42n);
    expect(fill.feeQuote.isZero()).toBe(true);
  });

  it("ignores another pool's logs, and a Swap or HookFeeTaken from the wrong address", () => {
    const logs = [
      swap(-5n * 10n ** 18n, 1n, OTHER_POOL_ID),
      feeTaken(7n * 10n ** 16n, true, OTHER_POOL_ID),
      // The right pool id, emitted by something that is not the manager/hook.
      swap(-3n * 10n ** 18n, 1n, POOL_ID, TOKEN_ADDRESS),
      feeTaken(9n * 10n ** 16n, true, POOL_ID, TOKEN_ADDRESS),
      feeTaken(10_000_000_000_000_000n, true),
      swap(-990_000_000_000_000_000n, 5n),
    ];
    const fill = quoteFillFromLogs(logs, where("buy"));
    expect(fill.quote.wad).toBe(1_000_000_000_000_000_000n);
    expect(fill.feeQuote.wad).toBe(10_000_000_000_000_000n);
  });

  it("refuses a receipt with no Swap for this pool rather than reporting zero", () => {
    expect(() => quoteFillFromLogs([feeTaken(1n, true)], where("buy"))).toThrow(/Swap/);
    try {
      quoteFillFromLogs([], where("sell"));
      expect.unreachable();
    } catch (error) {
      expect(isArcNowError(error) && error.code).toBe("RpcFailure");
    }
  });

  it("refuses a USDC leg whose sign contradicts the side it was read for", () => {
    expect(() => quoteFillFromLogs([swap(10n ** 18n, -1n)], where("buy"))).toThrow(/buy/);
    expect(() => quoteFillFromLogs([swap(-(10n ** 18n), 1n)], where("sell"))).toThrow(/sell/);
  });
});
