# Meridian — Pitch Deck (SoSoValue Wave 3)

## Slide 1 — Title
**Meridian**  
*The Autonomous One-Person On-Chain Finance Business OS*  
Powered by SoSoValue OpenAPI v1/v3 · SoDEX Spot/Perps/Wealth · ValueChain · Base SSI Protocol  
Live App: `https://meridian.bedir-ai.workers.dev` · Public Repo: `https://github.com/mevlanayalcin/meridian-sosovalue`

## Slide 2 — The Problem
Running a financial news agency, index publisher, and asset manager normally requires a research team, quant backtester, risk desk, and execution infrastructure. Meanwhile, crypto AI bots often:
1. Hallucinate market claims without verifiable evidence or timestamps.
2. Ignore live L2 orderbook liquidity and blow up on slippage or closed session channels.
3. Keep signals locked in a UI instead of distributing them to other agents and clients.

## Slide 3 — The Meridian Solution (End-to-End One-Person Business)
1. **Autonomous Research Agency**: Aggregates live SoDEX Spot (46 pairs), Perps (100 contracts), Wealth RWA vaults (`CXMT`, `UNITREE`, `Morpho-Earn`, tokenized ETFs), ValueChain finality, Base SSI on-chain state, and SoSoValue OpenAPI v1/v3 (with BYOK + server key support) into SHA-256 attested investment theses.
2. **SSI Index Publisher & Quant Lab**: Audits cross-venue `MAG7.ssi` / `MEME.ssi` / `DEFI.ssi` / `USSI` parity between Base Mainnet (8453) and SoDEX CLOB, and runs walk-forward rebalanced backtests + 500-path bootstrap Monte Carlo VaR(95%)/CVaR(99%) on real daily klines.
3. **Pre-Trade Risk Firewall**: Walks live L2 orderbooks before every trade to compute exact VWAP fill, slippage bps, bid-ask spread, intraday volatility, portfolio concentration, and Wealth channel status (`APPROVE` / `CAUTION` / `BLOCK`).
4. **Protocol-Exact EIP-712 Execution**: Serializes Spot `batchNewOrder` and Perps `newOrder` in exact Go-struct field order (`sodex-go-sdk-public`) to generate deterministic `ExchangeAction{payloadHash, nonce}` signatures for ValueChain Mainnet (`286623`) and Testnet (`138565`).
5. **Client Distribution Layer**: Exposes every capability via live **Model Context Protocol (`POST /mcp`)**, OpenAPI 3.0.3 REST endpoints, Cloudflare D1 audit logs, and standalone CLI (`bin/meridian.ts`).

## Slide 4 — Architecture
```
[SoDEX Spot/Perps/Wealth] + [ValueChain RPC] + [Base SSI RPC] + [SoSoValue OpenAPI v1/v3]
                                      │
                       [Cloudflare Worker Edge Engine (Hono)]
          ┌───────────────────────────┼───────────────────────────┐
   Quant & Regime               Pre-Trade Risk             AI Thesis Analyst
  Walk-Forward + MC           L2 Depth + Slippage       NVIDIA NIM + Evidence SHA256
          └───────────────────────────┼───────────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
  React 19 Quant UI           Cloudflare D1 SQLite      MCP JSON-RPC + OpenAPI + CLI
```

## Slide 5 — Judging Rubric Alignment
- **User Value (30%)**: Single operator runs research, custom index publishing, risk gating, and agent distribution from one terminal.
- **Working Demo (25%)**: Always-on global edge HTTPS deployment with live data, zero mocks, and BYOK SoSoValue OpenAPI support.
- **Logic & Risk Control (20%)**: Deterministic 5-check Pre-Trade Firewall + SHA-256 thesis/audit ledger + walk-forward backtester.
- **Data Integration (15%)**: SoSoValue v1/v3 + SoDEX Spot/Perps/Wealth + ValueChain JSON-RPC + Base SSI `eth_call`.
- **UX & Clarity (10%)**: 5-step guided institutional terminal with real-time L2 depth ladder and interactive equity curve.
