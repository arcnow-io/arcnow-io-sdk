//! The whole arc, against a real chain: connect, quote a launch, launch, quote a
//! buy, buy, read the curve, quote a sell, sell, and print where the fee went.
//!
//! # What you need
//!
//! One environment variable:
//!
//! ```text
//! ARCNOW_PRIVATE_KEY=0x...   a funded Arc testnet key
//! ARCNOW_RPC_URL=...         optional; defaults to the preset's public endpoint
//! ARCNOW_METADATA_URI=...    optional; defaults to a placeholder
//! ```
//!
//! **This file contains no key, no mnemonic and no credential of any kind, and
//! it never will.** The key is read from the environment at run time, and the
//! program says so in its own output so that nobody has to read this comment to
//! find out where it looked. This repository is private today and is intended to
//! become public; it is written as if it already were.
//!
//! # What it will cost
//!
//! The launch fee the quote registry charges — **zero** on arcnow.io's
//! deployments; launching is free — plus whatever you choose to spend on the
//! initial buy, plus gas. The program reads the fee off the chain rather than
//! assuming it, prints the exact total **before** it spends anything, and
//! everything it does is on Arc **testnet**.
//!
//! # Run it
//!
//! ```text
//! ARCNOW_PRIVATE_KEY=0x... cargo run --example launch_and_trade
//! ```

use std::process::ExitCode;

use alloy::signers::local::PrivateKeySigner;
use arcnow_sdk::{
    Bps, BuyRequest, Client, Deadline, LaunchParams, Network, SellRequest, Tokens, Usdc,
};

/// What the initial buy spends. Small on purpose: this is a demonstration, not a
/// launch strategy.
const INITIAL_BUY: u64 = 1;

/// What the follow-up buy spends.
const SECOND_BUY: u64 = 2;

/// Slippage tolerance for both trades: 1%.
///
/// Note this is bps **of the trade**, not bps of the fee — a different framing
/// from the fee shares, and the type says so on itself.
const SLIPPAGE: Bps = Bps::of_trade(100);

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("\n  failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    println!("arcnow.io — launch and trade, on Arc testnet");
    println!(
        "\n  Arc's native gas currency IS USDC, and msg.value is 18 decimals. Every USDC figure\n  \
         printed below is a decimal USDC amount, not a raw integer. The 6-decimal USDC ERC-20\n  \
         predeploy at 0x3600...0000 is the same asset at a different scale and is not used here\n  \
         at all."
    );

    // ---- the key, from the environment and nowhere else -------------------
    let Ok(key) = std::env::var("ARCNOW_PRIVATE_KEY") else {
        eprintln!(
            "\n  ARCNOW_PRIVATE_KEY is not set.\n\n  \
             This example reads a funded Arc testnet private key from the environment variable\n  \
             ARCNOW_PRIVATE_KEY, and from nowhere else — there is no key in this file and there\n  \
             is no default. Run it like this:\n\n      \
             ARCNOW_PRIVATE_KEY=0x... cargo run --example launch_and_trade\n\n  \
             The account needs enough native USDC for the launch fee, the buys below and gas."
        );
        return Err("ARCNOW_PRIVATE_KEY is unset".into());
    };
    let signer: PrivateKeySigner = key.trim().parse().map_err(|err| {
        format!("ARCNOW_PRIVATE_KEY is not a private key ({err}). It should be 32 bytes of hex.")
    })?;
    let me = signer.address();
    println!("\n  signing as {me} (key read from ARCNOW_PRIVATE_KEY)");

    // ---- connect ----------------------------------------------------------
    let mut builder = Client::builder().network(Network::ArcTestnet).signer(signer);
    if let Ok(url) = std::env::var("ARCNOW_RPC_URL") {
        println!("  using the endpoint in ARCNOW_RPC_URL");
        builder = builder.rpc_url(url);
    }
    let client = builder.build().await?;
    let network = client.network();
    println!(
        "  connected to {} (chain id {}), contracts from {}",
        network.name,
        network.chain_id.unwrap_or_default(),
        network.contracts_commit.as_deref().unwrap_or("an unrecorded commit")
    );
    println!("  balance {} USDC", client.balance(me).await?);

    // ---- what a launch costs, before spending anything --------------------
    let launchpad = client.launchpad()?;
    let launch_fee = launchpad.launch_fee(arcnow_sdk::NATIVE_QUOTE).await?;
    let trade_fee = launchpad.trade_fee_bps().await?;
    println!(
        "\n  the quote registry charges {launch_fee} USDC to launch (free, on arcnow.io's \
         deployments), and the launchpad {trade_fee} on every trade\n  ({}% — and the initial \
         buy is an ordinary buy, so it pays that too)",
        trade_fee.percent_string()
    );

    let metadata = std::env::var("ARCNOW_METADATA_URI")
        .unwrap_or_else(|_| "ipfs://example-metadata-not-a-real-document".to_owned());
    let params = LaunchParams::new("Arcnow SDK Example", "ASDKX", metadata)
        .initial_buy(Usdc::from_whole(INITIAL_BUY));

    let quote = launchpad.quote_launch(&params).await?;
    if quote.graduates {
        println!(
            "\n  NOTE: this initial buy alone reaches the graduation target, so the launch \
             will graduate the curve and migrate it in the same transaction. The SDK sends an \
             explicit gas limit for that; an estimated one would starve the migration."
        );
    }
    let (token_address, curve_address) = launchpad.predict_addresses(me, &params).await?;
    println!("\n  THIS LAUNCH WILL COST EXACTLY {} USDC, plus gas.", quote.total_cost);
    println!(
        "    {launch_fee} launch fee\n    {} initial buy, of which {} is the 1% trade fee\n  \
         and it will deliver {} tokens.",
        params.initial_buy, quote.trade_fee, quote.tokens_out
    );
    println!("    the token will land at {token_address}\n    its curve at  {curve_address}");
    println!(
        "  (that is the exact value the launchpad requires — it takes exact payment, not \
         at-least.)"
    );

    // Re-quote with a floor derived from the quote rather than launching with a
    // floor of zero, which on a public mempool is a donation.
    let params = params.min_tokens_out(quote.tokens_out.less_tolerance(SLIPPAGE));

    // ---- launch -----------------------------------------------------------
    println!("\n  launching...");
    // No gas limit is set here, and none is needed. If `quote.graduates` were
    // true -- the initial buy alone reaching the platform's graduation target --
    // `launch` would send GRADUATION_GAS_LIMIT itself, because an ESTIMATED
    // limit is precisely the one at which the migration inside the launch is
    // starved and caught. See LaunchParams::gas_limit.
    let launched = launchpad.launch(&params).await?;
    println!(
        "  launched in {}\n    token {}\n    curve {}\n    the initial buy delivered {} tokens",
        launched.tx_hash, launched.token, launched.curve, launched.tokens_out
    );
    if launched.graduated {
        // Read from the launch's OWN receipt. A later read of the chain answers
        // a different question: migrate() is permissionless and anyone may have
        // finished the job in between.
        println!(
            "    and it GRADUATED in the same transaction; migrated here: {}, pool {:?}",
            launched.migrated_in_this_transaction, launched.pool
        );
    }

    let curve = client.curve(launched.curve);
    let token = client.token(launched.token);

    // ---- quote a buy, then buy -------------------------------------------
    let buy_amount = Usdc::from_whole(SECOND_BUY);
    let buy_quote = curve.quote_buy(buy_amount.clone()).await?;
    println!(
        "\n  {buy_amount} USDC would buy {} tokens\n    fee {}, spent {}, refund {}, price after {}",
        buy_quote.tokens_out,
        buy_quote.fee,
        buy_quote.quote_spent,
        buy_quote.refund,
        buy_quote.new_price
    );

    let bought = curve
        .buy(
            BuyRequest::new(buy_amount, buy_quote.min_tokens_out(SLIPPAGE))
                .deadline(Deadline::in_minutes(5)),
        )
        .await?;
    println!(
        "  bought {} tokens for {} in {} (refund {})",
        bought.tokens_out, bought.quote_spent, bought.tx_hash, bought.refund
    );

    // ---- read the curve ---------------------------------------------------
    let state = curve.state().await?;
    println!(
        "\n  curve state\n    raised    {} of {} USDC\n    progress  {} ({}%)\n    sold      {} \
         tokens, {} left\n    spot      {} USDC per token\n    graduated {}, migrated {}\n    \
         graduates to {}",
        state.real_reserve,
        state.target,
        state.progress_bps,
        state.progress_bps.percent_string(),
        state.tokens_sold,
        state.tokens_remaining,
        state.spot_price,
        state.graduated,
        state.migrated,
        state.migrator
    );

    // ---- quote a sell, then sell. No approval anywhere. -------------------
    let held = token.balance_of(me).await?;
    let to_sell = Tokens::from_wad(held.to_wad() / alloy::primitives::U256::from(2));
    println!("\n  holding {held} tokens; selling half of them, {to_sell}");
    println!(
        "  note there is NO approve step here and none is needed: the curve pulls the tokens\n  \
         through a privileged path that reads no allowance at all."
    );
    println!(
        "  allowance granted to the curve, for the record: {}",
        token.allowance(me, launched.curve).await?
    );

    let sell_quote = curve.quote_sell(to_sell).await?;
    println!(
        "  it would pay {} USDC (gross {}, fee {}), price after {}",
        sell_quote.quote_out, sell_quote.gross, sell_quote.fee, sell_quote.new_price
    );

    let sold = curve
        .sell(
            SellRequest::new(to_sell, sell_quote.min_quote_out(SLIPPAGE))
                .deadline(Deadline::in_minutes(5)),
        )
        .await?;
    println!("  sold for {} USDC in {}", sold.quote_out, sold.tx_hash);
    println!(
        "  allowance granted to the curve, afterwards: {} — unchanged, because a sell never \
         reads one",
        token.allowance(me, launched.curve).await?
    );

    // ---- where the fee went ----------------------------------------------
    let split = curve.preview_fee_split(sell_quote.fee.clone(), None).await?;
    println!("\n  the {} USDC fee on that sell split four ways", sell_quote.fee);
    println!("  (basis points OF THE FEE, never of the trade):\n");
    for party in arcnow_sdk::FeeShare::ALL {
        let (recipient, amount) = split.part(party);
        println!("    {:<10} {:>24}  {recipient}", party.to_string(), amount.to_string());
    }
    println!(
        "    {:<10} {:>24}  (exactly the fee, at every size)",
        "total",
        split.total().to_string()
    );
    println!(
        "  no referrer was named, so that share went to the platform recipient — the same \
         rule\n  a zero configured share follows. It keeps its own identity in the logs all the \
         same,\n  so referral reporting does not quietly become platform revenue."
    );

    println!("\n  balance now {} USDC", client.balance(me).await?);
    println!("  done.");
    Ok(())
}
