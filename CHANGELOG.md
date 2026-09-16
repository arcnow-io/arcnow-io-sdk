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
