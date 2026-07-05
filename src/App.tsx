import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bridgeTrackingItemFromStep,
  cleanupBridgeTrackingItems,
  fetchBridgeTrackingItem,
  fetchRecentBridgeTrackingItems,
  isBridgeResolved,
  loadBridgeTrackingItems,
  markBridgeTrackingError,
  markBridgeTrackingFailed,
  mergeBridgeTrackingItems,
  saveBridgeTrackingItems,
  type BridgeTrackingItem,
} from "./arb/bridgeTracker";
import { APP_CONFIG } from "./arb/config";
import { buildQuote, loadWalletInventory, preparePlan, prepareRebalancePlan } from "./arb/engine";
import { assertPreparedStepStillExecutable, checkPreparedStepBeforeSigning, preSignWarningText } from "./arb/preSignCheck";
import { quoteReviewWarnings } from "./arb/reviewWarnings";
import { waitForTransactionReceipt } from "./arb/receipts";
import { tradeSummaryText } from "./arb/tradeMetadata";
import type { PairId, PreparedStep, PreparedWalletPlan, QuoteResult, RebalanceSuggestion, RebalanceSummary, RebalanceTokenId, WalletBalances, WalletInventoryState } from "./arb/types";
import { connectProvider, currentAccount, discoverProviders, switchChain, type ProviderEntry } from "./arb/wallet";
import { explorerTx, isAllowedWallet, numberFmt, sameAddress, shortAddress, usdFmt } from "./arb/utils";
import "./index.css";

type FlowState = "idle" | "loading" | "ready" | "signing" | "success" | "error";
type RebalanceScope = "both" | RebalanceTokenId;

const STEP_LABELS = ["Connect", "Quote", "Review", "Sign"] as const;
const EMPTY_OPPORTUNITIES = [
  { pairId: "coti-gcoti" as PairId, pairLabel: "COTI/gCOTI" },
  { pairId: "coti-usdc" as PairId, pairLabel: "COTI/USDC" },
];
const REBALANCE_SCOPES: Array<{ label: string; value: RebalanceScope }> = [
  { label: "Both", value: "both" },
  { label: "COTI", value: "coti" },
  { label: "gCOTI", value: "gcoti" },
];
type OpportunityListItem = QuoteResult["opportunities"][number] | typeof EMPTY_OPPORTUNITIES[number];

interface TxProgress {
  hash?: string;
  index: number;
  label: string;
  message: string;
  status: "mining" | "pending" | "success" | "error" | "waiting";
  chain?: "ethereum" | "coti";
}

function stepName(index: number): string {
  return STEP_LABELS[index] || "";
}

function parseError(error: unknown): string {
  if (typeof error === "object" && error) {
    const record = error as { message?: string; reason?: string; shortMessage?: string };
    return record.shortMessage || record.reason || record.message || "Operation failed.";
  }
  return String(error || "Operation failed.");
}

function pairTitle(pairId: PairId): string {
  return pairId === "coti-gcoti" ? "COTI/gCOTI" : "COTI/USDC";
}

function isQuotedOpportunity(item: OpportunityListItem): item is QuoteResult["opportunities"][number] {
  return "summary" in item && "netProfitUsd" in item;
}

function rebalanceText(rebalance: RebalanceSummary | null, activeBridgeCount: number, selectedSuggestions: RebalanceSuggestion[]): string {
  if (activeBridgeCount > 0) return `${activeBridgeCount} bridge transfer${activeBridgeCount === 1 ? "" : "s"} still being tracked.`;
  if (!rebalance) return "Refresh balances.";
  const executableCount = selectedSuggestions.filter((item) => item.executable).length;
  if (!executableCount) {
    const selectedReason = selectedSuggestions.map((item) => item.reason).filter(Boolean).join(" ");
    return selectedReason || rebalance.reason || "No rebalance needed.";
  }
  return `Bridge ${executableCount} token${executableCount === 1 ? "" : "s"}.`;
}

function chainLabel(chainId: number | null): string {
  if (chainId === APP_CONFIG.ethereum.chainId) return "Ethereum";
  if (chainId === APP_CONFIG.coti.chainId) return "COTI";
  return chainId === null ? "n/a" : String(chainId);
}

function bridgeStatusLabel(status: BridgeTrackingItem["status"]): string {
  if (status === "in_progress") return "in progress";
  return status;
}

function bridgeStatusPillClass(status: BridgeTrackingItem["status"]): string {
  if (status === "done") return "ok";
  if (status === "refunded") return "warn";
  return "blocked";
}

function bridgeStatusText(item: BridgeTrackingItem): string {
  if (item.error) return item.error;
  const activeStage = item.stages.find((stage) => !stage.completed) || item.stages[item.stages.length - 1];
  if (activeStage?.errorDetails) return activeStage.errorDetails;
  if (activeStage?.description) return `${activeStage.label || activeStage.systemName}: ${activeStage.description}`;
  return item.overallStatus || "Waiting for tracker.";
}

function bridgeStageRows(item: BridgeTrackingItem) {
  if (item.stages.length) {
    return item.stages.map((stage) => ({
      detail: stage.errorDetails || stage.description || stage.currentStep || stage.status,
      key: `${stage.stepId}:${stage.systemName}`,
      label: stage.label || stage.systemName,
      state: stage.errorDetails || stage.status.toLowerCase() === "error" ? "error" : stage.completed ? "done" : "active",
    }));
  }
  const failed = Boolean(item.error) || item.status === "failed" || item.status === "refunded";
  return [
    { detail: "Source transaction submitted.", key: "detected", label: "Detected", state: "done" },
    { detail: item.error || item.overallStatus || "Waiting for tracker data.", key: "preparing", label: "Preparing", state: failed ? "error" : item.status === "done" ? "done" : "active" },
    { detail: item.destinationHash ? "Arrival transaction found." : "Destination transaction not found yet.", key: "arrival", label: "Arrival", state: item.status === "done" || item.destinationHash ? "done" : failed ? "error" : "active" },
  ];
}

function walletInventoryFromQuote(result: QuoteResult): WalletInventoryState {
  return {
    balances: result.balances,
    generatedAtUtc: result.generatedAtUtc,
    rebalance: result.rebalance,
    wallet: result.wallet,
  };
}

function bestOpportunityByNet(result: QuoteResult) {
  return result.opportunities.reduce((best, item) => (
    !best || item.netProfitAfterFeesUsd > best.netProfitAfterFeesUsd ? item : best
  ), null as QuoteResult["opportunities"][number] | null);
}

function appendUnique(items: string[], incoming: string[]): string[] {
  return Array.from(new Set([...items, ...incoming]));
}

function bridgeSummary(activeCount: number, failedCount: number, totalCount: number, fallback: string): string {
  if (activeCount) return `${activeCount} active`;
  if (failedCount) return `${failedCount} review`;
  if (totalCount) return `${totalCount} history`;
  return fallback;
}

function SignatureCard({
  flow,
  prepared,
  preparedStepByIndex,
  preparedWarnings,
  progress,
  sign,
  signWarnings,
}: {
  flow: FlowState;
  prepared: PreparedWalletPlan;
  preparedStepByIndex: Map<number, PreparedStep>;
  preparedWarnings: Array<{ message: string }>;
  progress: TxProgress[];
  sign: () => void;
  signWarnings: string[];
}) {
  return (
    <div className="sign-card">
      <div className="review-head">
        <div>
          <h3>Signatures</h3>
          <p>{prepared.warning}</p>
        </div>
        <button className="danger" type="button" onClick={sign} disabled={flow === "signing"}>Start</button>
      </div>
      {preparedWarnings.length ? (
        <div className="warning-list">
          {preparedWarnings.map((warning) => <p key={warning.message}>{warning.message}</p>)}
        </div>
      ) : null}
      {signWarnings.length ? (
        <div className="warning-list">
          {signWarnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      ) : null}
      <div className="tx-list">
        {progress.map((item) => {
          const step = preparedStepByIndex.get(item.index);
          return (
            <div className={`tx-row ${item.status}`} key={item.index}>
              <span>{item.index}</span>
              <div>
                <strong>{item.label}</strong>
                {step?.trade ? <small className="trade-line">{tradeSummaryText(step.trade)}</small> : null}
                <small>{item.message}</small>
                {item.hash && item.chain ? <a href={explorerTx(item.chain, item.hash)} target="_blank" rel="noreferrer">{shortAddress(item.hash)}</a> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [providerId, setProviderId] = useState("");
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [inventory, setInventory] = useState<WalletInventoryState | null>(null);
  const [selectedPair, setSelectedPair] = useState<PairId>("coti-gcoti");
  const [rebalanceScope, setRebalanceScope] = useState<RebalanceScope>("both");
  const [prepared, setPrepared] = useState<PreparedWalletPlan | null>(null);
  const [progress, setProgress] = useState<TxProgress[]>([]);
  const [signWarnings, setSignWarnings] = useState<string[]>([]);
  const [flow, setFlow] = useState<FlowState>("idle");
  const [message, setMessage] = useState("Connect wallet.");
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [bridgeItems, setBridgeItems] = useState<BridgeTrackingItem[]>(() => loadBridgeTrackingItems());
  const [bridgeHistoryLoading, setBridgeHistoryLoading] = useState(false);
  const [bridgeHistoryMessage, setBridgeHistoryMessage] = useState("Recent bridge history loads from the public tracker.");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showBalances, setShowBalances] = useState(false);
  const [showBridgeTracking, setShowBridgeTracking] = useState(false);

  const selectedProvider = useMemo(
    () => providers.find((entry) => entry.id === providerId) || providers[0] || null,
    [providerId, providers],
  );
  const allowed = account ? isAllowedWallet(account) : false;
  const selectedOpportunity = quote?.opportunities.find((item) => item.pairId === selectedPair) || null;
  const opportunityItems = quote?.opportunities || EMPTY_OPPORTUNITIES;
  const balances: WalletBalances | null = inventory?.balances || quote?.balances || null;
  const rebalance = inventory?.rebalance || quote?.rebalance || null;
  const selectedRebalanceTokens = useMemo(
    () => rebalanceScope === "both" ? (["coti", "gcoti"] as RebalanceTokenId[]) : [rebalanceScope],
    [rebalanceScope],
  );
  const selectedRebalanceSuggestions = useMemo(() => {
    const selected = new Set(selectedRebalanceTokens);
    return rebalance?.suggestions.filter((suggestion) => suggestion.token && selected.has(suggestion.token)) || [];
  }, [rebalance, selectedRebalanceTokens]);
  const selectedRebalanceExecutable = selectedRebalanceSuggestions.some((suggestion) => suggestion.executable);
  const trackingWallet = account && allowed ? account : APP_CONFIG.allowedWallet;
  const trackedBridges = useMemo(
    () => bridgeItems.filter((item) => sameAddress(item.wallet, trackingWallet)),
    [bridgeItems, trackingWallet],
  );
  const activeBridges = useMemo(() => trackedBridges.filter((item) => !isBridgeResolved(item)), [trackedBridges]);
  const resolvedBridges = useMemo(() => trackedBridges.filter(isBridgeResolved), [trackedBridges]);
  const visibleTrackedBridges = useMemo(() => {
    const historyLimit = activeBridges.length ? 4 : 6;
    return [...activeBridges, ...resolvedBridges.slice(0, historyLimit)];
  }, [activeBridges, resolvedBridges]);
  const failedBridgeCount = useMemo(() => trackedBridges.filter((item) => item.status === "failed" || item.status === "refunded").length, [trackedBridges]);
  const rebalanceBlockedByBridge = activeBridges.length > 0;
  const preparedWarnings = prepared?.kind === "arb" ? prepared.reviewWarnings || [] : [];
  const quotePreviewWarnings = selectedOpportunity && quote ? quoteReviewWarnings(quote, selectedOpportunity, nowMs).filter((warning) => warning.code === "stale-quote") : [];
  const preparedStepByIndex = useMemo(() => new Map(prepared?.steps.map((step) => [step.index, step]) || []), [prepared]);

  useEffect(() => {
    discoverProviders().then((items) => {
      setProviders(items);
      setProviderId((current) => current || items[0]?.id || "");
    });
  }, []);

  useEffect(() => {
    setBridgeItems(loadBridgeTrackingItems());
  }, [account]);

  useEffect(() => {
    if (!quote) return undefined;
    const interval = window.setInterval(() => setNowMs(Date.now()), 10000);
    return () => window.clearInterval(interval);
  }, [quote]);

  const refreshTrackedBridges = useCallback(async (walletOverride = account, importHistory = false) => {
    const wallet = walletOverride;
    let importError: string | null = null;
    let stored = cleanupBridgeTrackingItems(loadBridgeTrackingItems());
    if (!wallet) {
      setBridgeItems(stored);
      return stored;
    }
    if (importHistory) {
      setBridgeHistoryLoading(true);
      setBridgeHistoryMessage("Loading recent bridge history...");
      const imported = await fetchRecentBridgeTrackingItems(wallet).catch((error) => {
        console.warn("Bridge history import failed:", error);
        importError = parseError(error);
        return [];
      });
      stored = cleanupBridgeTrackingItems(mergeBridgeTrackingItems(stored, imported));
    }
    const relevant = stored.filter((item) => sameAddress(item.wallet, wallet));
    if (!relevant.length) {
      saveBridgeTrackingItems(stored);
      setBridgeItems(stored);
      if (importHistory) {
        setBridgeHistoryLoading(false);
        setBridgeHistoryMessage(importError ? `Bridge history import failed: ${importError}` : "No recent bridge transfers found.");
      }
      return stored;
    }
    const refreshed = await Promise.all(relevant.map(async (item) => (
      item.status === "done" || item.status === "refunded"
        ? item
        : fetchBridgeTrackingItem(item).catch((error) => markBridgeTrackingError(item, error))
    )));
    const otherWallets = stored.filter((item) => !sameAddress(item.wallet, wallet));
    const next = cleanupBridgeTrackingItems(mergeBridgeTrackingItems(otherWallets, refreshed));
    saveBridgeTrackingItems(next);
    setBridgeItems(next);
    if (importHistory) {
      const count = next.filter((item) => sameAddress(item.wallet, wallet)).length;
      setBridgeHistoryLoading(false);
      setBridgeHistoryMessage(importError
        ? `Bridge history import failed: ${importError}`
        : `Loaded ${count} recent bridge transfer${count === 1 ? "" : "s"}.`);
    }
    return next;
  }, [account]);

  useEffect(() => {
    void refreshTrackedBridges(APP_CONFIG.allowedWallet, true);
  }, [refreshTrackedBridges]);

  const refreshInventory = useCallback(async (quiet = false) => {
    if (!account || !allowed) {
      if (!quiet) setMessage("Connect wallet first.");
      return null;
    }
    try {
      setInventoryLoading(true);
      if (!quiet) {
        setFlow("loading");
        setMessage("Refreshing balances...");
      }
      const result = await loadWalletInventory(account);
      setInventory(result);
      if (!quiet) {
        setFlow("ready");
        setMessage("Balances updated.");
      }
      return result;
    } catch (error) {
      if (!quiet) setFlow("error");
      setMessage(parseError(error));
      return null;
    } finally {
      setInventoryLoading(false);
    }
  }, [account, allowed]);

  const chooseRebalanceScope = useCallback((scope: RebalanceScope) => {
    setRebalanceScope(scope);
    if (prepared?.kind === "rebalance") {
      setPrepared(null);
      setProgress([]);
      setSignWarnings([]);
      setFlow("idle");
      setMessage("Review rebalance again.");
    }
  }, [prepared]);

  useEffect(() => {
    if (!account || !allowed || activeBridges.length === 0) return undefined;
    const refresh = () => {
      void refreshTrackedBridges();
      void refreshInventory(true);
    };
    refresh();
    const interval = window.setInterval(refresh, 30000);
    return () => window.clearInterval(interval);
  }, [account, activeBridges.length, allowed, refreshInventory, refreshTrackedBridges]);

  const connect = useCallback(async () => {
    if (!selectedProvider) {
      setFlow("error");
      setMessage("No wallet detected.");
      return;
    }
    try {
      setFlow("loading");
      setMessage("Connecting...");
      const result = await connectProvider(selectedProvider);
      setAccount(result.address);
      setChainId(result.chainId);
      setPrepared(null);
      setQuote(null);
      setInventory(null);
      setProgress([]);
      setSignWarnings([]);
      setBridgeItems(loadBridgeTrackingItems());
      if (!isAllowedWallet(result.address)) {
        setFlow("error");
        setMessage(`${shortAddress(result.address)} not allowed.`);
        return;
      }
      setMessage("Importing bridge history...");
      await refreshTrackedBridges(result.address, true);
      setMessage("Loading balances...");
      try {
        setInventory(await loadWalletInventory(result.address));
        setMessage("Ready. Balances updated.");
      } catch (inventoryError) {
        setMessage(`Ready. Balance refresh failed: ${parseError(inventoryError)}`);
      }
      setFlow("ready");
    } catch (error) {
      setFlow("error");
      setMessage(parseError(error));
    }
  }, [refreshTrackedBridges, selectedProvider]);

  const forget = useCallback(() => {
    setAccount("");
    setChainId(null);
    setQuote(null);
    setInventory(null);
    setPrepared(null);
    setProgress([]);
    setSignWarnings([]);
    setBridgeItems(loadBridgeTrackingItems());
    setFlow("idle");
    setMessage("Wallet forgotten.");
  }, []);

  const refreshQuote = useCallback(async () => {
    if (!account || !allowed) {
      setMessage("Connect wallet first.");
      return;
    }
    try {
      setFlow("loading");
      setPrepared(null);
      setProgress([]);
      setSignWarnings([]);
      setMessage("Quoting...");
      const result = await buildQuote(account);
      setQuote(result);
      setInventory(walletInventoryFromQuote(result));
      setNowMs(Date.now());
      const best = bestOpportunityByNet(result);
      if (best) setSelectedPair(best.pairId);
      setFlow("ready");
      setMessage("Quote updated.");
    } catch (error) {
      setFlow("error");
      setMessage(parseError(error));
    }
  }, [account, allowed]);

  const review = useCallback(async () => {
    if (!account || !allowed || !selectedOpportunity?.executable) {
      setMessage(selectedOpportunity?.reason || "Selected opportunity is blocked.");
      return;
    }
    try {
      setFlow("loading");
      setProgress([]);
      setSignWarnings([]);
      setMessage("Preparing txs...");
      const plan = await preparePlan(account, selectedPair);
      const warnings = quoteReviewWarnings(quote, plan.opportunity);
      const reviewedPlan = { ...plan, reviewWarnings: warnings };
      setPrepared(reviewedPlan);
      setProgress(plan.steps.map((step) => ({
        chain: step.chain,
        index: step.index,
        label: step.label,
        message: "Waiting for signature",
        status: "waiting",
      })));
      setFlow("ready");
      setMessage(warnings.length ? "Review prepared with warnings." : "Review prepared.");
    } catch (error) {
      setFlow("error");
      setMessage(parseError(error));
    }
  }, [account, allowed, quote, selectedOpportunity, selectedPair]);

  const reviewRebalance = useCallback(async () => {
    if (!account || !allowed) {
      setMessage("Connect wallet first.");
      return;
    }
    if (rebalanceBlockedByBridge) {
      setMessage("A bridge transfer is still unresolved. Wait for tracking to finish before rebalancing again.");
      return;
    }
    try {
      setFlow("loading");
      setProgress([]);
      setSignWarnings([]);
      setMessage("Preparing rebalance...");
      const plan = await prepareRebalancePlan(account, { tokens: selectedRebalanceTokens });
      setPrepared(plan);
      setProgress(plan.steps.map((step) => ({
        chain: step.chain,
        index: step.index,
        label: step.label,
        message: "Waiting for signature",
        status: "waiting",
      })));
      setFlow("ready");
      setMessage("Rebalance prepared.");
    } catch (error) {
      setFlow("error");
      setMessage(parseError(error));
    }
  }, [account, allowed, rebalanceBlockedByBridge, selectedRebalanceTokens]);

  const sign = useCallback(async () => {
    if (!selectedProvider || !prepared) return;
    try {
      setFlow("signing");
      setMessage("Signing...");
      const current = await currentAccount(selectedProvider);
      if (!current || current.toLowerCase() !== prepared.wallet.toLowerCase()) {
        throw new Error("Wallet account changed before signing.");
      }
      const nextProgress = prepared.steps.map((step) => ({
        chain: step.chain,
        index: step.index,
        label: step.label,
        message: "Waiting for signature",
        status: "waiting" as const,
      }));
      const submittedBridgeItems: BridgeTrackingItem[] = [];
      const persistBridgeItem = (item: BridgeTrackingItem) => {
        const next = mergeBridgeTrackingItems(loadBridgeTrackingItems(), [item]);
        saveBridgeTrackingItems(next);
        setBridgeItems(next);
        return item;
      };
      setProgress(nextProgress);
      setSignWarnings([]);
      for (const step of prepared.steps) {
        setProgress((items) => items.map((item) => item.index === step.index ? { ...item, message: "Checking wallet state", status: "pending" } : item));
        try {
          const warnings = await checkPreparedStepBeforeSigning(prepared.wallet, step);
          if (warnings.length) {
            const texts = warnings.map(preSignWarningText);
            setSignWarnings((items) => appendUnique(items, texts));
          }
        } catch (checkError) {
          const text = `Step ${step.index} ${step.label}: Wallet state recheck failed: ${parseError(checkError)}`;
          setSignWarnings((items) => appendUnique(items, [text]));
        }
        await assertPreparedStepStillExecutable(step);
        await switchChain(selectedProvider, {
          blockExplorerUrls: [step.chain === "ethereum" ? APP_CONFIG.ethereum.explorer : APP_CONFIG.coti.explorer],
          chainIdHex: step.chain === "ethereum" ? APP_CONFIG.ethereum.chainIdHex : APP_CONFIG.coti.chainIdHex,
          label: step.chain === "ethereum" ? APP_CONFIG.ethereum.label : APP_CONFIG.coti.label,
          nativeCurrency: step.chain === "ethereum" ? APP_CONFIG.ethereum.nativeCurrency : APP_CONFIG.coti.nativeCurrency,
          rpcUrl: step.chain === "ethereum" ? APP_CONFIG.ethRpcUrl : APP_CONFIG.cotiRpcUrl,
        });
        setProgress((items) => items.map((item) => item.index === step.index ? { ...item, message: "Confirm in wallet", status: "pending" } : item));
        const hash = await selectedProvider.provider.request({
          method: "eth_sendTransaction",
          params: [step.tx],
        });
        if (typeof hash !== "string") throw new Error(`${step.label} did not return a transaction hash.`);
        setProgress((items) => items.map((item) => item.index === step.index ? { ...item, hash, message: "Waiting for receipt", status: "mining" } : item));
        let trackingItem: BridgeTrackingItem | null = null;
        if (prepared.kind === "rebalance" && step.bridge) {
          trackingItem = bridgeTrackingItemFromStep(prepared.wallet, hash, step.bridge);
          submittedBridgeItems.push(trackingItem);
          persistBridgeItem(trackingItem);
        }
        let receipt;
        try {
          receipt = await waitForTransactionReceipt(step.chain, hash);
        } catch (receiptError) {
          if (trackingItem) persistBridgeItem(markBridgeTrackingError(trackingItem, receiptError));
          throw receiptError;
        }
        if (receipt.status !== "success") {
          const failure = new Error(`${step.label} source transaction reverted.`);
          if (trackingItem) persistBridgeItem(markBridgeTrackingFailed(trackingItem, failure));
          throw failure;
        }
        const minedMessage = receipt.blockNumber ? `Mined in block ${receipt.blockNumber}` : "Mined";
        setProgress((items) => items.map((item) => item.index === step.index ? { ...item, message: minedMessage, status: "success" } : item));
      }
      setFlow("success");
      if (prepared.kind === "rebalance") {
        if (submittedBridgeItems.length) await refreshTrackedBridges(prepared.wallet, true);
      }
      await refreshInventory(true);
      setMessage(prepared.kind === "rebalance" ? "Bridge submitted. Tracking arrival." : "Submitted. Refresh before trading again.");
    } catch (error) {
      const errorText = parseError(error);
      setFlow("error");
      setMessage(errorText);
      setProgress((items) => items.map((item) => item.status === "pending" || item.status === "mining" ? { ...item, message: errorText, status: "error" } : item));
    }
  }, [prepared, refreshInventory, refreshTrackedBridges, selectedProvider]);

  const clearResolvedBridges = useCallback(() => {
    const next = cleanupBridgeTrackingItems(loadBridgeTrackingItems()).filter((item) => !(sameAddress(item.wallet, trackingWallet) && isBridgeResolved(item)));
    saveBridgeTrackingItems(next);
    setBridgeItems(next);
  }, [trackingWallet]);

  const activeStep = account ? quote ? prepared ? 3 : 2 : 1 : 0;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Wallet Console</h1>
        </div>
        <div className="top-status">
          <div className={`status ${flow}`} aria-live="polite">{flow}</div>
          <small>{account ? `${shortAddress(account)} - ${chainLabel(chainId)}` : "wallet not connected"}</small>
        </div>
      </header>

      <section className="steps">
        {[0, 1, 2, 3].map((step) => (
          <div className={`step ${activeStep >= step ? "active" : ""}`} key={step}>
            <span>{step + 1}</span>
            <strong>{stepName(step)}</strong>
          </div>
        ))}
      </section>

      <section className="workflow">
        <section className="panel action-strip">
          <label className="field provider-field">
            <span>Provider</span>
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              {providers.length === 0 ? <option>No wallet detected</option> : providers.map((provider) => (
                <option value={provider.id} key={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
          <Info label="Wallet" value={account ? shortAddress(account) : "not connected"} />
          <Info label="Network" value={chainLabel(chainId)} />
          {account && !allowed ? <div className="access-blocked">This wallet is not allowed.</div> : null}
          <div className="action-buttons">
            <button className="primary" type="button" onClick={connect}>{account ? "Change" : "Connect"}</button>
            <button type="button" onClick={forget} disabled={!account}>Forget</button>
            <button type="button" onClick={refreshQuote} disabled={!account || !allowed || flow === "loading" || flow === "signing"}>Quote</button>
          </div>
        </section>

        <section className="panel main-panel">
          <div className="panel-head">
            <div>
              <h2>Opportunities</h2>
              <p>{message}</p>
            </div>
            {quote ? <span className="fresh">Updated {new Date(quote.generatedAtUtc).toLocaleTimeString()}</span> : null}
          </div>

          <div className="opportunities">
            {opportunityItems.map((item) => {
              const opportunity = isQuotedOpportunity(item) ? item : null;
              const pairId = item.pairId;
              return (
                <button className={`opportunity ${selectedPair === pairId ? "selected" : ""} ${opportunity?.executable ? "ok" : "blocked"}`} type="button" key={pairId} onClick={() => setSelectedPair(pairId)}>
                  <span>{pairTitle(pairId)}</span>
                  <strong>{opportunity ? usdFmt(opportunity.netProfitUsd) : "not quoted"}</strong>
                  <small>{opportunity ? `${numberFmt(opportunity.summary.profitTokenAmount)} ${opportunity.summary.profitTokenSymbol} profit - net ${usdFmt(opportunity.netProfitAfterFeesUsd)}` : "Quote"}</small>
                </button>
              );
            })}
          </div>

          {selectedOpportunity ? (
            <>
            <div className="review-card">
              <div className="review-head">
                <div>
                  <h3>{selectedOpportunity.pairLabel}</h3>
                  <p>{selectedOpportunity.action}</p>
                </div>
                <span className={selectedOpportunity.executable ? "pill ok" : "pill blocked"}>{selectedOpportunity.executable ? "executable" : "blocked"}</span>
              </div>
              <div className="numbers">
                <div><span>Input</span><strong>{numberFmt(selectedOpportunity.summary.inputAmount)} {selectedOpportunity.summary.inputSymbol}</strong></div>
                <div><span>Intermediate</span><strong>{numberFmt(selectedOpportunity.summary.bridgeOutputAmount)} {selectedOpportunity.summary.bridgeOutputSymbol}</strong></div>
                <div><span>Output</span><strong>{numberFmt(selectedOpportunity.summary.outputAmount)} {selectedOpportunity.summary.outputSymbol}</strong></div>
              </div>
              <div className="fee-summary">
                <div>
                  <span>Profit</span>
                  <strong>{usdFmt(selectedOpportunity.netProfitUsd)}</strong>
                  <small className="token-profit">Token profit {numberFmt(selectedOpportunity.summary.profitTokenAmount)} {selectedOpportunity.summary.profitTokenSymbol}</small>
                </div>
                <div><span>Fees</span><strong>{usdFmt(selectedOpportunity.estimatedFeesUsd)}</strong></div>
                <div><span>Net</span><strong>{usdFmt(selectedOpportunity.netProfitAfterFeesUsd)}</strong></div>
              </div>
              {quotePreviewWarnings.length ? (
                <div className="warning-list">
                  {quotePreviewWarnings.map((warning) => <p key={warning.message}>{warning.message}</p>)}
                </div>
              ) : null}
              {selectedOpportunity.reason ? <div className="warning">{selectedOpportunity.reason}</div> : null}
              <div className="button-row">
                <button className="primary" type="button" onClick={review} disabled={!selectedOpportunity.executable || flow === "loading" || flow === "signing"}>Review</button>
                <button type="button" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide details" : "Details"}</button>
              </div>
            </div>
            {prepared?.kind === "arb" ? (
              <SignatureCard
                flow={flow}
                prepared={prepared}
                preparedStepByIndex={preparedStepByIndex}
                preparedWarnings={preparedWarnings}
                progress={progress}
                sign={sign}
                signWarnings={signWarnings}
              />
            ) : null}
            </>
          ) : null}

          <section className="balances-collapse">
            <button type="button" onClick={() => setShowBalances((value) => !value)}>
              {showBalances ? "Hide balances" : "Show balances"}
            </button>
            {showBalances ? (
              balances ? (
                <>
                  {inventory ? <p className="muted">Updated {new Date(inventory.generatedAtUtc).toLocaleTimeString()}</p> : null}
                  <div className="balances-grid">
                    <div>
                      <h3>Ethereum</h3>
                      <Balance label="COTI" value={balances.ethereum.tokens.coti.value} />
                      <Balance label="gCOTI" value={balances.ethereum.tokens.gcoti.value} />
                      <Balance label="USDC" value={balances.ethereum.tokens.usdc.value} />
                      <Balance label="ETH gas" value={balances.ethereum.native.value} />
                    </div>
                    <div>
                      <h3>COTI</h3>
                      <Balance label="COTI" value={balances.coti.tokens.coti.value} />
                      <Balance label="gCOTI" value={balances.coti.tokens.gcoti.value} />
                      <Balance label="USDCe" value={balances.coti.tokens.usdc.value} />
                      <Balance label="COTI gas" value={balances.coti.native.value} />
                    </div>
                  </div>
                </>
              ) : null
            ) : null}
          </section>

          <section className="rebalance-card">
            <div className="review-head">
              <div>
                <h3>Rebalance 50/50</h3>
                <p>{rebalanceText(rebalance, activeBridges.length, selectedRebalanceSuggestions)}</p>
              </div>
              {rebalance ? <span className={selectedRebalanceExecutable && !rebalanceBlockedByBridge ? "pill ok" : "pill blocked"}>{rebalanceBlockedByBridge ? "tracking" : selectedRebalanceExecutable ? "ready" : "blocked"}</span> : null}
            </div>
            <div className="rebalance-scope" role="group" aria-label="Rebalance scope">
              {REBALANCE_SCOPES.map((scope) => (
                <button
                  className={rebalanceScope === scope.value ? "active" : ""}
                  key={scope.value}
                  disabled={flow === "loading" || flow === "signing"}
                  onClick={() => chooseRebalanceScope(scope.value)}
                  type="button"
                >
                  {scope.label}
                </button>
              ))}
            </div>
            {rebalance?.suggestions.map((suggestion) => (
              <div className={`rebalance-details ${suggestion.executable ? "" : "muted-row"} ${suggestion.token && selectedRebalanceTokens.includes(suggestion.token) ? "" : "unselected"}`} key={suggestion.token || suggestion.tokenSymbol || suggestion.reason}>
                <span>{suggestion.executable ? `${suggestion.sourceChain} -> ${suggestion.targetChain}` : suggestion.reason || "No action"}</span>
                <strong>{suggestion.executable ? `${numberFmt(suggestion.amount)} ${suggestion.tokenSymbol}` : suggestion.tokenSymbol}</strong>
                <small>{suggestion.token && selectedRebalanceTokens.includes(suggestion.token) ? suggestion.executable ? "selected" : "no action" : "skipped"}</small>
              </div>
            ))}
            <div className="button-row">
              <button className="primary" type="button" onClick={reviewRebalance} disabled={!account || !allowed || !selectedRebalanceExecutable || rebalanceBlockedByBridge || flow === "loading" || flow === "signing"}>Rebalance</button>
              <button type="button" onClick={() => { void refreshInventory(); }} disabled={!account || !allowed || inventoryLoading || flow === "loading" || flow === "signing"}>{inventoryLoading ? "Refreshing" : "Refresh balances"}</button>
            </div>
          </section>

          {prepared?.kind === "rebalance" ? (
            <SignatureCard
              flow={flow}
              prepared={prepared}
              preparedStepByIndex={preparedStepByIndex}
              preparedWarnings={[]}
              progress={progress}
              sign={sign}
              signWarnings={signWarnings}
            />
          ) : null}

          <section className="bridge-card">
            <div className="review-head">
              <div>
                <h3>Bridge tracking</h3>
                <p>{bridgeSummary(
                  activeBridges.length,
                  failedBridgeCount,
                  trackedBridges.length,
                  bridgeHistoryLoading ? "Checking tracker" : bridgeHistoryMessage,
                )}</p>
              </div>
              <div className="bridge-head-actions">
                <span className={activeBridges.length ? "pill blocked" : failedBridgeCount ? "pill warn" : trackedBridges.length ? "pill ok" : "pill"}>{activeBridges.length ? "active" : failedBridgeCount ? "review" : trackedBridges.length ? "history" : "idle"}</span>
                <button type="button" onClick={() => setShowBridgeTracking((value) => !value)}>{showBridgeTracking ? "Hide" : "Show"}</button>
              </div>
            </div>
            {showBridgeTracking ? (
              visibleTrackedBridges.length ? (
                <div className="bridge-list">
                  {visibleTrackedBridges.map((item) => (
                    <div className={`bridge-item ${item.status}`} key={item.id}>
                      <div className="bridge-item-head">
                        <div>
                          <strong>{item.tokenSymbol} {item.sourceChain} {"->"} {item.targetChain}</strong>
                          <small>{numberFmt(item.amount)} {item.tokenSymbol}</small>
                        </div>
                        <span className={`pill ${bridgeStatusPillClass(item.status)}`}>{bridgeStatusLabel(item.status)}</span>
                      </div>
                      <small>{bridgeStatusText(item)}</small>
                      <div className="bridge-stages">
                        {bridgeStageRows(item).map((stage) => (
                          <div className={`bridge-stage ${stage.state}`} key={stage.key}>
                            <span>{stage.label}</span>
                            <small>{stage.detail}</small>
                          </div>
                        ))}
                      </div>
                      <div className="bridge-links">
                        <a href={explorerTx(item.sourceChain, item.hash)} target="_blank" rel="noreferrer">source {shortAddress(item.hash)}</a>
                        {item.destinationHash ? <a href={explorerTx(item.targetChain, item.destinationHash)} target="_blank" rel="noreferrer">arrival {shortAddress(item.destinationHash)}</a> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null
            ) : null}
            <div className="button-row">
              <button type="button" onClick={() => { void refreshTrackedBridges(trackingWallet, true); }} disabled={bridgeHistoryLoading || flow === "signing"}>{bridgeHistoryLoading ? "Loading history" : "Refresh tracking"}</button>
              <button type="button" onClick={clearResolvedBridges} disabled={!resolvedBridges.length || flow === "signing"}>Clear resolved</button>
            </div>
          </section>

          {showAdvanced ? (
            <pre className="advanced">{JSON.stringify({ quote, inventory, prepared, trackedBridges }, null, 2)}</pre>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Balance({ label, value }: { label: string; value: number }) {
  return (
    <div className="balance">
      <span>{label}</span>
      <strong>{numberFmt(value)}</strong>
    </div>
  );
}

export default App;
