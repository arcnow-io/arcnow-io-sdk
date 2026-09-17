/**
 * The venue list a creator picks from, and the two fields on it that are not
 * storage slots.
 *
 * `label` is the migrator's own `VERSION()` — the registry keeps the label only
 * in an event, and `VERSION()` is what the deployment script registers as that
 * label. `reachable` is the same question `Pool.isReachable()` asks, asked
 * before the launch rather than after: can a token that graduates here be
 * traded through the network's configured v4 router?
 *
 * Both are derived, so both can be wrong in a way the contract cannot correct,
 * which is why they are pinned here — with and without a router configured,
 * because on Arc testnet today there is none.
 */

import type { Abi, Address, Hex } from "viem";
import { custom, decodeFunctionData, encodeFunctionResult } from "viem";
import { describe, expect, it } from "vitest";

import { createArcNowClient } from "../../src/client.js";
import { migratorRegistryAbi, uniswapV4MigratorAbi }
  from "../../src/generated/abi/index.js";
import { uniswapV4Router04Abi }
  from "../../src/generated/abi/external/uniswapV4Router04.js";
import type { NetworkConfig } from "../../src/networks.js";
import { resolveNetwork } from "../../src/networks.js";

/** arcnow.io's own PoolManager: `networks.json`'s `v4.poolManager`. */
const OURS: Address = "0x06110b57dd9b82DD846ee0325fB81B284E1C6dD0";
/** Some other PoolManager. Synthetic: nothing here should care which. */
const ELSEWHERE: Address = "0x00000000000000000000000000000000000e15e0";
/** Where arcnow-io/contracts' deterministic router deployment lands. */
const ROUTER: Address = "0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e";

/** arcnow.io's live v4 migrator on Arc testnet's multi-quote stack, bound to OURS. */
const LIVE_V4: Address = "0x6bcfb74330a091ea5b06b4111ea5b572da0186b2";
/** A hypothetical v4 migrator bound to a manager the router does not serve. */
const STRANDED_V4: Address = "0x0000000000000000000000000000000000000044";
/** An escrow migrator: no poolManager(), no VERSION() either. */
const ESCROW: Address = "0x00000000000000000000000000000000000000ee";

interface Fixture {
  /** What `migratorAt(i)` returns, in order. */
  readonly order: readonly Address[];
  /** Per migrator: its recorded mode, its canonical router, and what it answers. */
  readonly rows: Record<string, {
    taxMode: number;
    router: Address;
    version?: string;
    poolManager?: Address;
  }>;
}

const FIXTURE: Fixture = {
  order: [ESCROW, LIVE_V4, STRANDED_V4],
  rows: {
    [ESCROW.toLowerCase()]: {
      taxMode: 0,
      router: "0x0000000000000000000000000000000000000000",
      // No VERSION() and no poolManager(): an escrow migrator answers neither.
    },
    [LIVE_V4.toLowerCase()]: {
      taxMode: 1,
      router: "0x0000000000000000000000000000000000000000",
      version: "arcnow/uniswap-v4-migrator@1.0.0",
      poolManager: OURS,
    },
    [STRANDED_V4.toLowerCase()]: {
      taxMode: 1,
      router: "0x0000000000000000000000000000000000000000",
      version: "arcnow/uniswap-v4-migrator@1.0.0",
      poolManager: ELSEWHERE,
    },
  },
};

/** The registry's real address on arc-testnet, from networks.json. */
const REGISTRY = "0x14300072ae1873d1163fb6e9f42485d3555b87f2";

/**
 * A revert shaped the way a node phrases one.
 *
 * JSON-RPC error code 3 rather than a bare `Error`, because viem retries what
 * it cannot classify — and a unit suite that spent three backoffs per expected
 * revert would be slow for a reason that has nothing to do with the code.
 */
function reverted(): Error {
  return Object.assign(new Error("execution reverted"), { code: 3 });
}

/** How many times the router was asked which PoolManager it serves. */
interface RouterReads {
  count: number;
}

/**
 * A transport that answers the registry's reads, each migrator's two optional
 * ones — **reverting** where the real contract would — and the router's
 * `poolManager()`.
 *
 * The reverts are the point. An escrow migrator has no `VERSION()` and no
 * `poolManager()`, and a `list()` that threw on either would hide a perfectly
 * selectable venue from a picker.
 */
function scripted(reads: RouterReads = { count: 0 }) {
  return custom({
    request: ({ method, params }): Promise<Hex> => {
      if (method !== "eth_call") throw new Error(`unscripted RPC method ${method}`);
      const call = (params as [{ to: Address; data: Hex }])[0];
      const to = call.to.toLowerCase();

      if (to === ROUTER) {
        const { functionName } = decodeFunctionData({ abi: uniswapV4Router04Abi, data: call.data });
        if (functionName !== "poolManager") throw new Error(`unscripted router call ${functionName}`);
        reads.count += 1;
        return Promise.resolve(
          encodeFunctionResult({ abi: uniswapV4Router04Abi, functionName, result: OURS }),
        );
      }

      const registryCall = to === REGISTRY;
      const abi = (registryCall ? migratorRegistryAbi : uniswapV4MigratorAbi) as unknown as Abi;
      const { functionName, args } = decodeFunctionData({ abi, data: call.data });
      const answer = (result: unknown): Promise<Hex> =>
        Promise.resolve(encodeFunctionResult({ abi, functionName, result }));

      if (registryCall) {
        switch (functionName) {
          case "migratorCount": return answer(BigInt(FIXTURE.order.length));
          case "migratorAt": return answer(FIXTURE.order[Number(args?.[0])]);
          case "isRegistered": return answer(true);
          case "taxModeOf":
            return answer(FIXTURE.rows[(args?.[0] as string).toLowerCase()]?.taxMode ?? 0);
          case "routerOf":
            return answer(FIXTURE.rows[(args?.[0] as string).toLowerCase()]?.router);
          default: throw new Error(`unscripted registry call ${functionName}`);
        }
      }

      const row = FIXTURE.rows[to];
      if (!row) throw new Error(`unscripted call to ${call.to}`);
      if (functionName === "VERSION") {
        if (row.version === undefined) throw reverted();
        return answer(row.version);
      }
      if (functionName === "poolManager") {
        if (row.poolManager === undefined) throw reverted();
        return answer(row.poolManager);
      }
      throw new Error(`unscripted migrator call ${functionName}`);
    },
  });
}

const PRESET = resolveNetwork("arc-testnet");

/** The arc-testnet preset with a router configured, as it will be once one is broadcast. */
function withRouter(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return { ...PRESET, ...overrides, contracts: { ...PRESET.contracts, v4Router: ROUTER } };
}

const client = createArcNowClient({ network: "arc-testnet", transport: scripted() });

describe("the registry of graduation targets", () => {
  it("is the address networks.json names", () => {
    expect(client.migrators.address).toBe(REGISTRY);
  });

  it("enumerates every migrator ever registered, in registration order", async () => {
    expect(await client.migrators.count()).toBe(3n);
    expect((await client.migrators.at(1)).toLowerCase()).toBe(LIVE_V4.toLowerCase());
    const list = await client.migrators.list();
    expect(list.map((entry) => entry.address.toLowerCase()))
      .toEqual(FIXTURE.order.map((address) => address.toLowerCase()));
  });

  it("reads the label off the migrator's own VERSION(), and tolerates none", async () => {
    const list = await client.migrators.list();
    // There is no labelOf on the contract: the label lives in an event, and
    // VERSION() is what the deployment registers as it.
    expect(list[1]?.label).toBe("arcnow/uniswap-v4-migrator@1.0.0");
    // An unnamed venue is still a selectable one, so this is "" rather than a
    // thrown error that would empty the whole picker.
    expect(list[0]?.label).toBe("");
  });

  it("says which venues charge the 1% and which charge nothing", async () => {
    const list = await client.migrators.list();
    // Escrow, v2 and v3 cannot run our code inside a swap, so nobody takes an
    // arcnow fee there at all — a platform choosing one earns nothing after
    // graduation.
    expect(list[0]?.taxMode).toBe("None");
    expect(list[1]?.taxMode).toBe("HookFee");
  });

  it("reports the zero router as the normal, safe value", async () => {
    const list = await client.migrators.list();
    // A non-zero canonical router gets a standing maximum allowance over every
    // holder of every token launched against that migrator. Zero grants nobody
    // anything, and is what Arc testnet's v4 migrator records.
    for (const entry of list) {
      expect(entry.router).toBe(`0x${"0".repeat(40)}`);
    }
  });

  it("describes one migrator without enumerating the list", async () => {
    const info = await client.migrators.describe(LIVE_V4);
    expect(info.taxMode).toBe("HookFee");
    expect(info.label).toBe("arcnow/uniswap-v4-migrator@1.0.0");
  });
});

describe("reachable, with no v4 router configured", () => {
  it("is false for every v4 migrator — and the router is never asked", async () => {
    // A network with no router: no graduated token can be traded through this
    // SDK, whichever manager it is in. Nothing to ask, so nothing asked.
    //
    // Built explicitly rather than taken from the arc-testnet preset. The preset
    // had no router until one was broadcast, and a test that relied on that
    // stopped being a test of this behaviour the day the router existed.
    const reads = { count: 0 };
    const testnet = resolveNetwork("arc-testnet");
    const noRouter: NetworkConfig = {
      ...testnet,
      contracts: { ...testnet.contracts, v4Router: undefined },
    };
    const preset = createArcNowClient({ network: noRouter, transport: scripted(reads) });
    expect(preset.config.contracts.v4Router).toBeUndefined();

    const list = await preset.migrators.list();
    const byAddress = (address: Address) =>
      list.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    expect(byAddress(LIVE_V4)?.reachable).toBe(false);
    expect(byAddress(STRANDED_V4)?.reachable).toBe(false);
    expect(reads.count).toBe(0);
  });

  it("is still true for a venue with no poolManager, because the question does not apply", async () => {
    // Escrow, v2 and v3 have no PoolManager and are not traded through the v4
    // router at all. Marking them unreachable would grey out perfectly good
    // venues on a chain that has them.
    const list = await client.migrators.list();
    expect(list[0]?.reachable).toBe(true);
  });
});

describe("reachable, with a v4 router configured", () => {
  it("is true for the live v4 migrator, because the router serves its PoolManager", async () => {
    // The planned deployment: arcnow.io's router is bound to the same manager
    // arcnow.io's migrator opens pools in, so the tokens already graduated and
    // every future one become tradeable together.
    const routed = createArcNowClient({ network: withRouter(), transport: scripted() });
    expect((await routed.migrators.describe(LIVE_V4)).reachable).toBe(true);
    expect((await routed.migrators.describe(ESCROW)).reachable).toBe(true);
  });

  it("is false for a v4 migrator bound to a manager the router does not serve", async () => {
    const routed = createArcNowClient({ network: withRouter(), transport: scripted() });
    expect((await routed.migrators.describe(STRANDED_V4)).reachable).toBe(false);
  });

  it("ASKS THE ROUTER, so a drifted v4.poolManager in the preset changes nothing", async () => {
    // The preset now claims the manager is ELSEWHERE. Compare migrators against
    // that and the two answers flip; ask the router and they do not.
    const drifted = createArcNowClient({
      network: withRouter({ v4: { poolManager: ELSEWHERE } }),
      transport: scripted(),
    });
    const list = await drifted.migrators.list();
    const byAddress = (address: Address) =>
      list.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
    expect(byAddress(LIVE_V4)?.reachable).toBe(true);
    expect(byAddress(STRANDED_V4)?.reachable).toBe(false);
  });

  it("reads the router's poolManager once per client, however many migrators are listed", async () => {
    // It is immutable. Two v4 migrators, two list() calls: one read.
    const reads = { count: 0 };
    const routed = createArcNowClient({ network: withRouter(), transport: scripted(reads) });
    await routed.migrators.list();
    await routed.migrators.list();
    expect(reads.count).toBe(1);
  });
});
