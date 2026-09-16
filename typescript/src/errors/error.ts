/**
 * One error type for the whole SDK.
 *
 * **Why one.** A caller integrating a launchpad has to handle a revert from six
 * different contracts, a network preset with nothing on it, a write attempted
 * without a signer and a slippage floor they set too tight. Those are four
 * error classes in most SDKs and four `instanceof` checks at every call site.
 * Here they are one class with a `code`, so a caller writes one `catch`, and
 * switches on `code` only where they actually behave differently.
 *
 * **Every message says what to do, not what happened.** `"SlippageExceeded"` is
 * what happened; "re-quote and retry, the curve's price rises across your own
 * order" is what to do. The decoded parameters are kept on `args` so a UI can
 * render the numbers itself rather than scraping the sentence.
 *
 * @module
 */

/** Codes this SDK raises itself, before or instead of a chain round trip. */
export type SdkErrorCode
  /** A network name that is not a preset and not a `{ rpcUrl, chainId, contracts }`. */
  = | "UnknownNetwork"
  /** A preset that exists and has nothing deployed on it. Arc mainnet, today. */
    | "NetworkNotDeployed"
  /** One contract the call needed is absent on this chain. */
    | "ContractNotDeployed"
  /** A write was attempted on a client built without a signer. Raised before any RPC. */
    | "ReadOnlyClient"
  /** The endpoint reports a different chain id than the config claims. */
    | "ChainIdMismatch"
  /** An argument this SDK could reject without asking the chain. */
    | "InvalidArgument"
  /**
   * No Uniswap v4 router is configured for this network, so no graduated token
   * can be quoted or traded on it.
   *
   * `contracts.v4Router` is absent — `null` in `networks.json` — because the
   * router arcnow.io deploys (arcnow-io/contracts `script/DeployV4Router.s.sol`)
   * has not been broadcast there yet. Raised before any RPC: a call built
   * against an address with no code at it would "succeed" as an empty return,
   * and reads as a broken pool rather than as a missing router.
   *
   * A property of the network, not of the token. Every graduated token on it is
   * refused the same way, bonding-curve trading is unaffected, and it clears the
   * moment a router address is configured.
   */
    | "NoRouterDeployed"
  /**
   * The token's v4 pool is in a different PoolManager from the one the
   * configured router serves.
   *
   * A v4 pool is a `PoolId` inside one PoolManager's storage, and the router
   * holds its manager `immutable`, so a router bound to one manager cannot see a
   * pool in another: that call would revert `PoolNotInitialized()` —
   * `0x486aa307` — which reads like a malformed key rather than like the truth.
   * Refused before the swap is encoded instead.
   *
   * With the planned deployment this should not arise for an arcnow.io token:
   * the router is bound to the same PoolManager every arcnow.io migrator opens
   * pools in. Seeing it means the network's `v4Router` points at a router bound
   * somewhere else, or the token graduated through a migrator bound to another
   * manager.
   */
    | "PoolUnreachable"
  /**
   * The token has not migrated, so it has no pool to quote or trade in.
   *
   * Its market is still its bonding curve. Use `client.curve(...)`, or
   * `client.trade(...)`, which dispatches on the venue for you.
   */
    | "PoolNotMigrated"
  /**
   * A curve, platform or registry answered a `VERSION()` this SDK does not
   * price: anything but `arcnow/bonding-curve@2.x.x` (the constant-product
   * curve), `arcnow/platform-config@2.x.x` or `arcnow/platform-registry@2.x.x` —
   * the retired `@1.x.x` linear curve included. Raised before any local maths and
   * before any trade is simulated, naming the version in `details.version` and
   * the contract in `details.component`.
   */
    | "UnknownCurveVersion"
  /**
   * The address is not a bonding curve at all: it answered a `VERSION()` that is
   * not `arcnow/bonding-curve@…` (a token's `arcnow/arc-token@1.0.0`, a
   * factory's), or answered no `VERSION()` — no code, a revert, no data.
   * `details.version` and `details.component` say what it claimed to be,
   * `details.address` where it is. Distinct from `UnknownCurveVersion`, which is
   * a bonding curve of a version this SDK does not know.
   *
   * Raised by the SDK before any trade call. **Not** the migrators' contract
   * error `NotACurve(address caller)`, which still arrives under its own name
   * when a migrator refuses a caller that is not one of its factory's curves.
   */
    | "AddressIsNotACurve"
  /**
   * A pool's fee hook answered a `VERSION()` that is not
   * `arcnow/arc-now-fee-hook@2.x.x` — the hook that accrues fees as PoolManager
   * claims and pays them out later — so how it books fees is unknown.
   * `details.hook` and `details.version`.
   */
    | "UnknownHookVersion"
  /**
   * Two amounts in different quote tokens were combined or compared, or a
   * request's amount is in a quote other than the curve's, pool's or launch's.
   * Raised before anything is read or sent.
   */
    | "QuoteTokenMismatch"
  /**
   * An amount of an ERC-20 quote carries dust below one raw unit, so it cannot
   * be moved. Raised before sending; the contracts revert with the same name.
   */
    | "QuoteAmountNotRepresentable"
  /**
   * Uniswap v4's `WrappedError(address,bytes4,bytes,bytes)` around a revert this
   * SDK could not decode: a hook or pool call failed with empty or unknown data.
   * `details` carries `target`, `selector`, `reason` and `details`. A wrapped
   * revert that CAN be decoded is reported as the inner error instead.
   */
    | "WrappedRevert"
  /** A revert whose selector is in no ABI this SDK carries. */
    | "UnknownRevert"
  /** A plain `require("...")` / `revert("...")`. */
    | "RevertString"
  /** A `Panic(uint256)` — a compiler-inserted check, not a contract's own rule. */
    | "Panic"
  /** A revert with no data at all. */
    | "EmptyRevert"
  /**
   * An ERC-20-quoted trade or launch reverted with no data: contracts#23's gas
   * guard on fee-share transfers (`QuoteTransfer.tryPushBounded`) found too little
   * gas left. `details` carries `quoteToken` and, when one was set, `gasLimit`.
   */
    | "QuoteTransferOutOfGas"
  /** The transport failed: no answer, a bad answer, a rejected transaction. */
    | "RpcFailure";

/**
 * Every {@link SdkErrorCode}, at runtime, so a caller can tell an SDK-side
 * refusal from a decoded contract revert without keeping a list of their own.
 *
 * **No SDK-side code may share a name with a custom error in a pinned ABI**
 * (`abi/` and the external router ABI in `abi/external/`), because
 * `ArcNowError.code` is also the name of whatever contract error was decoded: a
 * shared name would make "the SDK refused before any call" and "the chain
 * reverted with that error" the same `case`. `test/unit/error-code-collisions.test.ts`
 * fails on any such collision, except the codes listed in
 * {@link SDK_CODES_THAT_ARE_CONTRACT_ERRORS}.
 */
export const SDK_ERROR_CODES = [
  "UnknownNetwork",
  "NetworkNotDeployed",
  "ContractNotDeployed",
  "ReadOnlyClient",
  "ChainIdMismatch",
  "InvalidArgument",
  "NoRouterDeployed",
  "PoolUnreachable",
  "PoolNotMigrated",
  "UnknownCurveVersion",
  "AddressIsNotACurve",
  "UnknownHookVersion",
  "QuoteTokenMismatch",
  "QuoteAmountNotRepresentable",
  "WrappedRevert",
  "UnknownRevert",
  "RevertString",
  "Panic",
  "EmptyRevert",
  "QuoteTransferOutOfGas",
  "RpcFailure",
] as const satisfies readonly SdkErrorCode[];

/**
 * SDK-side codes deliberately spelled as a contract error, because the SDK
 * raises them to mean exactly that error. An entry here is a decision, and the
 * collision test names it.
 */
export const SDK_CODES_THAT_ARE_CONTRACT_ERRORS: readonly SdkErrorCode[] = [
  // Raised before sending for a WAD with dust below one raw unit of an ERC-20
  // quote: exactly what BondingCurve and Launchpad revert with for that amount.
  "QuoteAmountNotRepresentable",
];

/** Compile-time proof that {@link SDK_ERROR_CODES} lists every {@link SdkErrorCode}. */
type MissingSdkErrorCode = Exclude<SdkErrorCode, (typeof SDK_ERROR_CODES)[number]>;
const everySdkErrorCodeIsListed: [MissingSdkErrorCode] extends [never] ? true : MissingSdkErrorCode
  = true;
void everySdkErrorCodeIsListed;

/**
 * An SDK code, or the name of a custom error declared in one of the pinned
 * ABIs — `"CurveGraduated"`, `"IncorrectPayment"`, `"NotProtocolAdmin"` and the
 * rest. Kept open rather than enumerated so that a contracts release adding an
 * error does not need a type change here to be reported by name.
 */
export type ArcNowErrorCode = SdkErrorCode | (string & {});

/** How to build an {@link ArcNowError}. */
export interface ArcNowErrorOptions {
  /** The discriminant. An {@link SdkErrorCode} or a contract error name. */
  code: ArcNowErrorCode;
  /** A sentence that tells the caller what to do about it. */
  message: string;
  /**
   * Decoded revert parameters, by the name the Solidity error gave them.
   * Empty for an SDK-side error and for a custom error that takes none.
   */
  args?: Readonly<Record<string, unknown>> | undefined;
  /** Decoded revert parameters in declaration order, for positional access. */
  positionalArgs?: readonly unknown[] | undefined;
  /** The 4-byte selector the revert data started with, when there was one. */
  selector?: `0x${string}` | undefined;
  /** The raw revert data, kept so an unrecognised selector can still be looked up. */
  data?: `0x${string}` | undefined;
  /** Anything else worth carrying: the contract that was missing, the network, the addresses. */
  details?: Readonly<Record<string, unknown>> | undefined;
  /** The original error. Always set when this wraps a viem or transport failure. */
  cause?: unknown;
}

/**
 * The error every method on this SDK throws.
 *
 * @example
 * ```ts
 * try {
 *   await curve.buy({ usdcIn: Usdc.parse("10"), minTokensOut, deadline });
 * } catch (error) {
 *   if (isArcNowError(error) && error.code === "SlippageExceeded") {
 *     // error.args.minOutWad / error.args.actualOutWad are the numbers
 *     return requote();
 *   }
 *   throw error;
 * }
 * ```
 */
export class ArcNowError extends Error {
  override readonly name = "ArcNowError";

  /** What went wrong, as something a `switch` can branch on. */
  readonly code: ArcNowErrorCode;

  /** Decoded revert parameters by name. `{}` when there are none. */
  readonly args: Readonly<Record<string, unknown>>;

  /** Decoded revert parameters in order. `[]` when there are none. */
  readonly positionalArgs: readonly unknown[];

  /** The 4-byte selector, when this came from revert data. */
  readonly selector?: `0x${string}` | undefined;

  /** The raw revert data, when there was any. */
  readonly data?: `0x${string}` | undefined;

  /** Whatever context the thrower attached. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(options: ArcNowErrorOptions) {
    super(options.message, options.cause === undefined ? {} : { cause: options.cause });
    this.code = options.code;
    this.args = options.args ?? {};
    this.positionalArgs = options.positionalArgs ?? [];
    this.selector = options.selector;
    this.data = options.data;
    this.details = options.details ?? {};
  }

  /** True when this came from a contract reverting, rather than from the SDK's own checks. */
  get isRevert(): boolean {
    return this.data !== undefined || this.selector !== undefined;
  }

  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

/** A type guard, for the one `catch` a caller should need. */
export function isArcNowError(value: unknown): value is ArcNowError {
  return value instanceof ArcNowError;
}
