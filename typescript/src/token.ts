/**
 * One launched token: the ordinary ERC-20 surface, plus the three things about
 * it that are not ordinary.
 *
 * **The token taxes nothing.** It is a plain ERC-20. The only post-graduation
 * fee is charged in native USDC by a v4 hook inside the pool's swaps, on a swap
 * amount, never on a transfer.
 *
 * **Its curve can move any holder's balance, and no allowance is involved.**
 * See {@link Curve.sell}. `approve`, `allowance` and `transferFrom` here are
 * for everybody else — routers, other spenders — and are a different system
 * from the curve's privilege.
 *
 * **After migration the canonical router is auto-approved for every holder.**
 * `allowance(anyone, canonicalRouter)` answers `uint256.max` once the pool is
 * recorded. That address is snapshotted at launch from the migrator registry
 * and cannot be changed by anyone afterwards, because it is the one address
 * that can move holders' balances without being granted anything.
 *
 * @module
 */

import type { Address } from "viem";

import { Bps, Tokens } from "./amounts.js";
import type { ClientContext } from "./client.js";
import { withMappedErrors } from "./errors/map.js";
import type { FeeConfig } from "./fees.js";
import { arcTokenAbi } from "./generated/abi/index.js";

/** Where a token's post-graduation fee is charged, as the registry recorded it at launch. */
export type PoolTaxMode = "None" | "HookFee";

/** A handle on one launched token. Built with `client.token(address)`. */
export class Token {
  private readonly ctx: ClientContext;

  /** The token's address. */
  readonly address: Address;

  constructor(context: ClientContext, address: Address) {
    this.ctx = context;
    this.address = address;
  }

  /**
   * The no-argument reads, grouped by return type.
   *
   * Three narrow helpers rather than one generic one, because a helper that
   * took a `string` function name would need a cast to satisfy viem — and that
   * cast is exactly what stops the compiler noticing when an ABI changes shape
   * under the SDK. These keep the ABI's own literal types all the way through.
   */
  private readText(functionName: "name" | "symbol" | "metadataURI"): Promise<string> {
    return withMappedErrors({ functionName, address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: arcTokenAbi,
        functionName,
      }));
  }

  private readByte(functionName: "decimals" | "poolTaxMode"): Promise<number> {
    return withMappedErrors({ functionName, address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: arcTokenAbi,
        functionName,
      }));
  }

  private readWad(functionName: "totalSupply" | "tradeFeeBps"): Promise<bigint> {
    return withMappedErrors({ functionName, address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: arcTokenAbi,
        functionName,
      }));
  }

  private readAddress(
    functionName: "creator" | "curve" | "migrator" | "migratedPool" | "canonicalRouter",
  ): Promise<Address> {
    return withMappedErrors({ functionName, address: this.address }, () =>
      this.ctx.publicClient.readContract({
        address: this.address,
        abi: arcTokenAbi,
        functionName,
      }));
  }

  /** The token's name. */
  name(): Promise<string> {
    return this.readText("name");
  }

  /** Its ticker symbol. */
  symbol(): Promise<string> {
    return this.readText("symbol");
  }

  /**
   * Always 18 — like every other amount in this system, and like native USDC on
   * Arc. The 6-decimal number in this world belongs to the USDC ERC-20
   * predeploy and to nothing else.
   */
  decimals(): Promise<number> {
    return this.readByte("decimals");
  }

  /** The off-chain metadata document: image, description, links. */
  metadataUri(): Promise<string> {
    return this.readText("metadataURI");
  }

  /** The fixed supply, minted in full at launch. Nothing can mint more. */
  async totalSupply(): Promise<Tokens> {
    return Tokens.fromWad(await this.readWad("totalSupply"));
  }

  /** One account's balance. */
  async balanceOf(account: Address): Promise<Tokens> {
    return withMappedErrors({ functionName: "balanceOf", address: this.address }, async () =>
      Tokens.fromWad(
        await this.ctx.publicClient.readContract({
          address: this.address,
          abi: arcTokenAbi,
          functionName: "balanceOf",
          args: [account],
        }),
      ));
  }

  /**
   * The creator seat: who receives the creator share of every fee.
   *
   * Transferable by its holder, in two steps, so that a creator whose address
   * is blocklisted on Arc has somewhere to go. It carries **no** privilege over
   * the token or the curve: no mint, no pause, no fee switch, no upgrade, and
   * no ability to change the size of its own share.
   */
  creator(): Promise<Address> {
    return this.readAddress("creator");
  }

  /** The bonding curve this token is bound to for life. */
  curve(): Promise<Address> {
    return this.readAddress("curve");
  }

  /** Where this token graduates to. Snapshotted at launch, immutable. */
  migrator(): Promise<Address> {
    return this.readAddress("migrator");
  }

  /**
   * The canonical pool, once the token has migrated. The zero address until
   * then, and it is written exactly once.
   */
  migratedPool(): Promise<Address> {
    return this.readAddress("migratedPool");
  }

  /**
   * The router every holder's allowance answers `uint256.max` for after
   * migration, or the zero address for a venue with no router.
   *
   * The zero address is the ordinary value — Arc testnet's v4 migrator
   * registers none, deliberately — and means the token grants no standing
   * allowance to anybody.
   */
  canonicalRouter(): Promise<Address> {
    return this.readAddress("canonicalRouter");
  }

  /** Whether the token's pool charges the arcnow fee after graduation. */
  async poolTaxMode(): Promise<PoolTaxMode> {
    const mode = await this.readByte("poolTaxMode");
    return mode === 1 ? "HookFee" : "None";
  }

  /** The trade fee written onto this token at launch: 100 bps. */
  async tradeFeeBps(): Promise<Bps> {
    return Bps.of(await this.readWad("tradeFeeBps"));
  }

  /** The five-way fee split snapshotted onto this token. Identical to its curve's. */
  async feeConfig(): Promise<FeeConfig> {
    const config = await withMappedErrors(
      { functionName: "feeConfig", address: this.address },
      () =>
        this.ctx.publicClient.readContract({
          address: this.address,
          abi: arcTokenAbi,
          functionName: "feeConfig",
        }),
    );
    return {
      creatorShareBps: Bps.of(config.creatorShareBps),
      platformShareBps: Bps.of(config.platformShareBps),
      refShareBps: Bps.of(config.refShareBps),
      protocolShareBps: Bps.of(config.protocolShareBps),
      platformRecipient: config.platformRecipient,
      protocolRecipient: config.protocolRecipient,
    };
  }

  /**
   * An ordinary ERC-20 allowance.
   *
   * **Nothing to do with selling.** The curve reads no allowance at all, so a
   * zero here does not stop a holder exiting and a non-zero here is not spent
   * by a sell. This is for routers and other spenders. After migration it
   * answers `uint256.max` for the canonical router over every holder.
   */
  async allowance(owner: Address, spender: Address): Promise<Tokens> {
    return withMappedErrors({ functionName: "allowance", address: this.address }, async () =>
      Tokens.fromWad(
        await this.ctx.publicClient.readContract({
          address: this.address,
          abi: arcTokenAbi,
          functionName: "allowance",
          args: [owner, spender],
        }),
      ));
  }

  /**
   * Approve a spender.
   *
   * **If you are about to sell to the curve, you do not need this.** A sell
   * needs no approval, ever; see {@link Curve.sell}. This exists for the
   * ordinary ERC-20 uses — a router, a bridge, an escrow — and calling it
   * before a sell approves something that will not be spent.
   *
   * Resolves once the transaction is **mined**, like every other write on this
   * SDK, so the allowance is readable the moment this returns. Returning an
   * unmined hash would make `approve(); allowance()` a race that reads zero
   * often enough to look intermittent and rarely enough to ship.
   */
  async approve(spender: Address, amount: Tokens): Promise<`0x${string}`> {
    const { wallet, account } = this.ctx.requireSigner("token.approve");
    await this.ctx.assertChain();
    return withMappedErrors({ functionName: "approve", address: this.address }, async () => {
      const { request } = await this.ctx.publicClient.simulateContract({
        address: this.address,
        abi: arcTokenAbi,
        functionName: "approve",
        args: [spender, amount.wad],
        account,
        chain: this.ctx.chain,
      });
      const txHash = await wallet.writeContract(request);
      await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    });
  }

  /** An ordinary ERC-20 transfer. Resolves once mined. */
  async transfer(to: Address, amount: Tokens): Promise<`0x${string}`> {
    const { wallet, account } = this.ctx.requireSigner("token.transfer");
    await this.ctx.assertChain();
    return withMappedErrors({ functionName: "transfer", address: this.address }, async () => {
      const { request } = await this.ctx.publicClient.simulateContract({
        address: this.address,
        abi: arcTokenAbi,
        functionName: "transfer",
        args: [to, amount.wad],
        account,
        chain: this.ctx.chain,
      });
      const txHash = await wallet.writeContract(request);
      await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
      return txHash;
    });
  }

  /**
   * An ordinary ERC-20 `transferFrom`, spending an allowance the owner granted.
   * Resolves once mined.
   */
  async transferFrom(from: Address, to: Address, amount: Tokens): Promise<`0x${string}`> {
    const { wallet, account } = this.ctx.requireSigner("token.transferFrom");
    await this.ctx.assertChain();
    return withMappedErrors(
      { functionName: "transferFrom", address: this.address },
      async () => {
        const { request } = await this.ctx.publicClient.simulateContract({
          address: this.address,
          abi: arcTokenAbi,
          functionName: "transferFrom",
          args: [from, to, amount.wad],
          account,
          chain: this.ctx.chain,
        });
        const txHash = await wallet.writeContract(request);
        await this.ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
        return txHash;
      },
    );
  }
}
