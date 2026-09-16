//! The amount types, with no chain anywhere.
//!
//! These are the tests that matter most per line in this crate. Everything else
//! can be wrong by a transaction; a scale error here is wrong by a factor of a
//! trillion, in every amount, silently.

use arcnow_sdk::alloy::primitives::{Address, U256, address};
use arcnow_sdk::{
    AmountParseError, Bps, Error, MAX_QUOTE_DECIMALS, NATIVE_QUOTE, NATIVE_USDC, QuoteAmount,
    QuoteTokenInfo, Tokens, Usdc, UsdcErc20,
};

fn wad(text: &str) -> U256 {
    U256::from_str_radix(text, 10).expect("a decimal integer")
}

#[test]
fn whole_usdc_is_eighteen_decimals() {
    assert_eq!(Usdc::from_whole(1).to_wad(), wad("1000000000000000000"));
    assert_eq!(Usdc::from_whole(50_000).to_wad(), wad("50000000000000000000000"));
    // The shipped graduation target, spelled both ways, must agree.
    assert_eq!(Usdc::from_whole(50_000), Usdc::parse("50000").unwrap());
}

#[test]
fn tokens_are_eighteen_decimals_too_and_are_a_different_type() {
    assert_eq!(Tokens::from_whole(1_000_000_000).to_wad(), wad("1000000000000000000000000000"));
    // The interesting property is not runtime: `Usdc` and `Tokens` have the same
    // representation and cannot be substituted for one another, which is checked
    // by the compiler on every call site in this crate. What is asserted here is
    // that they at least agree about the scale.
    assert_eq!(Usdc::from_whole(7).to_wad(), Tokens::from_whole(7).to_wad());
}

#[test]
fn parsing_is_exact_and_refuses_to_round() {
    assert_eq!(Usdc::parse("1.25").unwrap().to_wad(), wad("1250000000000000000"));
    assert_eq!(Usdc::parse("0.000000000000000001").unwrap().to_wad(), U256::from(1));
    assert_eq!(Usdc::parse(".5").unwrap().to_wad(), wad("500000000000000000"));
    assert_eq!(Usdc::parse("7.").unwrap(), Usdc::from_whole(7));
    assert_eq!(Usdc::parse("  12.5  ").unwrap().to_wad(), wad("12500000000000000000"));

    // Nineteen fractional digits is an error, not a truncation. This is the
    // whole point: an SDK that shortened the number you typed would send a
    // different amount from the one you chose.
    let nineteen = Usdc::parse("0.0000000000000000001");
    assert!(matches!(nineteen, Err(AmountParseError::TooPrecise { found: 19, decimals: 18, .. })));

    for bad in ["", "   ", ".", "abc", "1.2.3", "-1", "1e18", "1_000", "$5", "1,000"] {
        assert!(Usdc::parse(bad).is_err(), "{bad:?} should not parse");
    }
}

#[test]
fn display_renders_usdc_and_never_the_raw_integer() {
    assert_eq!(Usdc::from_whole(50_000).to_string(), "50000");
    assert_eq!(Usdc::parse("1.25").unwrap().to_string(), "1.25");
    assert_eq!(Usdc::from_wad(U256::from(1)).to_string(), "0.000000000000000001");
    assert_eq!(Usdc::ZERO.to_string(), "0");
    // The shipped opening price, straight off ArcConstants.INITIAL_PRICE_WAD.
    assert_eq!(Usdc::from_wad(wad("13488642643250")).to_string(), "0.00001348864264325");
    // Round trip: whatever is rendered parses back to the same integer.
    for text in ["0", "1", "1.25", "0.000000000000000001", "123456.789"] {
        assert_eq!(Usdc::parse(text).unwrap().to_string(), Usdc::parse(text).unwrap().to_string());
        assert_eq!(
            Usdc::parse(&Usdc::parse(text).unwrap().to_string()).unwrap().to_wad(),
            Usdc::parse(text).unwrap().to_wad()
        );
    }
}

#[test]
fn debug_carries_the_unit_so_a_failing_assertion_says_which_quantity() {
    assert_eq!(format!("{:?}", Usdc::from_whole(3)), "3 USDC");
    assert_eq!(format!("{:?}", Tokens::from_whole(3)), "3 tokens");
    assert_eq!(format!("{:?}", UsdcErc20::from_whole(3)), "3 USDC (6dp ERC-20 view)");
}

#[test]
fn the_erc20_conversion_is_a_factor_of_1e12_upwards_and_exact() {
    let six = UsdcErc20::parse("1.25").unwrap();
    assert_eq!(six.to_units(), U256::from(1_250_000u64));
    assert_eq!(Usdc::from_erc20(six).to_wad(), wad("1250000000000000000"));
    assert_eq!(six.to_native(), Usdc::from_erc20(six));

    // Every 6-decimal figure is exactly representable at 18, so the round trip
    // up and back is lossless.
    for text in ["0", "1", "1.25", "0.000001", "50000"] {
        let original = UsdcErc20::parse(text).unwrap();
        assert_eq!(Usdc::from_erc20(original).to_erc20().unwrap(), original, "{text}");
    }
}

#[test]
fn the_erc20_conversion_truncates_downwards_and_never_rounds_up() {
    // A wad amount can carry dust six decimals cannot express. Rounding up would
    // promise dollars that do not exist, so it truncates towards zero.
    let dusty = Usdc::parse("1.9999999999999999").unwrap();
    assert_eq!(dusty.to_erc20().unwrap().to_string(), "1.999999");
    // One wei of USDC is a millionth of the smallest 6-decimal unit, and
    // disappears entirely rather than becoming 0.000001.
    assert_eq!(Usdc::from_wad(U256::from(1)).to_erc20().unwrap(), UsdcErc20::ZERO);
    assert_eq!(Usdc::parse("0.0000009").unwrap().to_erc20().unwrap().to_string(), "0");
}

#[test]
fn arithmetic_is_checked_rather_than_wrapping() {
    let a = Usdc::from_whole(10);
    let b = Usdc::from_whole(3);
    assert_eq!(a.clone() + b.clone(), Usdc::from_whole(13));
    assert_eq!(a.clone() - b.clone(), Usdc::from_whole(7));
    assert_eq!(a.checked_sub(&b), Some(Usdc::from_whole(7)));
    // There is no negative amount for this to be, so it is reported.
    assert_eq!(b.checked_sub(&a), None);
    assert!(matches!(b.sub(&a), Err(Error::InvalidArgument { .. })));
    assert_eq!(b.sub_saturating(&a).unwrap(), Usdc::ZERO);
    assert_eq!(Usdc::MAX.checked_add(&Usdc::from_whole(1)), None);
    assert!(matches!(Usdc::MAX.add(&Usdc::from_whole(1)), Err(Error::InvalidArgument { .. })));
    assert!(Usdc::ZERO.is_zero());
    assert!(a > b);
}

#[test]
fn a_slippage_floor_is_a_tolerance_below_a_quote() {
    let quoted = Tokens::from_whole(1_000);
    // 50 bps of the amount: half a percent.
    assert_eq!(quoted.less_tolerance(Bps::of_trade(50)), Tokens::from_whole(995));
    assert_eq!(quoted.less_tolerance(Bps::ZERO), quoted);
    assert_eq!(quoted.less_tolerance(Bps::WHOLE), Tokens::ZERO);
    // It floors, so the floor is never above what a caller asked for.
    let odd = Usdc::from_wad(U256::from(999u64));
    assert!(odd.less_tolerance(Bps::of_trade(1)).to_wad() <= odd.to_wad());
}

#[test]
fn bps_of_fee_and_bps_of_trade_are_the_same_number_meaning_different_things() {
    let creator = Bps::of_fee(3_000);
    let trade_fee = Bps::of_trade(100);

    // 3000 bps of a 1% fee is 0.30% of the trade — 30 bps, not 3000.
    assert_eq!(creator.of_trade_equivalent(trade_fee), Bps::of_trade(30));
    assert_eq!(creator.percent_string(), "30.00");
    assert_eq!(creator.of_trade_equivalent(trade_fee).percent_string(), "0.30");
    assert_eq!(trade_fee.percent_string(), "1.00");

    // And the arcnow.io defaults, all five, restated as a share of a trade.
    let of_trade = |bps| Bps::of_fee(bps).of_trade_equivalent(trade_fee).percent_string();
    assert_eq!(of_trade(3_000), "0.30"); // creator
    assert_eq!(of_trade(2_500), "0.25"); // platform (the residual)
    assert_eq!(of_trade(1_000), "0.10"); // ref
    assert_eq!(of_trade(1_000), "0.10"); // dev
    assert_eq!(of_trade(2_500), "0.25"); // protocol
}

#[test]
fn taking_bps_of_an_amount_floors() {
    // The 1% fee on 10 USDC.
    assert_eq!(Bps::of_trade(100).take(&Usdc::from_whole(10)), Usdc::parse("0.1").unwrap());
    // A fee of one wei: every proportional share floors to zero, which is why
    // the platform's share is a residual and picks up the dust.
    let one_wei = Usdc::from_wad(U256::from(1));
    assert_eq!(Bps::of_fee(3_000).take(&one_wei), Usdc::ZERO);
    assert_eq!(Bps::of_fee(2_500).take(&one_wei), Usdc::ZERO);
}

#[test]
fn bps_off_the_chain_is_read_or_refused_and_never_saturated() {
    assert_eq!(Bps::from_u256(U256::from(3_000)).unwrap(), Bps::of_fee(3_000));
    assert!(Bps::from_u256(U256::MAX).is_err());
}

// ---------------------------------------------------------------------------
// quote tokens: native USDC, a 6-decimal ERC-20 and an 18-decimal ERC-20
// ---------------------------------------------------------------------------

const EURC: Address = address!("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
const EIGHTEEN: Address = address!("0x0000000000000000000000000000000000001818");

fn eurc() -> QuoteTokenInfo {
    QuoteTokenInfo::erc20(EURC, "EURC", "EURC", 6).unwrap()
}

fn eighteen() -> QuoteTokenInfo {
    QuoteTokenInfo::erc20(EIGHTEEN, "W18", "Eighteen", 18).unwrap()
}

#[test]
fn native_usdc_is_the_zero_address_at_eighteen_decimals() {
    assert_eq!(NATIVE_QUOTE, Address::ZERO);
    assert_eq!(MAX_QUOTE_DECIMALS, 18);
    assert_eq!(NATIVE_USDC.address, NATIVE_QUOTE);
    assert_eq!(NATIVE_USDC.symbol, "USDC");
    assert_eq!(NATIVE_USDC.name, "USD Coin");
    assert_eq!(NATIVE_USDC.decimals, 18);
    const { assert!(NATIVE_USDC.is_native) };
    assert_eq!(NATIVE_USDC.scale(), U256::from(1));
    // The alias's constructors build native amounts, ZERO included.
    assert_eq!(Usdc::ZERO.token(), &NATIVE_USDC);
    assert_eq!(Usdc::from_whole(1).token(), &NATIVE_USDC);
    assert_eq!(Usdc::parse("1.5").unwrap().token(), &NATIVE_USDC);
    assert!(Usdc::from_wad(U256::from(7)).is_native());
}

#[test]
fn a_quote_scale_is_ten_to_the_eighteen_minus_its_decimals() {
    assert_eq!(eurc().scale(), U256::from(1_000_000_000_000_u64));
    assert!(!eurc().is_native);
    assert_eq!(eighteen().scale(), U256::from(1));
}

#[test]
fn quote_token_info_refuses_what_cannot_be_a_quote() {
    // An ERC-20 at the zero address would be native USDC in disguise.
    assert!(matches!(
        QuoteTokenInfo::erc20(Address::ZERO, "X", "X", 18),
        Err(Error::InvalidArgument { .. })
    ));
    assert!(matches!(
        QuoteTokenInfo::erc20(EURC, "X", "X", 19),
        Err(Error::InvalidArgument { .. })
    ));
    let lying_native = QuoteTokenInfo { is_native: true, ..eurc() };
    assert!(matches!(lying_native.validate(), Err(Error::InvalidArgument { .. })));
    let six_decimal_native = QuoteTokenInfo { decimals: 6, ..NATIVE_USDC };
    assert!(matches!(six_decimal_native.validate(), Err(Error::InvalidArgument { .. })));
    assert!(NATIVE_USDC.validate().is_ok());
    assert!(eurc().validate().is_ok());
}

#[test]
fn parse_in_is_exact_in_the_tokens_own_decimals() {
    let amount = QuoteAmount::parse_in(&eurc(), "1.25").unwrap();
    assert_eq!(amount.to_wad(), wad("1250000000000000000"));
    assert_eq!(amount.to_raw().unwrap(), U256::from(1_250_000_u64));
    assert_eq!(amount.token(), &eurc());
    // Seven fractional digits on a six-decimal token: refused, never rounded.
    assert!(matches!(
        QuoteAmount::parse_in(&eurc(), "0.0000001"),
        Err(AmountParseError::TooPrecise { found: 7, decimals: 6, .. })
    ));
    let one_wei = QuoteAmount::parse_in(&eighteen(), "0.000000000000000001").unwrap();
    assert_eq!((one_wei.to_wad(), one_wei.to_raw().unwrap()), (U256::from(1), U256::from(1)));
    assert_eq!(QuoteAmount::parse_in(&NATIVE_USDC, "1.5").unwrap(), Usdc::parse("1.5").unwrap());
    assert!(QuoteAmount::zero_in(&eurc()).is_zero());
    assert_eq!(QuoteAmount::zero_in(&eurc()).token(), &eurc());
}

#[test]
fn raw_units_scale_up_by_the_quote_scale() {
    let amount = QuoteAmount::from_raw_in(&eurc(), U256::from(1_500_000_u64)).unwrap();
    assert_eq!(amount.to_wad(), wad("1500000000000000000"));
    assert_eq!(amount.to_string(), "1.5");
    assert_eq!(amount.format(), "1.5 EURC");
    assert_eq!(format!("{amount:?}"), "1.5 EURC");
    assert_eq!(
        QuoteAmount::from_raw_in(&eighteen(), U256::from(7)).unwrap().to_wad(),
        U256::from(7)
    );
    assert_eq!(
        QuoteAmount::from_raw_in(&NATIVE_USDC, U256::from(7)).unwrap(),
        Usdc::from_wad(U256::from(7))
    );
    // A raw figure whose wad does not fit is refused rather than wrapped.
    assert!(QuoteAmount::from_raw_in(&eurc(), U256::MAX).is_err());
}

#[test]
fn a_wad_the_token_cannot_carry_is_refused_rather_than_truncated() {
    let scale = U256::from(1_000_000_000_000_u64);
    let dusty = QuoteAmount::from_wad_in(&eurc(), scale + U256::from(1));
    assert!(!dusty.is_representable());
    let err = dusty.to_raw().unwrap_err();
    assert!(
        matches!(err, Error::QuoteAmountNotRepresentable { amount_wad, quote_scale }
            if amount_wad == scale + U256::from(1) && quote_scale == scale),
        "{err:?}"
    );
    assert_eq!(dusty.floor_to_representable().to_wad(), scale);
    assert_eq!(dusty.ceil_to_representable().to_wad(), scale * U256::from(2));
    assert_eq!(dusty.floor_to_representable().token(), &eurc());
    let exact = QuoteAmount::from_wad_in(&eurc(), scale * U256::from(3));
    assert!(exact.is_representable());
    assert_eq!(exact.ceil_to_representable(), exact);
    // Every wad is representable natively, and at 18 decimals.
    assert!(Usdc::from_wad(U256::from(1)).is_representable());
    assert!(QuoteAmount::from_wad_in(&eighteen(), U256::from(1)).is_representable());
}

#[test]
fn arithmetic_across_two_quotes_is_a_mismatch_not_a_number() {
    let euros = QuoteAmount::parse_in(&eurc(), "1").unwrap();
    let dollars = Usdc::from_whole(1);
    let mismatch = |result: Result<(), Error>| {
        let err = result.unwrap_err();
        assert!(
            matches!(err, Error::QuoteTokenMismatch { expected, actual }
                if expected == EURC && actual == NATIVE_QUOTE),
            "{err:?}"
        );
    };
    mismatch(euros.add(&dollars).map(drop));
    mismatch(euros.sub(&dollars).map(drop));
    mismatch(euros.sub_saturating(&dollars).map(drop));
    mismatch(euros.compare(&dollars).map(drop));
    mismatch(euros.gt(&dollars).map(drop));
    mismatch(euros.lt(&dollars).map(drop));
    mismatch(euros.eq(&dollars).map(drop));
    assert_eq!(euros.checked_add(&dollars), None);
    // Same number, different money: never equal, and not ordered either.
    assert_ne!(euros, QuoteAmount::from_wad_in(&NATIVE_USDC, euros.to_wad()));
    assert_eq!(euros.partial_cmp(&dollars), None);

    let two = euros.add(&euros).unwrap();
    assert_eq!(two, QuoteAmount::parse_in(&eurc(), "2").unwrap());
    assert_eq!(two.token(), &eurc());
    assert_eq!(two.sub(&euros).unwrap(), euros);
    assert!(matches!(euros.sub(&two), Err(Error::InvalidArgument { .. })));
    assert!(euros.sub_saturating(&two).unwrap().is_zero());
    assert_eq!(euros.compare(&two).unwrap(), core::cmp::Ordering::Less);
    assert!(two.gt(&euros).unwrap() && euros.lt(&two).unwrap() && euros.eq(&euros).unwrap());
    assert!(euros < two);
}

#[test]
fn the_erc20_view_is_only_for_native_usdc() {
    assert!(Usdc::from_whole(1).to_erc20().is_ok());
    let euros = QuoteAmount::parse_in(&eurc(), "1").unwrap();
    assert!(matches!(euros.to_erc20(), Err(Error::InvalidArgument { .. })));
}

#[test]
fn basis_points_of_a_quote_keep_its_token() {
    let fee = Bps::of_trade(100).apply_to_quote(&QuoteAmount::parse_in(&eurc(), "10").unwrap());
    assert_eq!(fee, QuoteAmount::parse_in(&eurc(), "0.1").unwrap());
    assert_eq!(fee.token(), &eurc());
    let floor = QuoteAmount::parse_in(&eurc(), "100").unwrap().less_tolerance(Bps::of_trade(50));
    assert_eq!(floor, QuoteAmount::parse_in(&eurc(), "99.5").unwrap());
}
