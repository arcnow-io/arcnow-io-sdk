/**
 * The gas limit a launch is sent with, decided without a chain.
 *
 * # Why this file exists
 *
 * A launch whose *initial buy* reaches the graduation target graduates the curve
 * inside the launch transaction, and the curve attempts the migration there and
 * **catches its failure** — logging `InstantMigrationFailed` rather than
 * reverting. So the launch succeeds whether or not the migration runs, and
 * `eth_estimateGas`, which searches for the lowest limit at which the
 * transaction still succeeds, converges on exactly the limit that starves it.
 *
 * That happened on Arc testnet: an estimate of 6,250,146 against 5,452,572 used,
 * a token that graduated the moment it was created, no pool, and no error
 * anywhere. A bystander's permissionless `migrate()` rescued it ten blocks
 * later.
 *
 * The decision itself needs no chain, so it is tested without one. What it takes
 * a fork to prove — that 8,000,000 is actually enough — is in
 * `test/fork/journey.fork.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { Tokens, Usdc } from "../../src/amounts.js";
import { isArcNowError } from "../../src/errors/index.js";
import {
  GRADUATION_GAS_FLOOR,
  GRADUATION_GAS_LIMIT,
  resolveLaunchGas,
} from "../../src/launchpad.js";
import type { LaunchParams } from "../../src/types.js";

const base: LaunchParams = {
  name: "Example",
  symbol: "EXMPL",
  metadataUri: "ipfs://example",
  initialBuy: Usdc.parse("60"),
  minTokensOut: Tokens.ZERO,
};

describe("the gas limit a launch is sent with", () => {
  it("leaves an ordinary launch to the node's estimate", () => {
    // Where the estimate is correct it is also cheaper, and an SDK that pinned
    // 8,000,000 onto every launch would be asking every caller to reserve gas
    // for a migration that is not going to happen.
    expect(resolveLaunchGas(base, false)).toBeUndefined();
  });

  it("supplies a sufficient limit itself when the quote says the launch graduates", () => {
    // THE FIX. Not "documents that you should pass one": supplies it. The caller
    // has no way to know from anything in front of them that this launch is the
    // one where estimation is wrong, and the quote already knows.
    expect(resolveLaunchGas(base, true)).toBe(GRADUATION_GAS_LIMIT);
    // 6,000,000 for the migrator plus the curve's own 100,000 reserve, and two
    // deployments before either of those runs.
    expect(GRADUATION_GAS_LIMIT).toBeGreaterThan(GRADUATION_GAS_FLOOR);
    expect(GRADUATION_GAS_FLOOR).toBeGreaterThan(6_100_000n);
  });

  it("mirrors contracts' SdkGasLimits: FLOOR 6_200_000 and LIMIT 8_000_000", () => {
    // arcnow-io/contracts pins the same two numbers in its GraduationGasFloor tests
    // (SdkGasLimits.FLOOR and SdkGasLimits.LIMIT), and proves an instant migration
    // succeeds at the floor. Moving either here without moving it there, or the
    // other way round, is a drift this test and that one exist to catch.
    expect(GRADUATION_GAS_FLOOR).toBe(6_200_000n);
    expect(GRADUATION_GAS_LIMIT).toBe(8_000_000n);
  });

  it("honours an explicit limit, graduating or not", () => {
    expect(resolveLaunchGas({ ...base, gasLimit: 9_000_000n }, true)).toBe(9_000_000n);
    expect(resolveLaunchGas({ ...base, gasLimit: 500_000n }, false)).toBe(500_000n);
  });

  it("refuses an explicit limit too small for the migration the launch will attempt", () => {
    // Refused rather than sent, because it is not a limit that makes the launch
    // FAIL. It makes it succeed and quietly do half the job, and there is no
    // error afterwards to read.
    try {
      resolveLaunchGas({ ...base, gasLimit: GRADUATION_GAS_FLOOR - 1n }, true);
      expect.unreachable("a limit that starves the migration must not be sent");
    } catch (error) {
      if (!isArcNowError(error)) throw error;
      expect(error.code).toBe("InvalidArgument");
      expect(error.message).toMatch(/would still succeed/);
      expect(error.message).toContain(String(GRADUATION_GAS_FLOOR));
      expect(error.details).toMatchObject({ floor: GRADUATION_GAS_FLOOR });
    }
  });

  it("accepts exactly the floor, which is a floor and not a fence", () => {
    expect(resolveLaunchGas({ ...base, gasLimit: GRADUATION_GAS_FLOOR }, true))
      .toBe(GRADUATION_GAS_FLOOR);
  });

  it("does not second-guess a small limit on a launch that graduates nothing", () => {
    // The refusal is about one specific silent failure. A caller capping gas on
    // an ordinary launch is doing something ordinary.
    expect(resolveLaunchGas({ ...base, gasLimit: 100_000n }, false)).toBe(100_000n);
  });

  it("keeps a floor re-derived from the curve's own budget, clearing every measured graduation", () => {
    // Derived: what the curve forwards to its migrator, what it keeps back for
    // itself, and 100,000 of margin.
    const INSTANT_MIGRATION_GAS_LIMIT = 6_000_000n;
    const POST_MIGRATION_GAS_RESERVE = 100_000n;
    expect(GRADUATION_GAS_FLOOR)
      .toBe(INSTANT_MIGRATION_GAS_LIMIT + POST_MIGRATION_GAS_RESERVE + 100_000n);

    // Measured on an Arc fork (arcnow-io/contracts README):
    // the smallest limits at which the migration still happens instantly.
    const cpmmLaunchMigratesAbove = 5_880_000n;
    const cpmmBuyMigratesAbove = 845_500n;

    // The floor clears the heaviest measured threshold by at least 5%...
    expect(GRADUATION_GAS_FLOOR * 100n).toBeGreaterThanOrEqual(cpmmLaunchMigratesAbove * 105n);
    expect(GRADUATION_GAS_FLOOR).toBeGreaterThan(cpmmBuyMigratesAbove);
    // ...and the limit sent by default clears all of them with room.
    expect(GRADUATION_GAS_LIMIT * 100n).toBeGreaterThanOrEqual(cpmmLaunchMigratesAbove * 135n);
  });
});
