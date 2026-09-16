/**
 * Turning whatever viem threw into the one {@link ArcNowError}.
 *
 * **Map through viem's own error, do not reach past it.** viem already walks
 * the transport's response, finds the revert and wraps it in a
 * `ContractFunctionRevertedError` that carries the raw data and, when the ABI
 * covered it, the decoded name and arguments. Re-parsing the JSON-RPC envelope
 * here would be a second implementation of something viem maintains, and would
 * go wrong on exactly the nodes whose error shapes viem has already learned.
 * So: walk the chain for the revert, take the raw bytes off it, and decode
 * those against {@link ERROR_REGISTRY} — which spans *every* pinned ABI, not
 * just the one being called, so an error thrown by a token or a migrator inside
 * a curve call still decodes.
 *
 * A caller never sees a bare hex blob. The four cases that are not a known
 * custom error each get their own code and their own sentence: a plain
 * `Error(string)`, a `Panic(uint256)`, empty revert data, and a selector in no
 * ABI this SDK carries.
 *
 * @module
 */

import { BaseError, ContractFunctionRevertedError, toFunctionSelector } from "viem";

import { arcNowFeeHookAbi } from "../generated/abi/index.js";

import { ArcNowError } from "./error.js";
import type { ErrorContext } from "./messages.js";
import { messageFor } from "./messages.js";
import {
  decodeRevertData,
  ERROR_STRING_SELECTOR,
  lookupSelector,
  PANIC_SELECTOR,
  WRAPPED_ERROR_SELECTOR,
} from "./registry.js";

/** One layer of v4's `WrappedError`, outermost first in `details.wrappedBy`. */
export interface WrappedLayer {
  /** The contract whose call reverted: the hook, or the currency being transferred. */
  readonly target: `0x${string}`;
  /** The selector of the call that reverted, e.g. the hook's `beforeSwap`. */
  readonly selector: `0x${string}`;
  /** The function that selector names, when this SDK knows it (the hook callbacks). */
  readonly selectorName?: string | undefined;
  /** v4's own context: `HookCallFailed()` for a hook call. */
  readonly details: `0x${string}`;
  /** `details` decoded, when it is an error this SDK knows. */
  readonly detailsName?: string | undefined;
}

/** Hook callback selectors, from the pinned fee hook's ABI, for naming a wrapped call. */
const HOOK_FUNCTIONS: ReadonlyMap<string, string> = new Map(
  (arcNowFeeHookAbi as readonly { type: string; name?: string }[])
    .filter((item) => item.type === "function")
    .map((item) => {
      const signature = toFunctionSelector(item as never);
      return [signature.toLowerCase(), item.name ?? ""] as const;
    }),
);

/**
 * What each `Panic(uint256)` code means.
 *
 * A panic is a check the **compiler** inserted, not a rule a contract wrote, so
 * the advice is always the same shape: this is a bug rather than a rejection,
 * and the number says which kind.
 */
const PANIC_REASONS: Record<string, string> = {
  "0x00": "a generic compiler panic",
  "0x01": "an assert() that did not hold",
  "0x11": "arithmetic overflowed or underflowed",
  "0x12": "a division or modulo by zero",
  "0x21": "a value converted to an enum that has no such member",
  "0x22": "an incorrectly encoded storage byte array",
  "0x31": "a pop() on an empty array",
  "0x32": "an array index out of bounds",
  "0x41": "too much memory allocated, or an array created too large",
  "0x51": "a zero-initialised internal function pointer was called",
};

function hexData(value: unknown): `0x${string}` | undefined {
  if (typeof value === "string" && value.startsWith("0x")) return value as `0x${string}`;
  if (value && typeof value === "object" && "data" in value) {
    return hexData((value).data);
  }
  return undefined;
}

/**
 * Find the revert bytes anywhere in an error chain.
 *
 * viem nests: an execution error wrapping a reverted error wrapping the raw
 * one. The raw hex may sit on any of them depending on how the node phrased
 * itself, so every link is asked.
 */
function findRevertData(error: unknown): `0x${string}` | undefined {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const raw = hexData(reverted.raw) ?? hexData(reverted.signature);
      if (raw !== undefined) return raw;
      // A revert viem itself decoded but whose raw bytes it did not keep: it
      // still gives us the name, which the caller of this function handles.
      if (reverted.data !== undefined) return undefined;
      // A revert with no data at all. Distinguish it from "not found" below.
      return "0x";
    }
    const withData = error.walk((e) => hexData((e as { data?: unknown }).data) !== undefined);
    const raw = hexData((withData as { data?: unknown } | null)?.data);
    if (raw !== undefined) return raw;
  }
  return hexData((error as { data?: unknown } | null)?.data);
}

function revertedError(error: unknown): ContractFunctionRevertedError | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const found = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return found instanceof ContractFunctionRevertedError ? found : undefined;
}

/**
 * Map anything thrown by a contract interaction into an {@link ArcNowError}.
 *
 * Idempotent: an {@link ArcNowError} passes straight through, so a method that
 * validated its arguments and then called the chain can wrap the whole thing in
 * one try/catch without double-mapping its own refusal.
 *
 * @param error   Whatever was thrown.
 * @param context Facts the revert data does not carry — the launch fee, the
 *                contract, the function — so the message can name them.
 */
export function mapError(error: unknown, context: ErrorContext = {}): ArcNowError {
  if (error instanceof ArcNowError) return error;

  const where = context.functionName
    ? ` (calling ${context.functionName}${context.address ? ` at ${context.address}` : ""})`
    : "";

  const data = findRevertData(error);

  if (data === "0x" && context.quoteToken !== undefined && !context.quoteToken.isNative) {
    const { symbol, address } = context.quoteToken;
    const limit = context.gasLimit === undefined ? "" : ` at a gas limit of ${context.gasLimit}`;
    return new ArcNowError({
      code: "QuoteTransferOutOfGas",
      message:
        `the call reverted with no data${where}, on a path that pays ${symbol} fee shares${limit}. `
        + "arcnow.io's contracts push every ERC-20 fee share through a gas guard "
        + "(QuoteTransfer.tryPushBounded) that reverts with no data when less than about 111,600 "
        + "gas remains for it, so this is a gas limit too tight for the transfers rather than a "
        + "rejection. Leave gasLimit unset and the SDK sends the node's estimate plus a fifth (at "
        + "least 150,000 more), or raise it; a graduating trade needs GRADUATION_GAS_LIMIT.",
      data,
      details: { quoteToken: address, gasLimit: context.gasLimit },
      cause: error,
    });
  }

  if (data === "0x") {
    return new ArcNowError({
      code: "EmptyRevert",
      message:
        `the call reverted with no data at all${where}. That is almost always one of three `
        + "things: it ran out of gas, it was sent to an address with no code on it (check "
        + "the address, and check you are on the chain you think you are), or a plain "
        + "require() with no reason string somewhere outside arcnow.io's contracts — every "
        + "failure in those is a named error.",
      data,
      cause: error,
    });
  }

  if (data !== undefined) {
    if (data.toLowerCase().startsWith(WRAPPED_ERROR_SELECTOR)) {
      return unwrap(data, context, where, error);
    }
    return mapRevertData(data, context, where, error);
  }
  return mapWithoutData(error, context, where);
}

/**
 * Peel v4's `WrappedError` layers off revert data and report the revert inside.
 *
 * v4-core wraps a reverting hook call as `WrappedError(hook, selector, reason,
 * HookCallFailed())`, and a hook that itself makes a v4 call can wrap again. The
 * innermost `reason` is what actually went wrong. When it is a custom error this
 * SDK knows, an `Error(string)` or a `Panic`, the result **is** that error — same
 * code, same decoded args — with the layers it came through on
 * `details.wrappedBy`, outermost first. When the inner reason is empty or
 * unknown, the code is `WrappedRevert` and the raw layers are all there is.
 */
function unwrap(
  outer: `0x${string}`,
  context: ErrorContext,
  where: string,
  cause: unknown,
): ArcNowError {
  const layers: WrappedLayer[] = [];
  let data: `0x${string}` = outer;
  while (data.toLowerCase().startsWith(WRAPPED_ERROR_SELECTOR) && layers.length < 16) {
    const decoded = decodeRevertData(data);
    const { target, selector, reason, details } = decoded.args as {
      target?: `0x${string}`;
      selector?: `0x${string}`;
      reason?: `0x${string}`;
      details?: `0x${string}`;
    };
    if (target === undefined || selector === undefined || reason === undefined
      || details === undefined) {
      break;
    }
    const detailsName = details.length >= 10
      ? lookupSelector(details.slice(0, 10))?.name
      : undefined;
    layers.push({
      target,
      selector,
      // A hook callback by its name; and v4-core's own transfers, which wrap a
      // failure with selector 0x00000000 (native) or the token's transfer
      // selector (ERC-20) and say which in `details`. Selector zero is v4's
      // marker for a native transfer, not padding or an empty layer.
      selectorName: HOOK_FUNCTIONS.get(selector.toLowerCase())
        ?? (detailsName === "NativeTransferFailed"
          ? "native transfer"
          : detailsName === "ERC20TransferFailed" ? "ERC-20 transfer" : undefined),
      details,
      detailsName,
    });
    data = reason;
  }

  const describe = layers
    .map((layer) =>
      `${layer.selectorName ?? layer.selector} on ${layer.target}`
      + (layer.detailsName ? ` (${layer.detailsName})` : ""))
    .join(", inside ");
  const prefix = `inside a Uniswap v4 call — ${describe} — `;
  const inner = data.length >= 10 ? decodeRevertData(data) : undefined;
  const known = inner !== undefined && (inner.error !== undefined
    || inner.selector === ERROR_STRING_SELECTOR || inner.selector === PANIC_SELECTOR);

  if (!known) {
    const innermost = layers[layers.length - 1];
    const nativeTransfer = data === "0x" && innermost?.detailsName === "NativeTransferFailed";
    return new ArcNowError({
      code: "WrappedRevert",
      message: nativeTransfer
        ? `${prefix}the PoolManager could not pay native USDC to ${innermost.target}${where}: `
        + "v4-core's native transfer failed with no reason. The manager did not hold the "
        + "native USDC it owed that address when it tried to pay it, or the address refused "
        + "native USDC. The layers are on error.details.wrappedBy."
        : `${prefix}the call reverted with ${data === "0x" ? "no data at all" : `data ${data}, whose selector is in none of the ABIs this SDK carries`}${where}. `
          + "v4 wraps every failing hook call and native transfer in WrappedError; the layers "
          + "are on error.details.wrappedBy. An empty reason is most often a hook running out of "
          + "gas or a transfer to an address that refuses native USDC.",
      selector: WRAPPED_ERROR_SELECTOR,
      data: outer,
      details: {
        wrappedBy: layers,
        target: layers[0]?.target,
        selector: layers[0]?.selector,
        reason: data,
        details: layers[0]?.details,
      },
      cause,
    });
  }

  const mapped = mapRevertData(data, context, where, cause);
  return new ArcNowError({
    code: mapped.code,
    message: `${prefix}${mapped.message}`,
    args: mapped.args,
    positionalArgs: mapped.positionalArgs,
    selector: mapped.selector,
    data: mapped.data,
    details: { ...mapped.details, wrappedBy: layers, wrappedData: outer },
    cause,
  });
}

/** Decode raw revert data that is not a `WrappedError`. */
function mapRevertData(
  data: `0x${string}`,
  context: ErrorContext,
  where: string,
  error: unknown,
): ArcNowError {
  {
    const decoded = decodeRevertData(data);

    if (decoded.selector === ERROR_STRING_SELECTOR) {
      const reason = typeof decoded.args.reason === "string" ? decoded.args.reason : "";
      return new ArcNowError({
        code: "RevertString",
        message:
          `the call reverted with the message ${JSON.stringify(reason)}${where}. No `
          + "arcnow.io contract throws a string — every failure in them is a named custom "
          + "error — so this came from something else in the call path: a venue, a router, "
          + "a token that is not ours.",
        args: decoded.args,
        positionalArgs: decoded.positionalArgs,
        selector: decoded.selector,
        data,
        details: { reason },
        cause: error,
      });
    }

    if (decoded.selector === PANIC_SELECTOR) {
      const raw = decoded.args.code;
      const code = typeof raw === "bigint" ? `0x${raw.toString(16).padStart(2, "0")}` : "0x??";
      const reason = PANIC_REASONS[code] ?? "an unrecognised panic code";
      return new ArcNowError({
        code: "Panic",
        message:
          `the call hit a compiler-inserted check: Panic(${code}) — ${reason}${where}. A `
          + "panic is a bug rather than a rejection: it is not a rule any contract wrote, "
          + "it is the compiler catching something impossible. If the call path is entirely "
          + "arcnow.io's, this is worth reporting with the arguments you passed.",
        args: decoded.args,
        positionalArgs: decoded.positionalArgs,
        selector: decoded.selector,
        data,
        details: { panicCode: code, reason },
        cause: error,
      });
    }

    if (decoded.error) {
      const authored = messageFor(
        decoded.error.name,
        decoded.error.signature,
        decoded.args,
        context,
      );
      const fallback
        = `${decoded.error.signature} reverted${where}. This SDK has no advice written for `
          + "it yet; the decoded arguments are on error.args, and the error is declared in "
          + `${decoded.error.sources.join(", ")}.`;
      return new ArcNowError({
        code: decoded.error.name,
        message: authored ?? fallback,
        args: decoded.args,
        positionalArgs: decoded.positionalArgs,
        selector: decoded.selector,
        data,
        details: { signature: decoded.error.signature, declaredIn: decoded.error.sources },
        cause: error,
      });
    }

    return new ArcNowError({
      code: "UnknownRevert",
      message:
        `the call reverted with selector ${decoded.selector ?? "(none)"}, which is in none `
        + `of the ABIs this SDK carries${where}. Look the selector up — `
        + "https://openchain.xyz/signatures is the usual place — and if it turns out to "
        + "belong to arcnow-io/contracts, the pinned ABIs in this package are behind the "
        + `deployment. Full revert data: ${data}`,
      selector: decoded.selector,
      data,
      cause: error,
    });
  }
}

/** A revert viem decoded without keeping its bytes, or a failure that never reached a contract. */
function mapWithoutData(error: unknown, context: ErrorContext, where: string): ArcNowError {
  // viem decoded the revert but kept no raw bytes. Rare, and worth handling:
  // the name and arguments are still there, and they are what the message needs.
  const reverted = revertedError(error);
  if (reverted?.data) {
    const name = reverted.data.errorName;
    const values = (reverted.data.args ?? []);
    const abiItem = reverted.data.abiItem;
    const inputs
      = abiItem && "inputs" in abiItem ? (abiItem.inputs as readonly { name?: string }[]) : [];
    const args: Record<string, unknown> = {};
    inputs.forEach((input, index) => {
      args[input.name ?? `arg${index}`] = values[index];
    });
    const authored = messageFor(name, `${name}(...)`, args, context);
    return new ArcNowError({
      code: name,
      message: authored ?? `${name} reverted${where}. The decoded arguments are on error.args.`,
      args,
      positionalArgs: values,
      cause: error,
    });
  }

  if (reverted?.reason) {
    return new ArcNowError({
      code: "RevertString",
      message: `the call reverted with the message ${JSON.stringify(reverted.reason)}${where}.`,
      details: { reason: reverted.reason },
      cause: error,
    });
  }

  const detail = error instanceof BaseError
    ? error.shortMessage
    : error instanceof Error
      ? error.message
      : String(error);
  return new ArcNowError({
    code: "RpcFailure",
    message:
      `the call did not reach a contract${where}: ${detail}. This is the transport rather `
      + "than the chain — a wrong RPC URL, an endpoint that is down or rate limiting, a "
      + "wallet that rejected the request, or a chain id that is not the one this client "
      + "was built for.",
    cause: error,
  });
}

/**
 * Run something and map anything it throws.
 *
 * Every public method on this SDK that touches the chain goes through here, so
 * that "one error type" is a property of the code rather than a convention.
 */
export async function withMappedErrors<T>(
  context: ErrorContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw mapError(error, context);
  }
}
