/**
 * Deadlines, as something you name rather than a timestamp you compute at the
 * call site.
 *
 * Every trade on a curve takes one. It is the caller's protection against a
 * transaction being held back and executed at a much later price — the curve
 * checks it against the block timestamp and reverts with `DeadlineExpired`
 * rather than filling an order somebody agreed to an hour ago.
 *
 * @module
 */

/**
 * A unix-seconds deadline for a trade.
 *
 * Built through the three named constructors so that a raw `Date.now()`, which
 * is milliseconds, can never be mistaken for one. That mistake produces a
 * deadline roughly 50,000 years in the future — which is to say, no deadline at
 * all, silently.
 */
export class Deadline {
  /** Unix seconds, as the contracts want it. */
  readonly unixSeconds: bigint;

  private constructor(unixSeconds: bigint) {
    this.unixSeconds = unixSeconds;
  }

  /**
   * `minutes` from now. **Five is the sensible default** and what the examples
   * use: long enough to survive a busy block or two, short enough that a
   * transaction stuck in the mempool expires instead of filling at a price the
   * caller would no longer accept.
   *
   * Measured against the caller's clock, checked against the chain's. A machine
   * whose clock is minutes off will produce deadlines that are minutes off.
   */
  static inMinutes(minutes: number): Deadline {
    return Deadline.inSeconds(Math.round(minutes * 60));
  }

  /** `seconds` from now. */
  static inSeconds(seconds: number): Deadline {
    return new Deadline(BigInt(Math.floor(Date.now() / 1000) + Math.round(seconds)));
  }

  /** An absolute unix-seconds instant. */
  static at(unixSeconds: bigint | number): Deadline {
    return new Deadline(BigInt(unixSeconds));
  }

  /**
   * No deadline: `type(uint256).max`.
   *
   * **Understand what you are opting out of.** A transaction with no deadline
   * can sit in the mempool and be included much later, at a price the curve has
   * moved a long way to. On a bonding curve that price moves in one direction
   * with every buy. Use this for a call where time cannot hurt you — reading, a
   * migrate retry — and not for a trade you care about the price of.
   */
  static none(): Deadline {
    return new Deadline(2n ** 256n - 1n);
  }

  /** True for {@link Deadline.none}. */
  get isNone(): boolean {
    return this.unixSeconds === 2n ** 256n - 1n;
  }

  /** As a `Date`, for display. `undefined` for {@link Deadline.none}. */
  toDate(): Date | undefined {
    return this.isNone ? undefined : new Date(Number(this.unixSeconds) * 1000);
  }

  toString(): string {
    return this.isNone ? "no deadline" : `${this.toDate()?.toISOString()}`;
  }
}
