/**
 * Which contracts this SDK will price, decided by each contract's own
 * `VERSION()`.
 *
 * arcnow.io has one bonding curve: the constant-product curve under the
 * fee model with no developer share, `arcnow/bonding-curve@4.x.x`, with
 * parameters `{ r0Wad, y0Wad }` and a quote token. Every price, quote, trade
 * and template decode starts by asking the contract which version it is, and
 * anything but that one is refused by name:
 *
 * | `VERSION()` | outcome |
 * | --- | --- |
 * | `arcnow/bonding-curve@4.x.x` | priced and traded |
 * | `arcnow/bonding-curve@3.x.x` | `UnknownCurveVersion`, naming the retired multi-quote stack |
 * | another `arcnow/bonding-curve@…`, or malformed | `UnknownCurveVersion`, naming it |
 * | anything not `arcnow/bonding-curve@…` | `AddressIsNotACurve`, naming what it is |
 *
 * A curve of another version is **never** priced with this SDK's maths: its
 * parameters may mean something else in the same slots, and a plausible wrong
 * number is worse than an error.
 *
 * @module
 */

import { ArcNowError } from "./errors/error.js";

const SEMVER = /^arcnow\/([a-z0-9-]+)@(\d+)\.(\d+)\.(\d+)$/;
const COMPONENT = /^arcnow\/([a-z0-9-]+)@/;
const CURVE_PREFIX = "arcnow/bonding-curve@";

/** What an arcnow.io component that is not a curve is, in a sentence fragment. */
function whatItIs(component: string | undefined): string {
  switch (component) {
    case undefined:
      return "it does not name an arcnow.io component at all";
    case "arc-token":
      return "it is a token, not a curve: a token's curve is token.curve(), or trade the token "
        + "with client.trade(token), which finds its curve or pool for you";
    default:
      return `it is an arcnow.io ${component}`;
  }
}

/**
 * The refusal for an address that is not a bonding curve at all — as opposed
 * to a bonding curve of a version this SDK does not price.
 *
 * `version` is what the address answered to `VERSION()`, or `undefined` when it
 * answered nothing a contract with that getter would: no code, a revert, or no
 * data.
 */
export function notACurve(options: {
  readonly version?: string | undefined;
  readonly address?: string | undefined;
  readonly subject?: string | undefined;
  readonly cause?: unknown;
}): ArcNowError {
  const subject = options.subject ?? (options.address ? `the address ${options.address}` : "this address");
  if (options.version === undefined) {
    return new ArcNowError({
      code: "AddressIsNotACurve",
      message:
        `${subject} answers no VERSION(), so it is not a bonding curve: every arcnow.io curve `
        + "answers arcnow/bonding-curve@<version>. Either nothing is deployed there on this chain, "
        + "or the contract there is not one of arcnow.io's. Check the address and the network. "
        + "If it is a token, its curve is token.curve(), or use client.trade(token).",
      details: { address: options.address },
      cause: options.cause,
    });
  }
  const component = COMPONENT.exec(options.version)?.[1];
  return new ArcNowError({
    code: "AddressIsNotACurve",
    message:
      `${subject} answers VERSION() ${JSON.stringify(options.version)}, so it is not a bonding `
      + `curve: ${whatItIs(component)}. Nothing was priced or sent.`,
    details: { version: options.version, component, address: options.address },
    cause: options.cause,
  });
}

/** The major version this SDK speaks, per component. */
const MAJOR = {
  "bonding-curve": "4",
  "platform-config": "4",
  "platform-registry": "4",
  "arc-now-fee-hook": "4",
  "quote-registry": "1",
  "launchpad": "3",
  "uniswap-v4-migrator": "2",
} as const;

/**
 * The major of each component in the retired multi-quote (v3) stack, whose
 * contracts carried a developer fee share and whose fee hook charged the
 * curve's 1% in the pool. That stack is gone from arcnow.io's networks and its
 * data was wiped; a contract still answering with it is refused by name.
 */
const RETIRED_MULTI_QUOTE_MAJOR = {
  "bonding-curve": "3",
  "platform-config": "3",
  "platform-registry": "3",
  "arc-now-fee-hook": "3",
} as const;

type Component = keyof typeof MAJOR;

function assertMajor(
  version: string,
  component: Component,
  what: string,
  address: string | undefined,
  code: "UnknownCurveVersion" | "UnknownHookVersion" = "UnknownCurveVersion",
): void {
  const major = MAJOR[component];
  const match = SEMVER.exec(version);
  if (match?.[1] === component && match[2] === major) return;
  const sameComponent = match?.[1] === component;
  const retired = (RETIRED_MULTI_QUOTE_MAJOR as Record<string, string | undefined>)[component];
  const isRetiredMultiQuote = sameComponent && retired !== undefined && match[2] === retired;
  const predatesQuotes = sameComponent && !isRetiredMultiQuote && Number(match[2]) < Number(major);
  throw new ArcNowError({
    code,
    message:
      `${what} answers VERSION() ${JSON.stringify(version)}, which is not a version this SDK `
      + `prices. The one it speaks is arcnow/${component}@${major}.x.x, the fee-model stack: `
      + "curves priced in a quote token (native USDC or an allowlisted ERC-20), a fee split "
      + "between creator, referrer, platform and protocol, and a pool that charges its own "
      + "0.80% under the hook; any other version is refused rather than priced, because "
      + "another build can put another quantity in the same slots and a guess would produce a "
      + "plausible, wrong number. No local maths and no trade will be attempted. "
      + (isRetiredMultiQuote
        ? `This is the retired multi-quote stack (arcnow/${component}@${retired}.x.x), which `
        + "carried a developer share in its fee split and charged the curve's 1% in the pool. "
        + "It is gone from arcnow.io's networks and its data was wiped; nothing this SDK "
        + "speaks is deployed at that address any more. "
        : "")
      + (predatesQuotes
        ? "This build predates quote tokens: it is the version-2 stack, which this SDK no longer "
        + "speaks. "
        : "")
      + `Check that the address really is arcnow.io's current ${component}.`,
    details: { version, component, address },
  });
}

/**
 * Refuse a `BondingCurve` whose `VERSION()` this SDK does not price.
 *
 * Two different refusals, because they mean different things to a caller: a
 * string that is not `arcnow/bonding-curve@…` at all (a token's
 * `arcnow/arc-token@2.0.0`, a factory's, an empty string) is
 * `AddressIsNotACurve` and names what the address says it is; a bonding-curve
 * version other than `@4.x.x` — the retired multi-quote `@3.x.x`, the
 * version-2 `@2.x.x` and the linear `@1.x.x` included — or a malformed one is
 * `UnknownCurveVersion`.
 *
 * @param subject Names the contract in the refusal, e.g. "the curve at 0x…".
 * @param address The address, carried on `details.address` of a refusal.
 * @throws {ArcNowError} `AddressIsNotACurve` or `UnknownCurveVersion`, as above.
 */
export function assertCurveVersion(version: string, subject = "this curve", address?: string): void {
  if (!version.startsWith(CURVE_PREFIX)) {
    throw notACurve({ version, subject, address });
  }
  assertMajor(version, "bonding-curve", subject, address);
}

/**
 * Refuse a `PlatformConfig` that is not `arcnow/platform-config@4.x.x`, whose
 * templates are per quote, whose fourth field is `y0Wad`, and whose fee shares
 * are creator and referrer only (the platform's is the residual).
 *
 * @throws {ArcNowError} `UnknownCurveVersion`, with `details.component`.
 */
export function assertPlatformVersion(version: string, subject = "this platform", address?: string): void {
  assertMajor(version, "platform-config", subject, address);
}

/**
 * Refuse a `PlatformRegistry` that is not `arcnow/platform-registry@4.x.x`.
 *
 * @throws {ArcNowError} `UnknownCurveVersion`, with `details.component`.
 */
export function assertRegistryVersion(
  version: string,
  subject = "this platform registry",
  address?: string,
): void {
  assertMajor(version, "platform-registry", subject, address);
}

/**
 * Refuse a quote registry that is not `arcnow/quote-registry@1.x.x`.
 *
 * @throws {ArcNowError} `UnknownCurveVersion`, with `details.component`.
 */
export function assertQuoteRegistryVersion(
  version: string,
  subject = "this quote registry",
  address?: string,
): void {
  assertMajor(version, "quote-registry", subject, address);
}

/**
 * Refuse a launchpad that is not `arcnow/launchpad@3.x.x`.
 *
 * @throws {ArcNowError} `UnknownCurveVersion`, with `details.component`.
 */
export function assertLaunchpadVersion(version: string, subject = "this launchpad", address?: string): void {
  assertMajor(version, "launchpad", subject, address);
}

/**
 * Refuse a Uniswap v4 migrator that is not `arcnow/uniswap-v4-migrator@2.x.x`, the
 * migrator that seeds a pool in either currency order for the curve's quote.
 *
 * @throws {ArcNowError} `UnknownCurveVersion`, with `details.component`.
 */
export function assertV4MigratorVersion(
  version: string,
  subject = "this v4 migrator",
  address?: string,
): void {
  assertMajor(version, "uniswap-v4-migrator", subject, address);
}

/**
 * Refuse a v4 fee hook that is not `arcnow/arc-now-fee-hook@4.x.x`: the hook that
 * takes the pool's own 0.80% in the pool's quote currency, in raw units, splits
 * it creator / platform / protocol, accrues it and pays it out in a later
 * transaction.
 *
 * @throws {ArcNowError} `UnknownHookVersion`, with `details.component`.
 */
export function assertHookVersion(version: string, subject = "this fee hook", address?: string): void {
  assertMajor(version, "arc-now-fee-hook", subject, address, "UnknownHookVersion");
}
