/**
 * One front door for a token's whole life: the bonding curve before
 * graduation, the Uniswap v4 pool after it.
 *
 * A token's market moves exactly once, irreversibly, in the middle of its life.
 * Before that `curve.buy`/`curve.sell` work and the pool does not exist; after
 * it the curve reverts forever and the pool is the only market. An application
 * that hardcodes either one is correct for half of every token's existence.
 *
 * # This is a dispatcher, not an abstraction layer
 *
 * The two venues are genuinely different and this class does **not** hide that.
 * It refuses to pretend:
 *
 * - a **curve trade always pays `msg.sender`** — there is no recipient argument
 *   anywhere in the curve — so naming a {@link TradeBuyRequest.recipient} on the
 *   curve side is **refused**, not dropped;
 * - a **pool swap has no referrer** — a pool has no argument
 *   for them, and a hook that read them out of `hookData` would let any trader
 *   name themselves the referrer and skim the share — so naming either on the
 *   pool side is **refused**, not dropped;
 * - a **curve buy can graduate mid-trade**: it is capped at the curve's
 *   remaining inventory, the unspent USDC comes back, and the migration is
 *   attempted in the same transaction. {@link CurveBuyResult} carries
 *   `refund`, `graduated` and `migratedInThisTransaction`; a pool buy has no
 *   analogue for any of them, because a pool has no inventory to exhaust, only
 *   a price that moves;
 * - a **curve buy that might graduate needs an explicit `gasLimit`**, and a
 *   pool trade has no such trap, so `gasLimit` is refused on the pool side too;
 * - **the results do not share a shape** and the union is discriminated on
 *   `venue` so that the compiler makes you look. A curve result carries
 *   `txHash`, a pool result carries `hash`; that is not an oversight to be
 *   smoothed over, it is the seam, and a caller who has not noticed which venue
 *   they are on should find out here rather than in production.
 *
 * What it *does* unify is the question "can I trade this token, and at what
 * price" — which is the one question that genuinely has the same meaning on both
 * sides.
 *
 * **No default slippage floor, on either venue.** `minTokensOut`/`minQuoteOut`
 * stay required, for the reason `./slippage.js` gives: a zero floor means "fill
 * me at any price", and a caller who types the zero has made a decision rather
 * than an omission.
 *
 * @module
 */

import type { Address } from "viem";
import { zeroAddress } from "viem";

import type { QuoteAmount, QuoteTokenInfo, Tokens } from "./amounts.js";
import type { ClientContext } from "./client.js";
import { Curve } from "./curve.js";
import type { Deadline } from "./deadline.js";
import { ArcNowError } from "./errors/error.js";
import { withMappedErrors } from "./errors/map.js";
import { arcTokenAbi } from "./generated/abi/index.js";
import { Pool } from "./pool.js";
import type { PoolBuyQuote, PoolSellQuote, PoolTradeResult } from "./pool.js";
import type { BuyQuote, BuyResult, SellQuote, SellResult } from "./types.js";

/* -------------------------------------------------------------------------- *
 * The discriminant
 * -------------------------------------------------------------------------- */

/**
 * Where a token trades right now.
 *
 * `"curve"` before graduation, `"pool"` after. The transition happens once and
 * never reverses.
 */
export type Venue = "curve" | "pool";

/** A curve buy quote, tagged so it can be told from a pool's. */
export interface CurveBuyQuote extends BuyQuote {
  readonly venue: "curve";
}

/** A curve sell quote, tagged. */
export interface CurveSellQuote extends SellQuote {
  readonly venue: "curve";
}

/** What a curve buy did, tagged. Carries `refund`, `graduated`, `txHash`. */
export interface CurveBuyResult extends BuyResult {
  readonly venue: "curve";
}

/** What a curve sell did, tagged. */
export interface CurveSellResult extends SellResult {
  readonly venue: "curve";
}

/** A buy quote from whichever venue the token is on. Switch on `venue`. */
export type TradeBuyQuote = CurveBuyQuote | PoolBuyQuote;

/** A sell quote from whichever venue the token is on. Switch on `venue`. */
export type TradeSellQuote = CurveSellQuote | PoolSellQuote;

/** What a buy did, on whichever venue. Switch on `venue`. */
export type TradeBuyResult = CurveBuyResult | PoolTradeResult;

/** What a sell did, on whichever venue. Switch on `venue`. */
export type TradeSellResult = CurveSellResult | PoolTradeResult;

/* -------------------------------------------------------------------------- *
 * Requests
 * -------------------------------------------------------------------------- */

/**
 * A buy, on whichever venue the token is on.
 *
 * The three required fields mean the same thing on both. The optional ones do
 * not exist on both, and passing one to the venue that has no notion of it is
 * **refused** rather than ignored — see the module docs.
 */
export interface TradeBuyRequest {
  /**
   * What to spend, in the token's quote token (`trade.quoteToken()`). Native USDC
   * is the transaction's value on both venues; an ERC-20 quote is pulled by the
   * curve or the router after an exact approve the SDK sends when the allowance
   * falls short.
   */
  readonly quoteIn: QuoteAmount;
  /** Slippage floor. Required on both. No default, ever. */
  readonly minTokensOut: Tokens;
  /**
   * When the order stops being valid. **Required on both**, and enforced by the
   * curve and by the router respectively.
   */
  readonly deadline: Deadline;
  /**
   * Who receives the tokens. **Pool only.** A curve buy always pays
   * `msg.sender` and has no recipient argument at all, so this is refused there
   * rather than silently dropped.
   */
  readonly recipient?: Address | undefined;
  /**
   * A referrer to credit out of the fee. **Curve only.** A pool's fee has no
   * referrer share at all — the hook's split is creator, platform and protocol
   * — because a pool has no argument to name one with.
   */
  readonly referrer?: Address | undefined;
  /**
   * An explicit gas limit. **Curve only**, and it matters there: a buy that
   * graduates the curve succeeds whether or not its migration does, so
   * `eth_estimateGas` converges on exactly the limit that starves the
   * migration. See `BuyRequest.gasLimit`. A pool swap has no such trap.
   */
  readonly gasLimit?: bigint | undefined;
}

/** A sell, on whichever venue the token is on. Same rules as {@link TradeBuyRequest}. */
export interface TradeSellRequest {
  /**
   * Tokens to sell.
   *
   * **A curve sell needs no approval, ever; a pool sell does.** The curve pulls
   * with `curveTransferFrom`, which reads no allowance. The router calls
   * `safeTransferFrom` and must be approved — `trade.pool.approveRouter(...)`.
   */
  readonly tokensIn: Tokens;
  /** Slippage floor, net of fee, in the token's quote token. Required on both. */
  readonly minQuoteOut: QuoteAmount;
  /** When the order stops being valid. */
  readonly deadline: Deadline;
  /** Who receives the proceeds. **Pool only**; a curve sell always pays `msg.sender`. */
  readonly recipient?: Address | undefined;
  /** A referrer to credit out of the fee. **Curve only.** */
  readonly referrer?: Address | undefined;
}

/* -------------------------------------------------------------------------- *
 * The handle
 * -------------------------------------------------------------------------- */

/**
 * A handle that trades one token wherever it currently trades. Built with
 * `client.trade(tokenAddress)`.
 *
 * @example
 * ```ts
 * const trade = client.trade(token);
 * const quote = await trade.quoteBuy(Usdc.parse("25"));
 * if (quote.venue === "pool") console.log(`fee ${quote.feeQuote.format()}`);
 * else console.log(`graduates: ${quote.graduates}`);
 *
 * await trade.buy({
 *   quoteIn: Usdc.parse("25"),
 *   minTokensOut: minTokensOutFromQuote(quote, Bps.of(50n)),
 *   deadline: Deadline.inMinutes(5),
 * });
 * ```
 */
export class Trade {
  private readonly ctx: ClientContext;

  /** The token being traded. */
  readonly token: Address;

  /** The pool half of the handle: the key, the manager, reachability, the approval. */
  readonly pool: Pool;

  private cachedCurve: Curve | undefined;
  /** Only ever set to `"pool"`. See {@link Trade.venue}. */
  private settledVenue: Venue | undefined;

  constructor(context: ClientContext, tokenAddress: Address) {
    this.ctx = context;
    this.token = tokenAddress;
    this.pool = new Pool(context, tokenAddress);
  }

  /**
   * Where this token trades **now**.
   *
   * Read from `token.migratedPool()`, which is non-zero once the curve's assets
   * have reached the migrator. Its *value* is the PoolManager and is the same
   * for every token that graduated through the same migrator — this asks only
   * whether it is set.
   *
   * **`"pool"` is cached for the life of the handle and `"curve"` is not**, and
   * the asymmetry is the point: migration happens once and is irreversible, so
   * a token that is on a pool will never be on a curve again and re-reading is
   * waste — while a token that is on a curve may graduate in the next block,
   * and caching that answer would send a buy to a curve that has stopped
   * trading.
   */
  async venue(): Promise<Venue> {
    if (this.settledVenue !== undefined) return this.settledVenue;
    const migrated = await this.pool.isMigrated();
    if (migrated) this.settledVenue = "pool";
    return migrated ? "pool" : "curve";
  }

  /**
   * The quote token this token trades against, for life — read off its curve,
   * which still answers after graduation. Its pool pairs the token with the same
   * quote.
   */
  async quoteToken(): Promise<QuoteTokenInfo> {
    return (await this.curve()).quoteToken();
  }

  /**
   * The bonding curve, whether or not it still trades.
   *
   * Read from `token.curve()` and cached: a token is bound to one curve for
   * life. A graduated curve still answers every read — state, progress, the
   * template it launched under — it just refuses every trade.
   */
  async curve(): Promise<Curve> {
    if (this.cachedCurve !== undefined) return this.cachedCurve;
    const address = await withMappedErrors(
      { functionName: "curve", address: this.token },
      () =>
        this.ctx.publicClient.readContract({
          address: this.token,
          abi: arcTokenAbi,
          functionName: "curve",
        }),
    );
    if (address === zeroAddress) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          `${this.token} reports no curve, so it is not an arcnow.io token — or the `
          + "address is not a token at all. Check the address and the chain.",
        details: { token: this.token },
      });
    }
    this.cachedCurve = new Curve(this.ctx, address);
    return this.cachedCurve;
  }

  /* ---------------------------------------------------------------------- *
   * Quoting
   * ---------------------------------------------------------------------- */

  /**
   * Price a buy on whichever venue the token is on.
   *
   * The two quotes are not the same object and deliberately do not pretend to
   * be: a curve quote knows about `refund` and `graduates`, a pool quote knows
   * about `feeUsdc` as a derived figure. Both carry `tokensOut`, which is what
   * `minTokensOutFromQuote` needs.
   *
   * @param opts `from` is used only by the pool path, which prices by
   *             `eth_call`ing the router as somebody.
   */
  async quoteBuy(
    quoteIn: QuoteAmount,
    opts?: { readonly from?: Address | undefined },
  ): Promise<TradeBuyQuote> {
    if ((await this.venue()) === "pool") {
      return this.pool.quoteBuy(quoteIn, opts);
    }
    const quote = await (await this.curve()).quoteBuy(quoteIn);
    return { venue: "curve", ...quote };
  }

  /**
   * Price a sell on whichever venue the token is on.
   *
   * On the pool side `from` must be a holder: the router pulls the tokens with
   * `transferFrom` and this SDK overrides the allowance for the quote but
   * deliberately not the balance. On the curve side it is unused — a curve sell
   * is priced for nobody in particular.
   */
  async quoteSell(
    tokensIn: Tokens,
    opts?: { readonly from?: Address | undefined },
  ): Promise<TradeSellQuote> {
    if ((await this.venue()) === "pool") {
      return this.pool.quoteSell(tokensIn, opts);
    }
    const quote = await (await this.curve()).quoteSell(tokensIn);
    return { venue: "curve", ...quote };
  }

  /* ---------------------------------------------------------------------- *
   * Trading
   * ---------------------------------------------------------------------- */

  /**
   * Buy on whichever venue the token is on.
   *
   * On the **curve** this can graduate the token mid-trade: the fill is capped
   * at the remaining inventory, the unspent USDC is refunded, and the migration
   * runs in the same transaction — so pass `gasLimit` when the quote says
   * `graduates`, or the migration is silently starved. On the **pool** none of
   * that applies and none of those fields exist on the result.
   */
  async buy(request: TradeBuyRequest): Promise<TradeBuyResult> {
    if ((await this.venue()) === "pool") {
      this.refuseCurveOnly(request, "buy");
      return this.pool.buy({
        quoteIn: request.quoteIn,
        minTokensOut: request.minTokensOut,
        deadline: request.deadline,
        ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
      });
    }
    this.refusePoolOnly(request.recipient, "buy");
    const result = await (await this.curve()).buy({
      quoteIn: request.quoteIn,
      minTokensOut: request.minTokensOut,
      deadline: request.deadline,
      ...(request.referrer === undefined ? {} : { referrer: request.referrer }),
      ...(request.gasLimit === undefined ? {} : { gasLimit: request.gasLimit }),
    });
    return { venue: "curve", ...result };
  }

  /**
   * Sell on whichever venue the token is on.
   *
   * **A curve sell needs no approval and a pool sell does.** This method does
   * not paper over that by issuing an approval for you: an SDK that silently
   * granted an allowance would be spending a caller's gas and widening their
   * exposure without being asked. Call `trade.pool.approveRouter(amount)`
   * yourself once the venue is `"pool"`, or let the refusal from
   * {@link Pool.sell} tell you.
   */
  async sell(request: TradeSellRequest): Promise<TradeSellResult> {
    if ((await this.venue()) === "pool") {
      this.refuseCurveOnly(request, "sell");
      return this.pool.sell({
        tokensIn: request.tokensIn,
        minQuoteOut: request.minQuoteOut,
        deadline: request.deadline,
        ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
      });
    }
    this.refusePoolOnly(request.recipient, "sell");
    const result = await (await this.curve()).sell({
      tokensIn: request.tokensIn,
      minQuoteOut: request.minQuoteOut,
      deadline: request.deadline,
      ...(request.referrer === undefined ? {} : { referrer: request.referrer }),
    });
    return { venue: "curve", ...result };
  }

  /* ---------------------------------------------------------------------- *
   * The refusals
   * ---------------------------------------------------------------------- */

  /**
   * Refuse a curve-only field on a pool trade.
   *
   * Dropping them instead would be worse than an error in both cases. A
   * referrer that is silently ignored is a partner who was promised a share and
   * gets nothing, with no log anywhere saying why; a `gasLimit` silently
   * ignored hides that the caller believed they were guarding against a
   * migration trap that does not exist here.
   */
  private refuseCurveOnly(
    request: {
      referrer?: Address | undefined;
      gasLimit?: bigint | undefined;
    },
    what: string,
  ): void {
    const named: string[] = [];
    if (request.referrer !== undefined) named.push("referrer");
    if (request.gasLimit !== undefined) named.push("gasLimit");
    if (named.length === 0) return;
    throw new ArcNowError({
      code: "InvalidArgument",
      message:
        `${named.join(" and ")} ${named.length === 1 ? "is" : "are"} a curve-only option `
        + `and this token has graduated, so the ${what} goes through the Uniswap v4 `
        + "router. A pool swap has no argument for a referrer and the hook's split has no "
        + "referrer share — creator, platform and protocol only — deliberately, because a hook "
        + "that read one out of hookData would let any trader name themselves the referrer and "
        + "skim the share. And gasLimit guards a graduation that cannot happen twice. This "
        + "is refused rather than dropped so that nobody is promised a fee share the chain "
        + "was never asked for.",
      details: { token: this.token, refused: named, venue: "pool" },
    });
  }

  /** Refuse a pool-only field on a curve trade. */
  private refusePoolOnly(recipient: Address | undefined, what: string): void {
    if (recipient === undefined) return;
    throw new ArcNowError({
      code: "InvalidArgument",
      message:
        `recipient is a pool-only option and this token is still on its bonding curve, so `
        + `the ${what} goes through the curve — which pays msg.sender and has no recipient `
        + "argument anywhere in it. Refused rather than dropped, because a trade that paid "
        + "somebody other than the address the caller named would be the worst possible way "
        + "to find this out. Send the proceeds on yourself, or wait for graduation.",
      details: { token: this.token, refused: ["recipient"], venue: "curve" },
    });
  }
}
