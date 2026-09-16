/**
 * The client: a network, a transport, and optionally a signer.
 *
 * **Reading needs no key.** A read-only client is constructible from an RPC URL
 * alone and every read method on this SDK works on it. That is not a courtesy —
 * an indexer, a price page and a CLI that only looks at things should not have
 * to hold a key to do their job, and an SDK that demands one teaches people to
 * put keys where they are not needed.
 *
 * **A write on a read-only client fails before any RPC happens**, with
 * {@link ArcNowError} code `ReadOnlyClient`, naming the method and saying to
 * supply a signer. The alternative — building the transaction and letting the
 * node reject it — spends a round trip to produce a worse message.
 *
 * # Every write simulates first, and that is load-bearing twice over
 *
 * Each write method calls `simulateContract` before `writeContract`. The
 * obvious reason is the message: a simulation reverts with decodable data, so
 * a caller gets `SlippageExceeded` with its two amounts rather than a failed
 * receipt with nothing in it.
 *
 * The less obvious reason is **nonce safety**, and it is worth stating because
 * the equivalent Rust SDK had to fix it explicitly. A client that keeps a local
 * nonce counter and advances it *before* broadcast burns a nonce whenever a
 * transaction fails while being filled — the chain never sees that nonce, so
 * every later transaction from the same address sits behind a gap nothing
 * closes. It neither succeeds nor fails; it simply never mines. And reverts are
 * routine here: a slippage floor missed, a deadline passed, a curve that
 * graduated a block ago.
 *
 * This SDK is safe from that for two independent reasons, and the fork suite
 * pins both ("a revert does not wedge the client"):
 *
 * 1. **A revert surfaces from `simulateContract`, which is an `eth_call`.** It
 *    happens strictly upstream of the nonce — nothing is signed, nothing is
 *    broadcast, and `prepareTransactionRequest` is never entered. This holds
 *    even for a caller who opts into viem's cached nonce manager, which was
 *    verified by doing exactly that and watching the suite still pass.
 * 2. **viem does not cache a nonce by default.** `privateKeyToAccount(key)`
 *    leaves `nonceManager` undefined, and `prepareTransactionRequest` then
 *    takes its `!nonceManager` branch and reads
 *    `eth_getTransactionCount(address, "pending")` per transaction. There is no
 *    local counter to go stale.
 *
 * If you opt into a cached nonce manager *and* send transactions outside this
 * SDK, the first reason stops covering you and the second no longer applies —
 * that is your tradeoff to make, and the cost of the safe default is one
 * `eth_getTransactionCount` per transaction.
 *
 * @module
 */

import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";

import type { QuoteTokenInfo } from "./amounts.js";
import { Curve } from "./curve.js";
import { ArcNowError } from "./errors/error.js";
import { withMappedErrors } from "./errors/map.js";
import { Launchpad } from "./launchpad.js";
import { MigratorRegistry } from "./migrator-registry.js";
import type { NetworkConfig, NetworkInput } from "./networks.js";
import { MULTICALL3_ADDRESS, resolveNetwork, toViemChain } from "./networks.js";
import { PlatformRegistry } from "./platform-registry.js";
import { Pool } from "./pool.js";
import { QuoteRegistry } from "./quote-registry.js";
import { QuoteToken, resolveQuoteTokenInfo } from "./quote-token.js";
import { Token } from "./token.js";
import { Trade } from "./trade.js";

/** How to build a client. */
export interface ArcNowClientOptions {
  /**
   * A preset name (`"arc-testnet"`), or a custom deployment
   * `{ rpcUrl, chainId, contracts }`.
   *
   * A custom deployment is a first-class path, not a fallback. `"arc-mainnet"`
   * resolves and then refuses, naming the contracts that are missing.
   */
  readonly network: NetworkInput;
  /** Override the preset's RPC endpoint — a private node, a local fork. */
  readonly rpcUrl?: string | undefined;
  /**
   * A signer. A local account from `privateKeyToAccount`, or a plain address
   * for a JSON-RPC account the node signs for (a browser wallet, or an
   * impersonated account on a fork).
   *
   * Leave it out for a read-only client.
   */
  readonly account?: Account | Address | undefined;
  /** A viem transport, when `http(rpcUrl)` is not what you want. */
  readonly transport?: Transport | undefined;
  /**
   * Where Multicall3 lives, for batching a curve's whole state into one round
   * trip. Defaults to the canonical predeploy address, which Arc has. Pass
   * `null` to never batch — the reads then go out in parallel instead, which is
   * correct but chattier.
   */
  readonly multicallAddress?: Address | null | undefined;
}

/**
 * Shared plumbing, handed to each handle.
 *
 * Internal, but exported because the handles are separate modules and this is
 * their common shape. Nothing here is part of the promised API.
 */
export interface ClientContext {
  readonly config: NetworkConfig;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient | undefined;
  readonly account: Account | Address | undefined;
  readonly multicallAddress: Address | undefined;
  /** The signer, or a `ReadOnlyClient` error naming what the caller was trying to do. */
  requireSigner(what: string): { wallet: WalletClient; account: Account | Address };
  /** Assert once that the endpoint is the chain this client was configured for. */
  assertChain(): Promise<void>;
  /**
   * A quote token's metadata: the network's `quoteTokens` with no RPC, otherwise
   * one cached on-chain read. See `resolveQuoteTokenInfo`.
   */
  quoteTokenInfo(address: Address): Promise<QuoteTokenInfo>;
}

/**
 * A connected arcnow.io client.
 *
 * @example Read-only
 * ```ts
 * const client = createArcNowClient({ network: "arc-testnet" });
 * const state = await client.curve(address).state();
 * console.log(`${state.progressBps.percentOfFee()}% of the way to graduation`);
 * ```
 *
 * @example With a signer
 * ```ts
 * const client = createArcNowClient({
 *   network: "arc-testnet",
 *   account: privateKeyToAccount(process.env.ARCNOW_PRIVATE_KEY as `0x${string}`),
 * });
 * ```
 */
export class ArcNowClient {
  /** The resolved deployment: chain id, endpoint, addresses, venues. */
  readonly config: NetworkConfig;

  /** The underlying viem public client, for anything this SDK does not wrap. */
  readonly publicClient: PublicClient;

  /** The underlying viem wallet client, when a signer was supplied. */
  readonly walletClient: WalletClient | undefined;

  /** The launchpad: fees, quotes, address prediction, launching. */
  readonly launchpad: Launchpad;

  /** The platform registry: the protocol's share, platform lookup, registration. */
  readonly platforms: PlatformRegistry;

  /**
   * The protocol's list of graduation targets — what a creator may pass as
   * `LaunchParams.migrator`, and what each of them would mean.
   */
  readonly migrators: MigratorRegistry;

  /**
   * The quote registry: which quote tokens a launch may use — native USDC and
   * the allowlisted ERC-20s — and each one's launch fee.
   */
  readonly quoteRegistry: QuoteRegistry;

  private readonly context: ClientContext;

  private constructor(context: ClientContext) {
    this.context = context;
    this.config = context.config;
    this.publicClient = context.publicClient;
    this.walletClient = context.walletClient;
    this.launchpad = new Launchpad(context);
    this.platforms = new PlatformRegistry(context);
    this.migrators = new MigratorRegistry(context, context.config.contracts.migratorRegistry);
    this.quoteRegistry = new QuoteRegistry(context);
  }

  /** Build a client. The same thing {@link createArcNowClient} does. */
  static create(options: ArcNowClientOptions): ArcNowClient {
    const config = resolveNetwork(options.network);
    const rpcUrl = options.rpcUrl ?? config.rpcUrl;
    const chain = toViemChain({ ...config, rpcUrl });
    const transport = options.transport ?? http(rpcUrl);

    const publicClient = createPublicClient({ chain, transport });
    const walletClient
      = options.account === undefined
        ? undefined
        : createWalletClient({ account: options.account, chain, transport });

    const multicallAddress
      = options.multicallAddress === null
        ? undefined
        : (options.multicallAddress ?? MULTICALL3_ADDRESS);

    let chainChecked: Promise<void> | undefined;

    const context: ClientContext = {
      config: { ...config, rpcUrl },
      chain,
      publicClient,
      walletClient,
      account: options.account,
      multicallAddress,
      requireSigner(what: string) {
        if (!walletClient || options.account === undefined) {
          throw new ArcNowError({
            code: "ReadOnlyClient",
            message:
              `${what} is a write and this client has no signer, so there is nothing to `
              + "sign with. Rebuild it with `account:` — a local account from viem's "
              + "privateKeyToAccount, or a plain address for a wallet or node that signs "
              + "on your behalf. Every read method works without one, which is why the "
              + "signer is optional in the first place.",
            details: { method: what },
          });
        }
        return { wallet: walletClient, account: options.account };
      },
      async assertChain() {
        chainChecked ??= (async () => {
          const reported = await withMappedErrors({ functionName: "eth_chainId" }, () =>
            publicClient.getChainId());
          if (reported !== config.chainId) {
            throw new ArcNowError({
              code: "ChainIdMismatch",
              message:
                `this client is configured for ${config.name} (chain ${config.chainId}) and `
                + `the endpoint at ${rpcUrl} reports chain ${reported}. Every address this `
                + "client holds belongs to the chain it was configured for, so sending to "
                + "them here would call whatever happens to sit at those addresses on a "
                + "different chain. Point at the right endpoint, or build the client with "
                + "the addresses for this one.",
              details: { expected: config.chainId, reported, rpcUrl },
            });
          }
        })();
        await chainChecked;
      },
      quoteTokenInfo(address: Address) {
        return resolveQuoteTokenInfo(context, address);
      },
    };

    return new ArcNowClient(context);
  }

  /** A fluent builder, for callers who prefer one. */
  static builder(): ArcNowClientBuilder {
    return new ArcNowClientBuilder();
  }

  /** A handle on one bonding curve: state, quotes, buy, sell, migrate, withdraw. */
  curve(address: Address): Curve {
    return new Curve(this.context, address);
  }

  /**
   * A handle on one quote token — native USDC or an allowlisted ERC-20 — for
   * balances, allowances and the exact approve an ERC-20 spend needs.
   */
  quoteToken(token: Address | QuoteTokenInfo): QuoteToken {
    return new QuoteToken(this.context, token);
  }

  /**
   * A quote token's symbol, name and decimals: from the network's `quoteTokens`
   * with no RPC when listed, otherwise one Multicall3 read cached for the process.
   */
  quoteTokenInfo(address: Address): Promise<QuoteTokenInfo> {
    return this.context.quoteTokenInfo(address);
  }

  /** A handle on one launched token: the ordinary ERC-20 surface, plus its curve and pool. */
  token(address: Address): Token {
    return new Token(this.context, address);
  }

  /**
   * A handle that trades one token **wherever it currently trades** — its
   * bonding curve before graduation, its Uniswap v4 pool after.
   *
   * The front door. A token's market moves once, irreversibly, in the middle of
   * its life, and an application that reached for `client.curve(...)` alone
   * would be correct for only half of every token's existence.
   */
  trade(tokenAddress: Address): Trade {
    return new Trade(this.context, tokenAddress);
  }

  /**
   * A handle on one graduated token's v4 pool.
   *
   * Built from the **token**, because a v4 pool has no address of its own: it
   * is a `PoolId` inside one PoolManager's storage. Use {@link ArcNowClient.trade}
   * unless you specifically want the pool side — its key, its manager, whether
   * any router on this chain can reach it, and the router approval a sell needs.
   */
  pool(tokenAddress: Address): Pool {
    return new Pool(this.context, tokenAddress);
  }

  /** True when this client can sign. */
  get canWrite(): boolean {
    return this.walletClient !== undefined;
  }

  /**
   * Check that the endpoint really is the chain this client was configured for.
   *
   * Done automatically before every write. Call it yourself after building a
   * read-only client if you would rather find out now than on the first read
   * that returns something surprising.
   */
  async verifyChain(): Promise<void> {
    await this.context.assertChain();
  }
}

/**
 * The fluent form of {@link ArcNowClient.create}.
 *
 * @example
 * ```ts
 * const client = ArcNowClient.builder()
 *   .network("arc-testnet")
 *   .rpcUrl("http://127.0.0.1:8545")
 *   .signer(account)
 *   .build();
 * ```
 */
export class ArcNowClientBuilder {
  private options: Partial<ArcNowClientOptions> = {};

  /** The network preset, or a custom `{ rpcUrl, chainId, contracts }`. */
  network(network: NetworkInput): this {
    this.options = { ...this.options, network };
    return this;
  }

  /** Override the endpoint. */
  rpcUrl(rpcUrl: string): this {
    this.options = { ...this.options, rpcUrl };
    return this;
  }

  /** Supply a signer. Without one the client is read-only and says so when you write. */
  signer(account: Account | Address): this {
    this.options = { ...this.options, account };
    return this;
  }

  /** Supply a viem transport instead of plain HTTP. */
  transport(transport: Transport): this {
    this.options = { ...this.options, transport };
    return this;
  }

  /** Where Multicall3 lives, or `null` to read without batching. */
  multicall(address: Address | null): this {
    this.options = { ...this.options, multicallAddress: address };
    return this;
  }

  /** Build it. */
  build(): ArcNowClient {
    if (this.options.network === undefined) {
      throw new ArcNowError({
        code: "InvalidArgument",
        message:
          "a client needs a network. Call .network(\"arc-testnet\"), or pass your own "
          + "{ rpcUrl, chainId, contracts } — a custom deployment is a first-class path "
          + "here, not a fallback.",
      });
    }
    return ArcNowClient.create(this.options as ArcNowClientOptions);
  }
}

/** Build a client. The short form. */
export function createArcNowClient(options: ArcNowClientOptions): ArcNowClient {
  return ArcNowClient.create(options);
}
