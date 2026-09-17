# arcnow-sdk

Launch, trade and read [arcnow.io](https://arcnow.io) bonding-curve tokens on
[Arc](https://docs.arc.io/), by talking to the contracts over JSON-RPC. No
arcnow.io backend is involved and none is needed.

Install from crates.io — [`arcnow-sdk`](https://crates.io/crates/arcnow-sdk):

```sh
cargo add arcnow-sdk
```

```toml
[dependencies]
arcnow-sdk = "0.1"
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
```

Every release is tagged `vX.Y.Z` on
[arcnow-io/arcnow-io-sdk](https://github.com/arcnow-io/arcnow-io-sdk), with the
`.crate` under its GitHub Release. To build from source, depend on the public
repository at a tag — never a floating branch, which is a dependency that can
change under you; Cargo finds the crate inside the repository:

```toml
arcnow-sdk = { git = "https://github.com/arcnow-io/arcnow-io-sdk", tag = "v0.1.3" }
```

Rust `1.97.1`, edition 2024, pinned in `rust-toolchain.toml`. Built on
[`alloy`](https://alloy.rs) `2.4.2`, re-exported as `arcnow_sdk::alloy` so you
never have to guess which version a signature wants.

---

## The one fact to get right

**On Arc, USDC is the native gas currency and `msg.value` is 18 decimals.**

The USDC ERC-20 interface predeploy at
`0x3600000000000000000000000000000000000000` is the *same asset* reporting **6**
decimals. It does not pay for gas, and no arcnow.io contract reads, writes,
calls or imports it. The two raw representations of one dollar differ by `1e12`.

Every amount in every arcnow.io signature, event, error and storage slot is an
18-decimal fixed-point integer. There is no 6-decimal number anywhere in the
contracts, and there is none anywhere in this crate's call path either.

So there are three types and they do not convert into one another by accident:

| type | decimals | what it is |
| --- | --- | --- |
| `Usdc` | 18 | native USDC. The **only** type any value-bearing API here accepts. |
| `Tokens` | 18 | a launched token's quantity. Distinct so it cannot be paid as money. |
| `UsdcErc20` | 6 | the same USDC through the ERC-20 interface. **Edge only.** |

**There is no `From<u64>` on any of them.** A bare integer does not say which
scale it is in, and a constructor that guesses is wrong half the time and silent
about it. Every way in names its scale:

```rust
use arcnow_sdk::{Usdc, Tokens, UsdcErc20};

Usdc::from_whole(50);                        // fifty dollars
Usdc::parse("1.25").unwrap();                // exact; 19 decimals is an error, not a round
Usdc::from_wad(some_u256);                   // a number that was already a wad

// The edge, and only the edge. Conversions are named and one of them truncates.
let six = UsdcErc20::parse("1.25").unwrap(); // what a wallet reported
let native = Usdc::from_erc20(six);          // exact, * 1e12
let back = native.to_erc20();                // TRUNCATES towards zero
```

`to_erc20` truncates because a wad amount can carry dust six decimals cannot
express, and rounding up would promise dollars that do not exist. Use it to
*display* a figure; never to decide what to send.

**`Bps` is basis points of the fee, not of the trade.** A creator share of 3000
bps is 30% of the 1% fee and **0.30% of a trade**. `Bps::of_fee` and
`Bps::of_trade` say which framing you meant, and `of_trade_equivalent` converts:

```rust
use arcnow_sdk::Bps;
assert_eq!(Bps::of_fee(3_000).of_trade_equivalent(Bps::of_trade(100)), Bps::of_trade(30));
```

---

## Connect

Reading needs no key at all.

```rust
use arcnow_sdk::{Client, Network};

let client = Client::builder().network(Network::ArcTestnet).build().await?;
```

Writing needs one. A write on a read-only client fails with
`Error::SignerRequired`, naming the method, **before any RPC happens**.

```rust
use alloy::signers::local::PrivateKeySigner;

let signer: PrivateKeySigner = std::env::var("ARCNOW_PRIVATE_KEY")?.parse()?;
let client = Client::builder().network(Network::ArcTestnet).signer(signer).build().await?;
```

The preset's own endpoint is public and rate-limited. Point it at yours, keeping
the preset's addresses — which is also how you talk to a local fork:

```rust
let client = Client::builder()
    .network(Network::ArcTestnet)
    .rpc_url("http://127.0.0.1:8545")
    .build()
    .await?;
```

Building from your own addresses is a first-class path, not a fallback:

```rust
use arcnow_sdk::{ContractAddresses, NetworkConfig, Network};

let contracts = ContractAddresses { launchpad: Some(addr), ..Default::default() };
let config = NetworkConfig::custom("my-chain", 5_042_002, "http://…", contracts);
let client = Client::builder().network(Network::Custom(Box::new(config))).build().await?;
```

### The mainnet gap, on purpose

`Network::ArcMainnet` **resolves** and then **refuses**, naming the contracts
that are missing:

```text
the arc-mainnet preset resolves and has no deployment behind it: launchpad,
tokenFactory, curveFactory, migratorRegistry, platformRegistry, arcnowPlatform
are not deployed there. Nothing in this crate will invent an address for a chain
it has not been told about, and the zero address is a real account on Arc that
would send money nowhere. Either target arc-testnet, or build a client from
Network::Custom with the addresses you know.
```

That is deliberate. An absent preset gets you a "no such network" error, which
reads as "the SDK is behind" and is worked around by pasting addresses from
somewhere. A preset with plausible addresses gets you a transaction to an account
that does not exist. This gets you the truth.

`null` in `networks.json` means **not deployed on this chain**, and on Arc
testnet `escrowMigrator`, `v2Migrator` and `v3Migrator` are null because the
chain genuinely offers none of them — not because nobody filled them in.

---

## Read

```rust
let curve = client.curve(curve_address);
let state = curve.state().await?;          // one batched read, not eleven round trips

println!("{} of {} USDC raised ({}%)", state.real_reserve, state.target,
         state.progress_bps.percent_string());
println!("spot {} USDC per token, {} tokens left", state.spot_price, state.tokens_remaining);
println!("graduates to {}", state.migrator);
```

`spot_price` is the marginal price of the next infinitesimal token. **It is not
the price a trade of any size fills at** — the curve integrates along its own
slope, so a buy pays a rising price across its own order. Quote instead.

### One curve

Every arcnow.io bonding curve is the constant-product curve,
`arcnow/bonding-curve@2.x.x`: `k = r0 · y0`, `Y = y0 − sold`,
`C(Y) = ceil(k / Y)`, and `state.params` is `CurveParams { r0_wad, y0_wad }`.

**Any other version is refused, never priced.** `curve.state()`, `params()`,
`quote_buy`/`quote_sell`, `buy`/`sell`/`migrate` all read `VERSION()` first, and a
bonding curve of another version — the retired linear `@1.x.x` included, or a
future `@3.x.x` — is `Error::UnknownCurveVersion { version }`, before any maths
and before any trade is sent.

**An address that is not a bonding curve at all is a different refusal.** A token
(`arcnow/arc-token@1.0.0`), any other arcnow.io contract, or an address that
answers no `VERSION()` — no code, or not arcnow.io's — is
`Error::AddressIsNotACurve { address, version }`, whose message names what the
address says it is (for a token: use `Token::curve()`, or `Client::trade`). A
resolver handed an address a user pasted can branch on it and try the address as
a token. It is deliberately not spelled `NotACurve`: that is a migrator's own
contract revert, which still decodes as `Error::NamedRevert { name: "NotACurve" }`.

```rust
use arcnow_sdk::{CurveSnapshot, curve_math};

let state = curve.state().await?;
println!("Y0 = {}, R0 = {}", state.params.y0_wad, state.params.r0_wad);

// The chain's quote, and the same integers locally with no round trip per number.
let chain = curve.quote_buy(Usdc::from_whole(5)).await?;
let local = curve_math::quote_buy(&CurveSnapshot::from_state(&state), Usdc::from_whole(5).to_wad())?;
assert_eq!(chain.tokens_out.to_wad(), local.tokens_out_wad);
```

`curve_math` is the contracts' `CurveMath` and `CurveQuote`, ported in integers
and held **to the wei** against every row of `../vectors/vectors.json` by
`tests/vectors.rs`. `curve.quote_buy_local`/`quote_sell_local` are the
convenience form.

---

## Launch

```rust
use arcnow_sdk::{LaunchParams, Usdc, Bps};

let params = LaunchParams::new("Example", "EXMPL", "ipfs://Qm…")
    .initial_buy(Usdc::from_whole(10));

let launchpad = client.launchpad()?;
let quote = launchpad.quote_launch(&params).await?;

// total_cost is the EXACT msg.value the launch requires. Not "at least":
// overpaying reverts as readily as underpaying, because the launchpad has no
// refund path and a launch is the wrong place to invent one.
println!("costs exactly {} ({} of it the 1% trade fee on the initial buy)",
         quote.total_cost, quote.trade_fee);

let params = params.min_tokens_out(quote.tokens_out.less_tolerance(Bps::of_trade(50)));
let launched = launchpad.launch(&params).await?;
println!("token {} curve {}", launched.token, launched.curve);
```

**The initial buy is an ordinary buy.** It pays the 1% trade fee on top of the
flat launch fee; there is no fee-free entry into the curve. `quote_launch`
reports the two charges separately so you can name both.

`predict_addresses` gives the token and curve a launch *would* produce. It is
pure prediction and is valid **only** for that creator's current launch nonce and
exactly those parameters.

`params.platform` defaults to the network's `arcnowPlatform` — arcnow.io's own
platform, the default and not a privileged singleton. `params.migrator` defaults
to the platform's own, which is what almost every launch does.

---

## Trade

```rust
use arcnow_sdk::{BuyRequest, SellRequest, Deadline, Bps};

let quote = curve.quote_buy(Usdc::from_whole(25)).await?;
let filled = curve.buy(
    BuyRequest::new(Usdc::from_whole(25), quote.min_tokens_out(Bps::of_trade(50)))
        .deadline(Deadline::in_minutes(5))
).await?;
```

`usdc_in` **is the transaction's value.** There is no allowance and no token
transfer from the buyer.

`min_tokens_out` and `min_usdc_out` are required arguments, not optional ones
defaulting to zero. Passing zero on a public mempool is a donation.
`quote.min_tokens_out(tolerance)` and `quote.min_usdc_out(tolerance)` derive one.

`Deadline::in_minutes(5)` is the sensible default. `Deadline::none()` opts out,
and opting out lets a transaction be held back and executed at a much later
price.

### Selling to a curve needs no approval. Ever.

```rust
let quote = curve.quote_sell(amount).await?;
curve.sell(SellRequest::new(amount, quote.min_usdc_out(Bps::of_trade(50)))).await?;
```

That is the whole sell. There is no approve step and this crate never emits one.

The curve pulls tokens with `IArcToken.curveTransferFrom`, a privileged path
callable only by the token's own curve, which **reads no allowance at all**. A
holder who has approved nobody can sell; an allowance granted to the curve is not
spent by a sell and is still there afterwards; an approved spender still cannot
use the curve's path. It is a deliberate, tested guarantee, and the forked-chain
test in this crate asserts the allowance is zero before and after.

The token *does* have ordinary `approve`/`allowance`/`transferFrom` for everyone
else — routers, other spenders — and after migration the venue's canonical
router, *where one was registered*, is auto-approved over every holder. That is a
separate system from the curve's privilege and the two must not be confused.

**Uniswap v4 registers none**, so on every arcnow.io token `canonicalRouter()` is
`address(0)` and stays that way. A sell **after** graduation therefore does need
an approval — see [Trading after graduation](#trading-after-graduation). The
guarantee above is about the curve, and only about the curve.

---

## Create a platform

```rust
use arcnow_sdk::{NewPlatform, CurveTemplate, Bps, platform_share_bps};

let platform = NewPlatform {
    admin, fee_recipient,
    creator_share_bps: Bps::of_fee(3_000),
    ref_share_bps: Bps::of_fee(1_000),
    dev_share_bps: Bps::of_fee(1_000),
    default_migrator,
    curve: CurveTemplate::arcnow_defaults(),
};
platform.validate()?;                       // refused client-side, before sending
let (address, tx) = client.platform_registry()?.register_platform(&platform).await?;
```

**`NewPlatform` has no platform-share field, and that is the point.** The
platform's own cut is the **residual**: `10000 - protocol - creator - ref - dev`,
computed on demand and never an input anywhere in the contracts. A platform
allocates at most **7500 bps** across creator, ref and dev, and whatever it does
not allocate is its own.

The 7500 is measured against the protocol's **maximum** share (2500), not its
current one, so a protocol admin lowering their cut widens every platform's
residual and can never invalidate a stored configuration.

```rust
// See your own cut without deploying anything.
let mine = platform_share_bps(Bps::of_fee(3_000), Bps::of_fee(1_000), Bps::of_fee(1_000),
                              Bps::of_fee(2_500));
assert_eq!(mine, Bps::of_fee(2_500));
```

**`register_platform` is callable only by the registry's `protocolAdmin`.** An
ordinary caller gets `Error::NotProtocolAdmin`. This is the single most likely
surprise in this API.

**A curve template is not a constant, and this crate treats it as one nowhere.**
It is per-platform state, replaceable by that platform's admin in a single
transaction, and snapshotted immutably onto every curve at launch. Ask
`client.platform(addr).curve_parameters()` what a **new launch** will get, and
`client.curve(addr).state()` what an **existing token** got — arcnow.io's
platform moved on 2026-09-13, total supply from 1e9 to 1e6 and the target from
50,000 USDC to 50, and a curve launched before that keeps the old one for as long
as it exists.

**A template is `y0`-shaped.** `CurveTemplate` carries `total_supply`,
`curve_supply`, `y0`, `r0`, `target` and `initial_price`. `curve_parameters()`,
`check_curve_parameters` and `register_platform` read the contract's `VERSION()`
first and refuse anything but `arcnow/platform-config@2.x.x` /
`arcnow/platform-registry@2.x.x` with `Error::UnknownCurveVersion` before encoding
anything.

`CurveTemplate::arcnow_defaults()` is a **reference snapshot** of arcnow.io's
platform, for the one job a live read cannot do: seeding a platform of your own:
1e6 total supply, 790,931.78 on the curve (79.09%), a 50 USDC target, `Y0` and
`R0` placed so that the 209,068.22 tokens held back are exactly what 50 USDC buys
at the last price of 0.000239156382570519. `CurveTemplate::reference()` is the
contracts' 1e9 / 50,000 USDC reference at the same prices. **Do not re-derive
either in floating point** — a recomputation is refused by `PlatformConfig` with
`PoolReserveMismatch`. The values live in `../curve-templates.json`, one copy for
both SDKs, and `../scripts/check-template.sh` reads the live platform and
**fails** on any difference.

Check a candidate of your own with
`client.platform(addr).check_curve_parameters(&template)`, which reverts naming
the relationship that failed. **It cannot tell you a template is current**, only
that it is self-consistent — the 1e9 template passes it on the live chain today,
which is exactly why the drift went unseen.

---

## Graduation

A curve retires **permanently** once it has collected its target in *real*
reserve — `state.target`, its own, snapshotted at launch. `state.graduated` is then true and
every further buy and sell reverts with `Error::CurveGraduated`. There is no
admin who can reopen it.

**The graduating buy migrates the curve itself, in the same transaction**, under
a bounded gas budget with its failure caught. Nobody has to poll and nobody has
to send a second transaction.

```rust
let quote = curve.quote_buy(amount).await?;
if quote.graduates {
    println!("this fills the curve; {} comes back as a refund", quote.refund);
    // An ESTIMATED gas limit is precisely the limit at which the migration does
    // not fit, because the buy succeeds either way and eth_estimateGas returns
    // the cheaper run. Give a graduating buy room.
    curve.buy(BuyRequest::new(amount, quote.min_tokens_out(tol)).gas_limit(8_000_000)).await?;
}
```

The buy that fills the curve is **capped at remaining inventory** and the unspent
USDC is **refunded** — or credited to `pending_withdrawal` if that transfer
fails. `BuyQuote::refund` and `BuyQuote::graduates` let you see it coming.

**A launch can graduate too, and there the SDK sets the limit for you.** The
target is whatever the platform's live template says — 50 USDC on arcnow.io's
own — so an *initial buy* can reach it, and the launch then deploys a token,
graduates it and attempts its migration in one transaction. That happened on Arc
testnet with an estimated limit: `InstantMigrationFailed` was logged and no pool
was created. So `launch` does not leave it to the caller.

The figures: the floor is `INSTANT_MIGRATION_GAS_LIMIT` 6,000,000 +
`POST_MIGRATION_GAS_RESERVE` 100,000 + 100,000 of margin. Measured on an Arc
fork, a graduating launch used 5,298,297 and migrates instantly only above
≈5,880,000 (the floor clears it by 5.4%, the 8,000,000 default by 36%); a
graduating buy used 741,432 and migrates only above ≈845,500. `tests/fork.rs`
sends a graduating launch at exactly the floor and requires it to migrate.

```rust
let quote = launchpad.quote_launch(&params).await?;
if quote.graduates {
    // launch() sends GRADUATION_GAS_LIMIT (8,000,000) by itself here, and
    // REFUSES an explicit gas_limit below GRADUATION_GAS_FLOOR (6,200,000) —
    // a limit that does not make the launch fail, only do half the job.
}
let launched = launchpad.launch(&params).await?;
launched.migrated_in_this_transaction;  // read from the launch's OWN receipt
```

`LaunchResult` carries `graduated`, `instant_migration_failed`,
`migrated_in_this_transaction` and `pool`, exactly as `BuyResult` does, all read
from the launch's own receipt — a later read of the chain answers a different
question, because `migrate()` is open to anyone in between.

`curve.migrate()` is **permissionless** and is the **retry** path, not the normal
one. When the instant migration succeeded it reverts with
`Error::AlreadyMigrated`; when it failed — the curve logged
`InstantMigrationFailed` — it stays open to anyone, so a stuck migrator can never
strand a curve.

Where a curve graduates *to* is its own snapshotted `state.migrator`, chosen at
launch and immutable. On Arc testnet that is the Uniswap v4 migrator; v2, v3 and
escrow are not deployed there. **Ask the curve, not a network-wide list.**

After migration the same 1% is charged by `ArcNowFeeHook` inside the v4 pool's
swaps, still denominated in native USDC. Ref and dev have no address in a pool,
so both shares follow the zero rule to the platform recipient.

---

## Trading after graduation

`Trade` is the front door. It reads which venue a token is at and dispatches,
because the two are genuinely different calls:

```rust
use arcnow_sdk::{Deadline, PoolBuyRequest, PoolSellRequest, Venue};

let trade = client.trade(token);
let quote = trade.quote_buy(Usdc::from_whole(25)).await?;      // curve or pool
match quote.venue() {
    Venue::Curve => { /* BuyRequest, as above */ }
    Venue::Pool  => {
        let floor = quote.min_tokens_out(Bps::of_trade(50));
        trade.buy(PoolBuyRequest::new(Usdc::from_whole(25), floor, Deadline::in_minutes(5))).await?;
    }
}
```

A request built for the wrong venue is refused with `Error::VenueMismatch`
rather than quietly reshaped. `client.pool(token)` is the venue itself when you
already know.

### A v4 pool has no address

It is a `PoolId` inside **one** `PoolManager`'s storage. `migratedPool()` and the
`Migrated` event both return that **manager**, identically for every token on a
deployment, because there was nothing else to record. Read it as "has this
migrated", never as a per-token pool. What identifies the market is `pool.key()`,
which this crate reads from the token's own migrator — never assembled from
constants, because a key that is wrong in any field hashes to a `PoolId` that
does not exist.

### A quote is the swap, simulated

No quoter is deployed on Arc, and off-chain tick maths would be wrong anyway: the
migrator seeds two single-sided positions and anyone may add more. So
`quote_buy`/`quote_sell` `eth_call` the **real swap** against
`UniswapV4Router04` and read back the `BalanceDelta` it returns — the trader's
own delta, with the hook's 1% already inside it. State the call does not have (a
balance to pay with, an allowance to be pulled from) comes from `eth_call` state
overrides. The fee is then *derived*, never added on:

* **buy** — the pool sees 99% of what the trader pays, so `fee = usdc_in / 100`.
* **sell** — the trader sees 99% of what the pool pays, so
  `gross = usdc_out * 10000 / 9900` and `fee = gross / 100`.

### What a settled trade reports, and from where

`PoolTradeResult` is read out of the transaction's **own logs**, the one source
nothing else in the block can move, and every figure in it is **exact to the
wei**:

* `tokens` — the token's own `Transfer` logs in that receipt.
* `fee_usdc` — every `ArcNowFeeHook.HookFeeTaken` from the pool key's hook with
  this pool's `PoolId`. Zero when there is none, which is exactly right: a trade
  too small to be charged is charged nothing and logs nothing.
* `usdc` — the `PoolManager`'s own `Swap` log for this `PoolId`, with the fee put
  back: `|Σ Swap.amount0 − Σ feeWad|`.

Why that is the trader's figure, from v4-core `e50237c4` (`PoolManager.swap`):
`beforeSwap` resizes the swap by the hook's specified delta, `_swap` emits
`Swap` with the **pool's** delta, and only afterwards does `afterSwap` subtract
the hook's delta from what the router settles. `amount0` is signed from the
swapper's side — negative for USDC into the pool — and the hook's fee is always a
positive `currency0` delta: a buy of 1 USDC with a 0.01 fee logs `−0.99`.

Neither `HookFeeTaken.payer` nor `Swap.sender` is matched on: both are the
router. And a buy's `usdc` is read, not assumed to be `amountIn` — the router
refunds whatever the pool did not take. `tests/pool_fork.rs` holds every `usdc`
to the trader's native balance change with the receipt's gas put back, on both
sides and for trades too small to be charged.

### The fee hook pays later, and the fill is still exact

Every arcnow.io pool carries `ArcNowFeeHook` `arcnow/arc-now-fee-hook@2.x.x`. It
charges 1% and emits `HookFeeTaken` in the swap, but it mints the fee to itself
as a `PoolManager` claim and pays out only claims from an **earlier**
transaction: at the pool's next swap, logged as `FeesDistributed`, or when anyone
calls `pool.distribute_hook_fees()`. `pool.accrued_hook_fee()` is what is
waiting. The distribution is the hook's own `burn` and `take`, so it does not
touch the trader's delta: `PoolTradeResult::fees_distributed` reports it, and
`usdc` still excludes it.

`pool.hook_version()` reads the hook's `VERSION()`. `accrued_hook_fee` and
`distribute_hook_fees` refuse any hook that is not `@2.x.x` with
`Error::UnknownHookVersion { hook, version }` before anything is sent.

`tests/pool_fork.rs` holds a buy, a later sell that distributes the buy's fee, a
bystander's `distribute_hook_fees` and dust trades each to the trader's native
balance, to the wei.

### Selling here *does* need an approval

```rust
let pool = client.pool(token);
if pool.router_allowance(me).await? < amount {
    pool.approve_router(Tokens::MAX).await?;     // transaction one
}
let quote = pool.quote_sell(amount, me).await?;  // works before the approval
pool.sell(PoolSellRequest::new(amount, quote.min_usdc_out(tol), Deadline::in_minutes(5))).await?;
```

The router pulls the token leg with `transferFrom` and nothing auto-approves it.
`Pool::sell` reads the allowance and refuses with
`Error::RouterApprovalRequired` before sending, rather than producing a reverted
transaction whose message is about a failed ERC-20 call. A *quote* needs no
approval: the allowance it would need is a state override.

### The router: arcnow.io's own, and live

arcnow.io stays on its **own** Uniswap v4 `PoolManager`,
`0x06110b57dd9b82DD846ee0325fB81B284E1C6dD0`, and deploys its own router against
it. Arc testnet also carries an unrelated `PoolManager` with a third-party router
bound to it; arcnow.io uses neither. Every graduated token has its liquidity in
`0x06110b57…` permanently (the positions are burned and the migrator is
immutable), so a second manager would only split liquidity across two disjoint
markets. A router bound to our manager serves every graduated token.

That router is `UniswapV4Router04` from
[z0r0z/v4-router](https://github.com/z0r0z/v4-router) at
`f5d5bfc2d70c56eb27cd645467e89f074d95660a`, unmodified, deployed by
`arcnow-io/contracts` `script/DeployV4Router.s.sol` through Arc's CREATE2 factory
with salt zero. That puts it at `0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e`,
where it is live on Arc testnet and named by `contracts.v4Router`. The SDK
behaves as follows:

* **No router configured.** Every pool quote and trade — and `router_allowance`
  and `approve_router` — returns `Error::NoRouterDeployed { chain_id }` before
  any RPC. `pool.is_reachable()` returns `Ok(false)`. The key, pool id and
  manager are still readable.
* **A router configured.** The SDK reads the router's immutable `poolManager()`
  and compares it with the token's migrator's. If they match, the pool trades. If
  not, it returns `Error::PoolUnreachable { token, pool_manager, router,
  router_pool_manager }` instead of a swap that answers `PoolNotInitialized()`.
  With arcnow.io's own router that should not happen for an arcnow.io token.

A different router — on a chain the presets do not cover, say — goes in through
`Network::Custom`:

```rust
let mut config = Network::ArcTestnet.config().clone();
config.contracts.v4_router = Some(router);
let client = Client::builder().network(Network::Custom(Box::new(config))).build().await?;
```

`client.migrator_registry()?.list()` asks the same question per venue, one step
earlier, which is what a launch-time venue chooser needs. For a v4 migrator,
`reachable` is `true` only when a router is configured and that router serves
the migrator's `poolManager()`, and `false` when no router is configured. A
migrator with no `poolManager()` is always `true`:

```rust
for venue in client.migrator_registry()?.list().await? {
    println!("{} {} {}", venue.address, venue.label, if venue.reachable { "" } else { "(UNREACHABLE)" });
}
```

---

## Error handling

One error type: `arcnow_sdk::Error`. Every custom Solidity error in **every**
pinned ABI is decoded by selector, carries its parameters, and has a message that
says what to do.

```rust
use arcnow_sdk::Error;

match curve.buy(request).await {
    Ok(filled) => { /* … */ }
    Err(Error::CurveGraduated) => { /* trade at state.migrator instead */ }
    Err(Error::SlippageExceeded { min_out, actual_out }) => { /* re-quote */ }
    Err(Error::DeadlineExpired { .. }) => { /* nothing traded; send it again */ }
    Err(other) => eprintln!("{other}"),
}
```

The decoder covers all thirteen ABIs, not just the one being called: a launch
touches six contracts in one transaction and can fail in any of them, and a
graduating buy calls a migrator. It also handles the three non-custom shapes —
`Error(string)`, `Panic(uint256)` and empty revert data, which usually means an
out-of-gas or a call to an address with no code rather than a deliberate revert.

An error that is in an ABI but has no dedicated variant arrives as
`Error::NamedRevert` with its name, full signature and decoded arguments. A
selector in no ABI arrives as `Error::UnknownRevert`, printing the selector
plainly so it can be looked up. `CurveNotPriceable`'s second field is `y0`.

**Uniswap v4's `WrappedError` is unwrapped.** The `PoolManager` wraps every hook
revert as `WrappedError(address target, bytes4 selector, bytes reason, bytes
details)` (`0x90bfb865`). The decoder returns the **inner** error whenever it is a
custom error in a pinned ABI, an `Error(string)` or a `Panic` — recursively, so a
wrapped wrapper is unwrapped too — and `Error::WrappedRevert { target, selector,
reason, details }`, naming the contract that failed, only when the inner revert is
empty or in no ABI.

A `WrappedRevert` with selector `0x00000000` and `NativeTransferFailed()` as its
`details` is v4-core's `Currency.transfer` failing a native payment, and it is a
**genuine** layer, not a decoding artefact:
`WrappedError(hook, beforeSwap, WrappedError(hook, 0x00000000, "",
NativeTransferFailed()), HookCallFailed())` is a hook whose callback made the
`PoolManager` pay native USDC it did not have, or pay an address that refused it.
The message says so and says a smaller trade may succeed; `tests/errors.rs`
decodes exactly those bytes.

Refusals that happen **before anything is sent** — and therefore cost nothing —
are `SignerRequired`, `NetworkNotDeployed`, `ContractNotDeployed`,
`ChainIdMismatch`, `FeeSharesExceedAllowance`, `UnknownCurveVersion`,
`AddressIsNotACurve` (from a version string) and `UnknownHookVersion`.

---

## The worked example

```bash
ARCNOW_PRIVATE_KEY=0x… cargo run --example launch_and_trade
```

Connect, quote a launch, launch, quote a buy, buy, read the curve, quote a sell,
sell, print the fee split. It reads the key from the environment and from nowhere
else, says so in its output, prints what the whole thing will cost before
spending anything, and contains no credential of any kind.

---

## Running the tests

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo build --all-targets
cargo test                       # unit tests; forked tests skip with no Docker
```

The unit tests need no chain: the amount types and their decimal conversions, the
residual fee arithmetic, the network presets, revert decoding and the variant
collision guard, and the curve's maths against every row of the vector file
(`tests/vectors.rs`).

`tests/fork.rs` runs the whole journey against the **real Arc testnet
deployment** on an anvil fork of it, at the block `../pins.json` pins — connect
and check every address's `VERSION()` against `networks.json`, launch, refuse a
token read as a curve with `AddressIsNotACurve`, quote a buy locally and on chain
and have the fill match both to the wei, watch progress move, sell with no
approval anywhere and assert the allowance is still zero, then drive the curve to
graduation at `GRADUATION_GAS_LIMIT` and a launch at exactly
`GRADUATION_GAS_FLOOR`, and assert the refund, the permanent halt and the
migration.

```bash
cargo test --test fork -- --nocapture
ARCNOW_SDK_REQUIRE_DOCKER=1 cargo test --test fork   # a missing daemon is a failure
ARCNOW_SDK_KEEP_CONTAINERS=1 cargo test --test fork  # leave the fork up to inspect
ARCNOW_SDK_FORK_URL=https://…  cargo test --test fork # your own endpoint
```

Without a Docker daemon they **skip, loudly**, because a developer without one
should not get a red run about somebody else's environment — unless
`ARCNOW_SDK_REQUIRE_DOCKER=1` is set, because a pipeline that skips its only
chain tests is a pipeline showing green having tested nothing.

Every container is labelled `io.arcnow.sdk.test=1` with the pid that started it
and the boot-and-namespace scope that pid means something in, and is removed on
pass, fail, panic and Ctrl-C. Nothing ever removes a container that does not carry
all three labels: this machine's Docker daemon is shared.

`tests/pool_fork.rs` is the other half. It launches a token on the fork whose
initial buy graduates it, so its pool is seeded by the real migrator and carries
the real `ArcNowFeeHook`. It asserts that a network with no router refuses every
pool quote and trade with `NoRouterDeployed`. Then it finds arcnow.io's live
router on the fork — it never deploys one — and asserts that the pinned creation
bytecode predicts its address and that its runtime codehash is the pinned one.
The creation bytecode is carried as `tests/fixtures/UniswapV4Router04.creation.hex`,
pinned by keccak256 and compared against the contracts checkout's copy when
`ARCNOW_CONTRACTS_DIR`, `../contracts` or `../contracts-router` has one. With that
router configured it trades the pool:

* Buys and sells fill to the wei of their quotes.
* Every reported `usdc` equals the trader's native balance change with the
  receipt's `gasUsed × effectiveGasPrice` put back, to the wei — including a sell
  whose swap distributes the buy's accrued fee, and a buy and a sell too small to
  be charged any fee.
* `fee_usdc` equals the hook's logged `feeWad` exactly; it accrues
  (`accrued_hook_fee`), the later swap reports it as `fees_distributed`, and a
  bystander's `distribute_hook_fees` zeroes the accrual.
* The router's slippage floor and deadline refuse as `PoolSlippageExceeded` and
  `PoolDeadlineExpired`.

It also overrides `ArcToken._allowance` and reads it back through the ABI, which
is what makes the storage slot the quote path relies on more than a hopeful
constant.

```bash
cargo test --test pool_fork -- --nocapture
```

**What a fork cannot prove.** It re-executes transactions locally with anvil's
EVM, so Arc's own execution semantics — blocklisted transfers, EIP-1153, the
EIP-7708 system emitter, burn-to-zero — are not exercised, and a fork will
disagree with the live chain about them without saying so. The deferred-payout
paths are unreachable there for exactly that reason.

---

## What is pinned

The ABIs under `src/generated/abi/` and the presets in
`src/generated/networks.json` are copies, pinned by SHA-256 in `../pins.json` to
the `arcnow-io/contracts` commit the deployment was built from, and compiled into
the crate so a published `arcnow-sdk` carries them and needs no file, no fetch
and no Solidity toolchain.
`../scripts/check-pins.sh` fails if one is edited or goes stale.

Do not edit them here. Fix them where they are generated and move the pin.
