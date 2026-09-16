/**
 * Slippage floors.
 *
 * `minTokensOut` and `minUsdcOut` are **required arguments** on every trade in
 * this SDK, not optional ones defaulting to zero. That is deliberate: passing
 * zero means "fill me at any price", and on a public mempool that is a
 * donation. Making the argument mandatory means a caller has to type the zero
 * themselves, and typing it is a decision rather than an omission.
 *
 * The curve's price rises across your own order — the input is integrated along
 * the curve rather than filled at the spot price — so a large order fills worse
 * than `spotPrice` suggests even with nobody else trading. Quote first, then
 * put a tolerance on the quote.
 *
 * @module
 */

import type { QuoteAmount } from "./amounts.js";
import { Bps, QuoteAmount as Quote, Tokens } from "./amounts.js";

/**
 * A floor `toleranceBps` below what a quote promised.
 *
 * `Bps.of(50)` is 0.5%, which is a reasonable starting point on a quiet curve
 * and much too tight on a busy one. There is no universally right number: the
 * cost of being wrong in one direction is a reverted transaction and in the
 * other is a worse fill, and only the caller knows which they mind more.
 *
 * Takes anything carrying a `tokensOut`, so it serves a
 * {@link BuyQuote} and a {@link LaunchQuote} alike — the initial buy in a
 * launch is an ordinary buy and deserves an ordinary slippage floor, and a
 * helper that only accepted one of the two would push callers into a cast.
 */
export function minTokensOutFromQuote(
  quote: { readonly tokensOut: Tokens },
  toleranceBps: Bps,
): Tokens {
  const floor
    = (quote.tokensOut.wad * (Bps.DENOMINATOR - toleranceBps.bps)) / Bps.DENOMINATOR;
  return Tokens.fromWad(floor);
}

/** The same, for the USDC side of a sell. */
export function minQuoteOutFromQuote(
  quote: { readonly quoteOut: QuoteAmount },
  toleranceBps: Bps,
): QuoteAmount {
  const floor = (quote.quoteOut.wad * (Bps.DENOMINATOR - toleranceBps.bps)) / Bps.DENOMINATOR;
  return Quote.fromWad(quote.quoteOut.token, floor);
}
