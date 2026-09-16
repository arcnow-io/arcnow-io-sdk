//! Revert decoding, with no chain anywhere.
//!
//! Revert data is built here from the signature and the arguments, exactly as a
//! contract would build it, and fed to the decoder. Selectors are derived with
//! `keccak256` rather than pasted, so a test that passes is testing the registry
//! and the curation rather than a hex string somebody typed twice.
//!
//! One selector *is* pasted — `CurveGraduated()` — as a cross-check that the
//! derivation itself is right.

use arcnow_sdk::alloy::primitives::{Address, U256, address, keccak256};
use arcnow_sdk::alloy::sol_types::SolValue;
use arcnow_sdk::{Bps, Error, Tokens, Usdc, decode_revert};

/// Revert data for `signature` with `arguments` already ABI-encoded.
fn revert(signature: &str, arguments: &[u8]) -> Vec<u8> {
    let mut data = keccak256(signature.as_bytes())[..4].to_vec();
    data.extend_from_slice(arguments);
    data
}

const ALICE: Address = address!("0x00000000000000000000000000000000000a11ce");
const BOB: Address = address!("0x0000000000000000000000000000000000000b0b");

#[test]
fn a_derived_selector_matches_the_one_solc_produces() {
    // Cross-check: if this fails, every other test in this file is testing its
    // own arithmetic rather than the decoder.
    assert_eq!(arcnow_sdk::alloy::hex::encode(&keccak256(b"CurveGraduated()")[..4]), "025ac17e");
}

#[test]
fn a_graduated_curve_says_where_to_trade_instead() {
    let error = decode_revert(&revert("CurveGraduated()", &[]));
    assert!(matches!(error, Error::CurveGraduated));
    let message = error.to_string();
    assert!(message.contains("stopped trading permanently"), "{message}");
    assert!(message.contains("curve.state().migrator"), "{message}");
}

#[test]
fn incorrect_payment_carries_both_amounts_and_says_payment_is_exact() {
    let arguments = (Usdc::from_whole(12).to_wad(), Usdc::from_whole(10).to_wad()).abi_encode();
    let error = decode_revert(&revert("IncorrectPayment(uint256,uint256)", &arguments));
    let Error::IncorrectPayment { expected, actual, launch_fee, initial_buy } = error else {
        panic!("expected IncorrectPayment, got {error:?}");
    };
    assert_eq!(expected, Usdc::from_whole(12));
    assert_eq!(actual, Usdc::from_whole(10));
    // The breakdown is not in the revert data; only the caller who built the
    // transaction knows it, so it is filled in there and is None here.
    assert_eq!(launch_fee, None);
    assert_eq!(initial_buy, None);

    let message = Error::IncorrectPayment {
        expected,
        actual,
        launch_fee: Some(Usdc::from_whole(2)),
        initial_buy: Some(Usdc::from_whole(10)),
    }
    .to_string();
    assert!(message.contains("exactly 12 USDC"), "{message}");
    assert!(message.contains("(2 fee + 10 initial buy)"), "{message}");
    assert!(message.contains("not at-least"), "{message}");
}

#[test]
fn slippage_names_the_floor_and_says_to_requote() {
    let arguments = (U256::from(900u64), U256::from(880u64)).abi_encode();
    let error = decode_revert(&revert("SlippageExceeded(uint256,uint256)", &arguments));
    let Error::SlippageExceeded { min_out, actual_out } = error else {
        panic!("expected SlippageExceeded, got {error:?}");
    };
    assert_eq!(min_out, U256::from(900u64));
    assert_eq!(actual_out, U256::from(880u64));
    let message = error.to_string();
    assert!(message.contains("Re-quote and retry"), "{message}");
    assert!(message.contains("rises across your own order"), "{message}");
}

#[test]
fn an_insufficient_balance_on_a_sell_says_approval_is_not_the_problem() {
    let arguments =
        (ALICE, Tokens::from_whole(5).to_wad(), Tokens::from_whole(9).to_wad()).abi_encode();
    let error =
        decode_revert(&revert("InsufficientTokenBalance(address,uint256,uint256)", &arguments));
    let Error::InsufficientTokenBalance { seller, balance, amount } = error else {
        panic!("expected InsufficientTokenBalance, got {error:?}");
    };
    assert_eq!(seller, ALICE);
    assert_eq!(balance, Tokens::from_whole(5));
    assert_eq!(amount, Tokens::from_whole(9));
    let message = error.to_string();
    assert!(message.contains("No approval is involved"), "{message}");
    assert!(message.contains("fixing the wrong thing"), "{message}");
}

#[test]
fn the_deadline_error_says_how_late_the_transaction_was() {
    let arguments = (U256::from(1_000u64), U256::from(1_090u64)).abi_encode();
    let error = decode_revert(&revert("DeadlineExpired(uint256,uint256)", &arguments));
    assert!(matches!(error, Error::DeadlineExpired { deadline: 1_000, timestamp: 1_090 }));
    let message = error.to_string();
    assert!(message.contains("90 seconds late"), "{message}");
    assert!(message.contains("Nothing was traded"), "{message}");
}

#[test]
fn not_protocol_admin_says_which_role_was_needed() {
    let error = decode_revert(&revert("NotProtocolAdmin(address)", &(BOB,).abi_encode()));
    assert!(matches!(error, Error::NotProtocolAdmin { caller } if caller == BOB));
    let message = error.to_string();
    assert!(message.contains("not the protocol admin"), "{message}");
    assert!(message.contains("most likely surprise"), "{message}");

    let error = decode_revert(&revert("NotAdmin(address)", &(BOB,).abi_encode()));
    assert!(matches!(error, Error::NotAdmin { caller } if caller == BOB));
}

#[test]
fn platform_not_registered_says_the_check_runs_at_inclusion() {
    let error = decode_revert(&revert("PlatformNotRegistered(address)", &(BOB,).abi_encode()));
    assert!(matches!(error, Error::PlatformNotRegistered { platform } if platform == BOB));
    let message = error.to_string();
    assert!(message.contains(&BOB.to_string()), "{message}");
    assert!(message.contains("at inclusion, not at signing"), "{message}");
}

#[test]
fn already_migrated_is_framed_as_the_normal_outcome() {
    let error = decode_revert(&revert("AlreadyMigrated()", &[]));
    assert!(matches!(error, Error::AlreadyMigrated));
    let message = error.to_string();
    assert!(message.contains("normal outcome"), "{message}");
    assert!(message.contains("InstantMigrationFailed"), "{message}");
}

#[test]
fn every_curve_template_error_is_curated() {
    let two = (U256::from(1u64), U256::from(2u64)).abi_encode();
    assert!(matches!(
        decode_revert(&revert("InitialPriceMismatch(uint256,uint256)", &two)),
        Error::InitialPriceMismatch { .. }
    ));
    assert!(matches!(
        decode_revert(&revert("GraduationTargetMismatch(uint256,uint256)", &two)),
        Error::GraduationTargetMismatch { .. }
    ));
    let unpriceable = decode_revert(&revert("CurveNotPriceable(uint256,uint256)", &two));
    // The second word is y0Wad, the virtual token reserve at launch.
    assert!(
        matches!(
            unpriceable,
            Error::CurveNotPriceable { curve_supply, y0 }
                if curve_supply == Tokens::from_wad(U256::from(1u64))
                    && y0 == Tokens::from_wad(U256::from(2u64))
        ),
        "{unpriceable:?}"
    );
    assert!(unpriceable.to_string().contains("Y0"), "{unpriceable}");
    assert!(matches!(
        decode_revert(&revert("InvalidSupplies(uint256,uint256)", &two)),
        Error::InvalidSupplies { .. }
    ));
    let mismatch = decode_revert(&revert("PoolReserveMismatch(uint256,uint256)", &two));
    assert!(matches!(mismatch, Error::PoolReserveMismatch { .. }));
    assert!(mismatch.to_string().contains("do not re-derive it in floating"), "{mismatch}");
}

#[test]
fn an_error_from_an_abi_this_sdk_does_not_call_still_decodes() {
    // UniswapV2Migrator's. Nothing here calls a migrator — but a graduating buy
    // does, in the buyer's own transaction, so its errors are reachable from a
    // call a caller sent.
    let arguments = (ALICE, U256::from(7u64)).abi_encode();
    let error = decode_revert(&revert("UnusableGraduationPrice(address,uint256)", &arguments));
    let Error::NamedRevert { name, signature, source_abi, arguments } = error else {
        panic!("expected NamedRevert, got {error:?}");
    };
    assert_eq!(name, "UnusableGraduationPrice");
    assert_eq!(signature, "UnusableGraduationPrice(address,uint256)");
    assert!(source_abi.contains("Migrator"), "{source_abi}");
    assert_eq!(arguments.len(), 2);
    assert_eq!(arguments[1], "7");
}

#[test]
fn a_plain_require_string_is_decoded_as_one() {
    let arguments = ("nope".to_owned(),).abi_encode();
    let error = decode_revert(&revert("Error(string)", &arguments));
    assert!(matches!(&error, Error::ErrorString { message } if message == "nope"));
    assert!(error.to_string().contains("\"nope\""));
}

#[test]
fn a_panic_is_translated_into_what_it_means() {
    let error = decode_revert(&revert("Panic(uint256)", &(U256::from(0x11u64),).abi_encode()));
    let Error::Panic { code } = error else { panic!("expected Panic, got {error:?}") };
    assert_eq!(code, U256::from(0x11u64));
    assert!(error.to_string().contains("overflowed or underflowed"), "{error}");

    let divide = decode_revert(&revert("Panic(uint256)", &(U256::from(0x12u64),).abi_encode()));
    assert!(divide.to_string().contains("division or modulo by zero"), "{divide}");
}

#[test]
fn empty_revert_data_is_its_own_answer_and_not_an_unknown_selector() {
    let error = decode_revert(&[]);
    assert!(matches!(error, Error::EmptyRevert));
    let message = error.to_string();
    assert!(message.contains("out-of-gas"), "{message}");
    assert!(message.contains("address with no code"), "{message}");
}

#[test]
fn an_unknown_selector_is_named_plainly_rather_than_dumped() {
    let data = [0xde, 0xad, 0xbe, 0xef, 0x00];
    let error = decode_revert(&data);
    let Error::UnknownRevert { selector, data: payload } = &error else {
        panic!("expected UnknownRevert, got {error:?}");
    };
    assert_eq!(selector, "0xdeadbeef");
    assert_eq!(payload.len(), 5);
    let message = error.to_string();
    assert!(message.contains("0xdeadbeef"), "{message}");
    assert!(message.contains("Look it up"), "{message}");

    // And revert data too short to hold a selector is still framed, not panicked
    // on.
    assert!(matches!(decode_revert(&[0x01, 0x02]), Error::UnknownRevert { .. }));
}

#[test]
fn two_errors_with_the_same_name_and_different_arities_stay_apart() {
    // `NothingToWithdraw()` is the curve's; `NothingToWithdraw(address)` is the
    // fee hook's. They have different selectors and must not collide.
    let curve = decode_revert(&revert("NothingToWithdraw()", &[]));
    assert!(matches!(curve, Error::NothingToWithdraw));
    let hook = decode_revert(&revert("NothingToWithdraw(address)", &(ALICE,).abi_encode()));
    assert!(matches!(hook, Error::NamedRevert { .. }), "{hook:?}");
}

#[test]
fn the_fee_share_errors_explain_the_residual() {
    let total =
        decode_revert(&revert("FeeSharesNotWhole(uint256)", &(U256::from(9_999u64),).abi_encode()));
    assert!(matches!(total, Error::FeeSharesNotWhole { total } if total == Bps::of_fee(9_999)));
    assert!(total.to_string().contains("residual"), "{total}");

    let allowance = decode_revert(&revert(
        "FeeSharesExceedAllowance(uint256,uint256)",
        &(U256::from(8_000u64), U256::from(7_500u64)).abi_encode(),
    ));
    let Error::FeeSharesExceedAllowance { requested, allowance: cap, .. } = allowance else {
        panic!("expected FeeSharesExceedAllowance, got {allowance:?}");
    };
    assert_eq!(requested, Bps::of_fee(8_000));
    assert_eq!(cap, Bps::of_fee(7_500));
}

// ---------------------------------------------------------------------------
// the curve's own errors, and v4's WrappedError
// ---------------------------------------------------------------------------

#[test]
fn the_curves_reserve_error_decodes_by_name() {
    let arguments = (U256::from(5u64), U256::from(9u64)).abi_encode();
    let short = decode_revert(&revert("InsufficientTokenReserve(uint256,uint256)", &arguments));
    assert!(
        matches!(&short, Error::NamedRevert { name, .. } if name == "InsufficientTokenReserve"),
        "{short:?}"
    );
    // The retired linear curve's InvalidK() is in no pinned ABI any more.
    assert!(
        matches!(decode_revert(&revert("InvalidK()", &[])), Error::UnknownRevert { .. }),
        "InvalidK is not an error this SDK's contracts declare"
    );
}

/// `WrappedError(address target, bytes4 selector, bytes reason, bytes details)`
/// as v4-core's `CustomRevert.bubbleUpAndRevertWith` encodes it.
fn wrapped(target: Address, called: [u8; 4], reason: &[u8], details: &[u8]) -> Vec<u8> {
    use arcnow_sdk::alloy::primitives::{Bytes, FixedBytes};
    let arguments = (
        target,
        FixedBytes::<4>::from(called),
        Bytes::copy_from_slice(reason),
        Bytes::copy_from_slice(details),
    )
        .abi_encode_params();
    revert("WrappedError(address,bytes4,bytes,bytes)", &arguments)
}

/// `beforeSwap(address,(address,address,uint24,int24,address),(bool,int256,uint160),bytes)`.
const BEFORE_SWAP: [u8; 4] = [0x57, 0x5e, 0x24, 0xb4];
/// `HookCallFailed()`.
const HOOK_CALL_FAILED: [u8; 4] = [0xa9, 0xe3, 0x5b, 0x2f];

#[test]
fn the_wrapped_error_selector_is_v4_cores() {
    assert_eq!(
        arcnow_sdk::alloy::hex::encode(
            &keccak256(b"WrappedError(address,bytes4,bytes,bytes)")[..4]
        ),
        "90bfb865"
    );
    assert_eq!(&keccak256(b"HookCallFailed()")[..4], &HOOK_CALL_FAILED);
}

#[test]
fn a_hook_revert_wrapped_by_the_pool_manager_decodes_as_the_hook_error_itself() {
    // The PoolManager wraps an ArcNowFeeHook refusal inside a swap. Undecoded,
    // it used to reach a caller as an UnknownRevert of 0x90bfb865.
    let inner = revert("PoolNotRegistered(bytes32)", &[0x11_u8; 32]);
    let error = decode_revert(&wrapped(ALICE, BEFORE_SWAP, &inner, &HOOK_CALL_FAILED));
    assert!(
        matches!(&error, Error::NamedRevert { name, .. } if name == "PoolNotRegistered"),
        "the inner error, not the wrapper: {error:?}"
    );

    // A curated inner error comes back as its own variant.
    let slippage = revert(
        "SlippageExceeded(uint256,uint256)",
        &(U256::from(900u64), U256::from(880u64)).abi_encode(),
    );
    let error = decode_revert(&wrapped(ALICE, BEFORE_SWAP, &slippage, &HOOK_CALL_FAILED));
    assert!(matches!(error, Error::SlippageExceeded { .. }), "{error:?}");

    // And a plain Error(string) from a foreign hook.
    let string = revert("Error(string)", &("hook says no".to_owned(),).abi_encode());
    let error = decode_revert(&wrapped(BOB, BEFORE_SWAP, &string, &HOOK_CALL_FAILED));
    assert!(matches!(&error, Error::ErrorString { message } if message == "hook says no"));
}

#[test]
fn a_wrapped_error_inside_a_wrapped_error_is_unwrapped_all_the_way() {
    let innermost = revert("CurveGraduated()", &[]);
    let middle = wrapped(BOB, BEFORE_SWAP, &innermost, &HOOK_CALL_FAILED);
    let outer = wrapped(ALICE, BEFORE_SWAP, &middle, &HOOK_CALL_FAILED);
    assert!(matches!(decode_revert(&outer), Error::CurveGraduated));
}

#[test]
fn a_wrapped_error_whose_inner_revert_is_unknown_keeps_the_wrapper_and_says_where() {
    let unknown = [0xde, 0xad, 0xbe, 0xef, 0x01];
    let error = decode_revert(&wrapped(ALICE, BEFORE_SWAP, &unknown, &HOOK_CALL_FAILED));
    let Error::WrappedRevert { target, selector, reason, details } = &error else {
        panic!("expected WrappedRevert, got {error:?}");
    };
    assert_eq!(*target, ALICE);
    assert_eq!(selector.0, BEFORE_SWAP);
    assert_eq!(reason.as_ref(), &unknown);
    assert_eq!(details.as_ref(), &HOOK_CALL_FAILED);
    let message = error.to_string();
    assert!(message.contains(&ALICE.to_string()), "{message}");
    assert!(message.contains("WrappedError"), "{message}");

    // Nested, with an unknown innermost: the deepest wrapper names the failure.
    let nested = wrapped(ALICE, BEFORE_SWAP, &wrapped(BOB, BEFORE_SWAP, &unknown, &[]), &[]);
    assert!(
        matches!(decode_revert(&nested), Error::WrappedRevert { target, .. } if target == BOB),
        "the wrapper closest to the failure"
    );
}

#[test]
fn a_wrapped_error_with_an_empty_inner_revert_keeps_the_wrapper() {
    let error = decode_revert(&wrapped(ALICE, BEFORE_SWAP, &[], &HOOK_CALL_FAILED));
    assert!(
        matches!(&error, Error::WrappedRevert { reason, .. } if reason.is_empty()),
        "{error:?}"
    );
    assert!(error.to_string().contains("no data"), "{error}");

    // Wrapper bytes that do not decode as the four arguments are an unknown
    // revert, not a panic.
    let garbage = revert("WrappedError(address,bytes4,bytes,bytes)", &[0x01, 0x02]);
    assert!(matches!(decode_revert(&garbage), Error::UnknownRevert { .. }));
}

// ---------------------------------------------------------------------------
// not a curve, an unknown hook, and v4's failed native transfer
// ---------------------------------------------------------------------------

#[test]
fn a_token_address_is_not_a_curve_and_the_error_says_what_it_is() {
    let token = address!("0x00000000000000000000000000000000000070c3");
    let error = Error::AddressIsNotACurve {
        address: Some(token),
        version: Some("arcnow/arc-token@1.0.0".to_owned()),
    };
    let message = error.to_string();
    assert!(message.contains(&token.to_string()), "{message}");
    assert!(message.contains("arcnow/arc-token@1.0.0"), "{message}");
    assert!(message.contains("token"), "{message}");
    assert!(message.contains("Token::curve"), "points at the token's curve: {message}");

    let silent = Error::AddressIsNotACurve { address: Some(token), version: None };
    let message = silent.to_string();
    assert!(message.contains("no VERSION()"), "an address answering nothing: {message}");
}

#[test]
fn an_unknown_fee_hook_version_is_its_own_error() {
    let error = Error::UnknownHookVersion {
        hook: ALICE,
        version: "arcnow/arc-now-fee-hook@1.0.0".to_owned(),
    };
    let message = error.to_string();
    assert!(message.contains("arcnow/arc-now-fee-hook@1.0.0"), "{message}");
    assert!(message.contains("@3.x.x"), "names the one version it accepts: {message}");
    assert!(message.contains(&ALICE.to_string()), "{message}");
}

/// A made-up hook address: the decoding is independent of which hook it is.
const HOOK: Address = address!("0x00000000000000000000000000000000000020cc");

/// `NativeTransferFailed()` from v4-core's `CurrencyLibrary`.
const NATIVE_TRANSFER_FAILED: [u8; 4] = [0xf4, 0xb3, 0xb1, 0xbc];

#[test]
fn a_failed_native_transfer_inside_a_hook_call_is_two_real_layers_and_says_so() {
    // WrappedError(hook, beforeSwap, WrappedError(hook, 0x00000000, "",
    // NativeTransferFailed()), HookCallFailed()): v4-core's Currency.transfer
    // wraps a failed native payment with selector zero, and the hook call that
    // made it wraps that again. Both layers are genuinely in the bytes.
    let data = wrapped(
        HOOK,
        BEFORE_SWAP,
        &wrapped(HOOK, [0, 0, 0, 0], &[], &NATIVE_TRANSFER_FAILED),
        &HOOK_CALL_FAILED,
    );
    let error = decode_revert(&data);
    let Error::WrappedRevert { target, selector, reason, details } = &error else {
        panic!("expected WrappedRevert, got {error:?}");
    };
    assert_eq!(*target, HOOK);
    assert_eq!(selector.0, [0, 0, 0, 0], "selector zero: a native transfer, not a function call");
    assert!(reason.is_empty());
    assert_eq!(details.as_ref(), &NATIVE_TRANSFER_FAILED);
    let message = error.to_string();
    assert!(message.contains("native USDC"), "{message}");
    assert!(message.contains("NativeTransferFailed"), "{message}");
    assert!(message.contains("smaller"), "says what to do: {message}");
    assert!(!message.contains("version-1"), "one hook, no versions to explain: {message}");
}

#[test]
fn v4_cores_transfer_and_hook_errors_decode_by_name() {
    for name in ["NativeTransferFailed", "ERC20TransferFailed", "HookCallFailed"] {
        let error = decode_revert(&revert(&format!("{name}()"), &[]));
        assert!(
            matches!(&error, Error::NamedRevert { name: decoded, .. } if decoded == name),
            "{name}: {error:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// An SDK-side variant must never be spelled like a contract error.
// ---------------------------------------------------------------------------

/// The variant names of `Error`, read from its source: the enum is the list.
fn error_variant_names() -> Vec<String> {
    let source = include_str!("../src/error.rs");
    let start = source.find("pub enum Error {").expect("error.rs declares pub enum Error");
    let body = &source[start..];
    let end = body.find("\n}\n").expect("the enum closes");
    body[..end]
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("    ")?;
            if rest.starts_with(' ') || rest.starts_with('#') || rest.starts_with('/') {
                return None;
            }
            let name: String = rest.chars().take_while(char::is_ascii_alphanumeric).collect();
            (!name.is_empty() && name.starts_with(|c: char| c.is_ascii_uppercase())).then_some(name)
        })
        .collect()
}

/// Every custom error in every pinned ABI set: `(name, canonical signature, file)`.
fn contract_errors() -> Vec<(String, String, String)> {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../abi");
    let mut found = Vec::new();
    for dir in ["", "external"] {
        let path = std::path::Path::new(root).join(dir);
        for entry in std::fs::read_dir(&path).expect("the pinned ABI directory exists") {
            let file = entry.expect("readable").path();
            if file.extension().is_none_or(|e| e != "json")
                || file.file_name().is_some_and(|n| n == "index.json")
            {
                continue;
            }
            let abi: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&file).expect("readable")).unwrap();
            for item in abi.as_array().expect("an ABI is an array") {
                if item["type"] != "error" {
                    continue;
                }
                let name = item["name"].as_str().unwrap().to_owned();
                let types: Vec<&str> = item["inputs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|i| i["type"].as_str().unwrap())
                    .collect();
                let signature = format!("{name}({})", types.join(","));
                found.push((
                    name,
                    signature,
                    format!("{dir}/{}", file.file_name().unwrap().display()),
                ));
            }
        }
    }
    found
}

#[test]
fn no_sdk_variant_shares_a_name_with_a_contract_error_it_does_not_decode_as() {
    let variants = error_variant_names();
    let errors = contract_errors();
    assert!(variants.len() > 40, "the variant parser found {}", variants.len());
    assert!(errors.iter().any(|(n, _, f)| n == "InsufficientTokenReserve" && f.starts_with('/')));
    assert!(errors.iter().any(|(n, _, f)| n == "DeadlinePassed" && f.starts_with("external/")));

    // A variant spelled like a contract error is fine only when some revert of
    // that contract error decodes AS that variant: then it is the decoded
    // error, not an SDK-side refusal wearing its name.
    let mut collisions = Vec::new();
    for variant in &variants {
        let same_name: Vec<_> = errors.iter().filter(|(n, _, _)| n == variant).collect();
        if same_name.is_empty() {
            continue;
        }
        let decodes_as_variant = same_name.iter().any(|(_, signature, _)| {
            // Zero words are a valid encoding of every static argument; the
            // decoder tolerates what it cannot read, and the name is all that
            // is compared.
            let arity = signature.matches(',').count() + usize::from(!signature.ends_with("()"));
            let decoded =
                format!("{:?}", decode_revert(&revert(signature, &vec![0u8; 32 * arity])));
            decoded == *variant
                || decoded.starts_with(&format!("{variant} "))
                || decoded.starts_with(&format!("{variant}("))
        });
        if !decodes_as_variant {
            let files: Vec<_> = same_name.iter().map(|(_, s, f)| format!("{s} in {f}")).collect();
            collisions
                .push(format!("Error::{variant} is SDK-side but shares the name of {files:?}"));
        }
    }
    assert!(collisions.is_empty(), "{collisions:#?}");
}

#[test]
fn a_migrators_own_not_a_curve_revert_still_decodes_as_that_contract_error() {
    let error = decode_revert(&revert("NotACurve(address)", &ALICE.abi_encode()));
    let Error::NamedRevert { name, signature, arguments, .. } = &error else {
        panic!("the migrator's revert must decode as itself, got {error:?}");
    };
    assert_eq!(name, "NotACurve");
    assert_eq!(signature, "NotACurve(address)");
    assert_eq!(arguments.len(), 1);
    assert!(arguments[0].to_lowercase().contains("a11ce"), "{arguments:?}");
}

// ---------------------------------------------------------------------------
// multi-quote
// ---------------------------------------------------------------------------

#[test]
fn the_multi_quote_contract_errors_decode_by_name() {
    let zero_words = |n: usize| vec![0u8; 32 * n];
    for (signature, words) in [
        ("WrongQuotePath()", 0),
        ("QuoteTokenNotSupported(address)", 1),
        ("QuoteNotEnabledOnPlatform(address,address)", 2),
        ("MigratorDoesNotSupportQuote(address,address)", 2),
        ("LaunchFeeAboveMaximum(uint256,uint256)", 2),
        ("QuoteTransferShortfall(uint256,uint256)", 2),
        ("NoCurveParameters(address)", 1),
        // Declared only by the QuoteRegistry ABI.
        ("QuoteTokenNotRegistered(address)", 1),
    ] {
        let name = &signature[..signature.find('(').unwrap()];
        let error = decode_revert(&revert(signature, &zero_words(words)));
        assert!(
            matches!(&error, Error::NamedRevert { name: n, signature: s, .. } if n == name && s == signature),
            "{signature}: {error:?}"
        );
    }
}

#[test]
fn a_non_representable_amount_decodes_with_the_quote_scale() {
    let arguments =
        (U256::from(1_000_000_000_001_u64), U256::from(1_000_000_000_000_u64)).abi_encode();
    let error = decode_revert(&revert("QuoteAmountNotRepresentable(uint256,uint256)", &arguments));
    let Error::QuoteAmountNotRepresentable { amount_wad, quote_scale } = &error else {
        panic!("expected QuoteAmountNotRepresentable, got {error:?}");
    };
    assert_eq!(*amount_wad, U256::from(1_000_000_000_001_u64));
    assert_eq!(*quote_scale, U256::from(1_000_000_000_000_u64));
    let message = error.to_string();
    assert!(message.contains("1000000000000"), "the scale is named: {message}");
    assert!(message.contains("floor_to_representable"), "the fix is named: {message}");
}

#[test]
fn a_quote_mismatch_names_both_quotes() {
    let error = Error::QuoteTokenMismatch { expected: ALICE, actual: BOB };
    let message = error.to_string();
    assert!(message.contains(&ALICE.to_string()), "{message}");
    assert!(message.contains(&BOB.to_string()), "{message}");
}
