/**
 * Presets, the deliberate mainnet hole, and the refusal to send to a null
 * address.
 */

import { describe, expect, it } from "vitest";

import { isArcNowError } from "../../src/errors/index.js";
import {
  NETWORKS,
  rawNetwork,
  REQUIRED_CONTRACTS,
  requireContract,
  resolveNetwork,
  toViemChain,
} from "../../src/networks.js";

describe("arc-testnet", () => {
  const config = resolveNetwork("arc-testnet");

  it("resolves to the live deployment", () => {
    expect(config.chainId).toBe(5042002);
    expect(config.rpcUrl).toBe("https://rpc.testnet.arc.io");
    expect(config.contracts.launchpad).toBe("0x3e4f0291f5e3ed7f8da839903e2984e6d69b1240");
    expect(config.contracts.arcnowPlatform).toBe("0xa78b737da5758250cc95097425d3d3ba534ea47a");
  });

  it("has every required contract", () => {
    for (const name of REQUIRED_CONTRACTS) {
      expect(requireContract(config, name)).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("names no explorer, because guessing one would put a wrong link in an error", () => {
    expect(config.explorerUrl).toBeUndefined();
  });

  it("offers a v4 venue and nothing else — and escrow's absence is the good state", () => {
    expect(config.venues).toEqual({
      escrow: false,
      uniswapV2: false,
      uniswapV3: false,
      uniswapV4: true,
    });
    expect(config.contracts.v4Migrator).toBeDefined();
    expect(config.contracts.escrowMigrator).toBeUndefined();
  });

  it("refuses to build a call to a contract that is not deployed, and says why", () => {
    expect(() => requireContract(config, "escrowMigrator")).toThrow(/not deployed/);
    try {
      requireContract(config, "escrowMigrator");
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("ContractNotDeployed");
      expect(error.message).toMatch(/healthy state/);
      expect(error.message).toMatch(/custodial/);
    }

    try {
      requireContract(config, "v2Migrator");
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      // Points the caller at the curve, which is the actual answer.
      expect(error.message).toMatch(/curve\.state\(\)\.migrator/);
    }
  });

  it("carries the contracts commit the ABIs are pinned to", () => {
    expect(config.contractsCommit).toBe("327f45b4763ab7f2ba5fc8cc0426b3d02e63f816");
    expect(config.deployedAtBlock).toBe(62226550);
  });

  it("records which build is at each address", () => {
    expect(config.contractVersions.launchpad).toBe("arcnow/launchpad@3.0.0");
    expect(config.contractVersions.curveFactory).toBe("arcnow/curve-factory@3.0.0");
    expect(config.contractVersions.feeHook).toBe("arcnow/arc-now-fee-hook@3.0.0");
    expect(config.contractVersions.quoteRegistry).toBe("arcnow/quote-registry@1.0.0");
    expect(config.contractVersions.escrowMigrator).toBeUndefined();
  });

  it("is one stack, with the router beside it and no legacy stacks", () => {
    expect(config).not.toHaveProperty("legacyStacks");
    expect(config.contracts.v4Router).toBe("0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e");
    expect(config.contractVersions.curveFactory).toBe("arcnow/curve-factory@3.0.0");
    expect(rawNetwork("arc-testnet")).not.toHaveProperty("legacyStacks");
  });

  it("describes Arc's native currency as USDC at 18 decimals", () => {
    const chain = toViemChain(config);
    expect(chain.nativeCurrency).toEqual({ name: "USD Coin", symbol: "USDC", decimals: 18 });
    expect(chain.id).toBe(5042002);
  });

  it("exposes the 6-decimal predeploy for edge conversion, and only for that", () => {
    expect(config.usdcErc20).toBe("0x3600000000000000000000000000000000000000");
  });
});

describe("arc-mainnet resolves, and then refuses", () => {
  it("is a preset — not a 'no such network'", () => {
    expect(NETWORKS).toContain("arc-mainnet");
    // The raw entry is readable, so a caller can SEE that it is empty rather
    // than infer it from a thrown error.
    const raw = rawNetwork("arc-mainnet");
    expect(raw.name).toBe("arc-mainnet");
    expect(raw.chainId).toBeNull();
    expect(raw.contracts.launchpad).toBeNull();
  });

  it("fails with NetworkNotDeployed and names every missing contract", () => {
    try {
      resolveNetwork("arc-mainnet");
      expect.unreachable("arc-mainnet must not resolve to something usable");
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("NetworkNotDeployed");
      expect(error.code).not.toBe("UnknownNetwork");
      for (const name of REQUIRED_CONTRACTS) {
        expect(error.message).toContain(name);
      }
      expect(error.message).toMatch(/not the SDK being out of date/);
      expect(error.message).toMatch(/rpcUrl, chainId, contracts/);
      expect(error.details.missing).toHaveLength(REQUIRED_CONTRACTS.length);
    }
  });

  it("never hands back a zero address", () => {
    // The zero address is a real account on Arc that would send money nowhere.
    expect(() => resolveNetwork("arc-mainnet")).toThrow();
  });
});

describe("custom deployments are a first-class path", () => {
  const contracts = {
    launchpad: "0x1111111111111111111111111111111111111111",
    tokenFactory: "0x2222222222222222222222222222222222222222",
    curveFactory: "0x3333333333333333333333333333333333333333",
    migratorRegistry: "0x4444444444444444444444444444444444444444",
    platformRegistry: "0x5555555555555555555555555555555555555555",
    arcnowPlatform: "0x6666666666666666666666666666666666666666",
  } as const;

  it("resolves from rpcUrl + chainId + contracts", () => {
    const config = resolveNetwork({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      contracts,
    });
    expect(config.name).toBe("custom");
    expect(config.chainId).toBe(31337);
    expect(config).not.toHaveProperty("legacyStacks");
    expect(config.contractVersions).toEqual({});
    expect(config.contracts.launchpad).toBe(contracts.launchpad);
    expect(config.venues.uniswapV4).toBe(false);
  });

  it("refuses one that is missing a required contract, naming it", () => {
    const { launchpad: _dropped, ...rest } = contracts;
    try {
      resolveNetwork({ rpcUrl: "http://127.0.0.1:8545", chainId: 31337, contracts: rest as never });
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("ContractNotDeployed");
      expect(error.message).toContain("launchpad");
    }
  });

  it("rejects a name that is neither a preset nor a custom deployment", () => {
    try {
      resolveNetwork("arc-devnet" as never);
      expect.unreachable();
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("UnknownNetwork");
      expect(error.message).toContain("arc-testnet");
    }
  });
});
