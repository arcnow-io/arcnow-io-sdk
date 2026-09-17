/**
 * The type-level half of the 18/6 wall.
 *
 * **This file is checked by `tsc --noEmit`, not by Vitest.** Every
 * `@ts-expect-error` below is an assertion: if the compiler ever stops
 * rejecting the line under it, the *type check itself* fails with "unused
 * '@ts-expect-error' directive". That is the only way to prove a compiler
 * rejection, and a runtime test cannot do it — the whole point of a branded
 * type is that the mistake never gets as far as running.
 *
 * The property under test is nominal typing. `Usdc`, `Tokens` and `Bps` have
 * identical shapes (`{ wad: bigint }`, near enough), and TypeScript is
 * structural: without the `declare private` brand on each class they would be
 * freely interchangeable, and so would a bare `bigint` if the API took one.
 */

import { Bps, Tokens, Usdc, UsdcErc20 } from "../../src/amounts.js";
import { Deadline } from "../../src/deadline.js";
import type { BuyRequest, LaunchParams, SellRequest } from "../../src/types.js";

declare function takesUsdc(value: Usdc): void;
declare function takesTokens(value: Tokens): void;

/* -------------------------------------------------------------------------- *
 * A bare bigint is not money.
 * -------------------------------------------------------------------------- */

// @ts-expect-error a raw bigint carries no scale and must not be assignable to Usdc
takesUsdc(1_000_000_000_000_000_000n);

// @ts-expect-error nor to Tokens
takesTokens(1_000_000_000_000_000_000n);

// @ts-expect-error and a number is even further from it
takesUsdc(1);

/* -------------------------------------------------------------------------- *
 * The three amount types do not substitute for one another.
 * -------------------------------------------------------------------------- */

// @ts-expect-error a token quantity is not a USDC quantity, however identical the shape
takesUsdc(Tokens.fromWhole(1n));

// @ts-expect-error and a USDC quantity is not a token quantity
takesTokens(Usdc.fromWhole(1n));

// @ts-expect-error the 6-decimal view never reaches a call path; it must be converted
takesUsdc(UsdcErc20.fromWhole(1n));

// @ts-expect-error basis points are not an amount
takesUsdc(Bps.of(100n));

// The conversion that IS allowed, and only because it is spelled out:
takesUsdc(Usdc.fromErc20(UsdcErc20.fromWhole(1n)));

/* -------------------------------------------------------------------------- *
 * The same wall, on the real request shapes.
 * -------------------------------------------------------------------------- */

const goodBuy: BuyRequest = {
  quoteIn: Usdc.parse("10"),
  minTokensOut: Tokens.parse("1000"),
  deadline: Deadline.inMinutes(5),
};
void goodBuy;

const swappedBuy: BuyRequest = {
  // @ts-expect-error quoteIn is money; a token quantity here is the classic 18/18 mixup
  quoteIn: Tokens.parse("10"),
  minTokensOut: Tokens.parse("1000"),
  deadline: Deadline.inMinutes(5),
};
void swappedBuy;

const swappedSell: SellRequest = {
  tokensIn: Tokens.parse("1000"),
  // @ts-expect-error minQuoteOut is money, not a token count
  minQuoteOut: Tokens.parse("1"),
  deadline: Deadline.inMinutes(5),
};
void swappedSell;

const rawDeadline: BuyRequest = {
  quoteIn: Usdc.parse("10"),
  minTokensOut: Tokens.parse("1000"),
  // @ts-expect-error a raw timestamp is not a Deadline; Date.now() is milliseconds
  deadline: Date.now(),
};
void rawDeadline;

/* -------------------------------------------------------------------------- *
 * Launch params take the right currency in each slot.
 * -------------------------------------------------------------------------- */

const goodLaunch: LaunchParams = {
  name: "Example",
  symbol: "EXAM",
  metadataUri: "ipfs://…",
  initialBuy: Usdc.parse("5"),
  minTokensOut: Tokens.ZERO,
};
void goodLaunch;

const badLaunch: LaunchParams = {
  name: "Example",
  symbol: "EXAM",
  metadataUri: "ipfs://…",
  // @ts-expect-error the initial buy is spent in USDC, not measured in tokens
  initialBuy: Tokens.parse("5"),
  minTokensOut: Tokens.ZERO,
};
void badLaunch;

/* -------------------------------------------------------------------------- *
 * NewPlatform has no platform-share field, and that is load-bearing.
 * -------------------------------------------------------------------------- */

import type { CurveTemplate } from "../../src/curve-template.js";
import type { NewPlatform } from "../../src/fees.js";

declare const someAddress: `0x${string}`;
declare const someCurve: CurveTemplate;

const platform: NewPlatform = {
  admin: someAddress,
  feeRecipient: someAddress,
  creatorShareBps: Bps.of(3000n),
  refShareBps: Bps.of(1000n),
  defaultMigrator: someAddress,
  curve: someCurve,
  // @ts-expect-error the platform's own cut is the RESIDUAL and is never an input
  platformShareBps: Bps.of(3500n),
};
void platform;

const platformWithDeveloper: NewPlatform = {
  admin: someAddress,
  feeRecipient: someAddress,
  creatorShareBps: Bps.of(3000n),
  refShareBps: Bps.of(1000n),
  defaultMigrator: someAddress,
  curve: someCurve,
  // @ts-expect-error there is no developer share: the fee has four parties
  devShareBps: Bps.of(1000n),
};
void platformWithDeveloper;
