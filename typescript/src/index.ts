/**
 * `@arcnow/sdk` — launch, trade and read arcnow.io bonding-curve tokens on Arc.
 *
 * Talks to the contracts over JSON-RPC. No arcnow.io backend is involved, and
 * none is required: everything this package does, it does by calling the
 * deployed contracts directly.
 *
 * **The one fact that breaks everything if you get it wrong.** On Arc, USDC
 * *is* the native gas currency and `msg.value` is an **18-decimal** integer.
 * The USDC ERC-20 interface predeploy at `0x3600…0000` is the same asset
 * reporting **6** decimals; it does not pay for gas and no arcnow.io contract
 * touches it. The two raw representations of one dollar differ by `1e12`. This
 * SDK will not let you mix them: see {@link Usdc} and {@link UsdcErc20}.
 *
 * @example
 * ```ts
 * import { createArcNowClient, Usdc, Tokens, Deadline, Bps } from "@arcnow/sdk";
 *
 * const client = createArcNowClient({ network: "arc-testnet" });
 * const curve = client.curve("0x…");
 *
 * const state = await curve.state();
 * console.log(`${state.realReserve} of ${state.target} USDC raised`);
 *
 * const quote = await curve.quoteBuy(Usdc.parse("25"));
 * console.log(`25 USDC buys ${quote.tokensOut} tokens, fee ${quote.fee}`);
 * ```
 *
 * @module
 */

export {
  AmountParseError,
  Bps,
  MAX_QUOTE_DECIMALS,
  NATIVE_QUOTE,
  NATIVE_USDC,
  QuoteAmount,
  quoteScaleOf,
  quoteTokenInfo,
  sameQuote,
  Tokens,
  Usdc,
  UsdcErc20,
  USDC_ERC20_DECIMALS,
  USDC_ERC20_SCALE,
  WAD,
  WAD_DECIMALS,
} from "./amounts.js";
export type { QuoteTokenInfo } from "./amounts.js";

export {
  allowanceOverride,
  erc20GasLimit,
  POOL_QUOTE_TRANSFER_GAS_HEADROOM_MIN,
  QUOTE_TRANSFER_GAS_HEADROOM_BPS,
  QUOTE_TRANSFER_GAS_HEADROOM_MIN,
  QuoteToken,
  requireSameQuote,
  withPoolQuoteTransferHeadroom,
  withQuoteTransferHeadroom,
} from "./quote-token.js";
export type { AllowanceOutcome, SpendState } from "./quote-token.js";
export { QuoteRegistry } from "./quote-registry.js";
export type { QuoteRegistration, QuoteRegistryEntry } from "./quote-registry.js";

export { ArcNowClient, ArcNowClientBuilder, createArcNowClient } from "./client.js";
export type { ArcNowClientOptions, ClientContext } from "./client.js";

export { Curve, curveSnapshotOf } from "./curve.js";
export {
  assertCurveVersion,
  assertHookVersion,
  assertLaunchpadVersion,
  assertPlatformVersion,
  assertQuoteRegistryVersion,
  assertRegistryVersion,
  assertV4MigratorVersion,
} from "./curve-version.js";
export { CurveMath } from "./curve-math.js";
export type {
  CurveParams,
  CurveSnapshot,
  RawBuyQuote,
  RawLaunchQuote,
  RawSellQuote,
} from "./curve-math.js";
export {
  ARC_TOKEN_ALLOWANCE_SLOT,
  arcTokenAllowanceSlot,
  buyFeeFromQuoteIn,
  erc20AllowanceSlot,
  feesDistributedIn,
  Pool,
  quoteFillFromLogs,
  sellFeeFromQuoteOut,
  sellQuoteOutFromFee,
  unpackBalanceDelta,
} from "./pool.js";
export type {
  BalanceDelta,
  PoolBuyQuote,
  PoolBuyRequest,
  PoolFillSource,
  PoolKeyStruct,
  PoolSellQuote,
  PoolSellRequest,
  PoolTradeResult,
  QuoteFrom,
} from "./pool.js";
export { Trade } from "./trade.js";
export type {
  CurveBuyQuote,
  CurveBuyResult,
  CurveSellQuote,
  CurveSellResult,
  TradeBuyQuote,
  TradeBuyResult,
  TradeBuyRequest,
  TradeSellQuote,
  TradeSellRequest,
  TradeSellResult,
  Venue,
} from "./trade.js";
export { GRADUATION_GAS_FLOOR, GRADUATION_GAS_LIMIT, Launchpad } from "./launchpad.js";
export { MigratorRegistry } from "./migrator-registry.js";
export type { MigratorInfo } from "./migrator-registry.js";
export { PlatformRegistry } from "./platform-registry.js";
export type { PlatformSettings, RegisterPlatformResult } from "./platform-registry.js";
export { Token } from "./token.js";
export type { PoolTaxMode } from "./token.js";

export { CurveTemplate } from "./curve-template.js";
export type {
  CurveTemplate as CurveTemplateParams,
  EncodedCurveParameters,
} from "./curve-template.js";

export { Deadline } from "./deadline.js";
export { minQuoteOutFromQuote, minTokensOutFromQuote } from "./slippage.js";

export {
  BPS_DENOMINATOR,
  MAX_PLATFORM_ALLOWANCE_BPS,
  TRADE_FEE_BPS,
  platformShareBps,
  totalOf,
  validateNewPlatform,
} from "./fees.js";
export type { FeeConfig, FeeSplit, NewPlatform } from "./fees.js";

export {
  ArcNowError,
  decodeRevertData,
  ERROR_REGISTRY,
  ERROR_STRING_SELECTOR,
  errorSignature,
  isArcNowError,
  lookupSelector,
  mapError,
  PANIC_SELECTOR,
  SDK_CODES_THAT_ARE_CONTRACT_ERRORS,
  SDK_ERROR_CODES,
  selectorOf,
  withMappedErrors,
  WRAPPED_ERROR_SELECTOR,
} from "./errors/index.js";
export type {
  ArcNowErrorCode,
  ArcNowErrorOptions,
  DecodedRevert,
  ErrorContext,
  RegisteredError,
  SdkErrorCode,
  WrappedLayer,
} from "./errors/index.js";

export {
  findQuoteToken,
  MULTICALL3_ADDRESS,
  quoteAllowanceSlot,
  NETWORKS,
  rawNetwork,
  REQUIRED_CONTRACTS,
  requireContract,
  requireV4Router,
  resolveNetwork,
  toViemChain,
} from "./networks.js";
export type {
  ContractAddresses,
  CustomNetwork,
  Network,
  NetworkConfig,
  NetworkInput,
  RequiredContract,
  V4Deployment,
  VenueFlags,
} from "./networks.js";

export type {
  BuyQuote,
  BuyRequest,
  BuyResult,
  CurveState,
  LaunchParams,
  LaunchQuote,
  LaunchResult,
  MigrateResult,
  SellQuote,
  SellRequest,
  SellResult,
} from "./types.js";

/**
 * The pinned ABIs, `as const`, for anyone who wants to talk to the contracts
 * directly with viem rather than through this SDK's handles.
 *
 * They are generated copies of `arcnow-io/contracts`' exported artefacts at the
 * commit `pins.json` records, and they are what this package encodes every call
 * with. Never edit them in place: the maintainers' pin gate hashes them.
 */
export * as abi from "./generated/abi/index.js";
