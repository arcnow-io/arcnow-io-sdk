/**
 * What a network can be quoted in, read from `networks.json` with no RPC.
 *
 * The list is metadata, not the allowlist: symbol, name and decimals, so an
 * amount can be labelled and scaled without a round trip. Whether the registry
 * accepts a quote is the registry's answer.
 */

import { describe, expect, it } from "vitest";

import { NATIVE_USDC } from "../../src/amounts.js";
import { isArcNowError } from "../../src/errors/index.js";
import { findQuoteToken, rawNetwork, resolveNetwork } from "../../src/networks.js";

const contracts = {
  launchpad: "0x1111111111111111111111111111111111111111",
  tokenFactory: "0x2222222222222222222222222222222222222222",
  curveFactory: "0x3333333333333333333333333333333333333333",
  migratorRegistry: "0x4444444444444444444444444444444444444444",
  platformRegistry: "0x5555555555555555555555555555555555555555",
  arcnowPlatform: "0x6666666666666666666666666666666666666666",
} as const;

describe("arc-testnet's quote tokens", () => {
  const config = resolveNetwork("arc-testnet");

  it("are native USDC and EURC, in the order networks.json lists them", () => {
    expect(config.quoteTokens).toEqual([
      NATIVE_USDC,
      {
        address: "0x89b50855aa3be2f677cd6303cec089b5f319d72a",
        symbol: "EURC",
        name: "EURC",
        decimals: 6,
        isNative: false,
      },
    ]);
  });

  it("are found by address, whatever its case, and nothing else is", () => {
    expect(findQuoteToken(config, "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")?.symbol).toBe("EURC");
    expect(findQuoteToken(config, "0x0000000000000000000000000000000000000000")).toEqual(NATIVE_USDC);
    expect(findQuoteToken(config, "0x3600000000000000000000000000000000000000")).toBeUndefined();
  });

  it("records the deployed quote registry", () => {
    expect(config.contracts.quoteRegistry).toBe("0x72405d10551d3e27a899dc3119cb356cb27bb9b3");
    expect(rawNetwork("arc-testnet").contracts.quoteRegistry)
      .toBe("0x72405d10551d3e27a899dc3119cb356cb27bb9b3");
  });
});

describe("a custom network's quote tokens", () => {
  it("default to native USDC alone", () => {
    const config = resolveNetwork({ rpcUrl: "http://127.0.0.1:8545", chainId: 31337, contracts });
    expect(config.quoteTokens).toEqual([NATIVE_USDC]);
  });

  it("take what the caller supplies, validated", () => {
    const config = resolveNetwork({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contracts: { ...contracts, quoteRegistry: "0x7777777777777777777777777777777777777777" },
      quoteTokens: [
        NATIVE_USDC,
        { address: "0x00000000000000000000000000000000000000E6", symbol: "SIX", name: "Six", decimals: 6, isNative: false },
      ],
    });
    expect(config.quoteTokens[1]?.address).toBe("0x00000000000000000000000000000000000000e6");
    expect(config.contracts.quoteRegistry).toBe("0x7777777777777777777777777777777777777777");
  });

  it("refuses a quote token the contracts would refuse", () => {
    try {
      resolveNetwork({
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 31337,
        contracts,
        quoteTokens: [{ address: "0x00000000000000000000000000000000000000e7", symbol: "BAD", name: "Bad", decimals: 24, isNative: false }],
      });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("InvalidArgument");
    }
  });
});

describe("review: native USDC is always a quote", () => {
  it("is found even on a custom network whose quoteTokens omit it", () => {
    const config = resolveNetwork({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contracts,
      quoteTokens: [{ address: "0x89b50855aa3be2f677cd6303cec089b5f319d72a", symbol: "EURC", name: "EURC", decimals: 6, isNative: false }],
    });
    expect(findQuoteToken(config, "0x0000000000000000000000000000000000000000")).toEqual(NATIVE_USDC);
  });
});
