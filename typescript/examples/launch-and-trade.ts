/**
 * The whole arc, end to end, against Arc testnet:
 * connect → quote a launch → launch → quote a buy → buy → read state →
 * quote a sell → sell → print the fee split.
 *
 * ## Running it
 *
 * ```
 * export ARCNOW_PRIVATE_KEY=0x…      # a funded Arc testnet key
 * npm run example                    # builds, then runs this file
 * ```
 *
 * It imports `@arcnow/sdk` by name rather than by relative path, so what you
 * read here is exactly what your own code would say.
 *
 * Set `ARCNOW_RPC_URL` to point at something other than the public endpoint —
 * a private node, or a local anvil fork of Arc testnet, which is a good way to
 * rehearse this whole script without spending anything real.
 *
 * **The key is read from the environment variable `ARCNOW_PRIVATE_KEY` and from
 * nowhere else.** There is no key, no mnemonic and no credential of any kind in
 * this file, and there must never be one: this repository is private today and
 * is intended to become public, so it is written as if it already were. If the
 * variable is unset the script says so and stops without touching the network.
 *
 * ## What it costs
 *
 * Real testnet USDC leaves the key: the 2 USDC flat launch fee, plus whatever
 * initial buy and follow-on buy you choose below, plus gas. The script prints
 * the total before it spends anything and gives you a moment to stop it. The
 * sell at the end returns most — not all — of the trading capital: the curve
 * charges 1% on the way in and 1% on the way out, and the price you sell back
 * at is the price after your own buy moved it.
 *
 * ## The one fact to carry away
 *
 * **On Arc the native gas currency IS USDC, and `msg.value` is 18 decimals.**
 * Every amount below is an 18-decimal `Usdc` or `Tokens`; the SDK will not let
 * a bare `bigint` into any of these calls, and that is deliberate. The USDC
 * ERC-20 predeploy reports 6 decimals for the same asset, and the two raw
 * integers differ by a factor of a trillion.
 *
 * @module
 */

import { privateKeyToAccount } from "viem/accounts";

import {
  Bps,
  createArcNowClient,
  Deadline,
  isArcNowError,
  minTokensOutFromQuote,
  minQuoteOutFromQuote,
  Tokens,
  Usdc,
} from "@arcnow/sdk";

/** What the creator spends on the first buy, at launch. Set to `Usdc.ZERO` to skip it. */
const INITIAL_BUY = Usdc.parse("1");

/** What the follow-on buy spends, after the launch. */
const FOLLOW_ON_BUY = Usdc.parse("2");

/** How much slippage to tolerate against a fresh quote. 50 bps is 0.5%. */
const SLIPPAGE = Bps.of(50n);

/** How long an order stays valid. Five minutes is the sensible default. */
const deadline = (): Deadline => Deadline.inMinutes(5);

function line(): void {
  console.log("─".repeat(76));
}

async function main(): Promise<void> {
  const key = process.env.ARCNOW_PRIVATE_KEY;
  if (!key) {
    console.error(
      "ARCNOW_PRIVATE_KEY is not set.\n\n"
      + "This example reads your key from the environment variable ARCNOW_PRIVATE_KEY and\n"
      + "from nowhere else — there is no key in this file and there never will be. Set it\n"
      + "to a funded Arc testnet key and run it again:\n\n"
      + "    export ARCNOW_PRIVATE_KEY=0x…\n"
      + "    npm run example\n\n"
      + "The account needs enough native USDC for a 2 USDC launch fee, the buys configured\n"
      + "at the top of this file, and gas. On Arc, gas is paid in USDC too.",
    );
    process.exitCode = 1;
    return;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error(
      "ARCNOW_PRIVATE_KEY does not look like a private key: it should be 0x followed by 64\n"
      + "hex characters. Nothing has been sent anywhere.",
    );
    process.exitCode = 1;
    return;
  }

  const account = privateKeyToAccount(key as `0x${string}`);
  const client = createArcNowClient({
    network: "arc-testnet",
    account,
    ...(process.env.ARCNOW_RPC_URL === undefined
      ? {}
      : { rpcUrl: process.env.ARCNOW_RPC_URL }),
  });

  line();
  console.log("arcnow.io SDK — launch and trade on Arc testnet");
  line();
  console.log(`network        ${client.config.name} (chain ${client.config.chainId})`);
  console.log(
    `rpc            ${client.config.rpcUrl}`
    + `${process.env.ARCNOW_RPC_URL === undefined ? "" : "  (from $ARCNOW_RPC_URL)"}`,
  );
  console.log(`signing as     ${account.address}`);
  console.log(`key from       $ARCNOW_PRIVATE_KEY (never from this file)`);
  console.log(`contracts at   ${client.config.contractsCommit ?? "unknown commit"}`);
  console.log();
  console.log(
    "Amounts below are native USDC at 18 decimals. On Arc, USDC *is* the gas currency\n"
    + "and msg.value is an 18-decimal integer — not the 6 decimals the USDC ERC-20\n"
    + "predeploy reports for the same asset. The two differ by a factor of 1e12.",
  );

  await client.verifyChain();

  const balance = await client.publicClient.getBalance({ address: account.address });
  console.log();
  console.log(`your balance   ${Usdc.fromWad(balance).format()}`);

  /* ---------------------------------------------------------------------- *
   * 1. Quote the launch, and say what it costs before spending anything.
   * ---------------------------------------------------------------------- */

  line();
  console.log("1. quoting the launch");
  line();

  const suffix = Date.now().toString(36).toUpperCase().slice(-4);
  const params = {
    name: `SDK Example ${suffix}`,
    symbol: `EX${suffix}`,
    // Point this at a real metadata document for a token anyone should see.
    metadataUri: `ipfs://example-metadata-${suffix}`,
    initialBuy: INITIAL_BUY,
    minTokensOut: Tokens.ZERO, // replaced with a real floor below
  };

  const launchFee = await client.launchpad.launchFee();
  const tradeFee = await client.launchpad.tradeFeeBps();
  const quote = await client.launchpad.quoteLaunch(params);

  console.log(`launch fee     ${launchFee.format()}   (flat, immutable)`);
  console.log(
    `trade fee      ${tradeFee.toString()} = ${tradeFee.percentOfFee()}% of every trade`,
  );
  console.log(
    `initial buy    ${params.initialBuy.format()}   `
    + `(an ORDINARY buy: it pays the trade fee too)`,
  );
  console.log(`  its fee      ${quote.tradeFee.format()}`);
  console.log(`  tokens out   ${quote.tokensOut.format(params.symbol)}`);
  if (quote.graduates) {
    // The initial buy alone reaches the platform's graduation target, so this
    // launch deploys a token, graduates it and migrates it in one transaction.
    // `launch()` sends GRADUATION_GAS_LIMIT itself for that: an ESTIMATED limit
    // is precisely the one at which the migration is starved and caught.
    console.log(
      "  GRADUATES    this initial buy fills the curve. The launch will migrate it in the\n"
      + "               same transaction, and the SDK sends an explicit gas limit so that it\n"
      + "               can -- see LaunchParams.gasLimit.",
    );
  }
  console.log();
  console.log(`TOTAL TO SEND  ${quote.totalCost.format()}  — exactly, not "at least".`);
  console.log(
    "               The launchpad has no refund path and reverts on an overpayment as\n"
    + "               readily as on an underpayment.",
  );
  console.log();
  console.log(
    `You will then spend a further ${FOLLOW_ON_BUY.format()} on a buy, and sell half of\n`
    + "what you hold back to the curve. Press Ctrl-C within 5 seconds to stop.",
  );
  await new Promise((r) => setTimeout(r, 5_000));

  const { token: predictedToken, curve: predictedCurve }
    = await client.launchpad.predictAddresses(account.address, params);
  console.log();
  console.log(`predicted token ${predictedToken}`);
  console.log(`predicted curve ${predictedCurve}`);
  console.log("(valid only for this creator, this launch nonce and exactly these params)");

  /* ---------------------------------------------------------------------- *
   * 2. Launch.
   * ---------------------------------------------------------------------- */

  line();
  console.log("2. launching");
  line();

  const launch = await client.launchpad.launch({
    ...params,
    // A real floor now that we have a quote, rather than the zero above. The
    // initial buy is an ordinary buy, so it gets an ordinary slippage floor.
    minTokensOut: minTokensOutFromQuote(quote, SLIPPAGE),
  });

  console.log(`token          ${launch.token}`);
  console.log(`curve          ${launch.curve}`);
  console.log(`tokens out     ${launch.tokensOut.format(params.symbol)}`);
  console.log(`tx             ${launch.txHash}`);
  if (launch.graduated) {
    // Read from the launch's OWN receipt. A later read of the chain answers a
    // different question: migrate() is permissionless and anyone could have
    // finished the job in between.
    console.log(`graduated      yes, in this very transaction`);
    console.log(`migrated here  ${launch.migratedInThisTransaction}`);
    console.log(`pool           ${launch.pool ?? "none — the migration did not run"}`);
  }

  const curve = client.curve(launch.curve);
  const token = client.token(launch.token);

  /* ---------------------------------------------------------------------- *
   * 3. Quote a buy, then buy.
   * ---------------------------------------------------------------------- */

  line();
  console.log("3. buying");
  line();

  const buyQuote = await curve.quoteBuy(FOLLOW_ON_BUY);
  console.log(`spending       ${FOLLOW_ON_BUY.format()}`);
  console.log(`  fee          ${buyQuote.fee.format()}  (taken off the input first)`);
  console.log(`  tokens out   ${buyQuote.tokensOut.format(params.symbol)}`);
  console.log(`  new price    ${buyQuote.newPrice.toString()} USDC per token`);
  console.log(`  graduates?   ${buyQuote.graduates ? "yes" : "no"}`);

  const bought = await curve.buy({
    quoteIn: FOLLOW_ON_BUY,
    minTokensOut: minTokensOutFromQuote(buyQuote, SLIPPAGE),
    deadline: deadline(),
    // referrer / developer are optional and credit part of the fee you are
    // already paying. Omitted here, so both shares go to the platform.
  });
  console.log(`filled         ${bought.tokensOut.format(params.symbol)} for `
    + `${bought.quoteSpent.format()}`);
  if (!bought.refund.isZero()) {
    console.log(`refunded       ${bought.refund.format()} (the curve filled up)`);
  }
  console.log(`tx             ${bought.txHash}`);

  /* ---------------------------------------------------------------------- *
   * 4. Read the curve's state.
   * ---------------------------------------------------------------------- */

  line();
  console.log("4. where the curve stands");
  line();

  const state = await curve.state();
  // The curve's own VERSION(): the SDK refuses anything but arcnow/bonding-curve@2.x.x.
  console.log(`curve: ${state.version}, y0 ${state.params.y0Wad} r0 ${state.params.r0Wad}`);
  const percent = Number(state.progressBps.bps) / 100;
  const filled = Math.round(percent / 2);
  console.log(`raised         ${state.realReserve.format()} of ${state.target.format()}`);
  console.log(`progress       [${"█".repeat(filled)}${"░".repeat(50 - filled)}] `
    + `${percent.toFixed(2)}%`);
  console.log(`tokens sold    ${state.tokensSold.format(params.symbol)}`);
  console.log(`remaining      ${state.tokensRemaining.format(params.symbol)}`);
  console.log(`spot price     ${state.spotPrice.toString()} USDC per token`);
  console.log(
    "               (the marginal price — NOT what a trade of any size fills at;\n"
    + "                the curve integrates the price across your own order)",
  );
  console.log(`graduated      ${state.graduated ? "yes" : "no"}`);
  console.log(`graduates to   ${state.migrator}`);
  console.log("               (snapshotted at launch and immutable — ask the curve, not a");
  console.log("                network-wide venue list)");

  /* ---------------------------------------------------------------------- *
   * 5. Quote a sell, then sell. No approval, anywhere.
   * ---------------------------------------------------------------------- */

  line();
  console.log("5. selling — with no approve step, because none exists");
  line();

  const held = await token.balanceOf(account.address);
  const selling = Tokens.fromWad(held.wad / 2n);
  console.log(`you hold       ${held.format(params.symbol)}`);
  console.log(`selling        ${selling.format(params.symbol)}`);

  const allowance = await token.allowance(account.address, launch.curve);
  console.log(`allowance      ${allowance.toString()} — and it stays that way.`);
  console.log(
    "               The curve pulls tokens through a privileged path that reads no\n"
    + "               allowance at all. A holder who has approved nobody can always sell.",
  );

  const sellQuote = await curve.quoteSell(selling);
  console.log(`  gross        ${sellQuote.gross.format()}`);
  console.log(`  fee          ${sellQuote.fee.format()}`);
  console.log(`  you receive  ${sellQuote.quoteOut.format()}`);

  const sold = await curve.sell({
    tokensIn: selling,
    minQuoteOut: minQuoteOutFromQuote(sellQuote, SLIPPAGE),
    deadline: deadline(),
  });
  console.log(`received       ${sold.quoteOut.format()}`);
  console.log(`tx             ${sold.txHash}`);
  console.log(
    `allowance      ${(await token.allowance(account.address, launch.curve)).toString()} `
    + "— still zero, after a completed sell.",
  );

  /* ---------------------------------------------------------------------- *
   * 6. Where the fee went.
   * ---------------------------------------------------------------------- */

  line();
  console.log("6. where that fee went — five ways, in bps OF THE FEE");
  line();

  const split = await curve.previewFeeSplit(sold.fee);
  const config = await curve.feeConfig();
  const rows: [string, typeof split.creatorAmount, typeof config.creatorShareBps, string][] = [
    ["creator", split.creatorAmount, config.creatorShareBps, split.creator],
    ["platform", split.platformAmount, config.platformShareBps, split.platform],
    ["ref", split.refAmount, config.refShareBps, split.ref],
    ["dev", split.devAmount, config.devShareBps, split.dev],
    ["protocol", split.protocolAmount, config.protocolShareBps, split.protocol],
  ];
  console.log(`fee            ${sold.fee.format()}`);
  for (const [name, amount, share, recipient] of rows) {
    console.log(
      `  ${name.padEnd(10)} ${share.bps.toString().padStart(5)} bps of the fee = `
      + `${share.percentOfTrade(tradeFee).toFixed(2)}% of the trade  `
      + `${amount.toString().padStart(22)}  ${recipient}`,
    );
  }
  console.log();
  console.log(
    "The platform's share is the RESIDUAL — 10000 minus the other four — and is never\n"
    + "an input anywhere in the contracts. With no referrer and no developer named, both\n"
    + "of those shares go to the platform recipient too, which is the same rule as a\n"
    + "zero configured share.",
  );

  line();
  console.log("done.");
  console.log(`token   ${launch.token}`);
  console.log(`curve   ${launch.curve}`);
  line();
}

try {
  await main();
} catch (error) {
  if (isArcNowError(error)) {
    // One error type for the whole SDK, and the message says what to do.
    console.error(`\n${error.code}: ${error.message}`);
    if (Object.keys(error.args).length > 0) {
      console.error("\ndecoded arguments:", error.args);
    }
  } else {
    console.error("\nunexpected failure:", error);
  }
  process.exitCode = 1;
}
