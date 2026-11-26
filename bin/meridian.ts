#!/usr/bin/env tsx
import { buildMarketOverview } from "../src/worker/overview";
import { SoDexClient } from "../src/providers/sodex";
import { runFirewallWithLiveData } from "../src/engine/live-firewall";
import { runBasketBacktest } from "../src/engine/quant";

async function main() {
  const [, , cmd = "regime", arg1, arg2, arg3] = process.argv;

  if (cmd === "regime" || cmd === "ssi") {
    const bundle = await buildMarketOverview({
      sosoApiKey: process.env.SOSOVALUE_API_KEY,
      keyOrigin: process.env.SOSOVALUE_API_KEY ? "server_env" : "none",
      tavilyApiKey: process.env.TAVILY_API_KEY
    });
    if (cmd === "ssi") {
      console.log(JSON.stringify({ valueChainMainnetBlock: bundle.valueChainMainnetBlock, ssiParity: bundle.ssiParity }, null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        {
          timestamp: bundle.timestamp,
          valueChainMainnetBlock: bundle.valueChainMainnetBlock,
          regime: bundle.regime,
          topSpot: bundle.spotTickers.slice(0, 5),
          wealthCount: bundle.wealthFunds.length
        },
        null,
        2
      )
    );
    return;
  }

  if (cmd === "firewall") {
    const symbol = arg1 || "vMAG7ssi_vUSDC";
    const side = (arg2?.toUpperCase() === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
    const notionalUsd = Number.parseFloat(arg3 || "2500");
    const marketType = symbol.includes("-") ? "perps" : symbol.includes("_") ? "spot" : "wealth";
    const result = await runFirewallWithLiveData({ marketType, symbol, side, notionalUsd });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "backtest") {
    const sodex = new SoDexClient();
    const legs = [
      { symbol: "vMAG7ssi_vUSDC", source: "spot" as const, weight: 0.4, label: "MAG7.ssi" },
      { symbol: "vQQQ_vUSDC", source: "spot" as const, weight: 0.35, label: "vQQQ" },
      { symbol: "UNITREE", source: "wealth" as const, weight: 0.25, label: "Unitree RWA" }
    ];
    const [mag7, qqq, unitree, btc] = await Promise.all([
      sodex.getKlines("spot", "vMAG7ssi_vUSDC", "1d", 60),
      sodex.getKlines("spot", "vQQQ_vUSDC", "1d", 60),
      sodex.getWealthPriceHistory("UNITREE", "3M"),
      sodex.getKlines("spot", "vBTC_vUSDC", "1d", 60)
    ]);
    const res = runBasketBacktest(
      "Meridian CLI Flagship Basket",
      legs,
      {
        vMAG7ssi_vUSDC: { points: mag7, source: "SoDEX Spot CLOB" },
        vQQQ_vUSDC: { points: qqq, source: "SoDEX Spot CLOB" },
        UNITREE: { points: unitree, source: "SoDEX Wealth API" }
      },
      mag7,
      btc
    );
    console.log(JSON.stringify({ ...res, equityCurve: `[${res.equityCurve.length} points]` }, null, 2));
    return;
  }

  console.error("Usage: meridian <regime|ssi|firewall <symbol> <BUY|SELL> <usd>|backtest>");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
