export type PairId = "coti-gcoti" | "coti-usdc";
export type ChainKey = "ethereum" | "coti";
export type StepType = "approval" | "uniswap-swap" | "carbon-swap" | "bridge-transfer";
export type Direction = "buy_on_uniswap_sell_on_carbon" | "buy_on_carbon_sell_on_uniswap";
export type RebalanceTokenId = "coti" | "gcoti";

export interface TokenBalance {
  address: string;
  decimals: number;
  raw: string;
  symbol: string;
  value: number;
}

export interface AllowanceState {
  native?: boolean;
  raw: string | null;
  value: number;
}

export interface WalletBalances {
  ethereum: {
    native: TokenBalance;
    tokens: Record<"coti" | "gcoti" | "usdc", TokenBalance>;
  };
  coti: {
    native: TokenBalance;
    tokens: Record<"coti" | "gcoti" | "usdc", TokenBalance>;
  };
}

export interface WalletAllowances {
  ethereum: Record<"coti" | "gcoti" | "usdc", AllowanceState>;
  coti: Record<"coti" | "gcoti" | "usdc", AllowanceState>;
}

export interface CarbonContext {
  sdk: {
    getTradeData(sourceToken: string, targetToken: string, amount: string, byTarget?: boolean): Promise<{
      tradeActions?: unknown[];
      totalSourceAmount: string;
      totalTargetAmount: string;
    }>;
    composeTradeBySourceTransaction(
      sourceToken: string,
      targetToken: string,
      tradeActions: unknown[],
      deadline: number | string,
      minReturn: string
    ): Promise<{ to?: string; data?: string; value?: bigint | string | number }>;
  };
  cotiAddress: string;
  gcotiAddress: string;
  usdcAddress: string;
}

export interface WalletState {
  owner: string;
  balances: WalletBalances;
  allowances: WalletAllowances;
  carbon: CarbonContext;
}

export interface Opportunity {
  action: string;
  direction: Direction;
  executable: boolean;
  estimatedFeesUsd: number;
  netProfitUsd: number;
  netProfitAfterFeesUsd: number;
  pairId: PairId;
  pairLabel: string;
  reason?: string;
  route: "Uniswap -> Carbon" | "Carbon -> Uniswap";
  summary: {
    inputSymbol: string;
    inputAmount: number;
    bridgeOutputSymbol: string;
    bridgeOutputAmount: number;
    outputSymbol: string;
    outputAmount: number;
    grossProfitUsd: number;
    gasUsd: number;
    profitTokenAmount: number;
    profitTokenSymbol: string;
  };
  warnings: string[];
}

export interface QuoteResult {
  generatedAtUtc: string;
  wallet: string;
  balances: WalletBalances;
  allowances: WalletAllowances;
  opportunities: Opportunity[];
  prices: {
    cotiUsd: number | null;
    cotiUsdError?: string;
    cotiUsdSource: "fresh" | "unavailable";
    ethUsd: number | null;
    ethUsdError?: string;
    ethUsdSource: "fresh" | "unavailable";
  };
  rebalance: RebalanceSummary;
}

export interface WalletInventoryState {
  generatedAtUtc: string;
  wallet: string;
  balances: WalletBalances;
  rebalance: RebalanceSummary;
}

export interface BridgeStepMetadata {
  amount: number;
  destinationNetworkId: string;
  sourceChain: ChainKey;
  sourceNetworkId: string;
  targetChain: ChainKey;
  token: RebalanceTokenId;
  tokenAddress: string;
  tokenSymbol: "COTI" | "gCOTI";
}

export interface TokenAmountMetadata {
  address: string;
  decimals: number;
  display: string;
  raw: string;
  symbol: string;
}

export interface TradeStepMetadata {
  action: "approve" | "swap" | "bridge";
  minTarget?: TokenAmountMetadata;
  protocol: "Uniswap" | "Carbon" | "Bridge";
  reviewAllowanceRaw?: string | null;
  reviewSourceBalanceRaw?: string;
  source: TokenAmountMetadata;
  spender?: string;
  target?: TokenAmountMetadata;
}

export interface PreparedPlanWarning {
  code: "stale-quote" | "quote-drift";
  message: string;
}

export interface PreparedStep {
  bridge?: BridgeStepMetadata;
  chain: ChainKey;
  description: string;
  index: number;
  label: string;
  token: string;
  trade?: TradeStepMetadata;
  tx: { data: string; from: string; gas?: string; to: string; value: string };
  type: StepType;
}

export interface PreparedPlan {
  generatedAtUtc: string;
  kind: "arb";
  opportunity: Opportunity;
  pairId: PairId;
  reviewWarnings?: PreparedPlanWarning[];
  steps: PreparedStep[];
  wallet: string;
  warning: string;
}

export interface RebalanceSuggestion {
  amount: number;
  direction: "ethereum-to-coti" | "coti-to-ethereum" | null;
  executable: boolean;
  reason?: string;
  recipient?: string;
  sourceBalance: number;
  sourceChain?: ChainKey;
  targetBalance: number;
  targetChain?: ChainKey;
  token: RebalanceTokenId | null;
  tokenSymbol: "COTI" | "gCOTI" | null;
}

export interface RebalanceSummary {
  executable: boolean;
  reason?: string;
  suggestions: RebalanceSuggestion[];
}

export interface RebalancePlanOptions {
  tokens?: RebalanceTokenId[];
}

export interface PreparedRebalancePlan {
  generatedAtUtc: string;
  kind: "rebalance";
  steps: PreparedStep[];
  suggestions: RebalanceSuggestion[];
  wallet: string;
  warning: string;
}

export type PreparedWalletPlan = PreparedPlan | PreparedRebalancePlan;

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isBraveWallet?: boolean;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isTrust?: boolean;
}
