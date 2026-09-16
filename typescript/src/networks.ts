/**
 * Network presets, and the deliberate hole where Arc mainnet will go.
 *
 * The addresses come from `src/generated/networks.json`, which is a copy of the
 * repository-root `networks.json` projected in by `scripts/sync-artifacts.sh`
 * and checked by `scripts/check-pins.sh`. It is the single source of truth
 * shared with the Rust SDK: two SDKs each carrying their own address list would
 * eventually disagree about one address, in one language, on one chain, and
 * nothing would say which was right.
 *
 * **`null` in that file means "not deployed on this chain".** It is not the
 * zero address, which on Arc is a real account that would send money nowhere at
 * all. So this module resolves a preset and then refuses to build a call to a
 * missing contract, naming which one was missing.
 *
 * @module
 */

import type { Address, Chain } from "viem";

import type { QuoteTokenInfo } from "./amounts.js";
import { NATIVE_QUOTE, NATIVE_USDC, quoteTokenInfo } from "./amounts.js";
import { ArcNowError } from "./errors/error.js";
import networksJson from "./generated/networks.json" with { type: "json" };

/**
 * The named presets. `"arc-mainnet"` resolves and then refuses; see
 * {@link resolveNetwork}.
 */
export type Network = "arc-testnet" | "arc-mainnet";

/** Every preset name, in the order `networks.json` lists them. */
export const NETWORKS: readonly Network[] = ["arc-testnet", "arc-mainnet"];

/**
 * The contracts a deployment consists of.
 *
 * **Five are required**, because nothing about arcnow.io works without them:
 * `launchpad`, `tokenFactory`, `curveFactory`, `migratorRegistry`,
 * `platformRegistry`.
 *
 * The rest may legitimately be absent on a perfectly healthy chain. Arc testnet
 * has no `escrowMigrator` — and that is the *better* state, because escrow is
 * the one custodial contract in the system and `arcnow-io/contracts` deploys it
 * only where no venue migrator could be built. It has no v2 or v3 migrator
 * either, because both need a wrapped-native token Arc testnet does not
 * publish.
 */
export interface ContractAddresses {
  /** The one orchestrator: takes the launch fee, deploys token and curve, does the first buy. */
  readonly launchpad: Address;
  /** Deploys the ERC-20 half of a launch. */
  readonly tokenFactory: Address;
  /** Deploys the curve half of a launch. */
  readonly curveFactory: Address;
  /** The protocol's list of graduation targets a launch may pick from. */
  readonly migratorRegistry: Address;
  /** Creates platforms, holds the protocol fee share, and answers `isPlatform`. */
  readonly platformRegistry: Address;
  /**
   * The quote registry: which quote tokens a launch may use, and each one's
   * launch fee. **Absent until the multi-quote stack is deployed**; when absent
   * the SDK asks the launchpad (`quoteTokenRegistry()`, immutable) instead.
   */
  readonly quoteRegistry?: Address | undefined;
  /**
   * arcnow.io's **own** `PlatformConfig` — the default to launch under when a
   * caller names no other.
   *
   * Not a privileged singleton. It is one platform among however many the
   * registry admits; it is just the one whose address is known before you have
   * read a log.
   */
  readonly arcnowPlatform: Address;
  /** Custodial escrow fallback. Absent wherever a real venue exists, which is the good case. */
  readonly escrowMigrator?: Address | undefined;
  /** Uniswap v2 graduation target, if the chain has a wrapped-native token. */
  readonly v2Migrator?: Address | undefined;
  /** Uniswap v3 graduation target, if the chain has a wrapped-native token. */
  readonly v3Migrator?: Address | undefined;
  /** Uniswap v4 graduation target. The one Arc testnet has. */
  readonly v4Migrator?: Address | undefined;
  /** The v4 hook that charges the same 1%, in native USDC, inside a graduated pool's swaps. */
  readonly feeHook?: Address | undefined;
  /**
   * The Uniswap v4 router every post-graduation quote and trade goes through.
   * **Absent until it is deployed**, and while it is absent every pool quote
   * and trade refuses with `NoRouterDeployed`.
   *
   * It is `UniswapV4Router04` from z0r0z/v4-router at commit `f5d5bfc2`,
   * unmodified, deployed by arcnow-io/contracts `script/DeployV4Router.s.sol`
   * through Arc's deterministic CREATE2 factory with salt zero and bound to
   * **arcnow.io's own PoolManager**, `0x06110b57…`. That makes its address
   * predictable before it exists — `0x139166ee…` on Arc testnet — but a
   * predictable address with no code at it is not a router, so the preset says
   * `null` until the deployment is broadcast rather than naming it early.
   *
   * **Why arcnow.io deploys its own rather than using the one already on the
   * chain.** Arc testnet has a second, unrelated PoolManager with a third-party
   * router bound to it. Every token that has graduated has its liquidity in
   * arcnow.io's manager permanently — the positions are burned and the
   * migrator's `poolManager` is immutable — so moving future launches to the
   * other manager would never make those tokens tradeable, and would split
   * arcnow.io's liquidity across two markets that cannot see each other. A
   * router bound to our manager fixes the tokens already graduated and every
   * future one.
   *
   * Listed with arcnow.io's contracts rather than with the v4 deployment
   * because arcnow.io deploys it, and because this is the key the web app
   * builds against. It pays a native leg from `msg.value` and refunds what it
   * did not settle to the payer; a seller approves it directly for the token
   * leg.
   */
  readonly v4Router?: Address | undefined;
}

/** The contracts without which nothing works. Named here so the refusal can list them. */
export const REQUIRED_CONTRACTS = [
  "launchpad",
  "tokenFactory",
  "curveFactory",
  "migratorRegistry",
  "platformRegistry",
  "arcnowPlatform",
] as const satisfies readonly (keyof ContractAddresses)[];

/** A contract name that must be present for a preset to be usable. */
export type RequiredContract = (typeof REQUIRED_CONTRACTS)[number];

/**
 * Which graduation targets a deployment actually offers.
 *
 * Informational only. **A token graduates into the migrator its curve
 * snapshotted at launch**, which is immutable and may not be the platform's
 * current default. For a particular token, ask the curve
 * (`curve.state().migrator`), never this list.
 */
export interface VenueFlags {
  readonly escrow: boolean;
  readonly uniswapV2: boolean;
  readonly uniswapV3: boolean;
  readonly uniswapV4: boolean;
}

/**
 * The Uniswap v4 PoolManager arcnow.io's graduated tokens trade in.
 *
 * **A v4 pool has no address.** It is a `PoolId` inside one PoolManager's
 * storage, so "which pool" is answered by a key plus a manager and never by a
 * contract address. `token.migratedPool()` and the curve's `Migrated` event
 * both report the **PoolManager**, identically for every token on the chain;
 * they say *that* a token migrated and *into which manager*, and nothing more.
 *
 * The router that reaches this manager is not here: it is
 * {@link ContractAddresses.v4Router}, because arcnow.io deploys it.
 */
export interface V4Deployment {
  /**
   * The PoolManager arcnow.io's migrator opens pools in — genuine Uniswap v4,
   * and where every token that has graduated has its liquidity, permanently.
   *
   * **Descriptive, not authoritative.** Nothing in this SDK decides
   * reachability from it. `Pool.isReachable()` compares the token's migrator's
   * `poolManager()` against the **router's own** `poolManager()`, both read off
   * the chain, because a check that compared one bundled address against
   * another would be defeated by a single stale entry in this file — the very
   * mistake it exists to catch.
   */
  readonly poolManager: Address;
}

/** A resolved, usable deployment. */
export interface NetworkConfig {
  /** The preset name, or `"custom"` for addresses a caller supplied. */
  readonly name: string;
  /** EVM chain id. Arc testnet is `5042002`. */
  readonly chainId: number;
  /** A JSON-RPC endpoint. Reading needs no key; writing needs a signer, not a different URL. */
  readonly rpcUrl: string;
  /**
   * A block explorer, when there is one to name.
   *
   * `undefined` for Arc testnet, deliberately: nothing in `arcnow-io/contracts`
   * or `arcnow-io/deployment` names an explorer for it, and a wrong link in an
   * error message is worse than no link.
   */
  readonly explorerUrl?: string | undefined;
  /** The deployment's addresses: the launchpad, platform, registries and router. */
  readonly contracts: ContractAddresses;
  /**
   * The `VERSION()` each contract answers, key for key with
   * {@link NetworkConfig.contracts}. Informational: every price in this SDK is
   * decided by asking the contract itself.
   */
  readonly contractVersions: Readonly<Record<string, string | undefined>>;
  /** What this deployment can graduate into. */
  readonly venues: VenueFlags;
  /**
   * The Uniswap v4 deployment a graduated token trades in, when the chain has
   * one. `undefined` where it does not — which is every chain arcnow.io is not
   * on yet.
   */
  readonly v4?: V4Deployment | undefined;
  /**
   * The `arcnow-io/contracts` commit the addresses were deployed from.
   *
   * The same commit `pins.json` pins the ABIs to. If these two ever diverge, an
   * encoded call succeeds against a selector that does something else — which
   * is the failure the pin exists to prevent.
   */
  readonly contractsCommit?: string | undefined;
  /** The block the deployment landed in, for an indexer's start height. */
  readonly deployedAtBlock?: number | undefined;
  /**
   * The 6-decimal ERC-20 view of native USDC, if the chain publishes one.
   *
   * Here so a wallet-facing caller can find it. **No arcnow.io contract reads
   * it and no method on this SDK accepts it**; see {@link UsdcErc20}.
   */
  readonly usdcErc20?: Address | undefined;
  /**
   * The quote tokens this network's curves may be priced in, with the metadata
   * needed to label and scale an amount **without an RPC call**: native USDC,
   * then each allowlisted ERC-20 `networks.json` knows about.
   *
   * Metadata, not the allowlist. A quote the registry lists and this does not is
   * read on chain once per process (`client.quoteTokenInfo`); whether a quote is
   * accepted at all is `QuoteRegistry.isQuoteToken`.
   */
  readonly quoteTokens: readonly QuoteTokenInfo[];
  /**
   * The storage slot of each ERC-20 quote's allowance mapping, by lower-cased
   * address, where `networks.json` records one. Used only to state-override the
   * router's allowance when pricing a pool buy with `eth_call`; a quote with no
   * slot here is priced only for a `from` that has already approved the router.
   */
  readonly quoteAllowanceSlots: Readonly<Record<string, bigint>>;
}

/** What a caller passes to build a client against a deployment this SDK has never heard of. */
export interface CustomNetwork {
  /** A JSON-RPC endpoint. */
  readonly rpcUrl: string;
  /** The chain id that endpoint reports. Checked against the chain on first use. */
  readonly chainId: number;
  /** The addresses. The required ones must be present. */
  readonly contracts: ContractAddresses;
  /** Optional: the `VERSION()` of each contract. Defaults to none recorded. */
  readonly contractVersions?: Readonly<Record<string, string | undefined>> | undefined;
  /** Optional: what it can graduate into. Defaults to all false. */
  readonly venues?: Partial<VenueFlags> | undefined;
  /**
   * Optional: the v4 PoolManager graduated tokens trade in. Descriptive only.
   * The router that trades them is `contracts.v4Router`; without that, every
   * pool quote and trade on this network refuses with `NoRouterDeployed`.
   */
  readonly v4?: V4Deployment | undefined;
  /** Optional: an explorer to put in messages. */
  readonly explorerUrl?: string | undefined;
  /** Optional: a name to put in messages. Defaults to `"custom"`. */
  readonly name?: string | undefined;
  /** Optional: the quote tokens' metadata. Defaults to native USDC alone. */
  readonly quoteTokens?: readonly QuoteTokenInfo[] | undefined;
  /** Optional: each ERC-20 quote's allowance storage slot, by address. */
  readonly quoteAllowanceSlots?: Readonly<Record<string, bigint>> | undefined;
}

/** What `resolveNetwork` and the client builder accept. */
export type NetworkInput = Network | CustomNetwork | NetworkConfig;

/** The shape of `networks.json`, minus the `$comment` prose. */
interface RawNetwork {
  name: string;
  chainId: number | null;
  rpcUrl: string | null;
  explorerUrl: string | null;
  deployedAtBlock: number | null;
  contractsCommit: string | null;
  native: { symbol: string; decimals: number };
  usdcErc20: { address: string | null; decimals: number };
  quoteTokens?: {
    address: string; symbol: string; name: string; decimals: number; native: boolean;
    allowanceSlot?: number;
  }[];
  contracts: Record<string, string | null>;
  contractVersions?: Record<string, string | null>;
  venues: Record<string, boolean>;
  v4?: {
    poolManager?: string | null;
  };
}

const RAW = (networksJson as unknown as { networks: Record<string, RawNetwork> }).networks;

/**
 * The raw preset entry, `null` addresses and all.
 *
 * Exposed so a caller can *see* that `"arc-mainnet"` exists and is empty rather
 * than having to infer it from a thrown error.
 */
export function rawNetwork(network: Network): RawNetwork {
  const entry = RAW[network];
  if (!entry) {
    throw new ArcNowError({
      code: "UnknownNetwork",
      message:
        `there is no preset called ${JSON.stringify(network)}. The presets are `
        + `${NETWORKS.join(", ")}. For anything else, pass { rpcUrl, chainId, contracts } `
        + "— building a client from your own addresses is a first-class path here, not a "
        + "fallback.",
    });
  }
  return entry;
}

function normaliseAddress(value: string | null): Address | undefined {
  if (value === null || value === "") return undefined;
  return value.toLowerCase() as Address;
}

/**
 * Resolve a preset, a custom deployment or an already-resolved config into
 * something a client can be built on.
 *
 * **`"arc-mainnet"` resolves and then refuses.** The preset is present,
 * complete in shape and null in every address, on purpose. A preset that was
 * absent would get a caller a "no such network" error they read as "the SDK is
 * behind" and work around by pasting addresses from somewhere; a preset with
 * plausible addresses in it would get them a transaction to an account that
 * does not exist. What they get instead is
 * {@link ArcNowError} with code `NetworkNotDeployed`, naming every missing
 * contract and saying to pass addresses explicitly.
 *
 * @throws {ArcNowError} `UnknownNetwork` for a name that is not a preset.
 * @throws {ArcNowError} `NetworkNotDeployed` for a preset with nothing deployed on it.
 */
export function resolveNetwork(input: NetworkInput): NetworkConfig {
  if (typeof input !== "string") {
    if ("contracts" in input && "chainId" in input && "rpcUrl" in input) {
      return resolveCustom(input);
    }
    throw new ArcNowError({
      code: "UnknownNetwork",
      message:
        "a custom network needs rpcUrl, chainId and contracts. Pass a preset name "
        + `(${NETWORKS.join(", ")}) or all three.`,
    });
  }

  const entry = rawNetwork(input);
  const contracts: Record<string, Address | undefined> = {};
  for (const [key, value] of Object.entries(entry.contracts)) {
    contracts[key] = normaliseAddress(value);
  }

  const missing = REQUIRED_CONTRACTS.filter((name) => contracts[name] === undefined);
  if (missing.length > 0 || entry.chainId === null || entry.rpcUrl === null) {
    throw notDeployed(input, missing, entry);
  }

  return {
    name: entry.name,
    chainId: entry.chainId,
    rpcUrl: entry.rpcUrl,
    explorerUrl: entry.explorerUrl ?? undefined,
    contracts: contracts as unknown as ContractAddresses,
    contractVersions: versions(entry.contractVersions),
    venues: {
      escrow: entry.venues.escrow ?? false,
      uniswapV2: entry.venues.uniswapV2 ?? false,
      uniswapV3: entry.venues.uniswapV3 ?? false,
      uniswapV4: entry.venues.uniswapV4 ?? false,
    },
    contractsCommit: entry.contractsCommit ?? undefined,
    deployedAtBlock: entry.deployedAtBlock ?? undefined,
    usdcErc20: normaliseAddress(entry.usdcErc20.address),
    v4: readV4(entry),
    quoteTokens: (entry.quoteTokens ?? [NATIVE_USDC]).map((raw) =>
      quoteTokenInfo({ ...raw, isNative: "native" in raw ? raw.native : (raw).isNative })),
    quoteAllowanceSlots: Object.fromEntries((entry.quoteTokens ?? [])
      .filter((raw) => raw.allowanceSlot !== undefined)
      .map((raw) => [raw.address.toLowerCase(), BigInt(raw.allowanceSlot as number)])),
  };
}

/** The allowance storage slot the network records for an ERC-20 quote, or `undefined`. */
export function quoteAllowanceSlot(config: NetworkConfig, address: string): bigint | undefined {
  return config.quoteAllowanceSlots[address.toLowerCase()];
}

/**
 * The metadata `networks.json` (or a custom network) carries for a quote token,
 * found by address in any case, or `undefined`. No RPC.
 */
export function findQuoteToken(config: NetworkConfig, address: string): QuoteTokenInfo | undefined {
  const wanted = address.toLowerCase();
  const listed = config.quoteTokens.find((token) => token.address === wanted);
  // Native USDC is every network's quote whether or not a custom list names it:
  // it has no contract to read metadata from.
  return listed ?? (wanted === NATIVE_QUOTE ? NATIVE_USDC : undefined);
}

function versions(
  raw: Record<string, string | null> | undefined,
): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw ?? {})) out[key] = value ?? undefined;
  return out;
}

/**
 * The v4 block, or `undefined` when the chain has no v4 deployment recorded.
 *
 * Descriptive only: whether a graduated token can be traded is decided by
 * `contracts.v4Router` and by what that router reports about itself.
 */
function readV4(entry: RawNetwork): V4Deployment | undefined {
  const poolManager = normaliseAddress(entry.v4?.poolManager ?? null);
  if (poolManager === undefined) return undefined;
  return { poolManager };
}

function resolveCustom(input: CustomNetwork | NetworkConfig): NetworkConfig {
  const missing = REQUIRED_CONTRACTS.filter(
    (name) => input.contracts[name] === undefined || input.contracts[name] === null,
  );
  if (missing.length > 0) {
    throw new ArcNowError({
      code: "ContractNotDeployed",
      message:
        `these contracts were not supplied and this SDK cannot work without them: `
        + `${missing.join(", ")}. They are the launchpad, the two factories it deploys `
        + "through, and the two registries a launch is validated against. Read them off "
        + "your deployment record — arcnow-io/deployment writes one per chain.",
      details: { missing },
    });
  }
  return {
    name: input.name ?? "custom",
    chainId: input.chainId,
    rpcUrl: input.rpcUrl,
    explorerUrl: input.explorerUrl ?? undefined,
    contracts: input.contracts,
    contractVersions: input.contractVersions ?? {},
    venues: {
      escrow: input.venues?.escrow ?? false,
      uniswapV2: input.venues?.uniswapV2 ?? false,
      uniswapV3: input.venues?.uniswapV3 ?? false,
      uniswapV4: input.venues?.uniswapV4 ?? false,
    },
    contractsCommit: "contractsCommit" in input ? input.contractsCommit : undefined,
    deployedAtBlock: "deployedAtBlock" in input ? input.deployedAtBlock : undefined,
    usdcErc20: "usdcErc20" in input ? input.usdcErc20 : undefined,
    v4: input.v4,
    quoteTokens: (input.quoteTokens ?? [NATIVE_USDC]).map((token) => quoteTokenInfo(token)),
    quoteAllowanceSlots: Object.fromEntries(Object.entries(input.quoteAllowanceSlots ?? {})
      .map(([address, slot]) => [address.toLowerCase(), slot])),
  };
}

function notDeployed(network: Network, missing: string[], entry: RawNetwork): ArcNowError {
  const named = missing.length > 0 ? missing : REQUIRED_CONTRACTS.slice();
  return new ArcNowError({
    code: "NetworkNotDeployed",
    message:
      `the ${network} preset exists and has nothing deployed on it. Missing: `
      + `${named.join(", ")}`
      + (entry.chainId === null ? ", and the chain id itself" : "")
      + (entry.rpcUrl === null ? ", and an RPC endpoint" : "")
      + ". This is not the SDK being out of date: arcnow.io is not on this chain yet, and "
      + "the preset is deliberately null in every address rather than absent, so that you "
      + "get this sentence instead of a 'no such network' you would work around. If you "
      + "know better, pass { rpcUrl, chainId, contracts } — a custom deployment is a "
      + "first-class path here.",
    details: { network, missing: named },
  });
}

/**
 * Read one contract address, or refuse with a message that names it.
 *
 * The zero address is refused as hard as `undefined` is: on Arc it is a real
 * account, and a transfer to it sends money nowhere at all.
 */
export function requireContract(
  config: NetworkConfig,
  name: keyof ContractAddresses,
): Address {
  const address = config.contracts[name];
  if (address === undefined || /^0x0{40}$/i.test(address)) {
    throw new ArcNowError({
      code: "ContractNotDeployed",
      message:
        `${name} is not deployed on ${config.name} (chain ${config.chainId}), so this call `
        + "has nowhere to go. "
        + (name === "escrowMigrator"
          ? "That is the healthy state: escrow is the one custodial contract in the "
          + "system and it is deployed only on a chain with no venue to migrate into."
          : name === "v2Migrator" || name === "v3Migrator"
            ? "Uniswap v2 and v3 migrators need a wrapped-native token, and arcnow-io/"
            + "contracts refuses to guess one. Ask the curve you care about which "
            + "migrator it snapshotted: curve.state().migrator."
            : "Pass the address explicitly on a custom network if you have one."),
      details: { contract: name, network: config.name },
    });
  }
  return address;
}

/**
 * The network's `contracts.v4Router`, or `undefined` when none is configured.
 *
 * The zero address counts as none, as it does in {@link requireContract}: on
 * Arc it is a real account, and a swap "sent" to it is a value transfer to
 * nobody.
 */
export function configuredV4Router(config: NetworkConfig): Address | undefined {
  const router = config.contracts.v4Router;
  if (router === undefined || router === null || /^0x0{40}$/i.test(router)) return undefined;
  return router;
}

/**
 * The network's v4 router, or `NoRouterDeployed`.
 *
 * Its own code rather than {@link requireContract}'s `ContractNotDeployed`,
 * because the consequence is specific and a UI needs to say it: **no graduated
 * token on this network can be quoted or traded**, however healthy its pool
 * is, while every bonding curve keeps working. A caller switching on the code
 * can show "trading after graduation is coming" instead of an error.
 *
 * @throws {ArcNowError} `NoRouterDeployed` when `contracts.v4Router` is absent.
 */
export function requireV4Router(config: NetworkConfig): Address {
  const router = configuredV4Router(config);
  if (router === undefined) {
    throw new ArcNowError({
      code: "NoRouterDeployed",
      message:
        `no Uniswap v4 router is deployed for ${config.name} (chain ${config.chainId}) yet, `
        + "so graduated tokens cannot be traded: a graduated token's liquidity is in a v4 "
        + "pool, and a v4 pool is reached only through a router. The router is "
        + "UniswapV4Router04 from z0r0z/v4-router, bound to arcnow.io's own PoolManager, "
        + "and it is deployed by arcnow-io/contracts script/DeployV4Router.s.sol; this "
        + "network's contracts.v4Router stays null until that deployment is broadcast. "
        + "Nothing about the token is wrong and retrying will not help. Bonding-curve "
        + "trading is unaffected. On a custom network, pass contracts.v4Router if you "
        + "have deployed one.",
      details: { network: config.name, chainId: config.chainId },
    });
  }
  return router;
}

/**
 * A viem {@link Chain} for a resolved config.
 *
 * The native currency is **USDC at 18 decimals** — that is not a typo and not a
 * placeholder. Arc's gas currency is USDC, and `msg.value` is an 18-decimal
 * integer. Anything that renders a native balance with this chain object gets
 * the right number of decimal places for free.
 */
export function toViemChain(config: NetworkConfig): Chain {
  return {
    id: config.chainId,
    name: config.name,
    nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
    ...(config.explorerUrl === undefined
      ? {}
      : { blockExplorers: { default: { name: "explorer", url: config.explorerUrl } } }),
  };
}

/**
 * Multicall3, a predeploy on Arc at the canonical address.
 * `ArcConstants.MULTICALL3`. Used to read a curve's whole state in one
 * round trip instead of eleven.
 */
export const MULTICALL3_ADDRESS: Address = "0xca11bde05977b3631167028862be2a173976ca11";
