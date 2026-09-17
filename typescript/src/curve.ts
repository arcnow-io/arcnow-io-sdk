/**
 * One bonding curve: what it is worth now, what a trade would do, and doing it.
 *
 * A curve has **no owner, no admin, no pause, no upgrade path and no privileged
 * caller**. Every parameter is set at construction and is immutable. That is
 * load-bearing rather than austerity: the token grants this contract the right
 * to move any holder's balance, and that right is only safe because nobody —
 * creator, factory, launchpad or deployer — can direct it.
 *
 * **Money is the curve's quote token**, fixed at launch: native USDC, where a
 * buy is `msg.value` and a sell is paid with a value transfer, or an allowlisted
 * ERC-20 such as EURC, which a buy pulls with an allowance (approved exactly,
 * only when short) and a sell pays out in raw units. A sell never needs an
 * allowance on the token side. See {@link Curve.buy} and {@link Curve.sell}.
 *
 * @module
 */

import type { Account, Address } from "viem";
import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionZeroDataError,
  parseEventLogs,
  zeroAddress,
} from "viem";

import type { QuoteAmount, QuoteTokenInfo } from "./amounts.js";
import { Bps, QuoteAmount as Quote, Tokens } from "./amounts.js";
import type { ClientContext } from "./client.js";
import { assertCurveVersion, notACurve } from "./curve-version.js";
import type { CurveParams, CurveSnapshot } from "./curve-math.js";
import { CurveMath } from "./curve-math.js";
import { ArcNowError } from "./errors/error.js";
import { mapError, withMappedErrors } from "./errors/map.js";
import { messageFor } from "./errors/messages.js";
import type { FeeConfig, FeeSplit } from "./fees.js";
import { bondingCurveAbi } from "./generated/abi/index.js";
import {
  allowanceOverride,
  QuoteToken,
  requireSameQuote,
  signerAddressOf,
  erc20GasLimit,
  withQuoteTransferHeadroom,
} from "./quote-token.js";
import type {
  BuyQuote,
  BuyRequest,
  BuyResult,
  CurveState,
  MigrateResult,
  SellQuote,
  SellRequest,
  SellResult,
} from "./types.js";

/** A handle on one curve. Built with `client.curve(address)`. */
export class Curve {
  private readonly ctx: ClientContext;

  /** The curve's address. */
  readonly address: Address;

  private cachedVersion: Promise<string> | undefined;
  private cachedQuote: Promise<QuoteTokenInfo> | undefined;

  constructor(context: ClientContext, address: Address) {
    this.ctx = context;
    this.address = address;
  }

  /* ---------------------------------------------------------------------- *
   * Which curve this is
   * ---------------------------------------------------------------------- */

  /**
   * The curve's `VERSION()`, e.g. `"arcnow/bonding-curve@4.0.0"`. Read once and
   * cached: a curve has no upgrade path, so its address is its code for life.
   */
  async version(): Promise<string> {
    const pending = this.cachedVersion ?? this.readVersion();
    this.cachedVersion = pending;
    pending.catch(() => {
      if (this.cachedVersion === pending) this.cachedVersion = undefined;
    });
    return pending;
  }

  /**
   * Refuse this address unless it is an `arcnow/bonding-curve@2.x.x` curve.
   *
   * **Every quote, trade and local price on this handle asks this first.** Any
   * other bonding-curve version — the retired `@1.x.x` included — is refused
   * with `UnknownCurveVersion`, naming the version, and an address that is not a
   * bonding curve at all with `AddressIsNotACurve`, before any maths runs or any
   * trade is simulated.
   */
  private async assertVersion(): Promise<void> {
    assertCurveVersion(await this.version(), `the curve at ${this.address}`, this.address);
  }

  /**
   * `VERSION()`, or `AddressIsNotACurve` when the address answers nothing a curve would.
   *
   * No code at the address, a revert, or return data that is not a string all
   * mean the same thing to a caller — this is not an arcnow.io curve — and are
   * reported as that, with the address. A transport failure is not: it says
   * nothing about the address and stays `RpcFailure`.
   */
  private async readVersion(): Promise<string> {
    try {
      return await this.ctx.publicClient.readContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "VERSION",
      });
    } catch (error) {
      const mapped = mapError(error, { functionName: "VERSION", address: this.address });
      if (mapped.isRevert || answeredNoData(error)) {
        throw notACurve({ address: this.address, subject: `the address ${this.address}`, cause: error });
      }
      throw mapped;
    }
  }

  /**
   * The quote token this curve is priced in — native USDC or an allowlisted
   * ERC-20 — read once off the curve's immutables and cached. Its symbol and name
   * come from the network's `quoteTokens` with no RPC, or one cached read.
   * Refuses a curve of any other version first.
   */
  async quoteToken(): Promise<QuoteTokenInfo> {
    await this.assertVersion();
    const pending = this.cachedQuote ?? this.readQuoteToken();
    this.cachedQuote = pending;
    pending.catch(() => {
      if (this.cachedQuote === pending) this.cachedQuote = undefined;
    });
    return pending;
  }

  private async readQuoteToken(): Promise<QuoteTokenInfo> {
    const [quote, decimals] = await withMappedErrors({ functionName: "quoteToken", address: this.address }, async () => {
      const common = { address: this.address, abi: bondingCurveAbi } as const;
      if (this.ctx.multicallAddress !== undefined) {
        return this.ctx.publicClient.multicall({
          contracts: [{ ...common, functionName: "quoteToken" }, { ...common, functionName: "quoteDecimals" }],
          allowFailure: false,
          multicallAddress: this.ctx.multicallAddress,
        });
      }
      return [
        await this.ctx.publicClient.readContract({ ...common, functionName: "quoteToken" }),
        await this.ctx.publicClient.readContract({ ...common, functionName: "quoteDecimals" }),
      ] as const;
    });
    return this.labelQuote(quote, decimals);
  }

  /** Metadata for the curve's quote, checked against the decimals the curve scales by. */
  private async labelQuote(quote: Address, decimals: number): Promise<QuoteTokenInfo> {
    const info = await this.ctx.quoteTokenInfo(quote);
    if (info.decimals !== decimals) {
      throw new ArcNowError({
        code: "RpcFailure",
        message:
          `the curve at ${this.address} is priced in ${quote} at ${decimals} decimals, and that `
          + `token's metadata says ${info.decimals}. Amounts cannot be scaled while the two `
          + "disagree, so nothing was priced. Check the network's quoteTokens entry.",
        details: {
          address: this.address, quote, curveDecimals: decimals, metadataDecimals: info.decimals,
        },
      });
    }
    return info;
  }

  /**
   * The curve's immutable parameters, `{ r0Wad, y0Wad }`. Refuses a curve of any
   * other version first.
   */
  async params(): Promise<CurveParams> {
    await this.assertVersion();
    return withMappedErrors({ functionName: "params", address: this.address }, async () => {
      const common = { address: this.address, abi: bondingCurveAbi } as const;
      const [r0Wad, y0Wad] = await Promise.all([
        this.ctx.publicClient.readContract({ ...common, functionName: "r0Wad" }),
        this.ctx.publicClient.readContract({ ...common, functionName: "y0Wad" }),
      ]);
      return { r0Wad, y0Wad };
    });
  }

  /* ---------------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------------- */

  /**
   * The curve's whole live state, in **one** round trip.
   *
   * Batched through Multicall3, which is a predeploy on Arc. Eleven separate
   * `eth_call`s would be eleven chances for the state to move underneath the
   * answer, and a state object assembled from reads taken at different blocks
   * can say things that were never true at once — a `tokensSold` from before a
   * trade next to a `spotPrice` from after it.
   *
   * If the batch fails (no Multicall3 on a custom chain, or a client built with
   * `multicall: null`) the reads go out in parallel instead and the object is
   * assembled from whatever block each landed on. Correct, chattier, and no
   * longer atomic.
   */
  async state(): Promise<CurveState> {
    const version = await this.version();
    assertCurveVersion(version, `the curve at ${this.address}`, this.address);
    return withMappedErrors({ functionName: "state", address: this.address }, async () => {
      const raw = await this.readStateBatched();
      const quote = await this.labelQuote(raw[16], raw[17]);
      this.cachedQuote ??= Promise.resolve(quote);
      return {
        version,
        quoteToken: quote,
        params: { r0Wad: raw[12], y0Wad: raw[13] },
        curveSupply: Tokens.fromWad(raw[14]),
        tradeFeeBps: Bps.of(raw[15]),
        token: raw[0],
        creator: raw[1],
        migrator: raw[2],
        spotPrice: Quote.fromWad(quote, raw[3]),
        tokensSold: Tokens.fromWad(raw[4]),
        tokensRemaining: Tokens.fromWad(raw[5]),
        realReserve: Quote.fromWad(quote, raw[6]),
        virtualReserve: Quote.fromWad(quote, raw[7]),
        target: Quote.fromWad(quote, raw[8]),
        progressBps: Bps.of(raw[9]),
        graduated: raw[10],
        migrated: raw[11],
      };
    });
  }

  private async readStateBatched(): Promise<
    [Address, Address, Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
      boolean, boolean, bigint, bigint, bigint, bigint, Address, number]
  > {
    const common = { address: this.address, abi: bondingCurveAbi } as const;
    const calls = [
      { ...common, functionName: "token" },
      { ...common, functionName: "creator" },
      { ...common, functionName: "migrator" },
      { ...common, functionName: "spotPriceWad" },
      { ...common, functionName: "tokensSoldWad" },
      { ...common, functionName: "tokensRemainingWad" },
      { ...common, functionName: "realReserveWad" },
      { ...common, functionName: "virtualReserveWad" },
      { ...common, functionName: "targetQuoteWad" },
      { ...common, functionName: "graduationProgressBps" },
      { ...common, functionName: "graduated" },
      { ...common, functionName: "migrated" },
      { ...common, functionName: "r0Wad" },
      { ...common, functionName: "y0Wad" },
      { ...common, functionName: "curveSupplyWad" },
      { ...common, functionName: "tradeFeeBps" },
      { ...common, functionName: "quoteToken" },
      { ...common, functionName: "quoteDecimals" },
    ] as const;

    if (this.ctx.multicallAddress !== undefined) {
      try {
        return await this.ctx.publicClient.multicall({
          contracts: calls,
          allowFailure: false,
          multicallAddress: this.ctx.multicallAddress,
        });
      } catch {
        // Fall through: a chain without Multicall3 is a perfectly good chain,
        // it just costs more round trips. Nothing about the answer changes
        // except that it is no longer taken at one block.
      }
    }

    const [
      token, creator, migrator, spotPrice, tokensSold, tokensRemaining,
      realReserve, virtualReserve, target, progress, graduated, migrated,
      r0Wad, y0Wad, curveSupply, tradeFee, quote, quoteDecimals,
    ] = await Promise.all([
      this.readNumberless("token"),
      this.readNumberless("creator"),
      this.readNumberless("migrator"),
      this.readNumber("spotPriceWad"),
      this.readNumber("tokensSoldWad"),
      this.readNumber("tokensRemainingWad"),
      this.readNumber("realReserveWad"),
      this.readNumber("virtualReserveWad"),
      this.readNumber("targetQuoteWad"),
      this.readNumber("graduationProgressBps"),
      this.readBoolean("graduated"),
      this.readBoolean("migrated"),
      this.readNumber("r0Wad"),
      this.readNumber("y0Wad"),
      this.readNumber("curveSupplyWad"),
      this.readNumber("tradeFeeBps"),
      this.readNumberless("quoteToken"),
      this.ctx.publicClient.readContract({ address: this.address, abi: bondingCurveAbi, functionName: "quoteDecimals" }),
    ]);
    return [
      token, creator, migrator, spotPrice, tokensSold, tokensRemaining,
      realReserve, virtualReserve, target, progress, graduated, migrated,
      r0Wad, y0Wad, curveSupply, tradeFee, quote, quoteDecimals,
    ];
  }

  private readNumberless(
    functionName: "token" | "creator" | "migrator" | "canonicalRouter" | "quoteToken",
  ): Promise<Address> {
    return this.ctx.publicClient.readContract({
      address: this.address,
      abi: bondingCurveAbi,
      functionName,
    });
  }

  private readNumber(
    functionName:
      | "spotPriceWad" | "tokensSoldWad" | "tokensRemainingWad" | "realReserveWad"
      | "virtualReserveWad" | "targetQuoteWad" | "graduationProgressBps" | "r0Wad" | "y0Wad"
      | "curveSupplyWad" | "tradeFeeBps" | "totalPendingWithdrawalsWad",
  ): Promise<bigint> {
    return this.ctx.publicClient.readContract({
      address: this.address,
      abi: bondingCurveAbi,
      functionName,
    });
  }

  private readBoolean(functionName: "graduated" | "migrated"): Promise<boolean> {
    return this.ctx.publicClient.readContract({
      address: this.address,
      abi: bondingCurveAbi,
      functionName,
    });
  }

  /**
   * Price a buy without executing it.
   *
   * The same code path settles the buy, so a quote and the fill that follows it
   * cannot disagree except by a state change in between. Reverts with
   * `CurveGraduated` on a graduated curve, so a UI cannot display a quote for a
   * trade that cannot happen.
   */
  async quoteBuy(quoteIn: QuoteAmount): Promise<BuyQuote> {
    const token = await this.quoteToken();
    requireSameQuote(quoteIn, token, `the curve at ${this.address}`);
    return withMappedErrors({ functionName: "quoteBuy", address: this.address }, async () => {
      const quote = await this.ctx.publicClient.readContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "quoteBuy",
        args: [quoteIn.wad],
      });
      return {
        tokensOut: Tokens.fromWad(quote.tokensOutWad),
        fee: Quote.fromWad(token, quote.feeQuoteWad),
        quoteSpent: Quote.fromWad(token, quote.quoteSpentWad),
        refund: Quote.fromWad(token, quote.refundWad),
        newReserve: Quote.fromWad(token, quote.newReserveWad),
        newTokensSold: Tokens.fromWad(quote.newTokensSoldWad),
        newPrice: Quote.fromWad(token, quote.newPriceWad),
        graduates: quote.graduates,
      };
    });
  }

  /** Price a sell without executing it. Refuses an unknown curve version first. */
  async quoteSell(tokensIn: Tokens): Promise<SellQuote> {
    const token = await this.quoteToken();
    return withMappedErrors({ functionName: "quoteSell", address: this.address }, async () => {
      const quote = await this.ctx.publicClient.readContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "quoteSell",
        args: [tokensIn.wad],
      });
      return {
        quoteOut: Quote.fromWad(token, quote.quoteOutWad),
        fee: Quote.fromWad(token, quote.feeQuoteWad),
        gross: Quote.fromWad(token, quote.grossQuoteWad),
        newReserve: Quote.fromWad(token, quote.newReserveWad),
        newTokensSold: Tokens.fromWad(quote.newTokensSoldWad),
        newPrice: Quote.fromWad(token, quote.newPriceWad),
      };
    });
  }

  /**
   * Price a buy **locally**, with this curve's own kind of maths, from a state
   * already in hand or one read now.
   *
   * The same numbers the chain's {@link Curve.quoteBuy} returns, to the wei, for
   * the same state: `CurveMath` is a faithful port of both curves' `CurveQuote`
   * and is held to the contracts' published vectors and, on a fork, to real
   * fills. What it cannot know is a trade that lands between the state you pass
   * and your transaction. Refuses a graduated curve with `CurveGraduated`, as
   * the chain does.
   */
  async quoteBuyLocal(quoteIn: QuoteAmount, state?: CurveState): Promise<BuyQuote> {
    const current = state ?? await this.state();
    const token = current.quoteToken;
    requireSameQuote(quoteIn, token, `the curve at ${this.address}`);
    this.refuseGraduated(current, "quoteBuy");
    const quote = CurveMath.quoteBuy(curveSnapshotOf(current), quoteIn.wad);
    return {
      tokensOut: Tokens.fromWad(quote.tokensOutWad),
      fee: Quote.fromWad(token, quote.feeQuoteWad),
      quoteSpent: Quote.fromWad(token, quote.quoteSpentWad),
      refund: Quote.fromWad(token, quote.refundWad),
      newReserve: Quote.fromWad(token, quote.newReserveWad),
      newTokensSold: Tokens.fromWad(quote.newTokensSoldWad),
      newPrice: Quote.fromWad(token, quote.newPriceWad),
      graduates: quote.graduates,
    };
  }

  /** Price a sell locally. See {@link Curve.quoteBuyLocal}. */
  async quoteSellLocal(tokensIn: Tokens, state?: CurveState): Promise<SellQuote> {
    const current = state ?? await this.state();
    this.refuseGraduated(current, "quoteSell");
    const quote = CurveMath.quoteSell(curveSnapshotOf(current), tokensIn.wad);
    const token = current.quoteToken;
    return {
      quoteOut: Quote.fromWad(token, quote.quoteOutWad),
      fee: Quote.fromWad(token, quote.feeQuoteWad),
      gross: Quote.fromWad(token, quote.grossQuoteWad),
      newReserve: Quote.fromWad(token, quote.newReserveWad),
      newTokensSold: Tokens.fromWad(quote.newTokensSoldWad),
      newPrice: Quote.fromWad(token, quote.newPriceWad),
    };
  }

  private refuseGraduated(state: CurveState, functionName: string): void {
    if (!state.graduated) return;
    throw new ArcNowError({
      code: "CurveGraduated",
      message: messageFor("CurveGraduated", "CurveGraduated()", {}, {})
        ?? "this curve has graduated and stopped trading permanently.",
      details: { address: this.address, functionName },
    });
  }

  /**
   * Split a fee exactly as a swap with this `ref` address would.
   *
   * The same arithmetic the swap settles with. The three proportional shares
   * are floored and the platform's is the residual, so the four total the fee
   * exactly at every size — including a fee of one wei, where three shares are
   * zero and the platform takes it all. The ref resolves to the platform
   * recipient when it is unset; the creator resolves to `token.creator()`,
   * read now.
   */
  async previewFeeSplit(fee: QuoteAmount, referrer?: Address): Promise<FeeSplit> {
    requireSameQuote(fee, await this.quoteToken(), `the curve at ${this.address}`);
    return withMappedErrors(
      { functionName: "previewFeeSplit", address: this.address },
      async () => {
        const split = await this.ctx.publicClient.readContract({
          address: this.address,
          abi: bondingCurveAbi,
          functionName: "previewFeeSplit",
          args: [fee.wad, referrer ?? zeroAddress],
        });
        return {
          creator: split.creator,
          platform: split.platform,
          ref: split.ref,
          protocol: split.protocol,
          creatorAmount: Quote.fromWad(fee.token, split.creatorWad),
          platformAmount: Quote.fromWad(fee.token, split.platformWad),
          refAmount: Quote.fromWad(fee.token, split.refWad),
          protocolAmount: Quote.fromWad(fee.token, split.protocolWad),
        };
      },
    );
  }

  /**
   * The four-way fee split this curve snapshotted at construction.
   *
   * Immutable and identical to the token's. No admin anywhere can change what a
   * launched curve charges or who it pays, which is why this design carries no
   * timelock.
   */
  async feeConfig(): Promise<FeeConfig> {
    return withMappedErrors({ functionName: "feeConfig", address: this.address }, async () => {
      const config = await this.ctx.publicClient.readContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "feeConfig",
      });
      return {
        creatorShareBps: Bps.of(config.creatorShareBps),
        platformShareBps: Bps.of(config.platformShareBps),
        refShareBps: Bps.of(config.refShareBps),
        protocolShareBps: Bps.of(config.protocolShareBps),
        platformRecipient: config.platformRecipient,
        protocolRecipient: config.protocolRecipient,
      };
    });
  }

  /**
   * USDC credited to an account after a payout could not be delivered.
   *
   * On Arc the expected cause is the blocklist: a transfer to a blocklisted
   * address reverts, and one blocklisted seller must not be able to wedge the
   * curve for everyone else. The trade still completes; the money is claimable
   * with {@link Curve.withdraw} to any address.
   */
  async pendingWithdrawal(account: Address): Promise<QuoteAmount> {
    const token = await this.quoteToken();
    return withMappedErrors(
      { functionName: "pendingWithdrawalWad", address: this.address },
      async () =>
        Quote.fromWad(
          token,
          await this.ctx.publicClient.readContract({
            address: this.address,
            abi: bondingCurveAbi,
            functionName: "pendingWithdrawalWad",
            args: [account],
          }),
        ),
    );
  }

  /* ---------------------------------------------------------------------- *
   * Trading
   * ---------------------------------------------------------------------- */

  /**
   * Buy tokens with the curve's quote token.
   *
   * - **Native USDC:** `quoteIn` is the transaction's value, through the payable
   *   `buy`. No allowance, no transfer.
   * - **An ERC-20 quote:** `buyWithQuote` pulls it. The amount must be
   *   representable in the token's decimals, and when the allowance to this curve
   *   falls short the SDK first approves **exactly** `quoteIn` and waits for it
   *   ({@link BuyResult.approvalTxHash}). The curve pulls only what it spends.
   *
   * The fee is taken off the input first, so it never enters the reserve, and
   * the remainder is integrated along the curve — **the buyer pays a rising
   * price across their own order**, which is what makes an immediate round trip
   * unprofitable. Quote first.
   *
   * The fill is **capped at the curve's remaining inventory**. If the value
   * would buy more tokens than the curve holds, the buy takes the remainder,
   * the curve graduates, and the unspent USDC comes back — see
   * {@link BuyResult.refund}. If that buy graduates the curve, the migration is
   * attempted in the same transaction under a bounded gas budget with its
   * failure caught; {@link BuyResult.migratedInThisTransaction} says whether it
   * took.
   *
   * **On a buy that might graduate, pass {@link BuyRequest.gasLimit}.** An estimated
   * gas limit is the lowest at which the transaction still succeeds, and a
   * graduating buy succeeds whether or not its migration does — so estimation
   * lands exactly on the limit that starves the migration, and the token
   * graduates with no market and no error anywhere. 8,000,000 is the figure
   * this SDK's fork tests use.
   */
  async buy(request: BuyRequest): Promise<BuyResult> {
    // Argument checks first, signer second, network last. A refusal that needs
    // no round trip should not cost one -- and a caller with no signer should
    // be told that rather than being told their amount is zero.
    if (request.quoteIn.isZero()) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          "a zero-value buy is refused by the curve (ZeroAmount) rather than treated as a "
          + "no-op, so that an integration bug surfaces as a revert instead of an event "
          + "stream full of empty trades. Something upstream produced zero.",
      });
    }
    // Dust below one raw unit of an ERC-20 quote cannot be moved and the curve
    // refuses it: say so before anything is asked of the chain.
    request.quoteIn.toRaw();
    const { wallet, account } = this.ctx.requireSigner("curve.buy");
    await this.ctx.assertChain();
    // Before anything is simulated: a curve whose version this SDK does not know
    // is not traded, whatever its ABI happens to accept.
    await this.assertVersion();
    const token = await this.quoteToken();
    requireSameQuote(request.quoteIn, token, `the curve at ${this.address}`);
    // An ERC-20 quote is pulled by the curve, so it needs an allowance: exactly
    // this buy's, and only when the current one falls short.
    const approvalTxHash = token.isNative
      ? undefined
      : (await new QuoteToken(this.ctx, token).ensureAllowance(this.address, request.quoteIn, {
        // Simulate the buy with the allowance it is about to have BEFORE paying
        // for the approve: a buy that would revert anyway costs no approve.
          beforeApprove: () => this.preflightBuyWithQuote(request, token, account),
        })).txHash;

    return withMappedErrors({
      functionName: token.isNative ? "buy" : "buyWithQuote",
      address: this.address,
      quoteToken: token,
      gasLimit: request.gasLimit,
    }, async () => {
      const referrer = request.referrer ?? zeroAddress;
      // Passed through only when the caller chose one. Without it viem lets the
      // node estimate, and on a graduating buy the estimate is precisely the
      // limit at which the instant migration is starved and caught. See
      // BuyRequest.gasLimit.
      const gas = request.gasLimit === undefined ? {} : { gas: request.gasLimit };
      const txHash = token.isNative
        // Native USDC: the payable buy, paid as the transaction's value.
        ? await wallet.writeContract((await this.ctx.publicClient.simulateContract({
            address: this.address,
            abi: bondingCurveAbi,
            functionName: "buy",
            args: [request.minTokensOut.wad, request.deadline.unixSeconds, referrer],
            value: request.quoteIn.wad,
            account,
            chain: this.ctx.chain,
            ...gas,
          })).request)
        // An ERC-20 quote: buyWithQuote pulls it, and sending value would revert.
        // Its fee shares pass contracts#23's gas guard, so it is never sent at the
        // bare estimate, and a caller's gasLimit is raised to the safe minimum, never lowered.
        : await (async () => {
            const args = [
              request.quoteIn.wad, request.minTokensOut.wad, request.deadline.unixSeconds, referrer,
            ] as const;
            const limit = erc20GasLimit(
              await this.ctx.publicClient.estimateContractGas({
                address: this.address, abi: bondingCurveAbi, functionName: "buyWithQuote", args, account,
              }),
              request.gasLimit,
            );
            return wallet.writeContract((await this.ctx.publicClient.simulateContract({
              address: this.address,
              abi: bondingCurveAbi,
              functionName: "buyWithQuote",
              args,
              account,
              chain: this.ctx.chain,
              gas: limit,
            })).request);
          })();
      const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

      const trade = parseEventLogs({
        abi: bondingCurveAbi,
        eventName: "Trade",
        logs: receipt.logs,
      }).find((log) => log.address.toLowerCase() === this.address.toLowerCase());
      const refunded = parseEventLogs({
        abi: bondingCurveAbi,
        eventName: "BuyRefunded",
        logs: receipt.logs,
      }).find((log) => log.address.toLowerCase() === this.address.toLowerCase());
      const graduated = parseEventLogs({
        abi: bondingCurveAbi,
        eventName: "Graduated",
        logs: receipt.logs,
      }).some((log) => log.address.toLowerCase() === this.address.toLowerCase());
      const migrationFailed = parseEventLogs({
        abi: bondingCurveAbi,
        eventName: "InstantMigrationFailed",
        logs: receipt.logs,
      }).some((log) => log.address.toLowerCase() === this.address.toLowerCase());
      // The Migrated log in THIS receipt is the only proof that the graduating
      // buy migrated the curve itself, rather than leaving it for a later
      // migrate(). Both end with a migrated curve; only one gives the token a
      // market at the moment it graduates.
      const migratedHere = parseEventLogs({
        abi: bondingCurveAbi,
        eventName: "Migrated",
        logs: receipt.logs,
      }).find((log) => log.address.toLowerCase() === this.address.toLowerCase());

      if (!trade) {
        throw new ArcNowError({
          code: "RpcFailure",
          message:
            "the buy was mined but the curve emitted no Trade log, which it does on every "
            + "completed buy. Either the receipt is for a reverted transaction the node "
            + "reported as successful, or this address is not a curve.",
          details: { txHash, address: this.address },
        });
      }

      return {
        tokensOut: Tokens.fromWad(trade.args.tokenAmountWad),
        quoteSpent: Quote.fromWad(token, trade.args.quoteAmountWad),
        refund: refunded
          ? Quote.fromWad(token, refunded.args.refundWad)
          : token.isNative
            ? Quote.zero(token)
            // An ERC-20 buy pulls only what it spends; the rest was never taken.
            : request.quoteIn.subSaturating(Quote.fromWad(token, trade.args.quoteAmountWad)),
        fee: Quote.fromWad(token, trade.args.feeQuoteWad),
        newPrice: Quote.fromWad(token, trade.args.newPriceWad),
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
    });
  }

  /**
   * `buyWithQuote` simulated with the curve's allowance overridden, when the
   * network records the quote's allowance slot. Nothing is sent.
   */
  private async preflightBuyWithQuote(
    request: BuyRequest,
    token: QuoteTokenInfo,
    account: Account | Address,
  ): Promise<void> {
    const owner = signerAddressOf(account);
    const stateOverride = allowanceOverride(this.ctx, token, owner, this.address);
    if (stateOverride === undefined) return;
    await withMappedErrors({ functionName: "buyWithQuote", address: this.address }, () =>
      this.ctx.publicClient.simulateContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "buyWithQuote",
        args: [
          request.quoteIn.wad, request.minTokensOut.wad, request.deadline.unixSeconds,
          request.referrer ?? zeroAddress,
        ],
        account,
        chain: this.ctx.chain,
        stateOverride,
      }));
  }

  /**
   * Sell tokens back to the curve for its quote token.
   *
   * **A sell needs no allowance, ever. This SDK will never emit an approve, and
   * neither should you.**
   *
   * The curve pulls the tokens with the token's `curveTransferFrom`, a
   * privileged path callable only by the token's own curve, which **reads no
   * allowance at all**. A holder who has approved nobody can sell; an allowance
   * granted to the curve is not spent by a sell and is still there afterwards;
   * and an approved spender still cannot use the curve's path. Selling is one
   * transaction with no approve step, and that is a deliberate, tested
   * guarantee — `contracts/test/unit/TokenCurveSell.t.sol` asserts each of those
   * three facts.
   *
   * The token *does* have ordinary `approve`/`allowance`/`transferFrom` for
   * everybody else — routers, other spenders — and after migration the
   * canonical router is auto-approved for every holder. That is a separate
   * system from the curve's privilege and the two must not be confused: an
   * allowance can be spent by whoever holds it, and the curve's privilege is
   * checked against `msg.sender` on every call.
   *
   * The pull and the payment are atomic: a code path that takes tokens without
   * paying does not exist. If the payout transfer fails — on Arc, a blocklisted
   * seller — the sale still completes and the proceeds are credited to
   * {@link Curve.pendingWithdrawal} for the seller to pull elsewhere.
   */
  async sell(request: SellRequest): Promise<SellResult> {
    if (request.tokensIn.isZero()) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          "a zero-token sell is refused by the curve (ZeroAmount) rather than treated as a "
          + "no-op. Check the amount you computed.",
      });
    }
    const { wallet, account } = this.ctx.requireSigner("curve.sell");
    await this.ctx.assertChain();
    await this.assertVersion();
    const token = await this.quoteToken();
    requireSameQuote(request.minQuoteOut, token, `the curve at ${this.address}`);

    return withMappedErrors({
      functionName: "sell", address: this.address, quoteToken: token,
    }, async () => {
      const args = [
        request.tokensIn.wad,
        request.minQuoteOut.wad,
        request.deadline.unixSeconds,
        request.referrer ?? zeroAddress,
      ] as const;
      // An ERC-20 payout's fee shares pass contracts#23's gas guard: never the bare estimate.
      const gas = token.isNative
        ? undefined
        : withQuoteTransferHeadroom(
            await this.ctx.publicClient.estimateContractGas({
              address: this.address, abi: bondingCurveAbi, functionName: "sell", args, account,
            }),
          );
      const { request: prepared } = await this.ctx.publicClient.simulateContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "sell",
        args,
        account,
        chain: this.ctx.chain,
        ...(gas === undefined ? {} : { gas }),
      });
      const txHash = await wallet.writeContract(prepared);
      const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });

      const trade = parseEventLogs({
        abi: bondingCurveAbi,
        eventName: "Trade",
        logs: receipt.logs,
      }).find((log) => log.address.toLowerCase() === this.address.toLowerCase());
      if (!trade) {
        throw new ArcNowError({
          code: "RpcFailure",
          message:
            "the sell was mined but the curve emitted no Trade log, which it does on every "
            + "completed sell.",
          details: { txHash, address: this.address },
        });
      }
      return {
        quoteOut: Quote.fromWad(token, trade.args.quoteAmountWad),
        fee: Quote.fromWad(token, trade.args.feeQuoteWad),
        newPrice: Quote.fromWad(token, trade.args.newPriceWad),
        txHash,
        receipt,
      };
    });
  }

  /**
   * Forward a graduated curve's USDC and remaining tokens to its migrator.
   *
   * **This is the retry path, not the normal one.** The graduating buy attempts
   * the migration itself, in the same transaction, under a bounded gas budget
   * and with its failure caught — so the buyer does not have to send a second
   * transaction and nobody has to poll. When that attempt succeeded, this
   * reverts with `AlreadyMigrated` and there is nothing to do. When it failed
   * (the curve logged `InstantMigrationFailed`), this stays open **to anyone**,
   * forwarding all remaining gas, so a stuck migrator can never strand a curve.
   */
  async migrate(): Promise<MigrateResult> {
    const { wallet, account } = this.ctx.requireSigner("curve.migrate");
    await this.ctx.assertChain();
    const token = await this.quoteToken();
    return withMappedErrors({ functionName: "migrate", address: this.address }, async () => {
      const { request } = await this.ctx.publicClient.simulateContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "migrate",
        account,
        chain: this.ctx.chain,
      });
      const txHash = await wallet.writeContract(request);
      const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
      const migrated = parseEventLogs({
        abi: bondingCurveAbi,
        eventName: "Migrated",
        logs: receipt.logs,
      }).find((log) => log.address.toLowerCase() === this.address.toLowerCase());
      return {
        quote: Quote.fromWad(token, migrated?.args.quoteWad ?? 0n),
        tokens: Tokens.fromWad(migrated?.args.tokenAmountWad ?? 0n),
        pool:
          migrated && migrated.args.pool !== zeroAddress ? migrated.args.pool : undefined,
        txHash,
        receipt,
      };
    });
  }

  /**
   * Pull a deferred payout to an address of the caller's choosing.
   *
   * The escape hatch for Arc's blocklist: the credit belongs to the caller, who
   * names a recipient that can actually receive it. Reverts with
   * `TransferFailed` if that address cannot receive either, leaving the credit
   * intact for another attempt.
   */
  async withdraw(to: Address): Promise<{ amount: QuoteAmount; txHash: `0x${string}` }> {
    const { wallet, account } = this.ctx.requireSigner("curve.withdraw");
    await this.ctx.assertChain();
    const token = await this.quoteToken();
    return withMappedErrors({ functionName: "withdraw", address: this.address }, async () => {
      const { request, result } = await this.ctx.publicClient.simulateContract({
        address: this.address,
        abi: bondingCurveAbi,
        functionName: "withdraw",
        args: [to],
        account,
        chain: this.ctx.chain,
      });
      const txHash = await wallet.writeContract(request);
      await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
      return { amount: Quote.fromWad(token, result), txHash };
    });
  }
}

/**
 * A {@link CurveSnapshot} for `CurveMath`, from a state read off the chain.
 *
 * The position is the stored virtual reserve and tokens sold; on the
 * constant-product curve `CurveMath` prices from `Y = y0Wad - tokensSold`, as the
 * contract does, so a stored reserve a few wei above `C(Y)` is handled exactly.
 */
export function curveSnapshotOf(state: CurveState): CurveSnapshot {
  return {
    params: state.params,
    reserveWad: state.virtualReserve.wad,
    tokensSoldWad: state.tokensSold.wad,
    targetQuoteWad: state.target.wad,
    curveSupplyWad: state.curveSupply.wad,
    tradeFeeBps: state.tradeFeeBps.bps,
  };
}

/** True when a call failed because the address returned no data, or data too short to decode. */
function answeredNoData(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk((link) =>
    link instanceof ContractFunctionZeroDataError
    || link instanceof AbiDecodingZeroDataError
    || link instanceof AbiDecodingDataSizeTooSmallError
    // Not exported by viem, so matched by name: data too short for a string.
    || (link as { name?: unknown }).name === "PositionOutOfBoundsError") !== null;
}
