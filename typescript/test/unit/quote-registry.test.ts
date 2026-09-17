/**
 * The quote registry: which quote tokens a launch may use, and what each costs
 * to launch in.
 *
 * `list()` is what a UI and the MCP server render a quote picker from, so its
 * RPC cost is pinned: a count, one batch of addresses, one batch of records —
 * never a read per token, and never a symbol read for a token `networks.json`
 * already describes.
 */

import type { Address } from "viem";
import { erc20Abi } from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_QUOTE, NATIVE_USDC } from "../../src/amounts.js";
import { createArcNowClient } from "../../src/client.js";
import { isArcNowError } from "../../src/errors/index.js";
import { launchpadAbi, quoteRegistryAbi } from "../../src/generated/abi/index.js";
import type { NetworkConfig } from "../../src/networks.js";
import { resolveNetwork } from "../../src/networks.js";
import { FakeChain, fakeErc20, Revert } from "./support/fake-chain.js";

const PRESET = resolveNetwork("arc-testnet");
const REGISTRY_ADDRESS: Address = "0x00000000000000000000000000000000000e0001";
const WITH_REGISTRY: NetworkConfig = {
  ...PRESET, contracts: { ...PRESET.contracts, quoteRegistry: REGISTRY_ADDRESS },
};
/**
 * A network that records no registry, so the launchpad is asked for it. The
 * arc-testnet preset records the deployed one, which is the other path below.
 */
const WITHOUT_REGISTRY: NetworkConfig = {
  ...PRESET, contracts: { ...PRESET.contracts, quoteRegistry: undefined },
};
const REGISTRY = REGISTRY_ADDRESS;
const EURC_ADDRESS: Address = "0x89b50855aa3be2f677cd6303cec089b5f319d72a";
const UNLISTED: Address = "0x00000000000000000000000000000000000e7418";

const EIGHT: Address = "0x00000000000000000000000000000000000e7408";

const records: Record<string, [number, bigint, boolean]> = {
  [NATIVE_QUOTE]: [18, 2n * 10n ** 18n, true],
  [EURC_ADDRESS]: [6, 2n * 10n ** 18n, true],
  [UNLISTED]: [18, 10n ** 18n, false],
  [EIGHT]: [8, 3n * 10n ** 18n, true],
};

function setup(
  network: NetworkConfig = WITHOUT_REGISTRY,
  order: Address[] = [NATIVE_QUOTE, EURC_ADDRESS, UNLISTED],
) {
  const chain = new FakeChain({
    [PRESET.contracts.launchpad]: {
      label: "launchpad",
      abi: launchpadAbi,
      reads: { quoteTokenRegistry: () => REGISTRY },
    },
    [REGISTRY]: {
      label: "registry",
      abi: quoteRegistryAbi,
      reads: {
        VERSION: () => "arcnow/quote-registry@1.0.0",
        quoteTokenCount: () => BigInt(order.length),
        quoteTokenAt: ([i]) => order[Number(i)],
        isQuoteToken: ([q]) => records[String(q).toLowerCase()]?.[2] ?? false,
        quoteInfo: ([q]) => {
          const record = records[String(q).toLowerCase()];
          if (!record) throw new Revert(quoteRegistryAbi, "QuoteTokenNotRegistered", [q]);
          return record;
        },
      },
    },
    [EIGHT]: fakeErc20({ label: "g8", address: EIGHT, abi: erc20Abi, symbol: "G8", name: "Eight", decimals: 8 }),
    [UNLISTED]: fakeErc20({ label: "w18", address: UNLISTED, abi: erc20Abi, symbol: "W18", name: "Eighteen", decimals: 18 }),
  });
  const client = createArcNowClient({ network, transport: chain.transport() });
  return { chain, client };
}

describe("the quote registry", () => {
  it("is the one the preset records, without asking the launchpad", async () => {
    const { chain, client } = setup({
      ...PRESET, contracts: { ...PRESET.contracts, quoteRegistry: REGISTRY_ADDRESS },
    });
    expect(PRESET.contracts.quoteRegistry).toBe("0x0428b6a3e1abe299e4497488d1137c3feda54250");
    expect(await client.quoteRegistry.address()).toBe(REGISTRY);
    expect(chain.calls).not.toContain("launchpad.quoteTokenRegistry");
  });

  it("is found through the launchpad when a network names none, once per client", async () => {
    const { chain, client } = setup();
    expect(await client.quoteRegistry.address()).toBe(REGISTRY);
    await client.quoteRegistry.count();
    await client.quoteRegistry.isQuoteToken(EURC_ADDRESS);
    expect(chain.calls.filter((c) => c === "launchpad.quoteTokenRegistry")).toHaveLength(1);
  });

  it("uses the configured address without asking the launchpad", async () => {
    const { chain, client } = setup(WITH_REGISTRY);
    expect(await client.quoteRegistry.count()).toBe(3n);
    expect(chain.calls).not.toContain("launchpad.quoteTokenRegistry");
  });

  it("answers info in the quote's own units, and isQuoteToken as 'active'", async () => {
    const { client } = setup();
    const eurc = await client.quoteRegistry.info(EURC_ADDRESS);
    expect(eurc.decimals).toBe(6);
    expect(eurc.active).toBe(true);
    expect(eurc.launchFee.format()).toBe("2 EURC");
    expect(await client.quoteRegistry.isQuoteToken(UNLISTED)).toBe(false);
    expect(await client.quoteRegistry.at(0)).toBe(NATIVE_QUOTE);
  });

  it("names a quote that was never registered", async () => {
    const { client } = setup();
    try {
      await client.quoteRegistry.info("0x00000000000000000000000000000000000bad01");
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("QuoteTokenNotRegistered");
    }
  });

  it("lists every quote in at most three eth_calls, reading metadata only for what networks.json lacks", async () => {
    const { chain, client } = setup(WITH_REGISTRY);
    const listed = await client.quoteRegistry.list();
    expect(listed.map((entry) => entry.token.symbol)).toEqual(["USDC", "EURC", "W18"]);
    expect(listed[0]?.token).toEqual(NATIVE_USDC);
    expect(listed.map((entry) => entry.active)).toEqual([true, true, false]);
    expect(listed[1]?.launchFee.format()).toBe("2 EURC");
    expect(chain.count("eth_call")).toBeLessThanOrEqual(3);
    // EURC's symbol came from networks.json; only the unlisted token was asked.
    expect(chain.calls).not.toContain("eurc.symbol");
    expect(chain.calls).toContain("w18.symbol");
  });

  it("refuses a registry of another version before listing", async () => {
    const chain = new FakeChain({
      [REGISTRY]: {
        label: "registry",
        abi: quoteRegistryAbi,
        reads: { VERSION: () => "arcnow/quote-registry@2.0.0", quoteTokenCount: () => 0n },
      },
    });
    const client = createArcNowClient({
      network: { ...PRESET, contracts: { ...PRESET.contracts, quoteRegistry: REGISTRY } },
      transport: chain.transport(),
    });
    try {
      await client.quoteRegistry.list();
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("UnknownCurveVersion");
      expect(error.details.component).toBe("quote-registry");
    }
  });

  it("lists two unlisted quotes in order, each with its own symbol and decimals", async () => {
    const { client } = setup(WITH_REGISTRY, [NATIVE_QUOTE, UNLISTED, EURC_ADDRESS, EIGHT]);
    const listed = await client.quoteRegistry.list();
    expect(listed.map((e) => [e.token.symbol, e.token.decimals])).toEqual([
      ["USDC", 18], ["W18", 18], ["EURC", 6], ["G8", 8],
    ]);
    expect(listed[3]?.launchFee.format()).toBe("3 G8");
  });

  it("asks the launchpad when a custom network's quoteRegistry is null", async () => {
    const contracts = { ...PRESET.contracts, quoteRegistry: null as never };
    const { client } = setup({ ...PRESET, contracts });
    expect(await client.quoteRegistry.address()).toBe(REGISTRY);
  });
});
