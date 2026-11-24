import { SoDexClient } from "../providers/sodex";
import { computeSsiParity } from "../providers/onchain";
import { detectMarketRegime, runBasketBacktest } from "../engine/quant";
import { evaluateTradeFirewall } from "../engine/firewall";
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
      "Compute live cross-asset crypto, tokenized US equity, and RWA market regime across SoDEX Spot, Perps, and Wealth.",
    inputSchema: { type: "object", properties: {} }
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
        maxSlippageBps: { type: "number" }
      },
      required: ["symbol", "side", "notionalUsd"]
    }
  },
  {
    name: "meridian_ssi_parity",
    description:
      "Inspect Base mainnet SSI Protocol on-chain token supply & DEX prices vs SoDEX CLOB prices to detect parity spreads.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "meridian_wealth_opportunities",
    description: "List live SoDEX Wealth RWA vaults (CXMT, UNITREE, Morpho-Earn, tokenized ETFs) with NAV, AUM, APY, and channel status.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "meridian_backtest_basket",
    description: "Run a walk-forward historical backtest & Monte Carlo VaR/CVaR stress test across SoDEX Spot and Wealth assets.",
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

export async function handleMcpRequest(reqBody: JsonRpcRequest) {
  const id = reqBody.id ?? null;
  const sodex = new SoDexClient();

  if (reqBody.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "meridian-finance-mcp", version: "1.0.0" },
        capabilities: { tools: {} }
      }
    };
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
      payload = detectMarketRegime(spot, perps, wealth);
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
      const book = marketType === "wealth" ? null : await sodex.getOrderbook(marketType, symbol, 50).catch(() => null);
      let refPx = book?.midPrice ?? 0;
      let volPct = 3.5;
      let channel = "clob";
      if (marketType === "wealth") {
        const funds = await sodex.getWealthFunds();
        const f = funds.find((x) => x.fundId === symbol);
        refPx = f?.price ?? 1;
        channel = f?.channel ?? "unknown";
      } else {
        const ticks = marketType === "spot" ? await sodex.getSpotTickers() : await sodex.getPerpsTickers();
        const t = ticks.find((x) => x.symbol === symbol);
        if (t && t.lastPx > 0) {
          refPx = t.lastPx;
          volPct = ((t.highPx - t.lowPx) / t.lastPx) * 100;
        }
      }
      payload = await evaluateTradeFirewall(
        { marketType, symbol, side, notionalUsd, maxSlippageBps: Number(args.maxSlippageBps ?? 60) },
        { orderbook: book, intradayVolPct: volPct, venueChannelStatus: channel, referencePrice: refPx }
      );
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
