import { sha256Hex } from "../providers/http";
import type { FirewallCheckRequest, FirewallCheckResult, OrderbookLevel, OrderbookSnapshot } from "../shared/types";

export interface FirewallContext {
  orderbook: OrderbookSnapshot | null;
  intradayVolPct: number;
  venueChannelStatus: string;
  referencePrice: number;
  assetFound?: boolean;
  limitPrice?: number;
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
  const portfolioTotal = Math.max(req.portfolioTotalUsd ?? 10_000, 1);
  const existingAssetUsd = Math.max(0, req.existingAssetUsd ?? 0);

  const postTradeUsd = req.side === "BUY" ? existingAssetUsd + req.notionalUsd : Math.max(0, existingAssetUsd - req.notionalUsd);
  const effectivePortfolio = Math.max(portfolioTotal, postTradeUsd);
  const postTradeConcentrationPct = Number(((postTradeUsd / effectivePortfolio) * 100).toFixed(2));

  const assetMissing =
    ctx.assetFound === false ||
    ctx.venueChannelStatus === "unknown" ||
    ctx.venueChannelStatus === "not_found" ||
    (ctx.referencePrice <= 0 && (!ctx.orderbook || ctx.orderbook.midPrice <= 0));

  const book = ctx.orderbook;
  const midPrice = book && book.midPrice > 0 ? book.midPrice : ctx.referencePrice;
  const isWealthModel = req.marketType === "wealth";
  const spreadBps = assetMissing ? 9999 : book ? book.spreadBps : isWealthModel ? 12 : 9999;

  const sim =
    assetMissing
      ? { vwapPrice: 0, slippageBps: 9999, filledUsd: 0, maxSafeUsd: 0 }
      : book && !isWealthModel
        ? simulateBookFill(req.side === "BUY" ? book.asks : book.bids, req.notionalUsd, midPrice, req.side, maxSlippageBps)
        : {
            vwapPrice: midPrice,
            slippageBps: isWealthModel ? 10 : 9999,
            filledUsd: isWealthModel ? req.notionalUsd : 0,
            maxSafeUsd: isWealthModel ? 25_000 : 0
          };

  const checks: FirewallCheckResult["checks"] = [];
  let riskScore = 0;

  // 1. Venue channel & symbol existence
  const statusNorm = (ctx.venueChannelStatus || "").toLowerCase();
  const channelClosed =
    assetMissing ||
    statusNorm.startsWith("closed") ||
    statusNorm === "halt" ||
    statusNorm === "halted" ||
    statusNorm === "suspended" ||
    statusNorm === "paused" ||
    statusNorm === "inactive" ||
    statusNorm === "delisted";
  checks.push({
    name: "Venue Session & Asset Registry",
    status: channelClosed ? "FAIL" : "PASS",
    observed: assetMissing ? "asset_not_found" : ctx.venueChannelStatus,
    threshold: "listed & open / rfq / clob / trading",
    detail: assetMissing
      ? `Symbol or vault "${req.symbol}" was not found on target ${req.marketType} venue.`
      : channelClosed
        ? `Market channel (${ctx.venueChannelStatus}) is currently closed or halted; order execution is blocked.`
        : "Target venue execution channel is live and accepting orders."
  });
  if (channelClosed) riskScore += 55;

  // 1b. Limit price deviation collar (prevents off-market limit orders bypassing notional/slippage controls)
  if (!assetMissing && ctx.limitPrice !== undefined && Number.isFinite(ctx.limitPrice) && ctx.limitPrice > 0 && midPrice > 0) {
    const devPct = (Math.abs(ctx.limitPrice - midPrice) / midPrice) * 100;
    const collarFail = devPct > 15;
    const collarWarn = !collarFail && devPct > 5;
    checks.push({
      name: "Limit Price Collar vs Live Mid",
      status: collarFail ? "FAIL" : collarWarn ? "WARN" : "PASS",
      observed: `$${ctx.limitPrice.toFixed(4)} vs mid $${midPrice.toFixed(4)} (${devPct.toFixed(1)}% off-market)`,
      threshold: "<= 15.0% hard collar (5.0% warn)",
      detail: collarFail
        ? `Limit price deviates ${devPct.toFixed(1)}% from live mid price; blocked to prevent fat-finger or notional bypass.`
        : collarWarn
          ? `Limit price is ${devPct.toFixed(1)}% away from live mid; verify intentional resting placement.`
          : "Limit price is tightly aligned with live orderbook mid."
    });
    if (collarFail) riskScore += 55;
    else if (collarWarn) riskScore += 15;
  }

  // 2. Orderbook slippage, depth sufficiency & Wealth size cap
  const wealthOversized = isWealthModel && !assetMissing && req.notionalUsd > sim.maxSafeUsd;
  const slipStatus =
    assetMissing || wealthOversized || sim.slippageBps > maxSlippageBps * 2 || sim.filledUsd < req.notionalUsd * 0.99
      ? "FAIL"
      : sim.slippageBps > maxSlippageBps
        ? "WARN"
        : "PASS";
  checks.push({
    name: isWealthModel ? "Vault Liquidity & Size Cap (Modeled)" : "L2 Depth & Execution Slippage",
    status: slipStatus,
    observed: isWealthModel
      ? `$${req.notionalUsd.toFixed(0)} vs $${sim.maxSafeUsd.toFixed(0)} max single-clip (~${sim.slippageBps.toFixed(1)} bps est.)`
      : `${sim.slippageBps.toFixed(1)} bps ($${sim.filledUsd.toFixed(0)}/${req.notionalUsd.toFixed(0)} filled)`,
    threshold: isWealthModel ? `<= $${sim.maxSafeUsd.toFixed(0)} single-clip / ${maxSlippageBps} bps` : `<= ${maxSlippageBps} bps`,
    detail:
      wealthOversized
        ? `Wealth order $${req.notionalUsd.toFixed(0)} exceeds modeled single-clip cap ($${sim.maxSafeUsd.toFixed(0)}); split into staged tranches.`
        : slipStatus === "FAIL"
          ? `Order exceeds available depth within ${maxSlippageBps} bps; safe max size is $${sim.maxSafeUsd.toFixed(0)}.`
          : slipStatus === "WARN"
            ? `Elevated price impact (${sim.slippageBps.toFixed(1)} bps); consider splitting into TWAP slices.`
            : isWealthModel
              ? `Modeled vault NAV execution estimate at $${sim.vwapPrice.toFixed(4)} within $${sim.maxSafeUsd.toFixed(0)} single-clip cap.`
              : `Sufficient L2 depth at VWAP $${sim.vwapPrice.toFixed(4)}.`
  });
  if (slipStatus === "FAIL") riskScore += 45;
  else if (slipStatus === "WARN") riskScore += 20;

  // 3. Bid-ask spread guard
  const spreadStatus = spreadBps > 120 ? "FAIL" : spreadBps > 45 ? "WARN" : "PASS";
  checks.push({
    name: isWealthModel ? "Vault Spread (Modeled Estimate)" : "Top-of-Book Bid/Ask Spread",
    status: spreadStatus,
    observed: isWealthModel && !assetMissing ? `~${spreadBps.toFixed(1)} bps modeled estimate` : `${spreadBps.toFixed(1)} bps`,
    threshold: "<= 45 bps optimal / 120 bps hard cap",
    detail:
      spreadStatus === "FAIL"
        ? "Spread exceeds 120 bps hard ceiling; use resting limit orders rather than market taker."
        : spreadStatus === "WARN"
          ? "Moderately wide spread; post-only GTC limit recommended."
          : isWealthModel
            ? "Modeled vault spread within mandate threshold."
            : "Tight institutional spread on SoDEX CLOB."
  });
  if (spreadStatus === "FAIL") riskScore += 25;
  else if (spreadStatus === "WARN") riskScore += 10;

  // 4. Intraday volatility & leverage guard
  const leverage = req.leverage ?? 1;
  const volAdjustedThreshold = leverage > 3 ? 6 : 12;
  const volStatus = ctx.intradayVolPct > volAdjustedThreshold * 1.5 ? "FAIL" : ctx.intradayVolPct > volAdjustedThreshold ? "WARN" : "PASS";
  checks.push({
    name: isWealthModel ? "Volatility Regime (Vault Category Est.)" : "24h Volatility & Leverage Regime",
    status: volStatus,
    observed: `${ctx.intradayVolPct.toFixed(2)}% ${isWealthModel ? "est. category" : "observed"} range (${leverage}x lev)`,
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
    observed: `${postTradeConcentrationPct.toFixed(1)}% post-trade ($${postTradeUsd.toFixed(0)} / $${effectivePortfolio.toFixed(0)})`,
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

  // Strictly respect 0 headroom when existing position already hits/exceeds cap (no `0 || x` bug)
  const concentrationMaxUsd = Math.max(0, (maxConcentrationPct / 100) * portfolioTotal - existingAssetUsd);
  const buyCapUsd = req.side === "BUY" ? concentrationMaxUsd : Number.POSITIVE_INFINITY;
  const recommendedMaxUsd = assetMissing || channelClosed
    ? 0
    : isWealthModel
      ? Number(Math.max(0, Math.min(req.notionalUsd, sim.maxSafeUsd, buyCapUsd)).toFixed(2))
      : Number(Math.max(0, Math.min(sim.maxSafeUsd, buyCapUsd)).toFixed(2));

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
    bookImbalance: book?.imbalanceRatio ?? 0,
    venueChannelStatus: ctx.venueChannelStatus,
    checks,
    sha256Digest,
    source:
      req.marketType === "spot"
        ? "SoDEX Spot CLOB"
        : req.marketType === "perps"
          ? "SoDEX Perps CLOB"
          : "SoDEX Wealth API"
  };
}
