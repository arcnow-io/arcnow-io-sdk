//! The arithmetic and the refusals behind post-graduation trading, with no
//! chain anywhere.
//!
//! Four things are pinned here, and each of them is a way the pool code could be
//! silently wrong against a live chain that would still look plausible:
//!
//! 1. **Unpacking a `BalanceDelta`.** Two `int128`s inside one `int256`. Get the
//!    sign extension wrong and a quote reads a buy's cost as
//!    `3.4 × 10^38` USDC; get the halves the wrong way round and it reads the
//!    token leg as the USDC leg, which on a token trading well under a dollar
//!    looks like a merely optimistic quote.
//! 2. **The allowance storage slot.** A hard-coded slot that nothing checks is
//!    the class of bug this whole module is about. The expected value here comes
//!    from `cast index`, not from this crate's own arithmetic, and
//!    `tests/pool_fork.rs` proves the slot is the one the token really reads.
//! 3. **The fee identities.** The hook's 0.80% is already inside the delta the
//!    router returns, so it is *derived* both ways and the two directions are
//!    not the same formula. The pool's other 0.20% is Uniswap's LP fee, inside
//!    the pool's own price and not the hook's to log.
//! 4. **The refusals.** No router configured, a router bound to another
//!    `PoolManager`, a token that has not migrated, and a request built for the
//!    other venue each have to fail with something a human can act on, before
//!    anything is sent.

use arcnow_sdk::alloy::primitives::{Address, I256, U256, address};
use arcnow_sdk::constants::TRADE_FEE_BPS;
use arcnow_sdk::pool::{
    POOL_CREATOR_SHARE_BPS, POOL_LP_FEE_PIPS, POOL_PLATFORM_SHARE_BPS, POOL_PROTOCOL_SHARE_BPS,
    POOL_TICK_SPACING, POOL_TOTAL_FEE_BPS, POOL_TRADE_FEE_BPS, arc_token_allowance_slot,
    buy_fee_from_quote_in, pool_currencies, quote_and_token_legs, quote_is_currency0,
    sell_fee_from_quote_out, sell_gross_from_quote_out, sell_quote_out_from_fee,
    unpack_balance_delta, zero_for_one,
};
use arcnow_sdk::{
    Bps, BuyRequest, Deadline, Error, MigratorInfo, NATIVE_QUOTE, Network, NetworkConfig,
    PoolBuyRequest, PoolKey, PoolSellRequest, QuoteAmount, QuoteTokenInfo, SellRequest, Tokens,
    TradeBuyRequest, TradeSellRequest, Usdc, Venue, decode_revert,
};

const ALICE: Address = address!("0x00000000000000000000000000000000000a11ce");
/// Where arcnow-io/contracts `script/DeployV4Router.s.sol` puts the router on
/// Arc testnet, where it is live and named by the `arc-testnet` preset.
const ROUTER: Address = address!("0x139166ee61bb560ff34f05ae4a2b666ad98b9b2e");
/// A graduated token, as a stand-in address for the pool-key and fill tests.
const TOKEN: Address = address!("0x00000000000000000000000000000000000070c3");
/// arcnow.io's own `PoolManager`, which its migrator and its router both use.
const ARCNOW_MANAGER: Address = address!("0x06110b57dd9b82DD846ee0325fB81B284E1C6dD0");
/// Any other `PoolManager`. Deliberately not a real one.
const OTHER_MANAGER: Address = address!("0x00000000000000000000000000000000000beef0");

/// Pack two signed halves the way Uniswap v4's `toBalanceDelta` does.
fn pack(amount0: i128, amount1: i128) -> I256 {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(&amount0.to_be_bytes());
    bytes[16..].copy_from_slice(&amount1.to_be_bytes());
    I256::from_raw(U256::from_be_bytes(bytes))
}

// ---------------------------------------------------------------- BalanceDelta

#[test]
fn a_buy_delta_is_usdc_out_of_the_trader_and_tokens_into_them() {
    // 25 USDC paid, 1,234.5 tokens received. currency0 is native USDC.
    let usdc = Usdc::from_whole(25).to_wad().to::<i128>();
    let tokens = Tokens::parse("1234.5").unwrap().to_wad().to::<i128>();
    let (amount0, amount1) = unpack_balance_delta(pack(-usdc, tokens));
    assert_eq!(amount0, -usdc, "the leg the trader pays is negative");
    assert_eq!(amount1, tokens, "the leg they receive is positive");
}

#[test]
fn a_sell_delta_has_the_signs_the_other_way_round() {
    let usdc = Usdc::from_whole(24).to_wad().to::<i128>();
    let tokens = Tokens::from_whole(1_000).to_wad().to::<i128>();
    let (amount0, amount1) = unpack_balance_delta(pack(usdc, -tokens));
    assert_eq!(amount0, usdc);
    assert_eq!(amount1, -tokens);
}

#[test]
fn the_halves_are_truncated_not_divided() {
    // -1 in the high half and +2 in the low half. A signed DIVISION by 2^128
    // would carry the low half's value into the high one and answer 0 here;
    // truncation is what `int128(delta >> 128)` means.
    let packed = (I256::MINUS_ONE << 128) | I256::unchecked_from(2);
    assert_eq!(unpack_balance_delta(packed), (-1, 2));
}

#[test]
fn both_extremes_of_an_int128_survive_the_round_trip() {
    for (amount0, amount1) in
        [(i128::MIN, i128::MAX), (i128::MAX, i128::MIN), (-1, -1), (0, 0), (0, -1), (-1, 0)]
    {
        assert_eq!(
            unpack_balance_delta(pack(amount0, amount1)),
            (amount0, amount1),
            "packing and unpacking ({amount0}, {amount1}) must be lossless"
        );
    }
}

#[test]
fn a_delta_of_zero_is_two_zeroes_and_not_a_sign() {
    assert_eq!(unpack_balance_delta(I256::ZERO), (0, 0));
}

// ------------------------------------------------------------ allowance slot

#[test]
fn the_allowance_slot_is_the_one_cast_index_computes() {
    let owner = address!("0x1111111111111111111111111111111111111111");
    let spender = address!("0x2222222222222222222222222222222222222222");
    // Not this crate's own arithmetic: from
    //   cast index address 0x2222… $(cast index address 0x1111… 11)
    // against the pinned contracts commit, where `forge inspect ArcToken
    // storage` puts `_allowance` at slot 11. tests/pool_fork.rs then proves the
    // token really reads that slot.
    assert_eq!(
        arc_token_allowance_slot(owner, spender).to_string(),
        "0x1fea054c7d0690543ba713a5c01750aeaa4f1a8a691692b98c3791549f750066"
    );
}

#[test]
fn the_allowance_slot_is_not_symmetric_in_owner_and_spender() {
    // `keccak256(spender ‖ keccak256(owner ‖ p))`. Swapping the two is the
    // mistake that produces a slot which is real, writable, and belongs to
    // somebody else's allowance.
    let owner = address!("0x1111111111111111111111111111111111111111");
    let spender = address!("0x2222222222222222222222222222222222222222");
    assert_ne!(arc_token_allowance_slot(owner, spender), arc_token_allowance_slot(spender, owner));
}

#[test]
fn every_pair_gets_its_own_slot() {
    let one = arc_token_allowance_slot(ALICE, ROUTER);
    let two = arc_token_allowance_slot(ALICE, TOKEN);
    let three = arc_token_allowance_slot(ROUTER, ROUTER);
    assert_ne!(one, two);
    assert_ne!(one, three);
    assert_ne!(two, three);
}

// ------------------------------------------------------------ the fee, derived

#[test]
fn the_hook_takes_eighty_bps_and_the_pool_costs_the_same_one_percent_the_curve_does() {
    // ArcConstants.POOL_TRADE_FEE_BPS: the hook takes 0.80%, and Uniswap's LP
    // fee of 2000 hundredths of a bip (0.20%) is the other half. A migrated
    // trade costs the trader 1.00% in all - the curve's rate, on both sides of
    // graduation - and at the 1% the hook used to take it would have cost 1.30%.
    assert_eq!(POOL_TRADE_FEE_BPS, Bps::of_trade(80));
    assert_eq!(POOL_TRADE_FEE_BPS.percent_string(), "0.80");
    assert_eq!(POOL_LP_FEE_PIPS, 2_000);
    assert_eq!(POOL_TICK_SPACING, 60);
    assert_eq!(POOL_TOTAL_FEE_BPS, Bps::of_trade(100));
    assert_eq!(POOL_TOTAL_FEE_BPS, TRADE_FEE_BPS, "the same 1.00% before and after graduation");
    assert_eq!(POOL_TRADE_FEE_BPS.get() + POOL_LP_FEE_PIPS / 100, POOL_TOTAL_FEE_BPS.get());
}

#[test]
fn the_pools_split_has_three_parties_and_totals_the_whole_fee() {
    // ArcConstants.POOL_*_SHARE_BPS: 5000 / 1875 / 3125 of the hook's 0.80%,
    // which is 0.40% / 0.15% / 0.25% of a trade. No ref share: a pool has no
    // argument to name a referrer with.
    assert_eq!(POOL_CREATOR_SHARE_BPS, Bps::of_fee(5_000));
    assert_eq!(POOL_PLATFORM_SHARE_BPS, Bps::of_fee(1_875));
    assert_eq!(POOL_PROTOCOL_SHARE_BPS, Bps::of_fee(3_125));
    assert_eq!(
        POOL_CREATOR_SHARE_BPS.get()
            + POOL_PLATFORM_SHARE_BPS.get()
            + POOL_PROTOCOL_SHARE_BPS.get(),
        Bps::DENOMINATOR
    );
    assert_eq!(POOL_PROTOCOL_SHARE_BPS.of_trade_equivalent(POOL_TRADE_FEE_BPS), Bps::of_trade(25));
    assert_eq!(POOL_CREATOR_SHARE_BPS.of_trade_equivalent(POOL_TRADE_FEE_BPS), Bps::of_trade(40));
    assert_eq!(POOL_PLATFORM_SHARE_BPS.of_trade_equivalent(POOL_TRADE_FEE_BPS), Bps::of_trade(15));
}

#[test]
fn a_buy_pays_eighty_bps_of_what_the_trader_sends() {
    // The pool sees 99.2% of the input; the hook takes its cut in beforeSwap.
    // So the amount the trader names IS the gross.
    assert_eq!(buy_fee_from_quote_in(&Usdc::from_whole(100)), Usdc::parse("0.8").unwrap());
    assert_eq!(buy_fee_from_quote_in(&Usdc::parse("25").unwrap()), Usdc::parse("0.2").unwrap());
    assert_eq!(buy_fee_from_quote_in(&Usdc::ZERO), Usdc::ZERO);
}

#[test]
fn a_sell_grosses_up_what_the_trader_received() {
    // The trader sees 99.2% of what the pool paid out, so the gross has to be
    // recovered before the fee can be named: gross = net * 10000 / 9920.
    let net = Usdc::parse("99.2").unwrap();
    assert_eq!(sell_gross_from_quote_out(&net), Usdc::from_whole(100));
    assert_eq!(sell_fee_from_quote_out(&net), Usdc::parse("0.8").unwrap());
}

#[test]
fn the_two_directions_are_not_the_same_formula_and_that_is_the_point() {
    // Applying the buy identity to a sell's output under-reports the fee by
    // 0.8% of itself - small, systematic, and exactly the kind of error that
    // shows up as a penny of drift per trade rather than as a failure.
    let usdc_out = Usdc::parse("99.2").unwrap();
    assert_ne!(buy_fee_from_quote_in(&usdc_out), sell_fee_from_quote_out(&usdc_out));
    assert_eq!(buy_fee_from_quote_in(&usdc_out), Usdc::parse("0.7936").unwrap());
    assert_eq!(sell_fee_from_quote_out(&usdc_out), Usdc::parse("0.8").unwrap());
}

#[test]
fn net_plus_fee_is_the_gross_a_sell_moved_out_of_the_pool() {
    for whole in [1_u64, 7, 99, 1_000, 123_456] {
        let net = Usdc::from_whole(whole);
        let gross = sell_gross_from_quote_out(&net);
        let fee = sell_fee_from_quote_out(&net);
        // Floored twice, so this is an inequality by at most a wei or two - not
        // an equality dressed up as one.
        let reconstructed = net.add(&fee).unwrap();
        assert!(
            gross.sub_saturating(&reconstructed).unwrap() <= Usdc::from_wad(U256::from(2))
                && reconstructed.sub_saturating(&gross).unwrap() <= Usdc::from_wad(U256::from(2)),
            "net {net} + fee {fee} should reconstruct the gross {gross}"
        );
    }
}

#[test]
fn the_fee_on_a_single_wei_rounds_to_nothing_rather_than_up() {
    let wei = Usdc::from_wad(U256::from(1));
    assert_eq!(buy_fee_from_quote_in(&wei), Usdc::ZERO, "0.8% of one wei is zero, floored");
    assert_eq!(sell_fee_from_quote_out(&wei), Usdc::ZERO);
    // 124 wei is the last gross whose fee floors to zero; 125 wei pays one.
    assert_eq!(buy_fee_from_quote_in(&Usdc::from_wad(U256::from(124))), Usdc::ZERO);
    assert_eq!(buy_fee_from_quote_in(&Usdc::from_wad(U256::from(125))), wei);
}

// ------------------------------------------------------------------ refusals

#[test]
fn no_router_says_so_and_names_the_script_that_deploys_one() {
    let message = Error::NoRouterDeployed { chain_id: 5_042_002 }.to_string();
    assert!(message.contains("no Uniswap v4 router is deployed for this network"), "{message}");
    assert!(message.contains("5042002"), "{message}");
    assert!(message.contains("graduated tokens cannot be traded"), "{message}");
    assert!(message.contains("arcnow-io/contracts"), "{message}");
    assert!(message.contains("script/DeployV4Router.s.sol"), "{message}");
    assert!(message.contains("contracts.v4Router"), "{message}");
}

#[test]
fn a_router_on_another_manager_names_both_managers_and_the_router() {
    let error = Error::PoolUnreachable {
        token: TOKEN,
        pool_manager: ARCNOW_MANAGER,
        router: ROUTER,
        router_pool_manager: OTHER_MANAGER,
    };
    let message = error.to_string();
    assert!(message.contains(&TOKEN.to_string()), "{message}");
    assert!(message.contains(&ARCNOW_MANAGER.to_string()), "{message}");
    assert!(message.contains(&OTHER_MANAGER.to_string()), "{message}");
    assert!(message.contains(&ROUTER.to_string()), "{message}");
    // What a caller must not conclude: that retrying helps.
    assert!(message.contains("retrying will not change it"), "{message}");
    assert!(message.contains("immutable"), "{message}");
    // And what fixes it.
    assert!(message.contains(&format!("Configure a router deployed against {ARCNOW_MANAGER}")));
    // The retired venue story must not leak back in.
    for stale in ["legacy", "new venue", "only router on this chain"] {
        assert!(!message.contains(stale), "{stale:?} in: {message}");
    }
}

#[test]
fn a_token_that_has_not_migrated_is_sent_back_to_its_curve() {
    let message = Error::TokenNotMigrated { token: TOKEN }.to_string();
    assert!(message.contains("still trades on its bonding curve"), "{message}");
    assert!(message.contains("Curve::buy"), "{message}");
}

#[test]
fn a_pool_sell_without_an_approval_names_the_call_that_fixes_it() {
    let message = Error::RouterApprovalRequired {
        token: TOKEN,
        owner: ALICE,
        router: ROUTER,
        allowance: Tokens::ZERO,
        needed: Tokens::from_whole(1_000),
    }
    .to_string();
    assert!(message.contains("Pool::approve_router"), "{message}");
    assert!(message.contains("TWO transactions"), "{message}");
    // The half a caller from the curve side will assume is still true.
    assert!(message.contains("selling to a bonding curve never needs one"), "{message}");
    assert!(message.contains("canonicalRouter() is the zero address"), "{message}");
}

#[test]
fn the_routers_amountless_slippage_error_does_not_borrow_the_curves_numbers() {
    // `SlippageExceeded()` on the router, `SlippageExceeded(uint256,uint256)` on
    // the curve. Two different selectors, and the router's carries nothing — so
    // reporting it as the curve's variant would mean printing a floor of 0 and a
    // fill of 0 to somebody trying to work out what happened.
    let mut data = arcnow_sdk::alloy::primitives::keccak256(b"SlippageExceeded()")[..4].to_vec();
    assert!(matches!(decode_revert(&data), Error::PoolSlippageExceeded));

    data = arcnow_sdk::alloy::primitives::keccak256(b"SlippageExceeded(uint256,uint256)")[..4]
        .to_vec();
    data.extend_from_slice(&arcnow_sdk::alloy::sol_types::SolValue::abi_encode(&(
        U256::from(5),
        U256::from(4),
    )));
    assert!(matches!(decode_revert(&data), Error::SlippageExceeded { min_out, actual_out }
            if min_out == U256::from(5) && actual_out == U256::from(4)));
}

#[test]
fn the_routers_deadline_error_does_not_invent_a_block_timestamp() {
    let mut data =
        arcnow_sdk::alloy::primitives::keccak256(b"DeadlinePassed(uint256)")[..4].to_vec();
    data.extend_from_slice(&arcnow_sdk::alloy::sol_types::SolValue::abi_encode(&(U256::from(
        1_800_000_000_u64,
    ),)));
    let error = decode_revert(&data);
    let Error::PoolDeadlineExpired { deadline } = error else {
        panic!("expected PoolDeadlineExpired, got {error:?}");
    };
    assert_eq!(deadline, 1_800_000_000);
    assert!(error.to_string().contains("does not carry the block timestamp"), "{error}");
}

#[test]
fn a_router_that_cannot_pull_the_token_points_at_the_allowance() {
    let mut data = arcnow_sdk::alloy::primitives::keccak256(b"SafeERC20FailedOperation(address)")
        [..4]
        .to_vec();
    data.extend_from_slice(&arcnow_sdk::alloy::sol_types::SolValue::abi_encode(&(TOKEN,)));
    let error = decode_revert(&data);
    assert!(matches!(error, Error::RouterCouldNotPullToken { token } if token == TOKEN));
    assert!(error.to_string().contains("Pool::router_allowance"), "{error}");
}

// ------------------------------------------------------- the two venues differ

#[test]
fn a_venue_reads_as_the_market_it_is() {
    assert_eq!(Venue::Curve.to_string(), "bonding curve");
    assert_eq!(Venue::Pool.to_string(), "Uniswap v4 pool");
}

#[test]
fn a_request_carries_the_venue_it_was_built_for() {
    let curve: TradeBuyRequest = BuyRequest::new(Usdc::from_whole(1), Tokens::from_whole(1)).into();
    let pool: TradeBuyRequest =
        PoolBuyRequest::new(Usdc::from_whole(1), Tokens::from_whole(1), Deadline::in_minutes(5))
            .into();
    assert_eq!(curve.venue(), Venue::Curve);
    assert_eq!(pool.venue(), Venue::Pool);

    let curve: TradeSellRequest =
        SellRequest::new(Tokens::from_whole(1), Usdc::from_whole(1)).into();
    let pool: TradeSellRequest =
        PoolSellRequest::new(Tokens::from_whole(1), Usdc::from_whole(1), Deadline::in_minutes(5))
            .into();
    assert_eq!(curve.venue(), Venue::Curve);
    assert_eq!(pool.venue(), Venue::Pool);
}

#[test]
fn handing_a_curve_request_to_a_graduated_token_is_refused_by_name() {
    let message =
        Error::VenueMismatch { token: TOKEN, actual: Venue::Pool, requested: Venue::Curve }
            .to_string();
    assert!(message.contains("trades at the Uniswap v4 pool"), "{message}");
    assert!(message.contains("this is a bonding curve request"), "{message}");
    assert!(message.contains("Trade::venue"), "{message}");
}

#[test]
fn a_pool_request_requires_its_deadline_at_construction() {
    // Not a defaulted field: the router enforces it, and a swap that sits in a
    // mempool fills at a price nobody saw. The type is where that is said.
    let deadline = Deadline::at(1_800_000_000);
    let request = PoolBuyRequest::new(Usdc::from_whole(1), Tokens::from_whole(1), deadline);
    assert_eq!(request.deadline, deadline);
    assert_eq!(request.recipient, None, "a recipient is optional and defaults to the sender");
    assert_eq!(request.gas_limit, None);

    let redirected = request.recipient(ALICE);
    assert_eq!(redirected.recipient, Some(ALICE));
}

#[test]
fn a_slippage_floor_is_never_defaulted_on_either_side() {
    // Both constructors take one. The helper below it is how you get a sensible
    // number; there is no path that quietly passes zero.
    let quoted = Tokens::from_whole(1_000);
    let floor = quoted.less_tolerance(Bps::of_trade(50));
    assert!(floor < quoted && floor > Tokens::ZERO);
    let request = PoolBuyRequest::new(Usdc::from_whole(1), floor, Deadline::in_minutes(5));
    assert_eq!(request.min_tokens_out, floor);
}

// --------------------------------------------------------- the network preset

#[test]
fn arc_testnet_names_arcnows_own_pool_manager_and_its_router() {
    // The router was null until it was broadcast; this test said it would move
    // to asserting the address once it existed, and it now has.
    let config = Network::ArcTestnet.config();
    assert_eq!(config.v4_pool_manager().unwrap(), ARCNOW_MANAGER);
    assert_eq!(config.contracts.v4_router, Some(ROUTER));
    assert_eq!(config.v4_router().unwrap(), ROUTER);
}

#[test]
fn a_network_with_no_router_refuses_every_pool_trade_by_name() {
    // The accessor every pool quote and trade goes through, before any RPC.
    //
    // Built explicitly: this used the arc-testnet preset as its example of a
    // network with no router, which stopped being true -- and stopped testing
    // the refusal -- the day the router was broadcast.
    let mut config = Network::ArcTestnet.config().clone();
    config.contracts.v4_router = None;
    let error = config.v4_router().unwrap_err();
    assert!(
        matches!(error, Error::NoRouterDeployed { chain_id: 5_042_002 }),
        "no router on arc-testnet must be NoRouterDeployed, not a generic missing contract: \
         {error:?}"
    );
}

#[test]
fn a_network_with_a_router_hands_it_back() {
    let mut config = Network::ArcTestnet.config().clone();
    config.contracts.v4_router = Some(ROUTER);
    assert_eq!(config.v4_router().unwrap(), ROUTER);

    let custom = NetworkConfig::custom(
        "my-fork",
        31_337,
        "http://127.0.0.1:8545",
        arcnow_sdk::ContractAddresses {
            v4_router: Some(ROUTER),
            ..arcnow_sdk::ContractAddresses::default()
        },
    );
    assert_eq!(custom.v4_router().unwrap(), ROUTER);
    let bare = NetworkConfig::custom(
        "bare",
        31_337,
        "http://127.0.0.1:8545",
        arcnow_sdk::ContractAddresses::default(),
    );
    assert!(matches!(bare.v4_router(), Err(Error::NoRouterDeployed { chain_id: 31_337 })));
}

// -------------------------------------------------- choosing a venue at launch

#[test]
fn a_v4_migrator_on_the_manager_the_configured_router_serves_is_reachable() {
    // arcnow.io's own v4 migrator, once arcnow.io's own router is configured.
    assert!(MigratorInfo::reachability(Some(ARCNOW_MANAGER), Some(ARCNOW_MANAGER)));
}

#[test]
fn a_v4_migrator_is_not_reachable_while_no_router_is_configured() {
    // Every preset today. The pool will be fine; nothing here can trade it yet.
    assert!(!MigratorInfo::reachability(Some(ARCNOW_MANAGER), None));
}

#[test]
fn a_v4_migrator_on_a_manager_the_router_does_not_serve_is_not_reachable() {
    assert!(!MigratorInfo::reachability(Some(ARCNOW_MANAGER), Some(OTHER_MANAGER)));
}

#[test]
fn a_migrator_with_no_pool_manager_is_not_judged_at_all() {
    // An escrow, a v2 or a v3 migrator names no PoolManager. "Does its manager
    // match?" has no answer, with or without a router, and answering `false`
    // would grey out a venue on no evidence.
    assert!(MigratorInfo::reachability(None, Some(ARCNOW_MANAGER)));
    assert!(MigratorInfo::reachability(None, None));
}

#[test]
fn a_zero_router_on_a_migrator_means_nobody_is_auto_approved() {
    // The normal, safe value, and the one every v4 venue records. A caller who
    // read it as "the zero address is approved" would be reading a standing
    // maximum allowance into a hole.
    let info = MigratorInfo {
        address: ALICE,
        tax_mode: arcnow_sdk::TaxMode::HookFee,
        router: Address::ZERO,
        label: "arcnow/uniswap-v4-migrator@1.0.0".to_owned(),
        reachable: false,
    };
    assert_eq!(info.router, Address::ZERO);
    assert_eq!(info.tax_mode, arcnow_sdk::TaxMode::HookFee);
}

// ------------------------------------- reading a settled trade off its receipt

#[test]
fn a_sells_usdc_is_recoverable_from_the_fee_the_hook_logged() {
    // `ArcNowFeeHook.HookFeeTaken` carries feeWad and nothing else about the
    // swap, and on a sell the hook took it as floor(gross * 80 / 10000). So from
    // the fee alone the net is about feeWad * 9920 / 80 = feeWad * 124 -- an
    // estimate, which `Pool::sell` does not report: it reads the PoolManager's
    // Swap log instead.
    assert_eq!(sell_quote_out_from_fee(&Usdc::from_whole(1)), Usdc::from_whole(124));
    assert_eq!(sell_quote_out_from_fee(&Usdc::ZERO), Usdc::ZERO);
}

#[test]
fn the_derivation_round_trips_against_the_fee_identity() {
    // gross -> fee -> net has to come back to the net the fee identity names,
    // for every gross that is a whole multiple of 125 wei (80 / 10000 = 1 / 125)
    // — which is every gross where the flooring throws nothing away.
    for gross_wei in [125_u64, 1_000, 10_000, 999_875, 1_000_000] {
        let gross = Usdc::from_wad(U256::from(gross_wei));
        let fee = Usdc::from_wad(U256::from(gross_wei / 125));
        assert_eq!(
            sell_quote_out_from_fee(&fee),
            gross.sub_saturating(&fee).unwrap(),
            "fee {fee} should imply a net of gross {gross} less the fee"
        );
    }
}

#[test]
fn the_derivation_is_never_above_the_truth_and_never_124_wei_below_it() {
    // The bound the doc comment claims, checked across every remainder. The
    // hook floors, so up to 124 wei of the gross are gone; what matters is that
    // what comes back is never optimistic.
    for gross_wei in 10_000_u64..10_250 {
        let fee = gross_wei * 80 / 10_000;
        let true_net = gross_wei - fee;
        let derived = sell_quote_out_from_fee(&Usdc::from_wad(U256::from(fee))).to_wad();
        let true_net = U256::from(true_net);
        assert!(derived <= true_net, "gross {gross_wei}: {derived} must not overstate {true_net}");
        assert!(
            true_net - derived <= U256::from(124),
            "gross {gross_wei}: {derived} is more than 124 wei below {true_net}"
        );
    }
}

// ------------------------------------------------- both pool orientations

/// A real 6-decimal quote whose address sorts ABOVE a token at `TOKEN`.
const EURC: Address = address!("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
/// An 18-decimal quote whose address sorts BELOW `TOKEN`.
const LOW_QUOTE: Address = address!("0x0000000000000000000000000000000000000042");

fn eurc() -> QuoteTokenInfo {
    QuoteTokenInfo::erc20(EURC, "EURC", "EURC", 6).unwrap()
}

#[test]
fn a_native_quote_is_always_currency0() {
    assert!(quote_is_currency0(NATIVE_QUOTE, TOKEN));
    assert_eq!(pool_currencies(NATIVE_QUOTE, TOKEN), (NATIVE_QUOTE, TOKEN));
}

#[test]
fn an_erc20_quote_sorts_by_address_either_way_round() {
    // Quote below the token: quote first.
    assert!(quote_is_currency0(LOW_QUOTE, TOKEN));
    assert_eq!(pool_currencies(LOW_QUOTE, TOKEN), (LOW_QUOTE, TOKEN));
    // EURC above the token: the TOKEN is currency0.
    assert!(!quote_is_currency0(EURC, TOKEN));
    assert_eq!(pool_currencies(EURC, TOKEN), (TOKEN, EURC));
}

#[test]
fn a_buy_swaps_zero_for_one_exactly_when_the_quote_is_currency0() {
    assert!(zero_for_one(true, true), "quote first: a buy pays currency0");
    assert!(!zero_for_one(true, false), "token first: a buy pays currency1");
    assert!(!zero_for_one(false, true), "quote first: a sell pays currency1");
    assert!(zero_for_one(false, false), "token first: a sell pays currency0");
}

#[test]
fn the_quote_leg_is_picked_by_orientation() {
    let (quote, tokens) = (-1_000_000_i128, 5_000_000_000_000_000_000_i128);
    assert_eq!(quote_and_token_legs(pack(quote, tokens), true), (quote, tokens));
    assert_eq!(quote_and_token_legs(pack(tokens, quote), false), (quote, tokens));
}

#[test]
fn a_pool_key_names_its_quote_relative_to_the_token() {
    let (currency0, currency1) = pool_currencies(EURC, TOKEN);
    let key = PoolKey { currency0, currency1, fee: 3_000, tick_spacing: 60, hooks: ALICE };
    assert_eq!(key.quote_currency(TOKEN), Some(EURC));
    assert!(!key.quote_is_currency0(TOKEN));
    assert_eq!(key.quote_currency(ALICE), None, "a key that does not hold the token has no quote");
    let native = PoolKey { currency0: NATIVE_QUOTE, currency1: TOKEN, ..key };
    assert_eq!(native.quote_currency(TOKEN), Some(NATIVE_QUOTE));
    assert!(native.quote_is_currency0(TOKEN));
}

#[test]
fn fees_on_a_six_decimal_quote_are_computed_on_raw_units_as_the_hook_does() {
    let parse = |text: &str| QuoteAmount::parse_in(&eurc(), text).unwrap();
    // 1.000099 EURC is 1,000,099 raw; 0.8% floored is 8,000 raw = 0.008 EURC.
    // The same arithmetic on the wad would claim 0.008000792, which is not an
    // amount the hook can have taken.
    let fee = buy_fee_from_quote_in(&parse("1.000099"));
    assert_eq!(fee, parse("0.008"));
    assert_eq!(fee.token(), &eurc());
    // A sell: 0.992 EURC net is 1.00 gross and a 0.008 fee.
    assert_eq!(sell_gross_from_quote_out(&parse("0.992")), parse("1"));
    assert_eq!(sell_fee_from_quote_out(&parse("0.992")), parse("0.008"));
    assert_eq!(sell_quote_out_from_fee(&parse("0.008")), parse("0.992"));
    // Every figure stays a whole number of raw units.
    assert!(sell_gross_from_quote_out(&parse("0.123457")).is_representable());
    // And natively nothing changes: one wei is the raw unit.
    assert_eq!(buy_fee_from_quote_in(&Usdc::from_whole(100)), Usdc::parse("0.8").unwrap());
}
