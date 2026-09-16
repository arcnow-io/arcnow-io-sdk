/**
 * The shapes the read and write surfaces exchange.
 *
 * Every amount here is one of the branded types from `./amounts.js`, never a
 * bare `bigint`. The raw 18-decimal integer is one `.wad` away whenever it is
 * actually wanted; what the type buys is that it cannot be confused with a
 * token quantity, with a 6-decimal ERC-20 figure, or with a basis-point count.
 *
 * @module
 */

import type { Address, Hash, TransactionReceipt } from "viem";

import type { Bps, QuoteAmount, QuoteTokenInfo, Tokens, Usdc } from "./amounts.js";
import type { CurveParams } from "./curve-math.js";
import type { Deadline } from "./deadline.js";

/* -------------------------------------------------------------------------- *
 * Launching
 * -------------------------------------------------------------------------- */

/** A launch request. */
export interface LaunchParams {
  /** Human-readable token name. Must not be empty. */
  readonly name: string;
  /** Ticker symbol. Must not be empty. */
  readonly symbol: string;
  /**
   * URI of the off-chain metadata document. Must not be empty — it is where
   * every UI reads the token's image and description from, and a launch without
   * one produces a token nothing can display.
   */
  readonly metadataUri: string;
  /**
   * What the creator wants to spend on the first buy, **in the quote token the
   * token launches against**. May be zero — `QuoteAmount.zero(quote)` or
   * `Usdc.ZERO`.
   *
   * **This amount's token IS the launch's quote.** A token launched with a EURC
   * initial buy is priced in EURC for life; there is no separate quote field to
   * disagree with it. For an ERC-20 quote the amount must be representable in
   * the token's own decimals, and the SDK approves the launchpad for exactly the
   * launch fee plus this before it launches.
   *
   * **This is an ordinary buy.** It runs through the curve's own `buy` and
   * therefore pays the 1% trade fee on top of the flat launch fee. There is no
   * fee-free entry into a curve: a second pricing path would be a code path
   * that could disagree with the quote a user was shown, and a route a creator
   * could push volume through. {@link LaunchQuote} reports the two charges
   * separately so a UI can name both.
   */
  readonly initialBuy: QuoteAmount;
  /**
   * The most launch fee this launch may be charged, in the launch's quote.
   *
   * The launch fee is per quote and set by the protocol admin, so it can change
   * while this transaction waits in the mempool. **Omitted, it defaults to the
   * fee just quoted**, so a raise reverts the launch with `LaunchFeeAboveMaximum`
   * rather than overcharging it.
   *
   * **A larger cap does not let a launch absorb a raise**: a native launch sends
   * exactly the quoted fee plus initial buy as value (a different fee reverts
   * `IncorrectPayment`), and an ERC-20 launch approves exactly the quoted total.
   * A raise always means quoting again. A smaller cap refuses a fee you consider
   * too high before anything is spent.
   */
  readonly maxLaunchFee?: QuoteAmount | undefined;
  /**
   * Slippage floor for the initial buy.
   *
   * Meaningful even though the launch is atomic: it pins the creator's
   * expectation against the platform's curve template changing between signing
   * and inclusion, which is a real risk rather than a theoretical one — a
   * platform admin can move its template at any time and this transaction may
   * sit in the mempool.
   */
  readonly minTokensOut: Tokens;
  /**
   * The `PlatformConfig` to launch under.
   *
   * Its fee split, curve template and default migrator are snapshotted onto the
   * new curve and token, and nothing the platform does afterwards reaches them.
   * Must be registered **at inclusion**, not at signing.
   *
   * **Omitting this is resolved by the SDK**, which substitutes the network's
   * `arcnowPlatform` address before encoding. The launchpad itself has no
   * notion of a default platform and would reject a zero address here with
   * `PlatformNotRegistered`. Compare {@link LaunchParams.migrator}, where the
   * omission means something different — the two look alike and are not.
   */
  readonly platform?: Address | undefined;
  /**
   * Graduation target of the creator's choosing, from the protocol's registry.
   *
   * **Omitting this is resolved by the contract, not by the SDK.** It encodes
   * `address(0)`, which is the launchpad's own spelling of "use this platform's
   * default migrator" — `Launchpad._resolveMigrator` reads it that way. The SDK
   * substitutes nothing and looks nothing up, so the default that applies is
   * the platform's at the moment of inclusion, not one this client read
   * earlier.
   *
   * That is what almost every launch does. Whichever migrator results, it is
   * snapshotted onto the curve and is immutable from then on.
   */
  readonly migrator?: Address | undefined;
  /**
   * An explicit gas limit for the launch transaction, instead of letting the
   * node estimate one.
   *
   * **You should not normally need this.** The SDK reads
   * {@link LaunchQuote.graduates} before it sends and supplies
   * {@link GRADUATION_GAS_LIMIT} itself when the initial buy would graduate the
   * curve, because the estimate is exactly wrong in that case and leaving a
   * caller to know was a footgun rather than a feature. Pass this to override
   * that, or to raise the limit on an ordinary launch.
   *
   * **Why the estimate is wrong.** A launch whose *initial buy* reaches the
   * graduation target graduates the curve inside the launch transaction, and
   * the curve then attempts the migration under a bounded budget and
   * **catches its failure**, logging `InstantMigrationFailed` rather than
   * reverting. So the launch succeeds whether or not the migration runs, and
   * `eth_estimateGas` — which searches for the lowest limit at which the
   * transaction still succeeds — converges on precisely the limit that starves
   * it. Observed live on Arc testnet: an estimate of 6,250,146 against a used
   * 5,452,572, a token with no market, and no error anywhere.
   *
   * The curve budgets up to `INSTANT_MIGRATION_GAS_LIMIT` (6,000,000) for the
   * migrator and keeps `POST_MIGRATION_GAS_RESERVE` (100,000) back for itself,
   * so a graduating launch needs a limit comfortably above 6.1M on top of the
   * two deployments the launch itself performs. A limit below
   * {@link GRADUATION_GAS_FLOOR} on a launch the quote says will graduate is
   * **refused** rather than sent, because it is a transaction that would
   * silently do the wrong thing. It is a ceiling, not a charge: unused gas is
   * not paid for.
   *
   * Spelled `gas_limit` in the Rust SDK's `LaunchParams`, and the same concept.
   * Deliberately not called `gas`, viem's own name for the field it ends up in:
   * this is the SDK's own option, and the two halves agreeing on what to call
   * it matters more than matching the transport underneath. Compare
   * {@link BuyRequest.gasLimit}, which is the same trap on the buy path.
   */
  readonly gasLimit?: bigint | undefined;
}

/** What a launch would cost and deliver. */
export interface LaunchQuote {
  /** The quote token the launch is priced in: `LaunchParams.initialBuy.token`. */
  readonly quoteToken: QuoteTokenInfo;
  /** The flat launch fee for this quote, as the quote registry records it now. */
  readonly launchFee: QuoteAmount;
  /** The initial buy, as requested. */
  readonly initialBuy: QuoteAmount;
  /**
   * What the launch costs in total, in the quote: the launch fee plus the
   * initial buy. For native USDC this is paid as value; for an ERC-20 it is
   * pulled, and it is exactly what the SDK approves the launchpad for.
   */
  readonly totalCost: QuoteAmount;
  /**
   * **Exactly** the `msg.value` `launch` requires: the total cost for native
   * USDC, and zero for an ERC-20 quote, which is pulled instead. Not "at least":
   * the launchpad reverts with `IncorrectPayment` on an overpayment as readily as
   * on an underpayment, because it has no refund path.
   */
  readonly nativeValue: Usdc;
  /** Tokens the initial buy would deliver. Zero when the initial buy is zero. */
  readonly tokensOut: Tokens;
  /** The 1% trade fee the initial buy would pay, **on top of** the launch fee, in the quote. */
  readonly tradeFee: QuoteAmount;
  /**
   * True when the initial buy alone would take the new curve to its graduation
   * target — so the launch deploys a token, graduates it and attempts its
   * migration, all in one transaction.
   *
   * Not an exotic case: the target is whatever the platform's live template
   * says, and on arcnow.io's own platform it is 50 USDC. An initial buy of 60
   * does it.
   *
   * Computed rather than returned by `quoteLaunch`, which reports only cost and
   * fill: the SDK reads the platform's **live** curve template and applies the
   * curve's own rule — the buy graduates when the reserve it leaves behind
   * reaches the target, or when it clears the curve's whole inventory. When it
   * is true the SDK sends {@link GRADUATION_GAS_LIMIT} rather than an estimate;
   * see {@link LaunchParams.gasLimit} for why an estimate is exactly wrong
   * here.
   */
  readonly graduates: boolean;
}

/** What a launch produced. */
export interface LaunchResult {
  /** The deployed token. */
  readonly token: Address;
  /** Its bonding curve, bound to it for life. */
  readonly curve: Address;
  /** Tokens the initial buy delivered. Zero when the initial buy was zero. */
  readonly tokensOut: Tokens;
  /**
   * True when the initial buy took the new curve straight to its target, so the
   * token graduated in the transaction that created it and will never trade on
   * its curve again.
   *
   * Read from the `Graduated` log in the launch's **own** receipt.
   */
  readonly graduated: boolean;
  /**
   * True when a migration was attempted inside this launch and did not succeed.
   *
   * Not an error and deliberately not a revert: the token exists, the creator
   * holds their tokens, the curve is graduated and every asset is still on it.
   * What it means is that somebody should call `migrate()`, which stays
   * permissionless and forwards an unbounded gas budget.
   *
   * **The most likely cause is a gas limit estimated rather than chosen** — see
   * {@link LaunchParams.gasLimit}. This is what was observed live on Arc
   * testnet before the SDK supplied a limit of its own.
   */
  readonly instantMigrationFailed: boolean;
  /**
   * True when the curve's assets reached the migrator **in this very
   * transaction** — the `Migrated` log is in the launch's own receipt.
   *
   * This is the question worth asking, and it is not the same as "is the curve
   * migrated now". A launch that graduates and whose migration runs out of gas
   * still succeeds, and `migrate()` stays open to anyone, so a later read of
   * the chain can say `migrated` about a curve a stranger rescued minutes
   * afterwards. Only this field distinguishes the instant path from the retry
   * path, and the difference is whether the token had a market the moment it
   * was created.
   *
   * False on every ordinary launch, which graduates nothing.
   */
  readonly migratedInThisTransaction: boolean;
  /**
   * The canonical pool the migrator reported, when this launch migrated the
   * curve.
   *
   * `undefined` when the launch did not migrate, and also when the migrator
   * created no market at all — an escrow migration reports the zero address.
   */
  readonly pool?: Address | undefined;
  /**
   * The approve sent first, for an ERC-20 quote whose allowance to the launchpad
   * fell short of the total cost. `undefined` when none was needed.
   */
  readonly approvalTxHash?: Hash | undefined;
  /** The transaction. */
  readonly txHash: Hash;
  /** Its receipt, for anyone who wants the logs. */
  readonly receipt: TransactionReceipt;
}

/* -------------------------------------------------------------------------- *
 * Curve state and quotes
 * -------------------------------------------------------------------------- */

/** A curve's whole live state, read in one round trip. */
export interface CurveState {
  /**
   * The curve's `VERSION()`, verbatim: always `arcnow/bonding-curve@2.x.x`, because
   * any other version is refused before any state is read.
   */
  readonly version: string;
  /**
   * The quote token this curve is priced in, for life: native USDC or an
   * allowlisted ERC-20. Every amount below is in it.
   */
  readonly quoteToken: QuoteTokenInfo;
  /** The curve's immutable parameters, `{ r0Wad, y0Wad }`. */
  readonly params: CurveParams;
  /** Tokens the curve sells over its whole life. Immutable. */
  readonly curveSupply: Tokens;
  /** The trade fee in basis points: 100 on every arcnow.io curve. Immutable. */
  readonly tradeFeeBps: Bps;
  /** The token this curve trades. Immutable. */
  readonly token: Address;
  /**
   * Who receives the creator share of every fee.
   *
   * Read through to `token.creator()`, which is the single source of truth and
   * is transferable by its holder — so that a creator whose address is
   * blocklisted on Arc has somewhere to go without the curve needing an admin.
   * The creator holds no privilege over the curve.
   */
  readonly creator: Address;
  /**
   * Where this curve's assets go at graduation. Chosen at launch and
   * **immutable**.
   *
   * This, not a network-wide venue list, is the answer to "where does this
   * token trade after it graduates".
   */
  readonly migrator: Address;
  /**
   * The marginal price of the next token: `floor(ceil(k / Y) · 1e18 / Y)`, with
   * `k = r0Wad · y0Wad` and `Y = y0Wad − tokensSold`.
   *
   * **Not the price a trade of any size fills at.** Use {@link BuyQuote} and
   * {@link SellQuote} for that: the curve integrates the price across an order,
   * so a buyer pays a rising price over their own trade.
   */
  readonly spotPrice: QuoteAmount;
  /** Tokens sold so far. Never exceeds the curve supply. */
  readonly tokensSold: Tokens;
  /** Tokens still held for sale. A buy is capped at this. */
  readonly tokensRemaining: Tokens;
  /**
   * Real USDC the curve owes its holders: `virtualReserve - R0`.
   *
   * This is the number compared against {@link CurveState.target} for
   * graduation. After migration the money is at the migrator, not here — read
   * {@link CurveState.migrated} before treating it as custodied.
   */
  readonly realReserve: QuoteAmount;
  /**
   * The virtual reserve `R`, which starts at `R0` rather than zero.
   *
   * Migration does not rewind it: it stays as the permanent record of what the
   * curve collected over its life.
   */
  readonly virtualReserve: QuoteAmount;
  /**
   * Real USDC the curve must collect to graduate.
   *
   * **This curve's own**, snapshotted from its platform's template at launch and
   * immutable since. It is not a protocol constant and not today's template: a
   * platform admin can change what the *next* launch gets at any time, and a
   * curve launched under an older template keeps the older target for life. So
   * this is the only correct source for a particular token, and the reason
   * `CurveTemplate.arcnowDefaults()` must never be substituted for it.
   */
  readonly target: QuoteAmount;
  /**
   * Progress toward the target, out of 10,000, capped there.
   *
   * The one place in this SDK where bps is not a share of a fee.
   */
  readonly progressBps: Bps;
  /** True once the target was reached. **Terminal**: no buy or sell will ever succeed again. */
  readonly graduated: boolean;
  /** True once the assets have been forwarded to the migrator. */
  readonly migrated: boolean;
}

/** A priced buy, as the curve would fill it right now. */
export interface BuyQuote {
  /** Tokens the buyer receives, rounded down. */
  readonly tokensOut: Tokens;
  /** The trade fee, taken from the input before anything reaches the reserve. */
  readonly fee: QuoteAmount;
  /** Quote actually consumed, fee included. */
  readonly quoteSpent: QuoteAmount;
  /**
   * USDC that would come back because the curve ran out of inventory.
   *
   * Zero unless this buy fills the curve. A buy is capped at the remaining
   * inventory: the curve will not take a wei more than clears it, so the last
   * buy on a curve is routinely sent more than it can spend and the remainder
   * is refunded — or credited to `pendingWithdrawal` if that transfer fails.
   */
  readonly refund: QuoteAmount;
  /** The virtual reserve after the trade. */
  readonly newReserve: QuoteAmount;
  /** Tokens sold after the trade. */
  readonly newTokensSold: Tokens;
  /** The spot price after the trade. */
  readonly newPrice: QuoteAmount;
  /**
   * True if this trade takes the curve to its target and ends trading forever.
   *
   * The graduating buy also **migrates the curve in the same transaction**,
   * under a bounded gas budget with its failure caught. Nobody has to poll and
   * the buyer does not have to send a second transaction.
   */
  readonly graduates: boolean;
}

/** A priced sell, as the curve would fill it right now. */
export interface SellQuote {
  /** Quote the seller receives, net of fee, rounded down. */
  readonly quoteOut: QuoteAmount;
  /** The trade fee, taken from the proceeds. */
  readonly fee: QuoteAmount;
  /** Quote leaving the reserve before the fee. */
  readonly gross: QuoteAmount;
  /** The virtual reserve after the trade. */
  readonly newReserve: QuoteAmount;
  /** Tokens sold after the trade. */
  readonly newTokensSold: Tokens;
  /** The spot price after the trade. */
  readonly newPrice: QuoteAmount;
}

/* -------------------------------------------------------------------------- *
 * Trading
 * -------------------------------------------------------------------------- */

/** A buy. */
export interface BuyRequest {
  /**
   * What to spend, **in the curve's quote token** — refused with
   * `QuoteTokenMismatch` otherwise.
   *
   * - **Native USDC** is the transaction's value: no allowance, no transfer.
   * - **An ERC-20 quote** is pulled by the curve through `buyWithQuote`. The
   *   amount must be representable in the token's decimals
   *   (`QuoteAmountNotRepresentable` otherwise), and the SDK approves the curve
   *   for exactly this amount first when the allowance falls short.
   */
  readonly quoteIn: QuoteAmount;
  /** Slippage floor. Required; see `./slippage.js` for why it has no default. */
  readonly minTokensOut: Tokens;
  /** When the order stops being valid. */
  readonly deadline: Deadline;
  /**
   * A referrer to credit out of the fee, or nothing.
   *
   * Not validated beyond the zero check that redirects it: this is the caller's
   * own choice of who to credit out of the fee they are paying, the amounts are
   * fixed by the curve's snapshotted split, and naming a bad address costs the
   * caller nothing extra and cannot enlarge anyone's share. Omitting it sends
   * that share to the platform.
   */
  readonly referrer?: Address | undefined;
  /** An integrating developer to credit out of the fee. Same rules as the referrer. */
  readonly developer?: Address | undefined;
  /**
   * An explicit gas limit for this transaction, instead of letting the node
   * estimate one.
   *
   * **Pass this on a buy that might graduate the curve, or the instant
   * migration will silently not happen.**
   *
   * `eth_estimateGas` searches for the lowest limit at which the transaction
   * still *succeeds*. A graduating buy succeeds either way: the curve attempts
   * the migration under a bounded budget and **catches its failure**, logging
   * {@link BuyResult.instantMigrationFailed} rather than reverting. So the
   * estimate converges on precisely the limit at which the migration runs out
   * of gas and is caught — the buy fills, the curve graduates, and the pool is
   * simply never created. Nothing looks wrong anywhere: no revert, no error,
   * and `migrate()` is still open as the permissionless retry, so the only
   * symptom is a graduated token with no market until somebody notices.
   *
   * The curve budgets up to `INSTANT_MIGRATION_GAS_LIMIT` (6,000,000) for the
   * migrator and keeps `POST_MIGRATION_GAS_RESERVE` (100,000) back for itself,
   * so a buy that should migrate in its own transaction needs a limit
   * comfortably above 6.1M — **8,000,000 is the number this SDK's own fork
   * tests use** and the one to copy if you have no better figure. It is a
   * ceiling, not a charge: unused gas is not paid for.
   *
   * Leave it out for an ordinary buy well short of the target, where the
   * estimate is correct and cheaper.
   *
   * Spelled `gas_limit` in the Rust SDK's `BuyRequest`, and the same concept.
   * It is deliberately not called `gas`, viem's own name for the field it
   * ends up in: this is the SDK's own option, and the two halves agreeing on
   * what to call it matters more than matching the transport underneath.
   */
  readonly gasLimit?: bigint | undefined;
}

/** A sell. */
export interface SellRequest {
  /** Tokens to sell. */
  readonly tokensIn: Tokens;
  /** Slippage floor, net of fee, in the curve's quote token. Required. */
  readonly minQuoteOut: QuoteAmount;
  /** When the order stops being valid. */
  readonly deadline: Deadline;
  /** A referrer to credit out of the fee. */
  readonly referrer?: Address | undefined;
  /** An integrating developer to credit out of the fee. */
  readonly developer?: Address | undefined;
}

/** What a buy actually did, read back out of its own logs. */
export interface BuyResult {
  /** Tokens delivered. */
  readonly tokensOut: Tokens;
  /** Quote consumed, fee included, excluding any refund. */
  readonly quoteSpent: QuoteAmount;
  /**
   * Quote not spent. Native USDC is sent back (or credited to
   * `pendingWithdrawal` if that transfer fails); an ERC-20 quote's unspent part
   * is simply never pulled.
   */
  readonly refund: QuoteAmount;
  /** The trade fee taken. */
  readonly fee: QuoteAmount;
  /** The spot price after the trade. */
  readonly newPrice: QuoteAmount;
  /** True when this buy took the curve to its target. */
  readonly graduated: boolean;
  /**
   * True when the migration attempted inside this buy did not succeed.
   *
   * Not an error and deliberately not a revert: the buyer keeps their tokens,
   * the curve is graduated and every asset is still on it. What it means is
   * that somebody should call `migrate()`, which stays permissionless and
   * forwards an unbounded gas budget.
   *
   * **The most likely cause is a gas limit estimated rather than chosen.** See
   * {@link BuyRequest.gasLimit}.
   */
  readonly instantMigrationFailed: boolean;
  /**
   * True when the curve's assets reached the migrator **in this very
   * transaction** — the `Migrated` log is in this buy's own receipt.
   *
   * This is the question worth asking, and it is not the same as "is the curve
   * migrated now". A graduating buy whose migration ran out of gas still
   * graduates, still succeeds, and still leaves `migrate()` open to anyone —
   * so a curve can be migrated a minute later by a stranger and look identical
   * afterwards. Only this field distinguishes the instant path from the retry
   * path, and the difference is whether the token had a market the moment it
   * graduated.
   */
  readonly migratedInThisTransaction: boolean;
  /**
   * The canonical pool the migrator reported, when this buy migrated the curve.
   *
   * `undefined` when this buy did not migrate, and also when the migrator
   * created no market at all — an escrow migration reports the zero address.
   */
  readonly pool?: Address | undefined;
  /**
   * The approve sent first, for an ERC-20 quote whose allowance to the curve fell
   * short of the buy. `undefined` when none was needed.
   */
  readonly approvalTxHash?: Hash | undefined;
  /** The transaction. */
  readonly txHash: Hash;
  /** Its receipt. */
  readonly receipt: TransactionReceipt;
}

/** What a sell actually did. */
export interface SellResult {
  /**
   * Quote paid, in WAD — or credited to `pendingWithdrawal` if the payout
   * failed. An ERC-20 payout moves `floor(wad / scale)` raw units; any dust below
   * one raw unit stays in the curve.
   */
  readonly quoteOut: QuoteAmount;
  /** The trade fee taken. */
  readonly fee: QuoteAmount;
  /** The spot price after the trade. */
  readonly newPrice: QuoteAmount;
  /** The transaction. */
  readonly txHash: Hash;
  /** Its receipt. */
  readonly receipt: TransactionReceipt;
}

/** What `migrate()` forwarded. */
export interface MigrateResult {
  /** The quote forwarded to the migrator, in the curve's quote token. */
  readonly quote: QuoteAmount;
  /** Tokens forwarded: the curve's unsold inventory. */
  readonly tokens: Tokens;
  /** The canonical pool the migrator reported, or `undefined` for an escrow migration. */
  readonly pool?: Address | undefined;
  /** The transaction. */
  readonly txHash: Hash;
  /** Its receipt. */
  readonly receipt: TransactionReceipt;
}
