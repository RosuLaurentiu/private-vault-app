import { describe, expect, it } from "vitest";
import { APP_CONFIG, ZERO_ADDRESS } from "./config";
import { arbLegAmounts, bridgeRouteMetadata, buildRebalanceSummary, candidateAmounts, opportunityBlocker, parseCoinGeckoUsdPrice, selectRebalanceSuggestions } from "./engine";
import type { Opportunity, RebalanceSuggestion, TokenBalance, WalletBalances } from "./types";

function opportunity(direction: Opportunity["direction"], inputAmount: number, bridgeOutputAmount: number): Pick<Opportunity, "direction" | "summary"> {
  return {
    direction,
    summary: {
      bridgeOutputAmount,
      bridgeOutputSymbol: "gCOTI",
      gasUsd: 0,
      grossProfitUsd: 0,
      inputAmount,
      inputSymbol: "COTI",
      outputAmount: 0,
      outputSymbol: "COTI",
      profitTokenAmount: 0,
      profitTokenSymbol: "COTI",
    },
  };
}

function suggestion(overrides: Partial<RebalanceSuggestion>): RebalanceSuggestion {
  return {
    amount: 10,
    direction: "coti-to-ethereum",
    executable: true,
    sourceBalance: 20,
    sourceChain: "coti",
    targetBalance: 0,
    targetChain: "ethereum",
    token: "coti",
    tokenSymbol: "COTI",
    ...overrides,
  };
}

function balance(symbol: string, value: number): TokenBalance {
  return {
    address: `0x${symbol.toLowerCase()}`,
    decimals: 18,
    raw: String(value * 10 ** 18),
    symbol,
    value,
  };
}

function balances(overrides: Partial<WalletBalances> = {}): WalletBalances {
  return {
    ethereum: {
      native: balance("ETH", 1),
      tokens: {
        coti: balance("COTI", 0),
        gcoti: balance("gCOTI", 0),
        usdc: balance("USDC", 0),
      },
    },
    coti: {
      native: balance("COTI", 1),
      tokens: {
        coti: balance("COTI", 0),
        gcoti: balance("gCOTI", 0),
        usdc: balance("USDC", 0),
      },
    },
    ...overrides,
  };
}

describe("arb leg amounts", () => {
  it("uses the intermediate amount for COTI/gCOTI Carbon -> Uniswap", () => {
    const amounts = arbLegAmounts(opportunity("buy_on_carbon_sell_on_uniswap", 1000, 4300));
    expect(amounts.carbonSourceAmount).toBe(1000);
    expect(amounts.uniswapSourceAmount).toBe(4300);
  });

  it("uses the intermediate amount for COTI/USDC Carbon -> Uniswap", () => {
    const amounts = arbLegAmounts(opportunity("buy_on_carbon_sell_on_uniswap", 250, 9100));
    expect(amounts.carbonSourceAmount).toBe(250);
    expect(amounts.uniswapSourceAmount).toBe(9100);
  });

  it("covers the observed gCOTI amount regression", () => {
    const amounts = arbLegAmounts(opportunity("buy_on_carbon_sell_on_uniswap", 16896.141944999999, 73246.38350181955));
    expect(amounts.carbonSourceAmount).toBe(16896.141944999999);
    expect(amounts.uniswapSourceAmount).toBe(73246.38350181955);
  });

  it("keeps Uniswap -> Carbon source amounts unchanged", () => {
    const amounts = arbLegAmounts(opportunity("buy_on_uniswap_sell_on_carbon", 500, 1200));
    expect(amounts.uniswapSourceAmount).toBe(500);
    expect(amounts.carbonSourceAmount).toBe(1200);
  });
});

describe("arb net eligibility", () => {
  it("allows any positive net after fees", () => {
    expect(opportunityBlocker([], 0.01)).toBeUndefined();
  });

  it("blocks zero or negative net after fees", () => {
    expect(opportunityBlocker([], 0)).toBe("Net after estimated fees is not positive.");
    expect(opportunityBlocker([], -0.01)).toBe("Net after estimated fees is not positive.");
  });

  it("does not use the old ten dollar warning", () => {
    expect(opportunityBlocker([], 9.99)).toBeUndefined();
  });
});

describe("COTI/USD quote math", () => {
  it("parses the CoinGecko payload shape used by the Discord bot", () => {
    expect(parseCoinGeckoUsdPrice({ coti: { usd: 0.016131 } }, "coti")).toBe(0.016131);
    expect(parseCoinGeckoUsdPrice({ coti: { usd: "0.016131" } }, "coti")).toBe(0.016131);
    expect(parseCoinGeckoUsdPrice({ coti: { usd: 0 } }, "coti")).toBeNull();
    expect(parseCoinGeckoUsdPrice({}, "coti")).toBeNull();
  });
});

describe("quote search range", () => {
  it("scans COTI/USDC amounts above the old 250 USDC probe ceiling", () => {
    const amounts = candidateAmounts(3000, "coti-usdc");
    expect(amounts.some((amount) => amount > 900 && amount < 1100)).toBe(true);
    expect(Math.max(...amounts)).toBe(3000);
  });
});

describe("rebalance summary", () => {
  it("skips small rebalance amounts below the configured minimum", () => {
    const summary = buildRebalanceSummary({
      balances: balances({
        ethereum: {
          native: balance("ETH", 1),
          tokens: {
            coti: balance("COTI", 100),
            gcoti: balance("gCOTI", 100),
            usdc: balance("USDC", 0),
          },
        },
        coti: {
          native: balance("COTI", 1),
          tokens: {
            coti: balance("COTI", 60),
            gcoti: balance("gCOTI", 20),
            usdc: balance("USDC", 0),
          },
        },
      }),
    });
    const coti = summary.suggestions.find((item) => item.token === "coti");
    const gcoti = summary.suggestions.find((item) => item.token === "gcoti");
    expect(coti).toMatchObject({
      executable: false,
    });
    expect(coti?.reason).toBeUndefined();
    expect(gcoti).toMatchObject({
      amount: 40,
      executable: true,
    });
  });

  it("filters executable rebalance suggestions by selected token", () => {
    const summary = {
      executable: true,
      suggestions: [
        suggestion({ amount: 25, token: "coti", tokenSymbol: "COTI" }),
        suggestion({ amount: 30, token: "gcoti", tokenSymbol: "gCOTI" }),
      ],
    };
    expect(selectRebalanceSuggestions(summary, ["coti"]).executable.map((item) => item.token)).toEqual(["coti"]);
    expect(selectRebalanceSuggestions(summary, ["gcoti"]).executable.map((item) => item.token)).toEqual(["gcoti"]);
    expect(selectRebalanceSuggestions(summary).executable.map((item) => item.token)).toEqual(["coti", "gcoti"]);
  });
});

describe("bridge route metadata", () => {
  const carbonGcoti = "0x7637C7838EC4Ec6b85080F28A678F8E234bB83D1";

  it("uses zero address for native COTI from COTI to Ethereum", () => {
    const route = bridgeRouteMetadata(suggestion({ token: "coti", tokenSymbol: "COTI" }), carbonGcoti);
    expect(route.sourceNetworkId).toBe(String(APP_CONFIG.coti.chainId));
    expect(route.destinationNetworkId).toBe(String(APP_CONFIG.ethereum.chainId));
    expect(route.tokenAddress).toBe(ZERO_ADDRESS);
  });

  it("uses the COTI-chain gCOTI address from COTI to Ethereum", () => {
    const route = bridgeRouteMetadata(suggestion({ token: "gcoti", tokenSymbol: "gCOTI" }), carbonGcoti);
    expect(route.tokenAddress).toBe(carbonGcoti);
  });

  it("uses Ethereum token addresses from Ethereum to COTI", () => {
    const route = bridgeRouteMetadata(suggestion({
      direction: "ethereum-to-coti",
      sourceChain: "ethereum",
      targetChain: "coti",
      token: "gcoti",
      tokenSymbol: "gCOTI",
    }), carbonGcoti);
    expect(route.sourceNetworkId).toBe(String(APP_CONFIG.ethereum.chainId));
    expect(route.destinationNetworkId).toBe(String(APP_CONFIG.coti.chainId));
    expect(route.tokenAddress).toBe(APP_CONFIG.uniswap.gcoti);
  });
});
