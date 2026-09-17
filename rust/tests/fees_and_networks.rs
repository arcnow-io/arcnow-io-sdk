//! The residual fee arithmetic, the reference curve template, and the network
//! presets — all with no chain anywhere.

use arcnow_sdk::alloy::primitives::{Address, U256, address};
use arcnow_sdk::constants::{
    MAX_PLATFORM_ALLOWANCE_BPS, MAX_PROTOCOL_SHARE_BPS, MIN_PROTOCOL_SHARE_BPS, TRADE_FEE_BPS,
};
use arcnow_sdk::{
    Bps, CurveTemplate, Error, FeeShare, NATIVE_QUOTE, NATIVE_USDC, Network, NetworkConfig,
    NewPlatform, Tokens, Usdc, platform_share_bps,
};

const SOMEBODY: Address = address!("0x00000000000000000000000000000000deadbeef");

// ---------------------------------------------------------------------------
// the residual
// ---------------------------------------------------------------------------

#[test]
fn the_shipped_defaults_leave_the_platform_3500_bps() {
    // ArcConstants: creator 3000, ref 1000, protocol 2500 - and no developer
    // share. 10000 - 2500 - 3000 - 1000 = 3500, which is
    // DEFAULT_PLATFORM_SHARE_BPS: a value the contracts derive and never store.
    // It was 2500 while there was a developer share; that share's 1000 bps
    // fell to the platform, because the platform is what the residual is.
    let residual = platform_share_bps(Bps::of_fee(3_000), Bps::of_fee(1_000), Bps::of_fee(2_500));
    assert_eq!(residual, Bps::of_fee(3_500));
    assert_eq!(residual.of_trade_equivalent(TRADE_FEE_BPS).percent_string(), "0.35");
}

#[test]
fn the_fee_share_enum_is_the_contracts_order_and_has_four_parties() {
    // IFeeConfig.FeeShare { Creator, Platform, Ref, Protocol }: the value a
    // FeePaid or FeeDeferred log's indexed `share` topic carries. Protocol is 3
    // (it was 4 while Dev sat between Ref and Protocol), and there is no Dev.
    assert_eq!(FeeShare::Creator as u8, 0);
    assert_eq!(FeeShare::Platform as u8, 1);
    assert_eq!(FeeShare::Ref as u8, 2);
    assert_eq!(FeeShare::Protocol as u8, 3);
    assert_eq!(
        FeeShare::ALL,
        [FeeShare::Creator, FeeShare::Platform, FeeShare::Ref, FeeShare::Protocol]
    );
    for share in FeeShare::ALL {
        assert_eq!(FeeShare::from_u8(share as u8), Some(share));
        assert_eq!(FeeShare::try_from(share as u8), Ok(share));
    }
    assert_eq!(FeeShare::from_u8(4), None, "there is no fifth party");
    assert!(FeeShare::try_from(4_u8).is_err());
}

#[test]
fn a_platform_that_allocates_nothing_keeps_everything_it_can() {
    let residual = platform_share_bps(Bps::ZERO, Bps::ZERO, MAX_PROTOCOL_SHARE_BPS);
    assert_eq!(residual, MAX_PLATFORM_ALLOWANCE_BPS);
    assert_eq!(residual, Bps::of_fee(7_500));
}

#[test]
fn a_platform_may_give_its_whole_allowance_away() {
    // "creator 75 / ArcNow 25" is not a special regime: it is a platform
    // allocating all 7500 bps to the creator and keeping nothing.
    let residual = platform_share_bps(Bps::of_fee(7_500), Bps::ZERO, Bps::of_fee(2_500));
    assert_eq!(residual, Bps::ZERO);
    // And a zero share does NOT mean the platform is never paid: the three
    // proportional shares are floored and the residual picks up the dust.
}

#[test]
fn lowering_the_protocol_share_widens_every_platforms_residual() {
    let at_max = platform_share_bps(Bps::of_fee(3_000), Bps::of_fee(1_000), MAX_PROTOCOL_SHARE_BPS);
    let at_min = platform_share_bps(Bps::of_fee(3_000), Bps::of_fee(1_000), MIN_PROTOCOL_SHARE_BPS);
    assert_eq!(at_max, Bps::of_fee(3_500));
    assert_eq!(at_min, Bps::of_fee(5_000));
    assert!(at_min > at_max, "a lower protocol share can only widen the residual");
}

fn platform(creator: u32, referrer: u32) -> NewPlatform {
    NewPlatform {
        admin: SOMEBODY,
        fee_recipient: SOMEBODY,
        creator_share_bps: Bps::of_fee(creator),
        ref_share_bps: Bps::of_fee(referrer),
        default_migrator: SOMEBODY,
        curve: CurveTemplate::arcnow_defaults(),
    }
}

#[test]
fn an_allocation_within_the_allowance_is_accepted_client_side() {
    assert!(platform(3_000, 1_000).validate().is_ok());
    // Exactly at the boundary.
    assert!(platform(7_500, 0).validate().is_ok());
    assert!(platform(5_000, 2_500).validate().is_ok());
}

#[test]
fn an_over_allocation_is_refused_before_anything_is_sent_and_says_the_residual() {
    let error = platform(6_000, 2_000).validate().unwrap_err();
    let Error::FeeSharesExceedAllowance { requested, allowance, .. } = &error else {
        panic!("expected FeeSharesExceedAllowance, got {error:?}");
    };
    assert_eq!(*requested, Bps::of_fee(8_000));
    assert_eq!(*allowance, Bps::of_fee(7_500));
    let message = error.to_string();
    assert!(message.contains("at most 7500 bps"), "{message}");
    assert!(message.contains("MAXIMUM share"), "{message}");
    assert!(!message.contains("dev"), "there is no developer share: {message}");
}

#[test]
fn new_platform_has_no_platform_share_field_and_computes_it_instead() {
    let candidate = platform(3_000, 1_000);
    assert_eq!(candidate.platform_share_bps(Bps::of_fee(2_500)), Bps::of_fee(3_500));
    assert_eq!(candidate.platform_share_bps(Bps::of_fee(1_000)), Bps::of_fee(5_000));
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
// and the maintainers' template gate reads curveParameters() off the live platform
// and FAILS on any difference. That script is the gate; these tests check what
// needs no network.
// ---------------------------------------------------------------------------

#[test]
fn the_testnet_template_is_the_one_arcnow_io_is_serving_there() {
    // arcnow.io's testnet platform's template, set by SetCurveTemplate: the
    // reference shape at a thousandth of the supply and the target, so every
    // price equals the 1e9 reference that mainnet serves.
    let template = CurveTemplate::arcnow_defaults();
    assert_eq!(template, CurveTemplate::reference_for("arc-testnet").unwrap());
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
fn the_reference_is_the_same_prices_at_a_thousand_times_the_scale_and_mainnet_serves_it() {
    let reference = CurveTemplate::reference();
    let testnet = CurveTemplate::arcnow_defaults();
    assert_eq!(reference.total_supply, Tokens::from_whole(1_000_000_000));
    assert_eq!(reference.curve_supply.to_wad().to_string(), "790931776678561246309958790");
    assert_eq!(reference.y0.to_wad().to_string(), "1075119882918585400307130090");
    assert_eq!(reference.r0.to_wad().to_string(), "17965399457930722779848");
    assert_eq!(reference.target, Usdc::from_whole(50_000));
    assert_eq!(reference.initial_price, testnet.initial_price);
    assert_eq!(reference.held_back().to_wad().to_string(), "209068223321438753690041210");
    // arcnow.io's mainnet platform holds the reference template for both quotes.
    assert_eq!(CurveTemplate::reference_for("arc-mainnet").unwrap(), reference);
    assert_ne!(reference, testnet, "the two networks serve different templates");
}

#[test]
fn both_sdks_read_the_same_file_and_get_the_same_numbers() {
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../src/generated/curve-templates.json"))
            .expect("the generated projection must parse");
    for (id, template) in [
        ("arc-testnet", CurveTemplate::arcnow_defaults()),
        ("arc-mainnet", CurveTemplate::reference()),
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
    assert!(json["templates"].get("cpmm-reference").is_none(), "mainnet serves the reference");
}

#[test]
fn every_live_network_has_a_template_and_nothing_else_does() {
    assert!(CurveTemplate::reference_for("arc-mainnet").is_some());
    assert!(CurveTemplate::reference_for("arc-testnet").is_some());
    assert!(CurveTemplate::reference_for("no-such-network").is_none());
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
fn arc_mainnet_carries_the_deployment() {
    let network = Network::from_id("arc-mainnet").expect("arc-mainnet resolves");
    assert_eq!(network, Network::ArcMainnet);
    let config = network.config();
    assert_eq!(config.name, "arc-mainnet");
    assert_eq!(config.chain_id, Some(5_042));
    assert_eq!(config.rpc_url.as_deref(), Some("https://rpc.mainnet.arc.io"));
    assert_eq!(config.explorer_url.as_deref(), Some("https://explorer.arc.io"));
    assert_eq!(config.deployed_at_block, Some(21_179_866));
    assert_eq!(config.native.symbol, "USDC");
    assert_eq!(config.native.decimals, 18);
    assert_eq!(config.usdc_erc20.address, Some(arcnow_sdk::constants::USDC_ERC20_PREDEPLOY));

    assert!(config.require_deployed().is_ok(), "every core contract is live on mainnet");
    assert_eq!(config.launchpad().unwrap(), address!("0xae1e5558ab71e851ce44f5c0f12ebeaf3db9dae3"));
    assert_eq!(
        config.arcnow_platform().unwrap(),
        address!("0xe3c7cd3e98af47de518740c7cfef9fc7064b2ef9")
    );
    assert_eq!(
        config.contracts.quote_registry,
        Some(address!("0x969a6a598efb4743293e8ad3df56a065fd990f6b"))
    );
    assert_eq!(config.v4_router().unwrap(), address!("0x4a142209396e7b9ba4c8527ff037fc73452b287f"));
    assert_eq!(
        config.v4_pool_manager().unwrap(),
        address!("0x8366a39CC670B4001A1121B8F6A443A643e40951")
    );
    assert_eq!(config.v4.lp_fee, Some(2_000));
    assert_eq!(config.v4.tick_spacing, Some(60));
    // v4-only, by design: Arc publishes no wrapped-native token.
    assert_eq!(config.contracts.escrow_migrator, None);
    assert_eq!(config.contracts.v2_migrator, None);
    assert_eq!(config.contracts.v3_migrator, None);
    assert!(config.contracts.v4_migrator.is_some());
    assert!(config.contracts.fee_hook.is_some());
    assert!(config.venues.uniswap_v4);
    assert!(!config.venues.uniswap_v2 && !config.venues.uniswap_v3 && !config.venues.escrow);
}

#[test]
fn both_presets_run_the_same_build() {
    for network in Network::presets() {
        let config = network.config();
        let versions = &config.contract_versions;
        let v = |key: &str| versions[key].as_deref().unwrap_or_else(|| panic!("{key} unset"));
        assert_eq!(v("launchpad"), "arcnow/launchpad@3.0.0", "{}", config.name);
        assert_eq!(v("tokenFactory"), "arcnow/token-factory@2.0.0", "{}", config.name);
        assert_eq!(v("curveFactory"), "arcnow/curve-factory@4.0.0", "{}", config.name);
        assert_eq!(v("platformRegistry"), "arcnow/platform-registry@4.0.0", "{}", config.name);
        assert_eq!(v("arcnowPlatform"), "arcnow/platform-config@4.0.0", "{}", config.name);
        assert_eq!(v("feeHook"), "arcnow/arc-now-fee-hook@4.0.0", "{}", config.name);
        assert_eq!(v("quoteRegistry"), "arcnow/quote-registry@1.0.0", "{}", config.name);
        assert_eq!(v("migratorRegistry"), "arcnow/migrator-registry@1.1.0", "{}", config.name);
        assert_eq!(v("v4Migrator"), "arcnow/uniswap-v4-migrator@2.0.0", "{}", config.name);
        assert_eq!(config.contracts.missing_core(), Vec::<&str>::new(), "{}", config.name);
        assert_eq!(
            config.contracts_commit.as_deref(),
            Some("e461106e2c6a0361b8c5463db292b73ad8691599"),
            "{}",
            config.name
        );
    }
    assert_ne!(
        Network::ArcTestnet.config().contracts.launchpad,
        Network::ArcMainnet.config().contracts.launchpad,
        "the same build at different addresses"
    );
}

#[test]
fn a_missing_contract_is_never_silently_the_zero_address() {
    let custom = NetworkConfig::custom(
        "bare",
        31_337,
        "http://127.0.0.1:8545",
        arcnow_sdk::ContractAddresses::default(),
    );
    let error = custom.launchpad().unwrap_err();
    assert!(matches!(error, Error::ContractNotDeployed { contract: "launchpad", .. }));
    assert!(error.to_string().contains("not deployed on this chain"), "{error}");

    // And a preset-shaped config with nothing behind it names every gap.
    let error = custom.require_deployed().unwrap_err();
    let Error::NetworkNotDeployed { network: name, missing } = &error else {
        panic!("expected NetworkNotDeployed, got {error:?}");
    };
    assert_eq!(name, "bare");
    assert_eq!(missing.len(), 6);
    let message = error.to_string();
    assert!(message.contains("launchpad"), "{message}");
    assert!(message.contains("Network::Custom"), "{message}");
    assert!(message.contains("zero address is a real account"), "{message}");
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
    assert_eq!(config.deployed_at_block, Some(62_386_232));
    assert_eq!(config.launchpad().unwrap(), address!("0x675a7a605911b0e3109eca580bc86e708199d952"));
    assert_eq!(config.contract_versions["launchpad"].as_deref(), Some("arcnow/launchpad@3.0.0"));
    assert_eq!(
        config.contract_versions["feeHook"].as_deref(),
        Some("arcnow/arc-now-fee-hook@4.0.0")
    );
    assert_eq!(
        config.contract_versions["arcnowPlatform"].as_deref(),
        Some("arcnow/platform-config@4.0.0")
    );
    assert_eq!(config.v4.lp_fee, Some(2_000));
    assert_eq!(config.v4.tick_spacing, Some(60));
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
    // A network that records none carries None, which means "ask the
    // launchpad", not the zero address.
    assert_eq!(
        config.contracts.quote_registry,
        Some(address!("0x0428b6a3e1abe299e4497488d1137c3feda54250"))
    );
}

const MAINNET_EURC: Address = address!("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1");

#[test]
fn arc_mainnet_lists_native_usdc_and_its_own_eurc_as_quotes() {
    let config = Network::ArcMainnet.config();
    assert_eq!(config.quote_tokens.len(), 2);
    assert_eq!(config.quote_tokens[0], NATIVE_USDC);
    let eurc = &config.quote_tokens[1];
    assert_eq!(eurc.address, MAINNET_EURC);
    assert_eq!(eurc.symbol, "EURC");
    assert_eq!(eurc.decimals, 6);
    assert!(!eurc.is_native);
    assert_eq!(config.quote_allowance_slot(MAINNET_EURC), Some(U256::from(10)));
    assert_eq!(config.quote_token(EURC), None, "testnet's EURC is not mainnet's");
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
