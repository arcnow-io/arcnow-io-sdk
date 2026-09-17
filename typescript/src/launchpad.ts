/**
 * The launchpad: what a launch costs, where it will land, and doing it.
 *
 * One transaction deploys the token, deploys its curve bound to it, takes the
 * flat launch fee and performs the creator's optional initial buy. There is no
 * window in which a token exists with a curve that has not been deployed, and
 * no window in which somebody else can front-run the creator's first buy.
 *
 * @module
 */

import type { Account, Address } from "viem";
import { parseEventLogs, zeroAddress } from "viem";

import type { QuoteAmount, QuoteTokenInfo } from "./amounts.js";
import { Bps, NATIVE_QUOTE, QuoteAmount as Quote, Tokens, Usdc } from "./amounts.js";
import type { ClientContext } from "./client.js";
import { ArcNowError } from "./errors/error.js";
import { withMappedErrors } from "./errors/map.js";
import { assertLaunchpadVersion, assertPlatformVersion } from "./curve-version.js";
import { CurveTemplate } from "./curve-template.js";
import { bondingCurveAbi, launchpadAbi, platformConfigAbi } from "./generated/abi/index.js";
import { requireContract } from "./networks.js";
import { QuoteRegistry } from "./quote-registry.js";
import {
  allowanceOverride,
  QuoteToken,
  requireSameQuote,
  signerAddressOf,
  erc20GasLimit,
} from "./quote-token.js";

/** The launchpad's version check, memoised per client; a failed read is evicted. */
const launchpadChecked = new WeakMap<ClientContext, Promise<void>>();
import type { LaunchParams, LaunchQuote, LaunchResult } from "./types.js";

/**
 * The gas limit this SDK sends for a launch whose initial buy will graduate the
 * curve: 8,000,000. Also the figure to pass on a graduating curve buy.
 *
 * A ceiling, not a charge: unused gas is not paid for. It clears every
 * measured graduation with room — a launch
 * whose initial buy graduates (receipt `gasUsed` 5,298,297, instant migration
 * only above ≈5,880,000) by 36%, and its graduating buy (`gasUsed` 741,432,
 * migrates only above ≈845,500) nearly tenfold — and it is sized, like the
 * floor below, for the heaviest venue a curve could graduate into, not for v4.
 *
 * **Nothing smaller can be estimated into existence.** See
 * {@link LaunchParams.gasLimit}.
 */
export const GRADUATION_GAS_LIMIT = 8_000_000n;

/**
 * The lowest gas limit this SDK will send on a launch that the quote says will
 * graduate: 6,200,000.
 *
 * **Derived, not measured.** The curve forwards at most
 * `INSTANT_MIGRATION_GAS_LIMIT` (6,000,000) to its migrator and keeps
 * `POST_MIGRATION_GAS_RESERVE` (100,000) back for itself; with 100,000 of
 * margin that is 6,200,000, the budget below which the heaviest venue's
 * migration could not fit however the rest of the transaction went.
 *
 * **Checked against what was measured** on an Arc fork (arcnow-io/contracts README):
 *
 * | transaction | receipt gasUsed | migrates instantly only above |
 * | --- | --- | --- |
 * | launch whose initial buy graduates | 5,298,297 | ≈ 5,880,000 |
 * | graduating curve buy | 741,432 | ≈ 845,500 |
 *
 * The floor clears the launch threshold by 5.4%. Below the threshold
 * the transaction still **succeeds** — the curve catches a starved migration
 * and logs `InstantMigrationFailed` — so the token graduates with no market and
 * no error anywhere. An explicit limit under this floor on a graduating launch
 * is refused rather than sent; anything at or above it is the caller's call.
 */
export const GRADUATION_GAS_FLOOR = 6_200_000n;

/**
 * The gas limit to send for a launch, given what the quote says.
 *
 * Exported so it can be tested without a chain; it is not part of the package's
 * public surface and `index.ts` does not re-export it.
 *
 * Three cases, and the middle one is the whole point of this method:
 *
 * * an explicit `gasLimit` is honoured — with one refusal, below;
 * * no `gasLimit` on a launch the quote says will **graduate** gets
 *   {@link GRADUATION_GAS_LIMIT}, because `eth_estimateGas` returns the limit
 *   at which the migration inside the launch does not fit. The launch
 *   succeeds either way: the curve catches a starved migration and logs it
 *   rather than reverting, so the estimator's search converges on exactly the
 *   wrong number. A default that is right beats a footgun that is documented;
 * * no `gasLimit` on an ordinary launch gets nothing, and the node estimates
 *   as usual. That estimate is correct and cheaper.
 *
 * The refusal: an explicit limit below {@link GRADUATION_GAS_FLOOR} on a
 * graduating launch is rejected before anything is sent. It is not a limit
 * that makes the launch fail — it is one that makes it succeed and quietly do
 * half the job, which is worse, and the caller has said enough about their
 * intent for the SDK to know they did not mean it.
 */
export function resolveLaunchGas(
  params: LaunchParams,
  graduates: boolean,
): bigint | undefined {
  if (params.gasLimit === undefined) {
    return graduates ? GRADUATION_GAS_LIMIT : undefined;
  }
  if (graduates && params.gasLimit < GRADUATION_GAS_FLOOR) {
    throw new ArcNowError({
      code: "InvalidArgument",
      message:
        `this launch's initial buy graduates the curve, and gasLimit (${params.gasLimit}) is `
        + `below the ${GRADUATION_GAS_FLOOR} the migration needs. The transaction would still `
        + "succeed: the curve attempts the migration under a bounded budget and CATCHES its "
        + "failure, so you would get a token that graduated the moment it was created and has "
        + "no market, with no error anywhere. Leave gasLimit out and the SDK sends "
        + `${GRADUATION_GAS_LIMIT}, or pass at least ${GRADUATION_GAS_FLOOR} yourself — it is a `
        + "ceiling, not a charge.",
      details: { gasLimit: params.gasLimit, floor: GRADUATION_GAS_FLOOR },
    });
  }
  return params.gasLimit;
}

/** The tuple `ILaunchpad.LaunchParams` is encoded as. */
interface EncodedLaunchParams {
  name: string;
  symbol: string;
  metadataURI: string;
  initialBuyWad: bigint;
  minTokensOutWad: bigint;
  platform: Address;
  migrator: Address;
  quoteToken: Address;
  maxLaunchFeeWad: bigint;
}

/** Read and write the launchpad. Reached as `client.launchpad`. */
export class Launchpad {
  private readonly ctx: ClientContext;

  /** The launchpad's address on this network. */
  readonly address: Address;

  constructor(context: ClientContext) {
    this.ctx = context;
    this.address = requireContract(context.config, "launchpad");
  }

  /**
   * The flat fee to launch a token in `quote` (native USDC when omitted), in that
   * quote, as the quote registry records it **now**. **Zero on both Arc networks
   * for every quote arcnow.io registers: launching is free.** The protocol admin
   * may change it, which is why it is read rather than assumed; a launch caps
   * what it pays with `LaunchParams.maxLaunchFee`.
   *
   * **Not the only charge.** The creator's initial buy is an ordinary buy and
   * pays the 1% trade fee on top of this. {@link Launchpad.quoteLaunch} reports
   * the two separately.
   *
   * @throws {ArcNowError} `QuoteTokenNotRegistered` for a quote never registered.
   */
  async launchFee(quote: Address = NATIVE_QUOTE): Promise<QuoteAmount> {
    return (await new QuoteRegistry(this.ctx).info(quote)).launchFee;
  }

  /** The quote registry this launchpad checks every launch's quote against. Immutable. */
  async quoteTokenRegistry(): Promise<Address> {
    return new QuoteRegistry(this.ctx).address();
  }

  /**
   * The trade fee written onto every new curve and token: 100 bps, 1%.
   *
   * Immutable and the same for every platform. **What a platform chooses is how
   * that 1% is divided, never how large it is.**
   */
  async tradeFeeBps(): Promise<Bps> {
    return withMappedErrors({ functionName: "tradeFeeBps", address: this.address }, async () =>
      Bps.of(
        await this.ctx.publicClient.readContract({
          address: this.address,
          abi: launchpadAbi,
          functionName: "tradeFeeBps",
        }),
      ));
  }

  /** Where the flat launch fee goes. Immutable, and unrelated to any trade fee. */
  async feeRecipient(): Promise<Address> {
    return withMappedErrors({ functionName: "feeRecipient", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: launchpadAbi,
        functionName: "feeRecipient",
      }));
  }

  /**
   * How many launches this creator has performed.
   *
   * Feeds the CREATE2 salt, so a creator's launches cannot collide with each
   * other or be squatted by anyone else — and so a prediction is only valid at
   * the nonce it was made at.
   */
  async launchNonce(creator: Address): Promise<bigint> {
    return withMappedErrors({ functionName: "launchNonce", address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: launchpadAbi,
        functionName: "launchNonce",
        args: [creator],
      }));
  }

  /**
   * What a launch would cost and deliver, without executing it.
   *
   * `totalCost` is **exactly** the value {@link Launchpad.launch} requires — not
   * a minimum. The launchpad reverts with `IncorrectPayment` on an overpayment
   * as readily as on an underpayment, because it has no refund path and will
   * not strand your change.
   */
  async quoteLaunch(params: LaunchParams): Promise<LaunchQuote> {
    const encoded = this.encode(params);
    const token = params.initialBuy.token;
    await this.assertLaunchpad();
    return withMappedErrors({ functionName: "quoteLaunch", address: this.address }, async () => {
      const [launchFeeWad, nativeValueWad, tokensOutWad, tradeFeeWad]
        = await this.ctx.publicClient.readContract({
          address: this.address,
          abi: launchpadAbi,
          functionName: "quoteLaunch",
          args: [encoded],
        });
      const launchFee = Quote.fromWad(token, launchFeeWad);
      const tradeFee = Quote.fromWad(token, tradeFeeWad);
      const tokensOut = Tokens.fromWad(tokensOutWad);
      await this.assertPlatform(encoded.platform);
      const graduates = await this.wouldGraduate(encoded.platform, params, tradeFee, tokensOut);
      return {
        quoteToken: token,
        launchFee,
        initialBuy: params.initialBuy,
        totalCost: launchFee.add(params.initialBuy),
        nativeValue: Usdc.fromWad(nativeValueWad),
        tokensOut,
        tradeFee,
        graduates,
      };
    });
  }

  /**
   * Refuse a launchpad that is not `arcnow/launchpad@3.x.x` before a quote or a
   * launch is encoded against it: another build's `LaunchParams` has other
   * fields. Read once per client.
   */
  private assertLaunchpad(): Promise<void> {
    const cached = launchpadChecked.get(this.ctx);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const version = await withMappedErrors(
        { functionName: "VERSION", address: this.address },
        () => this.ctx.publicClient.readContract({
          address: this.address,
          abi: launchpadAbi,
          functionName: "VERSION",
        }),
      );
      assertLaunchpadVersion(version, `the launchpad at ${this.address}`, this.address);
    })();
    launchpadChecked.set(this.ctx, pending);
    pending.catch(() => {
      if (launchpadChecked.get(this.ctx) === pending) launchpadChecked.delete(this.ctx);
    });
    return pending;
  }

  /** `launch` simulated with the launchpad's allowance overridden, when the slot is known. */
  private async preflightLaunch(
    launchArgs: EncodedLaunchParams,
    token: QuoteTokenInfo,
    account: Account | Address,
  ): Promise<void> {
    const owner = signerAddressOf(account);
    const stateOverride = allowanceOverride(this.ctx, token, owner, this.address);
    if (stateOverride === undefined) return;
    await withMappedErrors({ functionName: "launch", address: this.address }, () =>
      this.ctx.publicClient.simulateContract({
        address: this.address,
        abi: launchpadAbi,
        functionName: "launch",
        args: [launchArgs],
        account,
        chain: this.ctx.chain,
        stateOverride,
      }));
  }

  /**
   * Refuse a platform that is not `arcnow/platform-config@2.x.x`, before its
   * template is decoded or anything is sent: another version's template may
   * put another quantity in the same slot.
   */
  private async assertPlatform(platform: Address): Promise<void> {
    const version = await this.ctx.publicClient.readContract({
      address: platform,
      abi: platformConfigAbi,
      functionName: "VERSION",
    });
    assertPlatformVersion(version, `the platform at ${platform}`, platform);
  }

  /**
   * Whether the initial buy alone would take the new curve to its target.
   *
   * `quoteLaunch` on the launchpad reports cost and fill and throws the
   * graduation flag away, so this reconstructs it from the platform's **live**
   * curve template and the curve's own rule: a buy graduates when the reserve it
   * leaves behind reaches the target, **or** when it clears the curve's whole
   * inventory. On a fresh curve the reserve it leaves behind is exactly the input
   * net of its fee, both of which the quote already reports.
   *
   * The template is read from the chain and never from
   * `CurveTemplate.arcnowDefaults()`: a platform admin can change it at any time,
   * and a constant here would decide, silently and wrongly, whether this launch
   * gets a gas limit that lets its migration run.
   */
  private async wouldGraduate(
    platform: Address,
    params: LaunchParams,
    tradeFee: QuoteAmount,
    tokensOut: Tokens,
  ): Promise<boolean> {
    if (params.initialBuy.isZero()) return false;
    const token: QuoteTokenInfo = params.initialBuy.token;
    const raw = await this.ctx.publicClient.readContract({
      address: platform,
      abi: platformConfigAbi,
      functionName: "curveParametersFor",
      args: [token.address],
    });
    const template = CurveTemplate.decode(raw, token);
    const reserveAfter = params.initialBuy.subSaturating(tradeFee);
    return !reserveAfter.lt(template.target) || !tokensOut.lt(template.curveSupply);
  }

  /**
   * The addresses this creator's next launch of exactly these parameters would
   * produce. Deploys nothing.
   *
   * **Valid only for that creator's current launch nonce and only for exactly
   * those parameters.** Change a character of the name, or launch something
   * else first, and both addresses move.
   */
  async predictAddresses(
    creator: Address,
    params: LaunchParams,
  ): Promise<{ token: Address; curve: Address }> {
    const encoded = this.encode(params);
    return withMappedErrors(
      { functionName: "predictAddresses", address: this.address },
      async () => {
        const [token, curve] = await this.ctx.publicClient.readContract({
          address: this.address,
          abi: launchpadAbi,
          functionName: "predictAddresses",
          args: [creator, encoded],
        });
        return { token, curve };
      },
    );
  }

  /**
   * Launch a token.
   *
   * **The quote is `params.initialBuy.token`.** For native USDC the launch sends
   * exactly the quoted `nativeValue` (launch fee plus initial buy) as its value.
   * For an ERC-20 quote it sends no value: the launchpad pulls fee plus initial
   * buy, so when the allowance falls short the SDK first approves **exactly**
   * the quoted total and waits for it ({@link LaunchResult.approvalTxHash}).
   * Either way the launch fee is capped at `maxLaunchFee`, which defaults to the
   * fee just quoted.
   *
   * **A launch whose initial buy reaches the graduation target is sent with an
   * explicit gas limit, chosen here.** The quote already says whether that will
   * happen, and an estimate is precisely the limit at which the migration
   * inside the launch is starved and caught — so the token would be created,
   * graduated, and left with no market, with nothing anywhere reporting an
   * error. This was observed live on Arc testnet. See
   * {@link LaunchParams.gasLimit} for the mechanism and
   * {@link GRADUATION_GAS_LIMIT} for the figure; pass `gasLimit` to override
   * it.
   *
   * The result is read out of the launch's **own receipt** — the `Launched` log
   * for the addresses and the fill, the curve's `Graduated`,
   * `InstantMigrationFailed` and `Migrated` logs for what happened after — so
   * what it reports is what this transaction did, rather than what the chain
   * looks like by the time anyone reads it.
   */
  async launch(params: LaunchParams): Promise<LaunchResult> {
    // The free checks first: `encode` rejects an empty name, symbol or metadata
    // URI without asking anybody, and a caller with no signer should hear about
    // that before they hear about the network.
    this.encode(params);
    // Dust below one raw unit of an ERC-20 quote cannot be pulled; refuse it here.
    params.initialBuy.toRaw();
    params.maxLaunchFee?.toRaw();
    const { wallet, account } = this.ctx.requireSigner("launchpad.launch");
    await this.ctx.assertChain();

    const quote = await this.quoteLaunch(params);
    const launchFee = quote.launchFee;
    const gas = resolveLaunchGas(params, quote.graduates);
    // The fee cap defaults to the fee just quoted: a raise while this waits in
    // the mempool reverts LaunchFeeAboveMaximum instead of overcharging.
    const launchArgs = this.encode(params, params.maxLaunchFee?.wad ?? launchFee.wad);
    // An ERC-20 quote is pulled: fee plus initial buy, approved exactly, and only
    // when the current allowance to the launchpad falls short.
    const approvalTxHash = quote.quoteToken.isNative
      ? undefined
      : (await new QuoteToken(this.ctx, quote.quoteToken).ensureAllowance(
          this.address, quote.totalCost, {
            // A launch that would revert anyway costs no approve.
            beforeApprove: () => this.preflightLaunch(launchArgs, quote.quoteToken, account),
          })).txHash;

    return withMappedErrors(
      {
        functionName: "launch",
        address: this.address,
        launchFee,
        initialBuy: params.initialBuy,
        quoteToken: quote.quoteToken,
        gasLimit: gas,
      },
      async () => {
        // A native launch sends what resolveLaunchGas chose. An ERC-20 launch's fee
        // shares pass contracts#23's gas guard, so a caller's limit is only ever
        // raised: to GRADUATION_GAS_LIMIT on a graduating launch (the floor was
        // enforced above), to the estimate plus headroom on an ordinary one.
        const sendGas = quote.quoteToken.isNative
          ? gas
          : quote.graduates
            ? (gas !== undefined && gas > GRADUATION_GAS_LIMIT ? gas : GRADUATION_GAS_LIMIT)
            : erc20GasLimit(
                await this.ctx.publicClient.estimateContractGas({
                  address: this.address, abi: launchpadAbi, functionName: "launch", args: [launchArgs], account,
                }),
                gas,
              );
        const { request } = await this.ctx.publicClient.simulateContract({
          address: this.address,
          abi: launchpadAbi,
          functionName: "launch",
          args: [launchArgs],
          value: quote.nativeValue.wad,
          account,
          chain: this.ctx.chain,
          // Omitted on an ordinary native launch, where the node's estimate is
          // correct and cheaper. Present on a graduating one, where it is not.
          ...(sendGas === undefined ? {} : { gas: sendGas }),
        });
        const txHash = await wallet.writeContract(request);
        const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

        const launched = parseEventLogs({
          abi: launchpadAbi,
          eventName: "Launched",
          logs: receipt.logs,
        })[0];
        if (!launched) {
          throw new ArcNowError({
            code: "RpcFailure",
            message:
              "the launch transaction was mined but carries no Launched log, which should "
              + "be impossible: the launchpad emits it after the token, the curve and the "
              + "initial buy have all succeeded. Check the receipt on `error.details` — if "
              + "the transaction reverted, the node reported success for a failed "
              + "transaction.",
            details: { txHash, status: receipt.status },
          });
        }
        // Everything below is read from THIS receipt. A later read of the chain
        // answers a different question: `migrate()` is permissionless, so by the
        // time anyone could ask, a stranger may have finished the job and the
        // curve would look identical either way.
        const curve = launched.args.curve.toLowerCase();
        const fromCurve = <T extends { address: string }>(logs: readonly T[]): T[] =>
          logs.filter((log) => log.address.toLowerCase() === curve);
        const graduated = fromCurve(parseEventLogs({
          abi: bondingCurveAbi,
          eventName: "Graduated",
          logs: receipt.logs,
        })).length > 0;
        const migrationFailed = fromCurve(parseEventLogs({
          abi: bondingCurveAbi,
          eventName: "InstantMigrationFailed",
          logs: receipt.logs,
        })).length > 0;
        const migratedHere = fromCurve(parseEventLogs({
          abi: bondingCurveAbi,
          eventName: "Migrated",
          logs: receipt.logs,
        }))[0];

        return {
          token: launched.args.token,
          curve: launched.args.curve,
          tokensOut: Tokens.fromWad(launched.args.tokensOutWad),
          graduated,
          instantMigrationFailed: migrationFailed,
          migratedInThisTransaction: migratedHere !== undefined,
          pool:
            migratedHere && migratedHere.args.pool !== zeroAddress
              ? migratedHere.args.pool
              : undefined,
          approvalTxHash,
          txHash,
          receipt,
        };
      },
    );
  }

  /**
   * Push accrued launch fees to the immutable fee recipient. Permissionless.
   *
   * Fees accrue rather than being pushed on every launch for the same reason
   * trade fees are deferred on failure: a blocklisted or reverting recipient
   * must not be able to make every launch fail.
   */
  async collectLaunchFees(
    quote: Address = NATIVE_QUOTE,
  ): Promise<{ amount: QuoteAmount; txHash: `0x${string}` }> {
    const { wallet, account } = this.ctx.requireSigner("launchpad.collectLaunchFees");
    await this.ctx.assertChain();
    await this.assertLaunchpad();
    const token = await this.ctx.quoteTokenInfo(quote);
    return withMappedErrors(
      { functionName: "collectLaunchFees", address: this.address },
      async () => {
        const { request, result } = await this.ctx.publicClient.simulateContract({
          address: this.address,
          abi: launchpadAbi,
          functionName: "collectLaunchFees",
          args: [quote],
          account,
          chain: this.ctx.chain,
        });
        const txHash = await wallet.writeContract(request);
        await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
        return { amount: Quote.fromWad(token, result), txHash };
      },
    );
  }

  /** Launch fees taken in `quote` (native USDC when omitted) and not yet pushed, in that quote. */
  async accruedFees(quote: Address = NATIVE_QUOTE): Promise<QuoteAmount> {
    await this.assertLaunchpad();
    const token = await this.ctx.quoteTokenInfo(quote);
    return withMappedErrors({ functionName: "accruedFeesWad", address: this.address }, async () =>
      Quote.fromWad(
        token,
        await this.ctx.publicClient.readContract({
          address: this.address,
          abi: launchpadAbi,
          functionName: "accruedFeesWad",
          args: [quote],
        }),
      ));
  }

  /**
   * Fill in the defaults and check what can be checked without an RPC.
   *
   * **The two omissions are resolved in different places, and that difference
   * is deliberate.**
   *
   * An omitted `platform` is resolved *here*, to the network's
   * `arcnowPlatform` — arcnow.io's own config, one platform among however many
   * the registry admits and simply the one whose address is known before you
   * have read a log. The launchpad has no default platform of its own and would
   * reject a zero address with `PlatformNotRegistered`.
   *
   * An omitted `migrator` is resolved by *the contract*: this encodes
   * `address(0)`, which `Launchpad._resolveMigrator` reads as "take this
   * platform's default". Nothing is looked up here, so the default that applies
   * is the platform's at inclusion rather than one read at some earlier moment.
   * That is what almost every launch does.
   *
   * Spelling the two the same way would be wrong in both directions: a zero
   * platform is a revert, and an SDK-substituted migrator would freeze a
   * default that the platform is entitled to change under a pending
   * transaction.
   */
  private encode(
    params: LaunchParams,
    maxLaunchFeeWad = params.maxLaunchFee?.wad ?? 0n,
  ): EncodedLaunchParams {
    if (params.maxLaunchFee !== undefined) {
      requireSameQuote(params.maxLaunchFee, params.initialBuy.token, "this launch (its initial buy's quote)");
    }
    for (const [field, value] of [
      ["name", params.name],
      ["symbol", params.symbol],
      ["metadataUri", params.metadataUri],
    ] as const) {
      if (value.trim() === "") {
        throw new ArcNowError({
          code: "InvalidArgument",
          message:
            `${field} is empty, and the launchpad refuses a launch without one `
            + "(InvalidLaunchParameters). The metadata URI in particular is where every UI "
            + "reads the token's image and description from: a launch without one produces "
            + "a token nothing can display.",
          details: { field },
        });
      }
    }
    return {
      name: params.name,
      symbol: params.symbol,
      metadataURI: params.metadataUri,
      initialBuyWad: params.initialBuy.wad,
      minTokensOutWad: params.minTokensOut.wad,
      platform: params.platform ?? requireContract(this.ctx.config, "arcnowPlatform"),
      migrator: params.migrator ?? zeroAddress,
      quoteToken: params.initialBuy.token.address,
      maxLaunchFeeWad,
    };
  }
}
