export type ProvenanceSource =
  | "SoSoValue OpenAPI v1/v3"
  | "SoDEX Spot CLOB"
  | "SoDEX Perps CLOB"
  | "SoDEX Wealth API"
  | "ValueChain RPC (286623)"
  | "Base SSI On-Chain (8453)"
  | "Public Market Feed";

export type MarketRegime = "RISK_ON" | "ROTATION" | "DEFENSIVE" | "HIGH_VOL_CAUTION";

export interface SpotTicker {
  symbol: string;
  lastPx: number;
  openPx: number;
  highPx: number;
  lowPx: number;
  volume: number;
  quoteVolume: number;
  changePct: number;
  bidPx: number;
  askPx: number;
  spreadBps: number;
}

export interface PerpsTicker {
  symbol: string;
  lastPx: number;
  markPx: number;
  indexPx: number;
  highPx: number;
  lowPx: number;
  quoteVolume: number;
  openInterestUsd: number;
  fundingRate: number;
  changePct: number;
}

export interface WealthFund {
  fundId: string;
  name: string;
  fundType: "escrow_vault" | "clob" | "bridged_vault";
  fundStatus: string;
  price: number;
  nav: number | null;
  aum: number | null;
  apy7d: number | null;
  roi1M: number | null;
  roi1Y: number | null;
  shareCoin: string;
  shareAddress: string;
  channel: string;
  asOf: string;
}

export interface SsiParityRow {
  symbol: string;
  baseAddress: string;
  baseTotalSupply: number;
  baseDexPriceUsd: number | null;
  sodexSymbol: string | null;
  sodexPriceUsd: number | null;
  sodexSpreadBps: number | null;
  constituentFairValueUsd: number | null;
  premiumDiscountBps: number | null;
  signal: "ARBITRAGE_BUY_SODEX" | "ARBITRAGE_SELL_SODEX" | "PARITY_NEUTRAL" | "ONCHAIN_ONLY";
}

export interface OrderbookLevel {
  price: number;
  size: number;
  notionalUsd: number;
  cumNotionalUsd: number;
}

export interface OrderbookSnapshot {
  marketType: "spot" | "perps";
  symbol: string;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalanceRatio: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  blockHeight: number;
  blockTime: number;
}

export interface FirewallCheckRequest {
  marketType: "spot" | "perps" | "wealth";
  symbol: string;
  side: "BUY" | "SELL";
  notionalUsd: number;
  portfolioTotalUsd?: number;
  existingAssetUsd?: number;
  maxSlippageBps?: number;
  maxConcentrationPct?: number;
  leverage?: number;
}

export interface FirewallCheckResult {
  id: string;
  createdAt: string;
  verdict: "APPROVE" | "CAUTION" | "BLOCK";
  riskScore: number;
  symbol: string;
  marketType: "spot" | "perps" | "wealth";
  side: "BUY" | "SELL";
  requestedNotionalUsd: number;
  recommendedMaxUsd: number;
  estimatedFillPrice: number;
  midPrice: number;
  slippageBps: number;
  spreadBps: number;
  intradayVolPct: number;
  postTradeConcentrationPct: number;
  bookImbalance: number;
  venueChannelStatus: string;
  checks: Array<{
    name: string;
    status: "PASS" | "WARN" | "FAIL";
    observed: string;
    threshold: string;
    detail: string;
  }>;
  sha256Digest: string;
  source: ProvenanceSource;
}

export interface BasketLeg {
  symbol: string;
  source: "spot" | "wealth";
  weight: number; // 0..1 summing to 1
  label: string;
}

export interface BacktestPoint {
  date: string;
  portfolioValue: number;
  benchmarkSsiValue: number;
  benchmarkBtcValue: number;
  drawdownPct: number;
}

export interface BacktestResult {
  basketName: string;
  daysAnalyzed: number;
  rebalanceIntervalDays: number;
  feeBps: number;
  totalReturnPct: number;
  benchmarkSsiReturnPct: number;
  benchmarkBtcReturnPct: number;
  alphaVsSsiPct: number;
  annualizedSharpe: number;
  annualizedSortino: number;
  maxDrawdownPct: number;
  calmarRatio: number;
  annualizedVolPct: number;
  winRatePct: number;
  mcVar95Pct: number;
  mcCvar99Pct: number;
  equityCurve: BacktestPoint[];
  legsEvaluated: Array<{
    symbol: string;
    weight: number;
    dataPoints: number;
    legReturnPct: number;
    source: ProvenanceSource;
  }>;
}

export interface MarketOverviewBundle {
  timestamp: string;
  valueChainMainnetBlock: number;
  valueChainTestnetBlock: number;
  regime: {
    label: MarketRegime;
    confidence: number;
    breadthAdvancingPct: number;
    avgCryptoChange24hPct: number;
    avgEquityTokenChange24hPct: number;
    avgRwaApyPct: number;
    avgPerpsFundingBps: number;
    rationale: string[];
  };
  spotTickers: SpotTicker[];
  perpsTickers: PerpsTicker[];
  wealthFunds: WealthFund[];
  ssiParity: SsiParityRow[];
  newsFeed: Array<{
    id: string;
    title: string;
    source: string;
    url: string;
    publishedAt: string;
    sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
    tags: string[];
    provenance: ProvenanceSource;
  }>;
  sosoOpenApi: {
    connected: boolean;
    keyOrigin: "server_env" | "request_header" | "none";
    etfNetInflowUsd: number | null;
    etfLatestDate: string | null;
    btcDominancePct: number | null;
    totalMarketCapUsd: number | null;
    fomcNextProbabilities: Array<{ rateRange: string; probabilityPct: number }>;
    indicesCount: number;
    errorNote?: string;
  };
  provenanceList: ProvenanceSource[];
}

export interface PublishedThesis {
  id: string;
  createdAt: string;
  title: string;
  regime: MarketRegime;
  confidence: number;
  conviction: number;
  targetAsset: string;
  direction: "LONG" | "HEDGE" | "YIELD_ROTATE" | "NEUTRAL";
  summary: string;
  evidence: Array<{ metric: string; value: string; source: ProvenanceSource; url?: string }>;
  allocation: Array<{ asset: string; weightPct: number; venue: string }>;
  firewallVerdict: "APPROVE" | "CAUTION" | "BLOCK";
  sha256Digest: string;
  aiModel: string;
}
