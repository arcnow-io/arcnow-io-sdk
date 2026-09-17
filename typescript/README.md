# `@arcnow/sdk`

Launch, trade and read [arcnow.io](https://arcnow.io) bonding-curve tokens on
[Arc](https://docs.arc.io/), over JSON-RPC. **No arcnow.io backend is involved
and none is required** — everything here is done by calling the deployed
contracts directly, with [viem](https://viem.sh).

Install from npm — [`@arcnow/sdk`](https://www.npmjs.com/package/@arcnow/sdk) —
together with viem, which is a peer of everything here:

```sh
npm install @arcnow/sdk viem
```

Every release is tagged `vX.Y.Z` on
[arcnow-io/arcnow-io-sdk](https://github.com/arcnow-io/arcnow-io-sdk), with the
same tarball under its GitHub Release. The published `files` are the compiled
output, so a git install does not work; to build from source, clone the public
repository, build, and depend on the directory (a **link**, so "which SDK am I
running" is whatever that checkout is):

```sh
git clone https://github.com/arcnow-io/arcnow-io-sdk sdk
cd sdk/typescript && npm install && npm run build
npm install /path/to/sdk/typescript viem   # in your own project
```

Node 22.12 or newer. ESM only.

---

## The one fact that breaks everything if you get it wrong

**On Arc, USDC *is* the native gas currency, and `msg.value` is an 18-decimal
integer.**

The USDC ERC-20 interface predeploy at
`0x3600000000000000000000000000000000000000` is the *same asset* reporting **6**
decimals. It does not pay for gas, and **no arcnow.io contract reads, writes,
calls or imports it**. The two raw representations of one dollar differ by a
factor of `1e12`.

Every amount in every arcnow.io function signature, event, error and storage
slot is the 18-decimal one. There is no 6-decimal number anywhere in the
contracts.

This SDK refuses to let you mix them. Money is a `QuoteAmount` — a WAD **and the quote
token it is in** — with `Usdc` building native ones; token quantities are `Tokens`, fee
shares are `Bps`, and the 6-decimal view is `UsdcErc20`. The compiler will not let you
interchange them, and none can be built from a bare `bigint` without naming a scale
out loud:

```ts
import { QuoteAmount, Usdc, Tokens, UsdcErc20 } from "@arcnow/sdk";

Usdc.fromWhole(50n)            // fifty dollars, native USDC
Usdc.parse("1.25")             // exact; rejects a 19th decimal rather than truncating
Usdc.fromWad(2n * 10n ** 18n)  // the raw integer, as the chain stores it

curve.buy({ quoteIn: 10n, … })                // ✗ compile error: a bigint carries no scale
curve.buy({ quoteIn: Tokens.parse("10"), … }) // ✗ compile error: that is not money
curve.buy({ quoteIn: Usdc.parse("10"), … })   // ✓ on a USDC-quoted curve

// The 6-decimal USDC view exists only for the edge — a wallet balance, a UI figure.
Usdc.fromErc20(UsdcErc20.parse("1"))   // exact,   × 1e12
Usdc.parse("1.2345678").toErc20()      // 1.234567 — TRUNCATED toward zero
```

### A curve's quote may be an ERC-20

Curves are launched against a **quote token** — native USDC, or an ERC-20 the quote
registry allowlists, such as EURC (6 decimals) — and priced in it for life. Every
contract amount is still an 18-decimal WAD; an ERC-20 moves `wad / 10^(18 − decimals)`
raw units of itself.

```ts
const eurc = client.config.quoteTokens.find((q) => q.symbol === "EURC")!;

const amount = QuoteAmount.parse(eurc, "25");   // exact in EURC's 6 decimals
amount.wad;       // 25_000000000000000000n
amount.toRaw();   // 25_000000n
amount.format();  // "25 EURC"

QuoteAmount.parse(eurc, "1.1234567");            // ✗ AmountParseError: 7 fractional digits
QuoteAmount.fromWad(eurc, 1n).toRaw();           // ✗ QuoteAmountNotRepresentable
QuoteAmount.fromWad(eurc, 1n).ceilToRepresentable(); // 0.000001 EURC
amount.add(Usdc.parse("1"));                      // ✗ QuoteTokenMismatch
```

Every handle takes amounts in **its own** quote and refuses another with
`QuoteTokenMismatch` before anything is sent. `curve.quoteToken()` and
`trade.quoteToken()` say which one that is; `config.quoteTokens` carries the metadata
(no RPC), `client.quoteTokenInfo(address)` answers for any ERC-20 with one cached read,
and `client.quoteRegistry.list()` says which quotes a launch may use and what each
costs, in at most three `eth_call`s.

```ts
const quote = client.quoteToken(eurc);
await quote.balanceOf(me);                  // QuoteAmount, from balanceOf (eth_getBalance for native)
await quote.spendState(me, curve.address);  // { balance, allowance } in ONE Multicall3 call
await quote.ensureAllowance(curve.address, amount);
// sends nothing when the allowance covers it; otherwise approves EXACTLY `amount`
```

**Every approve this SDK sends is exact and only when short.** `curve.buy`,
`launchpad.launch` and `pool.buy` call `ensureAllowance` themselves for an ERC-20
quote and report the approve as `approvalTxHash`; native USDC needs none.

---

## Connect

Reading needs no key at all:

```ts
import { createArcNowClient } from "@arcnow/sdk";

const client = createArcNowClient({ network: "arc-testnet" });
```

Writing needs a signer — a local account, or a plain address for a wallet or
node that signs on your behalf:

```ts
import { privateKeyToAccount } from "viem/accounts";

const client = createArcNowClient({
  network: "arc-testnet",
  account: privateKeyToAccount(process.env.ARCNOW_PRIVATE_KEY as `0x${string}`),
});
```

**A write on a client with no signer fails before any RPC happens**, naming the
method and telling you to supply one. Building the transaction and letting the
node reject it would spend a round trip to produce a worse message.

### One stack, one curve

arcnow.io has one contract stack and one bonding curve: the multi-quote
constant-product curve, `arcnow/bonding-curve@3.x.x`, whose fee hook
(`arcnow/arc-now-fee-hook@3.x.x`) accrues each fee in the pool's quote currency as a
PoolManager claim and pays it out in a later transaction. `config.contracts` is that
stack, with the router (`contracts.v4Router`) beside it, and `config.contractVersions`
names the build at each address.

**Anything else is refused, never priced.** A curve, platform, registry or quote
registry that answers any other `VERSION()` — the version-2 build included — is refused
by name before anything is read, simulated or sent; see
[Which curve is this?](#which-curve-is-this).

> **Arc testnet still runs the version-2 stack** until the multi-quote stack is
> broadcast. The `arc-testnet` preset records those addresses — they must match the
> contracts' deployment record — and this SDK refuses them. Use a custom network (below)
> to talk to a multi-quote stack, as the fork suite does.

### Networks, and the mainnet gap

| preset | what happens |
| --- | --- |
| `"arc-testnet"` | resolves to the live deployment: chain `5042002`, the addresses in `networks.json` |
| `"arc-mainnet"` | **resolves, and then refuses**, naming every missing contract |

`"arc-mainnet"` is present in `networks.json`, complete in shape and `null` in
every address, on purpose. A preset that was *absent* gets you a "no such
network" you read as "the SDK is behind" and work around by pasting addresses
from somewhere; a preset with plausible addresses in it gets you a transaction
to an account that does not exist. What you get instead is an `ArcNowError` with
code `NetworkNotDeployed` that says exactly what is true.

`null` in that file means **"not deployed on this chain"**. It is not the zero
address, which on Arc is a real account that would send money nowhere at all.

A custom deployment is a first-class path, not a fallback:

```ts
const client = createArcNowClient({
  network: { rpcUrl: "http://127.0.0.1:8545", chainId: 31337, contracts: { … } },
});
```

`launchpad`, `tokenFactory`, `curveFactory`, `migratorRegistry`,
`platformRegistry` and `arcnowPlatform` are required. A custom network may add
`quoteRegistry` (otherwise asked of the launchpad), `quoteTokens` (defaulting to native
USDC alone) and `quoteAllowanceSlots`. `escrowMigrator`,
`v2Migrator`, `v3Migrator` and `feeHook` may be absent on a perfectly healthy
chain — Arc testnet has no escrow migrator, and that is the *better* state,
because escrow is the one custodial contract in the system and is deployed only
where no venue migrator could be built.

`arcnowPlatform` is arcnow.io's **own** `PlatformConfig`: the default to launch
under, not a privileged singleton. It is one platform among however many the
registry admits — just the one whose address is known before you have read a
log.

---

## Read

```ts
const curve = client.curve("0x…");
const state = await curve.state();   // one batched round trip, via Multicall3

state.quoteToken;             // { address, symbol, decimals, isNative } — for life
state.realReserve.format();   // "123.75 EURC" — raised so far, in the curve's quote
state.target.format();        // "50 EURC"  — what THIS curve's graduation takes
state.progressBps.bps;        // out of 10,000
state.tokensSold;             // Tokens
state.spotPrice;              // QuoteAmount per token
state.graduated;              // terminal once true
state.migrator;               // where THIS token graduates to. Ask the curve.
```

### Which curve is this?

```ts
await curve.version();   // "arcnow/bonding-curve@3.0.0"
await curve.quoteToken(); // the quote, read once from the curve's immutables
await curve.params();    // { r0Wad, y0Wad }
state.version; state.params; state.curveSupply; state.tradeFeeBps;
```

Every quote, local price, trade and state read asks the curve's own `VERSION()`
first. `arcnow/bonding-curve@3.x.x` is priced; **any other bonding-curve version,
the version-2 curve included, throws `UnknownCurveVersion` naming the version**, and an
address that is not a bonding curve at all — a token, a factory, an address with
no code — throws `AddressIsNotACurve`, naming what it says it is. Both before
anything is simulated. `assertCurveVersion(version)` is the rule on its own.

**Local prices, to the wei.** `curve.quoteBuy` asks the curve. The same numbers
without a round trip:

```ts
const state = await curve.state();
await curve.quoteBuyLocal(QuoteAmount.parse(state.quoteToken, "5"), state);   // BuyQuote
CurveMath.quoteBuy(curveSnapshotOf(state), 5n * 10n ** 18n);   // raw wads
```

`CurveMath` ports the curve's `CurveMath` and `CurveQuote` from arcnow-io/contracts
exactly — `k = r0Wad · y0Wad`, `C(Y) = ceil(k / Y)`, every rounding in the curve's
favour — and is held wei for wei to the pinned `vectors/vectors.json` and, on a
fork, to the chain's quotes and fills.

`spotPrice` is the marginal price of the next infinitesimal token — **not the
price a trade of any size fills at**. The curve integrates the price across an
order, so a buyer pays a rising price over their own trade. Quote instead.

```ts
const quote = await curve.quoteBuy(QuoteAmount.parse(state.quoteToken, "100"));
quote.tokensOut;   // what you would receive
quote.quoteSpent;  // what the buy consumes, fee included
quote.fee;         // 1% of the input, taken before anything reaches the reserve
quote.refund;      // non-zero only when this buy fills the curve
quote.graduates;   // true when this buy ends trading forever
```

The token handle carries the ordinary ERC-20 surface plus the launch-specific
bits:

```ts
const token = client.token(state.token);
await token.balanceOf(me);       // Tokens
await token.creator();           // the creator seat, transferable, no privilege
await token.migratedPool();      // zero until migration; written exactly once
await token.canonicalRouter();   // uint256.max allowance for every holder, after migration
```

---

## Launch

```ts
import { QuoteAmount, Usdc, Tokens, minTokensOutFromQuote, Bps } from "@arcnow/sdk";

const params = {
  name: "Example",
  symbol: "EXAM",
  metadataUri: "ipfs://…",
  initialBuy: Usdc.parse("25"),   // its token IS the launch's quote; QuoteAmount.parse(eurc, "25") for EURC
  minTokensOut: Tokens.ZERO,
  // platform defaults to the network's arcnowPlatform
  // migrator omitted = the platform's default, which is what almost every launch does
  // maxLaunchFee omitted = the launch fee just quoted
};

const quote = await client.launchpad.quoteLaunch(params);
quote.quoteToken;  // the quote: native USDC here
quote.launchFee;   // 2 USDC, from the quote registry, per quote
quote.totalCost;   // 27 USDC: launch fee + initial buy, in the quote
quote.nativeValue; // 27 USDC for native; ZERO for an ERC-20 quote, which is pulled
quote.tradeFee;    // 0.25 USDC — the initial buy's own 1%
quote.tokensOut;

const result = await client.launchpad.launch({
  ...params,
  minTokensOut: minTokensOutFromQuote(quote, Bps.of(50n)),
});
result.token;  result.curve;  result.tokensOut;  result.approvalTxHash;
```

Three things to know:

- **Native: `nativeValue` is exactly what `launch` sends, not a minimum.** The
  launchpad reverts with `IncorrectPayment` on an overpayment as readily as on
  an underpayment: it has no refund path. **ERC-20: no value at all**; the launchpad
  pulls launch fee + initial buy, and `launch()` approves exactly `totalCost` first
  when the allowance falls short.
- **The launch fee is per quote and the protocol admin may change it**, so every
  launch encodes `maxLaunchFeeWad` — `maxLaunchFee`, or the fee just quoted — and a
  raise while the transaction is pending reverts `LaunchFeeAboveMaximum`.
- **The initial buy is an ordinary buy.** It pays the 1% trade fee *on top of* the
  launch fee. `quoteLaunch` reports the two charges separately so you can name both.

`client.launchpad.launchFee(quote)` reads a quote's fee off the registry;
`accruedFees(quote)` and `collectLaunchFees(quote)` are per quote too.
`predictAddresses(creator, params)` tells you where the token and curve will
land, without deploying anything — valid only for that creator's **current**
launch nonce and **exactly** those parameters.

---

## Trade

```ts
import { Deadline, minQuoteOutFromQuote } from "@arcnow/sdk";

const q = await curve.quoteBuy(Usdc.parse("100"));
await curve.buy({
  quoteIn: Usdc.parse("100"),                   // native: the value; ERC-20: pulled after an exact approve
  minTokensOut: minTokensOutFromQuote(q, Bps.of(50n)),
  deadline: Deadline.inMinutes(5),
  referrer,                                      // optional; credits part of the fee
  developer,                                     // you are already paying
});
```

`minTokensOut` and `minQuoteOut` are **required arguments, not optional ones
defaulting to zero**. Passing zero means "fill me at any price", and on a public
mempool that is a donation — so you have to type the zero yourself, and typing
it is a decision rather than an omission.

`Deadline.inMinutes(5)` is the sensible default. `Deadline.none()` opts out, and
opting out lets a transaction be held back and executed at a much later price —
on a bonding curve, a price that has moved in one direction the whole time.

Everything in this section is the **curve**, which stops trading forever the
moment it graduates. `client.trade(token)` works on either side of that and
dispatches for you; see [Trade after graduation](#trade-after-graduation).

### On a buy that might graduate, set `gasLimit`

```ts
await curve.buy({ …, gasLimit: 8_000_000n });
```

**An estimated gas limit silently defeats the instant migration.**
`eth_estimateGas` searches for the lowest limit at which the transaction still
*succeeds* — and a graduating buy succeeds either way, because the curve
attempts the migration under a bounded budget and **catches its failure** rather
than reverting. So the estimate converges on precisely the limit at which the
migration is starved: the buy fills, the curve graduates, the refund is correct,
and the pool is simply never created. There is no revert and no error anywhere;
`migrate()` is still open as the permissionless retry, so the only symptom is a
graduated token with no market until somebody notices.

viem estimates unless you pass a limit, so this is the **default path**, not an
edge case. The curve budgets 6,000,000 for the migrator and keeps 100,000 back
for itself, so a buy that should migrate in its own transaction needs
comfortably more than 6.1M; 8,000,000 is what this package's fork tests use. It
is a ceiling, not a charge — unused gas is not paid for. `BuyQuote.graduates`
tells you in advance whether a given buy is the one that matters.

`BuyResult.migratedInThisTransaction` is how you check afterwards, and it is not
the same question as "is the curve migrated now": a starved migration still
leaves a curve that anybody can migrate a minute later, and the two look
identical from then on.

### A launch can graduate too, and there the SDK sets the limit for you

```ts
const quote = await client.launchpad.quoteLaunch(params);
quote.graduates;  // true when the initial buy alone fills the curve
```

The graduation target is whatever the platform's live template says — 50 USDC on
arcnow.io's own — so an **initial buy** can reach it, and then the launch deploys
a token, graduates it and attempts its migration in one transaction. The trap is
identical to the buy's, and it happened on Arc testnet: `eth_estimateGas` returned
6,250,146, the launch used 5,452,572, `InstantMigrationFailed` was logged, and no
pool was created. A bystander's `migrate()` rescued it ten blocks later.

So `launch()` does not leave this to you. When `quoteLaunch` says the launch
graduates, it sends `GRADUATION_GAS_LIMIT` (8,000,000) itself, and an explicit
`gasLimit` below `GRADUATION_GAS_FLOOR` (6,200,000) is **refused** rather than
sent — it is not a limit that makes the launch fail, it is one that makes it
succeed and quietly do half the job. `LaunchParams.gasLimit` overrides the
default for anyone who wants to.

`LaunchResult` then answers the question from the launch's **own receipt**:
`graduated`, `instantMigrationFailed`, `migratedInThisTransaction` and `pool`,
exactly as `BuyResult` does. A later read of the chain answers a different
question, because `migrate()` is open to anyone in between.

### A sell never needs an allowance — on the curve

```ts
const q = await curve.quoteSell(myTokens);
await curve.sell({
  tokensIn: myTokens,
  minQuoteOut: minQuoteOutFromQuote(q, Bps.of(50n)),
  deadline: Deadline.inMinutes(5),
});
```

**That is the whole thing. There is no approve step, and this SDK will never
emit one.**

The curve pulls the tokens with the token's `curveTransferFrom`, a privileged
path callable only by the token's own curve, which **reads no allowance at
all**. So:

- a holder who has approved nobody can always sell;
- an allowance granted to the curve is **not spent** by a sell and is still
  there afterwards;
- an approved spender still cannot use the curve's path.

That is a deliberate, tested guarantee — `TokenCurveSell.t.sol` in
`arcnow-io/contracts` asserts each of those three facts, and this package's
forked-chain suite asserts the first two against the real deployed bytecode.

If you find yourself reaching for `approve` before a sell, you are fixing the
wrong thing; `InsufficientTokenBalance` says so in as many words. The token
*does* have ordinary `approve` / `allowance` / `transferFrom` for everybody else
— routers, other spenders — and after migration the canonical router is
auto-approved for every holder. **That is a separate system from the curve's
privilege and the two must not be confused**: an allowance can be spent by
whoever holds it, and the curve's privilege is checked against `msg.sender` on
every call.

**After graduation this stops being true**, and it is the sharpest difference
between the two venues: the v4 router has no privileged path and pulls with
`safeTransferFrom`, so a pool sell needs `pool.approveRouter(amount)` first. The
auto-approved canonical router is the mechanism that would have avoided it, and
on Arc testnet it is registered as the zero address — so it applies to nothing.
See [Trade after graduation](#trade-after-graduation).

---

## Create a platform

A platform is a fee split, a curve template and a default migrator. Its own cut
is the **residual**:

```ts
import { platformShareBps, CurveTemplate, Bps } from "@arcnow/sdk";

// A pure helper: see your own cut without deploying anything.
platformShareBps(Bps.of(3000n), Bps.of(1000n), Bps.of(1000n));  // 2500 bps

await client.platforms.registerPlatform({
  admin, feeRecipient,
  creatorShareBps: Bps.of(3000n),
  refShareBps: Bps.of(1000n),
  devShareBps: Bps.of(1000n),
  defaultMigrator,
  curve: CurveTemplate.arcnowDefaults(),
});
```

**`NewPlatform` has no platform-share field, and that is the point.** The
platform's own cut is `10000 - protocol - creator - ref - dev`, computed on
demand and never an input anywhere in the contracts. A platform allocates at
most **7500 bps** across creator, ref and dev, and whatever it does not allocate
is its own. This SDK checks that **client-side, before sending**, with an error
that states the residual you are actually choosing.

The 7500 is measured against the **maximum** protocol share (2500), not the
current one — so a protocol admin lowering their cut widens every platform's
residual and can never invalidate a stored configuration.

> **Registering a platform is callable only by the registry's `protocolAdmin`.**
> An ordinary caller gets `NotProtocolAdmin`. This is the single most likely
> surprise in the API: the registry *deploys* every `PlatformConfig` itself, so
> that `isPlatform` certifies code rather than a claim, and it will not deploy
> one on behalf of an arbitrary caller. If you only want to launch tokens, you
> do not need a platform — launch under the network's `arcnowPlatform`.

### Every fee share is bps **of the fee**, never of the trade

The trade fee is a flat 1% and is not a platform's to change. What a platform
configures is how that 1% is divided. So a creator share of 3000 bps is **30% of
the fee** and **0.30% of the trade** — the single easiest mistake in this
design, which is why the conversion lives on the type:

```ts
Bps.of(3000n).percentOfFee();                 // 30
Bps.of(3000n).percentOfTrade(Bps.of(100n));   // 0.3
```

arcnow.io's own shipped split, and where the residual comes from:

| share | bps of the fee | of a trade | who sets it |
| --- | --- | --- | --- |
| creator | 3000 | 0.30% | the platform |
| platform | 2500 | 0.25% | **nobody — it is the residual** |
| ref | 1000 | 0.10% | the platform |
| dev | 1000 | 0.10% | the platform |
| protocol | 2500 | 0.25% | the protocol admin only |
| | **10000** | **1.00%** | |

A share whose **address** is zero at swap time — no referrer, no dev — is paid
to the platform instead, which is the same rule as a zero configured share. The
platform is the residual claimant throughout, including for the rounding dust
(at most four wei per fee).

### Curve templates

**A curve template is not a constant, and this SDK treats it as one nowhere.** It
is per-platform state, replaceable by that platform's admin in a single
transaction, and snapshotted immutably onto every curve at launch. Two questions,
two answers, neither of them a literal:

| question | where the answer comes from |
| --- | --- |
| what will a **new launch** in a quote get? | `client.platforms.curveParametersFor(platform, quote)` |
| what did **this token** get? | `client.curve(address).state()` |

arcnow.io's own template moved on 2026-09-13 — total supply from 1e9 to 1e6, the
graduation target from 50,000 USDC to 50 — and a curve launched before that keeps
the old one for as long as it exists. Applying today's template to such a token is
wrong by a factor of 1000.

`CurveTemplate` is `{ quoteToken, totalSupply, curveSupply, y0, r0, target,
initialPrice }` — `r0`, `target` and `initialPrice` in the quote — the tuple
`arcnow/platform-config@3.x.x` serves per quote; a platform or registry of any other
version is refused with `UnknownCurveVersion` before its template is read or anything
is sent. `hasCurveParameters(platform, quote)` says whether a platform launches in a
quote at all. `registerPlatform` takes the native template; other quotes are enabled by
the platform admin afterwards.

`CurveTemplate.arcnowDefaults()` is a **reference snapshot**, for the one job a
live read cannot do: seeding a platform of your own. It is arcnow.io's platform's:
1,000,000 total supply, 790,931.776678561246309959 on the curve (79.09%), a 50 USDC
target, opening at 0.000016710135998192 and graduating at 0.000239156382570519.
`CurveTemplate.reference()` is the contracts' 1e9 / 50,000 USDC reference, at the
same prices. Neither is written in TypeScript — they live in `curve-templates.json`
at the repository root, projected into `src/generated`, and
`scripts/check-template.sh` reads `curveParametersFor(quote)` off the live platform and
**fails** on any difference. `scripts/preflight.sh` runs that before anything
compiles.

**Do not recompute those numbers.** `y0` and `r0` are *placed*, not rounded, so
that the curve collects its target to the wei as it sells its last token and the
tokens held back are exactly what the target buys at the last price. A value
derived afresh in floating point lands a few wei out, the pool-reserve check
refuses it, and the failure looks like a bug in the contracts rather than in the
derivation.

`client.platforms.checkCurveTemplate(t)` runs the contracts' own `pure`
validator and surfaces the specific failure: `InitialPriceMismatch`,
`GraduationTargetMismatch`, `CurveNotPriceable`, `InvalidSupplies` or
`PoolReserveMismatch`. **It cannot tell you a template is current**, only that it
is self-consistent: the 1e9 template passes it on the live chain today. That is
why the drift went unseen, and why `check-template.sh` exists.

---

## Graduation

A curve retires **permanently** once it has collected its target — `state().target`,
its own, snapshotted at launch — in **real** reserve. `state().graduated` is then true
and every further buy, sell and quote reverts with `CurveGraduated`.

Four things worth knowing:

- **The graduating buy migrates the curve itself, in the same transaction**,
  under a bounded gas budget with its failure caught. Callers do not have to do
  anything and nobody has to poll — **provided the buy was sent with a gas limit
  you chose rather than one the node estimated**. See
  [`gasLimit`](#on-a-buy-that-might-graduate-set-gaslimit); this is the single
  easiest way to end up with a graduated token and no market.
- **`migrate()` is permissionless and is the retry path, not the normal one.**
  When the instant migration succeeded it reverts with `AlreadyMigrated`. When
  it failed — the curve logs `InstantMigrationFailed`, and `BuyResult` surfaces
  it as `instantMigrationFailed` — it stays open to anyone, with an unbounded
  gas budget, so a stuck migrator can never strand a curve.
- **The buy that fills the curve is capped at the remaining inventory.** Unspent
  native USDC is refunded — or credited to `pendingWithdrawal(account)` if that
  transfer fails — and an unspent ERC-20 quote is never pulled. `BuyQuote` carries `refund` and `graduates`, so you can
  see this coming before you send it.
- **Where it graduates to is the curve's own snapshotted `migrator`**, chosen at
  launch and immutable. On Arc testnet that is the Uniswap v4 migrator; v2, v3
  and escrow are not deployed there. **Ask the curve, not a network-wide list.**

After migration the same 1% is charged by `ArcNowFeeHook` inside the v4 pool's
swaps, in the pool's quote currency and in its raw units. Ref and dev have no address in a pool,
so both shares follow the zero rule to the platform recipient.

---

## Trade after graduation

`client.trade(token)` is the front door for a token's **whole** life. It asks the
token which venue it is on and dispatches, returning a union discriminated on
`venue`:

```ts
const trade = client.trade(token);

const quote = await trade.quoteBuy(Usdc.parse("25"));
if (quote.venue === "pool") console.log(`fee ${quote.feeQuote.format()}`);
else console.log(`graduates: ${quote.graduates}`);

await trade.buy({
  quoteIn: Usdc.parse("25"),   // in trade.quoteToken()
  minTokensOut: minTokensOutFromQuote(quote, Bps.of(50n)),
  deadline: Deadline.inMinutes(5),
});
```

It is a dispatcher, not an abstraction layer, and it **refuses** rather than
papering over the places the two venues genuinely differ: `recipient` is
pool-only (a curve pays `msg.sender` and has no such argument), and `referrer`,
`developer` and `gasLimit` are curve-only. Passing one to the wrong venue is an
`InvalidArgument`, not a silently dropped field — a referrer that is ignored is a
partner promised a share the chain was never asked for.

`client.pool(token)` is the pool side on its own: `key()`, `poolId()`,
`poolManager()`, `quoteToken()`, `quoteIsCurrency0()`, `isReachable()`,
`quoteBuy`/`quoteSell`, `buy`/`sell`, `routerAllowance()` and `approveRouter()`.

### The key's currency order is the token's and its quote's, sorted

`currency0 = min(quote, token)`. Native USDC is `address(0)` and always currency0, but
an ERC-20 quote such as EURC lands on either side depending on the token's address.
`pool.quoteIsCurrency0()` decides the swap direction (`zeroForOne` on a buy), which half
of the `BalanceDelta` and which leg of the `Swap` log is the quote — never assumed. v4
amounts are **raw units** of each currency (1 EURC is `1000000`), scaled to WAD in every
result. An ERC-20 pool buy approves the router for exactly the raw spend and swaps with
no value.

### A v4 pool has no address

A pool is a `PoolId` inside **one** PoolManager's storage. So
`token.migratedPool()` and the `Migrated` event's `pool` both return the
**PoolManager** — identically for every token that graduated through the same
migrator, by design. Read them as two facts and no more: *has this token
migrated*, and *into which manager*. The key itself is read from the token's
migrator; never write one down, because `fee`, `tickSpacing` and `hooks` are that
migrator's constructor arguments rather than constants of the chain.

### Quotes are `eth_call`s of the real swap

No quoter is deployed on Arc, and off-chain tick maths would be wrong anyway: the
migrator seeds two single-sided positions and anyone may add more. So a quote
calls the router itself with state overrides standing in for the money — and for
a sell, for the allowance — and reads back the `BalanceDelta`. **That delta is
the trader's own, with the hook's 1% already inside it**, which is the whole
reason it is worth the round trip. A buy quotes on a read-only client with no
funds anywhere when the quote is native USDC; an ERC-20 buy quote needs `{ from }`
holding the quote, and overrides only the router's allowance, at the quote's
`allowanceSlot` from `networks.json`. A sell needs `{ from }` naming a real holder,
because the allowance is overridden for the call and the balance deliberately is not.

The fee is then derived from the identity on **raw units**, the way the hook computes
it, not read back: `quoteIn * 1%` on a buy (`buyFeeFromQuoteIn`), and
`quoteOut * 10000/9900 * 1%` on a sell (`sellFeeFromQuoteOut`).

### A filled trade is read out of its own receipt

`PoolTradeResult` reports what happened, not what was predicted, and **every
figure in it is exact to the wei**. The token leg comes from the token's
`Transfer` log. The fee is the sum of the hook's `HookFeeTaken` logs for this
pool — zero when there are none, which is exactly what a trade too small to be
charged is — counted only for the pool's quote currency. And the quote leg comes from
the **PoolManager's own `Swap` log** for this pool, with the fee put back:
`quote = |Σ Swap.<quote leg> − Σ feeAmount|`, in raw units, scaled to WAD. See
`quoteFillFromLogs`.

Why: in v4-core, `beforeSwap` resizes the swap by the hook's specified delta,
`Swap` is emitted with the **pool's** delta, and only afterwards does `afterSwap`
subtract the hook's delta from what the router settles. The quote leg is signed from
the swapper's side, and the hook's fee is always a positive delta on it. A 1 USDC buy
charged 0.01 logs `−0.99`. A buy's `quote` is read, not assumed to be `quoteIn`. The fork suite holds every `usdc` to the trader's native balance
change with the receipt's gas put back, on both sides and for trades too small to
be charged.

**Fees accrue, and are paid out later.** The hook accrues each fee as an ERC-6909
claim on the PoolManager and pays it out five ways at the start of the pool's next
swap in a **later** transaction, or when anyone calls `distributeFees`.
`HookFeeTaken` is emitted per swap, so `feeQuote` is the fee this trade was
charged; a distribution burns and takes the hook's own claim and never touches the
trader's delta. The fork suite proves that on a swap that distributes, rather than
assuming it.

```ts
result.feesDistributed;          // earlier fees this swap paid out (FeesDistributed)
await pool.hookVersion();        // "arcnow/arc-now-fee-hook@3.0.0"
await pool.accruedHookFee();     // charged and not yet paid out, in the quote
await pool.distributeHookFees(); // permissionless payout
```

A pool whose hook answers any other `VERSION()` is refused with
`UnknownHookVersion` by `accruedHookFee` and `distributeHookFees` before anything
is read from the hook or sent to it.

### A pool sell needs an approval; a curve sell never does

The curve pulls with `curveTransferFrom` and reads no allowance at all. The
router has no such privilege — it calls `safeTransferFrom` — so call
`pool.approveRouter(amount)` first. There is **no standing allowance to fall back
on**: `token.canonicalRouter()` is the zero address on every arcnow.io token and
will stay that way for any token already launched, because it is snapshotted from
the migrator registry at launch and Arc testnet's v4 migrator registers no
router.

### The router is arcnow.io's own, and live on Arc testnet

Every pool quote and trade goes through **`contracts.v4Router`**:
`UniswapV4Router04` from [z0r0z/v4-router](https://github.com/z0r0z/v4-router)
at commit `f5d5bfc2`, unmodified, deployed by arcnow-io/contracts
`script/DeployV4Router.s.sol` and bound to **arcnow.io's own PoolManager**,
`0x06110b57…`.

Why its own, when Arc testnet already has a v4 router? That router is bound to a
**different** PoolManager, and a v4 pool is a `PoolId` inside one manager's
storage, so it cannot see a single arcnow.io pool. Every graduated arcnow.io token
has its liquidity in `0x06110b57…` permanently: the positions are burned and the
migrator's `poolManager` is immutable. A router bound to our manager reaches every
one of them.

Its address is deterministic — CREATE2 through Arc's factory
`0x4e59b448…`, salt zero — so it is `0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e`
with runtime codehash `0xdb6c3523…`, broadcast on Arc testnet and named by
`networks.json`. The two refusals:

- **`NoRouterDeployed`** — every pool quote and trade (and `approveRouter`,
  `routerAllowance`) on a network with no `contracts.v4Router` throws this,
  before any RPC. It is a property of the network, not the token; bonding-curve
  trading is unaffected. `pool.isReachable()` answers `false` rather than
  throwing, so a UI can show "trading after graduation is coming".
- **`PoolUnreachable`** — with a router configured, the token's migrator's
  `poolManager()` is not the one the router serves. With the planned deployment
  this should not happen for an arcnow.io token; it names a router bound to the
  wrong manager instead of letting the router answer `0x486aa307`,
  `PoolNotInitialized()`, which reads like a malformed key.

**`isReachable()` asks the router, not `networks.json`.** With a router
configured it reads the router's own immutable `poolManager()` off the chain and
compares the migrator's against that; the preset's `v4.poolManager` is
descriptive only. A check that compared one bundled address against another
could be made to pass by a single stale entry in that file, which is the mistake
it exists to catch. The router's answer is cached per client — it cannot change.

`client.migrators.list()` asks the same question of every registered graduation
target *before* a launch commits to one. `MigratorInfo.reachable` is `true` for
a v4 migrator only when a router is configured **and** serves that migrator's
PoolManager, `false` when no router is configured, and `true` for escrow, v2 and
v3, which have no PoolManager.

---

## Error handling

One error type for the whole SDK. Custom errors are decoded **by selector across
every pinned ABI** — not just the contract you called, so an error a token or a
migrator threw inside a curve call still comes back named — and each carries its
decoded parameters and a message that says what to do:

```ts
import { isArcNowError } from "@arcnow/sdk";

try {
  await curve.buy({ … });
} catch (error) {
  if (!isArcNowError(error)) throw error;

  switch (error.code) {
    case "SlippageExceeded":
      // "the fill moved to … against your floor of …. Re-quote and retry; the
      //  curve's price rises across your own order."
      error.args.minOutWad;  error.args.actualOutWad;
      return requote();
    case "CurveGraduated":
      // "…reached its target and stopped trading permanently. Trade the token at
      //  its graduation venue instead — curve.state().migrator says which."
      return sendToVenue();
    case "ReadOnlyClient":
      return askForASigner();
  }
  throw error;
}
```

`Error(string)`, `Panic(uint256)` and an empty revert are each handled and each
get their own code and their own sentence — an empty revert names the three
things it usually means. A selector in none of the ABIs comes back as
`UnknownRevert` with the selector stated plainly so it can be looked up, never
as a bare hex blob.

**Uniswap v4's `WrappedError`** (`0x90bfb865`), which v4 puts around every revert
from a hook call or a native transfer, is unwrapped: when the inner reason is a
known custom error, an `Error(string)` or a `Panic`, that is the error you get —
same `code`, same `args` — with the layers it came through on
`error.details.wrappedBy` (target, the call's selector and its name when it is a
hook callback, and v4's own detail such as `HookCallFailed`). Only an empty or
unknown inner reason comes back as `WrappedRevert`.

Three codes guard the one curve: `UnknownCurveVersion` (a curve, platform or
registry at any major but the multi-quote stack's), `AddressIsNotACurve` (an address
handed in as a curve that is not one), and `UnknownHookVersion` (a pool whose hook is
not `arcnow/arc-now-fee-hook@3.x.x`). Two more guard quotes, both raised before
anything is sent: `QuoteTokenMismatch` (an amount in the wrong quote) and
`QuoteAmountNotRepresentable` (an ERC-20 amount with dust below one raw unit, the same
name the contracts revert with). `CurveNotPriceable` reports the template's curve
supply and `y0Wad`.

---

## Running the tests

```bash
npm run typecheck   # tsc --noEmit, and the type-level brand assertions with it
npm run lint        # eslint (lint and formatting in one tool); lint:fix formats
npm run build       # tsc -p tsconfig.build.json
npm test            # the unit suite: no chain, no Docker, under a second
npm run test:fork   # the forked-chain suite: needs Docker
```

`npm run preflight` runs the first four in order.

### The unit suite

Everything that can be proved without a chain: the amount types and the 18/6
conversions, the network presets and the mainnet refusal, the residual fee
arithmetic, the shipped curve templates (checked field for field against the
contracts' pinned `vectors.json`), the error decoding across the pinned ABIs
including v4's `WrappedError`, the refusal of every curve, platform, registry and
hook version but `@2.x.x` — the retired `@1.x.x` included — before anything is
read or sent, and the container hygiene rules of the fork harness.

`CurveMath` is held **to the wei** against `vectors/vectors.json` at the repository
root (schema 2: every math row, every state replayed, all 504 priced trades, the
launch quotes).

`test/types/brands.test-d.ts` is checked by `tsc`, not by Vitest: every
`@ts-expect-error` in it is an assertion that the compiler *rejects* the line
below, and an unused directive fails the type check. That is the only way to
prove a compile-time refusal.

### The forked-chain suite

An **anvil fork of Arc testnet** in a container (`ghcr.io/foundry-rs/foundry:v1.8.1`,
pinned in `pins.json`), at the block `pins.json` pins (`ARCNOW_SDK_FORK_BLOCK` overrides
it), with **the multi-quote stack deployed onto it**: Arc testnet still runs the
version-2 stack, which this SDK refuses. `test/fork/support/stack.ts` runs
`scripts/fork-deploy-stack.sh`, which compiles arcnow-io/contracts at the pinned commit
from `ARCNOW_CONTRACTS_DIR` and broadcasts the contracts' own `DeployWithHook.s.sol`
with anvil's public development key — refusing any endpoint that is not anvil — then
sets arcnow.io's testnet template and registers EURC with a EURC template. The suites
build a custom network from its output; the live PoolManager, router and EURC token are
inherited from the fork.

`journey.fork.test.ts` reads every deployed address's `VERSION()`, the quote registry
(native USDC and EURC, with launch fees), the platform's per-quote templates and
`AddressIsNotACurve` for a token address, then launches a token, quotes and fills a
buy, sells with no approval anywhere, and drives a curve all the way to graduation —
asserting that the v4 pool was recorded **in the graduating buy's own receipt**, which
is the assertion that catches a starved instant migration. Remove the `gasLimit` from
that one call and a handful of tests fail while the rest still pass; that asymmetry is
the whole reason the assertion is written that way.

It then does the same graduation **without** a gas limit and asserts the damage
— the buy succeeds, the refund is right, and the pool is never created — before
a bystander rescues it with the permissionless `migrate()`.

It does the same for a **launch** whose initial buy alone graduates the curve:
no `gasLimit` from the caller, and `migratedInThisTransaction` asserted true, and
again at exactly `GRADUATION_GAS_FLOOR`, with the receipt's `gasUsed` logged.

It asserts that **a revert does not wedge the client**: it reverts a buy on its slippage
floor from a local signing account, then keeps transacting from the same account and
checks those later transactions still mine, and that the nonce advanced exactly as many
times as transactions were mined.

And it exercises **quote tokens** as far as the pinned contracts go: EURC's `symbol()`
and `decimals()` equal `networks.json`; its allowance slot 10 is pinned by overriding it
in an `eth_call` and reading it back; `ensureAllowance` approves the real EURC exactly
once and sends nothing the second time; the live version-2 platform is refused with
`UnknownCurveVersion`; and an ERC-20 launch is refused **by name**, with no nonce spent,
because contracts #22 implements native USDC only.

`pool.fork.test.ts` covers the other half of a token's life. It launches a token
whose initial buy graduates it **on the fork**, and trades that token's pool
through the live router — whose creation bytecode, deterministic address and
runtime codehash it checks first. With no router configured every pool quote and
trade refuses with `NoRouterDeployed`. With the router it reads the key off the migrator
(native-quoted, so quote-first; the fee hook `arcnow/arc-now-fee-hook@3.0.0`), pins
**ArcToken allowance storage slot 11** by writing it and reading it back through
`allowance()`, and then:

- buys 1 USDC exactly as quoted, the buyer's native balance moving by exactly
  `quote` with the gas put back, and the fee **accruing** — `accruedHookFee` up by
  exactly the `HookFeeTaken`, no recipient paid;
- sells half **in a later transaction** to a named payee whose balance moves by
  exactly the quote, while that swap's `FeesDistributed` pays out exactly the
  buy's accrual — the fill still exact;
- sells to self and trades 99 wei both ways, none of it charged, every figure
  exact;
- has a bystander call `distributeHookFees`, which pays out the rest and zeroes
  the accrual.

**EURC, on every run**: a EURC launch (exact approve, no value, the EURC pulled equal
to the total cost, the creator's fee share credited back in the same transaction), a
EURC curve buy and sell, and a EURC-quoted token's pool — its key order checked against
the addresses, every fill equal to the EURC balance change.

anvil is throttled against the upstream (`--compute-units-per-second 60`, with
retries and a backoff) because the public Arc endpoint rate-limits, and a fork
fetches state on demand for the whole run — so the 429 arrives mid-run, attached
to whichever transaction needed a cold account, and reads exactly like a
contract failure. `ARCNOW_SDK_FORK_URL` points the fork at a different endpoint.

**Docker may be unavailable, and then the suite skips — loudly.** Set
`ARCNOW_SDK_REQUIRE_DOCKER=1` to make a missing daemon a failure instead, which
is what CI should do: a skip is right for a developer without a daemon, and is
exactly how a pipeline shows green having tested nothing.

Every container is labelled `io.arcnow.sdk.test=1` plus a pid and a scope, and
is removed on pass, fail, unhandled rejection and SIGINT. A sweep only ever
touches containers carrying that label **and** a pid from its own scope that is
no longer alive — this machine's Docker daemon is shared with other work, and
"never touch a container you did not start" is a property of the code here, not
of a sidecar's configuration. `ARCNOW_SDK_KEEP_CONTAINERS=1` leaves them up for
inspection.

#### What a fork proves, and what it does not

A fork **re-executes transactions locally with anvil's EVM**. So it proves this
SDK against the real deployed bytecode, the real registries and the real
platform config — and it proves **nothing about Arc's own execution semantics**.
Blocklisted transfers, EIP-1153, the EIP-7708 system emitter and burn-to-zero
are Arc's, not anvil's, and a fork will happily disagree with the live chain
about all of them **without saying so**. That gap belongs to a live-smoke layer
this package does not have.

---

## The example

`examples/launch-and-trade.ts` does the whole arc — connect, quote, launch,
quote, buy, read state, quote, sell, print the fee split — and prints every amount
in its own quote token.

```bash
export ARCNOW_PRIVATE_KEY=0x…   # a funded Arc testnet key
npm run example
```

It reads the key from that environment variable and **from nowhere else**: there
is no key, no mnemonic and no credential of any kind in this repository. It says
what the run will cost before it spends anything. Set `ARCNOW_RPC_URL` to
rehearse it against a local fork instead of the public endpoint.

---

## Where the ABIs and addresses come from

`src/generated/` is projected in from the repository root by
`scripts/sync-artifacts.sh` and must never be hand-edited — `scripts/check-pins.sh`
hashes it. The ABIs are copies of `arcnow-io/contracts`' exported artefacts at
the commit `pins.json` pins, which is the same commit the addresses in
`networks.json` were deployed from. If those two ever diverge, an encoded call
succeeds against a selector that does something else, which is the failure the
pin exists to prevent.

The ABIs are re-exported for anyone who wants to talk to the contracts directly:

```ts
import { abi } from "@arcnow/sdk";   // abi.bondingCurveAbi, abi.launchpadAbi, …
```
