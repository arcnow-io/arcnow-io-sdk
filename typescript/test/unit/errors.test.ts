/**
 * Error decoding: every selector in every ABI, the three non-custom revert
 * shapes, and the tone of the messages.
 *
 * None of this needs a chain. Revert data is just bytes, and the whole point of
 * the registry is that it can decode them without having asked anybody.
 */

import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";

import * as abis from "../../src/generated/abi/index.js";
import { arcNowFeeHookAbi } from "../../src/generated/abi/index.js";
import { v4CoreErrorsAbi } from "../../src/errors/registry.js";
import { bondingCurveAbi, launchpadAbi, platformRegistryAbi } from "../../src/generated/abi/index.js";
import { Usdc } from "../../src/amounts.js";
import {
  decodeRevertData,
  ERROR_REGISTRY,
  errorSignature,
  lookupSelector,
  mapError,
  selectorOf,
} from "../../src/errors/index.js";
import { authoredErrorKeys } from "../../src/errors/messages.js";

/**
 * A revert exactly as viem surfaces one.
 *
 * The real `ContractFunctionRevertedError`, not a stand-in: the mapper's whole
 * job is to go *through* viem's error rather than around it, and a fake would
 * test the wrong path. The ABI passed here is the curve's, so an error declared
 * on some other contract arrives the way it really would — undecodable by the
 * ABI of the contract that was called, and decodable only by the registry.
 */
function revertWith(data: `0x${string}`): unknown {
  return new ContractFunctionRevertedError({
    abi: bondingCurveAbi,
    data,
    functionName: "buy",
  });
}

describe("the selector registry", () => {
  it("covers every custom error in every pinned ABI", () => {
    let declared = 0;
    for (const abi of Object.values(abis)) {
      if (!Array.isArray(abi)) continue;
      for (const item of abi as readonly { type: string; name?: string }[]) {
        if (item.type !== "error") continue;
        declared += 1;
        const signature = errorSignature(item as never);
        const found = lookupSelector(selectorOf(signature));
        expect(found, `no registry entry for ${signature}`).toBeDefined();
        expect(found?.signature).toBe(signature);
      }
    }
    // 79 distinct signatures across arcnow.io's 13 ABIs, plus Error(string) and
    // Panic(uint256), plus the 7 UniswapV4Router04 declares -- the router is
    // pinned too, and it is the WHOLE post-graduation trading path, so a
    // slippage floor missed on a pool trade has to decode by name rather than
    // arrive as a hex blob.
    expect(declared).toBeGreaterThan(100); // many are declared on several contracts
    // 103 distinct entries from the pinned multi-quote ABIs — the version-2 set's
    // 88 plus the 15 quote-token errors of contracts#22 (WrongQuotePath,
    // QuoteAmountNotRepresentable, QuoteTransferShortfall, the registry's seven,
    // the launchpad's four, the migrators' QuoteNotSupported/QuoteAmountMismatch,
    // NoCurveParameters) — + Error(string) and Panic(uint256) + v4's WrappedError
    // and HookCallFailed, which arrive inside every failing hook call, + v4-core's
    // NativeTransferFailed and ERC20TransferFailed, which name the layer a failed
    // transfer out of the PoolManager adds.
    expect(ERROR_REGISTRY.size).toBe(108);
  });

  it("keeps two errors that share a name but not a signature apart", () => {
    // BondingCurve's NothingToWithdraw() and ArcNowFeeHook's
    // NothingToWithdraw(address) are different selectors and different advice.
    const bare = lookupSelector(selectorOf("NothingToWithdraw()"));
    const withAccount = lookupSelector(selectorOf("NothingToWithdraw(address)"));
    expect(bare?.signature).toBe("NothingToWithdraw()");
    expect(withAccount?.signature).toBe("NothingToWithdraw(address)");
    expect(bare?.signature).not.toBe(withAccount?.signature);
  });

  it("records every contract an error is declared on", () => {
    // ZeroAddress is on almost all of them; solc folds inherited errors in.
    const zeroAddress = lookupSelector(selectorOf("ZeroAddress()"));
    expect(zeroAddress?.sources.length).toBeGreaterThan(5);
  });

  it("computes selectors the same way solc does", () => {
    // Cross-checked against viem's own encoder rather than against itself.
    const encoded = encodeErrorResult({ abi: bondingCurveAbi, errorName: "CurveGraduated" });
    expect(encoded.slice(0, 10)).toBe(selectorOf("CurveGraduated()"));
  });
});

describe("decoding a revert", () => {
  it("decodes a custom error's parameters by name", () => {
    const data = encodeErrorResult({
      abi: bondingCurveAbi,
      errorName: "SlippageExceeded",
      args: [1_000n, 900n],
    });
    const decoded = decodeRevertData(data);
    expect(decoded.error?.name).toBe("SlippageExceeded");
    expect(decoded.args).toEqual({ minOutWad: 1_000n, actualOutWad: 900n });
    expect(decoded.positionalArgs).toEqual([1_000n, 900n]);
  });

  it("decodes an error thrown by a DIFFERENT contract than the one being called", () => {
    // A curve call that bubbles a registry error. The one-table-across-all-ABIs
    // design is what makes this work; a curve-only ABI could not name it.
    const data = encodeErrorResult({
      abi: platformRegistryAbi,
      errorName: "NotProtocolAdmin",
      args: ["0x1111111111111111111111111111111111111111"],
    });
    const mapped = mapError(revertWith(data), { functionName: "curve.buy" });
    expect(mapped.code).toBe("NotProtocolAdmin");
  });

  it("never throws on rubbish", () => {
    expect(decodeRevertData("0x").error).toBeUndefined();
    expect(decodeRevertData("0xdeadbeef").selector).toBe("0xdeadbeef");
    // A known selector with unparseable parameters still names the error.
    const truncated = `${selectorOf("SlippageExceeded(uint256,uint256)")}00` as `0x${string}`;
    expect(decodeRevertData(truncated).error?.name).toBe("SlippageExceeded");
  });
});

describe("mapping to ArcNowError", () => {
  it("is idempotent — an ArcNowError passes straight through", () => {
    const first = mapError(revertWith(
      encodeErrorResult({ abi: bondingCurveAbi, errorName: "CurveGraduated" }),
    ));
    expect(mapError(first)).toBe(first);
  });

  it("handles Error(string)", () => {
    const data = `${selectorOf("Error(string)")}${encodeAbiParameters(
      [{ type: "string" }],
      ["not enough liquidity"],
    ).slice(2)}` as `0x${string}`;
    const mapped = mapError(revertWith(data));
    expect(mapped.code).toBe("RevertString");
    expect(mapped.message).toContain("not enough liquidity");
    // And says that this cannot have come from an arcnow.io contract.
    expect(mapped.message).toMatch(/No arcnow\.io contract throws a string/);
    expect(mapped.details.reason).toBe("not enough liquidity");
  });

  it("handles Panic(uint256) and explains the code", () => {
    const data = `${selectorOf("Panic(uint256)")}${encodeAbiParameters(
      [{ type: "uint256" }],
      [0x11n],
    ).slice(2)}` as `0x${string}`;
    const mapped = mapError(revertWith(data));
    expect(mapped.code).toBe("Panic");
    expect(mapped.message).toContain("0x11");
    expect(mapped.message).toContain("arithmetic overflowed or underflowed");
    expect(mapped.message).toMatch(/a bug rather than a rejection/);
  });

  it("handles empty revert data and names the three usual causes", () => {
    const mapped = mapError(revertWith("0x"));
    expect(mapped.code).toBe("EmptyRevert");
    expect(mapped.message).toMatch(/ran out of gas/);
    expect(mapped.message).toMatch(/no code on it/);
  });

  it("handles a selector in none of the ABIs, plainly", () => {
    const mapped = mapError(revertWith("0xdeadbeef00000000"));
    expect(mapped.code).toBe("UnknownRevert");
    expect(mapped.message).toContain("0xdeadbeef");
    // Never a bare hex blob with no framing.
    expect(mapped.message).toMatch(/openchain\.xyz/);
    expect(mapped.selector).toBe("0xdeadbeef");
  });

  it("falls back to RpcFailure for something that never reached a contract", () => {
    const mapped = mapError(new Error("fetch failed"), { functionName: "curve.state" });
    expect(mapped.code).toBe("RpcFailure");
    expect(mapped.message).toContain("fetch failed");
    expect(mapped.message).toContain("curve.state");
    expect(mapped.isRevert).toBe(false);
  });
});

describe("the messages say what to do", () => {
  it("IncorrectPayment names the exact cost and the two charges", () => {
    const data = encodeErrorResult({
      abi: launchpadAbi,
      errorName: "IncorrectPayment",
      args: [7n * 10n ** 18n, 5n * 10n ** 18n],
    });
    const mapped = mapError(revertWith(data), {
      launchFee: Usdc.fromWhole(2n),
      initialBuy: Usdc.fromWhole(5n),
    });
    expect(mapped.code).toBe("IncorrectPayment");
    expect(mapped.message).toContain("exactly 7 USDC");
    expect(mapped.message).toContain("2 fee + 5 initial buy");
    expect(mapped.message).toMatch(/not at-least/);
    expect(mapped.message).toMatch(/will not strand your change/);
    // The raw numbers stay available for a UI to render itself.
    expect(mapped.args.expectedWad).toBe(7n * 10n ** 18n);
  });

  it("CurveGraduated sends the caller to the graduation venue", () => {
    const mapped = mapError(revertWith(
      encodeErrorResult({ abi: bondingCurveAbi, errorName: "CurveGraduated" }),
    ));
    expect(mapped.message).toMatch(/stopped trading permanently/);
    expect(mapped.message).toMatch(/curve\.state\(\)\.migrator/);
    // And it points at the curve's own target rather than reciting one.
    expect(mapped.message).toMatch(/curve\.state\(\)\.target/);
  });

  it("CurveGraduated quotes NO graduation figure, because there is no such constant", () => {
    // A REGRESSION TEST WITH A HISTORY. This message used to read "(50,000 USDC on
    // the shipped template)". A graduation target is not a protocol constant: it is
    // per-platform, settable by that platform's admin, and snapshotted onto each
    // curve at launch, so a curve keeps whatever was live when it launched. When
    // arcnow.io's platform moved from a 50,000 USDC target to 50, this sentence was
    // shown to users wrong by a factor of 1000 -- and the unit test that asserted
    // the old string went on passing, because it was checking the message against
    // itself.
    //
    // So the rule is stronger than "say 50": say no number at all. Any digit group
    // here is a figure that can go stale in somebody else's transaction.
    const mapped = mapError(revertWith(
      encodeErrorResult({ abi: bondingCurveAbi, errorName: "CurveGraduated" }),
    ));
    expect(mapped.message).not.toMatch(/\d/);
  });

  it("SlippageExceeded says the price rises across your own order", () => {
    const mapped = mapError(revertWith(encodeErrorResult({
      abi: bondingCurveAbi,
      errorName: "SlippageExceeded",
      args: [1_000n, 900n],
    })));
    expect(mapped.message).toMatch(/Re-quote and retry/);
    expect(mapped.message).toMatch(/rises across your own order/);
    expect(mapped.message).toMatch(/zero on a public mempool is a donation/i);
  });

  it("SlippageExceeded never guesses a unit for its two amounts", () => {
    // Both amounts are tokens on a buy and USDC on a sell, and the revert data
    // says nothing about which. Labelling them wrongly would be worse than not
    // labelling them, because it looks answered.
    const data = encodeErrorResult({
      abi: bondingCurveAbi,
      errorName: "SlippageExceeded",
      args: [1_000n, 900n],
    });

    const unknownSide = mapError(revertWith(data));
    expect(unknownSide.message).toMatch(/tokens on a buy, USDC on a sell/);
    expect(unknownSide.message).toMatch(/does not say which/);
    // The raw integers, not a rendered decimal figure in either denomination.
    expect(unknownSide.message).toContain("900");
    expect(unknownSide.message).not.toMatch(/900 USDC/);

    expect(mapError(revertWith(data), { functionName: "buy" }).message)
      .toMatch(/token amounts, 18 decimals: this was a buy/);
    expect(mapError(revertWith(data), { functionName: "sell" }).message)
      .toMatch(/USDC amounts, 18 decimals: this was a sell/);

    // And the numbers stay on args either way, for a caller who does know.
    expect(unknownSide.args.minOutWad).toBe(1_000n);
    expect(unknownSide.args.actualOutWad).toBe(900n);
  });

  it("InsufficientTokenBalance says no approval is involved", () => {
    // The single most important sentence in this table: a caller who reaches
    // for approve() here is fixing the wrong thing.
    const mapped = mapError(revertWith(encodeErrorResult({
      abi: bondingCurveAbi,
      errorName: "InsufficientTokenBalance",
      args: ["0x1111111111111111111111111111111111111111", 5n * 10n ** 18n, 9n * 10n ** 18n],
    })));
    expect(mapped.message).toMatch(/No approval is involved/i);
    expect(mapped.message).toMatch(/reads no allowance at all/);
    expect(mapped.message).toMatch(/fixing the wrong thing/);
  });

  it("NotProtocolAdmin says which role was needed and that registration is admin-only", () => {
    const mapped = mapError(revertWith(encodeErrorResult({
      abi: platformRegistryAbi,
      errorName: "NotProtocolAdmin",
      args: ["0x1111111111111111111111111111111111111111"],
    })));
    expect(mapped.message).toMatch(/protocolAdmin/);
    expect(mapped.message).toMatch(/most likely surprise/);
    expect(mapped.message).toMatch(/Launch under an existing platform/);
  });

  it("PlatformNotRegistered says the check is at inclusion, not at signing", () => {
    const mapped = mapError(revertWith(encodeErrorResult({
      abi: launchpadAbi,
      errorName: "PlatformNotRegistered",
      args: ["0x2222222222222222222222222222222222222222"],
    })));
    expect(mapped.message).toContain("0x2222222222222222222222222222222222222222");
    expect(mapped.message).toMatch(/at inclusion, not at signing/);
  });

  it("DeadlineExpired says the transaction sat too long", () => {
    const mapped = mapError(revertWith(encodeErrorResult({
      abi: bondingCurveAbi,
      errorName: "DeadlineExpired",
      args: [1_700_000_000n, 1_700_000_600n],
    })));
    expect(mapped.message).toMatch(/sat too long/);
    expect(mapped.message).toMatch(/Deadline\.inMinutes/);
  });

  it("AlreadyMigrated reassures rather than alarms", () => {
    const mapped = mapError(revertWith(
      encodeErrorResult({ abi: bondingCurveAbi, errorName: "AlreadyMigrated" }),
    ));
    expect(mapped.message).toMatch(/normal and good outcome/);
    expect(mapped.message).toMatch(/retry path, not the normal one/);
    expect(mapped.message).toMatch(/Nothing to do/);
  });

  it("has advice written for every error a curve, a launchpad or a registry can throw", () => {
    const authored = new Set(authoredErrorKeys());
    const core = [bondingCurveAbi, launchpadAbi, platformRegistryAbi];
    const unadvised: string[] = [];
    for (const abi of core) {
      for (const item of abi as readonly { type: string; name?: string }[]) {
        if (item.type !== "error" || !item.name) continue;
        const signature = errorSignature(item as never);
        if (!authored.has(item.name) && !authored.has(signature)) unadvised.push(signature);
      }
    }
    expect(unadvised).toEqual([]);
  });

  it("falls back honestly rather than inventing advice it does not have", () => {
    // Every error in the core ABIs is authored, so this exercises the fallback
    // with a real-but-peripheral one from a migrator.
    const data = encodeErrorResult({
      abi: abis.uniswapV4MigratorAbi,
      errorName: "NotUnlocking",
    });
    const mapped = mapError(revertWith(data));
    expect(mapped.code).toBe("NotUnlocking");
    expect(mapped.message).toMatch(/unlock callback/);
  });
});

describe("the curve's own template and reserve errors", () => {
  it("decodes CurveNotPriceable with y0Wad for its second word, and says what it is", () => {
    const data = encodeErrorResult({
      abi: abis.platformConfigAbi,
      errorName: "CurveNotPriceable",
      args: [7n, 9n],
    });
    const mapped = mapError(revertWith(data));
    expect(mapped.code).toBe("CurveNotPriceable");
    expect(mapped.args).toEqual({ curveSupplyWad: 7n, y0Wad: 9n });
    expect(mapped.message).toMatch(/y0Wad/);
    expect(mapped.message).not.toMatch(/kWad|linear|version-1/i);
  });

  it("does not know the retired linear curve's InvalidK: no pinned ABI declares it", () => {
    expect(lookupSelector(selectorOf("InvalidK()"))).toBeUndefined();
  });

  it("decodes InsufficientTokenReserve, which only version 2 declares", () => {
    const data = encodeErrorResult({
      abi: bondingCurveAbi,
      errorName: "InsufficientTokenReserve",
      args: [10n, 11n],
    });
    const mapped = mapError(revertWith(data));
    expect(mapped.code).toBe("InsufficientTokenReserve");
    expect(mapped.args).toEqual({ tokenReserveWad: 10n, tokensOutWad: 11n });
  });
});

describe("Uniswap v4's WrappedError", () => {
  const HOOK = "0x4a4602b14f798f08d81fa33b77a4adbfd1cb20cc" as const;
  const beforeSwap = toFunctionSelector(
    arcNowFeeHookAbi.find((item) => item.type === "function" && item.name === "beforeSwap") as never,
  );
  const hookCallFailed = selectorOf("HookCallFailed()");
  const wrap = (reason: `0x${string}`, target: `0x${string}` = HOOK): `0x${string}` =>
    encodeErrorResult({
      abi: v4CoreErrorsAbi,
      errorName: "WrappedError",
      args: [target, beforeSwap, reason, hookCallFailed],
    });

  it("is 0x90bfb865", () => {
    expect(selectorOf("WrappedError(address,bytes4,bytes,bytes)")).toBe("0x90bfb865");
    expect(wrap("0x").slice(0, 10)).toBe("0x90bfb865");
  });

  it("unwraps into the inner custom error, keeping where it was wrapped", () => {
    const inner = encodeErrorResult({
      abi: arcNowFeeHookAbi,
      errorName: "PoolNotRegistered",
      args: ["0x1111111111111111111111111111111111111111111111111111111111111111"],
    });
    const mapped = mapError(revertWith(wrap(inner)));
    expect(mapped.code).toBe("PoolNotRegistered");
    expect(mapped.args.poolId).toBe("0x1111111111111111111111111111111111111111111111111111111111111111");
    expect(mapped.message).toMatch(/inside a Uniswap v4 call — beforeSwap on 0x4a4602b1/i);
    expect(mapped.message).toMatch(/HookCallFailed/);
    const layers = mapped.details.wrappedBy as {
      target: string;
      selector: string;
      selectorName?: string;
    }[];
    expect(layers).toHaveLength(1);
    expect(layers[0]?.target.toLowerCase()).toBe(HOOK);
    expect(layers[0]?.selector).toBe(beforeSwap);
    expect(layers[0]?.selectorName).toBe("beforeSwap");
    expect(mapped.details.wrappedData).toBe(wrap(inner));
  });

  it("unwraps nested layers, outermost first, down to an Error(string)", () => {
    const inner = `${selectorOf("Error(string)")}${encodeAbiParameters(
      [{ type: "string" }],
      ["no"],
    ).slice(2)}` as `0x${string}`;
    const outerTarget = "0x2222222222222222222222222222222222222222" as const;
    const mapped = mapError(revertWith(wrap(wrap(inner), outerTarget)));
    expect(mapped.code).toBe("RevertString");
    expect(mapped.details.reason).toBe("no");
    const layers = mapped.details.wrappedBy as { target: string }[];
    expect(layers.map((layer) => layer.target.toLowerCase())).toEqual([outerTarget, HOOK]);
  });

  it("unwraps a Panic", () => {
    const inner = `${selectorOf("Panic(uint256)")}${encodeAbiParameters(
      [{ type: "uint256" }],
      [0x11n],
    ).slice(2)}` as `0x${string}`;
    expect(mapError(revertWith(wrap(inner))).code).toBe("Panic");
  });

  it("is WrappedRevert when the inner reason is unknown, with every field kept", () => {
    const mapped = mapError(revertWith(wrap("0xdeadbeef")));
    expect(mapped.code).toBe("WrappedRevert");
    expect(mapped.details.reason).toBe("0xdeadbeef");
    expect(String(mapped.details.target).toLowerCase()).toBe(HOOK);
    expect(mapped.details.selector).toBe(beforeSwap);
    expect(mapped.details.details).toBe(hookCallFailed);
    expect(mapped.message).toContain("0xdeadbeef");
  });

  it("is WrappedRevert when the inner reason is empty", () => {
    const mapped = mapError(revertWith(wrap("0x")));
    expect(mapped.code).toBe("WrappedRevert");
    expect(mapped.details.reason).toBe("0x");
    expect(mapped.message).toMatch(/no data at all/);
  });
});

describe("a WrappedError inside a WrappedError: a hook call wrapping a failed native transfer", () => {
  // A made-up hook address. The bytes are built the way v4-core builds them:
  // Hooks.callHook wraps a reverting callback as
  // WrappedError(hook, <callback selector>, reason, HookCallFailed()), and
  // Currency.transfer wraps a failed native transfer inside that callback as
  // WrappedError(to, bytes4(0), reason, NativeTransferFailed()).
  const HOOK = "0x00000000000000000000000000000000000020cc";
  const nativeTransferFailed = encodeErrorResult({
    abi: v4CoreErrorsAbi, errorName: "NativeTransferFailed",
  });
  const hookCallFailed = encodeErrorResult({ abi: v4CoreErrorsAbi, errorName: "HookCallFailed" });
  const inner = encodeErrorResult({
    abi: v4CoreErrorsAbi,
    errorName: "WrappedError",
    args: [HOOK, "0x00000000", "0x", nativeTransferFailed],
  });
  const NESTED = encodeErrorResult({
    abi: v4CoreErrorsAbi,
    errorName: "WrappedError",
    args: [HOOK, "0x575e24b4", inner, hookCallFailed],
  });

  it("is two genuine layers: beforeSwap failed because a native transfer to the hook failed", () => {
    const mapped = mapError(revertWith(NESTED));
    expect(mapped.code).toBe("WrappedRevert");
    expect(mapped.data).toBe(NESTED);
    expect(mapped.details.reason).toBe("0x");
    const layers = mapped.details.wrappedBy as {
      target: string;
      selector: string;
      selectorName?: string;
      details: string;
      detailsName?: string;
    }[];
    expect(layers).toHaveLength(2);
    // The PoolManager's call to the hook's beforeSwap reverted...
    expect(layers[0]?.target.toLowerCase()).toBe(HOOK);
    expect(layers[0]?.selector).toBe("0x575e24b4");
    expect(layers[0]?.selectorName).toBe("beforeSwap");
    expect(layers[0]?.detailsName).toBe("HookCallFailed");
    // ...because inside it, v4-core's Currency.transfer of native USDC to the
    // hook failed: bubbleUpAndRevertWith(to, bytes4(0), NativeTransferFailed).
    // Selector zero is v4's own marker for a native transfer, not padding.
    expect(layers[1]?.target.toLowerCase()).toBe(HOOK);
    expect(layers[1]?.selector).toBe("0x00000000");
    expect(layers[1]?.selectorName).toBe("native transfer");
    expect(layers[1]?.details).toBe("0xf4b3b1bc");
    expect(layers[1]?.detailsName).toBe("NativeTransferFailed");
    expect(mapped.message).toMatch(new RegExp(`PoolManager could not pay native USDC to ${HOOK}`, "i"));
    expect(mapped.message).not.toMatch(/version-1|@1\./);
  });

  it("names an ERC-20 transfer the same way", () => {
    const erc20Failed = encodeErrorResult({ abi: v4CoreErrorsAbi, errorName: "ERC20TransferFailed" });
    const data = encodeErrorResult({
      abi: v4CoreErrorsAbi,
      errorName: "WrappedError",
      args: ["0x3600000000000000000000000000000000000000", "0xa9059cbb", "0x", erc20Failed],
    });
    const layers = mapError(revertWith(data)).details.wrappedBy as {
      selectorName?: string; detailsName?: string;
    }[];
    expect(layers[0]?.selectorName).toBe("ERC-20 transfer");
    expect(layers[0]?.detailsName).toBe("ERC20TransferFailed");
  });
});
