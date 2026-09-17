/**
 * A launch in native USDC (fee plus initial buy sent as value) or in an ERC-20
 * quote (fee plus initial buy pulled, after an exact approve), with the launch
 * fee capped so a fee raised while the transaction is pending reverts rather
 * than overcharging.
 */

import type { Address } from "viem";
import { erc20Abi, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_QUOTE, QuoteAmount, Tokens, Usdc } from "../../src/amounts.js";
import { createArcNowClient } from "../../src/client.js";
import { isArcNowError } from "../../src/errors/index.js";
import { bondingCurveAbi, launchpadAbi, platformConfigAbi, quoteRegistryAbi }
  from "../../src/generated/abi/index.js";
import { resolveNetwork } from "../../src/networks.js";
import { FakeChain, fakeErc20, Revert } from "./support/fake-chain.js";

const PRESET = resolveNetwork("arc-testnet");
const EURC = PRESET.quoteTokens.find((token) => token.symbol === "EURC")!;
const LAUNCHPAD = PRESET.contracts.launchpad;
const PLATFORM = PRESET.contracts.arcnowPlatform;
const REGISTRY: Address = "0x00000000000000000000000000000000000e0001";
const CREATOR: Address = "0x00000000000000000000000000000000000000c0";
const TOKEN: Address = "0x00000000000000000000000000000000000a0001";
const CURVE: Address = "0x00000000000000000000000000000000000c0001";
const WAD = 10n ** 18n;
const FEE = 2n * WAD;

const TEMPLATE = {
  totalSupplyWad: 1_000_000n * WAD,
  curveSupplyWad: 790_931_776_678_561_246_309_959n,
  y0Wad: 1_075_119_882_918_585_400_293_717n,
  r0Wad: 17_965_399_457_930_722_779n,
  targetQuoteWad: 50n * WAD,
  initialPriceWad: 16_710_135_998_192n,
};

type Params = { quoteToken: Address; initialBuyWad: bigint; maxLaunchFeeWad: bigint };

function setup(allowance = 0n, launchpadVersion = "arcnow/launchpad@3.0.0", revertLaunch = false) {
  const seenTemplates: Address[] = [];
  const eurc = fakeErc20({
    label: "eurc", address: EURC.address, abi: erc20Abi, symbol: "EURC", name: "EURC", decimals: 6,
    balances: { [CREATOR]: 10n ** 12n },
    allowances: { [`${CREATOR}:${LAUNCHPAD}`]: allowance },
  });
  const chain = new FakeChain({
    [LAUNCHPAD]: {
      label: "launchpad",
      abi: launchpadAbi,
      reads: {
        VERSION: () => launchpadVersion,
        quoteTokenRegistry: () => REGISTRY,
        quoteLaunch: ([params]) => {
          const p = params as Params;
          const native = p.quoteToken === NATIVE_QUOTE;
          const tokensOut = p.initialBuyWad === 0n ? 0n : 1_234n * WAD;
          return [FEE, native ? FEE + p.initialBuyWad : 0n, tokensOut, p.initialBuyWad / 100n];
        },
        predictAddresses: () => [TOKEN, CURVE],
      },
      writes: {
        launch: ([params], context) => revertLaunch
          ? (() => { throw new Revert(launchpadAbi, "QuoteTokenNotSupported", [EURC.address]); })()
          : ({
              result: [TOKEN, CURVE, 1_234n * WAD],
              logs: [{
                address: LAUNCHPAD,
                abi: launchpadAbi,
                eventName: "Launched",
                args: {
                  token: TOKEN, curve: CURVE, creator: context.from, platform: PLATFORM,
                  migrator: zeroAddress, quoteToken: (params as Params).quoteToken,
                  launchFeeWad: FEE,
                  initialBuyWad: (params as Params).initialBuyWad, tokensOutWad: 1_234n * WAD,
                },
              }],
            }),
      },
    },
    [PLATFORM]: {
      label: "platform",
      abi: platformConfigAbi,
      reads: {
        VERSION: () => "arcnow/platform-config@4.0.0",
        curveParametersFor: ([quote]) => {
          seenTemplates.push(quote as Address);
          return TEMPLATE;
        },
      },
    },
    [REGISTRY]: {
      label: "registry",
      abi: quoteRegistryAbi,
      reads: {
        quoteInfo: ([quote]) => [String(quote) === NATIVE_QUOTE ? 18 : 6, FEE, true],
      },
    },
    [EURC.address]: eurc,
  });
  const client = createArcNowClient({
    // The registry this fixture scripts, in place of the deployed one the preset records.
    network: { ...PRESET, contracts: { ...PRESET.contracts, quoteRegistry: REGISTRY } },
    transport: chain.transport(),
    account: CREATOR,
  });
  return { chain, eurc, client, seenTemplates };
}

const base = { name: "Example", symbol: "EXMPL", metadataUri: "ipfs://example", minTokensOut: Tokens.ZERO };

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    if (!isArcNowError(error)) throw error;
    return { code: String(error.code), message: error.message };
  }
  throw new Error("expected a refusal");
}

describe("quoting a launch", () => {
  it("reports the fee, the total in the quote, and the value to send, for native USDC", async () => {
    const { client, seenTemplates } = setup();
    const quote = await client.launchpad.quoteLaunch({ ...base, initialBuy: Usdc.parse("10") });
    expect(quote.quoteToken.isNative).toBe(true);
    expect(quote.launchFee.eq(Usdc.fromWhole(2n))).toBe(true);
    expect(quote.totalCost.eq(Usdc.fromWhole(12n))).toBe(true);
    expect(quote.nativeValue.eq(Usdc.fromWhole(12n))).toBe(true);
    expect(quote.tradeFee.eq(Usdc.parse("0.1"))).toBe(true);
    expect(quote.graduates).toBe(false);
    expect(seenTemplates).toEqual([NATIVE_QUOTE]);
  });

  it("reports the same in EURC with no value, and reads the EURC template", async () => {
    const { client, seenTemplates } = setup();
    const quote = await client.launchpad.quoteLaunch({ ...base, initialBuy: QuoteAmount.parse(EURC, "60") });
    expect(quote.quoteToken).toEqual(EURC);
    expect(quote.launchFee.format()).toBe("2 EURC");
    expect(quote.totalCost.format()).toBe("62 EURC");
    expect(quote.nativeValue.isZero()).toBe(true);
    expect(quote.nativeValue.token.isNative).toBe(true);
    expect(quote.graduates).toBe(true);
    expect(seenTemplates).toEqual([EURC.address]);
  });

  it("reads the launch fee per quote from the registry", async () => {
    const { client } = setup();
    expect((await client.launchpad.launchFee()).eq(Usdc.fromWhole(2n))).toBe(true);
    expect((await client.launchpad.launchFee(EURC.address)).format()).toBe("2 EURC");
  });
});

describe("launching in native USDC", () => {
  it("sends the quoted native value, encodes the quote, and caps the fee at the quote", async () => {
    const { chain, client } = setup();
    const result = await client.launchpad.launch({ ...base, initialBuy: Usdc.parse("10") });
    expect(chain.sends()).toEqual(["launchpad.launch"]);
    expect(chain.sent[0]?.value).toBe(12n * WAD);
    const params = chain.sent[0]?.args[0] as Params;
    expect(params.quoteToken).toBe(NATIVE_QUOTE);
    expect(params.maxLaunchFeeWad).toBe(FEE);
    expect(result.token).toBe(TOKEN);
    expect(result.approvalTxHash).toBeUndefined();
  });

  it("passes a caller's own fee cap through", async () => {
    const { chain, client } = setup();
    await client.launchpad.launch({ ...base, initialBuy: Usdc.ZERO, maxLaunchFee: Usdc.parse("2.5") });
    expect((chain.sent[0]?.args[0] as Params).maxLaunchFeeWad).toBe(25n * 10n ** 17n);
  });

  it("refuses a fee cap in another quote", async () => {
    const { chain, client } = setup();
    const refused = await refusal(() => client.launchpad.launch({
      ...base, initialBuy: Usdc.parse("1"), maxLaunchFee: QuoteAmount.parse(EURC, "2"),
    }));
    expect(refused.code).toBe("QuoteTokenMismatch");
    expect(chain.sent).toEqual([]);
  });
});

describe("launching in EURC", () => {
  it("approves exactly fee + initial buy to the launchpad, then launches with no value", async () => {
    const { chain, eurc, client } = setup(0n);
    const result = await client.launchpad.launch({ ...base, initialBuy: QuoteAmount.parse(EURC, "10") });
    expect(chain.sends()).toEqual(["eurc.approve", "launchpad.launch"]);
    expect(chain.sent[0]?.args).toEqual([LAUNCHPAD, 12_000_000n]);
    expect(eurc.allowances.get(`${CREATOR}:${LAUNCHPAD}`.toLowerCase())).toBe(12_000_000n);
    expect(chain.sent[1]?.value).toBe(0n);
    const params = chain.sent[1]?.args[0] as Params;
    expect(params.quoteToken).toBe(EURC.address);
    expect(params.initialBuyWad).toBe(10n * WAD);
    expect(params.maxLaunchFeeWad).toBe(FEE);
    expect(result.approvalTxHash).toBe(chain.sent[0]?.hash);
  });

  it("sends no approve when the allowance already covers the launch", async () => {
    const { chain, client } = setup(12_000_000n);
    await client.launchpad.launch({ ...base, initialBuy: QuoteAmount.parse(EURC, "10") });
    expect(chain.sends()).toEqual(["launchpad.launch"]);
  });

  it("sends an ordinary EURC launch at the estimate plus headroom (contracts#23)", async () => {
    const { chain, client } = setup(12_000_000n);
    await client.launchpad.launch({ ...base, initialBuy: QuoteAmount.parse(EURC, "10") });
    expect(chain.sent[0]?.gas).toBe(250_000n);
  });

  it.each([
    ["an ordinary launch below the safe minimum is raised to it", "10", 100_000n, 250_000n],
    ["an ordinary launch above it is kept", "10", 900_000n, 900_000n],
    ["a graduating launch at the floor is raised to GRADUATION_GAS_LIMIT", "60", 6_200_000n, 8_000_000n],
    ["a graduating launch above GRADUATION_GAS_LIMIT is kept", "60", 9_000_000n, 9_000_000n],
  ] as const)("a caller's gasLimit on a EURC launch: %s", async (_, buy, asked, sent) => {
    const { chain, client } = setup(10n ** 12n);
    await client.launchpad.launch({
      ...base, initialBuy: QuoteAmount.parse(EURC, buy), gasLimit: asked,
    });
    expect(chain.sent[0]?.gas).toBe(sent);
  });

  it("still refuses a graduating EURC launch below the floor, before sending", async () => {
    const { chain, client } = setup(10n ** 12n);
    const refused = await refusal(() => client.launchpad.launch({
      ...base, initialBuy: QuoteAmount.parse(EURC, "60"), gasLimit: 6_199_999n,
    }));
    expect(refused.message).toMatch(/below the 6200000/);
    expect(chain.sent).toEqual([]);
  });

  it("refuses an initial buy with dust below one raw unit before any RPC", async () => {
    const { chain, client } = setup();
    const refused = await refusal(() => client.launchpad.launch({
      ...base, initialBuy: QuoteAmount.fromWad(EURC, WAD + 7n),
    }));
    expect(refused.code).toBe("QuoteAmountNotRepresentable");
    expect(chain.rpc).toEqual([]);
  });
});

describe("review: the launchpad's version, and no approve for a launch that reverts", () => {
  it("refuses a version-2 launchpad before quoting or sending", async () => {
    const { chain, client } = setup(0n, "arcnow/launchpad@2.0.0");
    for (const run of [
      () => client.launchpad.quoteLaunch({ ...base, initialBuy: Usdc.parse("1") }),
      () => client.launchpad.launch({ ...base, initialBuy: QuoteAmount.parse(EURC, "1") }),
    ]) {
      expect((await refusal(run)).code).toBe("UnknownCurveVersion");
    }
    expect(chain.calls).not.toContain("launchpad.quoteLaunch");
    expect(chain.sent).toEqual([]);
  });

  it("simulates an ERC-20 launch with the allowance overridden, and sends no approve when it reverts", async () => {
    const { chain, client } = setup(0n, "arcnow/launchpad@3.0.0", true);
    const refused = await refusal(() => client.launchpad.launch({
      ...base, initialBuy: QuoteAmount.parse(EURC, "1"),
    }));
    expect(refused.code).toBe("QuoteTokenNotSupported");
    expect(Object.keys(chain.simulations[0]?.stateOverride ?? {})).toContain(EURC.address);
    expect(chain.sent).toEqual([]);
  });
});

void bondingCurveAbi;
