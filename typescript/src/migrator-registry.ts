/**
 * The protocol's list of graduation targets — the only venues a launch may
 * choose from.
 *
 * A platform picks a default from this list and a creator may pick another from
 * it, and from nothing wider: the alternative is a creator pointing their own
 * buyers' liquidity at an address they control. `LaunchParams.migrator` is that
 * choice, and this module is what makes it legible before it is made.
 *
 * # What is recorded here, and when
 *
 * A migrator's **tax mode** and its **canonical router** are read once, at
 * registration, and never re-read. A migrator that could change its answer could
 * switch the 1% on every future trade of an already-launched token on or off;
 * one that could revert would brick every launch that named it.
 *
 * # Deregistration reaches nothing that already exists
 *
 * A curve already bound to a migrator still migrates to it, and a token that
 * already recorded a pool keeps the mode recorded against it. Deregistration
 * stops the *next* launch choosing it and nothing else — which is why
 * `curve.state().migrator`, not this list, is the authoritative answer for a
 * particular token.
 *
 * # The two fields that are not on the contract
 *
 * {@link MigratorInfo.label} and {@link MigratorInfo.reachable} are derived, and
 * both are said so out loud below, because a UI that offers a venue picker needs
 * them and neither is a storage slot anybody can read.
 *
 * @module
 */

import type { Address } from "viem";
import { zeroAddress } from "viem";

import type { ClientContext } from "./client.js";
import { withMappedErrors } from "./errors/map.js";
import { migratorRegistryAbi, uniswapV4MigratorAbi } from "./generated/abi/index.js";
import { configuredV4Router } from "./networks.js";
import { routerPoolManager } from "./pool.js";
import type { PoolTaxMode } from "./token.js";

/** One graduation target, as a venue picker needs to render it. */
export interface MigratorInfo {
  /** The migrator's address. This is what goes in `LaunchParams.migrator`. */
  readonly address: Address;
  /**
   * Whether this venue charges arcnow.io's 1% after graduation.
   *
   * `"HookFee"` is Uniswap v4, where a hook takes the fee in USDC inside the
   * swap. `"None"` is v2, v3 and the escrow fallback: none of them can run our
   * code inside a swap, so nobody takes an arcnow fee there at all — a platform
   * choosing one is choosing to earn nothing after graduation.
   */
  readonly taxMode: PoolTaxMode;
  /**
   * The router every holder's allowance answers `uint256.max` for after
   * migration.
   *
   * **The zero address is the normal, safe value** and means the token grants no
   * standing allowance to anybody. A non-zero value here is the one address that
   * can move holders' balances without being granted anything, so read it before
   * choosing a venue. Arc testnet's v4 migrator registers none.
   */
  readonly router: Address;
  /**
   * A human-readable venue name, **read from the migrator's own `VERSION()`**.
   *
   * There is no `labelOf` on the registry: the label lives only in the
   * `MigratorRegistered` event, and what the deployment script registers as the
   * label is exactly this string. So this reproduces the registered label
   * without an event query — but it is the migrator's word, not the registry's
   * stored record, and the two could in principle disagree.
   *
   * Empty for a migrator that does not answer `VERSION()`, rather than a
   * throw: an unnamed venue is still a selectable one.
   */
  readonly label: string;
  /**
   * Whether a token graduating here would land somewhere this SDK can trade
   * **through the network's configured router**.
   *
   * The same question {@link Pool.isReachable} asks, asked **before** the
   * launch instead of after:
   *
   * - **A v4 migrator** (it answers `poolManager()`): `true` iff a
   *   `contracts.v4Router` is configured **and** that router's own immutable
   *   `poolManager()`, read off the chain, is this migrator's. `false` when no
   *   router is configured, and then graduated tokens cannot be traded through
   *   this SDK at all. A migrator bound to a manager the router does not serve is
   *   `false` permanently, because both managers are immutable.
   * - **A migrator with no `poolManager()`** — escrow, v2, v3: `true`, because
   *   the question does not apply to it.
   *
   * So on a network without a router, `false` means "not yet", not "never":
   * it turns `true` for arcnow.io's v4 migrator the moment the router this
   * SDK is told about is the one bound to its PoolManager.
   */
  readonly reachable: boolean;
}

/** A handle on the protocol's migrator registry. Built with `client.migrators`. */
export class MigratorRegistry {
  private readonly ctx: ClientContext;

  /** The registry's address. */
  readonly address: Address;

  constructor(context: ClientContext, address: Address) {
    this.ctx = context;
    this.address = address;
  }

  /** True if `migrator` may currently be chosen as a graduation target. */
  async isRegistered(migrator: Address): Promise<boolean> {
    return withMappedErrors({ functionName: "isRegistered", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: migratorRegistryAbi,
        functionName: "isRegistered",
        args: [migrator],
      }));
  }

  /**
   * The tax mode `migrator` declared at registration.
   *
   * **Reverts** for an address that was never registered rather than answering
   * `"None"` — the enum's zero value — because that would make an address
   * nobody ever vetted indistinguishable from a vetted venue that charges no
   * fee.
   */
  async taxModeOf(migrator: Address): Promise<PoolTaxMode> {
    const mode = await withMappedErrors(
      { functionName: "taxModeOf", address: this.address },
      () =>
        this.ctx.publicClient.readContract({
          address: this.address,
          abi: migratorRegistryAbi,
          functionName: "taxModeOf",
          args: [migrator],
        }),
    );
    return mode === 1 ? "HookFee" : "None";
  }

  /**
   * The canonical router recorded for `migrator`, or the zero address for a
   * venue with none.
   *
   * **This is the only source of a token's canonical router in the whole
   * protocol.** A launch reads it here, snapshots it onto the curve immutably,
   * and the curve hands that snapshot to the token at migration. Nothing can
   * change it afterwards — which matters, because it is the address that gets a
   * standing maximum allowance over every holder.
   */
  async routerOf(migrator: Address): Promise<Address> {
    return withMappedErrors({ functionName: "routerOf", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: migratorRegistryAbi,
        functionName: "routerOf",
        args: [migrator],
      }));
  }

  /** How many migrators have ever been registered, **deregistered ones included**. */
  async count(): Promise<bigint> {
    return withMappedErrors({ functionName: "migratorCount", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: migratorRegistryAbi,
        functionName: "migratorCount",
      }));
  }

  /** The `index`-th migrator ever registered, in registration order. */
  async at(index: bigint | number): Promise<Address> {
    return withMappedErrors({ functionName: "migratorAt", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: migratorRegistryAbi,
        functionName: "migratorAt",
        args: [BigInt(index)],
      }));
  }

  /**
   * Every migrator the registry has ever held, with everything a venue picker
   * needs to render one.
   *
   * **Includes deregistered migrators**, and says so through
   * {@link MigratorRegistry.isRegistered} rather than by omitting them: the
   * index list never shrinks, a token that already graduated through a
   * deregistered venue is still governed by it, and silently dropping entries
   * would make the indices in this array stop matching the registry's own.
   *
   * Read one migrator at a time rather than through Multicall3, deliberately.
   * Two of the five reads — `VERSION()` and `poolManager()` — are expected to
   * revert on some venues, so each has to be tolerated individually anyway, and
   * the list is a handful of entries rather than a page.
   */
  async list(): Promise<readonly MigratorInfo[]> {
    const total = await this.count();
    const indices = Array.from({ length: Number(total) }, (_, i) => BigInt(i));
    const addresses = await Promise.all(indices.map((index) => this.at(index)));
    return Promise.all(addresses.map((address) => this.describe(address)));
  }

  /** One migrator, with its derived label and reachability. */
  async describe(migrator: Address): Promise<MigratorInfo> {
    const [taxMode, router, label, poolManager] = await Promise.all([
      this.taxModeOf(migrator),
      this.routerOf(migrator),
      this.optionalLabel(migrator),
      this.optionalPoolManager(migrator),
    ]);
    return {
      address: migrator,
      taxMode,
      router,
      label,
      reachable: await this.reachable(poolManager),
    };
  }

  /**
   * `VERSION()`, or `""`.
   *
   * A migrator that does not answer is unnamed, not broken — and a venue picker
   * that threw rather than rendering it would hide a perfectly selectable
   * target.
   */
  private async optionalLabel(migrator: Address): Promise<string> {
    try {
      return await this.ctx.publicClient.readContract({
        address: migrator,
        abi: uniswapV4MigratorAbi,
        functionName: "VERSION",
      });
    } catch {
      return "";
    }
  }

  /** `poolManager()`, or `undefined` for a venue that has no such notion. */
  private async optionalPoolManager(migrator: Address): Promise<Address | undefined> {
    try {
      return await this.ctx.publicClient.readContract({
        address: migrator,
        abi: uniswapV4MigratorAbi,
        functionName: "poolManager",
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a pool seeded by a migrator with this PoolManager could be traded.
   *
   * `undefined` — no `poolManager()` — is `true`: escrow, v2 and v3 do not have
   * one and the question does not apply. With no `contracts.v4Router`
   * configured a v4 migrator is `false` without a round trip, because there is
   * nothing to trade through. Otherwise the router is asked which manager it
   * serves — the same memoised, immutable read {@link Pool.isReachable} makes —
   * rather than comparing against the preset's `v4.poolManager`, for the reason
   * given there.
   */
  private async reachable(poolManager: Address | undefined): Promise<boolean> {
    if (poolManager === undefined || poolManager === zeroAddress) return true;
    const router = configuredV4Router(this.ctx.config);
    if (router === undefined) return false;
    const served = await routerPoolManager(this.ctx, router);
    return poolManager.toLowerCase() === served.toLowerCase();
  }
}
