import { sha256Hex } from "../providers/http";
import type { FirewallCheckRequest, FirewallCheckResult, OrderbookLevel, OrderbookSnapshot } from "../shared/types";

export interface FirewallContext {
  orderbook: OrderbookSnapshot | null;
  intradayVolPct: number;
  venueChannelStatus: string;
  referencePrice: number;
}

/**
 * Walks one side of an L2 orderbook to estimate the volume-weighted fill price
 * and maximum executable notional within a target slippage cap.
 */
export function simulateBookFill(
  levels: OrderbookLevel[],
  notionalUsd: number,
  midPrice: number,
  side: "BUY" | "SELL",
  maxSlippageBps: number
): { vwapPrice: number; slippageBps: number; filledUsd: number; maxSafeUsd: number } {
  if (!levels.length || midPrice <= 0) {
    return { vwapPrice: midPrice, slippageBps: 9999, filledUsd: 0, maxSafeUsd: 0 };
  }

  let remainingUsd = notionalUsd;
  let totalCostUsd = 0;
  let totalBaseQty = 0;
  let maxSafeUsd = 0;

  for (const lvl of levels) {
    const levelSlippageBps =
      side === "BUY" ? ((lvl.price - midPrice) / midPrice) * 10_000 : ((midPrice - lvl.price) / midPrice) * 10_000;
    if (levelSlippageBps <= maxSlippageBps) {
      maxSafeUsd += lvl.notionalUsd;
    }
    if (remainingUsd <= 0) continue;
    const takeUsd = Math.min(remainingUsd, lvl.notionalUsd);
    totalCostUsd += takeUsd;
    totalBaseQty += takeUsd / lvl.price;
    remainingUsd -= takeUsd;
  }

  if (totalBaseQty <= 0) {
    return { vwapPrice: midPrice, slippageBps: 9999, filledUsd: 0, maxSafeUsd };
  }

  const vwapPrice = totalCostUsd / totalBaseQty;
  const rawSlippageBps =
    side === "BUY" ? ((vwapPrice - midPrice) / midPrice) * 10_000 : ((midPrice - vwapPrice) / midPrice) * 10_000;

  // Penalize unfilled remainder if book depth was exhausted
  const depthShortfall = remainingUsd > 0 ? 500 + (remainingUsd / notionalUsd) * 1500 : 0;

  return {
    vwapPrice: Number(vwapPrice.toFixed(6)),
    slippageBps: Number(Math.max(0, rawSlippageBps + depthShortfall).toFixed(2)),
    filledUsd: Number(totalCostUsd.toFixed(2)),
    maxSafeUsd: Number(maxSafeUsd.toFixed(2))
  };
}

/**
 * Deterministic Pre-Trade Risk Firewall evaluating live L2 depth, spread,
 * realized intraday volatility, post-trade concentration, and venue session state.
 */
export async function evaluateTradeFirewall(
  req: FirewallCheckRequest,
  ctx: FirewallContext
): Promise<FirewallCheckResult> {
  const maxSlippageBps = req.maxSlippageBps ?? 60;
  const maxConcentrationPct = req.maxConcentrationPct ?? 35;
  const portfolioTotal = Math.max(req.portfolioTotalUsd ?? 10_000, req.notionalUsd);
  const existingAssetUsd = req.existingAssetUsd ?? 0;

  const postTradeUsd = req.side === "BUY" ? existingAssetUsd + req.notionalUsd : Math.max(0, existingAssetUsd - req.notionalUsd);
  const postTradeConcentrationPct = Number(((postTradeUsd / portfolioTotal) * 100).toFixed(2));

  const book = ctx.orderbook;
  const midPrice = book && book.midPrice > 0 ? book.midPrice : ctx.referencePrice;
  const spreadBps = book ? book.spreadBps : req.marketType === "wealth" ? 12 : 9999;

  const sim =
    book && req.marketType !== "wealth"
      ? simulateBookFill(req.side === "BUY" ? book.asks : book.bids, req.notionalUsd, midPrice, req.side, maxSlippageBps)
      : {
          vwapPrice: midPrice,
          slippageBps: req.marketType === "wealth" ? 10 : 9999,
          filledUsd: req.notionalUsd,
          maxSafeUsd: req.marketType === "wealth" ? 25_000 : 0
        };

  const checks: FirewallCheckResult["checks"] = [];
  let riskScore = 0;

  // 1. Venue channel availability
  const channelClosed = ctx.venueChannelStatus.startsWith("closed") || ctx.venueChannelStatus === "HALT";
  checks.push({
    name: "Venue Session & Channel",
    status: channelClosed ? "FAIL" : "PASS",
    observed: ctx.venueChannelStatus,
    threshold: "open / rfq / clob / trading",
    detail: channelClosed
      ? "Market channel is currently closed or halted; order execution must wait for active session."
      : "Target venue execution channel is live and accepting orders."
  });
  if (channelClosed) riskScore += 45;

  // 2. Orderbook slippage & depth sufficiency
  const slipStatus = sim.slippageBps > maxSlippageBps * 2 || sim.filledUsd < req.notionalUsd * 0.99 ? "FAIL" : sim.slippageBps > maxSlippageBps ? "WARN" : "PASS";
  checks.push({
    name: "L2 Depth & Execution Slippage",
    status: slipStatus,
    observed: `${sim.slippageBps.toFixed(1)} bps ($${sim.filledUsd.toFixed(0)}/${req.notionalUsd.toFixed(0)} filled)`,
    threshold: `<= ${maxSlippageBps} bps`,
    detail:
      slipStatus === "FAIL"
        ? `Order exceeds live L2 depth within ${maxSlippageBps} bps; safe max size is $${sim.maxSafeUsd.toFixed(0)}.`
        : slipStatus === "WARN"
          ? `Elevated price impact (${sim.slippageBps.toFixed(1)} bps); consider splitting into TWAP slices.`
          : `Sufficient L2 depth at VWAP $${sim.vwapPrice.toFixed(4)}.`
  });
  if (slipStatus === "FAIL") riskScore += 40;
  else if (slipStatus === "WARN") riskScore += 20;

  // 3. Bid-ask spread guard
  const spreadStatus = spreadBps > 120 ? "FAIL" : spreadBps > 45 ? "WARN" : "PASS";
  checks.push({
    name: "Top-of-Book Bid/Ask Spread",
    status: spreadStatus,
    observed: `${spreadBps.toFixed(1)} bps`,
    threshold: "<= 45 bps optimal / 120 bps hard cap",
    detail:
      spreadStatus === "FAIL"
        ? "Spread exceeds 120 bps hard ceiling; use resting limit orders rather than market taker."
        : spreadStatus === "WARN"
          ? "Moderately wide spread; post-only GTC limit recommended."
          : "Tight institutional spread on SoDEX CLOB."
  });
  if (spreadStatus === "FAIL") riskScore += 25;
  else if (spreadStatus === "WARN") riskScore += 10;

  // 4. Intraday volatility & leverage guard
  const leverage = req.leverage ?? 1;
  const volAdjustedThreshold = leverage > 3 ? 6 : 12;
  const volStatus = ctx.intradayVolPct > volAdjustedThreshold * 1.5 ? "FAIL" : ctx.intradayVolPct > volAdjustedThreshold ? "WARN" : "PASS";
  checks.push({
    name: "24h Volatility & Leverage Regime",
    status: volStatus,
    observed: `${ctx.intradayVolPct.toFixed(2)}% range (${leverage}x lev)`,
    threshold: `<= ${volAdjustedThreshold}% intraday range`,
    detail:
      volStatus === "FAIL"
        ? "Extreme intraday swing relative to leverage; high stop-out risk."
        : "Volatility sits within acceptable portfolio risk budget."
  });
  if (volStatus === "FAIL") riskScore += 25;
  else if (volStatus === "WARN") riskScore += 12;

  // 5. Portfolio single-asset concentration cap
  const concStatus =
    req.side === "BUY" && postTradeConcentrationPct > maxConcentrationPct * 1.3
      ? "FAIL"
      : req.side === "BUY" && postTradeConcentrationPct > maxConcentrationPct
        ? "WARN"
        : "PASS";
  checks.push({
    name: "Portfolio Concentration Cap",
    status: concStatus,
    observed: `${postTradeConcentrationPct.toFixed(1)}% post-trade`,
    threshold: `<= ${maxConcentrationPct}% max single asset`,
    detail:
      concStatus === "FAIL"
        ? "Trade breaches single-asset risk concentration limit."
        : "Position remains diversified within mandate."
  });
  if (concStatus === "FAIL") riskScore += 25;
  else if (concStatus === "WARN") riskScore += 12;

  riskScore = Math.min(100, riskScore);
  const hasFail = checks.some((c) => c.status === "FAIL");
  const hasWarn = checks.some((c) => c.status === "WARN");
  const verdict: FirewallCheckResult["verdict"] = hasFail || riskScore >= 55 ? "BLOCK" : hasWarn || riskScore >= 25 ? "CAUTION" : "APPROVE";

  const concentrationMaxUsd = Math.max(0, (maxConcentrationPct / 100) * portfolioTotal - existingAssetUsd);
  const recommendedMaxUsd =
    req.marketType === "wealth"
      ? Number(Math.min(req.notionalUsd, concentrationMaxUsd || req.notionalUsd).toFixed(2))
      : Number(Math.max(0, Math.min(sim.maxSafeUsd, req.side === "BUY" ? concentrationMaxUsd || sim.maxSafeUsd : sim.maxSafeUsd)).toFixed(2));

  const id = `fw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = new Date().toISOString();
  const sha256Digest = await sha256Hex(
    JSON.stringify({ id, createdAt, symbol: req.symbol, side: req.side, notionalUsd: req.notionalUsd, verdict, riskScore, checks })
  );

  return {
    id,
    createdAt,
    verdict,
    riskScore,
    symbol: req.symbol,
    marketType: req.marketType,
    side: req.side,
    requestedNotionalUsd: req.notionalUsd,
    recommendedMaxUsd,
    estimatedFillPrice: sim.vwapPrice,
    midPrice: Number(midPrice.toFixed(6)),
    slippageBps: sim.slippageBps,
    spreadBps,
    intradayVolPct: Number(ctx.intradayVolPct.toFixed(2)),
    postTradeConcentrationPct,
    bookImbalance: book ? book.imbalanceRatio : 0,
    venueChannelStatus: ctx.venueChannelStatus,
    checks,
    sha256Digest,
    source: req.marketType === "wealth" ? "SoDEX Wealth API" : req.marketType === "perps" ? "SoDEX Perps CLOB" : "SoDEX Spot CLOB"
  };
}
