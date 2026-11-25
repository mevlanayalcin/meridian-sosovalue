import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  KeyRound,
  Layers,
  Lock,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  TrendingUp,
  Wallet
} from "lucide-react";
import { EquityCurveChart, OrderbookDepthLadder } from "./components/Charts";
import type {
  BacktestResult,
  BasketLeg,
  FirewallCheckResult,
  MarketOverviewBundle,
  OrderbookSnapshot,
  PublishedThesis
} from "../shared/types";

type TabId = "desk" | "ssi" | "wealth" | "firewall" | "api";

const TABS: Array<{ id: TabId; label: string; step: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "desk", label: "Research & Macro", step: "1", icon: Bot },
  { id: "ssi", label: "SSI Parity & Backtest", step: "2", icon: TrendingUp },
  { id: "wealth", label: "Wealth & Pre-IPO RWA", step: "3", icon: Layers },
  { id: "firewall", label: "Risk Firewall & EIP-712", step: "4", icon: ShieldCheck },
  { id: "api", label: "Client API & MCP", step: "5", icon: Terminal }
];

const DEFAULT_LEGS: BasketLeg[] = [
  { symbol: "vMAG7ssi_vUSDC", source: "spot", weight: 0.4, label: "MAG7.ssi" },
  { symbol: "vQQQ_vUSDC", source: "spot", weight: 0.25, label: "vQQQ" },
  { symbol: "vBOXX_vUSDC", source: "spot", weight: 0.2, label: "vBOXX" },
  { symbol: "UNITREE", source: "wealth", weight: 0.15, label: "Unitree RWA" }
];

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: string };

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  const res = await fetch(url, init);
  return (await res.json()) as ApiEnvelope<T>;
}

function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export default function App() {
  const [tab, setTab] = useState<TabId>("desk");
  const [sosoKey, setSosoKey] = useState<string>(() => sessionStorage.getItem("meridian_soso_key") || "");
  const [showKeyModal, setShowKeyModal] = useState(false);

  const [overview, setOverview] = useState<MarketOverviewBundle | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Tab 1: Theses
  const [theses, setTheses] = useState<PublishedThesis[]>([]);
  const [thesisPrompt, setThesisPrompt] = useState("Institutional crypto + pre-IPO robotics & US equity barbell");
  const [generatingThesis, setGeneratingThesis] = useState(false);

  // Tab 2: Backtest
  const [legs, setLegs] = useState<BasketLeg[]>(DEFAULT_LEGS);
  const [rebalanceDays, setRebalanceDays] = useState(7);
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [runningBacktest, setRunningBacktest] = useState(false);

  // Tab 4: Risk Firewall & EIP-712
  const [fwNetwork, setFwNetwork] = useState<"testnet" | "mainnet">("testnet");
  const [fwMarketType, setFwMarketType] = useState<"spot" | "perps" | "wealth">("spot");
  const [fwSymbol, setFwSymbol] = useState("vMAG7ssi_vUSDC");
  const [fwSide, setFwSide] = useState<"BUY" | "SELL">("BUY");
  const [fwOrderType, setFwOrderType] = useState<"LIMIT" | "MARKET">("LIMIT");
  const [fwNotionalUsd, setFwNotionalUsd] = useState(450);
  const [fwPortfolioUsd, setFwPortfolioUsd] = useState(10_000);
  const [fwExistingUsd, setFwExistingUsd] = useState(0);
  const [fwAccountId, setFwAccountId] = useState(1001);
  const [fwMaxSlippage, setFwMaxSlippage] = useState(60);
  const [fwMaxConc, setFwMaxConc] = useState(35);
  const [fwResult, setFwResult] = useState<FirewallCheckResult | null>(null);
  const [orderbook, setOrderbook] = useState<OrderbookSnapshot | null>(null);
  const [preparedOrder, setPreparedOrder] = useState<Record<string, unknown> | null>(null);
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [walletSig, setWalletSig] = useState<string | null>(null);
  const [submitReceipt, setSubmitReceipt] = useState<string | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [audits, setAudits] = useState<Array<Record<string, unknown>>>([]);
  const [runningFw, setRunningFw] = useState(false);

  // Tab 5: MCP Tester
  const [mcpTool, setMcpTool] = useState("meridian_market_regime");
  const [mcpOut, setMcpOut] = useState<string>("");
  const [runningMcp, setRunningMcp] = useState(false);

  const apiHeaders = useMemo(() => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (sosoKey.trim()) h["X-Soso-Api-Key"] = sosoKey.trim();
    return h;
  }, [sosoKey]);

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    setErrorMsg(null);
    try {
      const [ovRes, thRes, audRes] = await Promise.all([
        apiFetch<MarketOverviewBundle>("/api/v1/overview", { headers: apiHeaders }),
        apiFetch<PublishedThesis[]>("/api/v1/theses").catch(
          (): ApiEnvelope<PublishedThesis[]> => ({ ok: true, data: [] })
        ),
        apiFetch<Array<Record<string, unknown>>>("/api/v1/firewall/audits").catch(
          (): ApiEnvelope<Array<Record<string, unknown>>> => ({ ok: true, data: [] })
        )
      ]);
      if (!ovRes.ok || !ovRes.data) throw new Error(ovRes.error || "Failed to load market overview");
      setOverview(ovRes.data);
      if (thRes.ok && thRes.data) setTheses(thRes.data);
      if (audRes.ok && audRes.data) setAudits(audRes.data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoadingOverview(false);
    }
  }, [apiHeaders]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleRunBacktest = useCallback(async () => {
    setRunningBacktest(true);
    try {
      const res = await apiFetch<BacktestResult>("/api/v1/backtest", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          basketName: "Meridian Adaptive SSI + RWA Basket",
          legs,
          rebalanceIntervalDays: rebalanceDays,
          feeBps: 10,
          persist: true
        })
      });
      if (res.ok && res.data) setBacktest(res.data);
      else setErrorMsg(res.error ?? "Backtest failed");
    } finally {
      setRunningBacktest(false);
    }
  }, [apiHeaders, legs, rebalanceDays]);

  useEffect(() => {
    if (tab === "ssi" && !backtest && !runningBacktest) {
      void handleRunBacktest();
    }
  }, [tab, backtest, runningBacktest, handleRunBacktest]);

  const loadOrderbook = useCallback(async (mkt: "spot" | "perps" | "wealth", sym: string) => {
    if (mkt === "wealth") {
      setOrderbook(null);
      return;
    }
    try {
      const r = await apiFetch<OrderbookSnapshot>(`/api/v1/orderbook/${mkt}/${encodeURIComponent(sym)}`);
      if (r.ok && r.data) setOrderbook(r.data);
    } catch {
      setOrderbook(null);
    }
  }, []);

  useEffect(() => {
    if (tab === "firewall") {
      void loadOrderbook(fwMarketType, fwSymbol);
    }
  }, [tab, fwMarketType, fwSymbol, loadOrderbook]);

  async function handleGenerateThesis() {
    setGeneratingThesis(true);
    setErrorMsg(null);
    try {
      const r = await apiFetch<PublishedThesis>("/api/v1/theses/generate", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ focus: thesisPrompt })
      });
      if (r.ok && r.data) {
        const created = r.data;
        setTheses((prev) => [created, ...prev]);
      } else {
        setErrorMsg(r.error ?? "Thesis generation failed");
      }
    } finally {
      setGeneratingThesis(false);
    }
  }

  async function handleRunFirewall(prepareEip712 = true) {
    setRunningFw(true);
    setWalletSig(null);
    setSubmitReceipt(null);
    setErrorMsg(null);
    try {
      const fwRes = await apiFetch<FirewallCheckResult>("/api/v1/firewall/check", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          marketType: fwMarketType,
          symbol: fwSymbol,
          side: fwSide,
          notionalUsd: fwNotionalUsd,
          portfolioTotalUsd: fwPortfolioUsd,
          existingAssetUsd: fwExistingUsd,
          maxSlippageBps: fwMaxSlippage,
          maxConcentrationPct: fwMaxConc
        })
      });

      if (!fwRes.ok || !fwRes.data) throw new Error(fwRes.error ?? "Firewall check failed");
      setFwResult(fwRes.data);

      if (prepareEip712 && fwMarketType !== "wealth") {
        setPreparedOrder(null);
        const refPx = fwRes.data.midPrice || 1;
        const qty = (fwNotionalUsd / Math.max(1e-9, refPx)).toPrecision(6);
        const prep = await apiFetch<Record<string, unknown>>("/api/v1/execution/prepare", {
          method: "POST",
          headers: apiHeaders,
          body: JSON.stringify({
            network: fwNetwork,
            marketType: fwMarketType,
            symbol: fwSymbol,
            side: fwSide,
            orderType: fwOrderType,
            price: fwOrderType === "LIMIT" ? String(refPx) : undefined,
            quantity: qty,
            accountID: fwAccountId,
            portfolioTotalUsd: fwPortfolioUsd,
            existingAssetUsd: fwExistingUsd,
            maxSlippageBps: fwMaxSlippage,
            maxConcentrationPct: fwMaxConc,
            simulateEphemeralSign: true
          })
        });
        if (prep.ok && prep.data) {
          setPreparedOrder(prep.data);
        } else {
          setPreparedOrder(null);
          setErrorMsg(prep.error ?? "Failed to prepare order payload");
        }
      } else {
        setPreparedOrder(null);
      }

      const audRes = await apiFetch<Array<Record<string, unknown>>>("/api/v1/firewall/audits").catch(() => null);
      if (audRes?.ok && audRes.data) setAudits(audRes.data);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Firewall check failed");
    } finally {
      setRunningFw(false);
    }
  }

  async function handleWalletSign() {
    const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
    if (!eth) {
      setErrorMsg("No browser EIP-1193 wallet detected. Ephemeral key signature is shown for format inspection only (not an authorized SoDEX account).");
      return;
    }
    if (!preparedOrder?.typedData) return;
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const addr = accounts[0];
      setWalletAddr(addr);
      const td = preparedOrder.typedData as { domain?: { chainId?: number } };
      const targetChainId = td.domain?.chainId ?? (fwNetwork === "mainnet" ? 286623 : 138565);
      const chainHex = `0x${targetChainId.toString(16)}`;
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      } catch (switchErr) {
        const code = (switchErr as { code?: number })?.code;
        if (code === 4902) {
          await eth.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: chainHex,
                chainName: targetChainId === 286623 ? "ValueChain Mainnet" : "ValueChain Testnet",
                nativeCurrency: { name: "SOSO", symbol: "SOSO", decimals: 18 },
                rpcUrls: [targetChainId === 286623 ? "https://mainnet.valuechain.xyz" : "https://testnet.valuechain.xyz"]
              }
            ]
          });
        } else {
          throw new Error(`Please switch your wallet to ValueChain (${targetChainId}) before signing.`);
        }
      }
      const rawSig = (await eth.request({
        method: "eth_signTypedData_v4",
        params: [addr, JSON.stringify(td)]
      })) as string;
      const vByte = Number.parseInt(rawSig.slice(-2), 16);
      const vNorm = (vByte >= 27 ? vByte - 27 : vByte).toString(16).padStart(2, "0");
      setWalletSig(`0x01${rawSig.slice(2, -2)}${vNorm}`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Wallet signature cancelled");
    }
  }

  async function handleSubmitSignedOrder() {
    if (!preparedOrder || preparedOrder.blocked || !walletSig) return;
    setSubmittingOrder(true);
    setSubmitReceipt(null);
    setErrorMsg(null);
    try {
      const res = await apiFetch<unknown>("/api/v1/execution/submit", {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          network: preparedOrder.network,
          marketType: fwMarketType,
          symbol: fwSymbol,
          side: fwSide,
          notionalUsd: fwNotionalUsd,
          portfolioTotalUsd: fwPortfolioUsd,
          existingAssetUsd: fwExistingUsd,
          httpBody: preparedOrder.httpBody,
          wireSignature: walletSig,
          nonce: preparedOrder.nonce
        })
      });
      if (!res.ok) throw new Error(res.error ?? "SoDEX order relay rejected");
      setSubmitReceipt(JSON.stringify(res.data, null, 2));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Order submission failed");
    } finally {
      setSubmittingOrder(false);
    }
  }

  async function handleRunMcp() {
    setRunningMcp(true);
    try {
      const args =
        mcpTool === "meridian_check_trade_firewall"
          ? { marketType: "spot", symbol: "vMAG7ssi_vUSDC", side: "BUY", notionalUsd: 500 }
          : {};
      const res = await fetch("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: mcpTool, arguments: args }
        })
      }).then((x) => x.json());
      setMcpOut(JSON.stringify(res, null, 2));
    } finally {
      setRunningMcp(false);
    }
  }

  const regimeColor =
    overview?.regime.label === "RISK_ON"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
      : overview?.regime.label === "DEFENSIVE"
        ? "bg-amber-500/15 text-amber-300 border-amber-500/40"
        : overview?.regime.label === "HIGH_VOL_CAUTION"
          ? "bg-rose-500/15 text-rose-300 border-rose-500/40"
          : "bg-cyan-500/15 text-cyan-300 border-cyan-500/40";

  return (
    <div className="min-h-screen flex flex-col bg-[#07090f] text-slate-100">
      {/* Top Institutional Status Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#090d16]/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Activity className="w-5 h-5 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white">MERIDIAN</h1>
                <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
                  One-Person Finance OS
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                SoSoValue OpenAPI · SoDEX Spot/Perps/Wealth · ValueChain & Base SSI
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {overview && (
              <>
                <span className={`px-2.5 py-1 rounded-full border font-mono font-semibold ${regimeColor}`}>
                  {overview.regime.label} · {overview.regime.confidence}%
                </span>
                <span className="px-2.5 py-1 rounded-full border border-slate-700/80 bg-slate-900/90 font-mono text-slate-300">
                  ValueChain #{overview.valueChainMainnetBlock.toLocaleString("en-US")}
                </span>
                <span
                  className={`px-2.5 py-1 rounded-full border font-mono ${
                    overview.sosoOpenApi.connected
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-slate-700 bg-slate-900 text-slate-300"
                  }`}
                >
                  SoSo OpenAPI: {overview.sosoOpenApi.connected ? "Connected" : "BYOK Ready"}
                </span>
              </>
            )}

            <button
              onClick={() => setShowKeyModal(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-700 hover:border-cyan-500/50 bg-slate-900 text-slate-200 transition"
            >
              <KeyRound className="w-3.5 h-3.5 text-cyan-400" />
              <span>API Key</span>
            </button>
            <button
              onClick={() => void loadOverview()}
              disabled={loadingOverview}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingOverview ? "animate-spin" : ""}`} />
              <span>Sync</span>
            </button>
          </div>
        </div>

        {/* 5-Stage Autonomous Workflow Navigation */}
        <div className="max-w-7xl mx-auto px-4 pb-2.5 flex items-center gap-1.5 overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition border ${
                  active
                    ? "bg-cyan-500/15 text-cyan-200 border-cyan-500/50 shadow-sm"
                    : "bg-slate-900/50 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700"
                }`}
              >
                <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">{t.step}</span>
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-5 space-y-5">
        {errorMsg && (
          <div className="p-3 rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-200 text-xs flex items-center justify-between">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {errorMsg}
            </span>
            <button onClick={() => setErrorMsg(null)} className="text-rose-300 underline ml-4">
              Dismiss
            </button>
          </div>
        )}

        {/* Provenance Strip */}
        {overview && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-slate-900/60 border border-slate-800/80 text-[11px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-400 font-medium">Live Sources:</span>
              {overview.provenanceList.map((src) => (
                <span key={src} className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono">
                  ● {src}
                </span>
              ))}
            </div>
            <span className="text-slate-500 font-mono">
              Spot {overview.spotTickers.length} · Perps {overview.perpsTickers.length} · Wealth {overview.wealthFunds.length}
            </span>
          </div>
        )}

        {/* TAB 1: RESEARCH & MACRO DESK */}
        {tab === "desk" && (
          <div className="space-y-5">
            {/* Top KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                <div className="text-[11px] text-slate-400 uppercase tracking-wider">Cross-Asset Regime</div>
                <div className="mt-1 text-xl font-bold text-cyan-300 font-mono">{overview?.regime.label ?? "LOADING"}</div>
                <div className="mt-1 text-xs text-slate-400">
                  Breadth {overview?.regime.breadthAdvancingPct ?? 0}% advancing
                </div>
              </div>
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                <div className="text-[11px] text-slate-400 uppercase tracking-wider">Crypto vs Token Equities</div>
                <div className="mt-1 text-xl font-bold font-mono">
                  <span className={(overview?.regime.avgCryptoChange24hPct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    {overview?.regime.avgCryptoChange24hPct ?? 0}%
                  </span>
                  <span className="text-slate-500 mx-1.5">/</span>
                  <span className={(overview?.regime.avgEquityTokenChange24hPct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    {overview?.regime.avgEquityTokenChange24hPct ?? 0}%
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-400">24h SoDEX Spot CLOB delta</div>
              </div>
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                <div className="text-[11px] text-slate-400 uppercase tracking-wider">Mean Perps Funding</div>
                <div className="mt-1 text-xl font-bold text-violet-300 font-mono">
                  {overview?.regime.avgPerpsFundingBps ?? 0} bps
                </div>
                <div className="mt-1 text-xs text-slate-400">Across top 20 SoDEX Perps</div>
              </div>
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                <div className="text-[11px] text-slate-400 uppercase tracking-wider">
                  {overview?.sosoOpenApi.connected ? "SoSoValue BTC ETF Flow" : "ValueChain Dual Finality"}
                </div>
                <div className="mt-1 text-xl font-bold text-amber-300 font-mono">
                  {overview?.sosoOpenApi.connected && overview.sosoOpenApi.etfNetInflowUsd !== null
                    ? fmtUsd(overview.sosoOpenApi.etfNetInflowUsd)
                    : `#${(overview?.valueChainMainnetBlock ?? 0).toLocaleString("en-US")}`}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {overview?.sosoOpenApi.connected
                    ? `Settled ${overview.sosoOpenApi.etfLatestDate}`
                    : `Testnet #${(overview?.valueChainTestnetBlock ?? 0).toLocaleString("en-US")}`}
                </div>
              </div>
            </div>

            {/* Regime Rationale + AI Grounded Thesis Generator */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-7 p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Bot className="w-4 h-4 text-cyan-400" />
                    Autonomous Research Agency — Publish Grounded Thesis
                  </h2>
                  <span className="text-[11px] font-mono text-slate-400">D1 Attested · SHA-256</span>
                </div>

                {overview && (
                  <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800 text-xs text-slate-300 space-y-1">
                    {overview.regime.rationale.map((line, i) => (
                      <div key={i}>• {line}</div>
                    ))}
                  </div>
                )}

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={thesisPrompt}
                    onChange={(e) => setThesisPrompt(e.target.value)}
                    placeholder="Mandate focus (e.g. MAG7.ssi + US Treasury carry barbell)..."
                    className="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    onClick={() => void handleGenerateThesis()}
                    disabled={generatingThesis}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition disabled:opacity-60"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>{generatingThesis ? "Synthesizing..." : "Generate & Publish"}</span>
                  </button>
                </div>

                {/* Published Theses Ledger */}
                <div className="space-y-3">
                  {theses.length === 0 && (
                    <div className="p-4 rounded-lg border border-dashed border-slate-800 text-xs text-slate-400 text-center">
                      Click <strong>Generate &amp; Publish</strong> to synthesize an AI thesis grounded in live SoDEX + ValueChain + Base SSI data and persist its SHA-256 receipt to Cloudflare D1.
                    </div>
                  )}
                  {theses.map((th) => (
                    <div key={th.id} className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-white">{th.title}</span>
                        <div className="flex items-center gap-2 text-[11px] font-mono">
                          <span className="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                            {th.direction} · {th.conviction}% conv
                          </span>
                          <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            Firewall: {th.firewallVerdict}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">{th.summary}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {th.allocation.map((a) => (
                          <span key={a.asset} className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px] font-mono text-slate-200">
                            {a.asset}: <strong>{a.weightPct}%</strong>
                          </span>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1 border-t border-slate-800/80">
                        {th.evidence.slice(0, 4).map((ev, idx) => (
                          <div key={idx} className="text-[11px] text-slate-400 flex justify-between gap-2">
                            <span>{ev.metric}:</span>
                            <span className="font-mono text-slate-200 truncate">{ev.value}</span>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                        <span>Model: {th.aiModel}</span>
                        <span>SHA256: {th.sha256Digest.slice(0, 18)}…</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: Live Catalyst Feed + Top Spot/Perps Markets */}
              <div className="lg:col-span-5 space-y-4">
                <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                  <h3 className="text-sm font-semibold text-white mb-3">Live Market Catalyst Feed</h3>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {(overview?.newsFeed ?? []).slice(0, 8).map((n) => (
                      <a
                        key={n.id}
                        href={n.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/90 hover:border-cyan-500/40 transition"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-xs text-slate-200 font-medium leading-snug">{n.title}</span>
                          <ArrowUpRight className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono">
                          <span className="text-slate-400">
                            {n.source} · {n.provenance}
                          </span>
                          <span
                            className={
                              n.sentiment === "BULLISH"
                                ? "text-emerald-400"
                                : n.sentiment === "BEARISH"
                                  ? "text-rose-400"
                                  : "text-slate-400"
                            }
                          >
                            {n.sentiment}
                          </span>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                  <h3 className="text-sm font-semibold text-white mb-2.5">Top SoDEX Spot &amp; Tokenized Assets</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-slate-500 border-b border-slate-800 text-[10px] uppercase">
                          <th className="text-left py-1.5">Pair</th>
                          <th className="text-right py-1.5">Last</th>
                          <th className="text-right py-1.5">24h</th>
                          <th className="text-right py-1.5">Spread</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(overview?.spotTickers ?? []).slice(0, 8).map((t) => (
                          <tr
                            key={t.symbol}
                            onClick={() => {
                              setFwMarketType("spot");
                              setFwSymbol(t.symbol);
                              setTab("firewall");
                            }}
                            className="border-b border-slate-800/50 hover:bg-slate-800/40 cursor-pointer"
                          >
                            <td className="py-1.5 text-slate-200">{t.symbol}</td>
                            <td className="py-1.5 text-right">${t.lastPx.toFixed(t.lastPx < 5 ? 4 : 2)}</td>
                            <td className={`py-1.5 text-right ${t.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              {t.changePct >= 0 ? "+" : ""}
                              {t.changePct.toFixed(2)}%
                            </td>
                            <td className="py-1.5 text-right text-slate-400">{t.spreadBps.toFixed(1)} bps</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: SSI INDEX PARITY & WALK-FORWARD BACKTEST LAB */}
        {tab === "ssi" && (
          <div className="space-y-5">
            {/* Cross-Venue SSI Parity */}
            <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Base Mainnet SSI Protocol vs SoDEX CLOB Parity Monitor
                  </h2>
                  <p className="text-xs text-slate-400">
                    Reads live ERC-20 totalSupply() from Base Mainnet (8453) &amp; Base DEX liquidity prices vs live SoDEX Spot orderbooks.
                  </p>
                </div>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-violet-500/10 border border-violet-500/30 text-violet-300">
                  Base Mainnet RPC + SoDEX CLOB
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-800 text-[10px] uppercase">
                      <th className="text-left py-2">SSI Token</th>
                      <th className="text-left py-2">Base Contract (8453)</th>
                      <th className="text-right py-2">On-Chain Supply</th>
                      <th className="text-right py-2">Base DEX Price</th>
                      <th className="text-right py-2">SoDEX CLOB</th>
                      <th className="text-right py-2">Basis (bps)</th>
                      <th className="text-right py-2">Signal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(overview?.ssiParity ?? []).map((row) => (
                      <tr key={row.symbol} className="border-b border-slate-800/60">
                        <td className="py-2 font-semibold text-white">{row.symbol}</td>
                        <td className="py-2 text-slate-400">
                          {row.baseAddress.slice(0, 8)}…{row.baseAddress.slice(-6)}
                        </td>
                        <td className="py-2 text-right text-slate-200">{row.baseTotalSupply.toLocaleString("en-US")}</td>
                        <td className="py-2 text-right">{row.baseDexPriceUsd ? `$${row.baseDexPriceUsd.toFixed(4)}` : "—"}</td>
                        <td className="py-2 text-right text-cyan-300">
                          {row.sodexPriceUsd ? `$${row.sodexPriceUsd.toFixed(4)}` : "Not Listed"}
                        </td>
                        <td className="py-2 text-right">
                          {row.premiumDiscountBps !== null ? `${row.premiumDiscountBps > 0 ? "+" : ""}${row.premiumDiscountBps} bps` : "—"}
                        </td>
                        <td className="py-2 text-right">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] ${
                              row.signal.startsWith("ARBITRAGE")
                                ? "bg-amber-500/15 text-amber-300 border border-amber-500/40"
                                : "bg-slate-800 text-slate-300"
                            }`}
                          >
                            {row.signal}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Adaptive Basket Builder + Backtest */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-4 p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3">
                <h3 className="text-sm font-semibold text-white">Adaptive Index Publisher</h3>
                <p className="text-xs text-slate-400">
                  Adjust target weights across SSI Spot tokens, tokenized US ETFs, and SoDEX Wealth RWA vaults. Rebalanced on real daily klines.
                </p>

                <div className="space-y-2.5">
                  {legs.map((leg, idx) => (
                    <div key={leg.symbol} className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="font-medium text-slate-200">
                          {leg.label} <span className="text-[10px] font-mono text-slate-500">({leg.source})</span>
                        </span>
                        <span className="font-mono text-cyan-300">{Math.round(leg.weight * 100)}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={80}
                        value={Math.round(leg.weight * 100)}
                        onChange={(e) => {
                          const v = Number(e.target.value) / 100;
                          setLegs((prev) => prev.map((x, i) => (i === idx ? { ...x, weight: v } : x)));
                        }}
                        className="w-full accent-cyan-400"
                      />
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between text-xs pt-1">
                  <label className="text-slate-400">Rebalance Cadence (days)</label>
                  <select
                    value={rebalanceDays}
                    onChange={(e) => setRebalanceDays(Number(e.target.value))}
                    className="px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-xs"
                  >
                    <option value={1}>Daily (1d)</option>
                    <option value={7}>Weekly (7d)</option>
                    <option value={14}>Biweekly (14d)</option>
                    <option value={30}>Monthly (30d)</option>
                  </select>
                </div>

                <button
                  onClick={() => void handleRunBacktest()}
                  disabled={runningBacktest}
                  className="w-full py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition"
                >
                  {runningBacktest ? "Running Walk-Forward Simulation..." : "Run Real Kline Backtest + Monte Carlo"}
                </button>
              </div>

              <div className="lg:col-span-8 space-y-4">
                {backtest && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                      <div className="text-[10px] text-slate-400 uppercase">Total Return ({backtest.daysAnalyzed}d)</div>
                      <div className={`text-lg font-bold font-mono ${backtest.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {backtest.totalReturnPct >= 0 ? "+" : ""}
                        {backtest.totalReturnPct.toFixed(2)}%
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        Alpha vs SSI: {backtest.alphaVsSsiPct >= 0 ? "+" : ""}
                        {backtest.alphaVsSsiPct.toFixed(2)}%
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                      <div className="text-[10px] text-slate-400 uppercase">Sharpe / Sortino</div>
                      <div className="text-lg font-bold font-mono text-cyan-300">
                        {backtest.annualizedSharpe.toFixed(2)} / {backtest.annualizedSortino.toFixed(2)}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">Win Rate {backtest.winRatePct.toFixed(1)}%</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                      <div className="text-[10px] text-slate-400 uppercase">Max Drawdown</div>
                      <div className="text-lg font-bold font-mono text-rose-400">{backtest.maxDrawdownPct.toFixed(2)}%</div>
                      <div className="text-[10px] text-slate-500 font-mono">Calmar {backtest.calmarRatio.toFixed(2)}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800">
                      <div className="text-[10px] text-slate-400 uppercase">30d MC VaR95 / CVaR99</div>
                      <div className="text-lg font-bold font-mono text-amber-300">
                        {backtest.mcVar95Pct.toFixed(1)}% / {backtest.mcCvar99Pct.toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono">500 Bootstrap Paths</div>
                    </div>
                  </div>
                )}
                <EquityCurveChart points={backtest?.equityCurve ?? []} />
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: WEALTH & PRE-IPO RWA DESK */}
        {tab === "wealth" && (
          <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-white">SoDEX Wealth RWA, Pre-IPO Vaults &amp; Tokenized ETFs</h2>
                <p className="text-xs text-slate-400">
                  Live NAV, AUM, APY, ValueChain share contracts, and real-time RFQ/CLOB channel availability.
                </p>
              </div>
              <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                GET /api/v1/wealth/funds + /markets + /trading-status
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-800 text-[10px] uppercase">
                    <th className="text-left py-2">Fund / Vault</th>
                    <th className="text-left py-2">Type</th>
                    <th className="text-right py-2">Price / NAV</th>
                    <th className="text-right py-2">AUM</th>
                    <th className="text-right py-2">7d APY</th>
                    <th className="text-right py-2">1M ROI</th>
                    <th className="text-left py-2 pl-3">Channel</th>
                    <th className="text-left py-2">ValueChain Share Token</th>
                    <th className="text-right py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview?.wealthFunds ?? []).map((f) => (
                    <tr key={f.fundId} className="border-b border-slate-800/60 hover:bg-slate-800/30">
                      <td className="py-2">
                        <div className="font-semibold text-white">{f.fundId}</div>
                        <div className="text-[10px] text-slate-400 font-sans">{f.name}</div>
                      </td>
                      <td className="py-2 text-slate-300">{f.fundType}</td>
                      <td className="py-2 text-right text-cyan-300">${f.price.toFixed(4)}</td>
                      <td className="py-2 text-right">{f.aum !== null ? fmtUsd(f.aum, 0) : "CLOB/Bridged"}</td>
                      <td className={`py-2 text-right ${(f.apy7d ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {f.apy7d !== null ? `${f.apy7d.toFixed(2)}%` : "—"}
                      </td>
                      <td className={`py-2 text-right ${(f.roi1M ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {f.roi1M !== null ? `${f.roi1M.toFixed(2)}%` : "—"}
                      </td>
                      <td className="py-2 pl-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] ${
                            f.channel.startsWith("closed")
                              ? "bg-rose-500/15 text-rose-300 border border-rose-500/30"
                              : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                          }`}
                        >
                          {f.channel}
                        </span>
                      </td>
                      <td className="py-2 text-slate-400">
                        {f.shareAddress ? `${f.shareAddress.slice(0, 8)}…${f.shareAddress.slice(-6)}` : "—"}
                      </td>
                      <td className="py-2 text-right">
                        <button
                          onClick={() => {
                            setFwMarketType("wealth");
                            setFwSymbol(f.fundId);
                            setTab("firewall");
                          }}
                          className="px-2.5 py-1 rounded bg-cyan-500/15 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-[11px]"
                        >
                          Audit Risk
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: PRE-TRADE RISK FIREWALL & EIP-712 EXECUTION */}
        {tab === "firewall" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Order Ticket + Controls */}
            <div className="lg:col-span-4 space-y-4">
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-cyan-400" />
                  Pre-Trade Risk Firewall Ticket
                </h2>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <label className="text-[10px] text-slate-400 uppercase">Venue Engine</label>
                    <select
                      value={fwMarketType}
                      onChange={(e) => {
                        const m = e.target.value as "spot" | "perps" | "wealth";
                        setFwMarketType(m);
                        if (m === "spot") setFwSymbol("vMAG7ssi_vUSDC");
                        if (m === "perps") setFwSymbol("BTC-USD");
                        if (m === "wealth") setFwSymbol("CXMT");
                      }}
                      className="mt-1 w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    >
                      <option value="spot">SoDEX Spot CLOB</option>
                      <option value="perps">SoDEX Perps CLOB</option>
                      <option value="wealth">SoDEX Wealth RWA</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400 uppercase">Network</label>
                    <select
                      value={fwNetwork}
                      onChange={(e) => setFwNetwork(e.target.value as "testnet" | "mainnet")}
                      className="mt-1 w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    >
                      <option value="testnet">Testnet (138565)</option>
                      <option value="mainnet">Mainnet (286623)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-slate-400 uppercase">Instrument Symbol</label>
                  <select
                    value={fwSymbol}
                    onChange={(e) => setFwSymbol(e.target.value)}
                    className="mt-1 w-full px-2.5 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono text-xs"
                  >
                    {fwMarketType === "spot" &&
                      (overview?.spotTickers ?? []).map((t) => (
                        <option key={t.symbol} value={t.symbol}>
                          {t.symbol} (${t.lastPx})
                        </option>
                      ))}
                    {fwMarketType === "perps" &&
                      (overview?.perpsTickers ?? []).slice(0, 30).map((t) => (
                        <option key={t.symbol} value={t.symbol}>
                          {t.symbol} (${t.markPx})
                        </option>
                      ))}
                    {fwMarketType === "wealth" &&
                      (overview?.wealthFunds ?? []).map((f) => (
                        <option key={f.fundId} value={f.fundId}>
                          {f.fundId} (${f.price.toFixed(2)})
                        </option>
                      ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    onClick={() => setFwSide("BUY")}
                    className={`py-1.5 rounded font-semibold border ${
                      fwSide === "BUY"
                        ? "bg-emerald-500/20 border-emerald-500 text-emerald-300"
                        : "bg-slate-950 border-slate-700 text-slate-400"
                    }`}
                  >
                    BUY / LONG
                  </button>
                  <button
                    onClick={() => setFwSide("SELL")}
                    className={`py-1.5 rounded font-semibold border ${
                      fwSide === "SELL"
                        ? "bg-rose-500/20 border-rose-500 text-rose-300"
                        : "bg-slate-950 border-slate-700 text-slate-400"
                    }`}
                  >
                    SELL / REDEEM
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <label className="text-[10px] text-slate-400">Size (USD)</label>
                    <input
                      type="number"
                      value={fwNotionalUsd}
                      onChange={(e) => setFwNotionalUsd(Number(e.target.value))}
                      className="mt-1 w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400">Max Slip (bps)</label>
                    <input
                      type="number"
                      value={fwMaxSlippage}
                      onChange={(e) => setFwMaxSlippage(Number(e.target.value))}
                      className="mt-1 w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400">Max Conc (%)</label>
                    <input
                      type="number"
                      value={fwMaxConc}
                      onChange={(e) => setFwMaxConc(Number(e.target.value))}
                      className="mt-1 w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <label className="text-[10px] text-slate-400">Portfolio ($)</label>
                    <input
                      type="number"
                      value={fwPortfolioUsd}
                      onChange={(e) => setFwPortfolioUsd(Number(e.target.value))}
                      className="mt-1 w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400">Existing Pos ($)</label>
                    <input
                      type="number"
                      value={fwExistingUsd}
                      onChange={(e) => setFwExistingUsd(Number(e.target.value))}
                      className="mt-1 w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-400">Account ID</label>
                    <input
                      type="number"
                      value={fwAccountId}
                      onChange={(e) => setFwAccountId(Number(e.target.value))}
                      className="mt-1 w-full px-2 py-1.5 rounded bg-slate-950 border border-slate-700 font-mono"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Order Type</span>
                  <select
                    value={fwOrderType}
                    onChange={(e) => setFwOrderType(e.target.value as "LIMIT" | "MARKET")}
                    className="px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono"
                  >
                    <option value="LIMIT">LIMIT (GTC)</option>
                    <option value="MARKET">MARKET (IOC)</option>
                  </select>
                </div>

                <button
                  onClick={() => void handleRunFirewall(true)}
                  disabled={runningFw}
                  className="w-full py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition"
                >
                  {runningFw ? "Inspecting L2 Book & Signing..." : "Run Risk Firewall & Build EIP-712"}
                </button>
              </div>

              <OrderbookDepthLadder book={orderbook} />
            </div>

            {/* Firewall Scorecard + EIP-712 Payload */}
            <div className="lg:col-span-8 space-y-4">
              {!fwResult && (
                <div className="p-8 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 text-center space-y-2">
                  <ShieldCheck className="w-8 h-8 text-cyan-400 mx-auto" />
                  <h3 className="text-sm font-semibold text-white">Pre-Trade Risk Gate &amp; Non-Custodial Signer</h3>
                  <p className="text-xs text-slate-400 max-w-md mx-auto">
                    Test any order size against live SoDEX L2 depth. Try $450 (likely APPROVE) vs $25,000 (automatic BLOCK with safe sizing).
                  </p>
                </div>
              )}

              {fwResult && (
                <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      {fwResult.verdict === "APPROVE" ? (
                        <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                      ) : fwResult.verdict === "CAUTION" ? (
                        <AlertTriangle className="w-6 h-6 text-amber-400" />
                      ) : (
                        <Lock className="w-6 h-6 text-rose-400" />
                      )}
                      <div>
                        <div className="text-base font-bold font-mono text-white">
                          VERDICT: {fwResult.verdict} (Risk Score {fwResult.riskScore}/100)
                        </div>
                        <div className="text-xs text-slate-400">
                          Est. VWAP ${fwResult.estimatedFillPrice.toFixed(4)} · Slippage {fwResult.slippageBps} bps · Safe Max ${fwResult.recommendedMaxUsd.toLocaleString("en-US")}
                        </div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-slate-400">Audit SHA256: {fwResult.sha256Digest.slice(0, 16)}…</span>
                  </div>

                  <div className="space-y-2">
                    {fwResult.checks.map((chk) => (
                      <div key={chk.name} className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div>
                          <span className="font-semibold text-slate-200">{chk.name}</span>
                          <p className="text-[11px] text-slate-400">{chk.detail}</p>
                        </div>
                        <div className="text-right font-mono">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] ${
                              chk.status === "PASS"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : chk.status === "WARN"
                                  ? "bg-amber-500/15 text-amber-300"
                                  : "bg-rose-500/15 text-rose-300"
                            }`}
                          >
                            {chk.status}
                          </span>
                          <div className="text-[11px] text-slate-300 mt-1">{chk.observed}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {preparedOrder && (
                <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-cyan-400" />
                      SoDEX Go-Struct Exact EIP-712 ExchangeAction
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void handleWalletSign()}
                        disabled={Boolean(preparedOrder.blocked)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500 hover:bg-violet-400 text-white text-xs font-semibold disabled:opacity-40 transition"
                      >
                        <Wallet className="w-3.5 h-3.5" />
                        <span>{preparedOrder.blocked ? "Blocked by Firewall" : "Sign with Browser Wallet"}</span>
                      </button>
                      {walletSig && !preparedOrder.blocked && (
                        <button
                          onClick={() => void handleSubmitSignedOrder()}
                          disabled={submittingOrder}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold disabled:opacity-40 transition"
                        >
                          <span>{submittingOrder ? "Submitting..." : `Submit to SoDEX ${String(preparedOrder.network)}`}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {preparedOrder.blocked ? (
                    <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/40 text-xs text-rose-200 font-mono">
                      FAIL-CLOSED: Pre-Trade Risk Firewall returned BLOCK — signable EIP-712 payload withheld. Reduce order size to ≤ ${fwResult?.recommendedMaxUsd.toFixed(2) ?? "0"}.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] font-mono">
                      <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 overflow-x-auto">
                        <div className="text-slate-400 mb-1">Canonical Go-Order JSON &amp; Keccak256</div>
                        <div className="text-cyan-300 break-all mb-2">{String(preparedOrder.payloadHash)}</div>
                        <pre className="text-slate-300 whitespace-pre-wrap break-all">{String(preparedOrder.canonicalJson)}</pre>
                      </div>
                      <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 overflow-x-auto">
                        <div className="text-slate-400 mb-1">
                          {walletSig ? `Wallet Signed (${walletAddr?.slice(0, 10)}…)` : "Ephemeral Format-Preview Signature (Not for Live Relay)"}
                        </div>
                        <div className="text-emerald-300 break-all mb-2">
                          {walletSig || String((preparedOrder.demoSigned as { wireSignature?: string })?.wireSignature || "")}
                        </div>
                        <div className="text-slate-400">Target Endpoint:</div>
                        <div className="text-slate-300 break-all">{String(preparedOrder.endpoint)}</div>
                        {submitReceipt && (
                          <pre className="mt-2 p-2 rounded bg-emerald-950/50 border border-emerald-500/30 text-emerald-200 whitespace-pre-wrap">
                            {submitReceipt}
                          </pre>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {audits.length > 0 && (
                <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800">
                  <h3 className="text-xs font-semibold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
                    <Database className="w-3.5 h-3.5" />
                    Recent D1 Attested Firewall Audits
                  </h3>
                  <div className="space-y-1.5 text-xs font-mono">
                    {audits.slice(0, 5).map((a) => (
                      <div key={String(a.id)} className="flex justify-between items-center py-1 border-b border-slate-800/60 text-[11px]">
                        <span className="text-slate-200">
                          {String(a.symbol)} · {String(a.side)} ${Number(a.notional_usd).toFixed(0)}
                        </span>
                        <span className={a.verdict === "APPROVE" ? "text-emerald-400" : a.verdict === "CAUTION" ? "text-amber-400" : "text-rose-400"}>
                          {String(a.verdict)} ({Number(a.slippage_bps).toFixed(1)} bps)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 5: CLIENT API, MCP SERVER & ONE-PERSON BUSINESS DISTRIBUTION */}
        {tab === "api" && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-6 p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3">
              <h2 className="text-sm font-semibold text-white">Live Model Context Protocol (MCP) Endpoint</h2>
              <p className="text-xs text-slate-400">
                External AI agents, Claude Desktop, Cursor, or client bots connect directly to <code className="text-cyan-300">/mcp</code> via JSON-RPC 2.0 to query regime reads, SSI parity, backtests, and Pre-Trade Firewall verdicts.
              </p>

              <div className="flex gap-2">
                <select
                  value={mcpTool}
                  onChange={(e) => setMcpTool(e.target.value)}
                  className="flex-1 px-2.5 py-2 rounded-lg bg-slate-950 border border-slate-700 font-mono text-xs"
                >
                  <option value="meridian_market_regime">meridian_market_regime</option>
                  <option value="meridian_sosovalue_macro">meridian_sosovalue_macro</option>
                  <option value="meridian_check_trade_firewall">meridian_check_trade_firewall</option>
                  <option value="meridian_ssi_parity">meridian_ssi_parity</option>
                  <option value="meridian_wealth_opportunities">meridian_wealth_opportunities</option>
                  <option value="meridian_backtest_basket">meridian_backtest_basket</option>
                </select>
                <button
                  onClick={() => void handleRunMcp()}
                  disabled={runningMcp}
                  className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition"
                >
                  {runningMcp ? "Calling..." : "Call POST /mcp"}
                </button>
              </div>

              <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 max-h-96 overflow-auto">
                {mcpOut || "// Click 'Call POST /mcp' to execute a live JSON-RPC 2.0 tool call against SoDEX & ValueChain."}
              </pre>
            </div>

            <div className="lg:col-span-6 space-y-4">
              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2.5">
                <h3 className="text-sm font-semibold text-white">Client REST API &amp; OpenAPI 3.0.3 Catalog</h3>
                <div className="space-y-1.5 text-xs font-mono">
                  {[
                    ["GET /api/v1/overview", "Cross-asset regime, Spot/Perps/Wealth, Base SSI parity & news"],
                    ["POST /api/v1/theses/generate", "AI-grounded thesis synthesis persisted with SHA-256"],
                    ["POST /api/v1/backtest", "Walk-forward kline backtest + 500-path Monte Carlo VaR/CVaR"],
                    ["POST /api/v1/firewall/check", "L2 depth slippage & concentration gate (APPROVE/BLOCK)"],
                    ["POST /api/v1/execution/prepare", "SoDEX Go-struct EIP-712 ExchangeAction payload builder"],
                    ["GET /api/v1/openapi.json", "Machine-readable OpenAPI 3.0.3 schema"]
                  ].map(([ep, desc]) => (
                    <div key={ep} className="p-2 rounded bg-slate-950/80 border border-slate-800">
                      <div className="text-cyan-300">{ep}</div>
                      <div className="text-[11px] text-slate-400 font-sans">{desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2">
                <h3 className="text-sm font-semibold text-white">Standalone Terminal CLI</h3>
                <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-emerald-300 overflow-x-auto">{`npx tsx bin/meridian.ts regime
npx tsx bin/meridian.ts ssi
npx tsx bin/meridian.ts firewall vMAG7ssi_vUSDC BUY 500
npx tsx bin/meridian.ts backtest`}</pre>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* SoSoValue API Key BYOK Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="max-w-md w-full p-5 rounded-2xl bg-slate-900 border border-slate-700 space-y-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-cyan-400" />
              Connect SoSoValue OpenAPI Key (Optional BYOK)
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Meridian runs live out of the box via SoDEX Spot/Perps/Wealth + ValueChain RPC + Base SSI On-Chain feeds. Add an optional <code className="text-cyan-300">x-soso-api-key</code> to also unlock SoSoValue OpenAPI v1/v3 ETF net-flows, FOMC probabilities, and curated Hot News.
            </p>
            <input
              type="password"
              value={sosoKey}
              onChange={(e) => setSosoKey(e.target.value)}
              placeholder="Paste x-soso-api-key..."
              className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-slate-100"
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => {
                  sessionStorage.removeItem("meridian_soso_key");
                  setSosoKey("");
                  setShowKeyModal(false);
                }}
                className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300"
              >
                Clear
              </button>
              <button
                onClick={() => {
                  if (sosoKey.trim()) sessionStorage.setItem("meridian_soso_key", sosoKey.trim());
                  setShowKeyModal(false);
                  void loadOverview();
                }}
                className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs"
              >
                Save &amp; Sync
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
