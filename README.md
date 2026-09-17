# arcnow.io SDKs

Rust and TypeScript SDKs for [arcnow.io](https://arcnow.io): launch a token, trade
its bonding curve, create a platform and read the state of either, by talking to
the contracts over JSON-RPC.

**There is no arcnow.io backend in the loop.** Nothing here calls an arcnow.io API,
holds an arcnow.io key or needs arcnow.io's permission. The contracts are on
[Arc](https://docs.arc.io/), they have no owner, no admin, no pause and no upgrade
path, and an RPC endpoint is the whole dependency. If arcnow.io stopped existing
tomorrow, everything in this repository would keep working.

| | | install |
| --- | --- | --- |
| [`rust/`](rust/) | [`arcnow-sdk`](https://crates.io/crates/arcnow-sdk), built on [alloy](https://alloy.rs) | `cargo add arcnow-sdk` |
| [`typescript/`](typescript/) | [`@arcnow/sdk`](https://www.npmjs.com/package/@arcnow/sdk), built on [viem](https://viem.sh) | `npm install @arcnow/sdk viem` |

Both ship from this repository in one release, tagged `vX.Y.Z` on
[arcnow-io/arcnow-io-sdk](https://github.com/arcnow-io/arcnow-io-sdk) with the
tarballs under the GitHub Release. To build from source, clone that repository;
each package's README says how.

Each has its own README with the full API; this one covers what they share, which
is everything that matters and a few things that will cost you money if you skip
them.

---

## The one fact that breaks everything if you get it wrong

**On Arc, the native gas currency IS USDC, and `msg.value` is 18 decimals.**

There is also a USDC ERC-20 interface predeploy at
`0x3600000000000000000000000000000000000000`. It is the *same asset* and it reports
**6** decimals. It does not pay for gas, and **no arcnow.io contract reads, writes,
calls or imports it.**

The two raw representations of one dollar differ by `1e12`. A figure of "6 decimals"
is in wide enough circulation that you will meet it; it is about the other interface,
not about anything in this SDK.

So both SDKs make the distinction a *type*, not a convention:

| type | what it is | where it appears |
| --- | --- | --- |
| `QuoteAmount` | an amount of a curve's **quote token** — an 18-decimal WAD *and* the token it is in | **every** value-bearing API in this SDK |
| `Usdc` | native USDC: a `QuoteAmount` whose token is `NATIVE_USDC` (`address(0)`, 18 decimals) | the native alias, and what a USDC-quoted curve takes |
| `Tokens` | a launched token amount, 18 decimals | balances, quotes, slippage floors |
| `UsdcErc20` | native USDC through the 6-decimal interface | **nowhere in the call path** — it exists only so you can convert at the edge, for a wallet UI |

There is no constructor on any of them that takes a bare integer and guesses which
scale you meant, and no implicit conversion between them. Converting `Usdc` down to
`UsdcErc20` **truncates toward zero**, because a wad amount can carry dust six
decimals cannot express and rounding up would promise dollars that do not exist.

### Curves are priced in a quote token, and it may not be USDC

A curve is launched against a **quote token** and priced in it for life: native USDC,
or an ERC-20 the protocol's **quote registry** allowlists — EURC
(`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`, **6 decimals**) is the first. The two
are paid differently, and both SDKs choose the path from the curve's own
`quoteToken()`:

| quote | a launch, a buy | a sell's payout |
| --- | --- | --- |
| native USDC (`address(0)`) | `msg.value`, no allowance | a value transfer |
| an ERC-20 (EURC) | **pulled**, after an **exact** `approve` the SDK sends only when the allowance falls short | the token, in its raw units |

Every contract amount stays an 18-decimal WAD whatever the quote; an ERC-20 moves
`wad / 10^(18 − decimals)` raw units of itself. So a `QuoteAmount` carries its token,
and two rules follow:

- **An amount in one quote is refused where another is expected** (`QuoteTokenMismatch`)
  — 10 USDC handed to a EURC curve, or 1 EURC added to 1 USDC, has no answer.
- **A WAD that does not divide into whole raw units is named, not rounded**
  (`QuoteAmountNotRepresentable`, the same name the contracts revert with).
  `QuoteAmount.parse` is exact in the token's own decimals, so a parsed amount is always
  representable; round a computed one yourself with `floorToRepresentable` /
  `ceilToRepresentable`, so the amount sent is one you chose.

`networks.json` lists each network's quote tokens (`quoteTokens`: symbol, name,
decimals) so that labelling an amount costs no RPC call. That list is **metadata, not
the allowlist**: whether a quote is accepted is `QuoteRegistry.isQuoteToken`, and
`quoteRegistry.list()` reads every quote, its launch fee and whether it is active in at
most three `eth_call`s.

## What both SDKs do

**Connect** — the `arc-testnet` preset, or your own RPC URL and addresses. Reading
needs no key at all; a read-only client is a first-class thing and every read works
on one. Calling a write method on a read-only client fails before any RPC happens,
and says to supply a signer.

**Launch a token** through `Launchpad`, in one transaction: the launch fee, the token,
its bonding curve bound to it, and the creator's optional initial buy. **The initial
buy's token is the launch's quote.** Quote it first. In native USDC a launch requires
*exactly* the quoted `nativeValue` (launch fee + initial buy) as its value, not at
least, because the launchpad has no refund path. In an ERC-20 quote it sends no value:
the launchpad pulls fee + initial buy, which the SDK approves exactly beforehand. The
launch fee is **per quote and admin-mutable**, so every launch caps it
(`maxLaunchFee`, defaulting to the fee just quoted): a raise while the transaction is
pending reverts `LaunchFeeAboveMaximum` instead of overcharging. The initial buy is an
**ordinary buy** and pays the ordinary 1% trade fee on top of the launch fee; the quote
reports the two separately so you can name both charges.

**Buy and sell** on a curve, with quotes first, in the curve's quote. A native buy
carries USDC as the transaction's value; an ERC-20 buy calls `buyWithQuote` after an
exact approve. A sell needs **no allowance on the token** — see below, it is the
question everyone asks.

**Hold and approve a quote** — `quoteToken(q).balanceOf`, `spendState` (balance and
allowance in one Multicall3 call), and `ensureAllowance`, which approves **exactly** a
spend and sends nothing when the allowance already covers it.

**Read state** — spot price, tokens sold and remaining, real and virtual reserve,
progress toward graduation in basis points, whether it graduated, whether it
migrated, and where it graduates to.

**Create a platform** — register one through `PlatformRegistry` with its fee shares,
its fee recipient, its default migrator and its bonding-curve template. See
[the fee split](#the-fee-split-and-the-share-you-must-not-pass), which has one rule
that catches everybody.

## One curve, one stack

arcnow.io runs **one contract stack** per chain, and it has **one bonding curve**: the
multi-quote constant-product curve, convex in the quote raised.

| | |
| --- | --- |
| curve `VERSION()` | `arcnow/bonding-curve@3.x.x` |
| parameters | `{ r0Wad, y0Wad }`, and a quote token (`quoteToken()`, `quoteDecimals()`, `quoteScale()`) |
| fee hook after graduation | `arcnow/arc-now-fee-hook@3.x.x`, which accrues the 1% **in the pool's quote currency, in raw units**, as a PoolManager claim and pays it out in a **later** transaction |
| platform `VERSION()` | `arcnow/platform-config@3.x.x`, one curve template per quote |
| quote registry `VERSION()` | `arcnow/quote-registry@1.x.x` |

**Both SDKs read `VERSION()` before they price anything, and refuse what is not that
curve.** Any other bonding-curve version — the version-2 curve that predates quote
tokens, and `@1.x.x` — is `UnknownCurveVersion`, naming the version: no local maths, no
quote, no trade. An address that is not a bonding curve at all (a token, another
contract, nothing) is `AddressIsNotACurve`. A pool whose hook is not `@3.x.x` is
`UnknownHookVersion` on every hook-specific call. An unknown version is refused rather
than priced, because a guess would produce a plausible, wrong number.

> **Arc testnet runs the multi-quote stack**, deployed at block 62,226,550 and recorded
> in `networks.json` (`bonding-curve@3.x`, `launchpad@3.0.0`, `quote-registry@1.0.0`,
> `arc-now-fee-hook@3.0.0`); `pins.json` marks the deployment **deployed**, see
> [the ABI pin](#the-abi-pin). The fork suites still deploy their own copy of the stack
> onto a fork, so a run is reproducible and costs the live chain nothing.

The constant-product curve, exactly as the contracts trade it (`k = r0Wad · y0Wad`,
`Y = y0Wad − tokensSold`, `C(Y) = ceil(k / Y)`):

```text
buy, net USDC d   Y' = ceil(k / (C(Y) + d))     tokensOut = min(Y − Y', tokens left)
sell t tokens     gross = C(Y) − C(Y + t)       fee charged on gross
spot price        floor(C(Y) · 1e18 / Y)        every fee rounds up
```

Both SDKs carry that maths and hold it **to the wei** against the contracts' own
generated vectors, [`vectors/vectors.json`](vectors/vectors.json). The quotes a curve
handle returns still come from the curve itself; the local maths is what a UI prices
with between blocks, and the fork suites require local, on-chain and filled to agree
exactly.

## A curve template is not a constant

A platform's bonding-curve template — total supply, curve supply, `Y0`, `R0`, the
graduation target, the opening price — is **that platform's state**, replaceable by
its admin in one transaction, and **snapshotted immutably onto every curve at
launch**. So there are two questions with two different answers and neither of them
is a number in a document:

| question | ask |
| --- | --- |
| what will a **new launch** in a quote get? | `platforms.curveParametersFor(p, quote)` / `curve_parameters_for(p, quote)` |
| what did **this token** get? | `curve(address).state()` |

arcnow.io's own template moved on 2026-09-13: total supply 1e9 → 1e6, curve supply
741e6 → 741e3, target 50,000 USDC → 50. **Every price was bit-identical across the
change** — the opening price, the graduation price, the 14.31x rise and the
74.1/25.9 split all survived untouched — so nothing looked wrong anywhere, and a
curve launched the day before still has 1e9 supply and a 50,000 USDC target today.

The contracts cannot catch this. `PlatformConfig.checkCurveParameters` checks a
template against **itself** — the price relationship, the target relationship, the
pool-reserve rule — and the old template passes it on the live chain right now.
Self-consistency is not currency.

A platform serves **one template per quote** (`curveParametersFor(quote)`); a launch in
a quote the platform has no template for reverts `QuoteNotEnabledOnPlatform`. The EURC
template on arcnow.io's platform mirrors the USDC one in EURC units.

Both SDKs therefore ship templates as **reference snapshots** only, for seeding
a platform of your own, in one file (`curve-templates.json`, schema 4) read by both
languages. Each entry names its `quote`, its fourth field is `y0Wad`, and the target is
`targetQuoteWad`. Both SDKs refuse a platform whose `VERSION()` is not
`arcnow/platform-config@3.x.x` before decoding or sending one. The file carries:

| entry | what |
| --- | --- |
| `arc-testnet` | arcnow.io's platform: 1,000,000 supply, 79.09% on the curve, 50 USDC target, launch price 0.000016710135998192, graduation 0.000239156382570519 |
| `cpmm-reference` | the contracts' reference: 1e9 supply, 50,000 USDC target, the same prices; no live platform serves it |

`scripts/check-template.sh` reads `VERSION()` and `curveParametersFor(quote)` off the
platform `networks.json` names and **fails** on a missing snapshot, a platform that is
not `platform-config@3.x.x`, or a single wei of drift — except that while `pins.json`
marks the deployment pending, a `platform-config@2.x.x` platform is **reported** as the
pre-multi-quote stack rather than compared. A template no platform serves is reported
as exactly that and checked against the contracts' vectors instead, so it never passes
by being ignored. The same script reads every ERC-20 quote's `symbol()` and
`decimals()` back and **fails** when `networks.json` disagrees: a wrong decimals entry
would mis-scale every raw amount of that quote.
`scripts/preflight.sh` runs it before anything is compiled.

## Selling needs no allowance. Ever.

Not "usually not". Not "not after migration". Never.

The curve pulls a seller's tokens with `IArcToken.curveTransferFrom`, a privileged
path callable only by that token's own curve, which **reads no allowance at all**. A
holder who has approved nobody can sell. An allowance granted to the curve is not
spent by a sell and is still sitting there afterwards. An approved spender still
cannot use the curve's path. Selling is one transaction with no approve step, and
that is a deliberate, tested guarantee — `contracts/test/unit/TokenCurveSell.t.sol`
asserts every clause of it.

**So neither SDK will ever emit an approve before a sell, and neither has an
"approve if needed" helper.** If you are reaching for one, something else is wrong —
most often an insufficient balance, which both SDKs report as exactly that.

(The token does have ordinary `approve`/`allowance`/`transferFrom` for everyone
else, and after migration the venue's canonical router is auto-approved for every
holder. That is a separate system from the curve's privilege, and confusing the two
is how you end up debugging an allowance that was never involved.)

## The fee split, and the share you must not pass

A flat **1%** on every buy and every sell, split five ways. The shares are in **basis
points of the fee, never of the trade**: a creator share of 3000 bps is 0.30% of the
trade, not 30% of it.

arcnow.io's own configuration, which is the default a launch gets:

| share | bps of the fee | of a trade | who sets it |
| --- | --- | --- | --- |
| creator | 3000 | 0.30% | the platform |
| platform | 2500 | 0.25% | **nobody — it is the residual** |
| ref | 1000 | 0.10% | the platform |
| dev | 1000 | 0.10% | the platform |
| ArcNow protocol | 2500 | 0.25% | the protocol admin only |
| | **10000** | **1.00%** | |

**The platform's own cut is never an input.** It is
`10000 - protocol - creator - ref - dev`, computed on demand. A platform allocates at
most **7500 bps** across creator, ref and dev, and whatever it does not allocate is
its own share. So `NewPlatform` in both SDKs **has no platform-share field**, and
that absence is the API telling you the truth about the contract.

Two things fall out of this, both deliberate:

1. Zeroing ref and dev moves those bps to the platform — the same rule that applies
   at swap time when a ref or dev *address* is `address(0)`. One rule, stated once.
2. The 7500 allowance is measured against the **maximum** protocol share, not the
   current one. A protocol admin lowering the protocol share widens every platform's
   cut automatically and can never invalidate a stored configuration.

Both SDKs validate the 7500 client-side before sending, and both expose the residual
as a pure helper so you can see your own cut without deploying anything.

One likely surprise, documented on the method in both languages: **registering a
platform is callable only by the registry's `protocolAdmin`.** An ordinary caller
gets `NotProtocolAdmin`.

## Graduation: nobody has to do anything

A curve retires **permanently** once its real reserve reaches its target. **That
target is not a protocol constant**: it comes from the platform's curve template,
which that platform's admin can change at any time, and each curve snapshots it at
launch and keeps it for life. Read it from the curve — `state().target` — never from
a number in a document. After that `graduated()` is true and every further buy and
sell reverts.

The buy that gets it there is capped at the curve's remaining inventory. Unspent native
USDC is **refunded** to the buyer (or credited to `pendingWithdrawal` if that transfer
fails); an unspent ERC-20 quote is simply **never pulled**. A quote tells you this is
coming: it carries both `refund` and `graduates`.

**That same graduating buy migrates the curve, in its own transaction**, under a
bounded gas budget with its failure caught. The buyer does not send a second
transaction. Nobody polls. Nobody calls anything.

**It needs gas room, and an estimate will not give it any.** `eth_estimateGas`
searches for the lowest limit at which a transaction still *succeeds*, and a
graduating buy or launch succeeds either way — the curve catches a starved
migration and logs `InstantMigrationFailed` rather than reverting. So the estimate
converges on exactly the limit that starves it, and the token graduates with no
market and no error anywhere. Observed on Arc testnet: an estimate of 6,250,146
against 5,452,572 used.

On a **buy**, pass `gasLimit` / `gas_limit` — 8,000,000 — whenever the quote says
`graduates`. On a **launch**, whose *initial buy* can reach the target on its own,
both SDKs send that limit themselves when `quoteLaunch` says so, and refuse an
explicit limit below **6,200,000**, which is too small for the migration.

Where the floor comes from: the curve forwards at most `INSTANT_MIGRATION_GAS_LIMIT`
(6,000,000) to the migrator and keeps `POST_MIGRATION_GAS_RESERVE` (100,000) back for
itself, and the SDKs add 100,000 on top — so the floor is sized for the heaviest venue
the contracts support (v3), not for v4. Re-measured on the version-2 stack, on an Arc
fork with receipts: a graduating buy uses 741,432 gas and migrates instantly only above
≈845,500; a launch whose initial buy graduates uses 5,298,297 and migrates instantly
only above ≈5,880,000. The floor clears that launch threshold by 5.4% and the
8,000,000 limit by 36%, so neither figure moved with the curve. Both results then report
`migratedInThisTransaction` / `migrated_in_this_transaction`, read from the
transaction's **own receipt** — by the time the chain could be asked, anyone could
have called `migrate()` and the answer would be to a different question.

`migrate()` exists and is **permissionless**, but it is the **retry path**, not the
normal one. When the instant migration succeeded it reverts with `AlreadyMigrated`.
When it failed — the curve logs `InstantMigrationFailed` — it stays open to anyone,
forwarding all remaining gas, so a stuck migrator can never strand a curve with no
way out.

Where a token graduates to is its curve's own snapshotted `migrator`, chosen at launch
and immutable from then on. **Ask the curve, not a network-wide list.** On Arc testnet
the answer is the Uniswap v4 migrator: v2 and v3 both need a wrapped-native token Arc
testnet does not publish, and arcnow-io/contracts refuses to default one, so neither
was deployed there. Afterwards the same 1% is charged by `ArcNowFeeHook` inside the
pool's swaps, in the pool's quote currency — and since a pool has no argument for a
referrer, the ref and dev shares follow the zero rule to the platform recipient every
time.

## Networks, and the mainnet gap

[`networks.json`](networks.json) is the single source of truth for both languages.
`scripts/sync-artifacts.sh` projects it into each SDK; `scripts/check-pins.sh` fails
when a projection drifts. Two SDKs each carrying their own address list would
eventually disagree about one address, in one language, on one chain, and nothing
would say which was right.

**`arc-testnet`** is filled in, from the contracts' deployment record, with the
contracts commit those addresses were deployed from. It lists its **quote tokens**:
native USDC and EURC, each with symbol, name and decimals, and EURC's
`allowanceSlot` (10) — the storage slot of its allowance mapping, used only to
state-override the router's allowance when pricing a pool buy with `eth_call`.
`quoteRegistry` is `null` until the multi-quote stack is deployed; both SDKs then ask
the launchpad (`quoteTokenRegistry()`, immutable) instead.

**A network has one stack.** `contracts` (with `contractVersions`, `contractsCommit`
and `deployedAtBlock`) is arcnow.io's stack on that chain: the one `launchpad`,
`platforms` and `migrators` talk to, so `migrators.list()` lists exactly the venues a
launch can pick. `contracts.v4Router` is the router graduated tokens trade through and
`v4.poolManager` the manager it serves. There is no `legacyStacks` key, and
`scripts/check-pins.sh` fails if one appears here or in the contracts' deployment
record.

**`arc-mainnet` exists and every address in it is `null`, on purpose.** Arc mainnet is
not somewhere arcnow.io is deployed. The entry is there rather than absent because
the three ways this can go are not equally bad:

- *absent* gets you "no such network", which reads as "the SDK is behind" and gets
  worked around by pasting addresses from somewhere;
- *plausible addresses* gets you a transaction to an account that does not exist;
- *present, complete in shape, null in every address* gets you an error that says
  exactly what is true.

So both SDKs **resolve** `arc-mainnet` and then **refuse to use it**, naming the
contracts that are missing and telling you to pass your own. No address anywhere in
this repository was invented. When arcnow.io deploys to a mainnet the values arrive
here from the deployment record, with the commit that produced them.

`null` means *not deployed on this chain*. It is not the zero address, which on Arc
is a real account that would send money nowhere at all.

Some contracts are legitimately null on a perfectly healthy chain — `escrowMigrator`,
`v2Migrator`, `v3Migrator` — and neither SDK treats their absence as a broken
deployment. `escrowMigrator` being null is the *better* state: it is the one custodial
contract in the system, and arcnow-io/contracts deploys it only where no venue
migrator could be built at all.

## The ABI pin

The ABIs under [`abi/`](abi/) are **copies**, generated in `arcnow-io/contracts` and
committed here so that building an SDK needs no Solidity toolchain.

A copy that drifts is the quiet failure this pin exists to prevent: an SDK encodes
calls from an ABI, and if that ABI stops describing the bytecode at the addresses in
`networks.json`, nothing fails loudly. A selector still hashes. A call still goes out.
It lands on a function that does something else, or on nothing, and surfaces weeks
later as a revert nobody can read in somebody else's application.

**One pin.** `abi/*.json` is the multi-quote build, pinned to arcnow-io/contracts
`327f45b` (the deployed multi-quote stack: #22's frozen ABI, #23's ERC-20 implementation,
the #24 follow-ups, and #26's deployment record), and a shape check that needs no
checkout requires its `BondingCurve.json` to have `y0Wad()`, `virtualTokenReserveWad()`,
`quoteToken()`, `quoteDecimals()`, `quoteScale()`, `targetQuoteWad()` and
`buyWithQuote()` and no `kWad()`, a `QuoteRegistry.json` with the registry's reads, and
vectors at `bonding-curve@3`. A second ABI directory beside `abi/external/` fails.

**The deployment may lag the ABIs, and the pin says so.** `pins.json`
`contracts.deployment.status` is `deployed` when the pinned ABIs are what is on chain,
as it is now, and `networks.json`'s `contractsCommit` must then equal the pin. While it
is `pending` — as it was while the multi-quote ABIs were ahead of the version-2 stack
deployed from `735db85` — `contractsCommit` must instead equal
`deployment.deployedCommit`, and the gate prints a warning on every run: the addresses in
`networks.json` are real, and both SDKs refuse them by `VERSION()`.

[`pins.json`](pins.json) records the commit and the SHA-256 of every ABI and vector
file. [`scripts/check-pins.sh`](scripts/check-pins.sh) enforces three things:

1. **Always** — every file under `abi/` and `vectors/` still hashes to what
   `pins.json` records, and the set has the multi-quote curve's shape.
   Catches a hand-edited ABI. Needs nothing but this checkout.
2. **Always** — the projections under `rust/src/generated/` and
   `typescript/src/generated/` are what `abi/` and `networks.json` say they should be.
   Catches a pin that moved without a re-sync, which would leave `pins.json`
   describing one set of bytes and both SDKs compiled against another.
3. **When an `arcnow-io/contracts` checkout is reachable** (`ARCNOW_CONTRACTS_DIR`)
   — the same files at the pinned commit *in that repository* still hash the same,
   and `networks.json` matches the deployment record `exports/addresses.json` at
   `pins.json`'s `addresses.commit`, address for address. This is the only check
   that can see what the other two cannot: that the recorded hashes belong to the
   commit named. Without a checkout it is **reported as not run**, never passed
   silently — a pin check that passes without checking anything is worse than none,
   because somebody will trust it.

It also says, as a note rather than a failure, when `arcnow-io/contracts` has moved
past the pin and whether the ABIs changed in the interval. A pin is supposed to lag;
reading that diff is a person's job.

**Moving the pin is a commit of its own.** Change `contracts.commit`, run
`scripts/sync-artifacts.sh`, run `scripts/preflight.sh`, and say in the message what
changed in the ABIs and what it meant for the SDKs. A regenerated ABI that nobody read
is how an SDK ends up encoding a function that no longer exists.

## Testing, and what a green run is worth

Both SDKs test against an **anvil fork of Arc testnet**, in a container, with the
multi-quote stack **deployed onto the fork** by
[`scripts/fork-deploy-stack.sh`](scripts/fork-deploy-stack.sh): the contracts' own
`DeployWithHook.s.sol`, compiled at the commit `pins.json` pins from a checkout named
by `ARCNOW_CONTRACTS_DIR`, broadcast with anvil's public development key — and refused
outright against anything that is not anvil. The live PoolManager, router and EURC
token are the fork's, inherited. The approach is `arcnow-io/e2e-tests`', and the
harnesses there are what these were adapted from.

```sh
./scripts/preflight.sh              # every gate, both languages
./scripts/preflight.sh --no-chain   # skip the fork; fast loop
./scripts/preflight.sh --rust       # one language at a time
```

`scripts/preflight.sh` **is** the gate. `.github/workflows/ci.yml` is
`workflow_dispatch:` only — the same decision every repository in this org has made,
for the same reason: the hosted runners are 2 vCPU and were the slowest part of the
loop. CI is kept and kept correct because it is still the definition of a full
verification against a clean checkout, which a local run cannot prove.

**What the fork suites do.** Both languages fork Arc testnet at the block `pins.json`
pins (`chain.fork_block_number`, overridable with `ARCNOW_SDK_FORK_BLOCK`), deploy the
multi-quote stack with arcnow.io's testnet template and EURC registered, launch a token
on it, buy and sell it on the curve with local maths, on-chain quote and fill agreeing
to the wei, graduate it (a launch sent at exactly the 6,200,000 floor migrates in its
own transaction), and trade its pool through the router under the fee hook — requiring
every reported quote fill to equal the trader's balance change to the wei, including on
a swap that pays out an earlier transaction's fee. They list the quote registry, read
EURC's metadata and allowance slot back off the real token, approve the real EURC
exactly once and send nothing the second time, and refuse the live version-2 platform
by name.

**ERC-20 quotes, always.** The pinned contracts implement native USDC and ERC-20
quotes, so the EURC launch, curve and pool journeys run on every fork run, beside the
native ones: an exact approve and no value on a EURC launch, the EURC pulled equal to
the total cost, a EURC curve buy and sell, and a EURC-quoted pool in whichever currency
order its address gives it, every fill equal to the EURC balance change.

**What a fork cannot prove.** A fork RE-EXECUTES transactions locally with anvil's
EVM, fetching the state it does not have. So it proves the SDKs against real contract
bytecode and real chain state, and it proves **nothing about Arc's own execution
semantics** — blocklisted transfers, EIP-1153, the EIP-7708 system emitter,
burn-to-zero are Arc's, not anvil's, and a fork will happily disagree with the live
chain about all of them without saying so. That gap wants a live-smoke layer this
repository does not have.

**Container hygiene.** Everything either suite starts carries the label
`io.arcnow.sdk.test=1` and is removed however the run ends — pass, fail, panic,
Ctrl-C. Nothing is ever removed that does not carry that label: the Docker daemon on a
development machine is shared, and a test suite that reaps other people's containers
is a worse problem than a leaked one.

## Examples

One per language, and a stranger with a funded Arc testnet key can run either:

```sh
export ARCNOW_PRIVATE_KEY=0x...        # your key, your funds, never committed
cd rust       && cargo run --example launch_and_trade
cd typescript && npm run example
```

Both do the whole arc — connect, quote a launch, launch, quote a buy, buy, read state,
quote a sell, sell, print the fee split — and both tell you what it will cost before
they spend anything.

**No example in this repository contains a key, a mnemonic or a credential of any
kind, and none ever will.** They read `ARCNOW_PRIVATE_KEY` from the environment and
say so when it is unset.

## Trading a graduated token, without the SDK

This section is the specification both SDKs implement, written so that a client
can reproduce it with nothing but JSON-RPC and an ABI encoder. If the SDKs and
this section ever disagree, one of them is a bug.

### Where the market is

A graduated token's bonding curve reverts `buy` and `sell` for good. Its liquidity
is in a Uniswap v4 pool inside arcnow.io's PoolManager,
`0x06110b57dd9b82DD846ee0325fB81B284E1C6dD0`, permanently. A v4 pool has no
address of its own — it is a `PoolId` inside that manager — which is why
`token.migratedPool()` and the `Migrated` event's `pool` return **the PoolManager,
identically for every token**. Never treat that address as a per-token pool.

Arc testnet has a second Uniswap v4 PoolManager (`0x9BEACCac…`) with a
third-party router bound to it. arcnow.io does not use either: its pools are not
there, and cannot be moved there.

### The router

Trades go through `UniswapV4Router04` from
[z0r0z/v4-router](https://github.com/z0r0z/v4-router) at commit `f5d5bfc`,
unmodified, deployed by arcnow.io against its PoolManager. Its address is
`contracts.v4Router` in `networks.json` (and in `arcnow-io/contracts`
`exports/addresses.json`).

- **While `contracts.v4Router` is `null`, no graduated token can be traded.** The
  deployment is deterministic — CREATE2 through Arc's factory, salt 0 — so it will
  land at `0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e`, but until code exists
  there a client must refuse, not call. Both SDKs refuse with `NoRouterDeployed`.
- Before trading a token, confirm the router serves the token's PoolManager: call
  `poolManager()` on the router and compare it with `poolManager()` on the token's
  migrator (`token.migrator()`). Different means the pool is unreachable through
  that router (`PoolUnreachable` in the SDKs).
- The router is **not** a registered canonical router. `token.canonicalRouter()`
  is `address(0)` on every arcnow.io token, so there is no standing allowance.

### The pool key

Read it from the token's migrator rather than hard-coding it:
`poolKey(address token)` (selector `0x55d1cb60`) on `token.migrator()` returns
`(currency0, currency1, fee, tickSpacing, hooks)`: the token and **its curve's quote
token, sorted by address**.

```text
currency0   min(quote, token)    native USDC is address(0), so always currency0
currency1   max(quote, token)    an ERC-20 quote (EURC) is either, by the token's address
fee         3000
tickSpacing 60
hooks       ArcNowFeeHook 3.x
```

and `poolId = keccak256(abi.encode(key))`. Take `hooks` from the key, never from a
list: it is the only address whose logs count for that pool. Define
`quoteIsCurrency0 = (currency0 == quote)`: **every direction and every leg below is
chosen by it**. With an ERC-20 quote roughly half of all pools put the token first, and
reading the key the wrong way round encodes a buy as a sell.

**v4 amounts are raw units of each currency.** 1 EURC is `1000000` in a swap argument,
a `BalanceDelta`, a `Swap` log and the hook's fee; both SDKs scale the quote leg by
`10^(18 − decimals)` to report WAD.

### Executing a trade

Both directions call `swapExactTokensForTokens(uint256 amountIn, uint256
amountOutMin, bool zeroForOne, PoolKey key, bytes hookData, address receiver,
uint256 deadline)` (selector `0xb1a0d571`). `hookData` is empty. `deadline` is a
unix timestamp in seconds. **`amountOutMin` is the slippage floor; never default it
to zero** — see `typescript/src/slippage.ts` for why. `amountIn` and `amountOutMin`
are raw units of their currencies.

- **Buy** (quote → token): `zeroForOne = quoteIsCurrency0`. Native USDC:
  `msg.value = amountIn`; the router settles the native leg from its own `msg.value`
  and refunds any excess to **`msg.sender`**, not to `receiver`. An ERC-20 quote:
  first `approve(router, amountIn)` on the quote token, then `msg.value = 0`; the
  router pulls it with `transferFrom`.
- **Sell** (token → quote): first `approve(router, amount)` on the token; then
  `zeroForOne = !quoteIsCurrency0`, `msg.value = 0`. The router pulls the tokens with
  `transferFrom(msg.sender, poolManager, amountIn)`, and pays the quote to `receiver`.
  Permit2 is not needed.

### Quoting: simulate the real swap

**There is no Quoter on Arc**, and computing the price off-chain from pool state
would be wrong: the migrator seeds two single-sided positions, anyone may add
liquidity, and a trade can cross ticks. So a quote is an `eth_call` of the exact
transaction the trader would send, against the real router, reading back what it
returns.

The call returns a `BalanceDelta` — one `int256` packing two `int128`s from the
**trader's** point of view:

```text
amount0 = int128(delta >> 128)   currency0, raw   negative = the trader pays
amount1 = int128(delta)          currency1, raw   positive = the trader receives
```

The quote leg is `amount0` when `quoteIsCurrency0`, `amount1` otherwise.

The trader has to be able to afford the call, and for a sell has to have approved
the router, so the simulation supplies both with **state overrides** (Arc's public
RPC supports them):

- **Buy**: native USDC — override the caller's native `balance` to at least
  `amountIn` (plus headroom for gas). An ERC-20 quote — override the quote token's
  allowance slot for `(caller, router)` (EURC's mapping is at slot **10**, so
  `keccak256(abi.encode(router, keccak256(abi.encode(caller, uint256(10)))))`), and
  let the caller actually hold the quote: the balance is not faked. `tokensOut` is the
  token leg.
- **Sell**: override the caller's balance, and the token's allowance storage slot
  so that `allowance(caller, router) >= amountIn`. `ArcToken` keeps `_allowance`
  at **storage slot 11**, so the slot is
  `keccak256(abi.encode(router, keccak256(abi.encode(caller, uint256(11)))))`. The
  seller must actually hold the tokens; only the allowance is faked.
  `quoteOut` is the quote leg. (Alternatively, approve first and simulate with no
  override.)

```json
{"method": "eth_call", "params": [
  {"from": "<trader>", "to": "<router>", "value": "<amountIn, buys only>",
   "data": "<swapExactTokensForTokens calldata, amountOutMin = 0>"},
  "latest",
  {"<trader>": {"balance": "0x<enough>"},
   "<token>":  {"stateDiff": {"<allowance slot>": "0x<amountIn, sells only>"}}}
]}
```

### How the hook's 1% appears in a quote

**It is already inside the numbers** — nothing is added. `ArcNowFeeHook` takes
arcnow.io's 1% on the **quote leg, in raw units**, during the swap, and the router's
`BalanceDelta` is the trader's delta *after* the hook's adjustment. To *show* the fee:

- **Buy**: the hook takes its cut off the input before the pool sees it. The
  trader pays `amountIn`, the pool swaps `amountIn − fee`, and
  `fee = floor(amountIn × 100 / 10000)`, in raw units. So for a 6-decimal quote a buy
  of fewer than 100 raw units (0.0001 EURC) is charged nothing — dust-level fee-free
  swaps, accepted by design.
- **Sell**: the pool pays `gross` and the hook keeps its cut out of it. The trader
  receives `quoteOut = gross − fee` with `fee = floor(gross × 100 / 10000)`, so to
  show the fee from a quote: `gross = quoteOut × 10000 / 9900`, then
  `fee = gross × 100 / 10000`, on raw units. That can read one unit under the fee
  actually taken, because it floors twice where the hook floors once.

Applying the buy formula to a sell under-reports the fee by 1% of itself.

### Reading the fill from the receipt

- **Tokens**: the token's `Transfer` logs (topic0 `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`).
- **The fee**: the hook's `HookFeeTaken(bytes32 indexed poolId, address indexed
  token, address indexed payer, address currency, uint256 feeAmount, bool onInput)`
  log, **emitted by the hook address**, `feeAmount` in raw units of `currency`. Match
  on `topics[1] == poolId` **and `currency == quote`**. **Do not match on `payer`**: it
  is whoever called the PoolManager — the router — not the trader. Sum matching logs
  rather than taking the first.
- **The quote, both sides — what both SDKs report**: the PoolManager's `Swap(bytes32
  indexed id, address indexed sender, int128 amount0, int128 amount1, uint160,
  uint128, int24, uint24)` log (topic0
  `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f`),
  **emitted by the PoolManager**, matched on `topics[1] == poolId`. It is emitted
  with the *pool's* delta — after `beforeSwap` resized the swap, before
  `afterSwap` subtracts the hook's delta from what the router settles — signed
  from the swapper's side. Its quote leg (`amount0` or `amount1`, by
  `quoteIsCurrency0`) minus the summed `feeAmount` is the trader's quote delta, exact
  to the raw unit: a buy paid `−leg + fee`, a sell received `leg − fee`. Not
  `amountIn` on a buy: the pool may not take it all.
- **Dust**: a trade too small for the fee to round above zero emits no
  `HookFeeTaken` at all. The fee is then zero and the `Swap` figure is still
  exact.
- **The hook pays later, and that changes nothing above.** It mints itself an
  ERC-6909 claim on the PoolManager in the quote currency (`accruedFee(poolId)`, raw,
  rises), logs `HookFeeTaken`, and redeems and splits the claims of **earlier**
  transactions at the start of the pool's next swap or when anyone calls
  `distributeFees(key)`, logging `FeesDistributed(bytes32 indexed poolId, address
  indexed caller, address currency, uint256 amount)`. The mint, burn and take all sit
  in the hook's own delta, never the trader's. Both SDKs report the distribution
  separately (`feesDistributed` / `fees_distributed`), never inside the fill.

### How each SDK says no

The two SDKs agree on when to refuse and on the two refusals that decide whether a
graduated token can trade at all. They do **not** yet agree on the names of every
other error, and a caller switching on error names needs this table rather than an
assumption that the languages match:

| condition | TypeScript `ArcNowError.code` | Rust `Error` |
| --- | --- | --- |
| `contracts.v4Router` is `null`: no router on this network | `NoRouterDeployed` | `NoRouterDeployed` |
| the token's pool is in a PoolManager the router does not serve | `PoolUnreachable` | `PoolUnreachable` |
| the token has not graduated, so it has no pool | `PoolNotMigrated` | `TokenNotMigrated` |
| a sell with too small an allowance to the router | `InvalidArgument` | `RouterApprovalRequired` |
| an option that does not apply to the venue (e.g. `recipient` on a curve trade) | `InvalidArgument` | `VenueMismatch` |
| a zero amount | `InvalidArgument` | `ZeroAmount` |
| the router's slippage floor was not met | decoded router revert `SlippageExceeded()` | `PoolSlippageExceeded` |
| the router's deadline had passed | decoded router revert `DeadlinePassed(uint256)` | `PoolDeadlineExpired` |
| an address handed in as a curve that is not one — its `VERSION()` names another contract (a token answers `arcnow/arc-token@1.0.0`), or it has none | `AddressIsNotACurve` | `AddressIsNotACurve` |
| a **migrator** refusing a caller that is not one of its factory's curves — the contract's own `NotACurve(address)` revert | `NotACurve`, decoded | `NamedRevert { name: "NotACurve" }` |
| a curve whose `VERSION()` is `arcnow/bonding-curve@` with any major but 3 (the version-2 curve and `@1.x.x` included), or malformed | `UnknownCurveVersion` | `UnknownCurveVersion` |
| a platform, registry or quote registry that is not `platform-config@3.x.x` / `platform-registry@3.x.x` / `quote-registry@1.x.x` | `UnknownCurveVersion` | `UnknownCurveVersion` |
| a pool whose fee hook's `VERSION()` is not `arcnow/arc-now-fee-hook@3.x.x`, on `accruedHookFee` / `distributeHookFees` | `UnknownHookVersion` | `UnknownHookVersion` |
| an amount in a quote other than the curve's, pool's or launch's, or arithmetic across two quotes | `QuoteTokenMismatch` | `QuoteTokenMismatch` |
| an ERC-20 amount with dust below one raw unit, refused before sending | `QuoteAmountNotRepresentable` | `QuoteAmountNotRepresentable` |
| v4's `WrappedError(address,bytes4,bytes,bytes)` (`0x90bfb865`) around a hook or pool revert | the **inner** error's code, with the wrapper in `details.wrappedBy` | the **inner** error |
| a `WrappedError` whose inner revert is empty or in no pinned ABI | `WrappedRevert` | `WrappedRevert` |

**Two `WrappedError` layers are normal, not a decoding slip.** v4-core wraps a failed
hook call as `WrappedError(hook, <callback selector>, reason, HookCallFailed())`, and
a failed native transfer *inside* that call as `WrappedError(recipient, 0x00000000,
reason, NativeTransferFailed())` (an ERC-20 transfer as `ERC20TransferFailed()`). Both
SDKs name the inner layer a native or ERC-20 transfer, and say that the PoolManager
could not pay the recipient; unit tests pin the decoding against constructed bytes.

The first two rows are the ones that were pinned across both languages; the rest
predate that and should converge on the Rust names.

## Licence

**GPL-3.0-or-later.** The full text is in [`LICENSE`](LICENSE), and both manifests
carry the `GPL-3.0-or-later` identifier so `cargo` and `npm` say the same thing the
file does.

This is a **copyleft** licence, chosen deliberately: anyone may use, study, modify and
redistribute these SDKs, and a modified version distributed to others must be offered
under the same terms with its source available. The point is that improvements to the
way people talk to this platform stay available to everyone who uses it.

Two consequences worth stating plainly rather than letting somebody discover them:

- **Linking matters.** The GPL's reciprocity reaches software that links these SDKs,
  not just software that edits them. An application built on `arcnow-sdk` or
  `@arcnow/sdk` and distributed to others is expected to be GPL-compatible. If you
  need to build something proprietary on top of arcnow.io, talk to the contracts
  directly — they are a public interface on a public chain and nothing here is
  required to reach them.
- **This is not the contracts' licence.** The Solidity in `arcnow-io/contracts`
  carries `SPDX-License-Identifier: MIT` throughout. That is a different repository
  under different terms, and the ABIs and addresses vendored here describe contracts
  that anybody may interact with regardless of this licence.

`arcnow-io/mcp` carries its own MIT `LICENSE` and is not covered by this one.
