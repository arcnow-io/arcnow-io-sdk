//! The residual fee arithmetic, the reference curve template, and the network
//! presets — all with no chain anywhere.

use arcnow_sdk::alloy::primitives::{Address, U256, address};
use arcnow_sdk::constants::{
    MAX_PLATFORM_ALLOWANCE_BPS, MAX_PROTOCOL_SHARE_BPS, MIN_PROTOCOL_SHARE_BPS, TRADE_FEE_BPS,
};
use arcnow_sdk::{
    Bps, CurveTemplate, Error, NATIVE_QUOTE, NATIVE_USDC, Network, NetworkConfig, NewPlatform,
    Tokens, Usdc, platform_share_bps,
};

const SOMEBODY: Address = address!("0x00000000000000000000000000000000deadbeef");

// ---------------------------------------------------------------------------
// the residual
// ---------------------------------------------------------------------------

#[test]
fn the_shipped_defaults_leave_the_platform_2500_bps() {
    // ArcConstants: creator 3000, ref 1000, dev 1000, protocol 2500.
    // 10000 - 2500 - 3000 - 1000 - 1000 = 2500, which is
    // DEFAULT_PLATFORM_SHARE_BPS — a value the contracts derive and never store.
    let residual = platform_share_bps(
        Bps::of_fee(3_000),
        Bps::of_fee(1_000),
        Bps::of_fee(1_000),
        Bps::of_fee(2_500),
    );
    assert_eq!(residual, Bps::of_fee(2_500));
    assert_eq!(residual.of_trade_equivalent(TRADE_FEE_BPS).percent_string(), "0.25");
}

#[test]
fn a_platform_that_allocates_nothing_keeps_everything_it_can() {
    let residual = platform_share_bps(Bps::ZERO, Bps::ZERO, Bps::ZERO, MAX_PROTOCOL_SHARE_BPS);
    assert_eq!(residual, MAX_PLATFORM_ALLOWANCE_BPS);
    assert_eq!(residual, Bps::of_fee(7_500));
}

#[test]
fn a_platform_may_give_its_whole_allowance_away() {
    // "creator 75 / ArcNow 25" is not a special regime: it is a platform
    // allocating all 7500 bps to the creator and keeping nothing.
    let residual = platform_share_bps(Bps::of_fee(7_500), Bps::ZERO, Bps::ZERO, Bps::of_fee(2_500));
    assert_eq!(residual, Bps::ZERO);
    // And a zero share does NOT mean the platform is never paid: the four
    // proportional shares are floored and the residual picks up the dust.
}

#[test]
fn lowering_the_protocol_share_widens_every_platforms_residual() {
    let at_max = platform_share_bps(
        Bps::of_fee(3_000),
        Bps::of_fee(1_000),
        Bps::of_fee(1_000),
        MAX_PROTOCOL_SHARE_BPS,
    );
    let at_min = platform_share_bps(
        Bps::of_fee(3_000),
        Bps::of_fee(1_000),
        Bps::of_fee(1_000),
        MIN_PROTOCOL_SHARE_BPS,
    );
    assert_eq!(at_max, Bps::of_fee(2_500));
    assert_eq!(at_min, Bps::of_fee(4_000));
    assert!(at_min > at_max, "a lower protocol share can only widen the residual");
}

fn platform(creator: u32, referrer: u32, developer: u32) -> NewPlatform {
    NewPlatform {
        admin: SOMEBODY,
        fee_recipient: SOMEBODY,
        creator_share_bps: Bps::of_fee(creator),
        ref_share_bps: Bps::of_fee(referrer),
        dev_share_bps: Bps::of_fee(developer),
        default_migrator: SOMEBODY,
        curve: CurveTemplate::arcnow_defaults(),
    }
}

#[test]
fn an_allocation_within_the_allowance_is_accepted_client_side() {
    assert!(platform(3_000, 1_000, 1_000).validate().is_ok());
    // Exactly at the boundary.
    assert!(platform(7_500, 0, 0).validate().is_ok());
    assert!(platform(2_500, 2_500, 2_500).validate().is_ok());
}

#[test]
fn an_over_allocation_is_refused_before_anything_is_sent_and_says_the_residual() {
    let error = platform(5_000, 2_000, 1_000).validate().unwrap_err();
    let Error::FeeSharesExceedAllowance { requested, allowance, .. } = &error else {
        panic!("expected FeeSharesExceedAllowance, got {error:?}");
    };
    assert_eq!(*requested, Bps::of_fee(8_000));
    assert_eq!(*allowance, Bps::of_fee(7_500));
    let message = error.to_string();
    assert!(message.contains("at most 7500 bps"), "{message}");
    assert!(message.contains("MAXIMUM share"), "{message}");
}

#[test]
fn new_platform_has_no_platform_share_field_and_computes_it_instead() {
    let candidate = platform(3_000, 1_000, 1_000);
    assert_eq!(candidate.platform_share_bps(Bps::of_fee(2_500)), Bps::of_fee(2_500));
    assert_eq!(candidate.platform_share_bps(Bps::of_fee(1_000)), Bps::of_fee(4_000));
}

// ---------------------------------------------------------------------------
// the reference curve template
//
// A template is NOT a constant. It is per-platform state, replaceable by that
// platform's admin in one transaction and snapshotted onto each curve at launch.
// arcnow.io's moved on 2026-09-13 — supply from 1e9 to 1e6, target from 50,000
// USDC to 50 — and nothing here noticed, because these numbers were only ever
// asserted against themselves. Every price was bit-identical across the change
// and the OLD template still passes the contracts' own checkCurveParameters, so
// neither these tests nor the chain's validation could see it.
//
// The values now live in ../curve-templates.json, one copy for both languages,
// and ../scripts/check-template.sh reads curveParameters() off the live platform
// and FAILS on any difference. That script is the gate; these tests check what
// needs no network.
// ---------------------------------------------------------------------------

#[test]
fn the_reference_template_is_the_one_arcnow_io_is_serving() {
    // The platform's template, set on 2026-09-13 by SetCurveTemplate in derive
    // mode: the reference shape at a thousandth of the supply and the target, so
    // every price equals the 1e9 reference.
    let template = CurveTemplate::arcnow_defaults();
    assert_eq!(template.total_supply, Tokens::from_whole(1_000_000));
    assert_eq!(template.curve_supply.to_wad().to_string(), "790931776678561246309959");
    assert_eq!(template.y0.to_wad().to_string(), "1075119882918585400293717");
    assert_eq!(template.r0.to_wad().to_string(), "17965399457930722779");
    assert_eq!(template.target, Usdc::from_whole(50));
    assert_eq!(template.quote_token, NATIVE_USDC, "arcnow.io's default template is native");
    assert_eq!(template.initial_price.to_wad().to_string(), "16710135998192");
    assert_eq!(template.params().y0_wad, template.y0.to_wad());
    assert_eq!(template.params().r0_wad, template.r0.to_wad());
}

#[test]
fn the_reference_is_the_same_prices_at_a_thousand_times_the_scale() {
    let reference = CurveTemplate::reference();
    let testnet = CurveTemplate::arcnow_defaults();
    assert_eq!(reference.total_supply, Tokens::from_whole(1_000_000_000));
    assert_eq!(reference.target, Usdc::from_whole(50_000));
    assert_eq!(reference.initial_price, testnet.initial_price);
    assert_eq!(reference.held_back().to_wad().to_string(), "209068223321438753690041210");
}

#[test]
fn both_sdks_read_the_same_file_and_get_the_same_numbers() {
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../src/generated/curve-templates.json"))
            .expect("the generated projection must parse");
    for (id, template) in [
        ("arc-testnet", CurveTemplate::arcnow_defaults()),
        ("cpmm-reference", CurveTemplate::reference()),
    ] {
        let entry = &json["templates"][id];
        assert_eq!(entry["totalSupplyWad"], template.total_supply.to_wad().to_string(), "{id}");
        assert_eq!(entry["curveSupplyWad"], template.curve_supply.to_wad().to_string(), "{id}");
        assert_eq!(entry["y0Wad"], template.y0.to_wad().to_string(), "{id}");
        assert_eq!(entry["r0Wad"], template.r0.to_wad().to_string(), "{id}");
        assert_eq!(entry["targetQuoteWad"], template.target.to_wad().to_string(), "{id}");
        assert_eq!(entry["quote"], NATIVE_QUOTE.to_string().to_lowercase(), "{id}");
        assert_eq!(entry["initialPriceWad"], template.initial_price.to_wad().to_string(), "{id}");
        // Every wad is a STRING: as a JSON number any parser rounds it.
        assert!(entry["y0Wad"].is_string(), "{id} y0Wad must not be a JSON number");
        for retired in ["kWad", "kind", "stack"] {
            assert!(
                entry.get(retired).is_none(),
                "{id} must not carry {retired}: there is one curve"
            );
        }
    }
    assert!(json["templates"].get("arc-testnet/linear-v1").is_none());
}

#[test]
fn there_is_no_reference_for_a_chain_nothing_is_deployed_on() {
    assert!(CurveTemplate::reference_for("arc-mainnet").is_none());
    assert!(CurveTemplate::reference_for("no-such-network").is_none());
    assert!(CurveTemplate::reference_for("arc-testnet").is_some());
}

#[test]
fn the_template_holds_back_exactly_what_its_target_buys() {
    // 1e6 - 790,931.776678561246309959 = 209,068.223321438753690041, which is
    // what 50 USDC buys at 0.000239156382570519: the constant-product split,
    // S / H = sqrt(M), at a 14.312x multiplier.
    let template = CurveTemplate::arcnow_defaults();
    assert_eq!(template.held_back().to_wad().to_string(), "209068223321438753690041");
    assert_eq!(
        template.curve_supply.to_wad() * U256::from(10_000) / template.total_supply.to_wad(),
        U256::from(7_909)
    );
}

#[test]
fn the_declared_opening_price_renders_as_a_price_a_human_can_read() {
    assert_eq!(CurveTemplate::arcnow_defaults().initial_price.to_string(), "0.000016710135998192");
}

// ---------------------------------------------------------------------------
// networks
// ---------------------------------------------------------------------------

#[test]
fn arc_testnet_carries_the_deployment() {
    let config = Network::ArcTestnet.config();
    assert_eq!(config.name, "arc-testnet");
    assert_eq!(config.chain_id, Some(5_042_002));
    assert_eq!(config.rpc_url.as_deref(), Some("https://rpc.testnet.arc.io"));
    // Left null rather than guessed: a wrong link in an error message is worse
    // than no link.
    assert_eq!(config.explorer_url, None);
    assert_eq!(config.native.symbol, "USDC");
    assert_eq!(config.native.decimals, 18, "msg.value on Arc is 18 decimals");
    assert_eq!(config.usdc_erc20.decimals, 6, "the ERC-20 view is 6");
    assert_eq!(config.usdc_erc20.address, Some(arcnow_sdk::constants::USDC_ERC20_PREDEPLOY));

    assert!(config.require_deployed().is_ok());
    assert!(config.launchpad().is_ok());
    assert!(config.platform_registry().is_ok());
    assert!(config.arcnow_platform().is_ok());
}

#[test]
fn arc_testnets_optional_contracts_are_absent_and_that_is_healthy() {
    let contracts = &Network::ArcTestnet.config().contracts;
    // The one custodial contract in the system. Absent because Arc testnet has a
    // real venue to graduate into.
    assert_eq!(contracts.escrow_migrator, None);
    // Both need a wrapped-native token Arc testnet does not publish.
    assert_eq!(contracts.v2_migrator, None);
    assert_eq!(contracts.v3_migrator, None);
    assert!(contracts.v4_migrator.is_some());
    assert!(contracts.fee_hook.is_some());

    let venues = Network::ArcTestnet.config().venues;
    assert!(venues.uniswap_v4);
    assert!(!venues.uniswap_v2 && !venues.uniswap_v3 && !venues.escrow);
}

#[test]
fn arc_mainnet_resolves_and_then_refuses_by_name() {
    // It resolves. This is the half that matters: an absent preset would be a
    // "no such network" error, which reads as "the SDK is behind".
    let network = Network::from_id("arc-mainnet").expect("arc-mainnet resolves");
    assert_eq!(network, Network::ArcMainnet);
    let config = network.config();
    assert_eq!(config.name, "arc-mainnet");

    // And it refuses, naming every missing contract.
    let error = config.require_deployed().unwrap_err();
    let Error::NetworkNotDeployed { network: name, missing } = &error else {
        panic!("expected NetworkNotDeployed, got {error:?}");
    };
    assert_eq!(name, "arc-mainnet");
    for required in [
        "launchpad",
        "tokenFactory",
        "curveFactory",
        "migratorRegistry",
        "platformRegistry",
        "arcnowPlatform",
    ] {
        assert!(missing.contains(&required), "{required} should be reported missing: {missing:?}");
    }
    let message = error.to_string();
    assert!(message.contains("launchpad"), "{message}");
    assert!(message.contains("Network::Custom"), "{message}");
    assert!(message.contains("zero address is a real account"), "{message}");
}

#[test]
fn a_missing_contract_is_never_silently_the_zero_address() {
    let error = Network::ArcMainnet.config().launchpad().unwrap_err();
    assert!(matches!(error, Error::ContractNotDeployed { contract: "launchpad", .. }));
    assert!(error.to_string().contains("not deployed on this chain"), "{error}");
}

#[test]
fn an_unknown_preset_lists_the_ones_that_exist() {
    let error = Network::from_id("arc-devnet").unwrap_err();
    let Error::UnknownNetwork { known, .. } = &error else {
        panic!("expected UnknownNetwork, got {error:?}");
    };
    assert!(known.iter().any(|name| name == "arc-testnet"));
    assert!(known.iter().any(|name| name == "arc-mainnet"));
}

#[test]
fn a_custom_network_is_a_first_class_path() {
    let contracts = arcnow_sdk::ContractAddresses {
        launchpad: Some(SOMEBODY),
        ..arcnow_sdk::ContractAddresses::default()
    };
    let config =
        arcnow_sdk::NetworkConfig::custom("my-fork", 31_337, "http://127.0.0.1:8545", contracts);
    assert_eq!(config.launchpad().unwrap(), SOMEBODY);
    // The rest are still honestly absent rather than zero.
    assert!(config.platform_registry().is_err());
    let network = Network::Custom(Box::new(config));
    assert_eq!(network.id(), "my-fork");
}

#[test]
fn arc_testnet_names_one_stack_with_its_builds() {
    let config = Network::ArcTestnet.config();
    assert_eq!(config.deployed_at_block, Some(62_226_550));
    assert_eq!(config.contract_versions["launchpad"].as_deref(), Some("arcnow/launchpad@3.0.0"));
    assert_eq!(
        config.contract_versions["feeHook"].as_deref(),
        Some("arcnow/arc-now-fee-hook@3.0.0")
    );
    assert_eq!(
        config.contract_versions["arcnowPlatform"].as_deref(),
        Some("arcnow/platform-config@3.0.0")
    );
    assert_eq!(
        config.contract_versions["quoteRegistry"].as_deref(),
        Some("arcnow/quote-registry@1.0.0")
    );
    assert!(config.contracts.quote_registry.is_some(), "the deployed stack names its registry");
    assert!(config.contracts.v4_router.is_some(), "arc-testnet names its router");
}

#[test]
fn networks_json_carries_no_second_stack() {
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../src/generated/networks.json")).unwrap();
    for (name, network) in json["networks"].as_object().unwrap() {
        assert!(network.get("legacyStacks").is_none(), "{name} must carry one stack");
    }
}

// ---------------------------------------------------------------------------
// quote tokens
// ---------------------------------------------------------------------------

const EURC: Address = address!("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");

#[test]
fn arc_testnet_lists_native_usdc_and_eurc_as_quotes() {
    let config = Network::ArcTestnet.config();
    assert_eq!(config.quote_tokens.len(), 2);
    assert_eq!(config.quote_tokens[0], NATIVE_USDC);
    let eurc = &config.quote_tokens[1];
    assert_eq!(eurc.address, EURC);
    assert_eq!(eurc.symbol, "EURC");
    assert_eq!(eurc.decimals, 6);
    assert!(!eurc.is_native, "\"native\": false in networks.json");
    assert_eq!(eurc.scale(), U256::from(1_000_000_000_000_u64));
    assert_eq!(config.quote_token(EURC), Some(eurc));
    assert_eq!(config.quote_token(NATIVE_QUOTE), Some(&NATIVE_USDC));
    assert_eq!(config.quote_token(SOMEBODY), None);
    assert_eq!(
        config.quote_allowance_slot(EURC),
        Some(U256::from(10)),
        "FiatToken's allowed mapping, as networks.json records it"
    );
    // Recorded since the multi-quote stack was deployed; a network that records
    // none carries None, which means "ask the launchpad", not the zero address.
    assert_eq!(
        config.contracts.quote_registry,
        Some(address!("0x72405d10551d3e27a899dc3119cb356cb27bb9b3"))
    );
}

fn network_json(quote_tokens: &str) -> String {
    format!(
        r#"{{"name":"fork","chainId":31337,"rpcUrl":null,"explorerUrl":null,"deployedAtBlock":null,
        "contractsCommit":null,"native":{{"symbol":"USDC","decimals":18}},
        "usdcErc20":{{"address":null,"decimals":6}},
        "quoteTokens":{quote_tokens},
        "contracts":{{"launchpad":null,"quoteRegistry":"0x00000000000000000000000000000000000000aa"}},
        "venues":{{"escrow":false,"uniswapV2":false,"uniswapV3":false,"uniswapV4":true}}}}"#
    )
}

#[test]
fn quote_tokens_parse_with_an_optional_allowance_slot() {
    let config: NetworkConfig = serde_json::from_str(&network_json(
        r#"[{"address":"0x0000000000000000000000000000000000000000","symbol":"USDC","name":"USD Coin","decimals":18,"native":true},
           {"address":"0x89b50855aa3be2f677cd6303cec089b5f319d72a","symbol":"EURC","name":"EURC","decimals":6,"native":false,"allowanceSlot":10},
           {"address":"0x0000000000000000000000000000000000001818","symbol":"W18","name":"Eighteen","decimals":18,"native":false,"allowanceSlot":"0x2a"}]"#,
    ))
    .expect("a quoteTokens list with allowance slots parses");
    assert_eq!(config.quote_tokens.len(), 3);
    assert!(config.quote_tokens[0].is_native);
    assert_eq!(config.quote_allowance_slot(EURC), Some(U256::from(10)));
    assert_eq!(
        config.quote_allowance_slot(address!("0x0000000000000000000000000000000000001818")),
        Some(U256::from(42))
    );
    assert_eq!(config.quote_allowance_slot(NATIVE_QUOTE), None);
    assert_eq!(
        config.contracts.quote_registry,
        Some(address!("0x00000000000000000000000000000000000000aa"))
    );
}

#[test]
fn a_network_without_quote_tokens_is_native_usdc_only() {
    let config: NetworkConfig =
        serde_json::from_str(&network_json("[]").replace(r#""quoteTokens":[],"#, ""))
            .expect("quoteTokens may be absent");
    assert_eq!(config.quote_tokens, vec![NATIVE_USDC]);
    let custom = NetworkConfig::custom(
        "my-fork",
        31_337,
        "http://127.0.0.1:8545",
        arcnow_sdk::ContractAddresses::default(),
    );
    assert_eq!(custom.quote_tokens, vec![NATIVE_USDC]);
    assert_eq!(custom.contracts.quote_registry, None);
}

#[test]
fn a_quote_token_entry_that_contradicts_itself_is_refused() {
    for (why, entry) in [
        (
            "native at a non-zero address",
            r#"[{"address":"0x89b50855aa3be2f677cd6303cec089b5f319d72a","symbol":"EURC","name":"EURC","decimals":6,"native":true}]"#,
        ),
        (
            "an ERC-20 at the zero address",
            r#"[{"address":"0x0000000000000000000000000000000000000000","symbol":"USDC","name":"USD Coin","decimals":18,"native":false}]"#,
        ),
        (
            "more than 18 decimals",
            r#"[{"address":"0x89b50855aa3be2f677cd6303cec089b5f319d72a","symbol":"EURC","name":"EURC","decimals":19,"native":false}]"#,
        ),
        (
            "native at 6 decimals",
            r#"[{"address":"0x0000000000000000000000000000000000000000","symbol":"USDC","name":"USD Coin","decimals":6,"native":true}]"#,
        ),
    ] {
        assert!(serde_json::from_str::<NetworkConfig>(&network_json(entry)).is_err(), "{why}");
    }
}
