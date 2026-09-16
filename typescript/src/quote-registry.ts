/**
 * The quote registry: the protocol's allowlist of quote tokens a launch may use,
 * and each one's flat launch fee.
 *
 * Native USDC (`address(0)`) is registered at construction and can never be
 * removed; the protocol admin registers ERC-20s such as EURC. A curve snapshots
 * its quote at launch, so **deregistering a quote stops new launches only** —
 * every curve already priced in it keeps trading.
 *
 * `isQuoteToken` means *active*. `quoteInfo` reverts `QuoteTokenNotRegistered`
 * for a quote that was never registered, and answers `active: false` for one
 * that was deregistered.
 *
 * @module
 */

import type { Address } from "viem";

import type { QuoteTokenInfo } from "./amounts.js";
import { NATIVE_QUOTE, QuoteAmount, quoteTokenInfo } from "./amounts.js";
import type { ClientContext } from "./client.js";
import { assertQuoteRegistryVersion } from "./curve-version.js";
import { withMappedErrors } from "./errors/map.js";
import { launchpadAbi, quoteRegistryAbi } from "./generated/abi/index.js";
import { findQuoteToken, requireContract } from "./networks.js";
import { rememberQuoteTokenInfo, resolveQuoteTokenInfo } from "./quote-token.js";

/** One registered quote, as the registry records it. */
export interface QuoteRegistration {
  /** Its decimals, read by the registry once at registration. */
  readonly decimals: number;
  /** The flat fee to launch a token in this quote, in this quote. */
  readonly launchFee: QuoteAmount;
  /** True while launches may use it. */
  readonly active: boolean;
}

/** One quote in {@link QuoteRegistry.list}. */
export interface QuoteRegistryEntry extends Omit<QuoteRegistration, "decimals"> {
  /** The quote's metadata. */
  readonly token: QuoteTokenInfo;
}

/**
 * The registry's address, memoised per client. From the network's
 * `contracts.quoteRegistry` when it names one, otherwise asked of the launchpad
 * once (`quoteTokenRegistry()` is immutable). A failed read is evicted.
 */
const registryByClient = new WeakMap<ClientContext, Promise<Address>>();

export function quoteRegistryAddress(ctx: ClientContext): Promise<Address> {
  const configured = ctx.config.contracts.quoteRegistry;
  // null or absent (a JSON custom network may carry null) means "ask the launchpad".
  if (configured !== undefined && configured !== null && !/^0x0{40}$/i.test(configured)) {
    return Promise.resolve(configured.toLowerCase() as Address);
  }
  const cached = registryByClient.get(ctx);
  if (cached !== undefined) return cached;
  const launchpad = requireContract(ctx.config, "launchpad");
  const pending = withMappedErrors({ functionName: "quoteTokenRegistry", address: launchpad }, async () =>
    (await ctx.publicClient.readContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "quoteTokenRegistry",
    })).toLowerCase() as Address);
  registryByClient.set(ctx, pending);
  pending.catch(() => {
    if (registryByClient.get(ctx) === pending) registryByClient.delete(ctx);
  });
  return pending;
}

/** The quote's metadata with the registry's decimals, which are the ones the curve scales by. */
async function registeredToken(
  ctx: ClientContext,
  quote: Address,
  decimals: number,
): Promise<QuoteTokenInfo> {
  const metadata = await resolveQuoteTokenInfo(ctx, quote);
  return metadata.decimals === decimals ? metadata : quoteTokenInfo({ ...metadata, decimals });
}

/** Read and write the quote registry. Reached as `client.quoteRegistry`. */
export class QuoteRegistry {
  private readonly ctx: ClientContext;

  constructor(context: ClientContext) {
    this.ctx = context;
  }

  /** The registry's address; see {@link quoteRegistryAddress}. */
  address(): Promise<Address> {
    return quoteRegistryAddress(this.ctx);
  }

  /**
   * The registry's `VERSION()`, refused unless `arcnow/quote-registry@1.x.x`.
   *
   * @throws {ArcNowError} `UnknownCurveVersion` with `details.component`.
   */
  async version(): Promise<string> {
    const address = await this.address();
    const version = await withMappedErrors({ functionName: "VERSION", address }, () =>
      this.ctx.publicClient.readContract({ address, abi: quoteRegistryAbi, functionName: "VERSION" }));
    assertQuoteRegistryVersion(version, `the quote registry at ${address}`, address);
    return version;
  }

  /** How many quotes were ever registered, active or not. */
  async count(): Promise<bigint> {
    const address = await this.address();
    return withMappedErrors({ functionName: "quoteTokenCount", address }, () =>
      this.ctx.publicClient.readContract({ address, abi: quoteRegistryAbi, functionName: "quoteTokenCount" }));
  }

  /** The `index`-th registered quote. */
  async at(index: bigint | number): Promise<Address> {
    const address = await this.address();
    return withMappedErrors({ functionName: "quoteTokenAt", address }, async () =>
      (await this.ctx.publicClient.readContract({
        address,
        abi: quoteRegistryAbi,
        functionName: "quoteTokenAt",
        args: [BigInt(index)],
      })).toLowerCase() as Address);
  }

  /** True when `quote` is registered **and active**: a launch may use it. */
  async isQuoteToken(quote: Address): Promise<boolean> {
    const address = await this.address();
    return withMappedErrors({ functionName: "isQuoteToken", address }, () =>
      this.ctx.publicClient.readContract({
        address,
        abi: quoteRegistryAbi,
        functionName: "isQuoteToken",
        args: [quote],
      }));
  }

  /**
   * The registry's record of `quote`, with its launch fee in that quote.
   *
   * @throws {ArcNowError} `QuoteTokenNotRegistered` for a quote never registered.
   */
  async info(quote: Address = NATIVE_QUOTE): Promise<QuoteRegistration> {
    const address = await this.address();
    const [decimals, launchFeeWad, active] = await withMappedErrors({ functionName: "quoteInfo", address }, () =>
      this.ctx.publicClient.readContract({
        address,
        abi: quoteRegistryAbi,
        functionName: "quoteInfo",
        args: [quote],
      }));
    const token = await registeredToken(this.ctx, quote, decimals);
    return { decimals, launchFee: QuoteAmount.fromWad(token, launchFeeWad), active };
  }

  /**
   * Every registered quote, active or not, with metadata and launch fee — in at
   * most **three** `eth_call`s: `VERSION` and the count, every address, then
   * every record together with symbol and name for any quote the network's
   * `quoteTokens` does not describe. Metadata learned here is cached for the
   * process.
   *
   * @throws {ArcNowError} `UnknownCurveVersion` for a registry of another version.
   */
  async list(): Promise<readonly QuoteRegistryEntry[]> {
    const address = await this.address();
    const multicallAddress = this.ctx.multicallAddress;
    if (multicallAddress === undefined) {
      await this.version();
      const total = await this.count();
      const quotes = await Promise.all(Array.from({ length: Number(total) }, (_, i) => this.at(i)));
      return Promise.all(quotes.map(async (quote) => {
        const record = await this.info(quote);
        const { launchFee, active } = record;
        return { token: launchFee.token, launchFee, active };
      }));
    }
    const registry = { address, abi: quoteRegistryAbi } as const;
    return withMappedErrors({ functionName: "list", address }, async () => {
      const [version, total] = await this.ctx.publicClient.multicall({
        contracts: [
          { ...registry, functionName: "VERSION" },
          { ...registry, functionName: "quoteTokenCount" },
        ],
        allowFailure: false,
        multicallAddress,
      });
      assertQuoteRegistryVersion(version, `the quote registry at ${address}`, address);
      if (total === 0n) return [];

      const quotes = (await this.ctx.publicClient.multicall({
        contracts: Array.from({ length: Number(total) }, (_, i) => ({
          ...registry,
          functionName: "quoteTokenAt" as const,
          args: [BigInt(i)] as const,
        })),
        allowFailure: false,
        multicallAddress,
      })).map((quote) => quote.toLowerCase() as Address);

      const unlisted = quotes.filter((quote) =>
        findQuoteToken(this.ctx.config, quote) === undefined);
      const erc20 = [
        { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
        { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
      ] as const;
      const results = await this.ctx.publicClient.multicall({
        contracts: [
          ...quotes.map((quote) => ({ ...registry, functionName: "quoteInfo" as const, args: [quote] as const })),
          ...unlisted.flatMap((quote) => [
            { address: quote, abi: erc20, functionName: "symbol" as const },
            { address: quote, abi: erc20, functionName: "name" as const },
          ]),
        ],
        allowFailure: false,
        multicallAddress,
      });

      return quotes.map((quote, i) => {
        const [decimals, launchFeeWad, active] = results[i] as readonly [number, bigint, boolean];
        const listed = findQuoteToken(this.ctx.config, quote);
        let token: QuoteTokenInfo;
        if (listed !== undefined) {
          token = listed.decimals === decimals ? listed : quoteTokenInfo({ ...listed, decimals });
        } else {
          const at = quotes.length + 2 * unlisted.indexOf(quote);
          token = quoteTokenInfo({
            address: quote,
            symbol: results[at] as string,
            name: results[at + 1] as string,
            decimals,
          });
          rememberQuoteTokenInfo(this.ctx, token);
        }
        return { token, launchFee: QuoteAmount.fromWad(token, launchFeeWad), active };
      });
    });
  }
}
