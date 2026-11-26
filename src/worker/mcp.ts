import { SoDexClient } from "../providers/sodex";
import { parseFomcNextProbabilities, SoSoValueClient } from "../providers/sosovalue";
import { computeSsiParity } from "../providers/onchain";
import { detectMarketRegime, runBasketBacktest } from "../engine/quant";
import { runFirewallWithLiveData } from "../engine/live-firewall";
import type { BasketLeg } from "../shared/types";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const MCP_TOOLS = [
  {
    name: "meridian_market_regime",
    description:
      "Compute live cross-asset crypto, tokenized US equity, and RWA market regime across SoDEX Spot, Perps, Wealth, and SoSoValue ETF flows (when key configured).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "meridian_sosovalue_macro",
    description:
      "Query live SoSoValue OpenAPI v1 BTC Spot ETF net flows, FOMC probabilities, and index registry using server or request x-soso-api-key.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "ETF asset symbol, e.g. BTC or ETH" }
      }
    }
  },
  {
    name: "meridian_check_trade_firewall",
    description:
      "Evaluate pre-trade risk (L2 orderbook slippage bps, spread bps, volatility, concentration) and return APPROVE/CAUTION/BLOCK.",
    inputSchema: {
      type: "object",
      properties: {
        marketType: { type: "string", enum: ["spot", "perps", "wealth"] },
        symbol: { type: "string", description: "e.g. vMAG7ssi_vUSDC, BTC-USD, CXMT" },
        side: { type: "string", enum: ["BUY", "SELL"] },
        notionalUsd: { type: "number" },
        portfolioTotalUsd: { type: "number" },
        existingAssetUsd: { type: "number" },
        maxSlippageBps: { type: "number" }
      },
      required: ["symbol", "side", "notionalUsd"]
    }
  },
  {
    name: "meridian_ssi_parity",
    description:
      "Inspect Base mainnet SSI Protocol on-chain token supply (8-decimal native) & DEX prices vs SoDEX CLOB prices to detect parity spreads.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "meridian_wealth_opportunities",
    description: "List live SoDEX Wealth RWA vaults (CXMT, UNITREE, Morpho-Earn, tokenized ETFs) with NAV, AUM, APY, and channel status.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "meridian_backtest_basket",
    description: "Run a periodic-rebalanced historical backtest & 500-path bootstrap Monte Carlo VaR/CVaR stress test across SoDEX Spot and Wealth assets.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        legs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              source: { type: "string", enum: ["spot", "wealth"] },
              weight: { type: "number" }
            },
            required: ["symbol", "source", "weight"]
          }
        }
      }
    }
  }
];

export async function handleMcpRequest(reqBody: JsonRpcRequest, opts?: { sosoApiKey?: string }) {
  // Per JSON-RPC 2.0 & MCP spec, notifications (no id, e.g. notifications/initialized) return no error payload
  if (reqBody.method.startsWith("notifications/") || (reqBody.method === "initialized" && reqBody.id === undefined)) {
    return null;
  }

  const id = reqBody.id ?? null;
  const sodex = new SoDexClient();

  if (reqBody.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "meridian-finance-mcp", version: "1.1.0" },
        capabilities: { tools: {} }
      }
    };
  }

  if (reqBody.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (reqBody.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }

  if (reqBody.method === "tools/call") {
    const params = reqBody.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments as Record<string, unknown>) ?? {};

    let payload: unknown;
    if (name === "meridian_market_regime") {
      const [spot, perps, wealth] = await Promise.all([
        sodex.getSpotTickers(),
        sodex.getPerpsTickers(),
        sodex.getWealthFunds()
      ]);
      let etfNetInflowUsd: number | null = null;
      if (opts?.sosoApiKey) {
        const soso = new SoSoValueClient(opts.sosoApiKey);
        const hist = await soso.getEtfSummaryHistory("BTC", "US", 3).catch(() => []);
        etfNetInflowUsd = hist[0]?.total_net_inflow ?? null;
      }
      payload = detectMarketRegime(spot, perps, wealth, { etfNetInflowUsd });
    } else if (name === "meridian_sosovalue_macro") {
      if (!opts?.sosoApiKey) {
        payload = {
          connected: false,
          error: "Pass x-soso-api-key HTTP header (or configure server SOSOVALUE_API_KEY) to query live SoSoValue OpenAPI v1 ETF/FOMC feeds."
        };
      } else {
        const soso = new SoSoValueClient(opts.sosoApiKey);
        const sym = String(args.symbol ?? "BTC").toUpperCase();
        const [overview, etfHistory, indices, fomc] = await Promise.all([
          soso.getMarketOverview().catch(() => null),
          soso.getEtfSummaryHistory(sym, "US", 5).catch(() => []),
          soso.getIndices().catch(() => []),
          soso.getFomcProbabilities().catch(() => null)
        ]);
        payload = {
          connected: true,
          symbol: sym,
          overview,
          etfHistory,
          indices,
          fomcParsed: parseFomcNextProbabilities(fomc),
          fomc
        };
      }
    } else if (name === "meridian_ssi_parity") {
      const spot = await sodex.getSpotTickers();
      const map = Object.fromEntries(spot.map((s) => [s.symbol, { lastPx: s.lastPx, spreadBps: s.spreadBps }]));
      payload = await computeSsiParity(map);
    } else if (name === "meridian_wealth_opportunities") {
      payload = await sodex.getWealthFunds();
    } else if (name === "meridian_check_trade_firewall") {
      const marketType = (args.marketType as "spot" | "perps" | "wealth") ?? "spot";
      const symbol = String(args.symbol ?? "vMAG7ssi_vUSDC");
      const side = (String(args.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
      const notionalUsd = Number(args.notionalUsd ?? 1000);
      // Reuse the exact shared live firewall path (checks live HALT symbol status, L2 depth, volatility & caps)
      payload = await runFirewallWithLiveData({
        marketType,
        symbol,
        side,
        notionalUsd,
        portfolioTotalUsd: args.portfolioTotalUsd !== undefined ? Number(args.portfolioTotalUsd) : undefined,
        existingAssetUsd: args.existingAssetUsd !== undefined ? Number(args.existingAssetUsd) : undefined,
        maxSlippageBps: Number(args.maxSlippageBps ?? 60)
      });
    } else if (name === "meridian_backtest_basket") {
      const legs: BasketLeg[] = Array.isArray(args.legs)
        ? (args.legs as BasketLeg[])
        : [
            { symbol: "vMAG7ssi_vUSDC", source: "spot", weight: 0.45, label: "MAG7.ssi" },
            { symbol: "vQQQ_vUSDC", source: "spot", weight: 0.3, label: "vQQQ" },
            { symbol: "UNITREE", source: "wealth", weight: 0.25, label: "Unitree RWA" }
          ];
      const [seriesArr, ssiBench, btcBench] = await Promise.all([
        Promise.all(
          legs.map(async (l) => ({
            sym: l.symbol,
            points: l.source === "wealth" ? await sodex.getWealthPriceHistory(l.symbol, "3M") : await sodex.getKlines("spot", l.symbol, "1d", 60),
            source: l.source === "wealth" ? ("SoDEX Wealth API" as const) : ("SoDEX Spot CLOB" as const)
          }))
        ),
        sodex.getKlines("spot", "vMAG7ssi_vUSDC", "1d", 60),
        sodex.getKlines("spot", "vBTC_vUSDC", "1d", 60)
      ]);
      const seriesMap = Object.fromEntries(seriesArr.map((x) => [x.sym, { points: x.points, source: x.source }]));
      payload = runBasketBacktest(String(args.name ?? "Meridian MCP Basket"), legs, seriesMap, ssiBench, btcBench);
    } else {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown MCP tool: ${name}` } };
    }

    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
      }
    };
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported MCP method: ${reqBody.method}` } };
}
