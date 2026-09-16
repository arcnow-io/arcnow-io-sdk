/**
 * The five-way split of the 1% trade fee, and the one field that is deliberately
 * missing from it.
 *
 * **Every share here is basis points *of the fee*, never of the trade.** The
 * trade fee is a flat 1% and is not a platform's to change; what a platform
 * configures is how that 1% is divided. A creator share of 3000 bps is 30% of
 * the fee and 0.30% of the trade. This is the single easiest mistake in the
 * design, which is why the conversion lives on {@link Bps} and is spelled out
 * on every field below.
 *
 * @module
 */

import type { Address } from "viem";

import { Bps } from "./amounts.js";
import type { QuoteAmount } from "./amounts.js";
import type { CurveTemplate } from "./curve-template.js";
import { ArcNowError } from "./errors/error.js";

/**
 * The most of the fee a platform may allocate across creator, ref and dev:
 * 7500 bps. `ArcConstants.MAX_PLATFORM_ALLOWANCE_BPS`.
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

/** The shipped trade fee: 100 bps, 1%, charged on both sides of every trade. */
export const TRADE_FEE_BPS = 100n;

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
   * contracts: it is `10000 - protocol - creator - ref - dev`, computed on
   * demand and written into the snapshot so a reader does not have to
   * recompute it. It is also where every unaddressed share and all the
   * rounding dust ends up.
   */
  readonly platformShareBps: Bps;
  /** Referrer's share, bps of the fee. Goes to the platform when a swap names no referrer. */
  readonly refShareBps: Bps;
  /** Integrating developer's share, bps of the fee. Same zero rule as ref. */
  readonly devShareBps: Bps;
  /** The ArcNow protocol's share, bps of the fee. Protocol-controlled; no platform sets it. */
  readonly protocolShareBps: Bps;
  /** Where the platform's own share is sent. Fixed at creation, never zero. */
  readonly platformRecipient: Address;
  /** Where the protocol share is sent. Fixed at creation, never zero. */
  readonly protocolRecipient: Address;
}

/**
 * One fee, resolved into the five amounts and the five addresses that will
 * actually receive them.
 *
 * The four proportional shares are floored and the platform's is the
 * **residual**, so the five total the fee exactly at every size — including a
 * fee of one wei, where four shares are zero and the platform takes it all. The
 * rounding dust is at most four wei and it goes to the platform, which is the
 * same address every unaddressed share goes to.
 */
export interface FeeSplit {
  /** The creator's recipient, or the platform's if unset. */
  readonly creator: Address;
  /** The platform's recipient. */
  readonly platform: Address;
  /** The referrer, or the platform's recipient when the swap named none. */
  readonly ref: Address;
  /** The developer, or the platform's recipient when the swap named none. */
  readonly dev: Address;
  /** The protocol's recipient. */
  readonly protocol: Address;
  /** The creator's amount. */
  readonly creatorAmount: QuoteAmount;
  /** The platform's amount, including the rounding dust. */
  readonly platformAmount: QuoteAmount;
  /** The referrer's amount. */
  readonly refAmount: QuoteAmount;
  /** The developer's amount. */
  readonly devAmount: QuoteAmount;
  /** The protocol's amount. */
  readonly protocolAmount: QuoteAmount;
}

/** The sum of the five amounts, which is the fee, exactly. */
export function totalOf(split: FeeSplit): QuoteAmount {
  return split.creatorAmount
    .add(split.platformAmount)
    .add(split.refAmount)
    .add(split.devAmount)
    .add(split.protocolAmount);
}

/**
 * What a caller passes to register a new platform.
 *
 * **There is no platform-share field, and this is the point.** The platform's
 * own cut is the residual: `10000 - protocol - creator - ref - dev`. A platform
 * allocates at most {@link MAX_PLATFORM_ALLOWANCE_BPS} across creator, ref and
 * dev, and whatever it does not allocate is its own. Offering a field for it
 * would invite a caller to set five numbers that have to total 10,000 and to
 * discover on-chain that they do not.
 *
 * Two things fall out of that, both deliberate:
 *
 * 1. Zeroing ref and dev moves those bps to the platform — the *same* rule that
 *    applies at swap time when a ref or dev **address** is the zero address.
 *    One rule, stated once.
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
  /** Integrating developer's share, bps of the fee. Zero moves it to the platform. */
  readonly devShareBps: Bps;
  /** The migrator this platform's tokens graduate to by default. Must be registered. */
  readonly defaultMigrator: Address;
  /** The bonding-curve template new launches get. {@link CurveTemplate.arcnowDefaults}. */
  readonly curve: CurveTemplate;
}

/**
 * The platform's own cut, given the three shares it allocates — a pure
 * function, so a caller can see what they are choosing without deploying
 * anything.
 *
 * Computed against the **maximum** protocol share, which is what the contracts
 * validate against and therefore the residual a platform can count on. If the
 * protocol admin has currently set a lower share, the real residual is wider
 * than this by the difference, and no stored configuration ever becomes
 * invalid.
 *
 * @throws {ArcNowError} `FeeSharesExceedAllowance` when the three total more
 * than 7500 bps, with a message that states the residual being chosen.
 */
export function platformShareBps(creator: Bps, ref: Bps, dev: Bps): Bps {
  const allocated = creator.bps + ref.bps + dev.bps;
  if (allocated > MAX_PLATFORM_ALLOWANCE_BPS) {
    throw new ArcNowError({
      code: "FeeSharesExceedAllowance",
      message:
        `creator ${creator.bps} + ref ${ref.bps} + dev ${dev.bps} = ${allocated} bps, and a `
        + `platform may allocate at most ${MAX_PLATFORM_ALLOWANCE_BPS}. You are asking for a `
        + `residual of ${MAX_PLATFORM_ALLOWANCE_BPS - allocated} bps, which is not a share, `
        + "it is a deficit. The platform's own cut is whatever it does not allocate — bring "
        + `the three down by ${allocated - MAX_PLATFORM_ALLOWANCE_BPS} bps and the remainder `
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
    platformShare: platformShareBps(
      platform.creatorShareBps,
      platform.refShareBps,
      platform.devShareBps,
    ),
  };
}
