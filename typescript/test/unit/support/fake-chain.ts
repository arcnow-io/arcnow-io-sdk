/**
 * A scripted chain for unit tests that need writes: reads, Multicall3, native
 * balances, `eth_sendTransaction` and receipts, all answered from per-contract
 * handlers decoded against the real pinned ABIs.
 *
 * Every JSON-RPC request is counted and every contract call recorded, so a test
 * can assert not only what the SDK did but **how many round trips it cost** and
 * that nothing was sent when nothing should have been. Anything unscripted
 * throws, so a test cannot pass by quietly reaching a real endpoint.
 */

import type { Abi, AbiEvent, Address, Hex } from "viem";
import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  toHex,
} from "viem";

import { MULTICALL3_ADDRESS } from "../../../src/networks.js";

/** A revert with a custom error, thrown from a handler. */
export class Revert extends Error {
  constructor(
    readonly abi: Abi,
    readonly errorName: string,
    readonly args: readonly unknown[] = [],
  ) {
    super(`revert ${errorName}`);
  }
}

/** An event a write handler emits. */
export interface EmittedLog {
  readonly address: Address;
  readonly abi: Abi;
  readonly eventName: string;
  readonly args: Record<string, unknown>;
}

/** What a handler is told about the call it is answering. */
export interface CallContext {
  readonly from: Address | undefined;
  readonly value: bigint;
  /** False while simulating (`eth_call`), true while executing (`eth_sendTransaction`). */
  readonly commit: boolean;
  readonly chain: FakeChain;
}

export type Handler = (args: readonly unknown[], context: CallContext) => unknown;

export interface WriteOutcome {
  readonly result?: unknown;
  readonly logs?: readonly EmittedLog[];
  /** When true, the mined receipt says `status: reverted`. */
  readonly reverted?: boolean;
}

/** One simulation of a write (an `eth_call` of a non-view function). */
export interface Simulation {
  readonly label: string;
  readonly functionName: string;
  readonly value: bigint | undefined;
  /** The third `eth_call` parameter, verbatim, keyed by lower-cased address. */
  readonly stateOverride: Record<string, unknown> | undefined;
}

export type WriteHandler = (args: readonly unknown[], context: CallContext) => WriteOutcome;

export interface FakeContract {
  /** Names the contract in {@link FakeChain.calls}: `"eurc.allowance"`. */
  readonly label: string;
  readonly abi: Abi;
  readonly reads?: Record<string, Handler>;
  readonly writes?: Record<string, WriteHandler>;
}

/** One transaction the SDK sent. */
export interface SentTransaction {
  readonly to: Address;
  readonly label: string;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly value: bigint;
  readonly from: Address | undefined;
  readonly hash: Hex;
  /** The gas limit the transaction carried, when the SDK set one. */
  readonly gas: bigint | undefined;
}

const MULTICALL3_ABI = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [{
      name: "calls",
      type: "tuple[]",
      components: [
        { name: "target", type: "address" },
        { name: "allowFailure", type: "bool" },
        { name: "callData", type: "bytes" },
      ],
    }],
    outputs: [{
      name: "returnData",
      type: "tuple[]",
      components: [
        { name: "success", type: "bool" },
        { name: "returnData", type: "bytes" },
      ],
    }],
  },
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

export class FakeChain {
  /** Every contract call, as `label.functionName`, reads and simulations alike. */
  readonly calls: string[] = [];
  /** Every JSON-RPC method requested, in order. */
  readonly rpc: string[] = [];
  /** Every transaction sent. */
  readonly sent: SentTransaction[] = [];
  /** Every simulated write, with the value and state override it carried. */
  readonly simulations: Simulation[] = [];
  /** Native balances, by lower-cased address. */
  readonly balances = new Map<string, bigint>();
  /** While true, every eth_call fails at the transport (viem's retries included). */
  failCalls = false;

  private readonly contracts = new Map<string, FakeContract>();
  private readonly receipts = new Map<Hex, Record<string, unknown>>();
  private readonly block = 100n;
  private pendingOverride: Record<string, unknown> | undefined;
  private pendingValue: bigint | undefined;
  /** True while an eth_estimateGas runs a handler: nothing is recorded. */
  private estimating = false;

  constructor(contracts: Record<string, FakeContract>) {
    for (const [address, contract] of Object.entries(contracts)) {
      this.contracts.set(address.toLowerCase(), contract);
    }
  }

  /** How many JSON-RPC requests of one method were made. */
  count(method: string): number {
    return this.rpc.filter((name) => name === method).length;
  }

  /** The sends, as `label.functionName`. */
  sends(): string[] {
    return this.sent.map((tx) => `${tx.label}.${tx.functionName}`);
  }

  transport() {
    return custom({ request: ({ method, params }) => this.request(method, params as unknown[]) });
  }

  private request(method: string, params: unknown[]): Promise<unknown> {
    try {
      return Promise.resolve(this.answer(method, params));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private answer(method: string, params: unknown[]): unknown {
    this.rpc.push(method);
    switch (method) {
      case "eth_chainId":
        return "0x4cef52";
      case "eth_blockNumber":
        return numberToHex(this.block);
      case "eth_getBalance": {
        const [address] = params as [Address];
        return numberToHex(this.balances.get(address.toLowerCase()) ?? 0n);
      }
      case "eth_estimateGas": {
        // Estimated by running the call, so a call that reverts fails its estimate
        // exactly as a node's does; a call that succeeds costs 100,000.
        const [call] = params as [{ to?: Address; data?: Hex; from?: Address; value?: Hex }];
        if (call.to !== undefined && call.data !== undefined
          && this.contracts.has(call.to.toLowerCase())) {
          this.estimating = true;
          try {
            this.call({
              to: call.to,
              data: call.data,
              ...(call.from === undefined ? {} : { from: call.from }),
              ...(call.value === undefined ? {} : { value: call.value }),
            }, false);
          } finally {
            this.estimating = false;
          }
        }
        return "0x186a0";
      }
      case "eth_call": {
        if (this.failCalls) throw new Error("fetch failed: connect ECONNREFUSED");
        const [call, , override] = params as [
          { to: Address; data: Hex; from?: Address; value?: Hex },
          unknown,
          Record<string, unknown>?,
        ];
        this.pendingOverride = override === undefined
          ? undefined
          : Object.fromEntries(Object.entries(override).map(([k, v]) => [k.toLowerCase(), v]));
        this.pendingValue = call.value === undefined ? undefined : BigInt(call.value);
        return this.call(call, false);
      }
      case "eth_sendTransaction": {
        const [tx] = params as [{ to: Address; data: Hex; from?: Address; value?: Hex; gas?: Hex }];
        return this.send(tx);
      }
      case "eth_getTransactionReceipt": {
        const [hash] = params as [Hex];
        return this.receipts.get(hash) ?? null;
      }
      default:
        throw new Error(`unscripted RPC method ${method}`);
    }
  }

  private call(
    call: { to: Address; data: Hex; from?: Address; value?: Hex },
    commit: boolean,
  ): Hex {
    const to = call.to.toLowerCase();
    if (to === MULTICALL3_ADDRESS.toLowerCase()) return this.multicall(call.data);
    const contract = this.contracts.get(to);
    if (!contract) throw new Error(`unscripted call to ${call.to}`);
    const { functionName, args: decoded } = decodeFunctionData({
      abi: contract.abi, data: call.data,
    });
    const args = normalise(decoded ?? []) as readonly unknown[];
    if (!this.estimating) this.calls.push(`${contract.label}.${functionName}`);
    const context: CallContext = {
      from: call.from,
      value: call.value === undefined ? 0n : BigInt(call.value),
      commit,
      chain: this,
    };
    try {
      const read = contract.reads?.[functionName];
      if (read) {
        const result = read(args, context);
        return encodeFunctionResult({ abi: contract.abi, functionName, result });
      }
      const write = contract.writes?.[functionName];
      if (write) {
        if (!this.estimating) this.simulations.push({
          label: contract.label,
          functionName,
          value: this.pendingValue,
          stateOverride: this.pendingOverride,
        });
        const outcome = write(args, context);
        return encodeFunctionResult({ abi: contract.abi, functionName, result: outcome.result });
      }
    } catch (error) {
      if (error instanceof Revert) {
        const data = encodeErrorResult({
          abi: error.abi, errorName: error.errorName, args: error.args,
        });
        throw Object.assign(new Error("execution reverted"), { code: 3, data });
      }
      throw error;
    }
    throw new Error(`${contract.label} has no ${functionName}()`);
  }

  private multicall(data: Hex): Hex {
    const decoded = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    if (decoded.functionName === "getEthBalance") {
      throw new Error("getEthBalance called outside aggregate3");
    }
    this.calls.push("multicall.aggregate3");
    type Call3 = { target: Address; allowFailure: boolean; callData: Hex };
    const [calls] = decoded.args as [readonly Call3[]];
    const results = calls.map((sub) => {
      if (sub.target.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
        const inner = decodeFunctionData({ abi: MULTICALL3_ABI, data: sub.callData });
        if (inner.functionName !== "getEthBalance") throw new Error("nested aggregate3");
        this.calls.push("multicall.getEthBalance");
        const [address] = inner.args as [Address];
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: MULTICALL3_ABI,
            functionName: "getEthBalance",
            result: this.balances.get(address.toLowerCase()) ?? 0n,
          }),
        };
      }
      try {
        const returnData = this.call({ to: sub.target, data: sub.callData }, false);
        return { success: true, returnData };
      } catch (error) {
        const revertData = (error as { data?: Hex }).data;
        if (revertData === undefined) throw error;
        return { success: false, returnData: revertData };
      }
    });
    return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: "aggregate3", result: results });
  }

  private send(tx: { to: Address; data: Hex; from?: Address; value?: Hex; gas?: Hex }): Hex {
    const contract = this.contracts.get(tx.to.toLowerCase());
    if (!contract) throw new Error(`unscripted send to ${tx.to}`);
    const { functionName, args: decoded } = decodeFunctionData({
      abi: contract.abi, data: tx.data,
    });
    const args = normalise(decoded ?? []) as readonly unknown[];
    const write = contract.writes?.[functionName];
    if (!write) throw new Error(`${contract.label} has no writable ${functionName}()`);
    const value = tx.value === undefined ? 0n : BigInt(tx.value);
    const from = tx.from?.toLowerCase() as Address | undefined;
    const outcome = write(args, { from, value, commit: true, chain: this });
    const hash = keccak256(toHex(`tx-${this.sent.length}-${functionName}`));
    const to = tx.to.toLowerCase() as Address;
    const gas = tx.gas === undefined ? undefined : BigInt(tx.gas);
    this.sent.push({ to, label: contract.label, functionName, args, value, from, hash, gas });
    const blockHash = `0x${"11".repeat(32)}`;
    this.receipts.set(hash, {
      blockHash,
      blockNumber: numberToHex(this.block),
      contractAddress: null,
      cumulativeGasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      from: tx.from ?? `0x${"00".repeat(20)}`,
      gasUsed: "0x5208",
      logs: (outcome.logs ?? []).map((log, index) => ({
        ...encodeLog(log),
        blockHash,
        blockNumber: numberToHex(this.block),
        logIndex: numberToHex(index),
        transactionHash: hash,
        transactionIndex: "0x0",
        removed: false,
      })),
      logsBloom: `0x${"00".repeat(256)}`,
      status: outcome.reverted === true ? "0x0" : "0x1",
      to: tx.to,
      transactionHash: hash,
      transactionIndex: "0x0",
      type: "0x2",
    });
    return hash;
  }
}

/**
 * Decoded call arguments with every address lower-cased, recursively, so a test
 * compares against the lower-case addresses the SDK and `networks.json` use
 * rather than the checksummed form viem decodes to.
 */
function normalise(value: unknown): unknown {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalise(inner)]));
  }
  return value;
}

/** An event encoded the way a node hands it back. */
export function encodeLog(log: EmittedLog): { address: Address; topics: Hex[]; data: Hex } {
  const item = log.abi.find((entry): entry is AbiEvent =>
    entry.type === "event" && entry.name === log.eventName);
  if (item === undefined) throw new Error(`no event ${log.eventName}`);
  const topics = encodeEventTopics({ abi: [item], eventName: log.eventName, args: log.args });
  const unindexed = item.inputs.filter((input) => input.indexed !== true);
  const data = encodeAbiParameters(unindexed, unindexed.map((input) => log.args[input.name ?? ""]));
  return { address: log.address, topics: topics as Hex[], data };
}

/** A plain ERC-20 with balances and allowances, as a {@link FakeContract}. */
export function fakeErc20(options: {
  readonly label: string;
  readonly address: Address;
  readonly abi: Abi;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly balances?: Record<string, bigint>;
  readonly allowances?: Record<string, bigint>;
}): FakeContract & { allowances: Map<string, bigint>; balances: Map<string, bigint> } {
  const lower = (entries: Record<string, bigint> | undefined) =>
    new Map(Object.entries(entries ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const balances = lower(options.balances);
  const allowances = lower(options.allowances);
  const key = (owner: unknown, spender: unknown) => `${String(owner).toLowerCase()}:${String(spender).toLowerCase()}`;
  return {
    label: options.label,
    abi: options.abi,
    balances,
    allowances,
    reads: {
      symbol: () => options.symbol,
      name: () => options.name,
      decimals: () => options.decimals,
      balanceOf: ([owner]) => balances.get(String(owner).toLowerCase()) ?? 0n,
      allowance: ([owner, spender]) => allowances.get(key(owner, spender)) ?? 0n,
    },
    writes: {
      approve: ([spender, amount], context) => {
        if (context.commit) allowances.set(key(context.from, spender), amount as bigint);
        return {
          result: true,
          logs: [{
            address: options.address,
            abi: options.abi,
            eventName: "Approval",
            args: { owner: context.from, spender, value: amount },
          }],
        };
      },
    },
  };
}
