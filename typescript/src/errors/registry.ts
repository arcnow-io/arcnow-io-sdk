/**
 * Every custom error in every pinned ABI, indexed by its 4-byte selector.
 *
 * **Why it spans all of them rather than the one contract being called.** solc
 * folds inherited interface errors into the concrete ABI, so `BondingCurve.json`
 * already carries every error a curve can throw — but a curve's *internal* call
 * into a token, a migrator or a registry can bubble that contract's error out
 * through the curve, and viem would then hand back revert data the curve's own
 * ABI cannot decode. A single table across every ABI decodes it anyway.
 *
 * Built once at module load, from the generated `as const` ABIs and from
 * nothing else. Nothing here is hand-maintained: a contracts release that adds
 * an error appears in this table as soon as `scripts/sync-artifacts.sh` runs.
 *
 * @module
 */

import type { AbiError, AbiParameter } from "abitype";
import { decodeAbiParameters, keccak256, stringToBytes } from "viem";

import { uniswapV4Router04Abi } from "../generated/abi/external/uniswapV4Router04.js";
import * as generatedAbis from "../generated/abi/index.js";

/**
 * Pinned ABIs that are **not** arcnow.io's, and are therefore not re-exported
 * by the generated index.
 *
 * They belong in this table for exactly the reason the module docs give: a call
 * that leaves arcnow.io's contracts can come back with somebody else's revert
 * data, and the caller should read `SlippageExceeded` rather than a hex blob.
 * The v4 router is the whole post-graduation trading path, so every slippage
 * floor missed and every deadline passed on a pool trade reverts from here.
 */
const externalAbis = { uniswapV4Router04Abi } as const;

/**
 * Uniswap v4-core's `CustomRevert.WrappedError`, declared by hand because
 * PoolManager's ABI is not pinned here.
 *
 * v4 wraps every revert that comes out of a hook call — and out of a native
 * transfer inside the manager — in this error, so without it a hook's own
 * `NotTokenMigrator` or a pool's `PriceLimitAlreadyExceeded` arrives as an
 * unknown selector. `mapError` unwraps it into the inner revert.
 */
export const v4CoreErrorsAbi = [
  {
    type: "error",
    name: "WrappedError",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "reason", type: "bytes" },
      { name: "details", type: "bytes" },
    ],
  },
  { type: "error", name: "HookCallFailed", inputs: [] },
  // v4-core Currency.transfer's context when a transfer out of the PoolManager
  // fails: a native one is wrapped with selector 0x00000000, an ERC-20 one with
  // the token's transfer selector.
  { type: "error", name: "NativeTransferFailed", inputs: [] },
  { type: "error", name: "ERC20TransferFailed", inputs: [] },
] as const;

/** One decodable error, as the table holds it. */
export interface RegisteredError {
  /** The Solidity error name, e.g. `"SlippageExceeded"`. */
  readonly name: string;
  /**
   * The canonical signature the selector is the hash of, for example
   * `"SlippageExceeded(uint256,uint256)"`.
   */
  readonly signature: string;
  /** Its parameters, for decoding. */
  readonly inputs: readonly AbiParameter[];
  /** Which generated ABIs declare it. More than one is normal and not a problem. */
  readonly sources: readonly string[];
}

/**
 * The canonical signature of an ABI item: the name, then the parameter types
 * with every tuple expanded to its components.
 *
 * Written out rather than taken from a viem internal because the selector is
 * load-bearing — a signature formatted a hair differently hashes to something
 * else and the error silently becomes `UnknownRevert`.
 */
function canonicalType(parameter: AbiParameter): string {
  if (parameter.type.startsWith("tuple")) {
    const components = (parameter as { components?: readonly AbiParameter[] }).components ?? [];
    const suffix = parameter.type.slice("tuple".length);
    return `(${components.map(canonicalType).join(",")})${suffix}`;
  }
  return parameter.type;
}

/** The canonical signature of a custom error. */
export function errorSignature(item: AbiError): string {
  return `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

/** The 4-byte selector of a canonical signature. */
export function selectorOf(signature: string): `0x${string}` {
  return keccak256(stringToBytes(signature)).slice(0, 10) as `0x${string}`;
}

/**
 * `Error(string)` -- a plain `require("...")` or `revert("...")`.
 *
 * Not declared in any arcnow.io ABI, because no arcnow.io contract throws one:
 * every failure in `src/` is a named custom error. It is in the table anyway,
 * because a call can reach somebody else's contract — a migrator's venue, a
 * router, a token — and come back with one.
 */
export const ERROR_STRING_SELECTOR = selectorOf("Error(string)");

/** `Panic(uint256)` — a check the compiler inserted, not a rule a contract wrote. */
export const PANIC_SELECTOR = selectorOf("Panic(uint256)");

/** Uniswap v4's `WrappedError(address,bytes4,bytes,bytes)`: `0x90bfb865`. */
export const WRAPPED_ERROR_SELECTOR = selectorOf("WrappedError(address,bytes4,bytes,bytes)");

function buildRegistry(): ReadonlyMap<string, RegisteredError> {
  const table = new Map<string, RegisteredError>();

  for (const [exportName, abi] of [
    ...Object.entries(generatedAbis),
    ...Object.entries(externalAbis),
    ["v4-core", v4CoreErrorsAbi] as const,
  ]) {
    if (!Array.isArray(abi)) continue;
    for (const item of abi as readonly { type: string }[]) {
      if (item.type !== "error") continue;
      const error = item as unknown as AbiError;
      const signature = errorSignature(error);
      const selector = selectorOf(signature);
      const existing = table.get(selector);
      if (existing) {
        // The same error declared on several contracts, which is the normal
        // case: solc copies an inherited interface's errors into every concrete
        // ABI. Record the extra source and move on. A genuine four-byte
        // collision between two *different* signatures would show up here as a
        // second signature under one selector; the first wins, deterministically,
        // because the sources are listed and a reader can see both.
        if (!existing.sources.includes(exportName)) {
          table.set(selector, { ...existing, sources: [...existing.sources, exportName] });
        }
        continue;
      }
      table.set(selector, {
        name: error.name,
        signature,
        inputs: error.inputs,
        sources: [exportName],
      });
    }
  }

  table.set(ERROR_STRING_SELECTOR, {
    name: "Error",
    signature: "Error(string)",
    inputs: [{ name: "reason", type: "string" }],
    sources: ["solidity"],
  });
  table.set(PANIC_SELECTOR, {
    name: "Panic",
    signature: "Panic(uint256)",
    inputs: [{ name: "code", type: "uint256" }],
    sources: ["solidity"],
  });

  return table;
}

/** Selector -> error, for every custom error in every pinned ABI. */
export const ERROR_REGISTRY: ReadonlyMap<string, RegisteredError> = buildRegistry();

/** The registered error for a 4-byte selector, if this SDK knows it. */
export function lookupSelector(selector: string): RegisteredError | undefined {
  return ERROR_REGISTRY.get(selector.toLowerCase());
}

/** A decoded revert, ready to be turned into a message. */
export interface DecodedRevert {
  /** The error, when the selector was recognised. */
  readonly error?: RegisteredError | undefined;
  /** The selector the data started with, when it had four bytes to start with. */
  readonly selector?: `0x${string}` | undefined;
  /** Parameters by name. */
  readonly args: Record<string, unknown>;
  /** Parameters in declaration order. */
  readonly positionalArgs: readonly unknown[];
  /** The raw data, unchanged. */
  readonly data: `0x${string}`;
}

/**
 * Decode raw revert data against the whole table.
 *
 * Returns a result with no `error` — never throws — when the selector is
 * unknown or the parameters do not decode. An SDK that threw while explaining a
 * revert would replace the caller's problem with its own.
 */
export function decodeRevertData(data: `0x${string}`): DecodedRevert {
  if (data === "0x" || data.length < 10) {
    return { args: {}, positionalArgs: [], data };
  }
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`;
  const error = lookupSelector(selector);
  if (!error) {
    return { selector, args: {}, positionalArgs: [], data };
  }
  if (error.inputs.length === 0) {
    return { error, selector, args: {}, positionalArgs: [], data };
  }
  try {
    const values: readonly unknown[] = decodeAbiParameters(
      error.inputs,
      `0x${data.slice(10)}`,
    );
    const args: Record<string, unknown> = {};
    error.inputs.forEach((input, index) => {
      args[input.name ?? `arg${index}`] = values[index];
    });
    return { error, selector, args, positionalArgs: values, data };
  } catch {
    return { error, selector, args: {}, positionalArgs: [], data };
  }
}
