import { Contract, JsonRpcProvider } from "ethers";
import { ERC20_ABI } from "./abis";
import { APP_CONFIG } from "./config";
import { exactTokenDisplay } from "./tradeMetadata";
import type { ChainKey, PreparedStep } from "./types";
import { isNativeToken } from "./utils";

const ethProvider = new JsonRpcProvider(APP_CONFIG.ethRpcUrl);
const cotiProvider = new JsonRpcProvider(APP_CONFIG.cotiRpcUrl);

export type PreSignCheckCode =
  | "approval-already-covered"
  | "allowance-changed"
  | "allowance-low"
  | "balance-changed"
  | "balance-low";

export interface PreSignCheckWarning {
  code: PreSignCheckCode;
  message: string;
  stepIndex: number;
  stepLabel: string;
}

export interface PreSignStateReader {
  allowanceOf(chain: ChainKey, tokenAddress: string, owner: string, spender: string): Promise<bigint | null>;
  balanceOf(chain: ChainKey, tokenAddress: string, owner: string): Promise<bigint>;
}

export interface StepSimulator {
  call(chain: ChainKey, tx: PreparedStep["tx"]): Promise<unknown>;
}

function providerForChain(chain: ChainKey): JsonRpcProvider {
  return chain === "ethereum" ? ethProvider : cotiProvider;
}

export const defaultPreSignStateReader: PreSignStateReader = {
  async allowanceOf(chain, tokenAddress, owner, spender) {
    if (isNativeToken(tokenAddress)) return null;
    const contract = new Contract(tokenAddress, ERC20_ABI, providerForChain(chain));
    return contract.allowance(owner, spender) as Promise<bigint>;
  },
  async balanceOf(chain, tokenAddress, owner) {
    if (isNativeToken(tokenAddress)) return providerForChain(chain).getBalance(owner);
    const contract = new Contract(tokenAddress, ERC20_ABI, providerForChain(chain));
    return contract.balanceOf(owner) as Promise<bigint>;
  },
};

export const defaultStepSimulator: StepSimulator = {
  async call(chain, tx) {
    return providerForChain(chain).call(tx);
  },
};

function spenderForStep(step: PreparedStep): string | null {
  if (step.trade?.spender) return step.trade.spender;
  if (step.type === "uniswap-swap") return APP_CONFIG.uniswap.router;
  if (step.type === "carbon-swap") return APP_CONFIG.carbonController;
  return null;
}

function amountText(raw: bigint, decimals: number, symbol: string): string {
  return `${exactTokenDisplay(raw, decimals)} ${symbol}`;
}

function reviewRaw(value: string | null | undefined): bigint | null {
  if (value === undefined || value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function warning(step: PreparedStep, code: PreSignCheckCode, message: string): PreSignCheckWarning {
  return {
    code,
    message,
    stepIndex: step.index,
    stepLabel: step.label,
  };
}

export async function assertPreparedStepStillExecutable(
  step: PreparedStep,
  simulator: StepSimulator = defaultStepSimulator,
): Promise<void> {
  if (step.type !== "uniswap-swap" && step.type !== "carbon-swap") return;
  try {
    await simulator.call(step.chain, step.tx);
  } catch {
    throw new Error(`${step.label} would revert now. Refresh quote before signing.`);
  }
}

export async function checkPreparedStepBeforeSigning(
  wallet: string,
  step: PreparedStep,
  reader: PreSignStateReader = defaultPreSignStateReader,
): Promise<PreSignCheckWarning[]> {
  const trade = step.trade;
  if (!trade) return [];

  const warnings: PreSignCheckWarning[] = [];
  const required = BigInt(trade.source.raw);
  const currentBalance = await reader.balanceOf(step.chain, trade.source.address, wallet);
  const reviewedBalance = reviewRaw(trade.reviewSourceBalanceRaw);

  if (reviewedBalance !== null && currentBalance !== reviewedBalance) {
    warnings.push(warning(
      step,
      "balance-changed",
      `${trade.source.symbol} balance changed since Review: ${amountText(reviewedBalance, trade.source.decimals, trade.source.symbol)} -> ${amountText(currentBalance, trade.source.decimals, trade.source.symbol)}.`,
    ));
  }

  if (currentBalance < required) {
    warnings.push(warning(
      step,
      "balance-low",
      `${trade.source.symbol} balance is below this step: need ${amountText(required, trade.source.decimals, trade.source.symbol)}, current ${amountText(currentBalance, trade.source.decimals, trade.source.symbol)}.`,
    ));
  }

  const spender = spenderForStep(step);
  if (!spender || isNativeToken(trade.source.address)) return warnings;

  const currentAllowance = await reader.allowanceOf(step.chain, trade.source.address, wallet, spender);
  if (currentAllowance === null) return warnings;

  const reviewedAllowance = reviewRaw(trade.reviewAllowanceRaw);
  if (reviewedAllowance !== null && currentAllowance !== reviewedAllowance) {
    warnings.push(warning(
      step,
      "allowance-changed",
      `${trade.source.symbol} allowance for ${trade.protocol} changed since Review: ${amountText(reviewedAllowance, trade.source.decimals, trade.source.symbol)} -> ${amountText(currentAllowance, trade.source.decimals, trade.source.symbol)}.`,
    ));
  }

  if (step.type === "approval" && currentAllowance >= required) {
    warnings.push(warning(
      step,
      "approval-already-covered",
      `${trade.source.symbol} allowance already covers this approval amount.`,
    ));
  }

  if (step.type !== "approval" && currentAllowance < required) {
    warnings.push(warning(
      step,
      "allowance-low",
      `${trade.source.symbol} allowance for ${trade.protocol} is below this step: need ${amountText(required, trade.source.decimals, trade.source.symbol)}, current ${amountText(currentAllowance, trade.source.decimals, trade.source.symbol)}.`,
    ));
  }

  return warnings;
}

export function preSignWarningText(warningItem: PreSignCheckWarning): string {
  return `Step ${warningItem.stepIndex} ${warningItem.stepLabel}: ${warningItem.message}`;
}
