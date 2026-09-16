/**
 * contracts#23's gas guard on ERC-20 fee shares: `QuoteTransfer.tryPushBounded`
 * reverts with NO data when too little gas remains before a share is pushed.
 *
 * Two things follow for the SDK. An empty revert on an ERC-20 path is that
 * guard, and is named for it rather than left as an anonymous `EmptyRevert`.
 * And an ERC-20 trade is never sent at the node's bare estimate, which can land
 * right at the guard's edge: it gets a fifth more, and never less than 150,000.
 */

import { ContractFunctionRevertedError } from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_USDC } from "../../src/amounts.js";
import { mapError } from "../../src/errors/map.js";
import { bondingCurveAbi } from "../../src/generated/abi/index.js";
import { resolveNetwork } from "../../src/networks.js";
import {
  POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN,
  QUOTE_TRANSFER_GAS_HEADROOM_MIN,
  withPoolQuoteTransferHeadroom,
  withQuoteTransferHeadroom,
} from "../../src/quote-token.js";

const EURC = resolveNetwork("arc-testnet").quoteTokens.find((token) => token.symbol === "EURC")!;

const emptyRevert = () => new ContractFunctionRevertedError({
  abi: bondingCurveAbi, data: "0x", functionName: "buyWithQuote",
});

describe("the gas an ERC-20 trade is sent with", () => {
  it("is the estimate plus a fifth, and never less than 150,000 more", () => {
    expect(QUOTE_TRANSFER_GAS_HEADROOM_MIN).toBe(150_000n);
    expect(withQuoteTransferHeadroom(100_000n)).toBe(250_000n);
    expect(withQuoteTransferHeadroom(750_000n)).toBe(900_000n);
    expect(withQuoteTransferHeadroom(1_000_000n)).toBe(1_200_000n);
  });
});

describe("the gas a swap in an ERC-20-quoted pool is sent with (review L-1)", () => {
  it("is the estimate plus a fifth, and never less than 400,000 more", () => {
    // The estimate can miss the hook's fee redemption and distribution (an accrual
    // that was zero when estimated, until a front-running dust swap made it not),
    // and each ERC-20 share then needs 111,587 gas left before it.
    expect(POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN).toBe(400_000n);
    expect(withPoolQuoteTransferHeadroom(100_000n)).toBe(500_000n);
    expect(withPoolQuoteTransferHeadroom(2_000_000n)).toBe(2_400_000n);
    expect(withPoolQuoteTransferHeadroom(3_000_000n)).toBe(3_600_000n);
  });
});

describe("an empty revert", () => {
  it("on an ERC-20 path is the fee-share gas guard, named, with the limit it ran at", () => {
    const mapped = mapError(emptyRevert(), {
      functionName: "buyWithQuote", address: "0x00000000000000000000000000000000000c0001",
      quoteToken: EURC, gasLimit: 300_000n,
    });
    expect(mapped.code).toBe("QuoteTransferOutOfGas");
    expect(mapped.message).toMatch(/tryPushBounded/);
    expect(mapped.message).toMatch(/EURC/);
    expect(mapped.details).toMatchObject({ quoteToken: EURC.address, gasLimit: 300_000n });
    expect(mapped.isRevert).toBe(true);
  });

  it("on a native path, or with no quote known, is still EmptyRevert", () => {
    expect(mapError(emptyRevert(), { quoteToken: NATIVE_USDC }).code).toBe("EmptyRevert");
    expect(mapError(emptyRevert()).code).toBe("EmptyRevert");
  });
});
