/**
 * Presets — Arc testnet and Arc mainnet, both live — and the refusal to send to
 * a null address.
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
    expect(config.contracts.launchpad).toBe("0x675a7a605911b0e3109eca580bc86e708199d952");
    expect(config.contracts.arcnowPlatform).toBe("0x912898e51f78e92f0a0d6efdefdee83fe7e8f4a4");
    expect(config.contracts.quoteRegistry).toBe("0x0428b6a3e1abe299e4497488d1137c3feda54250");
    expect(config.contracts.feeHook).toBe("0xd70d5f977976cdca4a786b5b118be7458533a0cc");
    expect(config.v4?.poolManager.toLowerCase()).toBe("0x06110b57dd9b82dd846ee0325fb81b284e1c6dd0");
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
    expect(config.contractsCommit).toBe("e461106e2c6a0361b8c5463db292b73ad8691599");
    expect(config.deployedAtBlock).toBe(62386232);
  });

  it("records which build is at each address", () => {
    expect(config.contractVersions.launchpad).toBe("arcnow/launchpad@3.0.0");
    expect(config.contractVersions.tokenFactory).toBe("arcnow/token-factory@2.0.0");
    expect(config.contractVersions.curveFactory).toBe("arcnow/curve-factory@4.0.0");
    expect(config.contractVersions.platformRegistry).toBe("arcnow/platform-registry@4.0.0");
    expect(config.contractVersions.arcnowPlatform).toBe("arcnow/platform-config@4.0.0");
    expect(config.contractVersions.feeHook).toBe("arcnow/arc-now-fee-hook@4.0.0");
    expect(config.contractVersions.quoteRegistry).toBe("arcnow/quote-registry@1.0.0");
    expect(config.contractVersions.escrowMigrator).toBeUndefined();
  });

  it("is one stack, with the router beside it and no legacy stacks", () => {
    expect(config).not.toHaveProperty("legacyStacks");
    expect(config.contracts.v4Router).toBe("0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e");
    expect(config.contractVersions.curveFactory).toBe("arcnow/curve-factory@4.0.0");
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

describe("arc-mainnet", () => {
  const config = resolveNetwork("arc-mainnet");

  it("is a preset that resolves to the live mainnet deployment", () => {
    expect(NETWORKS).toContain("arc-mainnet");
    expect(config.name).toBe("arc-mainnet");
    expect(config.chainId).toBe(5042);
    expect(config.rpcUrl).toBe("https://rpc.mainnet.arc.io");
    expect(config.explorerUrl).toBe("https://explorer.arc.io");
    expect(config.deployedAtBlock).toBe(21179866);
    expect(config.contractsCommit).toBe("e461106e2c6a0361b8c5463db292b73ad8691599");
  });

  it("carries every address of the deployment record, lower-cased", () => {
    expect(config.contracts.launchpad).toBe("0xae1e5558ab71e851ce44f5c0f12ebeaf3db9dae3");
    expect(config.contracts.tokenFactory).toBe("0x5e920c86ed0415ced9c4b3ddaad3203d48187341");
    expect(config.contracts.curveFactory).toBe("0xd75d46bd1974267d7b1a028be72553fd4f409072");
    expect(config.contracts.migratorRegistry).toBe("0xd1f3dbd38a82376b60555f57934136760c5b25e9");
    expect(config.contracts.platformRegistry).toBe("0x0397b1da5ff68525403c9830178606f236c44cc6");
    expect(config.contracts.quoteRegistry).toBe("0x969a6a598efb4743293e8ad3df56a065fd990f6b");
    expect(config.contracts.arcnowPlatform).toBe("0xe3c7cd3e98af47de518740c7cfef9fc7064b2ef9");
    expect(config.contracts.v4Migrator).toBe("0x64dde435db5d5e57965b27488ac8dee734ef0311");
    expect(config.contracts.feeHook).toBe("0x3cf7b568c0731c6efdec591d80aa55af51e220cc");
    expect(config.contracts.v4Router).toBe("0x4a142209396e7b9ba4c8527ff037fc73452b287f");
    expect(config.v4?.poolManager.toLowerCase()).toBe("0x8366a39cc670b4001a1121b8f6a443a643e40951");
    for (const name of REQUIRED_CONTRACTS) {
      expect(requireContract(config, name)).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("is v4-only, like testnet, with nothing custodial on chain", () => {
    expect(config.venues)
      .toEqual({ escrow: false, uniswapV2: false, uniswapV3: false, uniswapV4: true });
    expect(config.contracts.escrowMigrator).toBeUndefined();
    expect(config.contracts.v2Migrator).toBeUndefined();
    expect(config.contracts.v3Migrator).toBeUndefined();
  });

  it("runs the same build as testnet", () => {
    const testnet = resolveNetwork("arc-testnet");
    expect(config.contractVersions).toEqual(testnet.contractVersions);
    expect(config.contractVersions.feeHook).toBe("arcnow/arc-now-fee-hook@4.0.0");
  });

  it("quotes in native USDC and Circle's mainnet EURC", () => {
    expect(config.quoteTokens.map((q) => q.symbol)).toEqual(["USDC", "EURC"]);
    const eurc = config.quoteTokens.find((q) => q.symbol === "EURC");
    expect(eurc?.address).toBe("0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1");
    expect(eurc?.decimals).toBe(6);
    expect(config.quoteAllowanceSlots["0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1"]).toBe(10n);
  });

  it("describes Arc's native currency as USDC at 18 decimals, with the explorer", () => {
    const chain = toViemChain(config);
    expect(chain.id).toBe(5042);
    expect(chain.nativeCurrency).toEqual({ name: "USD Coin", symbol: "USDC", decimals: 18 });
    expect(chain.blockExplorers?.default.url).toBe("https://explorer.arc.io");
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
