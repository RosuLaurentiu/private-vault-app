import { describe, expect, it } from "vitest";
import { APP_CONFIG, NATIVE_COTI } from "./config";
import { assertPreparedStepStillExecutable, checkPreparedStepBeforeSigning, preSignWarningText, type PreSignStateReader, type StepSimulator } from "./preSignCheck";
import { tokenAmountMetadata } from "./tradeMetadata";
import type { PreparedStep } from "./types";

function reader(balance: bigint, allowance: bigint | null = null): PreSignStateReader {
  return {
    allowanceOf: async () => allowance,
    balanceOf: async () => balance,
  };
}

function step(overrides: Partial<PreparedStep> = {}): PreparedStep {
  return {
    chain: "ethereum",
    description: "Swap",
    index: 2,
    label: "Uniswap swap",
    token: "COTI",
    trade: {
      action: "swap",
      protocol: "Uniswap",
      reviewAllowanceRaw: "500",
      reviewSourceBalanceRaw: "2000",
      source: tokenAmountMetadata(APP_CONFIG.uniswap.coti, "COTI", 18, 1000n),
    },
    tx: { data: "0x", from: "0xWallet", to: APP_CONFIG.uniswap.router, value: "0x0" },
    type: "uniswap-swap",
    ...overrides,
  };
}

describe("pre-sign wallet state check", () => {
  it("warns when reviewed balance and allowance changed before a swap", async () => {
    const warnings = await checkPreparedStepBeforeSigning("0xWallet", step(), reader(1500n, 900n));
    expect(warnings.map((item) => item.code)).toEqual(["balance-changed", "allowance-changed", "allowance-low"]);
    expect(preSignWarningText(warnings[0])).toContain("Step 2 Uniswap swap");
  });

  it("warns when an approval is already covered", async () => {
    const approvalStep = step({
      index: 1,
      label: "Approve COTI",
      trade: {
        action: "approve",
        protocol: "Uniswap",
        reviewAllowanceRaw: "0",
        reviewSourceBalanceRaw: "2000",
        source: tokenAmountMetadata(APP_CONFIG.uniswap.coti, "COTI", 18, 1000n),
        spender: APP_CONFIG.uniswap.router,
      },
      type: "approval",
    });
    const warnings = await checkPreparedStepBeforeSigning("0xWallet", approvalStep, reader(2000n, 1200n));
    expect(warnings.map((item) => item.code)).toEqual(["allowance-changed", "approval-already-covered"]);
  });

  it("checks native bridge balance without reading allowance", async () => {
    let allowanceReads = 0;
    const nativeReader: PreSignStateReader = {
      allowanceOf: async () => {
        allowanceReads += 1;
        return 0n;
      },
      balanceOf: async () => 900n,
    };
    const bridgeStep = step({
      chain: "coti",
      label: "Rebalance COTI",
      trade: {
        action: "bridge",
        protocol: "Bridge",
        reviewSourceBalanceRaw: "1000",
        source: tokenAmountMetadata(NATIVE_COTI, "COTI", 18, 1000n),
      },
      type: "bridge-transfer",
    });
    const warnings = await checkPreparedStepBeforeSigning("0xWallet", bridgeStep, nativeReader);
    expect(warnings.map((item) => item.code)).toEqual(["balance-changed", "balance-low"]);
    expect(allowanceReads).toBe(0);
  });

  it("blocks a swap that would revert before signing", async () => {
    const simulator: StepSimulator = {
      call: async () => {
        throw new Error("execution reverted");
      },
    };
    await expect(assertPreparedStepStillExecutable(step({ label: "Carbon swap", type: "carbon-swap" }), simulator))
      .rejects.toThrow("Carbon swap would revert now. Refresh quote before signing.");
  });

  it("does not simulate non-swap steps", async () => {
    let calls = 0;
    const simulator: StepSimulator = {
      call: async () => {
        calls += 1;
      },
    };
    await assertPreparedStepStillExecutable(step({ type: "approval" }), simulator);
    expect(calls).toBe(0);
  });
});
