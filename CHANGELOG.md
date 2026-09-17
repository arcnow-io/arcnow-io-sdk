# Changelog

All notable changes to the arcnow.io SDKs: `@arcnow/sdk` (TypeScript) and
`arcnow-sdk` (Rust). The two packages share one version and one release. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning:
[SemVer](https://semver.org/), with 0.x semantics until 1.0.0.

Versions are derived from the commits on `main` by `scripts/next-version.sh` and
written here by `scripts/apply-version.sh`; the section for a version is the list
of commits that went into it. A section written by hand before the release, like
the first one below, is kept as written.

## [Unreleased]

## [0.2.0] - 2026-09-17

Both SDKs now speak arcnow.io's live fee-model contract stack, on Arc testnet and on
Arc mainnet. The fee types changed shape, which is why this is a minor release under
0.x semantics rather than a patch.

### Added
- **Arc mainnet preset.** `resolveNetwork("arc-mainnet")` in TypeScript and
  `Network::ArcMainnet` in Rust resolve to the live mainnet deployment: chain `5042`,
  `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`, deployed at block
  21,179,866, every contract address from the deployment record, the Uniswap v4 router
  and PoolManager, and native USDC and EURC (`0xbEf5f6d5…`) as quotes. Mainnet's
  platform serves the reference curve template (1,000,000,000 supply, 50,000 to
  graduate), shipped as the `arc-mainnet` snapshot (`CurveTemplate.reference()` /
  `CurveTemplate::reference()`).
- **The pool's own fee, exposed.** A graduated pool's hook takes 0.80% of a trade
  (`POOL_TRADE_FEE_BPS`) beside the pool's 0.20% LP fee (`POOL_LP_FEE_PIPS`, tick
  spacing `POOL_TICK_SPACING`), 1.00% in all (`POOL_TOTAL_FEE_BPS`) — the same as the
  curve. The hook splits its fee creator 5000 / platform 1875 / protocol 3125 with no
  referrer share (`POOL_CREATOR_SHARE_BPS`, `POOL_PLATFORM_SHARE_BPS`,
  `POOL_PROTOCOL_SHARE_BPS`). Both SDKs read these off the chain per pool:
  `Pool.hookFeeBps()`, `Pool.feeConfig()` and `Pool.fees()` in TypeScript,
  `Pool::hook_fee_bps()` and `Pool::fee_config()` in Rust.
- **`FeeShare`**, the enum a `FeePaid` / `FeeDeferred` log's `share` topic carries:
  `Creator` 0, `Platform` 1, `Ref` 2, `Protocol` 3. Both SDKs export it; TypeScript's
  `FeeShare.nameOf(topic)` and Rust's `FeeShare::from_u8` refuse anything else.
- `NetworkConfig.v4` carries the migrator's `lpFee` and `tickSpacing` on both presets.

### Changed
- **No developer share.** The trade fee is split four ways — creator, platform,
  referrer, protocol — and every `devShareBps`, `dev` and `developer` field, argument and
  option is gone: `FeeConfig`, `FeeSplit`, `NewPlatform`, `PlatformSettings`, the buy and
  sell requests, `Trade`'s requests, `previewFeeSplit(fee, referrer?)` and
  `platformShareBps(creator, ref)`. arcnow.io's own split is creator 3000 / ref 1000 /
  platform 3500 / protocol 2500 bps of the fee: the platform's residual absorbed the
  developer's 1000.
- **Pool quotes report the hook's 0.80%**, not 1%: `feeQuote` on every pool buy and sell
  quote and fill, and the `buyFeeFromQuoteIn` / `sellFeeFromQuoteOut` /
  `sellQuoteOutFromFee` identities, are at 80 bps on raw units. A trade below 125 raw
  units of the quote is charged nothing (was 100).
- **Version gates moved to the fee-model stack**: `arcnow/bonding-curve@4.x.x`,
  `platform-config@4.x.x`, `platform-registry@4.x.x` and `arc-now-fee-hook@4.x.x` are
  accepted; the retired multi-quote `@3.x.x` contracts are refused **by name** — they
  are gone from arcnow.io's networks and the retired testnet stack's data was wiped —
  and `@2.x.x` and `@1.x.x` are refused as before. `launchpad@3.x.x`,
  `quote-registry@1.x.x` and `uniswap-v4-migrator@2.x.x` are unchanged.
- **Launching is free.** The quote registry's launch fee is zero for native USDC and
  EURC on both networks; the SDKs keep reading it from the registry, and every example,
  default and message that said 2 USDC now says zero.
- **`arc-testnet` points at the fee-model stack** deployed at block 62,386,232
  (launchpad `0x675a7a60…`, platform `0x912898e5…`, quote registry `0x0428b6a3…`, hook
  `0xd70d5f97…`), with `token-factory@2.0.0` and the 4.0.0 builds above. The retired
  multi-quote stack's addresses are gone from the presets.
- The ABIs, vectors and generated bindings are regenerated from arcnow-io/contracts at
  the commit whose deployment record carries both networks. The vectors' launch quotes
  moved with the launch fee; the curve maths did not.
- The READMEs describe both live networks, the four-party split, the pool's 0.80% +
  0.20% and the free launch; the "mainnet gap" is gone.

### Removed
- The `cpmm-reference` template entry: the reference template is now the live
  `arc-mainnet` snapshot.
- `arc-mainnet` no longer resolves to a refusal. `NetworkNotDeployed` remains for a
  preset or custom network with nothing deployed on it.

## [0.1.5] - 2026-09-17

### Changed
- The README is written for people who use the SDKs: install from npm (`@arcnow/sdk`) and crates.io (`arcnow-sdk`), what the offline tests prove, how the network presets are read. The maintainers' notes on pins, gates and releases live outside the published tree.
- Doc comments, `$comment` fields and error messages no longer refer to maintainer tooling by file name.

## [0.1.4] - 2026-09-17

- Install the SDKs from npm and crates.io; the public README is the README

## [0.1.3] - 2026-09-17

- The npm step reads "cannot publish over" as already published

## [0.1.2] - 2026-09-17

- A republish whose version is already on the mirror continues to the registries

## [0.1.1] - 2026-09-16

- No early-exiting reader in any publish pipeline

## [0.1.0] - 2026-09-17

The first published release. Both SDKs talk to arcnow.io's one contract stack on
Arc over JSON-RPC, with no arcnow.io backend in the loop.

### Added

- Rust (`arcnow-sdk`, on alloy) and TypeScript (`@arcnow/sdk`, on viem) clients
  with the same surface: launch a token, quote and trade its bonding curve,
  create a platform, read the state of any of them.
- The constant-product bonding curve (`arcnow/bonding-curve@3.x`) priced locally
  to the wei, checked against the contracts' reference vectors; every other
  curve version is refused by name rather than priced.
- Quote tokens: native USDC (18 decimals as `msg.value`) and the ERC-20 quotes
  the quote registry allowlists (EURC on Arc testnet), every amount labelled
  with its own quote and its own decimals.
- Graduated tokens traded through arcnow.io's Uniswap v4 router under the
  claim-based fee hook, with fills read exactly from the PoolManager's `Swap`
  log, or refused when the network has no router.
- A graduating launch is given the gas its migration needs; the curve template
  is read off the chain rather than assumed.
- Network presets (`networks.json`), curve-template snapshots
  (`curve-templates.json`) and the pinned ABIs (`abi/`) for the stack deployed
  on Arc testnet, projected into both packages.
- Typed error decoding for every contract revert, without a chain.
- Licensed under GPL-3.0-or-later.
