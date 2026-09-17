/**
 * The four-way split of the 1% trade fee, the one field that is deliberately
 * missing from it, and the pool's own rate and split.
 *
 * **Every share here is basis points *of the fee*, never of the trade.** The
 * trade fee is a flat 1% and is not a platform's to change; what a platform
 * configures is how that 1% is divided. A creator share of 3000 bps is 30% of
 * the fee and 0.30% of the trade. This is the single easiest mistake in the
 * design, which is why the conversion lives on {@link Bps} and is spelled out
 * on every field below.
 *
 * **Four parties, not five.** The fee goes to the token's creator, the
 * referrer a swap named, the platform the token launched under, and the
 * protocol. There is no developer share: the earlier stack carried one that
 * nothing ever used, and its 1000 bps fell to the platform, which is what the
 * residual is. arcnow.io's own split is creator 3000 / ref 1000 / platform 3500
 * / protocol 2500.
 *
 * **A pool is not a curve.** After graduation the trade happens in a Uniswap
 * v4 pool whose hook takes {@link POOL_TRADE_FEE_BPS} — 0.80% — beside the
 * pool's own 0.20% LP fee, so a migrated trade costs the curve's 1.00% in all;
 * and the hook splits its 0.80% on a split of its own, with no referrer:
 * creator 5000 / platform 1875 / protocol 3125.
 *
 * @module
 */

import type { Address } from "viem";

import { Bps } from "./amounts.js";
import type { QuoteAmount } from "./amounts.js";
import type { CurveTemplate } from "./curve-template.js";
import { ArcNowError } from "./errors/error.js";

/**
 * The most of the fee a platform may allocate across creator and ref: 7500 bps.
 * `ArcConstants.MAX_PLATFORM_ALLOWANCE_BPS`.
 *
 * It is `10000 - MAX_PROTOCOL_SHARE_BPS`, measured against the **maximum**
 * protocol share the protocol admin is permitted to set and never against the
 * current one. That is what makes a stored platform configuration permanently
 * valid: a protocol admin lowering their cut widens every platform's residual
 * automatically and cannot invalidate anybody's settings or stop them
 * launching.
 */
export const MAX_PLATFORM_ALLOWANCE_BPS = 7_500n;

/** The bps denominator. 10,000 bps is the whole fee. */
export const BPS_DENOMINATOR = 10_000n;

/** The shipped trade fee on a curve: 100 bps, 1%, charged on both sides of every trade. */
export const TRADE_FEE_BPS = 100n;

/**
 * What the fee hook takes on a migrated pool: 80 bps, 0.80% of the gross quote
 * leg of every swap. `ArcConstants.POOL_TRADE_FEE_BPS`; the hook answers it
 * from `feeBps()`.
 *
 * **Not {@link TRADE_FEE_BPS}, and the difference is the LP fee.** The pool
 * charges its own {@link POOL_LP_FEE_PIPS} on top of what the hook takes, so a
 * hook that kept charging 1% would make a migrated token cost 1.30% where the
 * curve cost 1.00%. At 0.80% the trader pays the same 1.00% on both sides of
 * graduation ({@link POOL_TOTAL_FEE_BPS}). The LP fee is not revenue: the
 * migrator burns its own position, so it accrues to liquidity nobody can
 * collect.
 */
export const POOL_TRADE_FEE_BPS = 80n;

/**
 * The LP fee of every pool arcnow.io's migrator opens, in Uniswap's unit —
 * hundredths of a bip (pips): 2000 is 0.20%. Baked into each pool's key by the
 * migrator; read it off `Pool.key().fee`, this is what it will say.
 */
export const POOL_LP_FEE_PIPS = 2000;

/** The tick spacing of every pool arcnow.io's migrator opens. */
export const POOL_TICK_SPACING = 60;

/**
 * What a migrated trade costs in all, bps of the trade: the hook's 0.80% plus
 * the pool's 0.20% LP fee. Equal to {@link TRADE_FEE_BPS}, by design.
 */
export const POOL_TOTAL_FEE_BPS = POOL_TRADE_FEE_BPS + BigInt(POOL_LP_FEE_PIPS) / 100n;

/**
 * The creator's share of a pool's fee: 5000 bps of the hook's 0.80% = 0.40% of
 * a trade. Higher than the curve default's 0.30%, on purpose.
 */
export const POOL_CREATOR_SHARE_BPS = 5_000n;

/**
 * The platform's share of a pool's fee: 1875 bps = 0.15% of a trade. Stated,
 * not a residual: a pool has no referrer whose unaddressed share would fall to
 * the platform.
 */
export const POOL_PLATFORM_SHARE_BPS = 1_875n;

/**
 * The protocol's share of a pool's fee: 3125 bps of 0.80% = 0.25% of a trade,
 * exactly what it was on the curve (2500 bps of 1.00%). Larger than the 2500
 * cap on a *platform's* protocol share because it is a share of a smaller fee.
 */
export const POOL_PROTOCOL_SHARE_BPS = 3_125n;

/**
 * Which party a `FeePaid` or `FeeDeferred` log is about, as its indexed `share`
 * topic encodes it: `IFeeConfig.FeeShare`.
 *
 * **Protocol is 3.** The earlier stack had a `Dev` at 3 and `Protocol` at 4; a
 * decoder written against it reads every protocol payout of this stack as a
 * developer's. Decode with {@link FeeShare.nameOf}, which refuses 4.
 */
export const FeeShare = {
  /** The token's creator, `token.creator()` at swap time. */
  Creator: 0,
  /** The platform the token launched under, at its `feeRecipient`. */
  Platform: 1,
  /** The referrer the swap named. A pool names none. */
  Ref: 2,
  /** The ArcNow protocol, at the registry's recipient. */
  Protocol: 3,
  /** The name of a share from its topic value, or `undefined` for anything else. */
  nameOf(share: number | bigint): FeeShareName | undefined {
    const value = Number(share);
    return (["Creator", "Platform", "Ref", "Protocol"] as const)[value];
  },
} as const;

/** The four parties a fee is split between. */
export type FeeShareName = "Creator" | "Platform" | "Ref" | "Protocol";

/**
 * A complete, validated fee split, as a curve and its token snapshot it at
 * creation.
 *
 * **Snapshotted and immutable.** A platform admin or protocol admin changing
 * anything afterwards reaches only launches that come later. There is no switch
 * anywhere that alters the economics of a token somebody already bought into,
 * which is why this design needs no timelock — and why a UI can cache this per
 * curve forever.
 */
export interface FeeConfig {
  /** Creator's share, bps of the fee. Paid to `token.creator()`, read at swap time. */
  readonly creatorShareBps: Bps;
  /**
   * The platform's own share, bps of the fee.
   *
   * **A residual, materialised.** It is never an input anywhere in the
   * contracts: it is `10000 - protocol - creator - ref`, computed on demand
   * and written into the snapshot so a reader does not have to recompute it.
   * It is also where every unaddressed share and all the rounding dust ends
   * up. (In a pool's config, read off the hook, it is stated instead: a pool
   * has no referrer.)
   */
  readonly platformShareBps: Bps;
  /**
   * Referrer's share, bps of the fee. Goes to the platform when a swap names
   * no referrer. Always zero in a pool's config: referrals are a curve feature.
   */
  readonly refShareBps: Bps;
  /** The ArcNow protocol's share, bps of the fee. Protocol-controlled; no platform sets it. */
  readonly protocolShareBps: Bps;
  /** Where the platform's own share is sent. Fixed at creation, never zero. */
  readonly platformRecipient: Address;
  /** Where the protocol share is sent. Fixed at creation, never zero. */
  readonly protocolRecipient: Address;
}

/**
 * One fee, resolved into the four amounts and the four addresses that will
 * actually receive them.
 *
 * The three proportional shares are floored and the platform's is the
 * **residual**, so the four total the fee exactly at every size — including a
 * fee of one wei, where three shares are zero and the platform takes it all.
 * The rounding dust is at most three wei and it goes to the platform, which is
 * the same address every unaddressed share goes to. A share of zero is not
 * paid and writes no `FeePaid` log.
 */
export interface FeeSplit {
  /** The creator's recipient, or the platform's if unset. */
  readonly creator: Address;
  /** The platform's recipient. */
  readonly platform: Address;
  /** The referrer, or the platform's recipient when the swap named none. */
  readonly ref: Address;
  /** The protocol's recipient. */
  readonly protocol: Address;
  /** The creator's amount. */
  readonly creatorAmount: QuoteAmount;
  /** The platform's amount, including the rounding dust. */
  readonly platformAmount: QuoteAmount;
  /** The referrer's amount. */
  readonly refAmount: QuoteAmount;
  /** The protocol's amount. */
  readonly protocolAmount: QuoteAmount;
}

/** The sum of the four amounts, which is the fee, exactly. */
export function totalOf(split: FeeSplit): QuoteAmount {
  return split.creatorAmount
    .add(split.platformAmount)
    .add(split.refAmount)
    .add(split.protocolAmount);
}

/**
 * What a caller passes to register a new platform.
 *
 * **There is no platform-share field, and this is the point.** The platform's
 * own cut is the residual: `10000 - protocol - creator - ref`. A platform
 * allocates at most {@link MAX_PLATFORM_ALLOWANCE_BPS} across creator and ref,
 * and whatever it does not allocate is its own. Offering a field for it would
 * invite a caller to set four numbers that have to total 10,000 and to
 * discover on-chain that they do not. There is no developer-share field
 * either: the fee has four parties.
 *
 * Two things fall out of that, both deliberate:
 *
 * 1. Zeroing ref moves those bps to the platform — the *same* rule that
 *    applies at swap time when the ref **address** is the zero address. One
 *    rule, stated once.
 * 2. Because the allowance is measured against the maximum protocol share, a
 *    protocol admin lowering their cut widens your residual and can never
 *    invalidate what you stored.
 *
 * **Registering a platform is callable only by the registry's `protocolAdmin`.**
 * An ordinary caller gets `NotProtocolAdmin`. That is the single most likely
 * surprise in this API: the registry *deploys* every `PlatformConfig` itself so
 * that `isPlatform` certifies code rather than a claim, and it will not deploy
 * one on behalf of an arbitrary caller.
 */
export interface NewPlatform {
  /** The platform's first admin. Two-step handover afterwards. */
  readonly admin: Address;
  /** Where the platform's own share of every fee is sent. Must not be zero. */
  readonly feeRecipient: Address;
  /** Creator's share, bps **of the fee**. 3000 is arcnow.io's own, = 0.30% of a trade. */
  readonly creatorShareBps: Bps;
  /** Referrer's share, bps of the fee. Zero moves it to the platform. */
  readonly refShareBps: Bps;
  /** The migrator this platform's tokens graduate to by default. Must be registered. */
  readonly defaultMigrator: Address;
  /** The bonding-curve template new launches get. {@link CurveTemplate.arcnowDefaults}. */
  readonly curve: CurveTemplate;
}

/**
 * The platform's own cut, given the two shares it allocates — a pure function,
 * so a caller can see what they are choosing without deploying anything.
 *
 * Computed against the **maximum** protocol share, which is what the contracts
 * validate against and therefore the residual a platform can count on. If the
 * protocol admin has currently set a lower share, the real residual is wider
 * than this by the difference, and no stored configuration ever becomes
 * invalid.
 *
 * @throws {ArcNowError} `FeeSharesExceedAllowance` when the two total more
 * than 7500 bps, with a message that states the residual being chosen.
 */
export function platformShareBps(creator: Bps, ref: Bps): Bps {
  const allocated = creator.bps + ref.bps;
  if (allocated > MAX_PLATFORM_ALLOWANCE_BPS) {
    throw new ArcNowError({
      code: "FeeSharesExceedAllowance",
      message:
        `creator ${creator.bps} + ref ${ref.bps} = ${allocated} bps, and a `
        + `platform may allocate at most ${MAX_PLATFORM_ALLOWANCE_BPS}. You are asking for a `
        + `residual of ${MAX_PLATFORM_ALLOWANCE_BPS - allocated} bps, which is not a share, `
        + "it is a deficit. The platform's own cut is whatever it does not allocate — bring "
        + `the two down by ${allocated - MAX_PLATFORM_ALLOWANCE_BPS} bps and the remainder `
        + "is yours. Remember these are bps of the **fee**: 7500 of the fee is 0.75% of a "
        + "trade, not 75% of one.",
      details: {
        requestedBps: Number(allocated),
        allowanceBps: Number(MAX_PLATFORM_ALLOWANCE_BPS),
      },
    });
  }
  return Bps.of(MAX_PLATFORM_ALLOWANCE_BPS - allocated);
}

/**
 * Validate a {@link NewPlatform} client-side, before a transaction is built.
 *
 * The contracts check the same thing; doing it here means a caller who got the
 * split wrong finds out at the call site with the residual named, rather than
 * paying gas to be told `FeeSharesExceedAllowance` with two bare numbers.
 */
export function validateNewPlatform(platform: NewPlatform): { platformShare: Bps } {
  const zero = /^0x0{40}$/i;
  for (const [field, value] of [
    ["admin", platform.admin],
    ["feeRecipient", platform.feeRecipient],
    ["defaultMigrator", platform.defaultMigrator],
  ] as const) {
    if (zero.test(value)) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          `${field} is the zero address. On Arc that is a real account, so the contracts `
          + "refuse it rather than reading it as 'unset' — a platform whose fee recipient "
          + "was zero would send its whole cut nowhere, on every trade, forever.",
        details: { field },
      });
    }
  }
  return {
    platformShare: platformShareBps(platform.creatorShareBps, platform.refShareBps),
  };
}
