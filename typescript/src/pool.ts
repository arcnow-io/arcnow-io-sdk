/**
 * Trading a token **after** it has graduated: the Uniswap v4 pool its migrator
 * seeded, reached through the v4 router arcnow.io deploys.
 *
 * Once a curve graduates, `curve.buy` and `curve.sell` revert forever. The
 * token still trades — it just trades somewhere else, and that somewhere is not
 * a contract you can call. This module is the second half of a token's life.
 *
 * # A v4 pool has no address, and that fact breaks every habit
 *
 * A pool is a `PoolId` — `keccak256` of a {@link PoolKeyStruct} — inside **one**
 * PoolManager's storage. There is no per-pool contract, no per-pool address and
 * nothing to `readContract` against.
 *
 * So `token.migratedPool()` and the curve's `Migrated` event do **not** return a
 * pool. They return the **PoolManager**, identically for every token that
 * graduated through the same migrator, by design. Treating either as a per-token
 * pool address gives you one address for every token on the chain and an
 * integration that looks right until you compare two tokens. Read them as
 * exactly two facts: *has this token migrated* (non-zero) and *into which
 * manager*.
 *
 * # The router is arcnow.io's own, bound to arcnow.io's own PoolManager
 *
 * Every token that has graduated has its liquidity in arcnow.io's PoolManager
 * (`0x06110b57…` on Arc testnet), permanently: the migrator burns the positions
 * and holds its `poolManager` immutable. Arc testnet also has a second,
 * unrelated PoolManager with a third-party router bound to it — and because a
 * pool lives inside one manager's storage, that router cannot see a single
 * arcnow.io pool. Moving future launches over there would never have made the
 * tokens already graduated tradeable, and would have split arcnow.io's
 * liquidity across two markets that cannot see each other.
 *
 * So arcnow.io deploys its own copy of the same router — `UniswapV4Router04`
 * from z0r0z/v4-router, unmodified — bound to its own manager, and this module
 * trades through **`contracts.v4Router`** and nothing else. Two refusals follow,
 * both raised before a swap is encoded:
 *
 * - **`NoRouterDeployed`** while `contracts.v4Router` is absent, which on Arc
 *   testnet is until that deployment is broadcast.
 * - **`PoolUnreachable`** when the router's own immutable `poolManager()` is
 *   not the token migrator's. With the planned deployment that should not
 *   happen for an arcnow.io token; it is there so a mis-pointed router is named
 *   rather than surfacing as `PoolNotInitialized()` from inside the swap.
 *
 * See {@link Pool.isReachable}.
 *
 * # There is no quoter on this chain, so the router is the quoter
 *
 * No `Quoter` is deployed on Arc, and off-chain tick maths would be wrong even
 * if it were easy: the migrator seeds **two single-sided positions** and anyone
 * may add liquidity afterwards, so the pool is not the textbook single-range
 * shape the closed-form formulas assume.
 *
 * So a quote is an `eth_call` of the **real swap**, with state overrides
 * standing in for the money and the allowance, reading back the
 * `BalanceDelta` the router returns. That delta is the trader's own, with the
 * hook's 0.80% and the pool's 0.20% LP fee already inside it — which is the
 * entire reason it is worth the round trip. See {@link unpackBalanceDelta}.
 *
 * # The pool's quote token, and which side of the key it is on
 *
 * A graduated token trades against the quote its curve was launched in: native
 * USDC or an allowlisted ERC-20. v4 sorts a key's currencies by address, so
 * `currency0 = min(quote, token)`: native USDC (`address(0)`) is always
 * currency0, and an ERC-20 quote such as EURC lands on either side depending on
 * the token's address. **Every direction, every delta leg and every log leg in
 * this file is chosen by {@link Pool.quoteIsCurrency0}**, never assumed.
 *
 * v4 amounts are **raw units** of each currency — 1 EURC is 1,000,000 in a
 * `BalanceDelta`, a `Swap` log and the hook's fee — and every SDK amount is WAD,
 * so the quote leg is scaled by `10^(18 - decimals)` on the way in and out.
 *
 * # The pool's own 0.80% is charged in the quote, by the hook, inside the swap
 *
 * `ArcNowFeeHook` takes {@link POOL_TRADE_FEE_BPS} — 0.80% of the gross quote
 * leg, in raw units — and splits it on the pool's own split, creator 5000 /
 * platform 1875 / protocol 3125 bps, which the hook answers from
 * `feeConfigOf(poolId)` ({@link Pool.feeConfig}). The pool charges its 0.20% LP
 * fee on top, inside its own price, so a migrated trade costs the curve's 1.00%
 * in all ({@link Pool.fees}). **A pool swap names no referrer**: a pool has no
 * argument for one, and a hook that read one out of `hookData` would let any
 * trader name themselves the referrer and skim the share, so the pool's split
 * has no referrer share at all.
 *
 * # A filled trade is read out of its own receipt, to the wei
 *
 * Native USDC moves with no ERC-20 event, so the quote leg is read from the
 * **PoolManager's own `Swap` log** for this pool, with the hook's fee put back
 * on top of it — see {@link quoteFillFromLogs} for why that is the exact figure
 * and not an estimate. The token leg is the token's `Transfer` log and the fee
 * is `HookFeeTaken`. Nothing in a result is carried over from the simulation
 * that preceded the trade, and nothing is reconstructed from the fee.
 *
 * @module
 */

import type { Account, Address, Hex, Log } from "viem";
import {
  maxUint256,
  numberToHex,
  parseEventLogs,
  zeroAddress,
} from "viem";

import type { QuoteAmount, QuoteTokenInfo } from "./amounts.js";
import { Bps, QuoteAmount as Quote, Tokens, WAD } from "./amounts.js";
import type { ClientContext } from "./client.js";
import type { Deadline } from "./deadline.js";
import { ArcNowError } from "./errors/error.js";
import { withMappedErrors } from "./errors/map.js";
import type { FeeConfig } from "./fees.js";
import { BPS_DENOMINATOR, POOL_TRADE_FEE_BPS } from "./fees.js";
import { arcNowFeeHookAbi, arcTokenAbi, uniswapV4MigratorAbi }
  from "./generated/abi/index.js";
import { uniswapV4Router04Abi } from "./generated/abi/external/uniswapV4Router04.js";
import { configuredV4Router, quoteAllowanceSlot, requireV4Router } from "./networks.js";
import { assertHookVersion, assertV4MigratorVersion } from "./curve-version.js";
import {
  allowanceOverride,
  erc20AllowanceSlot,
  QuoteToken,
  requireSameQuote,
  signerAddressOf,
  withPoolQuoteTransferHeadroom,
} from "./quote-token.js";

export { erc20AllowanceSlot } from "./quote-token.js";

/* -------------------------------------------------------------------------- *
 * The key, and the delta
 * -------------------------------------------------------------------------- */

/**
 * The five fields that *are* a v4 pool.
 *
 * **Read this from the token's migrator; never write it down.** `fee`,
 * `tickSpacing` and `hooks` are constructor arguments of
 * `UniswapV4Migrator`, so they are per-migrator rather than per-chain, and a
 * hardcoded 3000/60 would keep working right up until a migrator is deployed
 * with different ones — at which point every quote would be against a pool that
 * does not exist, and an empty pool quotes a revert, not a warning.
 *
 * The currencies are the token and its quote, **sorted by address**:
 * `currency0 = min(quote, token)`. Native USDC is `address(0)` and always
 * currency0; an ERC-20 quote may be either. See {@link Pool.quoteIsCurrency0}.
 */
export interface PoolKeyStruct {
  /** The lower of the token and its quote, by address. */
  readonly currency0: Address;
  /** The higher of the two. */
  readonly currency1: Address;
  /**
   * The LP fee tier, in hundredths of a bip: `2000`, 0.20%. Uniswap's fee, not
   * arcnow.io's, and not revenue — the migrator burns its position, so it
   * accrues to liquidity nobody can collect.
   */
  readonly fee: number;
  /** The pool's tick spacing: `60`. */
  readonly tickSpacing: number;
  /** `ArcNowFeeHook`: where arcnow.io's own 0.80% is charged. */
  readonly hooks: Address;
}

/**
 * A v4 `BalanceDelta`, unpacked into its two signed halves, in **raw units** of
 * `currency0` and `currency1`. Which one is the quote is the key's order.
 */
export interface BalanceDelta {
  /** The trader's `currency0` delta. Negative when they paid, positive when they were paid. */
  readonly amount0: bigint;
  /** The trader's `currency1` delta. */
  readonly amount1: bigint;
}

/**
 * Split a v4 `BalanceDelta` into its two `int128` halves.
 *
 * `BalanceDelta` is a packed `int256`: `amount0` is the **high** 128 bits and
 * `amount1` the low 128, each two's-complement `int128`. A naïve
 * `packed >> 128n` is wrong twice over — it sign-extends the whole 256-bit
 * value into `amount0`, and it leaves `amount1` as the entire remaining
 * 256-bit number rather than the signed 128-bit one. Both mistakes are
 * invisible on a small buy (where the top half is zero-ish and the bottom half
 * is positive) and catastrophic on a sell, where `amount1` is negative and a
 * missing truncation reads it as ~3.4e38 tokens.
 *
 * **The signs are the trader's own.** Negative is what leaves them; positive is
 * what arrives. On a buy that is `amount0 < 0` (USDC paid, the hook's 0.80%
 * already inside it) and `amount1 > 0` (tokens received). On a sell it is the
 * other way round.
 */
export function unpackBalanceDelta(packed: bigint): BalanceDelta {
  // Back to unsigned first: viem hands back a signed bigint for an int256, and
  // shifting a negative bigint right sign-extends forever.
  const raw = BigInt.asUintN(256, packed);
  return {
    amount0: BigInt.asIntN(128, raw >> 128n),
    amount1: BigInt.asIntN(128, raw),
  };
}

/* -------------------------------------------------------------------------- *
 * The allowance storage slot
 * -------------------------------------------------------------------------- */

/**
 * The storage slot `ArcToken._allowance` occupies: **11**.
 *
 * Verified with `forge inspect ArcToken storage` against the pinned contracts
 * commit, and **pinned by a fork test** — `test/fork/pool.fork.test.ts` writes
 * this slot and reads the value back through `allowance()`, so a layout change
 * in a future token turns into a red test rather than a quote that silently
 * prices a swap nobody could execute.
 *
 * That test is the entire justification for this constant existing. A
 * hard-coded storage slot nothing checks is a number that is true on the day it
 * is written and unfalsifiable afterwards.
 */
export const ARC_TOKEN_ALLOWANCE_SLOT = 11n;

/**
 * Where `allowance(owner, spender)` lives in an `ArcToken`'s storage.
 *
 * Solidity nests two mappings, so the slot is hashed twice:
 * `keccak256(spender ++ keccak256(owner ++ 11))`, each level ABI-encoding the
 * key and the parent slot as two 32-byte words.
 *
 * Used **only** to build an `eth_call` state override, so that a sell can be
 * quoted by a holder who has not approved the router yet. Nothing here writes
 * to a chain, and a quote that demanded an on-chain approval first would be a
 * price you cannot see until you have committed to paying for it.
 */
export function arcTokenAllowanceSlot(owner: Address, spender: Address): Hex {
  return erc20AllowanceSlot(owner, spender, ARC_TOKEN_ALLOWANCE_SLOT);
}

/* -------------------------------------------------------------------------- *
 * The fee, derived from the quote
 * -------------------------------------------------------------------------- */

/**
 * The hook's 0.80%, on a **buy**, in the pool's quote.
 *
 * The hook takes its cut off the input before the pool sees any of it, so the
 * pool swaps 99.2% of what the trader pays and the identity is the plain one —
 * **computed on raw units, the way the hook computes it**:
 *
 * ```text
 * feeRaw = quoteInRaw * POOL_TRADE_FEE_BPS / 10000
 * ```
 *
 * So for a 6-decimal quote a buy of fewer than 125 raw units (0.000125 EURC) is
 * charged nothing: dust-level fee-free swaps, accepted and documented.
 *
 * Derived rather than read back, because the fee is not a field of anything the
 * router returns — it is already subtracted inside the `BalanceDelta`.
 */
export function buyFeeFromQuoteIn(quoteIn: QuoteAmount): QuoteAmount {
  const raw = quoteIn.floorToRepresentable().toRaw();
  return Quote.fromRaw(quoteIn.token, (raw * POOL_TRADE_FEE_BPS) / BPS_DENOMINATOR);
}

/**
 * The hook's 0.80%, on a **sell**, in the pool's quote, on raw units.
 *
 * Here the pool quotes the payout first and the hook takes its cut out of it,
 * so the trader sees 99.2% of what the pool paid and the identity runs
 * backwards through that:
 *
 * ```text
 * grossRaw = quoteOutRaw * 10000 / (10000 - POOL_TRADE_FEE_BPS)
 * feeRaw   = grossRaw * POOL_TRADE_FEE_BPS / 10000
 * ```
 *
 * Applying the buy's identity to the payout instead would under-report the fee
 * by 0.80% of itself. **Two floors, so this can sit one raw unit under the fee the
 * hook actually took**; compare against {@link PoolTradeResult.feeQuote}, which
 * is read from the hook's own log, with a one-unit tolerance.
 */
export function sellFeeFromQuoteOut(quoteOut: QuoteAmount): QuoteAmount {
  const raw = quoteOut.floorToRepresentable().toRaw();
  const gross = (raw * BPS_DENOMINATOR) / (BPS_DENOMINATOR - POOL_TRADE_FEE_BPS);
  return Quote.fromRaw(quoteOut.token, (gross * POOL_TRADE_FEE_BPS) / BPS_DENOMINATOR);
}

/**
 * An **estimate** of a sell's payout from the fee alone — a lower bound, never
 * the figure a fill reports. {@link Pool.sell} reads the payout exactly, out of
 * the PoolManager's `Swap` log; see {@link quoteFillFromLogs}. This stays for a
 * caller who holds nothing but a `HookFeeTaken` log:
 *
 * ```text
 * grossRaw = feeRaw * 10000 / 80
 * netRaw   = grossRaw - feeRaw
 * ```
 *
 * **Up to 124 raw units under the truth, and no better**, because the fee was
 * floored. A sell too small to be charged emits no `HookFeeTaken` at all.
 */
export function sellQuoteOutFromFee(fee: QuoteAmount): QuoteAmount {
  const raw = fee.floorToRepresentable().toRaw();
  const gross = (raw * BPS_DENOMINATOR) / POOL_TRADE_FEE_BPS;
  return Quote.fromRaw(fee.token, gross - raw);
}

/* -------------------------------------------------------------------------- *
 * A fill, read out of its receipt
 * -------------------------------------------------------------------------- */

/**
 * The Uniswap v4 PoolManager's `Swap` event, declared by hand exactly as
 * `IPoolManager.sol` declares it at the v4-core commit arcnow-io/contracts
 * vendors (`e50237c4`).
 *
 * The one piece of the PoolManager this package reads, so it is written out
 * rather than pinned as a whole ABI. Its topic is pinned by a unit test against
 * the canonical signature, and the fork suite decodes it off real receipts.
 */
export const poolManagerSwapEventAbi = [
  {
    type: "event",
    name: "Swap",
    anonymous: false,
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

/** Where one pool trade's logs came from, and which way the trade went. */
export interface PoolFillSource {
  /** `"buy"`: the quote paid into the pool. `"sell"`: the quote paid out of it. */
  readonly side: "buy" | "sell";
  /** The pool's quote token: the only currency whose `HookFeeTaken` counts, and the scale. */
  readonly quoteToken: QuoteTokenInfo;
  /** True when the quote is the key's `currency0`, so its leg is `Swap.amount0`. */
  readonly quoteIsCurrency0: boolean;
  /** The PoolManager the pool lives in: the only address whose `Swap` counts. */
  readonly poolManager: Address;
  /** The pool key's `hooks`: the only address whose `HookFeeTaken` counts. */
  readonly hook: Address;
  /** The pool's `PoolId`. Both logs are matched on it. */
  readonly poolId: Hex;
  /** The transaction, named in an error. */
  readonly hash: Hex;
}

/**
 * The **exact** quote a pool trade moved for the trader, and the fee the hook
 * took, read out of the trade's own receipt, in WAD.
 *
 * # What the `Swap` leg means when a hook takes a delta
 *
 * Read out of the v4-core source arcnow-io/contracts vendors (`e50237c4`), and
 * confirmed against real receipts on a fork of Arc testnet:
 *
 * 1. `PoolManager.swap` calls `beforeSwap` first. A positive specified delta
 *    from the hook is applied as `amountToSwap += hookDeltaSpecified`, so the
 *    **pool** swaps a different amount from the one the trader named.
 * 2. `_swap` runs the pool and **emits `Swap` with the pool's own delta** —
 *    before `afterSwap` has run.
 * 3. `afterSwap` composes the hook's delta and does `swapDelta -= hookDelta`,
 *    which is what the caller settles. Nothing is emitted for that step.
 *
 * So the quote leg of `Swap` — `amount0` when the quote is currency0, `amount1`
 * otherwise — is the pool's leg **without** the hook's delta, signed from the
 * swapper's side. `ArcNowFeeHook` takes its fee on the quote leg in every swap
 * shape, as a positive delta, **in raw units**, so the trader's own quote delta is
 *
 * ```text
 * traderRaw = Σ Swap.<quote leg> − Σ HookFeeTaken.feeAmount   (currency == quote)
 * ```
 *
 * then scaled to WAD. Exact on a buy, a sell, a trade too small to be charged
 * (no `HookFeeTaken` at all) and a buy the pool fills only in part.
 *
 * # What it matches, and what it does not
 *
 * `Swap` by the **PoolManager's address and the pool id**; `HookFeeTaken` by
 * the **hook's address, the pool id and the quote currency**. Never by `payer`
 * or `sender`: both are the router, not the trader.
 *
 * @throws `RpcFailure` when the receipt holds no `Swap` for this pool, or when
 *   the trader's leg points the wrong way for `side`.
 */
export function quoteFillFromLogs(
  logs: readonly Log[],
  source: PoolFillSource,
): { quote: QuoteAmount; feeQuote: QuoteAmount; feesDistributed: QuoteAmount } {
  const same = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();
  const token = source.quoteToken;

  const swaps = parseEventLogs({ abi: poolManagerSwapEventAbi, eventName: "Swap", logs: [...logs] })
    .filter((log) => same(log.address, source.poolManager) && same(log.args.id, source.poolId));
  if (swaps.length === 0) {
    throw new ArcNowError({
      code: "RpcFailure",
      message:
        `transaction ${source.hash} carries no PoolManager Swap log for pool ${source.poolId}, `
        + `so its ${token.symbol} leg cannot be read. A mined pool trade always has one; either the `
        + "receipt's logs were filtered in transit or the transaction did not swap this pool.",
      details: { hash: source.hash, poolId: source.poolId, poolManager: source.poolManager },
    });
  }
  const fees = parseEventLogs({ abi: arcNowFeeHookAbi, eventName: "HookFeeTaken", logs: [...logs] })
    .filter((log) => same(log.address, source.hook) && same(log.args.poolId, source.poolId)
      && same(log.args.currency, token.address));

  const poolLeg = swaps.reduce(
    (total, log) => total + (source.quoteIsCurrency0 ? log.args.amount0 : log.args.amount1),
    0n,
  );
  const feeRaw = fees.reduce((total, log) => total + log.args.feeAmount, 0n);
  const trader = poolLeg - feeRaw;

  if (source.side === "buy" ? trader > 0n : trader < 0n) {
    throw new ArcNowError({
      code: "RpcFailure",
      message:
        `transaction ${source.hash} was read as a ${source.side}, and its ${token.symbol} leg for pool `
        + `${source.poolId} moved ${trader} raw units the other way (Swap leg ${poolLeg}, fee `
        + `${feeRaw}). A ${source.side} ${source.side === "buy" ? "pays the quote in" : "is paid the quote out"}; `
        + "this receipt is not the trade it was read for.",
      details: { hash: source.hash, poolId: source.poolId, poolLeg, feeRaw },
    });
  }
  return {
    quote: Quote.fromRaw(token, trader < 0n ? -trader : trader),
    feeQuote: Quote.fromRaw(token, feeRaw),
    feesDistributed: feesDistributedIn(logs, source),
  };
}

/**
 * The earlier fees the hook paid out inside this transaction, for this pool: the
 * sum of its `FeesDistributed` logs, matched by the hook's address and the pool
 * id. Zero when nothing accrued from an earlier transaction was redeemed.
 *
 * **Not part of the trader's fill, and that is proved rather than assumed.** A
 * distribution burns the hook's own ERC-6909 claim and takes the same amount, so
 * the hook's delta nets to zero and nothing touches the swapper's; the fork suite
 * holds `usdc` equal to the balance change on a swap that distributes.
 */
export function feesDistributedIn(
  logs: readonly Log[],
  source: Pick<PoolFillSource, "hook" | "poolId" | "quoteToken">,
): QuoteAmount {
  const same = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();
  const distributed = parseEventLogs({
    abi: arcNowFeeHookAbi,
    eventName: "FeesDistributed",
    logs: [...logs],
  }).filter((log) => same(log.address, source.hook) && same(log.args.poolId, source.poolId)
    && same(log.args.currency, source.quoteToken.address));
  const raw = distributed.reduce((total, log) => total + log.args.amount, 0n);
  return Quote.fromRaw(source.quoteToken, raw);
}

/* -------------------------------------------------------------------------- *
 * Quotes, requests, results
 * -------------------------------------------------------------------------- */

/** A priced buy in the pool, as the router would fill it right now. */
export interface PoolBuyQuote {
  /** Discriminates this from a curve quote. */
  readonly venue: "pool";
  /** What the trader pays, in total, fee included, in the pool's quote. */
  readonly quoteIn: QuoteAmount;
  /** What they receive. */
  readonly tokensOut: Tokens;
  /**
   * The hook's 0.80%, charged in the quote inside the swap. The pool's 0.20%
   * LP fee is not listed separately: it is inside the price
   * {@link PoolBuyQuote.tokensOut} reflects. See {@link Pool.fees}.
   */
  readonly feeQuote: QuoteAmount;
}

/** A priced sell in the pool. */
export interface PoolSellQuote {
  /** Discriminates this from a curve quote. */
  readonly venue: "pool";
  /** What the trader gives up. */
  readonly tokensIn: Tokens;
  /** What they receive, **net** of the fee, in the pool's quote. */
  readonly quoteOut: QuoteAmount;
  /** The hook's 0.80%, already deducted from {@link PoolSellQuote.quoteOut}. */
  readonly feeQuote: QuoteAmount;
}

/**
 * What a trade in this pool costs, and to whom: the hook's rate read off the
 * hook, the LP fee read off the key, and their total in bps of the trade.
 */
export interface PoolFees {
  /** What the hook takes, bps of the trade: 80. Read from `feeBps()`. */
  readonly hookFeeBps: Bps;
  /** The pool's LP fee, in hundredths of a bip: 2000, 0.20%. Read from the key. */
  readonly lpFeePips: number;
  /** The two together, bps of the trade: 100, the same as the curve charged. */
  readonly totalBps: Bps;
  /** How the hook splits its fee: creator, platform, protocol; the ref share is zero. */
  readonly split: FeeConfig;
}

/** What a pool trade actually did. */
export interface PoolTradeResult {
  /** Discriminates this from a curve result. */
  readonly venue: "pool";
  /** The transaction. */
  readonly hash: `0x${string}`;
  /**
   * The quote leg — spent on a buy, received on a sell — **exact to the raw
   * unit**, read out of this transaction's own receipt and scaled to WAD. See
   * {@link quoteFillFromLogs}.
   */
  readonly quote: QuoteAmount;
  /** The token leg, read out of the token's own `Transfer` log in this receipt. */
  readonly tokens: Tokens;
  /**
   * The hook's 0.80%, as the hook's own `HookFeeTaken` logs for this pool and quote
   * record it. **Zero** when a trade's fee floored to zero, which emits no log.
   * The hook accrues it as an ERC-6909 claim and pays it out in a later
   * transaction.
   */
  readonly feeQuote: QuoteAmount;
  /**
   * Fees from **earlier** transactions that the hook paid out during this swap
   * — the `FeesDistributed` logs for this pool. Never part of
   * {@link PoolTradeResult.quote}.
   */
  readonly feesDistributed: QuoteAmount;
  /**
   * The approve sent first, for an ERC-20 quote whose allowance to the router
   * fell short of a buy. `undefined` when none was needed.
   */
  readonly approvalTxHash?: `0x${string}` | undefined;
}

/** A buy in the pool. */
export interface PoolBuyRequest {
  /**
   * What to spend, in the pool's quote. Native USDC is the transaction's value;
   * an ERC-20 quote is pulled by the router in raw units, after an exact approve
   * the SDK sends when the allowance falls short. Must be representable.
   */
  readonly quoteIn: QuoteAmount;
  /**
   * Slippage floor. Required, and there is no default — see `./slippage.js`.
   * Enforced by the router itself, which reverts with `SlippageExceeded`.
   */
  readonly minTokensOut: Tokens;
  /** When the order stops being valid. **Required**: the router enforces it. */
  readonly deadline: Deadline;
  /** Who receives the tokens. Defaults to the signer. A curve trade has no equivalent. */
  readonly recipient?: Address | undefined;
}

/** A sell into the pool. */
export interface PoolSellRequest {
  /**
   * Tokens to sell.
   *
   * **Unlike a curve sell, this needs an ERC-20 approval to the router.** See
   * {@link Pool.approveRouter}.
   */
  readonly tokensIn: Tokens;
  /**
   * Slippage floor, net of the hook's fee, in the pool's quote. The router
   * compares raw units, so dust below one raw unit is rounded up, never down.
   */
  readonly minQuoteOut: QuoteAmount;
  /** When the order stops being valid. */
  readonly deadline: Deadline;
  /** Who receives the proceeds. Defaults to the signer. */
  readonly recipient?: Address | undefined;
}

/** Where a quote is priced from when the caller names nobody. */
export interface QuoteFrom {
  /**
   * The account to price the swap as.
   *
   * For a **buy** this only decides who the state override funds, so any
   * address does; it defaults to the client's signer, or to a probe address on
   * a read-only client. For a **sell** it must be a real holder: the router
   * pulls the tokens with `transferFrom`, and this SDK overrides the
   * *allowance* but deliberately not the *balance* — a price for tokens nobody
   * holds is a number, not a quote.
   */
  readonly from?: Address | undefined;
}

/**
 * The address a read-only client prices a buy as.
 *
 * Nothing lives here. It exists because `eth_call` still needs a `from` and the
 * state override needs somebody to fund, and picking the zero address would
 * mean overriding the balance of an account that, on Arc, is real.
 */
const QUOTE_PROBE_ADDRESS: Address = "0x0000000000000000000000000000000000c0ffee";

/**
 * Spare native USDC handed to the quoting account, on top of what it spends.
 *
 * A quote is a **price**, not an affordability check. Without this, quoting
 * would fail for anyone who could not already afford the trade — which is
 * every UI that wants to show a price before the user has topped up.
 */
const QUOTE_BALANCE_HEADROOM = 1_000n * WAD;

/** The deadline a quote is priced under: none. A quote has no lifetime to expire. */
const QUOTE_DEADLINE = maxUint256;

/**
 * The router's own `poolManager()`, memoised per client.
 *
 * Keyed on the {@link ClientContext} rather than held on a {@link Pool},
 * because the answer is a property of the chain and not of a token — one read
 * per client serves every token it will ever look at. The router holds the
 * field `immutable`, so there is no block at which a cached answer goes stale.
 *
 * A rejected read is evicted rather than cached: an endpoint that was down for
 * one call must not make every later reachability check fail for the life of
 * the process.
 */
const routerPoolManagerByClient = new WeakMap<ClientContext, Promise<Address>>();

/**
 * The PoolManager **the configured router itself is bound to**, asked of the
 * router and memoised per client.
 *
 * Shared by {@link Pool.isReachable} and `MigratorRegistry.list()`, so a page
 * that renders a venue picker and a price for the same client pays for this
 * read once. Not re-exported from the package: it is the mechanism behind two
 * public answers, not a third one.
 *
 * `router` is always the client's own `contracts.v4Router`, which a client
 * cannot change after it is built, so one entry per client is enough.
 */
export function routerPoolManager(ctx: ClientContext, router: Address): Promise<Address> {
  const cached = routerPoolManagerByClient.get(ctx);
  if (cached !== undefined) return cached;
  const pending = withMappedErrors({ functionName: "poolManager", address: router }, () =>
    ctx.publicClient.readContract({
      address: router,
      abi: uniswapV4Router04Abi,
      functionName: "poolManager",
    }));
  routerPoolManagerByClient.set(ctx, pending);
  pending.catch(() => routerPoolManagerByClient.delete(ctx));
  return pending;
}

/* -------------------------------------------------------------------------- *
 * The handle
 * -------------------------------------------------------------------------- */

/**
 * A handle on one graduated token's v4 pool. Built with `client.pool(token)`,
 * or reached through `client.trade(token)`.
 *
 * **Constructed from the token, not from a pool address**, because there is no
 * pool address; see the module docs. Everything the swap needs — the key, the
 * manager, the hook — is read from the token's own migrator, which is
 * snapshotted at launch and immutable.
 */
export class Pool {
  private readonly ctx: ClientContext;

  /**
   * The token. Deliberately not called `address`: a {@link Curve} has one and a
   * pool does not, and naming this field `address` is how an integration ends up
   * calling `readContract` against a token believing it is a pool.
   */
  readonly token: Address;

  private cachedMigrator: Address | undefined;
  private cachedKey: PoolKeyStruct | undefined;
  private cachedPoolId: `0x${string}` | undefined;
  private versionsChecked: Promise<void> | undefined;

  constructor(context: ClientContext, tokenAddress: Address) {
    this.ctx = context;
    this.token = tokenAddress;
  }

  /* ---------------------------------------------------------------------- *
   * Identity
   * ---------------------------------------------------------------------- */

  /** The network's `contracts.v4Router`, or `NoRouterDeployed` naming the network. */
  private get router(): Address {
    return requireV4Router(this.ctx.config);
  }

  /**
   * The migrator this token was launched against. Immutable, snapshotted at
   * launch, and the source of every other fact on this handle.
   */
  private async migrator(): Promise<Address> {
    this.cachedMigrator ??= await withMappedErrors(
      { functionName: "migrator", address: this.token },
      () =>
        this.ctx.publicClient.readContract({
          address: this.token,
          abi: arcTokenAbi,
          functionName: "migrator",
        }),
    );
    return this.cachedMigrator;
  }

  /**
   * The pool's key, read from the migrator and cached.
   *
   * Cached for the life of the handle because every field of it is immutable:
   * `fee`, `tickSpacing` and `hooks` are the migrator's constructor arguments
   * and the migrator itself is the token's, fixed at launch.
   *
   * Answers before migration too — the key is derivable in advance, which is
   * how an indexer names a pool it is waiting for. That it answers does **not**
   * mean the pool exists; {@link Pool.quoteBuy} checks that separately.
   */
  async key(): Promise<PoolKeyStruct> {
    if (this.cachedKey !== undefined) return this.cachedKey;
    const migrator = await this.migrator();
    const key = await withMappedErrors(
      { functionName: "poolKey", address: migrator },
      () =>
        this.ctx.publicClient.readContract({
          address: migrator,
          abi: uniswapV4MigratorAbi,
          functionName: "poolKey",
          args: [this.token],
        }),
    );
    this.cachedKey = {
      currency0: key.currency0,
      currency1: key.currency1,
      fee: key.fee,
      tickSpacing: key.tickSpacing,
      hooks: key.hooks,
    };
    return this.cachedKey;
  }

  /**
   * `keccak256` of the key: the pool's identity **inside its PoolManager**.
   *
   * Not an address and not portable. The same id in the other manager names a
   * pool that does not exist.
   */
  async poolId(): Promise<`0x${string}`> {
    if (this.cachedPoolId !== undefined) return this.cachedPoolId;
    const migrator = await this.migrator();
    const id = await withMappedErrors({ functionName: "poolIdOf", address: migrator }, () =>
      this.ctx.publicClient.readContract({
        address: migrator,
        abi: uniswapV4MigratorAbi,
        functionName: "poolIdOf",
        args: [this.token],
      }));
    // Zero until migration, and written exactly once. Caching a zero would
    // pin "no pool" for the life of a handle that outlived the graduation.
    if (id !== `0x${"0".repeat(64)}`) this.cachedPoolId = id;
    return id;
  }

  /** Which PoolManager this token's liquidity is inside. */
  async poolManager(): Promise<Address> {
    const migrator = await this.migrator();
    return withMappedErrors({ functionName: "poolManager", address: migrator }, () =>
      this.ctx.publicClient.readContract({
        address: migrator,
        abi: uniswapV4MigratorAbi,
        functionName: "poolManager",
      }));
  }

  /**
   * The pool's quote token — the key's currency that is not the token — with its
   * metadata from the network's `quoteTokens` (no RPC) or one cached read.
   */
  async quoteToken(): Promise<QuoteTokenInfo> {
    return (await this.orientation()).quote;
  }

  /**
   * True when the quote is the key's `currency0`. Always true for native USDC,
   * which is `address(0)`; either way for an ERC-20 quote. `zeroForOne` on a buy
   * is this value, and on a sell its negation.
   */
  async quoteIsCurrency0(): Promise<boolean> {
    return (await this.orientation()).quoteIsCurrency0;
  }

  private async orientation(): Promise<{ quote: QuoteTokenInfo; quoteIsCurrency0: boolean }> {
    const key = await this.key();
    const token = this.token.toLowerCase();
    const tokenIs0 = key.currency0.toLowerCase() === token;
    if (!tokenIs0 && key.currency1.toLowerCase() !== token) {
      throw new ArcNowError({
        code: "RpcFailure",
        message:
          `the migrator's pool key for ${this.token} is (${key.currency0}, ${key.currency1}), which `
          + "does not contain the token at all. Nothing was priced or sent.",
        details: { token: this.token, currency0: key.currency0, currency1: key.currency1 },
      });
    }
    const quote = await this.ctx.quoteTokenInfo(tokenIs0 ? key.currency1 : key.currency0);
    return { quote, quoteIsCurrency0: !tokenIs0 };
  }

  /** True once the curve has forwarded its assets and a pool exists. */
  async isMigrated(): Promise<boolean> {
    const pool = await withMappedErrors(
      { functionName: "migratedPool", address: this.token },
      () =>
        this.ctx.publicClient.readContract({
          address: this.token,
          abi: arcTokenAbi,
          functionName: "migratedPool",
        }),
    );
    // Non-zero means migrated. The VALUE is the PoolManager, the same one for
    // every token that graduated through this migrator -- never a pool address.
    return pool !== zeroAddress;
  }

  /**
   * Whether this SDK can trade this pool through the network's configured
   * router.
   *
   * - **No `contracts.v4Router`: `false`**, with no round trip and no throw, so
   *   a UI can ask before it renders a trade button. On Arc testnet that is
   *   the answer until arcnow.io's router is broadcast; it is "not yet", not
   *   "never".
   * - **A router configured:** the token migrator's `poolManager()` compared
   *   against the **router's own** `poolManager()`, both read off the chain.
   *   Not `config.v4.poolManager`, and that is the point: a check that
   *   compared one bundled address against another could be made to pass by a
   *   single stale entry in `networks.json`, which is exactly the kind of
   *   mistake it exists to catch. The router is the thing that has to reach
   *   the pool, and it holds its manager `immutable`, so it is asked once per
   *   client and the answer cached.
   *
   * With a router configured, `false` is terminal for this router: both
   * managers are immutable and the curve snapshotted its migrator at launch.
   *
   * Every quote and trade method asks the same question for you and refuses
   * with `NoRouterDeployed` or `PoolUnreachable`.
   */
  async isReachable(): Promise<boolean> {
    const router = configuredV4Router(this.ctx.config);
    if (router === undefined) return false;
    const [manager, served] = await Promise.all([
      this.poolManager(),
      routerPoolManager(this.ctx, router),
    ]);
    return manager.toLowerCase() === served.toLowerCase();
  }

  /* ---------------------------------------------------------------------- *
   * The refusal
   * ---------------------------------------------------------------------- */

  /**
   * The key, once we know there is a router, something to trade, and that the
   * router can reach it.
   *
   * Three questions, asked **in order** and none of them a formality. No
   * router is a property of the network and needs no RPC to know, so it comes
   * first and names the network rather than the token. A token that has not
   * migrated has no pool at all. And a pool in a manager the router does not
   * serve is one the router cannot see.
   *
   * Sequential rather than batched on purpose. A token that has not migrated
   * should not need its migrator read to be told so — and a chain that answers
   * the first read and fails the second would otherwise report a transport
   * failure for a token whose real answer was "there is no pool yet".
   */
  private async tradableKey(): Promise<{
    key: PoolKeyStruct;
    router: Address;
    poolManager: Address;
  }> {
    const router = this.router;
    const migrated = await this.isMigrated();

    if (!migrated) {
      throw new ArcNowError({
        code: "PoolNotMigrated",
        message:
          `${this.token} has not migrated, so it has no pool to trade in. Its market is `
          + "still its bonding curve: use client.curve(...), or client.trade(...), which "
          + "asks the token which venue it is on and dispatches for you. A graduated curve "
          + "whose migration was starved of gas sits here too — anybody can finish it with "
          + "the permissionless curve.migrate().",
        details: { token: this.token },
      });
    }

    const [manager, served] = await Promise.all([
      this.poolManager(),
      routerPoolManager(this.ctx, router),
    ]);
    if (manager.toLowerCase() !== served.toLowerCase()) {
      throw new ArcNowError({
        code: "PoolUnreachable",
        message:
          `${this.token}'s pool is in the Uniswap v4 PoolManager at ${manager}, and the `
          + `router this network configures, ${router}, serves ${served} (asked of the `
          + "router itself, not read out of this SDK's network preset). A v4 pool is a "
          + "PoolId inside ONE manager's storage and a router holds its manager immutable, "
          + "so this router cannot see this pool: handing it the correct PoolKey reverts "
          + "with 0x486aa307, PoolNotInitialized(), which reads like a bug in your key. "
          + "With arcnow.io's planned deployment this should not happen for an arcnow.io "
          + "token — its router is bound to the same PoolManager every arcnow.io migrator "
          + "opens pools in. So either contracts.v4Router names a router bound to a "
          + "different manager, or this token graduated through a migrator bound to one. "
          + "Retrying will not change it. Read Pool.isReachable() before offering a trade, "
          + "so the refusal lands in your UI rather than in somebody's wallet.",
        details: {
          token: this.token,
          poolManager: manager,
          routerPoolManager: served,
          router,
        },
      });
    }

    const key = await this.key();
    await this.requireVersions();
    return { key, router, poolManager: manager };
  }

  /* ---------------------------------------------------------------------- *
   * Quoting
   * ---------------------------------------------------------------------- */

  /**
   * Price a buy by `eth_call`ing the swap that would happen.
   *
   * Not arithmetic. The router is called for real, against the real pool, at
   * the latest block, with a state override supplying the money — and the
   * `BalanceDelta` it returns is the trader's own, **with the hook's 0.80% and
   * the pool's LP fee already inside it**. That is the only way to be right
   * here: there is no quoter on this chain, and the migrator's two single-sided
   * positions plus whatever anyone has added since mean the closed-form tick
   * maths does not apply.
   *
   * The fee is then derived from the identity `usdcIn * 0.80%`, which holds
   * because the hook takes its cut before the pool sees the input. See
   * {@link buyFeeFromUsdcIn}.
   */
  async quoteBuy(quoteIn: QuoteAmount, opts?: QuoteFrom): Promise<PoolBuyQuote> {
    if (quoteIn.isZero()) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          "a zero-value buy quote has no answer: the router would swap nothing and return "
          + "a zero delta, which is not a price. Something upstream produced zero.",
      });
    }
    const { key, router } = await this.tradableKey();
    const { quote, quoteIsCurrency0 } = await this.orientation();
    requireSameQuote(quoteIn, quote, `${this.token}'s pool`);
    const raw = quoteIn.toRaw();
    const from = opts?.from ?? this.signerAddress() ?? QUOTE_PROBE_ADDRESS;

    // The money for the call. Native USDC: a balance. An ERC-20: the router's
    // allowance, at the token's known allowance slot. Its BALANCE is not
    // overridden, for the same reason a sell's is not: a price for money nobody
    // holds is a number, not a quote.
    const allowanceSlot = quoteAllowanceSlot(this.ctx.config, quote.address);
    const stateOverride = quote.isNative
      ? [{ address: from, balance: raw + QUOTE_BALANCE_HEADROOM }]
      : [
          { address: from, balance: QUOTE_BALANCE_HEADROOM },
          ...(allowanceSlot === undefined
            ? []
            : [{
                address: quote.address,
                stateDiff: [{
                  slot: erc20AllowanceSlot(from, router, allowanceSlot),
                  value: numberToHex(maxUint256, { size: 32 }),
                }],
              }]),
        ];

    const delta = await withMappedErrors(
      { functionName: "swapExactTokensForTokens", address: router },
      async () => {
        const { result } = await this.ctx.publicClient.simulateContract({
          address: router,
          abi: uniswapV4Router04Abi,
          functionName: "swapExactTokensForTokens",
          args: [raw, 0n, quoteIsCurrency0, key, "0x", from, QUOTE_DEADLINE],
          ...(quote.isNative ? { value: raw } : {}),
          account: from,
          stateOverride,
        });
        return unpackBalanceDelta(result);
      },
    );

    const [quoteLeg, tokenLeg] = quoteIsCurrency0
      ? [delta.amount0, delta.amount1]
      : [delta.amount1, delta.amount0];
    const paid = Quote.fromRaw(quote, this.requirePaid(quoteLeg, "buy", quote.symbol));
    const received = this.requireReceived(tokenLeg, "buy", "tokens");
    return {
      venue: "pool",
      quoteIn: paid,
      tokensOut: Tokens.fromWad(received),
      feeQuote: buyFeeFromQuoteIn(paid),
    };
  }

  /**
   * Price a sell the same way, with one extra override.
   *
   * The router pulls the token leg with `safeTransferFrom(payer, poolManager,
   * amount)`, so an `eth_call` from a holder who has not approved it yet would
   * revert on the allowance rather than return a price. The allowance slot is
   * overridden for the call — see {@link arcTokenAllowanceSlot} — so a quote
   * costs nothing and commits to nothing.
   *
   * **The balance is deliberately not overridden.** `from` has to be somebody
   * who actually holds the tokens: a price for tokens nobody has would be a
   * number rather than a quote, and would quietly answer for a sell that cannot
   * be executed.
   */
  async quoteSell(tokensIn: Tokens, opts?: QuoteFrom): Promise<PoolSellQuote> {
    if (tokensIn.isZero()) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          "a zero-token sell quote has no answer: the router would swap nothing and return "
          + "a zero delta, which is not a price.",
      });
    }
    const { key, router } = await this.tradableKey();
    const from = opts?.from ?? this.signerAddress();
    if (from === undefined) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          "pricing a sell needs a holder to price it for. The router pulls the tokens with "
          + "transferFrom, and this SDK overrides the allowance for the call but not the "
          + "balance — so pass { from } naming an account that holds the tokens, or build "
          + "the client with a signer. A buy needs none of this and quotes on a read-only "
          + "client.",
        details: { token: this.token },
      });
    }

    const { quote, quoteIsCurrency0 } = await this.orientation();
    const delta = await withMappedErrors(
      { functionName: "swapExactTokensForTokens", address: router },
      async () => {
        const { result } = await this.ctx.publicClient.simulateContract({
          address: router,
          abi: uniswapV4Router04Abi,
          functionName: "swapExactTokensForTokens",
          args: [tokensIn.wad, 0n, !quoteIsCurrency0, key, "0x", from, QUOTE_DEADLINE],
          account: from,
          stateOverride: [
            { address: from, balance: QUOTE_BALANCE_HEADROOM },
            {
              address: this.token,
              stateDiff: [
                {
                  slot: arcTokenAllowanceSlot(from, router),
                  value: numberToHex(maxUint256, { size: 32 }),
                },
              ],
            },
          ],
        });
        return unpackBalanceDelta(result);
      },
    );

    const [quoteLeg, tokenLeg] = quoteIsCurrency0
      ? [delta.amount0, delta.amount1]
      : [delta.amount1, delta.amount0];
    const quoteOut = Quote.fromRaw(quote, this.requireReceived(quoteLeg, "sell", quote.symbol));
    const paid = this.requirePaid(tokenLeg, "sell", "tokens");
    return {
      venue: "pool",
      tokensIn: Tokens.fromWad(paid),
      quoteOut,
      feeQuote: sellFeeFromQuoteOut(quoteOut),
    };
  }

  /* ---------------------------------------------------------------------- *
   * Trading
   * ---------------------------------------------------------------------- */

  /**
   * Buy through the router, in the pool's quote.
   *
   * Native USDC is paid as `msg.value` and the router refunds what it did not
   * settle. An ERC-20 quote is pulled by the router in raw units, so when the
   * allowance to the router falls short the SDK first approves **exactly**
   * `quoteIn` and waits for it ({@link PoolTradeResult.approvalTxHash}).
   *
   * Unlike a curve buy, this **cannot graduate anything and cannot refund for
   * running out of inventory** — a pool has no inventory to run out of, only a
   * price that moves. And unlike a curve buy it can pay somebody else: see
   * {@link PoolBuyRequest.recipient}.
   */
  async buy(request: PoolBuyRequest): Promise<PoolTradeResult> {
    if (request.quoteIn.isZero()) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          "a zero-value buy would swap nothing and still cost gas. Something upstream "
          + "produced zero.",
      });
    }
    // Dust below one raw unit of an ERC-20 quote cannot be moved: refuse it first.
    const raw = request.quoteIn.toRaw();
    const { wallet, account } = this.ctx.requireSigner("pool.buy");
    await this.ctx.assertChain();
    const { key, router, poolManager } = await this.tradableKey();
    const { quote, quoteIsCurrency0 } = await this.orientation();
    requireSameQuote(request.quoteIn, quote, `${this.token}'s pool`);
    const payer = this.signerAddress() ?? zeroAddress;
    const recipient = request.recipient ?? payer;
    // An ERC-20 quote is pulled by the router: approve exactly this buy, and only
    // when the allowance falls short.
    const approvalTxHash = quote.isNative
      ? undefined
      : (await new QuoteToken(this.ctx, quote).ensureAllowance(router, request.quoteIn, {
        // A swap that would revert anyway costs no approve.
          beforeApprove: () => this.preflightSwap(router, [
            raw, request.minTokensOut.wad, quoteIsCurrency0, key, "0x", recipient,
            request.deadline.unixSeconds,
          ], quote, account),
        })).txHash;

    return withMappedErrors(
      { functionName: "swapExactTokensForTokens", address: router, quoteToken: quote },
      async () => {
        const args = [
          raw,
          request.minTokensOut.wad,
          quoteIsCurrency0,
          key,
          "0x",
          recipient,
          request.deadline.unixSeconds,
        ] as const;
        // An ERC-20 buy's fee share passes contracts#23's gas guard: never the bare estimate.
        const gas = quote.isNative
          ? undefined
          : withPoolQuoteTransferHeadroom(
              await this.ctx.publicClient.estimateContractGas({
                address: router, abi: uniswapV4Router04Abi, functionName: "swapExactTokensForTokens",
                args, account,
              }),
            );
        const { request: prepared } = await this.ctx.publicClient.simulateContract({
          address: router,
          abi: uniswapV4Router04Abi,
          functionName: "swapExactTokensForTokens",
          args,
          ...(quote.isNative ? { value: raw } : {}),
          account,
          chain: this.ctx.chain,
          ...(gas === undefined ? {} : { gas }),
        });
        const hash = await wallet.writeContract(prepared);
        const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash });
        const poolId = await this.poolId();
        // Read, not assumed to be quoteIn: the router settles what the pool
        // consumed and refunds (native) or never pulls (ERC-20) the rest.
        const fill = quoteFillFromLogs(receipt.logs, {
          side: "buy", poolManager, hook: key.hooks, poolId, hash, quoteToken: quote, quoteIsCurrency0,
        });
        return {
          venue: "pool" as const,
          hash,
          quote: fill.quote,
          tokens: this.tokensMovedTo(receipt.logs, recipient),
          feeQuote: fill.feeQuote,
          feesDistributed: fill.feesDistributed,
          approvalTxHash,
        };
      },
    );
  }

  /**
   * Sell into the pool, for its quote token.
   *
   * **This one needs an approval, and that is the sharpest difference from a
   * curve sell.** A curve sell never needs one — the curve pulls with
   * `curveTransferFrom`, a privileged path that reads no allowance at all. The
   * router has no such privilege: it calls `safeTransferFrom`, so the seller
   * must have approved it. See {@link Pool.approveRouter}.
   *
   * The allowance is checked before anything is sent, because the alternative
   * is a revert from inside SafeERC20 that names neither the router nor the
   * remedy.
   */
  async sell(request: PoolSellRequest): Promise<PoolTradeResult> {
    if (request.tokensIn.isZero()) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message: "a zero-token sell would swap nothing and still cost gas.",
      });
    }
    const { wallet, account } = this.ctx.requireSigner("pool.sell");
    await this.ctx.assertChain();
    const { key, router, poolManager } = await this.tradableKey();
    const { quote, quoteIsCurrency0 } = await this.orientation();
    requireSameQuote(request.minQuoteOut, quote, `${this.token}'s pool`);
    const payer = this.signerAddress() ?? zeroAddress;
    const recipient = request.recipient ?? payer;

    const allowance = await this.routerAllowance(payer);
    if (allowance.lt(request.tokensIn)) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          `selling ${request.tokensIn.toString()} tokens through the v4 router needs an `
          + `ERC-20 allowance and ${payer} has granted it ${allowance.toString()}. Call `
          + "pool.approveRouter(amount) first. There is no standing allowance to fall back "
          + "on: token.canonicalRouter() is the zero address on every arcnow.io token and "
          + "always will be for one already launched, because it is snapshotted from the "
          + "migrator registry at launch and Arc testnet's v4 migrator registers no router. "
          + "A CURVE sell needs none of this — the curve reads no allowance at all — so an "
          + "integration that worked before graduation will hit this the first time it "
          + "does not.",
        details: { token: this.token, router: router, owner: payer, allowance },
      });
    }

    return withMappedErrors(
      { functionName: "swapExactTokensForTokens", address: router, quoteToken: quote },
      async () => {
        const args = [
          request.tokensIn.wad,
          // Rounded UP to a whole raw unit: a floor is never loosened.
          request.minQuoteOut.ceilToRepresentable().toRaw(),
          !quoteIsCurrency0,
          key,
          "0x",
          recipient,
          request.deadline.unixSeconds,
        ] as const;
        // An ERC-20 payout's fee share passes contracts#23's gas guard: never the bare estimate.
        const gas = quote.isNative
          ? undefined
          : withPoolQuoteTransferHeadroom(
              await this.ctx.publicClient.estimateContractGas({
                address: router, abi: uniswapV4Router04Abi, functionName: "swapExactTokensForTokens",
                args, account,
              }),
            );
        const { request: prepared } = await this.ctx.publicClient.simulateContract({
          address: router,
          abi: uniswapV4Router04Abi,
          functionName: "swapExactTokensForTokens",
          args,
          account,
          chain: this.ctx.chain,
          ...(gas === undefined ? {} : { gas }),
        });
        const hash = await wallet.writeContract(prepared);
        const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash });
        const poolId = await this.poolId();
        const fill = quoteFillFromLogs(receipt.logs, {
          side: "sell", poolManager, hook: key.hooks, poolId, hash, quoteToken: quote, quoteIsCurrency0,
        });
        return {
          venue: "pool" as const,
          hash,
          quote: fill.quote,
          tokens: this.tokensMovedFrom(receipt.logs, payer),
          feeQuote: fill.feeQuote,
          feesDistributed: fill.feesDistributed,
        };
      },
    );
  }

  /* ---------------------------------------------------------------------- *
   * The hook
   * ---------------------------------------------------------------------- */

  /**
   * The `VERSION()` of this pool's fee hook, read off the chain. The one this SDK
   * books fees for is `arcnow/arc-now-fee-hook@4.x.x`, which takes the pool's own
   * 0.80%, accrues each fee as an ERC-6909 claim and pays it out in a later
   * transaction.
   */
  async hookVersion(): Promise<string> {
    const { hooks } = await this.key();
    return withMappedErrors({ functionName: "VERSION", address: hooks }, () =>
      this.ctx.publicClient.readContract({
        address: hooks,
        abi: arcNowFeeHookAbi,
        functionName: "VERSION",
      }));
  }

  /**
   * Refuse, once per handle, a pool whose migrator is not
   * `arcnow/uniswap-v4-migrator@2.x.x` or whose fee hook is not
   * `arcnow/arc-now-fee-hook@4.x.x`. Every quote and trade asks before it
   * simulates: another hook's fee events have another signature, and a fill read
   * against the wrong one silently reports no fee and the wrong amount.
   */
  private requireVersions(): Promise<void> {
    if (this.versionsChecked !== undefined) return this.versionsChecked;
    const pending = (async () => {
      const migrator = await this.migrator();
      const version = await withMappedErrors({ functionName: "VERSION", address: migrator }, () =>
        this.ctx.publicClient.readContract({
          address: migrator,
          abi: uniswapV4MigratorAbi,
          functionName: "VERSION",
        }));
      assertV4MigratorVersion(version, `${this.token}'s v4 migrator at ${migrator}`, migrator);
      await this.requireHook();
    })();
    this.versionsChecked = pending;
    pending.catch(() => {
      if (this.versionsChecked === pending) this.versionsChecked = undefined;
    });
    return pending;
  }

  /** The router swap simulated with the router's allowance overridden, when the slot is known. */
  private async preflightSwap(
    router: Address,
    args: readonly [bigint, bigint, boolean, PoolKeyStruct, Hex, Address, bigint],
    quote: QuoteTokenInfo,
    account: Account | Address,
  ): Promise<void> {
    const stateOverride = allowanceOverride(this.ctx, quote, signerAddressOf(account), router);
    if (stateOverride === undefined) return;
    await withMappedErrors({ functionName: "swapExactTokensForTokens", address: router }, () =>
      this.ctx.publicClient.simulateContract({
        address: router,
        abi: uniswapV4Router04Abi,
        functionName: "swapExactTokensForTokens",
        args,
        account,
        chain: this.ctx.chain,
        stateOverride,
      }));
  }

  /**
   * The pool's hook, or `UnknownHookVersion` for a hook that is not
   * `arcnow/arc-now-fee-hook@4.x.x` — how any other hook books its fees, and at
   * what rate, is unknown, so nothing is read from it or sent to it. The retired
   * `@3.x.x` hook, which charged the curve's 1% in the pool, is refused by name.
   */
  private async requireHook(): Promise<Address> {
    const [version, { hooks }] = await Promise.all([this.hookVersion(), this.key()]);
    try {
      assertHookVersion(version, `${this.token}'s pool's fee hook at ${hooks}`, hooks);
    } catch (error) {
      if (error instanceof ArcNowError && error.code === "UnknownHookVersion") {
        throw new ArcNowError({
          code: "UnknownHookVersion",
          message:
            `${error.message} This SDK will not guess how another hook books its fees, so `
            + "nothing was read from it or sent to it.",
          details: { token: this.token, hook: hooks, version },
        });
      }
      throw error;
    }
    return hooks;
  }

  /**
   * What the hook takes on every swap of this pool, bps of the trade, **read
   * off the hook** (`feeBps()`): 80, 0.80%. Not the curve's 100 — the pool's
   * LP fee makes up the rest; see {@link Pool.fees}.
   *
   * @throws {ArcNowError} `UnknownHookVersion` on a hook of any other version.
   */
  async hookFeeBps(): Promise<Bps> {
    const hooks = await this.requireHook();
    return withMappedErrors({ functionName: "feeBps", address: hooks }, async () =>
      Bps.of(await this.ctx.publicClient.readContract({
        address: hooks,
        abi: arcNowFeeHookAbi,
        functionName: "feeBps",
      })));
  }

  /**
   * How the hook splits this pool's fee, **read off the hook**
   * (`feeConfigOf(poolId)`): creator 5000 / platform 1875 / protocol 3125 bps
   * of the hook's 0.80%, a referrer share of zero, and the platform and protocol
   * recipients the pool was registered with. Written by the migrator at
   * graduation from the hook's own constants — not the curve's split, which a
   * platform configures — and immutable thereafter.
   *
   * @throws {ArcNowError} `UnknownHookVersion` on a hook of any other version.
   */
  async feeConfig(): Promise<FeeConfig> {
    const hooks = await this.requireHook();
    const poolId = await this.poolId();
    return withMappedErrors({ functionName: "feeConfigOf", address: hooks }, async () => {
      const config = await this.ctx.publicClient.readContract({
        address: hooks,
        abi: arcNowFeeHookAbi,
        functionName: "feeConfigOf",
        args: [poolId],
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
   * What a trade in this pool costs, all told: the hook's 0.80%
   * ({@link Pool.hookFeeBps}) plus the pool's 0.20% LP fee (the key's `fee`,
   * in hundredths of a bip), 1.00% of the trade — the same as the curve charged
   * before graduation — and how the hook's part is split
   * ({@link Pool.feeConfig}). Every figure is read off the chain.
   */
  async fees(): Promise<PoolFees> {
    const [hookFeeBps, split, key] = await Promise.all([
      this.hookFeeBps(), this.feeConfig(), this.key(),
    ]);
    return {
      hookFeeBps,
      lpFeePips: key.fee,
      totalBps: Bps.of(hookFeeBps.bps + BigInt(key.fee) / 100n),
      split,
    };
  }

  /**
   * The fee this pool's hook has charged and **not yet paid out**:
   * `accruedFee(poolId)`, in raw units of the pool's quote, scaled to WAD. It rises
   * by exactly each swap's `HookFeeTaken` and
   * falls to what the latest transaction charged when a later swap of the pool,
   * or anyone's {@link Pool.distributeHookFees}, pays the rest out.
   *
   * @throws {ArcNowError} `UnknownHookVersion` on a hook of any other version.
   */
  async accruedHookFee(): Promise<QuoteAmount> {
    const hooks = await this.requireHook();
    const [poolId, { quote }] = await Promise.all([this.poolId(), this.orientation()]);
    return withMappedErrors({ functionName: "accruedFee", address: hooks }, async () =>
      Quote.fromRaw(
        quote,
        await this.ctx.publicClient.readContract({
          address: hooks,
          abi: arcNowFeeHookAbi,
          functionName: "accruedFee",
          args: [poolId],
        }),
      ));
  }

  /**
   * Pay out this pool's accrued fees now: the hook's permissionless
   * `distributeFees(key)`, which anyone may call and which pays the pool's
   * three recipients — creator, platform, protocol — never the caller.
   *
   * Only claims from **earlier** transactions are paid; a fee charged in the
   * same transaction stays accrued. The amount is read from the
   * `FeesDistributed` log in this transaction's receipt.
   *
   * @throws {ArcNowError} `UnknownHookVersion` on a hook that is not
   *   `arcnow/arc-now-fee-hook@4.x.x`, before anything is simulated.
   */
  async distributeHookFees(): Promise<{ amount: QuoteAmount; hash: `0x${string}` }> {
    const { wallet, account } = this.ctx.requireSigner("pool.distributeHookFees");
    await this.ctx.assertChain();
    await this.requireHook();
    const [key, poolId, { quote }] = await Promise.all([
      this.key(), this.poolId(), this.orientation(),
    ]);
    return withMappedErrors({ functionName: "distributeFees", address: key.hooks }, async () => {
      const { request } = await this.ctx.publicClient.simulateContract({
        address: key.hooks,
        abi: arcNowFeeHookAbi,
        functionName: "distributeFees",
        args: [key],
        account,
        chain: this.ctx.chain,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash });
      const source = { hook: key.hooks, poolId, quoteToken: quote };
      const amount = feesDistributedIn(receipt.logs, source);
      return { amount, hash };
    });
  }

  /* ---------------------------------------------------------------------- *
   * The approval
   * ---------------------------------------------------------------------- */

  /**
   * How many tokens `owner` has approved the v4 router to move.
   *
   * **Zero until somebody approves, and there is no fallback.**
   * `token.canonicalRouter()` — the address every holder's allowance answers
   * `uint256.max` for after migration — is the **zero address on every
   * arcnow.io token**, and will stay that way for any token already launched:
   * it is snapshotted from the migrator registry at launch, immutably, and Arc
   * testnet's v4 migrator registers no router. So the auto-approval mechanism
   * exists and applies to nothing here.
   */
  async routerAllowance(owner: Address): Promise<Tokens> {
    const router = this.router;
    return withMappedErrors({ functionName: "allowance", address: this.token }, async () =>
      Tokens.fromWad(
        await this.ctx.publicClient.readContract({
          address: this.token,
          abi: arcTokenAbi,
          functionName: "allowance",
          args: [owner, router],
        }),
      ));
  }

  /**
   * Approve the v4 router to move `amount` of this token. Resolves once mined,
   * so the allowance is readable the moment this returns.
   *
   * Permit2 would avoid this transaction and the router supports it; this SDK
   * does not use it, deliberately. Permit2 is a second approval system with its
   * own expiry semantics and its own nonce book, and an SDK that quietly moved
   * a caller's allowance into it would make `token.allowance(owner, router)` —
   * the thing every integration and every explorer reads — stop being the
   * answer to "can this sell go through".
   */
  async approveRouter(amount: Tokens): Promise<`0x${string}`> {
    const { wallet, account } = this.ctx.requireSigner("pool.approveRouter");
    await this.ctx.assertChain();
    const router = this.router;
    return withMappedErrors({ functionName: "approve", address: this.token }, async () => {
      const { request } = await this.ctx.publicClient.simulateContract({
        address: this.token,
        abi: arcTokenAbi,
        functionName: "approve",
        args: [router, amount.wad],
        account,
        chain: this.ctx.chain,
      });
      const hash = await wallet.writeContract(request);
      await this.ctx.publicClient.waitForTransactionReceipt({ hash });
      return hash;
    });
  }

  /* ---------------------------------------------------------------------- *
   * Plumbing
   * ---------------------------------------------------------------------- */

  /** The signer's address, when there is a signer. */
  private signerAddress(): Address | undefined {
    const account = this.ctx.account;
    if (account === undefined) return undefined;
    return typeof account === "string" ? account : account.address;
  }

  /**
   * Sum the token this pool trades out of a receipt's logs, into `to`.
   *
   * The `Transfer` log is ground truth for the token leg. The USDC leg has no
   * such event — native USDC moves without one — and is read from the
   * PoolManager's `Swap` instead; see {@link quoteFillFromLogs}.
   */
  private tokensMovedTo(logs: Log[], to: Address): Tokens {
    return this.sumTransfers(logs, (args) => args.to.toLowerCase() === to.toLowerCase());
  }

  /** The same, out of `from`. */
  private tokensMovedFrom(logs: Log[], from: Address): Tokens {
    return this.sumTransfers(logs, (args) => args.from.toLowerCase() === from.toLowerCase());
  }

  private sumTransfers(
    logs: Log[],
    matches: (args: { from: Address; to: Address }) => boolean,
  ): Tokens {
    const transfers = parseEventLogs({
      abi: arcTokenAbi,
      eventName: "Transfer",
      logs,
    }).filter((log) => log.address.toLowerCase() === this.token.toLowerCase());
    let total = 0n;
    for (const log of transfers) {
      if (matches({ from: log.args.from, to: log.args.to })) total += log.args.value;
    }
    return Tokens.fromWad(total);
  }

  /**
   * A leg the trader **paid**, as a positive magnitude.
   *
   * The sign check is not a formality. `BalanceDelta` is two packed `int128`s
   * and the whole class of bug this file guards against is reading them with
   * the wrong sign or the wrong width — which produces a plausible-looking
   * quote, not an error. If the router ever returns a delta whose signs
   * contradict the swap that was asked for, that is worth saying out loud
   * rather than reporting as a price.
   */
  private requirePaid(amount: bigint, side: string, leg: string): bigint {
    if (amount >= 0n) {
      throw new ArcNowError({
        code: "RpcFailure",
        message:
          `the router returned a BalanceDelta whose ${leg} leg is ${amount} on a ${side}. `
          + "On that side it is what the trader gives up, so it has to be negative. Either "
          + "the pool key does not name the pool you think it does, or the delta was "
          + "unpacked against a different BalanceDelta layout than the one deployed.",
        details: { token: this.token, amount, side, leg },
      });
    }
    return -amount;
  }

  /** A leg the trader **received**. Same reasoning as {@link Pool.requirePaid}. */
  private requireReceived(amount: bigint, side: string, leg: string): bigint {
    if (amount <= 0n) {
      throw new ArcNowError({
        code: "RpcFailure",
        message:
          `the router returned a BalanceDelta whose ${leg} leg is ${amount} on a ${side}, `
          + "and that leg is what the trader receives, so it must be positive. A zero here "
          + "usually means the pool holds no liquidity on the side you are trading into.",
        details: { token: this.token, amount, side, leg },
      });
    }
    return amount;
  }
}
