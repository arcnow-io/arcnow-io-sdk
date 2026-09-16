/**
 * What to do about each revert.
 *
 * **The rule for every sentence in this file: say what to do, not what
 * happened.** `CurveGraduated` already says what happened; a caller needs to
 * know the curve is finished for good and where the token trades now. The
 * decoded parameters stay on {@link ArcNowError.args} so a UI can render the
 * numbers; this is the prose that goes next to them.
 *
 * Keyed by canonical signature where two errors share a name — `BondingCurve`'s
 * `NothingToWithdraw()` and `ArcNowFeeHook`'s `NothingToWithdraw(address)` are
 * different selectors and different situations — and by bare name otherwise.
 *
 * @module
 */

import type { QuoteTokenInfo } from "../amounts.js";
import { Usdc, Tokens } from "../amounts.js";

/** Extra facts the thrower knows and the revert data does not carry. */
export interface ErrorContext {
  /** The flat launch fee, when a launch is what reverted. */
  launchFee?: Usdc | undefined;
  /** The initial buy the caller asked for, when a launch is what reverted. */
  initialBuy?: Usdc | undefined;
  /** The contract the call was addressed to. */
  address?: string | undefined;
  /** The function that was called. */
  functionName?: string | undefined;
  /**
   * The quote token the call pays fee shares in. On an ERC-20 quote an empty
   * revert is the fee-share gas guard, and is named for it.
   */
  quoteToken?: QuoteTokenInfo | undefined;
  /** The gas limit the call was simulated or sent with, when one was set. */
  gasLimit?: bigint | undefined;
}

const wadUsdc = (value: unknown): string =>
  typeof value === "bigint" ? Usdc.fromWad(value).toString() : String(value);

const wadTokens = (value: unknown): string =>
  typeof value === "bigint" ? Tokens.fromWad(value).toString() : String(value);

const plain = (value: unknown): string => String(value);

type Args = Record<string, unknown>;
type Message = (args: Args, context: ErrorContext) => string;

/**
 * The table. Every entry is one or two sentences: the consequence, then the
 * action.
 */
const MESSAGES: Record<string, Message> = {
  /* ------------------------------------------------------------------ *
   * Launchpad
   * ------------------------------------------------------------------ */

  "IncorrectPayment": (args, context) => {
    const expected = wadUsdc(args.expectedWad);
    const actual = wadUsdc(args.actualWad);
    const breakdown
      = context.launchFee && context.initialBuy
        ? ` (${context.launchFee.toString()} fee + ${context.initialBuy.toString()} initial buy)`
        : " (the flat launch fee plus whatever initial buy you asked for)";
    return (
      `a launch costs exactly ${expected} USDC${breakdown} and this sent ${actual}. `
      + "The launchpad takes exact payment, not at-least: it has no refund path and will "
      + "not strand your change. Call quoteLaunch with the same params and send the "
      + "totalCost it reports."
    );
  },

  "InvalidLaunchParameters": () =>
    "the launch needs a name, a symbol and a metadata URI, and one of them is empty. "
    + "The metadata URI is where every UI reads the token's image and description from; "
    + "a launch without one produces a token nothing can display.",

  "PlatformNotRegistered": (args) =>
    `the platform ${plain(args.platform)} is not live in the registry, so no launch can `
    + "name it. This is checked at inclusion, not at signing — a platform deregistered "
    + "while your transaction sat in the mempool stops being launchable mid-flight. Use "
    + "the network's arcnowPlatform, or check isPlatform before you sign.",

  "MigratorNotRegistered": (args) =>
    `the migrator ${plain(args.migrator)} is not in the protocol's registry, and a launch `
    + "may only pick a graduation target from that list — the alternative is a creator "
    + "pointing their own buyers' liquidity at an address they control. Pass no migrator "
    + "at all to take the platform's default, which is what almost every launch does.",

  "TokenAddressMismatch": (args) =>
    `the token landed at ${plain(args.deployed)} and the curve was built around `
    + `${plain(args.predicted)}. The launch aborted rather than produce a curve bound to `
    + "an address with no token at it. This is unreachable in practice: if you are seeing "
    + "it, something deployed to your CREATE2 salt between the prediction and the launch. "
    + "Retry; your launch nonce has not moved.",

  "CurveAddressMismatch": (args) =>
    `the curve landed at ${plain(args.deployed)} and the token was bound to `
    + `${plain(args.predicted)}. The launch aborted rather than mint a token nobody could `
    + "ever sell. Unreachable in practice; retry, your launch nonce has not moved.",

  "NoFeesToCollect": () =>
    "there are no accrued launch fees to push. collectLaunchFees is permissionless and "
    + "can only ever pay the launchpad's immutable feeRecipient, so there is nothing to "
    + "fix here — somebody already collected.",

  /* ------------------------------------------------------------------ *
   * Trading
   * ------------------------------------------------------------------ */

  // No figure for the target, deliberately. This message used to name one -- "50,000
  // USDC on the shipped template" -- and a platform admin changed its template, so
  // the sentence shown to users was wrong by a factor of 1000 while every test that
  // asserted it still passed. A target is per-curve: it is snapshotted from the
  // platform's template at launch and a curve keeps it for life, so two tokens on the
  // same chain can have different ones and neither is "the" target. The only correct
  // answer is the curve's own, and the message says where to read it.
  "CurveGraduated": () =>
    "this curve reached its graduation target and stopped trading permanently. "
    + "Graduation is terminal: no buy, no sell and no quote will ever succeed on it "
    + "again. The target itself is this curve's own, snapshotted from its platform's "
    + "template at launch — curve.state().target, next to progressBps. Trade the token "
    + "at its graduation venue instead: curve.state().migrator says which one, chosen "
    + "at launch and immutable.",

  "NotGraduated": () =>
    "migrate() is only callable once the curve has collected its target in real reserve, "
    + "and this one has not. Nobody needs to poll for it: the graduating buy attempts the "
    + "migration itself, in the same transaction. Read state().progressBps to see how far "
    + "off it is.",

  "AlreadyMigrated": () =>
    "the assets have already been forwarded to the migrator, which is the normal and good "
    + "outcome: the graduating buy migrated the curve in its own transaction. migrate() is "
    + "the retry path, not the normal one — it only stays open when the instant migration "
    + "failed, and this one did not. Nothing to do.",

  "ZeroAmount": () =>
    "a zero-value buy or a zero-token sell is refused rather than treated as a no-op, so "
    + "that an integration bug surfaces here instead of as an event stream full of empty "
    + "trades. Check the amount you computed: something upstream produced zero.",

  "DeadlineExpired": (args) =>
    `your deadline was ${plain(args.deadline)} and the block that included this was at `
    + `${plain(args.timestamp)}: the transaction sat too long and the curve refused to `
    + "fill it at a price you agreed to that far back. Re-quote and resend with a fresh "
    + "Deadline.inMinutes(5). If you keep landing here, you are underpaying for gas.",

  "SlippageExceeded": (args, context) => {
    // The two amounts are TOKENS on a buy and USDC on a sell, and the revert
    // data carries nothing that says which. They are printed raw, as 18-decimal
    // integers, rather than rendered in a denomination this message would be
    // guessing at: a figure labelled "USDC" that was really a token count is
    // worse than an unlabelled integer, because it looks answered.
    const side
      = context.functionName === "buy"
        ? " (token amounts, 18 decimals: this was a buy)"
        : context.functionName === "sell"
          ? " (USDC amounts, 18 decimals: this was a sell)"
          : " (raw 18-decimal integers — tokens on a buy, USDC on a sell; the revert data "
            + "does not say which, so they are not rendered as either)";
    return `the fill moved to ${plain(args.actualOutWad)} against your floor of `
      + `${plain(args.minOutWad)}${side}. Re-quote and retry: the curve's price rises `
      + "across your own order, so a larger order fills worse than the spot price suggests, "
      + "and somebody else's trade in between moves it further. Widen the floor with "
      + "minTokensOutFromQuote(quote, toleranceBps) rather than passing zero — zero on a "
      + "public mempool is a donation.";
  },

  "InsufficientTokenBalance": (args) =>
    `${plain(args.seller)} holds ${wadTokens(args.balance)} tokens and tried to sell `
    + `${wadTokens(args.amount)}. **No approval is involved here.** The curve pulls tokens `
    + "through a privileged path that reads no allowance at all, so a caller reaching for "
    + "approve() at this point is fixing the wrong thing. Sell what you hold: read "
    + "token.balanceOf(seller) and pass that.",

  "ExceedsTokensSold": (args) =>
    `the curve believes ${wadTokens(args.tokensSoldWad)} tokens are outstanding and this `
    + `sell offered ${wadTokens(args.amountWad)}. This guards an accounting bug rather `
    + "than a user and is unreachable through the token, which cannot mint. If you have "
    + "hit it, stop and report it — do not retry with a smaller amount.",

  "NothingToWithdraw": () =>
    "you have no deferred credit on this curve. A credit only exists when a payout could "
    + "not be delivered — a blocklisted address, or a receive() that wanted more gas than "
    + "the 30,000 stipend. Check pendingWithdrawal(account) first; a zero there means the "
    + "money already reached you.",

  "NothingToWithdraw(address)": (args) =>
    `${plain(args.account)} has no fee credit on the v4 hook to withdraw. The hook only `
    + "credits a recipient whose push failed; a zero balance means the fee was delivered "
    + "at the moment of the swap.",

  "TransferFailed": (args) =>
    `the native USDC transfer of ${wadUsdc(args.amountWad)} to ${plain(args.to)} failed `
    + "and this path cannot defer it. On Arc the usual cause is the blocklist: that "
    + "address cannot receive. Call withdraw(to) again naming an address that can — the "
    + "credit is intact and waiting.",

  "Reentrancy": () =>
    "a state-changing function was re-entered. If you are calling from a contract, your "
    + "receive() or fallback is calling back into the curve or the launchpad while it is "
    + "mid-trade. Take the payout and do your work afterwards.",

  /* ------------------------------------------------------------------ *
   * Roles
   * ------------------------------------------------------------------ */

  "NotProtocolAdmin": (args) =>
    `this call needs the PlatformRegistry's protocolAdmin and ${plain(args.caller)} is not `
    + "it. **Registering a platform is protocol-admin-only** — that is the single most "
    + "likely surprise in this API. The registry deploys every PlatformConfig itself, so "
    + "that isPlatform certifies code rather than a claim, and it will not deploy one for "
    + "an arbitrary caller. Launch under an existing platform, or ask arcnow.io to "
    + "register yours.",

  "NotPendingProtocolAdmin": (args) =>
    `only the account currently offered the protocol-admin role can accept it, and `
    + `${plain(args.caller)} is not that account. The handover is two-step on purpose: a `
    + "mistyped transfer of this role would be unrecoverable.",

  "NotAdmin": (args) =>
    `this call needs the contract's admin and ${plain(args.caller)} is not it. A platform's `
    + "settings are its admin's to change, and a migrator registry's are its own admin's. "
    + "Read admin() to see who.",

  "NotPendingAdmin": (args) =>
    `only the account currently offered the admin role can accept it, and `
    + `${plain(args.caller)} is not that account. Two-step, because a mistyped handover `
    + "would be unrecoverable.",

  "NotCreator": (args) =>
    `this call needs the token's creator seat and ${plain(args.caller)} does not hold it. `
    + "The seat is transferable by its holder and is read from the token, not the curve — "
    + "token.creator() is the source of truth, and it is also who the creator fee share is "
    + "paid to.",

  "NotPendingCreator": (args) =>
    `only the account offered the creator seat can accept it, and ${plain(args.caller)} is `
    + "not that account.",

  "NotCurve": (args) =>
    `only the token's own bonding curve may call this, and ${plain(args.caller)} is not it. `
    + "This is the privileged path that makes a sell need no approval; it is checked "
    + "against msg.sender on every call and cannot be delegated, approved or granted. If "
    + "you want to move somebody else's tokens, you want transferFrom and an allowance, "
    + "which is a different system entirely.",

  "NotLaunchpad": (args) =>
    `only the launchpad may deploy through this factory, and ${plain(args.caller)} is not `
    + "it. Launch through launchpad.launch(); the factories hold no per-curve state and "
    + "are not an entry point.",

  "NotACurve": (args) =>
    `only a curve this migrator's curveFactory deployed may hand it liquidity, and `
    + `${plain(args.caller)} is not one. Graduation calls this for you; there is no reason `
    + "to call it yourself.",

  "NotCustodian": (args) =>
    `only the escrow migrator's immutable custodian may release an escrow, and `
    + `${plain(args.caller)} is not it. On a venue migrator (v2, v3, v4) release reverts `
    + "for every caller including the custodian, because the liquidity is not meant to "
    + "come back out.",

  "NotPoolManager": (args) =>
    `only the Uniswap v4 PoolManager may call this, and ${plain(args.caller)} is not it. `
    + "The hook runs inside other people's swaps and takes its instructions from the "
    + "manager alone.",

  "NotTokenMigrator": (args) =>
    `only ${plain(args.token)}'s own migrator may register its pool with the fee hook, and `
    + `${plain(args.caller)} is not it.`,

  /* ------------------------------------------------------------------ *
   * Fee configuration
   * ------------------------------------------------------------------ */

  "FeeSharesExceedAllowance": (args) =>
    `a platform may allocate at most ${plain(args.allowanceBps)} bps of the fee across `
    + `creator, ref and dev, and this asked for ${plain(args.requestedBps)}. Whatever it `
    + "does not allocate is the platform's own share — the platform's cut is a residual "
    + "and is never an input anywhere in these contracts. The 7500 is measured against the "
    + "maximum protocol share (2500), not the current one, so a protocol admin lowering "
    + "their cut widens your residual and can never invalidate a stored configuration. "
    + "Bring creator + ref + dev down to the allowance; platformShareBps(creator, ref, dev) "
    + "will tell you what is left for you.",

  "FeeSharesNotWhole": (args) =>
    `the five shares totalled ${plain(args.totalBps)} bps and must total exactly 10000. A `
    + "split that does not add up either loses fee wei or promises more than was taken, on "
    + "every trade, forever — so it is refused before it can become immutable. You should "
    + "not be able to reach this through this SDK: the registry assembles the protocol half "
    + "itself. If you did, report it.",

  "ShareExceedsDenominator": (args) =>
    `a single share of ${plain(args.shareBps)} bps is more than the whole fee. Shares are `
    + "in bps **of the fee**, not of the trade: 3000 means 30% of the 1% fee, which is "
    + "0.30% of the trade. If you meant 30%, pass 3000.",

  "ZeroFeeRecipient": () =>
    "the platform and protocol fee recipients cannot be the zero address, because they are "
    + "the two that cannot be resolved at swap time. Creator, ref and dev may be zero — "
    + "their shares go to the platform, which is the residual claimant throughout this "
    + "design.",

  "InvalidFeeConfig": () =>
    "the fee split reaching this constructor does not add up to 10000 bps, or its platform "
    + "or protocol recipient is zero. This is the last gate before the numbers become "
    + "immutable and a curve is the wrong place to be forgiving. Fix the platform's "
    + "configuration; the registry validates the same thing earlier.",

  "ProtocolShareOutOfBounds": (args) =>
    `the protocol share must be between ${plain(args.minimumBps)} and `
    + `${plain(args.maximumBps)} bps and this asked for ${plain(args.shareBps)}. The floor `
    + "stops a compromised admin zeroing the protocol's revenue; the ceiling equals the "
    + "shipped default, so the protocol may lower its cut and never raise it. That ceiling "
    + "is what lets every platform's configuration stay valid forever.",

  /* ------------------------------------------------------------------ *
   * Curve templates
   * ------------------------------------------------------------------ */

  "InitialPriceMismatch": (args) =>
    `this template declares an initial price of ${plain(args.expectedWad)} and its y0Wad and `
    + `r0Wad actually price the first token at ${plain(args.actualWad)}. The opening price is `
    + "floor(r0 * 1e18 / y0), and a template that fails this quotes one opening price and "
    + "charges another. Use CurveTemplate.arcnowDefaults(), or derive all six values together "
    + "from the supply, the target and the multiplier — five of them constrain the sixth.",

  "GraduationTargetMismatch": (args) =>
    `this template declares a graduation target of ${wadUsdc(args.expectedWad)} USDC and its `
    + `y0Wad and r0Wad would actually collect ${wadUsdc(args.actualWad)} over its curve supply: `
    + "C(y0 - S) - r0, with C(Y) = ceil(r0 * y0 / Y). A template that fails this graduates "
    + "somewhere other than where it claims to. Derive y0 and r0 from the supplies and the "
    + "target rather than picking them.",

  "CurveNotPriceable": (args) =>
    `this template cannot be priced at all: curve supply ${wadTokens(args.curveSupplyWad)} `
    + `against y0Wad ${wadTokens(args.y0Wad)}, the virtual token reserve at launch. y0 must be `
    + "above the curve supply, and it and r0 + target must stay under 2^128 wad, or the curve "
    + "would sell tokens it does not have or overflow its arithmetic. Start from "
    + "CurveTemplate.arcnowDefaults() rather than editing a field.",

  "InsufficientTokenReserve": (args) =>
    `the constant-product curve holds a virtual token reserve of ${wadTokens(args.tokenReserveWad)} `
    + `and this asked it for ${wadTokens(args.tokensOutWad)}. A buy can never take the whole `
    + "virtual reserve; the curve caps a buy at its remaining inventory long before this, so "
    + "reaching it means a template whose y0Wad is not above its curve supply.",

  "InvalidSupplies": (args) =>
    `total supply ${wadTokens(args.totalSupplyWad)} and curve supply `
    + `${wadTokens(args.curveSupplyWad)} are not a usable pair. The curve supply must be `
    + "non-zero and **strictly below** the total: what is left over is the inventory the "
    + "migrator opens the market with, and a pool cannot be opened with one side empty.",

  "PoolReserveMismatch": (args) =>
    `this template holds back ${wadTokens(args.heldBackWad)} tokens for the pool and the `
    + `graduating reserve buys ${wadTokens(args.requiredWad)} at the curve's last price. `
    + "They have to match: the goal is that all the USDC raised and all the tokens not sold "
    + "go into the DEX at that price, the way pump.fun's single fixed template does. Held "
    + "back too many and a v2 migration burns the excess tokens; too few and it burns USDC. "
    + "Move supply onto or off the curve until the ratio holds.",

  "InvalidCurveParameters": () =>
    "the curve factory refused these parameters. They are validated in full by "
    + "PlatformConfig first, so reaching this through a launch means the platform's stored "
    + "template is not what it was validated as. Read platform.curveParameters() and check "
    + "it with checkCurveParameters.",

  "InvalidTokenParameters": () =>
    "the token factory refused these parameters: an empty name, symbol or metadata URI, or "
    + "a zero supply.",

  "InvalidParameters": () =>
    "the curve's immutable parameters are inconsistent — a zero y0 or r0, a zero target or "
    + "curve supply, or a fee above the permitted maximum. Every one of these is caught by "
    + "PlatformConfig before a launch can reach the curve, so this means the template was "
    + "not validated on the way in.",

  "InvalidReserve": () =>
    "a reserve or parameter is zero: the constant product k = r0 * y0 prices nothing when "
    + "either is zero, and a zero token reserve would divide by nothing. r0 is an accounting "
    + "fiction that gives the first token a positive price; it is never payable to anyone.",

  "MathOverflow": () =>
    "a curve product or quotient did not fit the 512-bit multiply-divide the curve settles "
    + "with. That means the amount or the template is far outside anything a real launch "
    + "uses. Scale the trade down, or re-derive the template from the supplies and the target.",

  "SaltAlreadyUsed": (args) =>
    `something is already deployed at the CREATE2 address for salt ${plain(args.salt)} `
    + `(it is ${plain(args.existing)}). A creator's launch nonce feeds that salt, so this `
    + "cannot happen twice for the same creator through the launchpad. Retry the launch.",

  /* ------------------------------------------------------------------ *
   * Token (ordinary ERC-20 surface)
   * ------------------------------------------------------------------ */

  "InsufficientBalance": (args) =>
    `${plain(args.holder)} holds ${wadTokens(args.balance)} and the transfer needed `
    + `${wadTokens(args.needed)}. Read balanceOf first — token amounts are 18 decimals, `
    + "like everything else in this system.",

  "InsufficientAllowance": (args) =>
    `${plain(args.spender)} may spend ${wadTokens(args.allowance)} of `
    + `${plain(args.owner)}'s tokens and needed ${wadTokens(args.needed)}. This is the `
    + "ordinary ERC-20 path, used by routers and other spenders. **It has nothing to do "
    + "with selling to the curve**, which reads no allowance at all; if you are trying to "
    + "sell, you are on the wrong function.",

  "TransferToZeroAddress": () =>
    "a transfer to the zero address is refused. On Arc that address is a real account and "
    + "the transfer would send the tokens nowhere at all; if you meant to destroy them, "
    + "there is no public burn.",

  "ApproveToZeroAddress": () =>
    "approving the zero address can only be a mistake — a miscomputed spender, or an "
    + "unfilled struct field. Nothing can spend from it.",

  "PermitExpired": (args) =>
    `this permit's deadline was ${plain(args.deadline)} and the block is past it. Sign a `
    + "fresh permit; the nonce has not been consumed.",

  "InvalidPermitSignature": () =>
    "the permit signature does not recover to the owner. Check the domain separator (it is "
    + "per-token and includes the chain id), the nonce, and that you signed the token's own "
    + "PERMIT_TYPEHASH.",

  "PoolAlreadyRecorded": (args) =>
    `this token's canonical pool is already recorded as ${plain(args.pool)} and it is `
    + "written exactly once, at migration. It is what switches on the token's "
    + "post-graduation taxation, so it cannot be moved afterwards.",

  /* ------------------------------------------------------------------ *
   * Registries
   * ------------------------------------------------------------------ */

  "PlatformAlreadyDeregistered": (args) =>
    `${plain(args.platform)} is already barred from new launches. There is deliberately no `
    + "re-registration path: a platform that should trade again gets a fresh config, so "
    + "that 'deregistered' is terminal for one address and cannot be toggled underneath an "
    + "integrator. Note that deregistration reaches nothing already launched.",

  "MigratorAlreadyRegistered": (args) =>
    `${plain(args.migrator)} is already a registered graduation target, and the same address `
    + "can never be registered twice — its tax mode and canonical router were read once, at "
    + "registration, and tokens are already governed by both. A venue whose mode changed is "
    + "a different contract.",

  "NotAMigrator": (args) =>
    `${plain(args.migrator)} does not answer the IMigrator interface the registry probes for, `
    + "so its tax mode cannot be recorded and it will not be admitted.",

  "NotARouter": (args) =>
    `${plain(args.router)} does not look like a router. This one matters more than it reads: `
    + "the canonical router is the address every holder's allowance answers uint256.max "
    + "for once the token migrates, so the registry will not take one on trust.",

  /* ------------------------------------------------------------------ *
   * Migrators and the v4 hook
   * ------------------------------------------------------------------ */

  "AlreadyReceived": (args) =>
    `${plain(args.token)} has already been migrated through this migrator. A token `
    + "graduates once and its liquidity moves once.",

  "NothingEscrowed": (args) =>
    `${plain(args.token)} has nothing escrowed here. Either it never migrated through this `
    + "migrator, or the escrow has already been released.",

  "NothingToDeposit": (args) =>
    `the migration arrived with ${wadTokens(args.usdcWad)} (quote, WAD) and `
    + `${wadTokens(args.tokenWad)} tokens, and a pool cannot be opened with a side empty. `
    + "This means the curve forwarded nothing, which a graduated curve should never do.",

  "NoLiquidityMinted": (args) =>
    `the pair at ${plain(args.pair)} minted zero LP for the deposit. That usually means the `
    + "amounts rounded to nothing against the venue's minimum liquidity. The curve is still "
    + "graduated and migrate() is still open as a permissionless retry.",

  "UnusableGraduationPrice": (args) =>
    `curve ${plain(args.curve)} reports a graduation price of ${plain(args.priceWad)}, which `
    + "no pool can be seeded at. This is what PlatformConfig's CurveNotPriceable check "
    + "exists to prevent at configuration time; a template that got past it should be "
    + "reported.",

  "PriceOutOfRange": (args) =>
    `the curve's last price converts to a sqrtPriceX96 of ${plain(args.sqrtPriceX96)}, which `
    + "is outside the range Uniswap's tick maths accepts. The template's price at "
    + "graduation is too extreme for a concentrated-liquidity venue.",

  "FeeTierNotEnabled": (args) =>
    `the v3 factory has no tick spacing for fee tier ${plain(args.feeTier)} on this chain. `
    + "The migrator cannot create a pool in a tier the factory does not enable.",

  "InvalidPoolParameters": (args) =>
    `the v4 pool parameters are unusable: lpFee ${plain(args.lpFee)}, tickSpacing `
    + `${plain(args.tickSpacing)}.`,

  "InvalidPoolKey": (args) =>
    `the fee hook was asked about pool ${plain(args.poolId)} with a key that does not hash `
    + "to it.",

  "PoolAlreadyRegistered": (args) =>
    `pool ${plain(args.poolId)} is already registered with the fee hook.`,

  "PoolNotRegistered": (args) =>
    `pool ${plain(args.poolId)} is not registered with the fee hook, so the hook has no fee `
    + "split to apply to it. Only a pool a migrator opened for an arcnow token is.",

  "NotAnArcToken": (args) =>
    `${plain(args.token)} is not an arcnow token, so the fee hook has no fee configuration `
    + "to read off it.",

  "HookFlagsMismatch": (args) =>
    `the hook at ${plain(args.hook)} does not carry the permission flags Uniswap v4 encodes `
    + "in a hook's address. A v4 hook's address *is* its permissions; this one was deployed "
    + "to the wrong salt.",

  "HookNotImplemented": () =>
    "this hook callback is not implemented, and v4 should not be calling it. The hook "
    + "declares exactly the permissions it uses.",

  "NotUnlocking": () =>
    "this can only run inside a Uniswap v4 unlock callback. The migrator drives it; there "
    + "is no reason to call it directly.",

  "UnexpectedMintCallback": (args) =>
    `a v3 mint callback arrived from ${plain(args.caller)}, which is not the pool the `
    + "migrator is minting into. Refused: a mint callback is an instruction to pay.",

  "WithdrawalFailed": (args) =>
    `sending ${plain(args.amount)} raw units of the pool's quote currency to ${plain(args.to)} `
    + "failed. On Arc the usual cause is the blocklist (native USDC and EURC both have one). "
    + "Withdraw to an address that can receive; the credit is intact.",

  "WrappedTransferFailed": (args) =>
    `the wrapped-native transfer of ${plain(args.amountWad)} to ${plain(args.to)} failed. `
    + "This is the one leg of a v2/v3 migration that is denominated in somebody else's "
    + "token rather than native USDC.",

  /* ------------------------------------------------------------------ *
   * UniswapV4Router04 — the post-graduation trading path
   *
   * Keyed by SIGNATURE, because the router's SlippageExceeded takes no
   * arguments and the curve's takes two: same name, different selectors,
   * different advice. A message keyed by name alone would give a pool trader
   * the curve's sentence about a price that rises across their own order,
   * which is not what a pool does.
   * ------------------------------------------------------------------ */

  "SlippageExceeded()": () =>
    "the pool filled worse than the floor you set, and the router refused rather than "
    + "taking the worse price. Unlike a curve, a pool's price is moved by everybody: "
    + "re-quote with pool.quoteBuy/quoteSell and widen the floor with "
    + "minTokensOutFromQuote(quote, toleranceBps). The router carries no amounts in this "
    + "revert, so there is nothing to render next to it — quote again to see the number.",

  "DeadlinePassed": (args) =>
    `your deadline was ${plain(args.deadline)} and the block that included this swap was `
    + "past it, so the router refused to fill an order agreed to that long ago. Re-quote "
    + "and resend with a fresh Deadline.inMinutes(5); if you keep landing here, you are "
    + "underpaying for gas.",

  "SafeERC20FailedOperation": (args) =>
    `moving ${plain(args.token)} failed inside the router. On a SELL the usual cause is a `
    + "missing allowance: the v4 router pulls your tokens with transferFrom and has no "
    + "privileged path, unlike the curve, which reads no allowance at all. Call "
    + "pool.approveRouter(amount) first — and note that token.canonicalRouter() is the "
    + "zero address on every arcnow.io token, so there is no standing allowance to fall "
    + "back on.",

  "ETHTransferFailed": () =>
    "the router could not pay out native USDC. On Arc the expected cause is the blocklist "
    + "or a recipient contract that rejects a plain value transfer under the router's "
    + "stipend. Name a recipient that can receive: every pool trade takes one.",

  /* ------------------------------------------------------------------ *
   * Quote tokens: the curve, the launchpad and the quote registry
   * ------------------------------------------------------------------ */

  "WrongQuotePath": () =>
    "this curve is priced in an ERC-20 quote, and the payable buy is for native USDC only; "
    + "sending value would buy nothing. Buy with buyWithQuote after approving the curve — "
    + "curve.buy() and trade.buy() choose the path from curve.quoteToken() for you.",

  "QuoteAmountNotRepresentable": (args) =>
    `${plain(args.amountWad)} wad is not a whole number of the quote's raw units (each is `
    + `${plain(args.quoteScale)} wad), so it cannot be pulled and was refused. Round it with `
    + "QuoteAmount.floorToRepresentable() or ceilToRepresentable(); QuoteAmount.parse never "
    + "produces such an amount.",

  "QuoteTransferShortfall": (args) =>
    `the quote token delivered ${plain(args.received)} raw units where ${plain(args.expected)} `
    + "were pulled, so the transfer was refused. That is what a fee-on-transfer or rebasing "
    + "token does, and arcnow.io refuses both. Nothing was bought or launched.",

  "QuoteTokenNotSupported": (args) =>
    `${plain(args.quote)} is not an active quote token in the quote registry, so no launch may `
    + "use it. List what is accepted with client.quoteRegistry.list(). A curve already "
    + "launched in a deregistered quote keeps trading; only new launches are refused.",

  "QuoteNotEnabledOnPlatform": (args) =>
    `the platform ${plain(args.platform)} serves no curve template for the quote `
    + `${plain(args.quote)}, so it does not launch in it. Check with `
    + "client.platforms.hasCurveParameters(platform, quote), or launch in a quote it enables.",

  "MigratorDoesNotSupportQuote": (args) =>
    `the migrator ${plain(args.migrator)} cannot graduate a curve priced in ${plain(args.quote)}. `
    + "On the multi-quote stack only the Uniswap v4 and escrow migrators accept ERC-20 quotes. "
    + "Launch with the platform's default migrator, or pick one whose supportsQuote says yes.",

  "LaunchFeeAboveMaximum": (args) =>
    `the launch fee is now ${plain(args.launchFeeWad)} wad and this launch capped it at `
    + `${plain(args.maxLaunchFeeWad)}: the fee changed after the launch was quoted, and the launch `
    + "reverted rather than overcharge you. Quote again and resend, or raise maxLaunchFee.",

  "NoCurveParameters": (args) =>
    `this platform has no curve template for ${plain(args.quote)}. A platform enables a quote `
    + "by setting a template for it (setCurveParameters(quote, template), platform admin only).",

  "QuoteTokenNotRegistered": (args) =>
    `${plain(args.quote)} was never registered in the quote registry. List registered quotes `
    + "with client.quoteRegistry.list().",

  "QuoteTokenAlreadyRegistered": (args) =>
    `${plain(args.quote)} is already an active quote token. Use setLaunchFee to change its fee.`,

  "NativeQuoteIsPermanent": () =>
    "native USDC (address 0) is the registry's permanent quote and cannot be deregistered.",

  "LaunchFeeNotRepresentable": (args) =>
    `a launch fee of ${plain(args.launchFeeWad)} wad is not a whole number of ${plain(args.quote)}'s `
    + "raw units, so it could never be pulled. Set a fee representable in its decimals.",

  "QuoteAmountMismatch": (args) =>
    `the migrator was told to expect ${plain(args.expectedWad)} wad of quote and received `
    + `${plain(args.receivedWad)}. A graduating curve always forwards exactly what it reports; `
    + "if this persists, the quote token is not behaving like a plain ERC-20.",

  "QuoteNotSupported": (args) =>
    `this migrator does not support the quote ${plain(args.quote)}, so it cannot graduate a curve `
    + "priced in it.",

  /* ------------------------------------------------------------------ *
   * Shared
   * ------------------------------------------------------------------ */

  "ZeroAddress": () =>
    "an address argument that must be set is the zero address. On Arc the zero address is a "
    + "real account, so this is refused rather than treated as 'unset' — the one place a "
    + "zero address *means* something is a swap's ref and dev, where it redirects that "
    + "share to the platform.",
};

/**
 * The message for a decoded revert, or `undefined` when this SDK has nothing
 * better to say than the generic fallback.
 */
export function messageFor(
  name: string,
  signature: string,
  args: Args,
  context: ErrorContext,
): string | undefined {
  const author = MESSAGES[signature] ?? MESSAGES[name];
  return author?.(args, context);
}

/** Every error name this SDK has written advice for. Used by the tests. */
export function authoredErrorKeys(): readonly string[] {
  return Object.keys(MESSAGES);
}
