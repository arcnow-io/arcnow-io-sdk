/**
 * The platform registry: the protocol's own contract.
 *
 * It creates platforms, holds the protocol's share of every fee and the address
 * that share is paid to, and answers the one question a launch asks — "is this
 * a real platform?".
 *
 * **The registry deploys the `PlatformConfig`, rather than registering an
 * address somebody hands it.** That is the difference between a platform being
 * a configuration and a platform being arbitrary code: a registry that accepted
 * a supplied address would be accepting a contract that can answer one thing to
 * a validation call and another to the launch that follows it. It is also why
 * {@link PlatformRegistry.registerPlatform} is protocol-admin-only.
 *
 * @module
 */

import type { Address } from "viem";
import { parseEventLogs } from "viem";

import type { QuoteAmount, QuoteTokenInfo } from "./amounts.js";
import { Bps, NATIVE_QUOTE } from "./amounts.js";
import type { ClientContext } from "./client.js";
import { assertPlatformVersion, assertRegistryVersion } from "./curve-version.js";
import type { CurveTemplate as CurveTemplateType } from "./curve-template.js";
import { CurveTemplate } from "./curve-template.js";
import { ArcNowError } from "./errors/error.js";
import { withMappedErrors } from "./errors/map.js";
import type { FeeConfig, NewPlatform } from "./fees.js";
import { validateNewPlatform } from "./fees.js";
import { platformConfigAbi, platformRegistryAbi } from "./generated/abi/index.js";
import { requireContract } from "./networks.js";
import { QuoteRegistry } from "./quote-registry.js";

/** What a registration produced. */
export interface RegisterPlatformResult {
  /** The deployed `PlatformConfig`. This address **is** the platform's identity everywhere. */
  readonly platform: Address;
  /** The platform's own residual share of the fee, under the maximum protocol share. */
  readonly platformShareBps: Bps;
  /** The transaction. */
  readonly txHash: `0x${string}`;
}

/** One platform's current settings — a template for its next launch, never a control over one. */
export interface PlatformSettings {
  /** Who may change these settings. */
  readonly admin: Address;
  /** Where the platform's own share of every fee is sent. */
  readonly feeRecipient: Address;
  /** Creator's share, bps of the fee. */
  readonly creatorShareBps: Bps;
  /** Referrer's share, bps of the fee. */
  readonly refShareBps: Bps;
  /** The platform's own share: the residual. Not an input anywhere. */
  readonly platformShareBps: Bps;
  /** Where this platform's tokens graduate to unless the creator picks otherwise. */
  readonly defaultMigrator: Address;
  /** The platform's `VERSION()`: always `arcnow/platform-config@4.x.x`, or it is refused. */
  readonly version: string;
}

/** Read and write the platform registry. Reached as `client.platforms`. */
export class PlatformRegistry {
  private readonly ctx: ClientContext;

  /** The registry's address on this network. */
  readonly address: Address;

  constructor(context: ClientContext) {
    this.ctx = context;
    this.address = requireContract(context.config, "platformRegistry");
  }

  /**
   * The protocol's share of every fee, bps **of the fee**.
   *
   * Protocol-controlled and identical for every platform. This is the invariant
   * that makes multi-platform work: a platform chooses how the other 7500 bps
   * are spent and never how much the protocol takes. It is clamped to
   * `[1000, 2500]`, and the ceiling equals the shipped default — the protocol
   * may lower its cut, never raise it.
   */
  async protocolShareBps(): Promise<Bps> {
    return withMappedErrors(
      { functionName: "protocolShareBps", address: this.address },
      async () =>
        Bps.of(
          await this.ctx.publicClient.readContract({
            address: this.address,
            abi: platformRegistryAbi,
            functionName: "protocolShareBps",
          }),
        ),
    );
  }

  /** Where the protocol's share is sent. */
  async protocolRecipient(): Promise<Address> {
    return withMappedErrors(
      { functionName: "protocolRecipient", address: this.address },
      () =>
        this.ctx.publicClient.readContract({
          address: this.address,
          abi: platformRegistryAbi,
          functionName: "protocolRecipient",
        }),
    );
  }

  /** The protocol admin: the only account that may register or deregister a platform. */
  async protocolAdmin(): Promise<Address> {
    return withMappedErrors({ functionName: "protocolAdmin", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: platformRegistryAbi,
        functionName: "protocolAdmin",
      }));
  }

  /**
   * True when this address is a config the registry deployed and has not
   * deregistered.
   *
   * A launch checks this **at inclusion**, not at signing: a platform
   * deregistered while a transaction sat in the mempool stops being launchable
   * mid-flight.
   */
  async isPlatform(platform: Address): Promise<boolean> {
    return withMappedErrors({ functionName: "isPlatform", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: platformRegistryAbi,
        functionName: "isPlatform",
        args: [platform],
      }));
  }

  /**
   * How many platforms this registry has ever created.
   *
   * A **creation counter**, not a live count: it includes deregistered ones,
   * and it is what {@link PlatformRegistry.platformAt} indexes into.
   */
  async platformCount(): Promise<bigint> {
    return withMappedErrors({ functionName: "platformCount", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: platformRegistryAbi,
        functionName: "platformCount",
      }));
  }

  /** The `index`-th platform in creation order. */
  async platformAt(index: bigint | number): Promise<Address> {
    return withMappedErrors({ functionName: "platformAt", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: platformRegistryAbi,
        functionName: "platformAt",
        args: [BigInt(index)],
      }));
  }

  /**
   * The complete fee split a launch on this platform would snapshot right now.
   *
   * **The single assembly point.** The platform supplies its three allocations
   * and its own recipient; the registry supplies the protocol share and
   * recipient. The result is validated there — five shares totalling exactly
   * 10,000, both fixed recipients non-zero — before it is returned, so a launch
   * never has to trust either half.
   */
  async feeConfigFor(platform: Address): Promise<FeeConfig> {
    return withMappedErrors(
      { functionName: "feeConfigFor", address: this.address },
      async () => {
        const config = await this.ctx.publicClient.readContract({
          address: this.address,
          abi: platformRegistryAbi,
          functionName: "feeConfigFor",
          args: [platform],
        });
        return {
          creatorShareBps: Bps.of(config.creatorShareBps),
          platformShareBps: Bps.of(config.platformShareBps),
          refShareBps: Bps.of(config.refShareBps),
          protocolShareBps: Bps.of(config.protocolShareBps),
          platformRecipient: config.platformRecipient,
          protocolRecipient: config.protocolRecipient,
        };
      },
    );
  }

  /** Refuse this registry unless it is `arcnow/platform-registry@4.x.x`. */
  private async assertRegistry(): Promise<void> {
    const version = await withMappedErrors({ functionName: "VERSION", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: platformRegistryAbi,
        functionName: "VERSION",
      }));
    assertRegistryVersion(version, `the platform registry at ${this.address}`, this.address);
  }

  /** Refuse a `PlatformConfig` unless it is `arcnow/platform-config@2.x.x`. */
  private async assertPlatform(platform: Address): Promise<void> {
    const version = await withMappedErrors({ functionName: "VERSION", address: platform }, () =>
      this.ctx.publicClient.readContract({
        address: platform,
        abi: platformConfigAbi,
        functionName: "VERSION",
      }));
    assertPlatformVersion(version, `the platform at ${platform}`, platform);
  }

  /**
   * One platform's current settings, read off its `PlatformConfig`. Refuses a
   * platform of any version but `arcnow/platform-config@2.x.x`.
   */
  async settings(platform: Address): Promise<PlatformSettings> {
    return withMappedErrors(
      { functionName: "platformConfig", address: platform },
      async () => {
        const version = await this.ctx.publicClient.readContract({
          address: platform,
          abi: platformConfigAbi,
          functionName: "VERSION",
        });
        assertPlatformVersion(version, `the platform at ${platform}`, platform);
        const common = { address: platform, abi: platformConfigAbi } as const;
        const [
          admin, feeRecipient, creatorShareBps, refShareBps,
          platformShareBps, defaultMigrator,
        ] = await Promise.all([
          this.ctx.publicClient.readContract({ ...common, functionName: "admin" }),
          this.ctx.publicClient.readContract({ ...common, functionName: "feeRecipient" }),
          this.ctx.publicClient.readContract({ ...common, functionName: "creatorShareBps" }),
          this.ctx.publicClient.readContract({ ...common, functionName: "refShareBps" }),
          this.ctx.publicClient.readContract({ ...common, functionName: "platformShareBps" }),
          this.ctx.publicClient.readContract({ ...common, functionName: "defaultMigrator" }),
        ]);
        return {
          admin,
          feeRecipient,
          creatorShareBps: Bps.of(creatorShareBps),
          refShareBps: Bps.of(refShareBps),
          platformShareBps: Bps.of(platformShareBps),
          defaultMigrator,
          version,
        };
      },
    );
  }

  /**
   * Check a curve template against the contracts' own relationships, without
   * storing it and without a signer.
   *
   * The two curve relationships are transcendental and cannot be checked
   * honestly in floating point, so this asks `PlatformConfig.checkCurveParameters`
   * — a `pure` function — and lets the specific error come back:
   * `InitialPriceMismatch`, `GraduationTargetMismatch`, `CurveNotPriceable`,
   * `InvalidSupplies` or `PoolReserveMismatch`, each mapped to a sentence
   * saying which relationship broke.
   *
   * @param platform Any live `PlatformConfig` — the function is pure, so it
   *                 does not matter which one; the network's `arcnowPlatform`
   *                 is the obvious choice.
   */
  async checkCurveTemplate(template: CurveTemplateType, platform?: Address): Promise<void> {
    CurveTemplate.checkSupplies(template);
    const target = platform ?? requireContract(this.ctx.config, "arcnowPlatform");
    await this.assertPlatform(target);
    await withMappedErrors(
      { functionName: "checkCurveParameters", address: target },
      () =>
        this.ctx.publicClient.readContract({
          address: target,
          abi: platformConfigAbi,
          functionName: "checkCurveParameters",
          args: [CurveTemplate.encode(template)],
        }),
    );
  }

  /**
   * Deploy and register a new platform.
   *
   * **Callable only by the registry's `protocolAdmin`. An ordinary caller gets
   * `NotProtocolAdmin`, and that is the single most likely surprise in this
   * API.** The registry deploys every `PlatformConfig` itself so that
   * `isPlatform` certifies code rather than a claim, and it will not deploy one
   * on behalf of an arbitrary caller. If you want to launch tokens, you do not
   * need a platform of your own: launch under the network's `arcnowPlatform`,
   * which is the default.
   *
   * {@link NewPlatform} has **no platform-share field**. The platform's own cut
   * is the residual — `10000 - protocol - creator - ref` — and this method
   * computes it and returns it so the caller can see what they chose. The
   * `creator + ref <= 7500` rule is checked here, before any gas is
   * spent, with an error that states the residual being asked for.
   */
  /**
   * The curve template `platform` serves for launches in `quote` (native USDC
   * when omitted): what the next launch in that quote snapshots. Refuses a
   * platform of another version first.
   *
   * @throws {ArcNowError} `NoCurveParameters` when the platform has not enabled
   *   that quote — launches in it are refused with `QuoteNotEnabledOnPlatform`.
   */
  async curveParametersFor(
    platform: Address,
    quote: Address | QuoteTokenInfo = NATIVE_QUOTE,
  ): Promise<CurveTemplateType> {
    await this.assertPlatform(platform);
    const token = typeof quote === "string" ? await this.ctx.quoteTokenInfo(quote) : quote;
    return withMappedErrors({ functionName: "curveParametersFor", address: platform }, async () =>
      CurveTemplate.decode(
        await this.ctx.publicClient.readContract({
          address: platform,
          abi: platformConfigAbi,
          functionName: "curveParametersFor",
          args: [token.address],
        }),
        token,
      ));
  }

  /** True when `platform` serves a template for `quote`, so a launch in it is enabled there. */
  async hasCurveParameters(platform: Address, quote: Address = NATIVE_QUOTE): Promise<boolean> {
    await this.assertPlatform(platform);
    return withMappedErrors({ functionName: "hasCurveParameters", address: platform }, () =>
      this.ctx.publicClient.readContract({
        address: platform,
        abi: platformConfigAbi,
        functionName: "hasCurveParameters",
        args: [quote],
      }));
  }

  async registerPlatform(platform: NewPlatform): Promise<RegisterPlatformResult> {
    const { platformShare } = validateNewPlatform(platform);
    if (!platform.curve.quoteToken.isNative) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          `a platform registers with its native USDC template, and this one is priced in `
          + `${platform.curve.quoteToken.symbol}. Register with the native template, then enable `
          + "another quote with the platform admin's setCurveParameters(quote, template).",
        details: { quoteToken: platform.curve.quoteToken.address },
      });
    }
    const { wallet, account } = this.ctx.requireSigner("platforms.registerPlatform");
    await this.ctx.assertChain();
    // Before anything is simulated: a registry of another version may read the
    // template's slots as other quantities.
    await this.assertRegistry();

    return withMappedErrors(
      { functionName: "registerPlatform", address: this.address },
      async () => {
        const shares = [
          platform.admin,
          platform.feeRecipient,
          platform.creatorShareBps.bps,
          platform.refShareBps.bps,
          platform.defaultMigrator,
        ] as const;
        const { request, result } = await this.ctx.publicClient.simulateContract({
          address: this.address,
          abi: platformRegistryAbi,
          functionName: "registerPlatform",
          args: [...shares, CurveTemplate.encode(platform.curve)],
          account,
          chain: this.ctx.chain,
        });
        const txHash = await wallet.writeContract(request);
        const receipt = await this.ctx.publicClient.waitForTransactionReceipt({
          hash: txHash,
        });
        const registered = parseEventLogs({
          abi: platformRegistryAbi,
          eventName: "PlatformRegistered",
          logs: receipt.logs,
        })[0];
        if (!registered) {
          throw new ArcNowError({
            code: "RpcFailure",
            message:
              "the registration was mined but carries no PlatformRegistered log. The "
              + "registry emits it with the whole opening configuration, so an indexer can "
              + "register a platform from that log alone; its absence means this receipt "
              + "is not what it appears to be.",
            details: { txHash },
          });
        }
        return {
          platform: registered.args.platform ?? result,
          platformShareBps: platformShare,
          txHash,
        };
      },
    );
  }

  /** The flat launch fee, the protocol share and the trade fee, for a UI's fee panel. */
  async protocolSummary(): Promise<{
    protocolShareBps: Bps;
    protocolRecipient: Address;
    launchFee: QuoteAmount;
  }> {
    const [protocolShare, recipient, registration] = await Promise.all([
      this.protocolShareBps(),
      this.protocolRecipient(),
      new QuoteRegistry(this.ctx).info(NATIVE_QUOTE),
    ]);
    return {
      protocolShareBps: protocolShare,
      protocolRecipient: recipient,
      launchFee: registration.launchFee,
    };
  }
}
