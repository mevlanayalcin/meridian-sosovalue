# Akindo Wave 3 Submission Pack — Meridian (SoSoValue Buildathon)

## 1. Project Overview
- **Project Name:** Meridian
- **Short Tagline:** Autonomous One-Person On-Chain Finance OS: Research Agency, SSI Index Publisher & Pre-Trade Risk Firewall on SoSoValue + SoDEX + ValueChain.
- **Target Users:** Solo quant researchers, independent crypto/RWA fund operators, SSI index arbitrageurs, and external AI trading agents consuming verified signals via REST/MCP.
- **Public GitHub Repository:** https://github.com/mevlanayalcin/meridian-sosovalue
- **Live HTTPS Demo:** https://meridian.bedir-ai.workers.dev
- **Live MCP Endpoint:** `POST https://meridian.bedir-ai.workers.dev/mcp`
- **OpenAPI 3.0.3 Schema:** https://meridian.bedir-ai.workers.dev/api/v1/openapi.json

## 2. Core Logic, APIs & Data Sources
Meridian enables a single operator to run an institutional research agency, index publisher, and risk-gated execution desk end-to-end:
1. **SoSoValue OpenAPI (`src/providers/sosovalue.ts`)**: Integrated across ETF net-flow history (`/etfs/summary-history`), SSI indices (`/indices`), Macro FOMC probabilities (`/macro/fomc-probabilities`), Hot News (`/news/hot`), and Market Overview (`/market/overview`), actively overlaid onto cross-asset regime classification (`src/engine/quant.ts`) and exposed via the `meridian_sosovalue_macro` MCP tool. Supports both server secrets and interactive browser-session BYOK (`X-Soso-Api-Key`).
2. **SoDEX Spot CLOB + Perps CLOB + Wealth RWA API (`src/providers/sodex.ts`)**: Streams live orderbooks, tickers, and daily klines across 46 Spot pairs (including `vMAG7ssi_vUSDC`, `vMEMEssi_vUSDC`, `vQQQ_vUSDC`, `vBOXX_vUSDC`), 100 Perps contracts (`BTC-USD`, `NVDA-USD`, `BRENTOIL-USD`), and all 11 SoDEX Wealth RWA/Pre-IPO/Yield vaults (`CXMT`, `UNITREE`, `Morpho-Earn`, tokenized ETFs).
3. **ValueChain (`286623`/`138565`) & Base Mainnet (`8453`) On-Chain RPC (`src/providers/onchain.ts`)**: Reads live ValueChain block finality and Base Mainnet SSI Protocol `decimals()` + `totalSupply()` (`MAG7.ssi`, `MEME.ssi`, `DEFI.ssi`, `USSI`) to audit cross-venue parity spreads.
4. **Walk-Forward Quant & Monte Carlo Lab (`src/engine/quant.ts`)**: Runs rebalanced historical backtests on real SoDEX Spot klines & Wealth NAV histories (explicitly dropping insufficient-history legs) with taker fee modeling (`10 bps`), computing Sharpe, Sortino, Max Drawdown, Calmar, benchmark alpha vs `vMAG7ssi_vUSDC`, and 500-path deterministic bootstrap Monte Carlo VaR(95%)/CVaR(99%).
5. **Fail-Closed Pre-Trade L2 Risk Firewall & Protocol-Exact EIP-712 Signer (`src/engine/firewall.ts`, `src/engine/sodex-eip712.ts`)**: Walks live L2 orderbooks to compute VWAP fill, slippage bps, spread bps, volatility regime, portfolio concentration, and Wealth channel status (`APPROVE` | `CAUTION` | `BLOCK`), persisting SHA-256 audit receipts to Cloudflare D1. Refuses payload generation on `BLOCK` or unknown instruments, re-validates live firewall state on `/api/v1/execution/submit`, rounds to live `tickSize`/`stepSize`, and serializes Go-struct-ordered SoDEX `ExchangeAction` EIP-712 payloads with MetaMask `EIP712Domain` parity.
6. **B2B / Agent Distribution & Scheduled Autonomy (`src/worker/mcp.ts`, `src/worker/index.ts`, `bin/meridian.ts`)**: Exposes 6 live Model Context Protocol (`POST /mcp`, MCP 2024-11-05 compliant) tools, REST OpenAPI endpoints, 6-hour Cloudflare Cron autonomous thesis persistence, and a standalone CLI (`npx tsx bin/meridian.ts`).

## 3. Team & Contact
- **Builder:** Mevlana Yalcin (Solo Engineer)
- **Contact Email:** info@mevlanayalcin.com.tr
- **EVM Payout Address:** `0xFf135CeD375351ACBB2e8b6F32C96ccDB2a10161`
- **GitHub:** https://github.com/mevlanayalcin

## 4. Wave 3 Progress Update / Changelog
- Built and deployed full-stack Cloudflare Workers + D1 SQLite + React 19 production terminal (`https://meridian.bedir-ai.workers.dev`) with scheduled 6h Cron thesis generation.
- Added live SoDEX Wealth RWA & Pre-IPO vault intelligence (`CXMT`, `UNITREE`, `Morpho-Earn`) with APY anomaly sanitization (`[-25%, 40%]`) and cross-venue Base SSI parity detection using atomic Multicall3 ERC-20 `decimals()` + `totalSupply()`.
- Implemented fail-closed L2 orderbook Pre-Trade Risk Firewall (with 15% Limit Price Collar, live `HALT` checks, Wealth size caps, and signed `httpBody` server-side re-verification), Go-struct-exact SoDEX EIP-712 signing with MetaMask `EIP712Domain` parity and trailing-zero-free `tickSize`/`stepSize` rounding, periodic-rebalanced + Monte Carlo backtest engine, and 6-tool JSON-RPC MCP server (`19/19` unit/integration tests passing).
