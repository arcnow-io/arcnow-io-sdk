/**
 * A quote token as something you hold, approve and spend.
 *
 * A curve is priced in one quote token for life: **native USDC**, paid as
 * `msg.value` and needing no allowance, or an **allowlisted ERC-20** such as
 * EURC, pulled by the curve, the launchpad or the v4 router in raw units of its
 * own decimals — which needs an allowance first.
 *
 * Two rules hold for every approve this SDK sends, and both are tested:
 *
 * - **Exact, never unlimited.** The approve is for the spend in front of it and
 *   nothing more, so a compromised or buggy spender can take at most what the
 *   caller was about to hand it anyway.
 * - **Nothing is sent when the allowance already covers the spend.** An approve
 *   is a transaction, a fee and a round trip on a rate-limited endpoint.
 *
 * Permit2 and EIP-2612 permits are deliberately not used: see the design notes
 * in `arcnow-io/contracts` — a second approval system would stop
 * `allowance(owner, spender)` being the answer to "can this spend go through".
 *
 * @module
 */

import type { Account, Address, Hash, Hex, StateOverride } from "viem";
import { encodeAbiParameters, erc20Abi, keccak256, maxUint256, numberToHex } from "viem";

import type { QuoteTokenInfo } from "./amounts.js";
import { QuoteAmount, quoteTokenInfo, sameQuote } from "./amounts.js";
import type { ClientContext } from "./client.js";
import { ArcNowError } from "./errors/error.js";
import { withMappedErrors } from "./errors/map.js";
import { findQuoteToken, quoteAllowanceSlot } from "./networks.js";

/**
 * Where `allowance(owner, spender)` lives in a Solidity ERC-20 whose allowance
 * mapping `mapping(address => mapping(address => uint256))` sits at `slot`:
 * `keccak256(spender . keccak256(owner . slot))`. EURC's mapping is slot 10.
 */
export function erc20AllowanceSlot(owner: Address, spender: Address, slot: bigint): Hex {
  const ownerSlot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, slot]),
  );
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [spender, BigInt(ownerSlot)]),
  );
}

/**
 * An `eth_call` state override granting `spender` an unlimited allowance of `quote`
 * from `owner`, or `undefined` when the network records no allowance slot for that
 * quote. Used to simulate a spend **before** an approve is paid for, so a spend
 * that would revert anyway costs no approve.
 */
export function allowanceOverride(
  ctx: ClientContext,
  quote: QuoteTokenInfo,
  owner: Address,
  spender: Address,
): StateOverride | undefined {
  if (quote.isNative) return undefined;
  const slot = quoteAllowanceSlot(ctx.config, quote.address);
  if (slot === undefined) return undefined;
  return [{
    address: quote.address,
    stateDiff: [{
      slot: erc20AllowanceSlot(owner, spender, slot),
      value: numberToHex(maxUint256, { size: 32 }),
    }],
  }];
}

/** The share of the node's gas estimate added for an ERC-20 trade, in basis points: a fifth. */
export const QUOTE_TRANSFER_GAS_HEADROOM_BPS = 2_000n;

/** The least gas added on top of the estimate for an ERC-20 trade. */
export const QUOTE_TRANSFER_GAS_HEADROOM_MIN = 150_000n;

/**
 * The gas limit this SDK sends an ERC-20-quoted trade or launch with, given the
 * node's estimate: a fifth more, and never less than 150,000 more.
 *
 * arcnow.io's contracts push every ERC-20 fee share through a gas guard
 * (`QuoteTransfer.tryPushBounded`) that reverts with no data when too little gas
 * remains, and an estimate can land right at that edge.
 */
export function withQuoteTransferHeadroom(estimate: bigint): bigint {
  return withHeadroom(estimate, QUOTE_TRANSFER_GAS_HEADROOM_MIN);
}

/** `estimate` plus a fifth of it, and never less than `min` more. */
function withHeadroom(estimate: bigint, min: bigint): bigint {
  const share = (estimate * QUOTE_TRANSFER_GAS_HEADROOM_BPS) / 10_000n;
  return estimate + (share > min ? share : min);
}

/** The least gas added on top of the estimate for a swap in an ERC-20-quoted pool. */
export const POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN = 400_000n;

/**
 * The gas limit a swap in an ERC-20-quoted pool is sent with, given the node's
 * estimate: a fifth more, and never less than 400,000 more.
 *
 * More than a curve trade gets (review L-1): a swap's estimate can miss the fee
 * hook redeeming and distributing its accrued fee — an accrual that was zero when
 * estimated, until a front-running dust swap made it not — and every ERC-20 share
 * it then pushes needs 111,587 gas left before it.
 */
export function withPoolQuoteTransferHeadroom(estimate: bigint): bigint {
  return withHeadroom(estimate, POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN);
}

/**
 * The gas limit a non-graduating ERC-20-quoted write is sent with:
 * `max(callerLimit, withQuoteTransferHeadroom(estimate))`. A caller's limit below
 * that safe minimum is raised to it, never refused; one above it is kept.
 */
export function erc20GasLimit(estimate: bigint, callerLimit?: bigint): bigint {
  const safe = withQuoteTransferHeadroom(estimate);
  return callerLimit !== undefined && callerLimit > safe ? callerLimit : safe;
}

/** The address a signer signs as. */
export function signerAddressOf(account: Account | Address): Address {
  return typeof account === "string" ? account : account.address;
}

/** Options for {@link QuoteToken.ensureAllowance}. */
export interface EnsureAllowanceOptions {
  /**
   * Run immediately before an approve would be sent — and only then. A spend
   * that simulates its own call here, with the allowance overridden, refuses a
   * doomed spend before paying for an approve it would never use.
   */
  readonly beforeApprove?: (() => Promise<void>) | undefined;
}

/** Multicall3's own native-balance getter, so a native balance batches with other reads. */
const multicall3BalanceAbi = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

/**
 * Quote-token metadata read off the chain, per process, keyed by chain id and
 * address. Symbol, name and decimals of an allowlisted quote do not change, so
 * one read serves every client in the process. A failed read is evicted, never
 * cached: one throttled call must not break labelling for the process lifetime.
 */
const metadataCache = new Map<string, Promise<QuoteTokenInfo>>();

function cacheKey(ctx: ClientContext, address: Address): string {
  return `${ctx.config.chainId}:${address.toLowerCase()}`;
}

/**
 * Record metadata learned some other way (a registry listing, say), so a later
 * {@link resolveQuoteTokenInfo} asks nobody.
 */
export function rememberQuoteTokenInfo(ctx: ClientContext, info: QuoteTokenInfo): void {
  if (findQuoteToken(ctx.config, info.address)) return;
  metadataCache.set(cacheKey(ctx, info.address), Promise.resolve(info));
}

/**
 * The metadata of a quote token: from the network's `quoteTokens` with **no RPC**
 * when it is listed there, otherwise `symbol`, `name` and `decimals` in **one**
 * Multicall3 `eth_call`, cached for the process.
 *
 * Metadata, not the allowlist: this answers for any ERC-20. Whether a launch may
 * use it is `QuoteRegistry.isQuoteToken`.
 */
export function resolveQuoteTokenInfo(
  ctx: ClientContext,
  address: Address,
): Promise<QuoteTokenInfo> {
  const known = findQuoteToken(ctx.config, address);
  if (known !== undefined) return Promise.resolve(known);
  const key = cacheKey(ctx, address);
  const cached = metadataCache.get(key);
  if (cached !== undefined) return cached;

  const pending = withMappedErrors({ functionName: "symbol", address }, async () => {
    const common = { address, abi: erc20Abi } as const;
    let symbol: string;
    let name: string;
    let decimals: number;
    if (ctx.multicallAddress !== undefined) {
      [symbol, name, decimals] = await ctx.publicClient.multicall({
        contracts: [
          { ...common, functionName: "symbol" },
          { ...common, functionName: "name" },
          { ...common, functionName: "decimals" },
        ],
        allowFailure: false,
        multicallAddress: ctx.multicallAddress,
      });
    } else {
      symbol = await ctx.publicClient.readContract({ ...common, functionName: "symbol" });
      name = await ctx.publicClient.readContract({ ...common, functionName: "name" });
      decimals = await ctx.publicClient.readContract({ ...common, functionName: "decimals" });
    }
    return quoteTokenInfo({ address, symbol, name, decimals });
  });
  metadataCache.set(key, pending);
  pending.catch(() => {
    if (metadataCache.get(key) === pending) metadataCache.delete(key);
  });
  return pending;
}

/** What {@link QuoteToken.spendState} reads, in one round trip. */
export interface SpendState {
  /** What the owner holds of the quote. */
  readonly balance: QuoteAmount;
  /**
   * What the owner has approved the spender for. `undefined` for native USDC,
   * which has no allowance, and when no spender was named.
   */
  readonly allowance?: QuoteAmount | undefined;
}

/** What {@link QuoteToken.ensureAllowance} did. */
export interface AllowanceOutcome {
  /** True when an approve was sent (and mined) by this call. */
  readonly approved: boolean;
  /** The approve's transaction, when one was sent. */
  readonly txHash?: Hash | undefined;
  /**
   * The allowance the spender now holds. For native USDC, which needs none, the
   * spend itself.
   */
  readonly allowance: QuoteAmount;
}

/** A handle on one quote token. Built with `client.quoteToken(addressOrInfo)`. */
export class QuoteToken {
  private readonly ctx: ClientContext;
  private readonly known: QuoteTokenInfo | undefined;

  /** The token's address; the zero address for native USDC. */
  readonly address: Address;

  constructor(context: ClientContext, token: Address | QuoteTokenInfo) {
    this.ctx = context;
    if (typeof token === "string") {
      this.address = token.toLowerCase() as Address;
      this.known = undefined;
    } else {
      this.address = token.address;
      this.known = token;
    }
  }

  /** The token's metadata: see {@link resolveQuoteTokenInfo}. */
  info(): Promise<QuoteTokenInfo> {
    return this.known === undefined
      ? resolveQuoteTokenInfo(this.ctx, this.address)
      : Promise.resolve(this.known);
  }

  /** What `account` holds: `eth_getBalance` for native USDC, `balanceOf` for an ERC-20. */
  async balanceOf(account: Address): Promise<QuoteAmount> {
    const token = await this.info();
    if (token.isNative) {
      return withMappedErrors({ functionName: "eth_getBalance" }, async () =>
        QuoteAmount.fromWad(token, await this.ctx.publicClient.getBalance({ address: account })));
    }
    return withMappedErrors({ functionName: "balanceOf", address: token.address }, async () =>
      QuoteAmount.fromRaw(
        token,
        await this.ctx.publicClient.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account],
        }),
      ));
  }

  /**
   * What `owner` has approved `spender` for. ERC-20 quotes only.
   *
   * @throws {ArcNowError} `InvalidArgument` for native USDC, which is paid as
   *   `msg.value` and has no allowance to read.
   */
  async allowance(owner: Address, spender: Address): Promise<QuoteAmount> {
    const token = await this.info();
    if (token.isNative) throw nativeHasNoAllowance(token);
    return withMappedErrors({ functionName: "allowance", address: token.address }, async () =>
      QuoteAmount.fromRaw(
        token,
        await this.ctx.publicClient.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [owner, spender],
        }),
      ));
  }

  /**
   * The owner's balance and, for an ERC-20 with a spender named, their allowance
   * to it — in **one** Multicall3 `eth_call`. A native balance goes through
   * Multicall3's `getEthBalance` so it batches too.
   *
   * Use this rather than two reads wherever both are wanted together.
   */
  async spendState(owner: Address, spender?: Address): Promise<SpendState> {
    const token = await this.info();
    const multicallAddress = this.ctx.multicallAddress;
    if (multicallAddress === undefined) {
      const balance = await this.balanceOf(owner);
      if (token.isNative || spender === undefined) return { balance };
      return { balance, allowance: await this.allowance(owner, spender) };
    }
    return withMappedErrors({ functionName: "spendState", address: token.address }, async () => {
      if (token.isNative) {
        const [balance] = await this.ctx.publicClient.multicall({
          contracts: [{
            address: multicallAddress,
            abi: multicall3BalanceAbi,
            functionName: "getEthBalance",
            args: [owner],
          }],
          allowFailure: false,
          multicallAddress,
        });
        return { balance: QuoteAmount.fromWad(token, balance) };
      }
      const common = { address: token.address, abi: erc20Abi } as const;
      if (spender === undefined) {
        const [balance] = await this.ctx.publicClient.multicall({
          contracts: [{ ...common, functionName: "balanceOf", args: [owner] }],
          allowFailure: false,
          multicallAddress,
        });
        return { balance: QuoteAmount.fromRaw(token, balance) };
      }
      const [balance, allowance] = await this.ctx.publicClient.multicall({
        contracts: [
          { ...common, functionName: "balanceOf", args: [owner] },
          { ...common, functionName: "allowance", args: [owner, spender] },
        ],
        allowFailure: false,
        multicallAddress,
      });
      return {
        balance: QuoteAmount.fromRaw(token, balance),
        allowance: QuoteAmount.fromRaw(token, allowance),
      };
    });
  }

  /**
   * Approve `spender` for **exactly** `amount`, and wait for the receipt so the
   * allowance is readable when this returns. ERC-20 quotes only.
   *
   * @throws {ArcNowError} `QuoteTokenMismatch` for an amount in another quote,
   *   `QuoteAmountNotRepresentable` for dust below one raw unit, and
   *   `InvalidArgument` for native USDC — all before anything is sent.
   */
  async approve(spender: Address, amount: QuoteAmount): Promise<Hash> {
    const { wallet, account } = this.ctx.requireSigner("quoteToken.approve");
    const token = await this.checkedToken(amount);
    if (token.isNative) throw nativeHasNoAllowance(token);
    const raw = amount.toRaw();
    await this.ctx.assertChain();
    return withMappedErrors({ functionName: "approve", address: token.address }, async () => {
      const { request } = await this.ctx.publicClient.simulateContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, raw],
        account,
        chain: this.ctx.chain,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await this.ctx.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new ArcNowError({
          code: "RpcFailure",
          message:
            `the approve of ${amount.format()} to ${spender} was mined and reverted, so no `
            + "allowance was granted and nothing that needs one was sent. On Arc a blocklisted "
            + "or paused token does this.",
          details: { hash, spender, quoteToken: token.address },
        });
      }
      return hash;
    });
  }

  /**
   * Make sure `spender` may pull `amount` from the signer, approving **exactly**
   * `amount` only when the current allowance falls short.
   *
   * - **Native USDC:** nothing to do, and nothing is read: a native spend is
   *   `msg.value`.
   * - **ERC-20, allowance already enough:** one read, nothing sent.
   * - **ERC-20, allowance short:** one read, then {@link QuoteToken.approve} for
   *   the spend — never `uint256.max`, never the difference.
   */
  async ensureAllowance(
    spender: Address,
    amount: QuoteAmount,
    options: EnsureAllowanceOptions = {},
  ): Promise<AllowanceOutcome> {
    const token = await this.checkedToken(amount);
    if (token.isNative) return { approved: false, allowance: amount };
    const { account } = this.ctx.requireSigner("quoteToken.ensureAllowance");
    amount.toRaw();
    const owner = signerAddressOf(account);
    await this.ctx.assertChain();
    const current = await this.allowance(owner, spender);
    if (!current.lt(amount)) return { approved: false, allowance: current };
    await options.beforeApprove?.();
    const txHash = await this.approve(spender, amount);
    return { approved: true, txHash, allowance: amount };
  }

  /** The token, after refusing an amount denominated in another one. No RPC for a listed quote. */
  private async checkedToken(amount: QuoteAmount): Promise<QuoteTokenInfo> {
    const token = this.known ?? findQuoteToken(this.ctx.config, this.address) ?? await this.info();
    requireSameQuote(amount, token);
    return token;
  }
}

/**
 * Refuse an amount whose quote is not `expected`, naming both. Used wherever a
 * request's amount must be in the quote of the curve, pool or launch it goes to.
 *
 * @throws {ArcNowError} `QuoteTokenMismatch`.
 */
export function requireSameQuote(amount: QuoteAmount, expected: QuoteTokenInfo, what = "this"): void {
  if (sameQuote(amount.token, expected)) return;
  throw new ArcNowError({
    code: "QuoteTokenMismatch",
    message:
      `${amount.format()} was passed where ${what} is priced in ${expected.symbol} `
      + `(${expected.address}). An amount of one quote token has no meaning in another, so `
      + `nothing was sent. Build the amount with QuoteAmount.parse(<${expected.symbol} info>, …).`,
    details: { got: amount.token.address, expected: expected.address },
  });
}

function nativeHasNoAllowance(token: QuoteTokenInfo): ArcNowError {
  return new ArcNowError({
    code: "InvalidArgument",
    message:
      `${token.symbol} here is native USDC, paid as msg.value: there is no allowance to read or `
      + "grant, and no approve is ever needed to spend it.",
    details: { quoteToken: token.address },
  });
}
