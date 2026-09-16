/**
 * The read-only client, and the write that fails before any RPC.
 *
 * The transport in these tests throws on every request. That is the assertion:
 * a write on a client with no signer must be refused *without asking anybody*,
 * so if any of these tests reaches the network it fails with "the transport was
 * used" rather than passing for the wrong reason.
 */

import { custom } from "viem";
import { describe, expect, it } from "vitest";

import { Tokens, Usdc } from "../../src/amounts.js";
import { ArcNowClient, createArcNowClient } from "../../src/client.js";
import { Deadline } from "../../src/deadline.js";
import { isArcNowError } from "../../src/errors/index.js";

/** A transport that fails the test if anything touches it. */
const forbidden = custom({
  request: () => {
    throw new Error("the transport was used, and this test asserts that it is not");
  },
});

const anyAddress = "0x1111111111111111111111111111111111111111" as const;

describe("a read-only client", () => {
  const client = createArcNowClient({ network: "arc-testnet", transport: forbidden });

  it("is constructible from a network alone — no key anywhere", () => {
    expect(client.canWrite).toBe(false);
    expect(client.walletClient).toBeUndefined();
    expect(client.config.chainId).toBe(5042002);
  });

  it("exposes every handle without a signer", () => {
    expect(client.launchpad.address).toBe("0x3e4f0291f5e3ed7f8da839903e2984e6d69b1240");
    expect(client.platforms.address).toBe("0xd265496c0f4e7948db1813196993430eb54eb42c");
    expect(client.curve(anyAddress).address).toBe(anyAddress);
    expect(client.token(anyAddress).address).toBe(anyAddress);
  });

  it("refuses a launch before touching the network, and says what to do", async () => {
    await expect(
      client.launchpad.launch({
        name: "Example",
        symbol: "EXAM",
        metadataUri: "ipfs://example",
        initialBuy: Usdc.ZERO,
        minTokensOut: Tokens.ZERO,
      }),
    ).rejects.toThrow(/no signer/);

    try {
      await client.launchpad.launch({
        name: "Example",
        symbol: "EXAM",
        metadataUri: "ipfs://example",
        initialBuy: Usdc.ZERO,
        minTokensOut: Tokens.ZERO,
      });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("ReadOnlyClient");
      expect(error.message).toContain("launchpad.launch");
      expect(error.message).toMatch(/privateKeyToAccount/);
      expect(error.message).toMatch(/Every read method works without one/);
    }
  });

  it("refuses every other write the same way, and names each one", async () => {
    const curve = client.curve(anyAddress);
    const token = client.token(anyAddress);
    const cases: [string, () => Promise<unknown>][] = [
      ["curve.buy", () => curve.buy({
        quoteIn: Usdc.parse("1"),
        minTokensOut: Tokens.ZERO,
        deadline: Deadline.inMinutes(5),
      })],
      ["curve.sell", () => curve.sell({
        tokensIn: Tokens.parse("1"),
        minQuoteOut: Usdc.ZERO,
        deadline: Deadline.inMinutes(5),
      })],
      ["curve.migrate", () => curve.migrate()],
      ["curve.withdraw", () => curve.withdraw(anyAddress)],
      ["token.approve", () => token.approve(anyAddress, Tokens.ZERO)],
      ["token.transfer", () => token.transfer(anyAddress, Tokens.ZERO)],
      ["launchpad.collectLaunchFees", () => client.launchpad.collectLaunchFees()],
    ];

    for (const [name, run] of cases) {
      try {
        await run();
        expect.unreachable(`${name} should have refused`);
      } catch (error) {
        if (!isArcNowError(error)) throw error;
        expect(error.code, name).toBe("ReadOnlyClient");
        expect(error.message, name).toContain(name);
      }
    }
  });
});

describe("argument checks that happen before the chain is asked", () => {
  const client = createArcNowClient({
    network: "arc-testnet",
    transport: forbidden,
    account: anyAddress,
  });

  it("refuses an empty metadata URI, explaining what it is for", async () => {
    try {
      await client.launchpad.quoteLaunch({
        name: "Example",
        symbol: "EXAM",
        metadataUri: "   ",
        initialBuy: Usdc.ZERO,
        minTokensOut: Tokens.ZERO,
      });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toMatch(/token nothing can display/);
    }
  });

  it("refuses a zero-value buy rather than sending one", async () => {
    try {
      await client.curve(anyAddress).buy({
        quoteIn: Usdc.ZERO,
        minTokensOut: Tokens.ZERO,
        deadline: Deadline.inMinutes(5),
      });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toMatch(/ZeroAmount/);
    }
  });

  it("refuses a zero-token sell", async () => {
    try {
      await client.curve(anyAddress).sell({
        tokensIn: Tokens.ZERO,
        minQuoteOut: Usdc.ZERO,
        deadline: Deadline.inMinutes(5),
      });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("InvalidArgument");
    }
  });
});

describe("building a client", () => {
  it("refuses arc-mainnet at construction, not at first use", () => {
    expect(() => createArcNowClient({ network: "arc-mainnet", transport: forbidden }))
      .toThrow(/nothing deployed on it/);
  });

  it("has a builder that says what is missing", () => {
    expect(() => ArcNowClient.builder().build()).toThrow(/needs a network/);
    const built = ArcNowClient.builder()
      .network("arc-testnet")
      .rpcUrl("http://127.0.0.1:8545")
      .transport(forbidden)
      .signer(anyAddress)
      .build();
    expect(built.canWrite).toBe(true);
    expect(built.config.rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("takes a custom deployment as a first-class path", () => {
    const built = createArcNowClient({
      network: {
        rpcUrl: "http://127.0.0.1:8545",
        chainId: 31337,
        contracts: {
          launchpad: anyAddress,
          tokenFactory: anyAddress,
          curveFactory: anyAddress,
          migratorRegistry: anyAddress,
          platformRegistry: anyAddress,
          arcnowPlatform: anyAddress,
        },
      },
      transport: forbidden,
    });
    expect(built.config.name).toBe("custom");
    expect(built.launchpad.address).toBe(anyAddress);
  });
});
