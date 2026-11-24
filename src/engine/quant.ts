import type { DailySeriesPoint } from "../providers/sodex";
import type { BacktestPoint, BacktestResult, BasketLeg, MarketRegime, PerpsTicker, ProvenanceSource, SpotTicker, WealthFund } from "../shared/types";

export function detectMarketRegime(
  spot: SpotTicker[],
  perps: PerpsTicker[],
  wealth: WealthFund[]
): {
  label: MarketRegime;
  confidence: number;
  breadthAdvancingPct: number;
  avgCryptoChange24hPct: number;
  avgEquityTokenChange24hPct: number;
  avgRwaApyPct: number;
  avgPerpsFundingBps: number;
  rationale: string[];
} {
  const activeSpot = spot.filter((s) => s.lastPx > 0);
  const advancing = activeSpot.filter((s) => s.changePct > 0).length;
  const breadthAdvancingPct = activeSpot.length > 0 ? (advancing / activeSpot.length) * 100 : 50;

  const equitySet = new Set(["vQQQ_vUSDC", "vVOO_vUSDC", "vMSFT_vUSDC", "vTSLA_vUSDC", "vMETA_vUSDC", "vAMZN_vUSDC", "vNVDA_vUSDC"]);
  const eqRows = activeSpot.filter((s) => equitySet.has(s.symbol));
  const cryptoRows = activeSpot.filter((s) => !equitySet.has(s.symbol) && !s.symbol.includes("USDT") && !s.symbol.includes("BOXX"));

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const avgCryptoChange24hPct = avg(cryptoRows.map((s) => s.changePct));
  const avgEquityTokenChange24hPct = avg(eqRows.map((s) => s.changePct));

  const validApy = wealth.map((w) => w.apy7d).filter((v): v is number => v !== null && v > -50 && v < 100);
  const avgRwaApyPct = avg(validApy);

  const validFunding = perps.slice(0, 20).map((p) => p.fundingRate * 10_000);
  const avgPerpsFundingBps = avg(validFunding);

  const avgIntradaySwing = avg(
    activeSpot.slice(0, 15).map((s) => (s.lastPx > 0 ? ((s.highPx - s.lowPx) / s.lastPx) * 100 : 0))
  );

  const rationale: string[] = [];
  let label: MarketRegime = "ROTATION";
  let confidence = 70;

  if (avgIntradaySwing > 11) {
    label = "HIGH_VOL_CAUTION";
    confidence = Math.min(93, Math.round(68 + avgIntradaySwing * 1.4));
    rationale.push(`Elevated 24h cross-asset intraday swing (${avgIntradaySwing.toFixed(1)}%) triggers volatility size throttling.`);
  } else if (breadthAdvancingPct >= 58 && avgCryptoChange24hPct > 1.0) {
    label = "RISK_ON";
    confidence = Math.min(94, Math.round(60 + (breadthAdvancingPct - 50) * 0.8 + avgCryptoChange24hPct * 2.5));
    rationale.push(`${breadthAdvancingPct.toFixed(0)}% of SoDEX spot pairs advancing with +${avgCryptoChange24hPct.toFixed(2)}% mean crypto momentum.`);
  } else if (breadthAdvancingPct <= 40 && avgCryptoChange24hPct < -1.0) {
    label = "DEFENSIVE";
    confidence = Math.min(92, Math.round(62 + (50 - breadthAdvancingPct) * 0.7 + Math.abs(avgCryptoChange24hPct) * 2));
    rationale.push(`Broad crypto contraction (${avgCryptoChange24hPct.toFixed(2)}%, ${breadthAdvancingPct.toFixed(0)}% breadth); rotate core capital toward vBOXX/Morpho-Earn yield.`);
  } else {
    label = "ROTATION";
    confidence = 74;
    rationale.push(`Mixed breadth (${breadthAdvancingPct.toFixed(0)}% advancing); barbell between SSI index beta and tokenized RWA/Treasuries captures carry.`);
  }

  rationale.push(
    `Tokenized equities 24h avg ${avgEquityTokenChange24hPct >= 0 ? "+" : ""}${avgEquityTokenChange24hPct.toFixed(2)}%, Perps funding ${avgPerpsFundingBps.toFixed(2)} bps.`
  );

  return {
    label,
    confidence,
    breadthAdvancingPct: Number(breadthAdvancingPct.toFixed(1)),
    avgCryptoChange24hPct: Number(avgCryptoChange24hPct.toFixed(2)),
    avgEquityTokenChange24hPct: Number(avgEquityTokenChange24hPct.toFixed(2)),
    avgRwaApyPct: Number(avgRwaApyPct.toFixed(2)),
    avgPerpsFundingBps: Number(avgPerpsFundingBps.toFixed(2)),
    rationale
  };
}

/**
 * Runs a deterministic walk-forward rebalanced backtest and 500-path bootstrap
 * Monte Carlo VaR(95%) / CVaR(99%) simulation on real SoDEX Spot & Wealth daily series.
 */
export function runBasketBacktest(
  basketName: string,
  legs: BasketLeg[],
  seriesMap: Record<string, { points: DailySeriesPoint[]; source: ProvenanceSource }>,
  benchmarkSsiSeries: DailySeriesPoint[],
  benchmarkBtcSeries: DailySeriesPoint[],
  rebalanceIntervalDays = 7,
  feeBps = 10
): BacktestResult {
  // Normalize weights strictly to 1.0
  const rawSum = legs.reduce((acc, l) => acc + Math.max(0, l.weight), 0) || 1;
  const normLegs = legs.map((l) => ({ ...l, weight: Math.max(0, l.weight) / rawSum }));

  // Build date -> price lookup per series, only keeping dates present across all active legs
  const dateSets = normLegs
    .map((l) => new Set((seriesMap[l.symbol]?.points ?? []).map((p) => p.date)))
    .filter((s) => s.size > 0);

  if (!dateSets.length) {
    throw new Error("No historical series points available for selected basket legs.");
  }

  let commonDates = Array.from(dateSets[0]).filter((d) => dateSets.every((set) => set.has(d))).sort();
  if (commonDates.length < 5) {
    // Fallback to union with forward-fill if one newer RWA vault has fewer dates
    const allDates = new Set<string>();
    for (const l of normLegs) {
      for (const p of seriesMap[l.symbol]?.points ?? []) allDates.add(p.date);
    }
    commonDates = Array.from(allDates).sort().slice(-30);
  }

  const priceLookup = new Map<string, Map<string, number>>();
  const buildFfillMap = (pts: DailySeriesPoint[]) => {
    const rawMap = new Map(pts.map((p) => [p.date, p.close]));
    const filled = new Map<string, number>();
    let last = pts[0]?.close ?? 1;
    for (const d of commonDates) {
      const val = rawMap.get(d);
      if (val !== undefined && val > 0) last = val;
      filled.set(d, last);
    }
    return filled;
  };

  for (const leg of normLegs) {
    priceLookup.set(leg.symbol, buildFfillMap(seriesMap[leg.symbol]?.points ?? []));
  }
  const ssiMap = buildFfillMap(benchmarkSsiSeries);
  const btcMap = buildFfillMap(benchmarkBtcSeries);

  const initialVal = 100;
  let units = new Map<string, number>();
  const d0 = commonDates[0];
  for (const leg of normLegs) {
    const p0 = priceLookup.get(leg.symbol)?.get(d0) ?? 1;
    units.set(leg.symbol, (initialVal * leg.weight) / p0);
  }

  const ssiBase = ssiMap.get(d0) ?? 1;
  const btcBase = btcMap.get(d0) ?? 1;

  const equityCurve: BacktestPoint[] = [];
  const dailyReturns: number[] = [];
  let peak = initialVal;
  let maxDrawdownPct = 0;
  let prevNav = initialVal;

  for (let i = 0; i < commonDates.length; i++) {
    const d = commonDates[i];
    let nav = 0;
    for (const leg of normLegs) {
      const px = priceLookup.get(leg.symbol)?.get(d) ?? 1;
      nav += (units.get(leg.symbol) ?? 0) * px;
    }

    // Periodic walk-forward rebalance with turnover transaction cost
    if (i > 0 && i % rebalanceIntervalDays === 0) {
      let turnover = 0;
      for (const leg of normLegs) {
        const px = priceLookup.get(leg.symbol)?.get(d) ?? 1;
        const curVal = (units.get(leg.symbol) ?? 0) * px;
        const targetVal = nav * leg.weight;
        turnover += Math.abs(targetVal - curVal);
      }
      const feeCost = (turnover * feeBps) / 10_000;
      nav = Math.max(0.01, nav - feeCost);
      const nextUnits = new Map<string, number>();
      for (const leg of normLegs) {
        const px = priceLookup.get(leg.symbol)?.get(d) ?? 1;
        nextUnits.set(leg.symbol, (nav * leg.weight) / px);
      }
      units = nextUnits;
    }

    if (i > 0 && prevNav > 0) {
      dailyReturns.push((nav - prevNav) / prevNav);
    }
    prevNav = nav;

    if (nav > peak) peak = nav;
    const dd = peak > 0 ? ((nav - peak) / peak) * 100 : 0;
    if (dd < maxDrawdownPct) maxDrawdownPct = dd;

    equityCurve.push({
      date: d,
      portfolioValue: Number(nav.toFixed(2)),
      benchmarkSsiValue: Number((((ssiMap.get(d) ?? ssiBase) / ssiBase) * 100).toFixed(2)),
      benchmarkBtcValue: Number((((btcMap.get(d) ?? btcBase) / btcBase) * 100).toFixed(2)),
      drawdownPct: Number(dd.toFixed(2))
    });
  }

  const lastPt = equityCurve[equityCurve.length - 1];
  const totalReturnPct = lastPt.portfolioValue - 100;
  const benchmarkSsiReturnPct = lastPt.benchmarkSsiValue - 100;
  const benchmarkBtcReturnPct = lastPt.benchmarkBtcValue - 100;

  const meanDaily = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((a, r) => a + (r - meanDaily) ** 2, 0) / (dailyReturns.length - 1)
    : 0;
  const stdDaily = Math.sqrt(variance);
  const downsideSquares = dailyReturns.filter((r) => r < 0).map((r) => r * r);
  const downsideDev = downsideSquares.length
    ? Math.sqrt(downsideSquares.reduce((a, b) => a + b, 0) / dailyReturns.length)
    : stdDaily;

  const annualizedVolPct = stdDaily * Math.sqrt(365) * 100;
  const annualizedSharpe = stdDaily > 0 ? (meanDaily / stdDaily) * Math.sqrt(365) : 0;
  const annualizedSortino = downsideDev > 0 ? (meanDaily / downsideDev) * Math.sqrt(365) : annualizedSharpe;
  const annualizedReturn = (1 + totalReturnPct / 100) ** (365 / Math.max(1, commonDates.length - 1)) - 1;
  const calmarRatio = maxDrawdownPct < 0 ? (annualizedReturn * 100) / Math.abs(maxDrawdownPct) : 0;
  const winRatePct = dailyReturns.length
    ? (dailyReturns.filter((r) => r > 0).length / dailyReturns.length) * 100
    : 50;

  // Deterministic 500-path 30-day bootstrap Monte Carlo VaR(95%) & CVaR(99%)
  const { var95Pct, cvar99Pct } = runDeterministicBootstrapMc(dailyReturns, 30, 500);

  const legsEvaluated = normLegs.map((leg) => {
    const map = priceLookup.get(leg.symbol)!;
    const first = map.get(commonDates[0]) ?? 1;
    const last = map.get(commonDates[commonDates.length - 1]) ?? first;
    return {
      symbol: leg.symbol,
      weight: Number((leg.weight * 100).toFixed(1)),
      dataPoints: seriesMap[leg.symbol]?.points.length ?? 0,
      legReturnPct: Number((((last - first) / first) * 100).toFixed(2)),
      source: seriesMap[leg.symbol]?.source ?? ("SoDEX Spot CLOB" as ProvenanceSource)
    };
  });

  return {
    basketName,
    daysAnalyzed: commonDates.length,
    rebalanceIntervalDays,
    feeBps,
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    benchmarkSsiReturnPct: Number(benchmarkSsiReturnPct.toFixed(2)),
    benchmarkBtcReturnPct: Number(benchmarkBtcReturnPct.toFixed(2)),
    alphaVsSsiPct: Number((totalReturnPct - benchmarkSsiReturnPct).toFixed(2)),
    annualizedSharpe: Number(annualizedSharpe.toFixed(2)),
    annualizedSortino: Number(annualizedSortino.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    calmarRatio: Number(calmarRatio.toFixed(2)),
    annualizedVolPct: Number(annualizedVolPct.toFixed(2)),
    winRatePct: Number(winRatePct.toFixed(1)),
    mcVar95Pct: Number(var95Pct.toFixed(2)),
    mcCvar99Pct: Number(cvar99Pct.toFixed(2)),
    equityCurve,
    legsEvaluated
  };
}

function runDeterministicBootstrapMc(dailyReturns: number[], horizonDays: number, paths: number): { var95Pct: number; cvar99Pct: number } {
  if (!dailyReturns.length) return { var95Pct: 0, cvar99Pct: 0 };
  // LCG PRNG for reproducible institutional stress test numbers across identical inputs
  let seed = 42_1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const horizonReturns: number[] = [];
  for (let p = 0; p < paths; p++) {
    let eq = 1;
    for (let d = 0; d < horizonDays; d++) {
      const idx = Math.floor(nextRand() * dailyReturns.length);
      eq *= 1 + dailyReturns[idx];
    }
    horizonReturns.push((eq - 1) * 100);
  }
  horizonReturns.sort((a, b) => a - b);
  const idx5 = Math.max(0, Math.floor(paths * 0.05) - 1);
  const idx1 = Math.max(1, Math.floor(paths * 0.01));
  const tail1 = horizonReturns.slice(0, idx1);
  const cvar = tail1.reduce((a, b) => a + b, 0) / tail1.length;

  return {
    var95Pct: horizonReturns[idx5],
    cvar99Pct: cvar
  };
}
