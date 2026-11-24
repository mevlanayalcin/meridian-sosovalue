# Meridian — Autonomous One-Person On-Chain Finance Business OS

[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](LICENSE)
[![Built for SoSoValue Wave 3](https://img.shields.io/badge/SoSoValue-Wave%203-blue.svg)](https://app.akindo.io/wave-hacks/JBEQXgN4Zi2jA3wA)

**Meridian** is a production-deployed, end-to-end "One-Person On-Chain Finance Business" terminal and agentic API platform built on **SoSoValue OpenAPI v1/v3**, **SoDEX (Spot CLOB + Perps CLOB + Wealth RWA API)**, **ValueChain EVM RPC**, and **Base Mainnet SSI Protocol contracts**.

A single operator can function simultaneously as a **financial research agency**, **SSI/thematic index publisher**, **risk-gated execution fund manager**, and **B2B/agent API provider** — all from one unified Cloudflare Workers + D1 SQLite edge deployment.

---

## Live Deployment & Verification

- **Live HTTPS Application:** `https://meridian.bedir-ai.workers.dev`
- **Live MCP JSON-RPC Endpoint:** `POST https://meridian.bedir-ai.workers.dev/mcp`
- **OpenAPI 3.0.3 Schema:** `https://meridian.bedir-ai.workers.dev/api/v1/openapi.json`
- **Health Check:** `https://meridian.bedir-ai.workers.dev/health`
- **Pitch Deck:** [docs/PITCH_DECK.md](docs/PITCH_DECK.md)

---

## Architecture

```
Live Data Plane (Zero Mocks · Explicit Provenance Badges)
├── SoSoValue OpenAPI v1/v3 (ETF Net-Flows, Indices, News/Hot, Macro/FOMC, v3 Equities/Perps)
├── SoDEX Spot CLOB (46 pairs incl. vMAG7ssi_vUSDC, vMEMEssi_vUSDC, vQQQ_vUSDC, vBOXX_vUSDC)
├── SoDEX Perps CLOB (100 contracts incl. BTC-USD, NVDA-USD, BRENTOIL-USD, SILVER-USD)
├── SoDEX Wealth API (11 RWA/Pre-IPO/Yield vaults: CXMT, UNITREE, Morpho-Earn, tokenized ETFs)
├── ValueChain Mainnet (286623) & Testnet (138565) JSON-RPC
└── Base Mainnet (8453) SSI Protocol Contracts (MAG7.ssi, MEME.ssi, DEFI.ssi, USSI)
        │
        ▼
Edge Compute Engine (Cloudflare Workers + Hono + D1 SQLite)
├── Cross-Asset Regime Classifier (src/engine/quant.ts)
├── Walk-Forward Rebalanced Backtester & 500-Path Bootstrap Monte Carlo VaR95/CVaR99
├── Pre-Trade L2 Orderbook Risk Firewall (src/engine/firewall.ts)
├── Protocol-Exact Go-Struct EIP-712 ExchangeAction Signer (src/engine/sodex-eip712.ts)
└── Evidence-Grounded AI Research Analyst (src/engine/ai-analyst.ts)
        │
        ▼
Distribution Surfaces (One-Person Business Output)
├── React 19 + Vite Institutional 5-Stage Terminal (src/client/App.tsx)
├── Model Context Protocol JSON-RPC 2.0 Server (POST /mcp)
├── Public REST & OpenAPI 3.0.3 Endpoints (/api/v1/*)
└── Standalone Terminal CLI (bin/meridian.ts)
```

---

## Core Modules

1. **Research & Macro Agency (`src/worker/overview.ts`, `src/engine/ai-analyst.ts`)**
   - Detects cross-asset market regimes (`RISK_ON`, `ROTATION`, `DEFENSIVE`, `HIGH_VOL_CAUTION`) across crypto spot, tokenized US equities, perps funding, and RWA vault yields.
   - Generates investment theses strictly grounded in live telemetry and persists them to Cloudflare D1 SQLite with SHA-256 content digests.
   - Full `SoSoValueClient` (`src/providers/sosovalue.ts`) supports server-configured `SOSOVALUE_API_KEY` and interactive BYOK (`X-Soso-Api-Key` header in the UI Settings modal).

2. **SSI Parity Monitor & Adaptive Index Publisher (`src/providers/onchain.ts`, `src/engine/quant.ts`)**
   - Queries Base Mainnet (`eth_call` `totalSupply()`) for `MAG7.ssi`, `MEME.ssi`, `DEFI.ssi`, and `USSI` alongside Base DEX liquidity prices and SoDEX Spot CLOB orderbooks to compute real-time cross-venue parity spreads in bps.
   - Interactive basket builder runs walk-forward rebalanced backtests (real SoDEX Spot klines + Wealth price history) with transaction fee modeling, Sharpe, Sortino, Calmar, Max Drawdown, benchmark alpha vs `vMAG7ssi_vUSDC` & `vBTC_vUSDC`, and 500-path deterministic bootstrap Monte Carlo VaR(95%)/CVaR(99%).

3. **SoDEX Wealth & Pre-IPO RWA Desk (`src/providers/sodex.ts`)**
   - Tracks all live Wealth RWA vaults (`CXMT`, `UNITREE`), `Morpho-Earn` bridged yield, and tokenized ETFs (`vBOXX`, `vQQQ`, `vSCHD`, `vSMH`, `vSTRC`, `vVGT`, `vVOO`, `vVYM`) with NAV, AUM, 7d APY, 1M ROI, ValueChain share token addresses, and real-time RFQ/CLOB channel status.

4. **Pre-Trade Risk Firewall & EIP-712 Execution (`src/engine/firewall.ts`, `src/engine/sodex-eip712.ts`)**
   - Walks live L2 orderbooks before every trade to compute exact VWAP fill price, slippage bps, bid-ask spread bps, intraday volatility relative to leverage, portfolio concentration cap, and venue channel readiness (`APPROVE` | `CAUTION` | `BLOCK`), saving SHA-256 audit receipts to D1.
   - Serializes Spot `batchNewOrder` and Perps `newOrder` in exact `sodex-go-sdk-public` Go struct field order, computes `payloadHash = keccak256(compactJson)`, and produces `0x01`-prefixed `ExchangeAction` EIP-712 typed signatures for both ValueChain Mainnet (`286623`) and Testnet (`138565`).

5. **Client API, MCP Server & CLI (`src/worker/mcp.ts`, `bin/meridian.ts`)**
   - Exposes 5 live MCP tools (`meridian_market_regime`, `meridian_check_trade_firewall`, `meridian_ssi_parity`, `meridian_wealth_opportunities`, `meridian_backtest_basket`) via `POST /mcp` for Claude Desktop, Cursor, or autonomous trading agents.

---

## Local Setup & Verification

### Prerequisites
- Node.js >= 20
- npm >= 10

### Install, Typecheck, Test & Build
```bash
npm install
npm run typecheck
npm test
npm run build
```

### Run Standalone CLI
```bash
npx tsx bin/meridian.ts regime
npx tsx bin/meridian.ts ssi
npx tsx bin/meridian.ts firewall vMAG7ssi_vUSDC BUY 450
npx tsx bin/meridian.ts backtest
```

### Local Edge Dev Server
```bash
npx wrangler dev
```

### Environment Variables / Secrets (Optional)
- `SOSOVALUE_API_KEY`: SoSoValue OpenAPI `x-soso-api-key` (or supply per-session via UI **API Key** modal)
- `NVIDIA_API_KEY`: NVIDIA NIM endpoint key for AI thesis synthesis
- `TAVILY_API_KEY`: Tavily news search enrichment key

---

## Wave 3 Progress Summary
- Built complete Cloudflare Workers + D1 + React 19 full-stack edge architecture from scratch.
- Integrated SoSoValue OpenAPI v1/v3 client, SoDEX Spot/Perps/Wealth APIs (including newly launched Wealth RWA vaults), ValueChain Mainnet/Testnet JSON-RPC, and Base Mainnet SSI Protocol `eth_call` telemetry.
- Implemented protocol-exact SoDEX Go-struct EIP-712 serialization & signature verification, L2 orderbook Pre-Trade Risk Firewall, Walk-Forward + Monte Carlo Backtest Lab, live JSON-RPC MCP server, and standalone CLI.
