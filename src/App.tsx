import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  formatUnits,
  isAddress,
  parseUnits,
  type ContractTransactionResponse,
  type JsonRpcSigner,
} from "ethers";

type Asset = "USDC" | "COTI";
type Direction = "toPrivate" | "toPublic";
type TxType = "idle" | "pending" | "success" | "error";

interface TxState {
  type: TxType;
  message: string;
  hash?: string;
}

interface StatsState {
  usdcTokenAddress: string;
  usdcSymbol: string;
  usdcDecimals: number;
  walletUsdc: string;
  walletUsdcRaw: bigint;
  walletPrivateUsdc: string;
  walletPrivateUsdcRaw: bigint;
  walletCoti: string;
  walletCotiRaw: bigint;
  walletPrivateCoti: string;
  walletPrivateCotiRaw: bigint;
  usdcAllowanceRaw: bigint;
  usdcAllowance: string;
  usdcReserve: string;
  cotiReserve: string;
  usdcPrivateSupply: string;
  cotiPrivateSupply: string;
  usdcFeeWei: bigint;
  cotiFeeWei: bigint;
  usdcFee: string;
  cotiFee: string;
}

type Eip1193Request = {
  method: string;
  params?: unknown[] | Record<string, unknown>;
};

type Eip1193Listener = (...args: unknown[]) => void;

interface EthereumProvider {
  request(args: Eip1193Request): Promise<unknown>;
  on?(event: string, listener: Eip1193Listener): void;
  removeListener?(event: string, listener: Eip1193Listener): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

const COTI_MAINNET = {
  label: "COTI Mainnet",
  chainId: 2632500,
  rpcUrl: "https://mainnet.coti.io/rpc",
  explorer: "https://mainnet.cotiscan.io",
  nativeCurrency: {
    name: "COTI",
    symbol: "COTI",
    decimals: 18,
  },
};

const DEPLOYED = {
  privateUsdc: "0x4e036E9e586a90cb298060BdB9eAB384Ddf62384",
  privateCoti: "0xFA16Cd99eE6E24066a0aB4E7ABdf1369c3D33e26",
  usdcPrivateVault: "0xdd387192Fa632018EB5B0B562FC842F3001adb44",
  cotiPrivateVault: "0xd5D92880031847842C8eC2c26911F3943C7Bf94c",
} as const;

const CONTRACTS_READY = Object.values(DEPLOYED).every((address) => isAddress(address));
const COTI_STEP = 1_000_000_000_000n; // 1e12 (0.000001 COTI)

const EMPTY_STATS: StatsState = {
  usdcTokenAddress: "",
  usdcSymbol: "USDC.e",
  usdcDecimals: 6,
  walletUsdc: "-",
  walletUsdcRaw: 0n,
  walletPrivateUsdc: "-",
  walletPrivateUsdcRaw: 0n,
  walletCoti: "-",
  walletCotiRaw: 0n,
  walletPrivateCoti: "-",
  walletPrivateCotiRaw: 0n,
  usdcAllowanceRaw: 0n,
  usdcAllowance: "-",
  usdcReserve: "-",
  cotiReserve: "-",
  usdcPrivateSupply: "-",
  cotiPrivateSupply: "-",
  usdcFeeWei: 0n,
  cotiFeeWei: 0n,
  usdcFee: "0",
  cotiFee: "0",
};

const USDC_VAULT_ABI = [
  "function publicToken() view returns (address)",
  "function toPrivate(uint256 publicAmount) payable",
  "function toPublic(uint256 publicAmount) payable",
  "function publicReserve() view returns (uint256)",
  "function swapFeeWei() view returns (uint256)",
] as const;

const COTI_VAULT_ABI = [
  "function toPrivate(uint256 cotiAmount) payable",
  "function toPublic(uint256 cotiAmount) payable",
  "function nativeReserve() view returns (uint256)",
  "function swapFeeWei() view returns (uint256)",
] as const;

const PRIVATE_TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

function formatShort(value: bigint, decimals: number, precision = 6): string {
  const [whole, frac = ""] = formatUnits(value, decimals).split(".");
  if (!frac) return whole;
  const cut = frac.slice(0, precision).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseRpcError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.shortMessage === "string") return record.shortMessage;
    if (typeof record.reason === "string") return record.reason;
    if (typeof record.message === "string") return record.message;
  }
  return "Operation failed.";
}

function App() {
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState<number | null>(null);
  const [stats, setStats] = useState<StatsState>(EMPTY_STATS);
  const [asset, setAsset] = useState<Asset>("USDC");
  const [direction, setDirection] = useState<Direction>("toPrivate");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [txState, setTxState] = useState<TxState>({
    type: "idle",
    message: CONTRACTS_READY
      ? "Connect wallet and swap."
      : "Contract configuration error in app constants.",
  });

  const connected = !!provider && !!account;
  const networkMismatch = chainId !== null && chainId !== COTI_MAINNET.chainId;

  const amountRawUSDC = useMemo(() => {
    try {
      return parseUnits(amount || "0", stats.usdcDecimals);
    } catch {
      return 0n;
    }
  }, [amount, stats.usdcDecimals]);

  const needsUsdcApproval =
    asset === "USDC" &&
    direction === "toPrivate" &&
    amountRawUSDC > 0n &&
    amountRawUSDC > stats.usdcAllowanceRaw;

  const fromToken = useMemo(() => {
    if (asset === "USDC") {
      return direction === "toPrivate" ? stats.usdcSymbol : "pUSDC";
    }
    return direction === "toPrivate" ? "COTI" : "pCOTI";
  }, [asset, direction, stats.usdcSymbol]);

  const toToken = useMemo(() => {
    if (asset === "USDC") {
      return direction === "toPrivate" ? "pUSDC" : stats.usdcSymbol;
    }
    return direction === "toPrivate" ? "pCOTI" : "COTI";
  }, [asset, direction, stats.usdcSymbol]);

  const fromBalanceRaw = useMemo(() => {
    if (asset === "USDC") {
      return direction === "toPrivate" ? stats.walletUsdcRaw : stats.walletPrivateUsdcRaw;
    }
    return direction === "toPrivate" ? stats.walletCotiRaw : stats.walletPrivateCotiRaw;
  }, [asset, direction, stats.walletUsdcRaw, stats.walletPrivateUsdcRaw, stats.walletCotiRaw, stats.walletPrivateCotiRaw]);

  const fromBalanceText = useMemo(() => {
    if (asset === "USDC") {
      return direction === "toPrivate"
        ? `${stats.walletUsdc} ${stats.usdcSymbol}`
        : `${stats.walletPrivateUsdc} pUSDC`;
    }
    return direction === "toPrivate" ? `${stats.walletCoti} COTI` : `${stats.walletPrivateCoti} pCOTI`;
  }, [
    asset,
    direction,
    stats.walletUsdc,
    stats.usdcSymbol,
    stats.walletPrivateUsdc,
    stats.walletCoti,
    stats.walletPrivateCoti,
  ]);

  const receivePreview = useMemo(() => {
    if (!amount.trim()) return "0";
    try {
      if (asset === "USDC") {
        const raw = parseUnits(amount, stats.usdcDecimals);
        return formatShort(raw, stats.usdcDecimals, 6);
      }
      const raw = parseUnits(amount, 18);
      return formatShort(raw, 18, 6);
    } catch {
      return "--";
    }
  }, [amount, asset, stats.usdcDecimals]);

  const setMaxAmount = useCallback(() => {
    if (fromBalanceRaw <= 0n) return;

    let raw = fromBalanceRaw;
    const decimals = asset === "USDC" ? stats.usdcDecimals : 18;

    if (asset === "COTI" && direction === "toPrivate") {
      if (raw <= stats.cotiFeeWei) {
        setTxState({ type: "error", message: "Not enough COTI balance to cover amount plus fee." });
        return;
      }
      raw -= stats.cotiFeeWei;
      raw -= raw % COTI_STEP;
    }

    if (asset === "COTI" && direction === "toPublic") {
      raw -= raw % COTI_STEP;
    }

    if (raw <= 0n) {
      setAmount("");
      return;
    }

    const nextAmount = formatUnits(raw, decimals).replace(/\.?0+$/, "");
    setAmount(nextAmount);
  }, [fromBalanceRaw, asset, direction, stats.usdcDecimals, stats.cotiFeeWei]);

  const canSubmit =
    CONTRACTS_READY &&
    connected &&
    !networkMismatch &&
    !busy &&
    !isRefreshing &&
    Number(amount) > 0;

  const clearWalletSession = useCallback((message: string) => {
    setProvider(null);
    setAccount("");
    setChainId(null);
    setStats(EMPTY_STATS);
    setAmount("");
    setBusy("");
    setIsRefreshing(false);
    setTxState({ type: "idle", message });
  }, []);

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      setTxState({ type: "error", message: "No wallet detected. Install MetaMask first." });
      return;
    }
    try {
      const browserProvider = new BrowserProvider(window.ethereum as never);
      await browserProvider.send("eth_requestAccounts", []);
      const signer = await browserProvider.getSigner();
      const wallet = await signer.getAddress();
      const network = await browserProvider.getNetwork();

      setProvider(browserProvider);
      setAccount(wallet);
      setChainId(Number(network.chainId));
      setTxState({ type: "success", message: "Wallet connected." });
    } catch (error) {
      setTxState({ type: "error", message: parseRpcError(error) });
    }
  }, []);

  const disconnectWallet = useCallback(() => {
    clearWalletSession("Wallet disconnected.");
  }, [clearWalletSession]);

  const switchWallet = useCallback(async () => {
    if (!window.ethereum) {
      setTxState({ type: "error", message: "No wallet provider available." });
      return;
    }
    try {
      try {
        await window.ethereum.request({
          method: "wallet_requestPermissions",
          params: [{ eth_accounts: {} }],
        });
      } catch (permissionError) {
        const code =
          typeof permissionError === "object" && permissionError !== null
            ? (permissionError as { code?: number }).code
            : undefined;
        if (code === 4001) {
          setTxState({ type: "error", message: "Wallet switch cancelled." });
          return;
        }
        if (code !== -32601) {
          throw permissionError;
        }
      }
      await connectWallet();
    } catch (error) {
      setTxState({ type: "error", message: parseRpcError(error) });
    }
  }, [connectWallet]);

  const switchToMainnet = useCallback(async () => {
    if (!window.ethereum) {
      setTxState({ type: "error", message: "No wallet provider available." });
      return;
    }
    const chainHex = `0x${COTI_MAINNET.chainId.toString(16)}`;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      });
      setTxState({ type: "success", message: `Switched to ${COTI_MAINNET.label}.` });
    } catch (switchError) {
      const code =
        typeof switchError === "object" && switchError !== null
          ? (switchError as { code?: number }).code
          : undefined;
      if (code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: chainHex,
                chainName: COTI_MAINNET.label,
                rpcUrls: [COTI_MAINNET.rpcUrl],
                blockExplorerUrls: [COTI_MAINNET.explorer],
                nativeCurrency: COTI_MAINNET.nativeCurrency,
              },
            ],
          });
          setTxState({ type: "success", message: `${COTI_MAINNET.label} added to wallet.` });
        } catch (addError) {
          setTxState({ type: "error", message: parseRpcError(addError) });
        }
      } else {
        setTxState({ type: "error", message: parseRpcError(switchError) });
      }
    }
  }, []);

  const executeWrite = useCallback(
    async (
      action: string,
      label: string,
      builder: (signer: JsonRpcSigner) => Promise<ContractTransactionResponse>,
    ) => {
      if (!provider || !account) {
        setTxState({ type: "error", message: "Connect wallet first." });
        return;
      }
      try {
        setBusy(action);
        const signer = await provider.getSigner();
        const tx = await builder(signer);
        setTxState({
          type: "pending",
          message: `${label} submitted...`,
          hash: tx.hash,
        });
        await tx.wait();
        setTxState({ type: "success", message: `${label} confirmed.`, hash: tx.hash });
      } catch (error) {
        setTxState({ type: "error", message: parseRpcError(error) });
      } finally {
        setBusy("");
      }
    },
    [provider, account],
  );

  const refreshData = useCallback(async () => {
    if (!provider || !account || !CONTRACTS_READY) return;
    setIsRefreshing(true);
    const patch: Partial<StatsState> = {};

    try {
      const coti = await provider.getBalance(account);
      patch.walletCotiRaw = coti;
      patch.walletCoti = formatShort(coti, 18, 6);
    } catch {
      patch.walletCoti = "-";
    }

    try {
      const usdcVault = new Contract(DEPLOYED.usdcPrivateVault, USDC_VAULT_ABI, provider);
      const [publicTokenAddress, usdcReserve, usdcFeeWei] = await Promise.all([
        usdcVault.publicToken(),
        usdcVault.publicReserve(),
        usdcVault.swapFeeWei(),
      ]);

      patch.usdcTokenAddress = String(publicTokenAddress);
      patch.usdcReserve = formatShort(usdcReserve as bigint, 6, 4);
      patch.usdcFeeWei = usdcFeeWei as bigint;
      patch.usdcFee = formatShort(usdcFeeWei as bigint, 18, 6);

      const usdcToken = new Contract(String(publicTokenAddress), ERC20_ABI, provider);
      const [symbol, decimals, balance, allowance] = await Promise.all([
        usdcToken.symbol(),
        usdcToken.decimals(),
        usdcToken.balanceOf(account),
        usdcToken.allowance(account, DEPLOYED.usdcPrivateVault),
      ]);

      const usdcDecimals = Number(decimals);
      patch.usdcSymbol = String(symbol);
      patch.usdcDecimals = usdcDecimals;
      patch.walletUsdcRaw = balance as bigint;
      patch.walletUsdc = formatShort(balance as bigint, usdcDecimals, 4);
      patch.usdcAllowanceRaw = allowance as bigint;
      patch.usdcAllowance = formatShort(allowance as bigint, usdcDecimals, 4);

      const privateUsdc = new Contract(DEPLOYED.privateUsdc, PRIVATE_TOKEN_ABI, provider);
      const [supply, tokenDecimals, privateBalance] = await Promise.all([
        privateUsdc.totalSupply(),
        privateUsdc.decimals(),
        privateUsdc.balanceOf(account),
      ]);
      patch.usdcPrivateSupply = formatShort(supply as bigint, Number(tokenDecimals), 4);
      patch.walletPrivateUsdcRaw = privateBalance as bigint;
      patch.walletPrivateUsdc = formatShort(privateBalance as bigint, Number(tokenDecimals), 4);
    } catch {
      patch.usdcReserve = "-";
    }

    try {
      const cotiVault = new Contract(DEPLOYED.cotiPrivateVault, COTI_VAULT_ABI, provider);
      const [cotiReserve, cotiFeeWei] = await Promise.all([cotiVault.nativeReserve(), cotiVault.swapFeeWei()]);
      patch.cotiReserve = formatShort(cotiReserve as bigint, 18, 6);
      patch.cotiFeeWei = cotiFeeWei as bigint;
      patch.cotiFee = formatShort(cotiFeeWei as bigint, 18, 6);

      const privateCoti = new Contract(DEPLOYED.privateCoti, PRIVATE_TOKEN_ABI, provider);
      const [supply, tokenDecimals, privateBalance] = await Promise.all([
        privateCoti.totalSupply(),
        privateCoti.decimals(),
        privateCoti.balanceOf(account),
      ]);
      patch.cotiPrivateSupply = formatShort(supply as bigint, Number(tokenDecimals), 4);
      patch.walletPrivateCotiRaw = privateBalance as bigint;
      patch.walletPrivateCoti = formatShort(privateBalance as bigint, Number(tokenDecimals), 4);
    } catch {
      patch.cotiReserve = "-";
    }

    setStats((prev) => ({ ...prev, ...patch }));
    setIsRefreshing(false);
  }, [provider, account]);

  const submitSwap = useCallback(async () => {
    if (!CONTRACTS_READY) {
      setTxState({ type: "error", message: "Contract addresses are not configured correctly in app constants." });
      return;
    }
    if (!connected) {
      setTxState({ type: "error", message: "Connect wallet first." });
      return;
    }
    if (networkMismatch) {
      setTxState({ type: "error", message: "Switch to COTI Mainnet before swapping." });
      return;
    }

    try {
      if (asset === "USDC") {
        const rawAmount = parseUnits(amount || "0", stats.usdcDecimals);
        if (rawAmount <= 0n) {
          setTxState({ type: "error", message: "Enter an amount greater than zero." });
          return;
        }

        if (direction === "toPrivate" && needsUsdcApproval) {
          await executeWrite("approve-usdc", "USDC approval", async (signer) => {
            const usdcToken = new Contract(stats.usdcTokenAddress, ERC20_ABI, signer);
            return usdcToken.approve(DEPLOYED.usdcPrivateVault, rawAmount) as Promise<ContractTransactionResponse>;
          });
          await refreshData();
          return;
        }

        await executeWrite(`usdc-${direction}`, `USDC ${direction}`, async (signer) => {
          const vault = new Contract(DEPLOYED.usdcPrivateVault, USDC_VAULT_ABI, signer);
          return direction === "toPrivate"
            ? (vault.toPrivate(rawAmount, { value: stats.usdcFeeWei }) as Promise<ContractTransactionResponse>)
            : (vault.toPublic(rawAmount, { value: stats.usdcFeeWei }) as Promise<ContractTransactionResponse>);
        });
        await refreshData();
        return;
      }

      const rawAmount = parseUnits(amount || "0", 18);
      if (rawAmount <= 0n) {
        setTxState({ type: "error", message: "Enter an amount greater than zero." });
        return;
      }
      if (rawAmount % COTI_STEP !== 0n) {
        setTxState({ type: "error", message: "COTI amount must be multiple of 0.000001." });
        return;
      }

      await executeWrite(`coti-${direction}`, `COTI ${direction}`, async (signer) => {
        const vault = new Contract(DEPLOYED.cotiPrivateVault, COTI_VAULT_ABI, signer);
        return direction === "toPrivate"
          ? (vault.toPrivate(rawAmount, { value: rawAmount + stats.cotiFeeWei }) as Promise<ContractTransactionResponse>)
          : (vault.toPublic(rawAmount, { value: stats.cotiFeeWei }) as Promise<ContractTransactionResponse>);
      });
      await refreshData();
    } catch (error) {
      setTxState({ type: "error", message: parseRpcError(error) });
    }
  }, [
    connected,
    networkMismatch,
    asset,
    direction,
    amount,
    stats.usdcDecimals,
    stats.usdcTokenAddress,
    stats.usdcFeeWei,
    stats.cotiFeeWei,
    executeWrite,
    refreshData,
    needsUsdcApproval,
  ]);

  useEffect(() => {
    const hydrateWallet = async () => {
      if (!window.ethereum) return;
      try {
        const browserProvider = new BrowserProvider(window.ethereum as never);
        const accounts = (await browserProvider.send("eth_accounts", [])) as string[];
        if (accounts.length === 0) return;
        const signer = await browserProvider.getSigner();
        const network = await browserProvider.getNetwork();
        setProvider(browserProvider);
        setAccount(await signer.getAddress());
        setChainId(Number(network.chainId));
      } catch {
        // ignore
      }
    };
    void hydrateWallet();
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;

    const onAccountsChanged: Eip1193Listener = (next) => {
      if (!Array.isArray(next) || next.length === 0 || typeof next[0] !== "string") {
        clearWalletSession("Wallet disconnected in provider.");
        return;
      }
      setAccount(next[0]);
    };

    const onChainChanged: Eip1193Listener = (next) => {
      if (typeof next === "string") {
        setChainId(Number.parseInt(next, 16));
      }
    };

    window.ethereum.on?.("accountsChanged", onAccountsChanged);
    window.ethereum.on?.("chainChanged", onChainChanged);
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", onChainChanged);
    };
  }, [clearWalletSession]);

  useEffect(() => {
    if (!provider || !account) return;
    void refreshData();
    const timer = setInterval(() => void refreshData(), 15000);
    return () => clearInterval(timer);
  }, [provider, account, refreshData]);

  return (
    <div className="app">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <header className="top">
        <div>
          <h1>Private Vault</h1>
          <p>Swap between public and private balances on COTI Mainnet.</p>
        </div>
        <div className="top-actions">
          {networkMismatch ? (
            <button className="btn btn-secondary" onClick={switchToMainnet} type="button">
              Switch To Mainnet
            </button>
          ) : null}
          {connected ? (
            <>
              <div className="wallet-pill">{shortAddress(account)}</div>
              <button className="btn btn-secondary" onClick={switchWallet} type="button">
                Switch Wallet
              </button>
              <button className="btn btn-ghost" onClick={disconnectWallet} type="button">
                Disconnect
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={connectWallet} type="button">
              Connect Wallet
            </button>
          )}
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => void refreshData()}
            disabled={!connected || isRefreshing}
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      <main className="swap-card">
        <div className="toggle-row">
          <div className="segmented">
            <button
              type="button"
              className={asset === "USDC" ? "active" : ""}
              onClick={() => setAsset("USDC")}
            >
              USDC.e
            </button>
            <button
              type="button"
              className={asset === "COTI" ? "active" : ""}
              onClick={() => setAsset("COTI")}
            >
              COTI
            </button>
          </div>
          <div className="segmented">
            <button
              type="button"
              className={direction === "toPrivate" ? "active" : ""}
              onClick={() => setDirection("toPrivate")}
            >
              toPrivate
            </button>
            <button
              type="button"
              className={direction === "toPublic" ? "active" : ""}
              onClick={() => setDirection("toPublic")}
            >
              toPublic
            </button>
          </div>
        </div>

        <div className="swap-flow">
          <div className="asset-panel">
            <div className="panel-head">
              <span>You pay</span>
              <button
                className="max-btn"
                type="button"
                onClick={setMaxAmount}
                disabled={fromBalanceRaw <= 0n || !!busy}
              >
                Max
              </button>
            </div>
            <div className="panel-main">
              <input
                className="amount-input"
                placeholder="0.0"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
              />
              <span className="token-chip">{fromToken}</span>
            </div>
            <p className="panel-meta">Balance: {fromBalanceText}</p>
          </div>

          <div className="flow-chip">
            {direction === "toPrivate" ? "Public -> Private" : "Private -> Public"}
          </div>

          <div className="asset-panel">
            <div className="panel-head">
              <span>You receive</span>
              <span className="estimate-tag">Estimated</span>
            </div>
            <div className="panel-main panel-main-readonly">
              <span className="amount-preview">{receivePreview}</span>
              <span className="token-chip token-chip-out">{toToken}</span>
            </div>
          </div>
        </div>

        {asset === "USDC" ? (
          <p className="helper">
            Fee in COTI: {stats.usdcFee} | Allowance: {stats.usdcAllowance} {stats.usdcSymbol}
          </p>
        ) : (
          <p className="helper">
            Fee in COTI: {stats.cotiFee} | Amount step: 0.000001 COTI
          </p>
        )}

        <button className="btn btn-main" type="button" disabled={!canSubmit} onClick={() => void submitSwap()}>
          {busy
            ? "Processing..."
            : needsUsdcApproval
              ? `Approve ${stats.usdcSymbol}`
              : direction === "toPrivate"
                ? "Swap To Private"
                : "Swap To Public"}
        </button>

        <div className={`tx tx-${txState.type}`}>
          <span>{txState.message}</span>
          {txState.hash ? (
            <a href={`${COTI_MAINNET.explorer}/tx/${txState.hash}`} target="_blank" rel="noreferrer">
              View Tx
            </a>
          ) : null}
        </div>

        <div className="mini-stats">
          <div>
            <span>USDC Vault Reserve</span>
            <strong>{stats.usdcReserve}</strong>
          </div>
          <div>
            <span>COTI Vault Reserve</span>
            <strong>{stats.cotiReserve}</strong>
          </div>
          <div>
            <span>Private USDC Supply</span>
            <strong>{stats.usdcPrivateSupply}</strong>
          </div>
          <div>
            <span>Private COTI Supply</span>
            <strong>{stats.cotiPrivateSupply}</strong>
          </div>
          <div>
            <span>USDC Vault Fee</span>
            <strong>{stats.usdcFee} COTI</strong>
          </div>
          <div>
            <span>COTI Vault Fee</span>
            <strong>{stats.cotiFee} COTI</strong>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
