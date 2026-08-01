import { ChainCache } from "@bancor/carbon-sdk/chain-cache";
import { ContractsApi } from "@bancor/carbon-sdk/contracts-api";
import { Toolkit } from "@bancor/carbon-sdk/strategy-management";
import { Contract, Interface, JsonRpcProvider, formatEther, formatUnits, getAddress } from "ethers";
import { ERC20_ABI, UNISWAP_FACTORY_ABI, UNISWAP_PAIR_ABI, UNISWAP_ROUTER_ABI } from "./abis";
import { APP_CONFIG, NATIVE_COTI, ZERO_ADDRESS } from "./config";
import { assertAllowedPlan, assertAllowedRebalancePlan } from "./guards";
import { decimalStringToRaw, tokenAmountMetadata } from "./tradeMetadata";
import type {
  AllowanceState,
  BridgeStepMetadata,
  CarbonContext,
  Direction,
  Opportunity,
  PairId,
  PreparedPlan,
  PreparedRebalancePlan,
  PreparedStep,
  QuoteResult,
  RebalancePlanOptions,
  RebalanceSummary,
  RebalanceSuggestion,
  RebalanceTokenId,
  TokenBalance,
  TradeStepMetadata,
  WalletBalances,
  WalletInventoryState,
  WalletState,
} from "./types";
import {
  cleanAmount,
  gasWithBuffer,
  hexValue,
  isNativeToken,
  minOutRaw,
  normalizeAddress,
  parseTokenAmount,
  sameAddress,
} from "./utils";

const erc20Interface = new Interface(ERC20_ABI);
const routerInterface = new Interface(UNISWAP_ROUTER_ABI);
const ethProvider = new JsonRpcProvider(APP_CONFIG.ethRpcUrl);
const cotiProvider = new JsonRpcProvider(APP_CONFIG.cotiRpcUrl);
const GAS_UNITS = {
  erc20Approval: 55000,
  bridgeNative: 21000,
  bridgeToken: 70000,
  uniswapSwap: 180000,
  carbonSwap: 350000,
} as const;
const uniswapPathCache = new Map<string, Promise<string[]>>();

interface FeeRates {
  cotiUsdPerGas: number;
  ethUsdPerGas: number;
}

interface PriceLookup {
  error?: string;
  source: "fresh" | "unavailable";
  value: number | null;
}

function token(provider: JsonRpcProvider, address: string): Contract {
  return new Contract(address, ERC20_ABI, provider);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

function cacheBustUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("_walletConsoleTs", String(Date.now()));
  return parsed.toString();
}

export function parseCoinGeckoUsdPrice(payload: unknown, id: string): number | null {
  const record = payload as Record<string, { usd?: unknown } | undefined>;
  const value = Number(record?.[id]?.usd);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalPairKey(tokenA: string, tokenB: string): string {
  return [tokenA.toLowerCase(), tokenB.toLowerCase()].sort().join("_");
}

function normalizeSeedData(seedData: unknown): { latestBlockNumber: number; pairs: Array<{ fee?: number; pair: [string, string]; strategies: unknown[] }> } {
  const record = seedData as Record<string, unknown>;
  if (record.strategiesByPair && typeof record.strategiesByPair === "object") {
    const byPair = new Map<string, { fee?: number; pair: [string, string]; strategiesById: Map<string, unknown> }>();
    for (const [pairKey, strategies] of Object.entries(record.strategiesByPair as Record<string, unknown>)) {
      const [token0, token1] = pairKey.split("_");
      if (!token0 || !token1) continue;
      const canonicalKey = canonicalPairKey(token0, token1);
      if (!byPair.has(canonicalKey)) {
        byPair.set(canonicalKey, { pair: [token0, token1], strategiesById: new Map<string, unknown>() });
      }
      const entry = byPair.get(canonicalKey);
      for (const strategy of Array.isArray(strategies) ? strategies : []) {
        const strategyRecord = strategy as Record<string, unknown>;
        const id = String(strategyRecord.id ?? entry?.strategiesById.size ?? "");
        entry?.strategiesById.set(id, strategy);
      }
    }
    const feeByPair = record.tradingFeePPMByPair && typeof record.tradingFeePPMByPair === "object"
      ? record.tradingFeePPMByPair as Record<string, unknown>
      : {};
    for (const [pairKey, fee] of Object.entries(feeByPair)) {
      const [token0, token1] = pairKey.split("_");
      if (!token0 || !token1) continue;
      const entry = byPair.get(canonicalPairKey(token0, token1));
      if (entry && entry.fee === undefined) entry.fee = Number(fee);
    }
    return {
      latestBlockNumber: Number(record.latestBlockNumber || 0),
      pairs: Array.from(byPair.values()).map((entry) => ({
        fee: entry.fee,
        pair: entry.pair,
        strategies: Array.from(entry.strategiesById.values()),
      })),
    };
  }

  const rawPairs = Array.isArray(record.pairs)
    ? record.pairs
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.results)
        ? record.results
        : [];
  const pairs = rawPairs.flatMap((item): Array<{ fee?: number; pair: [string, string]; strategies: unknown[] }> => {
    const entry = item as Record<string, unknown>;
    const pair = Array.isArray(entry.pair) ? entry.pair : Array.isArray(entry.tokens) ? entry.tokens : null;
    const strategies = Array.isArray(entry.strategies) ? entry.strategies : Array.isArray(entry.orders) ? entry.orders : [];
    if (!pair || pair.length < 2) return [];
    return [{
      fee: Number(entry.fee ?? entry.tradingFeePPM ?? entry.tradingFee),
      pair: [String(pair[0]), String(pair[1])],
      strategies,
    }];
  });
  return {
    latestBlockNumber: Number(record.latestBlockNumber || record.blockNumber || record.block || 0),
    pairs,
  };
}

let carbonContextPromise: Promise<CarbonContext> | null = null;

export async function fetchCarbonContext(): Promise<CarbonContext> {
  if (carbonContextPromise) return carbonContextPromise;
  carbonContextPromise = (async () => {
    const [seedData, tokens] = await Promise.all([
      fetchJson<unknown>(`${APP_CONFIG.carbonApiBase}/v1/${APP_CONFIG.carbonExchangeId}/seed-data?page=0&pageSize=0`),
      fetchJson<Array<{ address: string; decimals: number; symbol: string }>>(`${APP_CONFIG.carbonApiBase}/v1/${APP_CONFIG.carbonExchangeId}/tokens`),
    ]);
    const normalized = normalizeSeedData(seedData);
    const cache = new ChainCache();
    cache.bulkAddPairs(normalized.pairs.map((item) => ({ pair: item.pair, strategies: item.strategies })) as never);
    for (const item of normalized.pairs) {
      if (Number.isFinite(item.fee)) cache.addPairFees(item.pair[0], item.pair[1], Number(item.fee));
    }
    cache.applyEvents([], normalized.latestBlockNumber);

    const decimalsMap = new Map(tokens.map((item) => [item.address.toLowerCase(), Number(item.decimals)]));
    const coti = tokens.find((item) => item.symbol.toLowerCase() === "coti");
    const gcoti = tokens.find((item) => item.symbol.toLowerCase() === "gcoti");
    const usdc = tokens.find((item) => item.symbol.toLowerCase() === "usdce" || sameAddress(item.address, "0xf1Feebc4376c68B7003450ae66343Ae59AB37D3C"));
    if (!coti || !gcoti || !usdc) throw new Error("Carbon token list did not include COTI, gCOTI, and USDCe.");

    const api = new ContractsApi(cotiProvider, { carbonControllerAddress: APP_CONFIG.carbonController });
    const sdk = new Toolkit(api, cache, async (address: string) => {
      const decimals = decimalsMap.get(address.toLowerCase());
      if (decimals === undefined) throw new Error(`Missing Carbon decimals for ${address}`);
      return decimals;
    });
    return {
      sdk,
      cotiAddress: getAddress(coti.address),
      gcotiAddress: getAddress(gcoti.address),
      usdcAddress: getAddress(usdc.address),
    } as unknown as CarbonContext;
  })();
  return carbonContextPromise;
}

async function tokenBalance(provider: JsonRpcProvider, owner: string, address: string, fallbackSymbol: string): Promise<TokenBalance> {
  if (isNativeToken(address)) {
    const raw = await provider.getBalance(owner);
    return { address, decimals: 18, raw: raw.toString(), symbol: fallbackSymbol, value: Number(formatEther(raw)) };
  }
  const contract = token(provider, address);
  const [raw, decimals, symbol] = await Promise.all([
    contract.balanceOf(owner) as Promise<bigint>,
    contract.decimals().then(Number) as Promise<number>,
    contract.symbol().catch(() => fallbackSymbol) as Promise<string>,
  ]);
  return { address, decimals, raw: raw.toString(), symbol, value: Number(formatUnits(raw, decimals)) };
}

async function allowance(provider: JsonRpcProvider, owner: string, tokenAddress: string, spender: string, decimals: number): Promise<AllowanceState> {
  if (isNativeToken(tokenAddress)) return { native: true, raw: null, value: Number.POSITIVE_INFINITY };
  const raw = await token(provider, tokenAddress).allowance(owner, spender) as bigint;
  return { raw: raw.toString(), value: Number(formatUnits(raw, decimals)) };
}

async function loadWalletBalances(owner: string, carbon: CarbonContext): Promise<WalletBalances> {
  const [ethNative, ethCoti, ethGcoti, ethUsdc, cotiNative, carbonGcoti, carbonUsdc] = await Promise.all([
    tokenBalance(ethProvider, owner, NATIVE_COTI, "ETH"),
    tokenBalance(ethProvider, owner, APP_CONFIG.uniswap.coti, "COTI"),
    tokenBalance(ethProvider, owner, APP_CONFIG.uniswap.gcoti, "gCOTI"),
    tokenBalance(ethProvider, owner, APP_CONFIG.uniswap.usdc, "USDC"),
    tokenBalance(cotiProvider, owner, NATIVE_COTI, "COTI"),
    tokenBalance(cotiProvider, owner, carbon.gcotiAddress, "gCOTI"),
    tokenBalance(cotiProvider, owner, carbon.usdcAddress, "USDCe"),
  ]);
  const carbonCoti: TokenBalance = { ...cotiNative, address: carbon.cotiAddress, symbol: "COTI" };
  return {
    ethereum: { native: ethNative, tokens: { coti: ethCoti, gcoti: ethGcoti, usdc: ethUsdc } },
    coti: { native: cotiNative, tokens: { coti: carbonCoti, gcoti: carbonGcoti, usdc: carbonUsdc } },
  };
}

export async function loadWalletInventory(walletAddress: string): Promise<WalletInventoryState> {
  const owner = normalizeAddress(walletAddress, "wallet");
  const carbon = await fetchCarbonContext();
  const balances = await loadWalletBalances(owner, carbon);
  return {
    balances,
    generatedAtUtc: new Date().toISOString(),
    rebalance: buildRebalanceSummary({ balances }),
    wallet: owner,
  };
}

export async function loadWalletState(walletAddress: string): Promise<WalletState> {
  const owner = normalizeAddress(walletAddress, "wallet");
  const carbon = await fetchCarbonContext();
  const balances = await loadWalletBalances(owner, carbon);
  const [ethCotiAllowance, ethGcotiAllowance, ethUsdcAllowance, carbonGcotiAllowance, carbonUsdcAllowance] = await Promise.all([
    allowance(ethProvider, owner, APP_CONFIG.uniswap.coti, APP_CONFIG.uniswap.router, balances.ethereum.tokens.coti.decimals),
    allowance(ethProvider, owner, APP_CONFIG.uniswap.gcoti, APP_CONFIG.uniswap.router, balances.ethereum.tokens.gcoti.decimals),
    allowance(ethProvider, owner, APP_CONFIG.uniswap.usdc, APP_CONFIG.uniswap.router, balances.ethereum.tokens.usdc.decimals),
    allowance(cotiProvider, owner, carbon.gcotiAddress, APP_CONFIG.carbonController, balances.coti.tokens.gcoti.decimals),
    allowance(cotiProvider, owner, carbon.usdcAddress, APP_CONFIG.carbonController, balances.coti.tokens.usdc.decimals),
  ]);
  return {
    allowances: {
      ethereum: { coti: ethCotiAllowance, gcoti: ethGcotiAllowance, usdc: ethUsdcAllowance },
      coti: { coti: { native: true, raw: null, value: Number.POSITIVE_INFINITY }, gcoti: carbonGcotiAllowance, usdc: carbonUsdcAllowance },
    },
    balances,
    carbon,
    owner,
  };
}

async function fetchUsdPrice(url: string, id: string): Promise<PriceLookup> {
  try {
    const payload = await fetchJson<unknown>(cacheBustUrl(url), { cache: "no-store" });
    const value = parseCoinGeckoUsdPrice(payload, id);
    if (!value) throw new Error(`Invalid ${id}/USD price payload.`);
    return { source: "fresh", value };
  } catch (error) {
    return { error: errorMessage(error), source: "unavailable", value: null };
  }
}

async function prices(): Promise<QuoteResult["prices"]> {
  const [coti, eth] = await Promise.all([
    fetchUsdPrice(APP_CONFIG.cotiUsdPriceApi, "coti"),
    fetchUsdPrice(APP_CONFIG.ethUsdPriceApi, "ethereum"),
  ]);
  return {
    cotiUsd: coti.value,
    cotiUsdError: coti.error,
    cotiUsdSource: coti.source,
    ethUsd: eth.value,
    ethUsdError: eth.error,
    ethUsdSource: eth.source,
  };
}

async function feeRates(cotiUsd: number | null, ethUsd: number | null): Promise<FeeRates> {
  const [ethFee, cotiFee] = await Promise.all([
    ethProvider.getFeeData().catch(() => null),
    cotiProvider.getFeeData().catch(() => null),
  ]);
  const ethWei = ethFee?.maxFeePerGas || ethFee?.gasPrice || 0n;
  const cotiWei = cotiFee?.maxFeePerGas || cotiFee?.gasPrice || 0n;
  return {
    ethUsdPerGas: ethUsd ? Number(formatEther(ethWei)) * ethUsd : 0,
    cotiUsdPerGas: cotiUsd ? Number(formatEther(cotiWei)) * cotiUsd : 0,
  };
}

async function uniswapPath(pairId: PairId, direction: Direction): Promise<string[]> {
  const cacheKey = `${pairId}:${direction}`;
  const cached = uniswapPathCache.get(cacheKey);
  if (cached) return cached;
  const pathPromise = (async () => {
  if (pairId === "coti-gcoti") {
    return direction === "buy_on_uniswap_sell_on_carbon"
      ? [APP_CONFIG.uniswap.coti, APP_CONFIG.uniswap.gcoti]
      : [APP_CONFIG.uniswap.gcoti, APP_CONFIG.uniswap.coti];
  }
  const source = direction === "buy_on_uniswap_sell_on_carbon" ? APP_CONFIG.uniswap.usdc : APP_CONFIG.uniswap.coti;
  const target = direction === "buy_on_uniswap_sell_on_carbon" ? APP_CONFIG.uniswap.coti : APP_CONFIG.uniswap.usdc;
  const factory = new Contract(APP_CONFIG.uniswap.factory, UNISWAP_FACTORY_ABI, ethProvider);
  const direct = await factory.getPair(APP_CONFIG.uniswap.coti, APP_CONFIG.uniswap.usdc) as string;
  if (!sameAddress(direct, ZERO_ADDRESS)) return [source, target];
  return direction === "buy_on_uniswap_sell_on_carbon"
    ? [APP_CONFIG.uniswap.usdc, APP_CONFIG.uniswap.weth, APP_CONFIG.uniswap.coti]
    : [APP_CONFIG.uniswap.coti, APP_CONFIG.uniswap.weth, APP_CONFIG.uniswap.usdc];
  })();
  uniswapPathCache.set(cacheKey, pathPromise);
  return pathPromise;
}

async function uniswapOut(amount: number, sourceDecimals: number, path: string[]): Promise<number> {
  if (amount <= 0) return 0;
  const router = new Contract(APP_CONFIG.uniswap.router, UNISWAP_ROUTER_ABI, ethProvider);
  const amounts = await router.getAmountsOut(parseTokenAmount(amount, sourceDecimals), path) as bigint[];
  const outputToken = path[path.length - 1];
  const output = sameAddress(outputToken, APP_CONFIG.uniswap.coti)
    ? { decimals: 18 }
    : sameAddress(outputToken, APP_CONFIG.uniswap.gcoti)
      ? { decimals: 18 }
      : { decimals: 6 };
  return Number(formatUnits(amounts[amounts.length - 1], output.decimals));
}

async function carbonOut(carbon: CarbonContext, sourceToken: string, targetToken: string, amount: number): Promise<number> {
  if (amount <= 0) return 0;
  const quote = await carbon.sdk.getTradeData(sourceToken, targetToken, cleanAmount(amount), false);
  return Number(quote.totalTargetAmount || 0);
}

function sourceInfo(state: WalletState, pairId: PairId, direction: Direction) {
  if (pairId === "coti-gcoti") {
    return direction === "buy_on_uniswap_sell_on_carbon"
      ? { source: state.balances.ethereum.tokens.coti, opposite: state.balances.coti.tokens.gcoti }
      : { source: state.balances.coti.tokens.coti, opposite: state.balances.ethereum.tokens.gcoti };
  }
  return direction === "buy_on_uniswap_sell_on_carbon"
    ? { source: state.balances.ethereum.tokens.usdc, opposite: state.balances.coti.tokens.coti }
    : { source: state.balances.coti.tokens.usdc, opposite: state.balances.ethereum.tokens.coti };
}

function rebalanceCandidate(state: { balances: WalletBalances }, tokenId: RebalanceTokenId): RebalanceSuggestion {
  const tokenSymbol = tokenId === "coti" ? "COTI" : "gCOTI";
  const ethBalance = state.balances.ethereum.tokens[tokenId].value;
  const cotiBalance = state.balances.coti.tokens[tokenId].value;
  const total = ethBalance + cotiBalance;
  if (total <= 0) {
    return {
      amount: 0,
      direction: null,
      executable: false,
      reason: `No ${tokenSymbol} balance found.`,
      sourceBalance: 0,
      targetBalance: 0,
      token: tokenId,
      tokenSymbol,
    };
  }

  const difference = ethBalance - cotiBalance;
  const needed = Math.abs(difference) / 2;
  const minimum = APP_CONFIG.rebalanceMinAmounts[tokenId];
  if (needed < minimum) {
    return {
      amount: 0,
      direction: null,
      executable: false,
      sourceBalance: difference > 0 ? ethBalance : cotiBalance,
      targetBalance: difference > 0 ? cotiBalance : ethBalance,
      token: tokenId,
      tokenSymbol,
    };
  }

  const sourceChain = difference > 0 ? "ethereum" : "coti";
  const targetChain = difference > 0 ? "coti" : "ethereum";
  const sourceBalance = sourceChain === "ethereum" ? ethBalance : cotiBalance;
  const targetBalance = sourceChain === "ethereum" ? cotiBalance : ethBalance;
  const amount = Math.min(needed, sourceBalance);
  return {
    amount,
    direction: sourceChain === "ethereum" ? "ethereum-to-coti" : "coti-to-ethereum",
    executable: amount > 0,
    recipient: sourceChain === "ethereum" ? APP_CONFIG.bridge.ethereumRecipient : APP_CONFIG.bridge.cotiRecipient,
    sourceBalance,
    sourceChain,
    targetBalance,
    targetChain,
    token: tokenId,
    tokenSymbol,
  };
}

export function buildRebalanceSummary(state: { balances: WalletBalances }): RebalanceSummary {
  const candidates = (["coti", "gcoti"] as RebalanceTokenId[]).map((tokenId) => rebalanceCandidate(state, tokenId));
  const executable = candidates.filter((candidate) => candidate.executable);
  if (!executable.length) {
    return {
      executable: false,
      reason: candidates.map((candidate) => candidate.reason).filter(Boolean).join(" "),
      suggestions: candidates,
    };
  }
  return {
    executable: true,
    suggestions: candidates,
  };
}

export function selectRebalanceSuggestions(rebalance: RebalanceSummary, tokens: RebalanceTokenId[] = ["coti", "gcoti"]): {
  executable: RebalanceSuggestion[];
  reason: string;
  selected: RebalanceSuggestion[];
} {
  const selectedTokens = new Set(tokens);
  const selected = rebalance.suggestions.filter((suggestion) => suggestion.token && selectedTokens.has(suggestion.token));
  const executable = selected.filter((suggestion) => suggestion.executable);
  const reason = selected.map((suggestion) => suggestion.reason).filter(Boolean).join(" ");
  return { executable, reason, selected };
}

export function candidateAmounts(max: number, pairId: PairId, steps = 24): number[] {
  const probes = pairId === "coti-usdc" ? APP_CONFIG.probeUsdcAmounts : APP_CONFIG.probeCotiAmounts;
  const candidateSet = new Set<number>([max, ...probes]);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    candidateSet.add(max * t);
    candidateSet.add(max * (t ** 2));
    candidateSet.add(max * (t ** 4));
  }
  return Array.from(candidateSet)
    .map((value) => Number(value.toFixed(6)))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
}

function refinementAmounts(best: number, max: number): number[] {
  if (best <= 0 || max <= 0) return [];
  const lower = Math.max(best * 0.65, max * 0.001);
  const upper = Math.min(best * 1.35, max);
  const candidateSet = new Set<number>([best, lower, upper]);
  for (let i = 1; i <= 12; i += 1) {
    const t = i / 12;
    candidateSet.add(lower + ((upper - lower) * t));
  }
  return Array.from(candidateSet)
    .map((value) => Number(value.toFixed(6)))
    .filter((value) => value > 0 && value <= max)
    .sort((a, b) => a - b);
}

function uniswapTokenDecimals(address: string): number {
  return sameAddress(address, APP_CONFIG.uniswap.usdc) ? 6 : 18;
}

async function uniswapPairReserves(tokenA: string, tokenB: string): Promise<Record<string, number> | null> {
  const factory = new Contract(APP_CONFIG.uniswap.factory, UNISWAP_FACTORY_ABI, ethProvider);
  const pairAddress = await factory.getPair(tokenA, tokenB) as string;
  if (sameAddress(pairAddress, ZERO_ADDRESS)) return null;
  const pair = new Contract(pairAddress, UNISWAP_PAIR_ABI, ethProvider);
  const [token0, token1, reserves] = await Promise.all([
    pair.token0() as Promise<string>,
    pair.token1() as Promise<string>,
    pair.getReserves() as Promise<[bigint, bigint, number]>,
  ]);
  return {
    [token0.toLowerCase()]: Number(formatUnits(reserves[0], uniswapTokenDecimals(token0))),
    [token1.toLowerCase()]: Number(formatUnits(reserves[1], uniswapTokenDecimals(token1))),
  };
}

async function cotiUsdcQuoteSearchMax(): Promise<number | null> {
  const path = await uniswapPath("coti-usdc", "buy_on_uniswap_sell_on_carbon");
  const reserves = await uniswapPairReserves(path[0], path[1]);
  const usdcReserve = Number(reserves?.[APP_CONFIG.uniswap.usdc.toLowerCase()]);
  return Number.isFinite(usdcReserve) && usdcReserve > 0 ? usdcReserve * 0.3 : null;
}

function balanceBlocker(label: string, required: number, available: number): string | null {
  if (required <= available) return null;
  return `Insufficient ${label}: need ${required.toFixed(4)}, available ${available.toFixed(4)}.`;
}

export function opportunityBlocker(blockers: Array<string | null>, netProfitAfterFeesUsd: number): string | undefined {
  const balanceIssue = blockers.find((item): item is string => !!item);
  if (balanceIssue) return balanceIssue;
  return netProfitAfterFeesUsd > 0 ? undefined : "Net after estimated fees is not positive.";
}

function needsApproval(allowanceState: AllowanceState, amount: number, decimals: number): boolean {
  if (allowanceState.native) return false;
  try {
    return BigInt(allowanceState.raw || 0) < parseTokenAmount(amount, decimals);
  } catch {
    return true;
  }
}

function estimatedNetworkFeesUsd(args: {
  carbonAllowance?: AllowanceState;
  carbonDecimals?: number;
  carbonSourceAmount: number;
  ethAllowance: AllowanceState;
  ethDecimals: number;
  ethSourceAmount: number;
  fees: FeeRates;
}): number {
  const ethUnits = GAS_UNITS.uniswapSwap + (needsApproval(args.ethAllowance, args.ethSourceAmount, args.ethDecimals) ? GAS_UNITS.erc20Approval : 0);
  const carbonUnits = GAS_UNITS.carbonSwap + (
    args.carbonAllowance && args.carbonDecimals !== undefined && needsApproval(args.carbonAllowance, args.carbonSourceAmount, args.carbonDecimals)
      ? GAS_UNITS.erc20Approval
      : 0
  );
  return (ethUnits * args.fees.ethUsdPerGas) + (carbonUnits * args.fees.cotiUsdPerGas);
}

async function evaluateCandidate(state: WalletState, pairId: PairId, direction: Direction, amount: number, cotiUsd: number | null, fees: FeeRates): Promise<Opportunity | null> {
  const route = direction === "buy_on_uniswap_sell_on_carbon" ? "Uniswap -> Carbon" : "Carbon -> Uniswap";
  const path = await uniswapPath(pairId, direction);

  if (pairId === "coti-gcoti") {
    if (direction === "buy_on_uniswap_sell_on_carbon") {
      const gcoti = await uniswapOut(amount, state.balances.ethereum.tokens.coti.decimals, path);
      const out = await carbonOut(state.carbon, state.carbon.gcotiAddress, state.carbon.cotiAddress, gcoti);
      const gross = out - amount;
      const grossUsd = gross * (cotiUsd || 0);
      const gasUsd = estimatedNetworkFeesUsd({
        carbonAllowance: state.allowances.coti.gcoti,
        carbonDecimals: state.balances.coti.tokens.gcoti.decimals,
        carbonSourceAmount: gcoti,
        ethAllowance: state.allowances.ethereum.coti,
        ethDecimals: state.balances.ethereum.tokens.coti.decimals,
        ethSourceAmount: amount,
        fees,
      });
      return makeOpportunity(pairId, direction, route, amount, "COTI", gcoti, "gCOTI", out, "COTI", gross, "COTI", grossUsd, gasUsd, [
        balanceBlocker("Ethereum COTI", amount, state.balances.ethereum.tokens.coti.value),
        balanceBlocker("COTI-chain gCOTI", gcoti, state.balances.coti.tokens.gcoti.value),
      ]);
    }
    const gcoti = await carbonOut(state.carbon, state.carbon.cotiAddress, state.carbon.gcotiAddress, amount);
    const out = await uniswapOut(gcoti, state.balances.ethereum.tokens.gcoti.decimals, path);
    const gross = out - amount;
    const grossUsd = gross * (cotiUsd || 0);
    const gasUsd = estimatedNetworkFeesUsd({
      carbonAllowance: state.allowances.coti.coti,
      carbonDecimals: state.balances.coti.tokens.coti.decimals,
      carbonSourceAmount: amount,
      ethAllowance: state.allowances.ethereum.gcoti,
      ethDecimals: state.balances.ethereum.tokens.gcoti.decimals,
      ethSourceAmount: gcoti,
      fees,
    });
    return makeOpportunity(pairId, direction, route, amount, "COTI", gcoti, "gCOTI", out, "COTI", gross, "COTI", grossUsd, gasUsd, [
      balanceBlocker("COTI-chain COTI", amount, state.balances.coti.tokens.coti.value),
      balanceBlocker("Ethereum gCOTI", gcoti, state.balances.ethereum.tokens.gcoti.value),
    ]);
  }

  if (direction === "buy_on_uniswap_sell_on_carbon") {
    const coti = await uniswapOut(amount, state.balances.ethereum.tokens.usdc.decimals, path);
    const out = await carbonOut(state.carbon, state.carbon.cotiAddress, state.carbon.usdcAddress, coti);
    const gross = out - amount;
    const gasUsd = estimatedNetworkFeesUsd({
      carbonAllowance: state.allowances.coti.coti,
      carbonDecimals: state.balances.coti.tokens.coti.decimals,
      carbonSourceAmount: coti,
      ethAllowance: state.allowances.ethereum.usdc,
      ethDecimals: state.balances.ethereum.tokens.usdc.decimals,
      ethSourceAmount: amount,
      fees,
    });
    return makeOpportunity(pairId, direction, route, amount, "USDC", coti, "COTI", out, "USDCe", gross, "USDC", gross, gasUsd, [
      balanceBlocker("Ethereum USDC", amount, state.balances.ethereum.tokens.usdc.value),
      balanceBlocker("COTI-chain COTI", coti, state.balances.coti.tokens.coti.value),
    ]);
  }
  const coti = await carbonOut(state.carbon, state.carbon.usdcAddress, state.carbon.cotiAddress, amount);
  const out = await uniswapOut(coti, state.balances.ethereum.tokens.coti.decimals, path);
  const gross = out - amount;
  const gasUsd = estimatedNetworkFeesUsd({
    carbonAllowance: state.allowances.coti.usdc,
    carbonDecimals: state.balances.coti.tokens.usdc.decimals,
    carbonSourceAmount: amount,
    ethAllowance: state.allowances.ethereum.coti,
    ethDecimals: state.balances.ethereum.tokens.coti.decimals,
    ethSourceAmount: coti,
    fees,
  });
  return makeOpportunity(pairId, direction, route, amount, "USDCe", coti, "COTI", out, "USDC", gross, "USDC", gross, gasUsd, [
    balanceBlocker("COTI-chain USDCe", amount, state.balances.coti.tokens.usdc.value),
    balanceBlocker("Ethereum COTI", coti, state.balances.ethereum.tokens.coti.value),
  ]);
}

function makeOpportunity(
  pairId: PairId,
  direction: Direction,
  route: Opportunity["route"],
  inputAmount: number,
  inputSymbol: string,
  bridgeOutputAmount: number,
  bridgeOutputSymbol: string,
  outputAmount: number,
  outputSymbol: string,
  profitTokenAmount: number,
  profitTokenSymbol: string,
  grossProfitUsd: number,
  gasUsd: number,
  balanceBlockers: Array<string | null> = [],
): Opportunity {
  // Keep this aligned with the ServerDashBoard !arb quote: the main opportunity
  // number is market profit before wallet gas. Gas is shown separately in details.
  const netProfitUsd = grossProfitUsd;
  const netProfitAfterFeesUsd = grossProfitUsd - gasUsd;
  const reason = opportunityBlocker(balanceBlockers, netProfitAfterFeesUsd);
  const warnings = [
    "Uniswap executes first. If Carbon fails, the first transaction remains final.",
  ];
  if (netProfitAfterFeesUsd <= 0) warnings.unshift("Net after estimated fees is not positive.");
  for (const blocker of balanceBlockers.filter((item): item is string => !!item)) warnings.unshift(blocker);
  return {
    action: direction === "buy_on_uniswap_sell_on_carbon" ? `Buy ${bridgeOutputSymbol} on Uniswap, sell on Carbon` : `Buy ${bridgeOutputSymbol} on Carbon, sell on Uniswap`,
    direction,
    executable: !reason && inputAmount > 0 && outputAmount > 0,
    estimatedFeesUsd: gasUsd,
    netProfitUsd,
    netProfitAfterFeesUsd,
    pairId,
    pairLabel: pairId === "coti-gcoti" ? "COTI/gCOTI" : "COTI/USDC",
    reason,
    route,
    summary: { inputAmount, inputSymbol, bridgeOutputAmount, bridgeOutputSymbol, outputAmount, outputSymbol, grossProfitUsd, gasUsd, profitTokenAmount, profitTokenSymbol },
    warnings,
  };
}

async function bestOpportunity(state: WalletState, pairId: PairId, direction: Direction, cotiUsd: number | null, fees: FeeRates, quoteSearchMax?: number | null): Promise<Opportunity | null> {
  const { source } = sourceInfo(state, pairId, direction);
  const max = Math.max(source.value, quoteSearchMax || 0);
  let best: Opportunity | null = null;
  let lastError: unknown = null;
  let bestInputAmount: number | null = null;
  const evaluateAmounts = async (amounts: number[]): Promise<void> => {
    for (const amount of amounts) {
    const candidate = await evaluateCandidate(state, pairId, direction, amount, cotiUsd, fees).catch((error) => {
      lastError = error;
      return null;
    });
    if (!candidate) continue;
    if (!best) {
      best = candidate;
      bestInputAmount = candidate.summary.inputAmount;
      continue;
    }
    if (candidate.executable !== best.executable) {
      if (candidate.executable) {
        best = candidate;
        bestInputAmount = candidate.summary.inputAmount;
      }
      continue;
    }
    if (candidate.netProfitUsd > best.netProfitUsd) {
      best = candidate;
      bestInputAmount = candidate.summary.inputAmount;
    }
  }
  };
  await evaluateAmounts(candidateAmounts(max, pairId, pairId === "coti-usdc" ? 80 : 24));
  if (bestInputAmount !== null) await evaluateAmounts(refinementAmounts(bestInputAmount, max));
  if (!best && lastError) {
    console.warn(`Quote failed for ${pairId} ${direction}:`, lastError);
  }
  return best;
}

async function buildQuoteFromState(state: WalletState): Promise<QuoteResult> {
  const price = await prices();
  const fees = await feeRates(price.cotiUsd, price.ethUsd);
  const cotiUsdcSearchMax = await cotiUsdcQuoteSearchMax().catch((error) => {
    console.warn("COTI/USDC quote search bound failed:", error);
    return null;
  });
  const settled = await Promise.all([
    bestOpportunity(state, "coti-gcoti", "buy_on_uniswap_sell_on_carbon", price.cotiUsd, fees),
    bestOpportunity(state, "coti-gcoti", "buy_on_carbon_sell_on_uniswap", price.cotiUsd, fees),
    bestOpportunity(state, "coti-usdc", "buy_on_uniswap_sell_on_carbon", price.cotiUsd, fees, cotiUsdcSearchMax),
    bestOpportunity(state, "coti-usdc", "buy_on_carbon_sell_on_uniswap", price.cotiUsd, fees, cotiUsdcSearchMax),
  ]);
  const byPair: Opportunity[] = (["coti-gcoti", "coti-usdc"] as PairId[]).map((pairId) => {
    const pairBest = settled.filter((item): item is Opportunity => !!item && item.pairId === pairId).sort((a, b) => {
      if (a.executable !== b.executable) return a.executable ? -1 : 1;
      return b.netProfitUsd - a.netProfitUsd;
    })[0];
    return pairBest || {
      action: "No quote",
      direction: "buy_on_uniswap_sell_on_carbon",
      estimatedFeesUsd: 0,
      executable: false,
      netProfitUsd: 0,
      netProfitAfterFeesUsd: 0,
      pairId,
      pairLabel: pairId === "coti-gcoti" ? "COTI/gCOTI" : "COTI/USDC",
      reason: "No executable route found for current balances.",
      route: "Uniswap -> Carbon",
      summary: { inputAmount: 0, inputSymbol: "-", bridgeOutputAmount: 0, bridgeOutputSymbol: "-", outputAmount: 0, outputSymbol: "-", grossProfitUsd: 0, gasUsd: 0, profitTokenAmount: 0, profitTokenSymbol: "-" },
      warnings: ["No executable route found for current balances."],
    };
  });
  return {
    generatedAtUtc: new Date().toISOString(),
    wallet: state.owner,
    balances: state.balances,
    allowances: state.allowances,
    opportunities: byPair,
    prices: price,
    rebalance: buildRebalanceSummary(state),
  };
}

export async function buildQuote(walletAddress: string): Promise<QuoteResult> {
  return buildQuoteFromState(await loadWalletState(walletAddress));
}

function rebalanceTokenAddress(state: WalletState, suggestion: RebalanceSuggestion): string {
  if (!suggestion.token || !suggestion.sourceChain) throw new Error("No rebalance token selected.");
  if (suggestion.sourceChain === "ethereum") return APP_CONFIG.uniswap[suggestion.token];
  return suggestion.token === "coti" ? NATIVE_COTI : state.carbon.gcotiAddress;
}

export function bridgeRouteMetadata(suggestion: RebalanceSuggestion, carbonGcotiAddress: string): BridgeStepMetadata {
  if (!suggestion.executable || !suggestion.token || !suggestion.sourceChain || !suggestion.targetChain || !suggestion.tokenSymbol) {
    throw new Error(suggestion.reason || "No bridge route is available.");
  }
  const sourceNetworkId = suggestion.sourceChain === "ethereum" ? String(APP_CONFIG.ethereum.chainId) : String(APP_CONFIG.coti.chainId);
  const destinationNetworkId = suggestion.targetChain === "ethereum" ? String(APP_CONFIG.ethereum.chainId) : String(APP_CONFIG.coti.chainId);
  const tokenAddress = suggestion.sourceChain === "ethereum"
    ? APP_CONFIG.uniswap[suggestion.token]
    : suggestion.token === "coti"
      ? ZERO_ADDRESS
      : carbonGcotiAddress;
  return {
    amount: suggestion.amount,
    destinationNetworkId,
    sourceChain: suggestion.sourceChain,
    sourceNetworkId,
    targetChain: suggestion.targetChain,
    token: suggestion.token,
    tokenAddress,
    tokenSymbol: suggestion.tokenSymbol,
  };
}

function rebalanceSourceBalance(state: WalletState, suggestion: RebalanceSuggestion): TokenBalance {
  if (!suggestion.token || !suggestion.sourceChain) throw new Error("No rebalance token selected.");
  return state.balances[suggestion.sourceChain].tokens[suggestion.token];
}

async function buildRebalanceStep(state: WalletState, suggestion: RebalanceSuggestion): Promise<PreparedStep> {
  if (!suggestion.executable || !suggestion.token || !suggestion.sourceChain || !suggestion.targetChain || !suggestion.recipient) {
    throw new Error(suggestion.reason || "No rebalance action is available.");
  }
  const sourceBalance = rebalanceSourceBalance(state, suggestion);
  const tokenAddress = rebalanceTokenAddress(state, suggestion);
  const amountRaw = parseTokenAmount(suggestion.amount, sourceBalance.decimals);
  const provider = suggestion.sourceChain === "ethereum" ? ethProvider : cotiProvider;
  const isNative = isNativeToken(tokenAddress);
  const data = isNative ? "0x" : erc20Interface.encodeFunctionData("transfer", [suggestion.recipient, amountRaw]);
  const to = isNative ? suggestion.recipient : tokenAddress;
  const value = isNative ? amountRaw : 0n;
  const gasFallback = isNative ? GAS_UNITS.bridgeNative : GAS_UNITS.bridgeToken;
  const gas = await provider.estimateGas({ from: state.owner, to, data, value })
    .then((estimate) => gasWithBuffer(estimate, APP_CONFIG.gasLimitBufferBps))
    .catch(() => BigInt(gasFallback));
  return {
    bridge: bridgeRouteMetadata(suggestion, state.carbon.gcotiAddress),
    chain: suggestion.sourceChain,
    description: `Bridge ${cleanAmount(suggestion.amount, 6)} ${suggestion.tokenSymbol} from ${suggestion.sourceChain} to ${suggestion.targetChain}.`,
    index: 1,
    label: `Rebalance ${suggestion.tokenSymbol}`,
    token: suggestion.tokenSymbol || "",
    trade: {
      action: "bridge",
      protocol: "Bridge",
      reviewSourceBalanceRaw: sourceBalance.raw,
      source: tokenAmountMetadata(tokenAddress, sourceBalance.symbol, sourceBalance.decimals, amountRaw),
    },
    tx: { from: state.owner, to, data, value: hexValue(value), gas: hexValue(gas) },
    type: "bridge-transfer",
  };
}

export async function prepareRebalancePlan(walletAddress: string, options: RebalancePlanOptions = {}): Promise<PreparedRebalancePlan> {
  const state = await loadWalletState(walletAddress);
  const rebalance = buildRebalanceSummary(state);
  const selected = selectRebalanceSuggestions(rebalance, options.tokens?.length ? options.tokens : undefined);
  const suggestions = selected.executable;
  if (!suggestions.length) {
    throw new Error(selected.reason || rebalance.reason || "No rebalance action is available for the selected token.");
  }
  const steps = await Promise.all(suggestions.map((suggestion) => buildRebalanceStep(state, suggestion)));
  const indexedSteps = steps.map((step, index) => ({ ...step, index: index + 1 }));
  assertAllowedRebalancePlan(indexedSteps, state.carbon.gcotiAddress);
  return {
    generatedAtUtc: new Date().toISOString(),
    kind: "rebalance",
    steps: indexedSteps,
    suggestions,
    wallet: state.owner,
    warning: "Bridge transfers prepared. Wait for completion before rebalancing again.",
  };
}

async function approvalStep(args: {
  allowance: AllowanceState;
  amountRaw: bigint;
  chain: "ethereum" | "coti";
  from: string;
  label: string;
  provider: JsonRpcProvider;
  spender: string;
  sourceBalanceRaw: string;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
}): Promise<PreparedStep | null> {
  if (isNativeToken(args.tokenAddress)) return null;
  if (BigInt(args.allowance.raw || 0) >= args.amountRaw) return null;
  const data = erc20Interface.encodeFunctionData("approve", [args.spender, args.amountRaw]);
  const gas = await args.provider.estimateGas({ from: args.from, to: args.tokenAddress, data, value: 0 }).then((estimate) => gasWithBuffer(estimate, APP_CONFIG.gasLimitBufferBps)).catch(() => null);
  return {
    chain: args.chain,
    description: `Allow ${args.label} to spend ${args.tokenSymbol}.`,
    index: 0,
    label: `Approve ${args.tokenSymbol}`,
    token: args.tokenSymbol,
    trade: {
      action: "approve",
      protocol: args.label === "Uniswap" ? "Uniswap" : "Carbon",
      reviewAllowanceRaw: args.allowance.raw,
      reviewSourceBalanceRaw: args.sourceBalanceRaw,
      source: tokenAmountMetadata(args.tokenAddress, args.tokenSymbol, args.tokenDecimals, args.amountRaw),
      spender: args.spender,
    },
    tx: { from: args.from, to: args.tokenAddress, data, value: "0x0", ...(gas ? { gas: hexValue(gas) } : {}) },
    type: "approval",
  };
}

export function arbLegAmounts(opportunity: Pick<Opportunity, "direction" | "summary">): { carbonSourceAmount: number; uniswapSourceAmount: number } {
  return opportunity.direction === "buy_on_uniswap_sell_on_carbon"
    ? {
      carbonSourceAmount: opportunity.summary.bridgeOutputAmount,
      uniswapSourceAmount: opportunity.summary.inputAmount,
    }
    : {
      carbonSourceAmount: opportunity.summary.inputAmount,
      uniswapSourceAmount: opportunity.summary.bridgeOutputAmount,
    };
}

function ethSourceKey(sourceToken: string): "coti" | "gcoti" | "usdc" {
  if (sameAddress(sourceToken, APP_CONFIG.uniswap.coti)) return "coti";
  if (sameAddress(sourceToken, APP_CONFIG.uniswap.gcoti)) return "gcoti";
  return "usdc";
}

function cotiTokenKey(state: WalletState, tokenAddress: string): "coti" | "gcoti" | "usdc" {
  if (sameAddress(tokenAddress, state.carbon.gcotiAddress)) return "gcoti";
  if (sameAddress(tokenAddress, state.carbon.usdcAddress)) return "usdc";
  return "coti";
}

async function buildUniswapSteps(state: WalletState, opportunity: Opportunity): Promise<PreparedStep[]> {
  const path = await uniswapPath(opportunity.pairId, opportunity.direction);
  const sourceToken = path[0];
  const sourceKey = ethSourceKey(sourceToken);
  const sourceInfo = state.balances.ethereum.tokens[sourceKey];
  const amountIn = parseTokenAmount(arbLegAmounts(opportunity).uniswapSourceAmount, sourceInfo.decimals);
  const router = new Contract(APP_CONFIG.uniswap.router, UNISWAP_ROUTER_ABI, ethProvider);
  const amounts = await router.getAmountsOut(amountIn, path) as bigint[];
  const outputToken = path[path.length - 1];
  const outputInfo = state.balances.ethereum.tokens[ethSourceKey(outputToken)];
  const expectedOut = amounts[amounts.length - 1];
  const minOut = minOutRaw(expectedOut, APP_CONFIG.slippageBps);
  const deadline = Math.floor(Date.now() / 1000) + APP_CONFIG.deadlineSec;
  const data = routerInterface.encodeFunctionData("swapExactTokensForTokens", [
    amountIn,
    minOut,
    path,
    state.owner,
    String(deadline),
  ]);
  const approval = await approvalStep({
    allowance: state.allowances.ethereum[sourceKey],
    amountRaw: amountIn,
    chain: "ethereum",
    from: state.owner,
    label: "Uniswap",
    provider: ethProvider,
    spender: APP_CONFIG.uniswap.router,
    sourceBalanceRaw: sourceInfo.raw,
    tokenAddress: sourceToken,
    tokenDecimals: sourceInfo.decimals,
    tokenSymbol: sourceInfo.symbol,
  });
  const gas = await ethProvider.estimateGas({ from: state.owner, to: APP_CONFIG.uniswap.router, data, value: 0 }).then((estimate) => gasWithBuffer(estimate, APP_CONFIG.gasLimitBufferBps)).catch(() => {
    if (!approval) throw new Error("Uniswap swap would revert now. Refresh quote.");
    return null;
  });
  const trade: TradeStepMetadata = {
    action: "swap",
    minTarget: tokenAmountMetadata(outputToken, outputInfo.symbol, outputInfo.decimals, minOut),
    protocol: "Uniswap",
    reviewAllowanceRaw: state.allowances.ethereum[sourceKey].raw,
    reviewSourceBalanceRaw: sourceInfo.raw,
    source: tokenAmountMetadata(sourceToken, sourceInfo.symbol, sourceInfo.decimals, amountIn),
    target: tokenAmountMetadata(outputToken, outputInfo.symbol, outputInfo.decimals, expectedOut),
  };
  return [approval, {
    chain: "ethereum",
    description: `${opportunity.action}. Minimum output includes ${APP_CONFIG.slippageBps / 100}% slippage.`,
    index: 0,
    label: "Uniswap swap",
    token: sourceInfo.symbol,
    trade,
    tx: { from: state.owner, to: APP_CONFIG.uniswap.router, data, value: "0x0", ...(gas ? { gas: hexValue(gas) } : {}) },
    type: "uniswap-swap" as const,
  }].filter(Boolean) as PreparedStep[];
}

function carbonLeg(state: WalletState, opportunity: Opportunity) {
  const carbon = state.carbon;
  const amount = arbLegAmounts(opportunity).carbonSourceAmount;
  if (opportunity.pairId === "coti-usdc") {
    return opportunity.direction === "buy_on_uniswap_sell_on_carbon"
      ? { amount, key: "coti" as const, source: carbon.cotiAddress, target: carbon.usdcAddress, symbol: "COTI" }
      : { amount, key: "usdc" as const, source: carbon.usdcAddress, target: carbon.cotiAddress, symbol: "USDCe" };
  }
  return opportunity.direction === "buy_on_uniswap_sell_on_carbon"
    ? { amount, key: "gcoti" as const, source: carbon.gcotiAddress, target: carbon.cotiAddress, symbol: "gCOTI" }
    : { amount, key: "coti" as const, source: carbon.cotiAddress, target: carbon.gcotiAddress, symbol: "COTI" };
}

async function buildCarbonSteps(state: WalletState, opportunity: Opportunity): Promise<PreparedStep[]> {
  const leg = carbonLeg(state, opportunity);
  const sourceInfo = state.balances.coti.tokens[leg.key];
  const targetKey = cotiTokenKey(state, leg.target);
  const targetInfo = state.balances.coti.tokens[targetKey];
  const amountRaw = parseTokenAmount(leg.amount, sourceInfo.decimals);
  const quote = await state.carbon.sdk.getTradeData(leg.source, leg.target, cleanAmount(leg.amount), false);
  if (!quote.tradeActions?.length || Number(quote.totalTargetAmount) <= 0) throw new Error("Carbon quote returned no trade actions.");
  const minReturn = cleanAmount(Number(quote.totalTargetAmount) * (1 - APP_CONFIG.slippageBps / 10000));
  const targetRaw = decimalStringToRaw(quote.totalTargetAmount, targetInfo.decimals);
  const minReturnRaw = decimalStringToRaw(minReturn, targetInfo.decimals);
  const deadline = Math.floor(Date.now() / 1000) + APP_CONFIG.deadlineSec;
  const txRequest = await state.carbon.sdk.composeTradeBySourceTransaction(leg.source, leg.target, quote.tradeActions, deadline, minReturn);
  const nativeValue = isNativeToken(leg.source) ? amountRaw : BigInt(txRequest.value || 0);
  const approval = await approvalStep({
    allowance: state.allowances.coti[leg.key],
    amountRaw,
    chain: "coti",
    from: state.owner,
    label: "Carbon",
    provider: cotiProvider,
    spender: APP_CONFIG.carbonController,
    sourceBalanceRaw: sourceInfo.raw,
    tokenAddress: leg.source,
    tokenDecimals: sourceInfo.decimals,
    tokenSymbol: leg.symbol,
  });
  const data = txRequest.data || "0x";
  const to = getAddress(String(txRequest.to || APP_CONFIG.carbonController));
  const gas = await cotiProvider.estimateGas({ from: state.owner, to, data, value: nativeValue }).then((estimate) => gasWithBuffer(estimate, APP_CONFIG.gasLimitBufferBps)).catch(() => {
    if (!approval) throw new Error("Carbon swap would revert now. Refresh quote.");
    return null;
  });
  const trade: TradeStepMetadata = {
    action: "swap",
    minTarget: tokenAmountMetadata(leg.target, targetInfo.symbol, targetInfo.decimals, minReturnRaw),
    protocol: "Carbon",
    reviewAllowanceRaw: state.allowances.coti[leg.key].raw,
    reviewSourceBalanceRaw: sourceInfo.raw,
    source: tokenAmountMetadata(leg.source, sourceInfo.symbol, sourceInfo.decimals, amountRaw),
    target: tokenAmountMetadata(leg.target, targetInfo.symbol, targetInfo.decimals, targetRaw),
  };
  return [approval, {
    chain: "coti",
    description: `${opportunity.action}. Minimum return includes ${APP_CONFIG.slippageBps / 100}% slippage.`,
    index: 0,
    label: "Carbon swap",
    token: leg.symbol,
    trade,
    tx: { from: state.owner, to, data, value: hexValue(nativeValue), ...(gas ? { gas: hexValue(gas) } : {}) },
    type: "carbon-swap" as const,
  }].filter(Boolean) as PreparedStep[];
}

function assertPreparedPlanAmounts(state: WalletState, opportunity: Opportunity, steps: PreparedStep[]): void {
  const uniswapStep = steps.find((step) => step.type === "uniswap-swap");
  if (!uniswapStep) throw new Error("Prepared plan is missing the Uniswap swap.");
  const decoded = routerInterface.decodeFunctionData("swapExactTokensForTokens", uniswapStep.tx.data);
  const amountIn = decoded[0] as bigint;
  const path = decoded[2] as string[];
  const sourceKey = ethSourceKey(path[0]);
  const expectedAmount = parseTokenAmount(arbLegAmounts(opportunity).uniswapSourceAmount, state.balances.ethereum.tokens[sourceKey].decimals);
  if (amountIn !== expectedAmount) {
    throw new Error("Prepared Uniswap amount does not match the selected opportunity.");
  }
}

export async function preparePlan(walletAddress: string, pairId: PairId): Promise<PreparedPlan> {
  const state = await loadWalletState(walletAddress);
  const quote = await buildQuoteFromState(state);
  const opportunity = quote.opportunities.find((item) => item.pairId === pairId);
  if (!opportunity) throw new Error(`Unknown pair ${pairId}.`);
  if (!opportunity.executable) throw new Error(opportunity.reason || `${opportunity.pairLabel} is not executable.`);
  const [uniswap, carbon] = await Promise.all([
    buildUniswapSteps(state, opportunity),
    buildCarbonSteps(state, opportunity),
  ]);
  const steps = [...uniswap, ...carbon].map((step, index) => ({ ...step, index: index + 1 }));
  assertAllowedPlan(steps, [state.carbon.cotiAddress, state.carbon.gcotiAddress, state.carbon.usdcAddress]);
  assertPreparedPlanAmounts(state, opportunity, steps);
  return {
    generatedAtUtc: new Date().toISOString(),
    kind: "arb",
    opportunity,
    pairId,
    steps,
    wallet: state.owner,
    warning: "Uniswap signs first. If the Carbon transaction fails or is rejected, the first transaction remains final.",
  };
}

export function assertNoBridge(plan: PreparedPlan): void {
  if (plan.steps.some((step) => !["approval", "uniswap-swap", "carbon-swap"].includes(step.type))) {
    throw new Error("Prepared plan includes an unsupported non-DEX step.");
  }
}
