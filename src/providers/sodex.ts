import { fetchJson, safeNum } from "./http";
import type { OrderbookLevel, OrderbookSnapshot, PerpsTicker, SpotTicker, WealthFund } from "../shared/types";

export const SODEX_MAINNET = "https://mainnet-gw.sodex.dev/api/v1";
export const SODEX_TESTNET = "https://testnet-gw.sodex.dev/api/v1";

interface SoDexEnvelope<T> {
  code: number;
  timestamp: number;
  data: T;
  error?: string;
}

interface RawSpotTicker {
  symbol: string;
  lastPx: string;
  openPx: string;
  highPx: string;
  lowPx: string;
  volume: string;
  quoteVolume: string;
  changePct: number;
  askPx: string;
  bidPx: string;
}

interface RawPerpsTicker extends RawSpotTicker {
  fundingRate?: string;
  indexPrice?: string;
  markPrice?: string;
  openInterest?: string;
}

interface RawMarkPrice {
  symbol: string;
  openInterest: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
}

interface RawOrderBook {
  blockTime: number;
  blockHeight: number;
  updateID: number;
  bids: [string, string][];
  asks: [string, string][];
}

interface RawCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  q: string;
}

interface RawWealthFund {
  fundId: string;
  name: string;
  fundType: "escrow_vault" | "clob" | "bridged_vault";
  fundStatus: string;
  nav?: string;
  aum?: string;
  asOf: string;
  share?: { coin?: string; address?: string };
}

interface RawWealthMarketQuote {
  fundId: string;
  price: string;
  apy7d?: string;
  roi1M?: string;
  roi1Y?: string;
}

interface RawWealthTradingStatus {
  fundId: string;
  channel: string;
  closedReason: string | null;
}

export interface DailySeriesPoint {
  date: string;
  close: number;
}

export class SoDexClient {
  constructor(private readonly baseUrl: string = SODEX_MAINNET) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetchJson<SoDexEnvelope<T>>(`${this.baseUrl}${path}`);
    if (res.code !== 0) {
      throw new Error(res.error ?? `SoDEX API error code ${res.code} on ${path}`);
    }
    return res.data;
  }

  async getSpotTickers(): Promise<SpotTicker[]> {
    const raw = await this.get<RawSpotTicker[]>("/spot/markets/tickers");
    return (raw ?? [])
      .map((t) => {
        const lastPx = safeNum(t.lastPx);
        const bidPx = safeNum(t.bidPx);
        const askPx = safeNum(t.askPx);
        const mid = bidPx > 0 && askPx > 0 ? (bidPx + askPx) / 2 : lastPx;
        const spreadBps = mid > 0 && bidPx > 0 && askPx > 0 ? ((askPx - bidPx) / mid) * 10_000 : 0;
        return {
          symbol: t.symbol,
          lastPx,
          openPx: safeNum(t.openPx),
          highPx: safeNum(t.highPx),
          lowPx: safeNum(t.lowPx),
          volume: safeNum(t.volume),
          quoteVolume: safeNum(t.quoteVolume),
          changePct: safeNum(t.changePct),
          bidPx,
          askPx,
          spreadBps: Number(spreadBps.toFixed(1))
        };
      })
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  }

  async getPerpsTickers(): Promise<PerpsTicker[]> {
    const [raw, markRows] = await Promise.all([
      this.get<RawPerpsTicker[]>("/perps/markets/tickers"),
      this.get<RawMarkPrice[]>("/perps/markets/mark-prices").catch(() => [])
    ]);
    const markBySym = new Map((markRows ?? []).map((m) => [m.symbol, m]));
    return (raw ?? [])
      .map((t) => {
        const m = markBySym.get(t.symbol);
        const markPx = safeNum(m?.markPrice ?? t.markPrice, safeNum(t.lastPx));
        const oiUnits = safeNum(m?.openInterest ?? t.openInterest);
        return {
          symbol: t.symbol,
          lastPx: safeNum(t.lastPx),
          markPx,
          indexPx: safeNum(m?.indexPrice ?? t.indexPrice, markPx),
          highPx: safeNum(t.highPx),
          lowPx: safeNum(t.lowPx),
          quoteVolume: safeNum(t.quoteVolume),
          openInterestUsd: Number((oiUnits * markPx).toFixed(2)),
          fundingRate: safeNum(m?.fundingRate ?? t.fundingRate),
          changePct: safeNum(t.changePct)
        };
      })
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  }

  async getSpotSymbols(): Promise<Array<{ id: number; name: string; minNotional: string; maxNotional: string; tickSize: string; stepSize: string }>> {
    return this.get("/spot/markets/symbols");
  }

  async getPerpsSymbols(): Promise<Array<{ id: number; name: string; minNotional: string; maxNotional: string; maxLeverage: number; tickSize: string; stepSize: string }>> {
    return this.get("/perps/markets/symbols");
  }

  async getOrderbook(marketType: "spot" | "perps", symbol: string, limit = 50): Promise<OrderbookSnapshot> {
    const raw = await this.get<RawOrderBook>(`/${marketType}/markets/${encodeURIComponent(symbol)}/orderbook?limit=${limit}`);
    const buildLevels = (rows: [string, string][]): OrderbookLevel[] => {
      let cum = 0;
      return rows
        .map(([pStr, sStr]) => {
          const price = safeNum(pStr);
          const size = safeNum(sStr);
          const notionalUsd = price * size;
          cum += notionalUsd;
          return { price, size, notionalUsd, cumNotionalUsd: cum };
        })
        .filter((r) => r.price > 0 && r.size > 0);
    };

    const bids = buildLevels(raw.bids ?? []);
    const asks = buildLevels(raw.asks ?? []);
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
    const spreadBps = midPrice > 0 && bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / midPrice) * 10_000 : 0;
    const bidDepthUsd = bids.reduce((a, b) => a + b.notionalUsd, 0);
    const askDepthUsd = asks.reduce((a, b) => a + b.notionalUsd, 0);
    const totalDepth = bidDepthUsd + askDepthUsd;
    const imbalanceRatio = totalDepth > 0 ? (bidDepthUsd - askDepthUsd) / totalDepth : 0;

    return {
      marketType,
      symbol,
      bestBid,
      bestAsk,
      midPrice,
      spreadBps: Number(spreadBps.toFixed(2)),
      bidDepthUsd: Number(bidDepthUsd.toFixed(2)),
      askDepthUsd: Number(askDepthUsd.toFixed(2)),
      imbalanceRatio: Number(imbalanceRatio.toFixed(4)),
      bids,
      asks,
      blockHeight: raw.blockHeight ?? 0,
      blockTime: raw.blockTime ?? 0
    };
  }

  async getKlines(marketType: "spot" | "perps", symbol: string, interval = "1d", limit = 60): Promise<DailySeriesPoint[]> {
    const raw = await this.get<RawCandle[]>(
      `/${marketType}/markets/${encodeURIComponent(symbol)}/klines?interval=${encodeURIComponent(interval)}&limit=${limit}`
    );
    const byDate = new Map<string, number>();
    for (const c of raw ?? []) {
      const close = safeNum(c.c);
      if (close > 0 && c.t > 0) {
        byDate.set(new Date(c.t).toISOString().slice(0, 10), close);
      }
    }
    return Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, close]) => ({ date, close }));
  }

  async getWealthFunds(): Promise<WealthFund[]> {
    const [funds, marketBoard] = await Promise.all([
      this.get<RawWealthFund[]>("/wealth/funds"),
      this.get<{ quotes: RawWealthMarketQuote[] }>("/wealth/markets")
    ]);
    const quoteMap = new Map((marketBoard.quotes ?? []).map((q) => [q.fundId, q]));
    const statusMap = new Map<string, string>();
    await Promise.all(
      (funds ?? []).slice(0, 12).map(async (f) => {
        try {
          const st = await this.get<RawWealthTradingStatus>(`/wealth/funds/${encodeURIComponent(f.fundId)}/trading-status`);
          statusMap.set(f.fundId, st.closedReason ? `${st.channel}:${st.closedReason}` : st.channel);
        } catch {
          statusMap.set(f.fundId, f.fundType === "bridged_vault" ? "bridge_route" : f.fundStatus);
        }
      })
    );

    return (funds ?? []).map((f) => {
      const q = quoteMap.get(f.fundId);
      const navVal = f.nav ? safeNum(f.nav) : null;
      const priceVal = q?.price ? safeNum(q.price) : navVal ?? 0;
      return {
        fundId: f.fundId,
        name: f.name,
        fundType: f.fundType,
        fundStatus: f.fundStatus,
        price: priceVal,
        nav: navVal,
        aum: f.aum ? safeNum(f.aum) : null,
        apy7d: q?.apy7d !== undefined ? safeNum(q.apy7d) : null,
        roi1M: q?.roi1M !== undefined ? safeNum(q.roi1M) : null,
        roi1Y: q?.roi1Y !== undefined ? safeNum(q.roi1Y) : null,
        shareCoin: f.share?.coin ?? f.fundId,
        shareAddress: f.share?.address ?? "",
        channel: statusMap.get(f.fundId) ?? f.fundStatus,
        asOf: f.asOf
      };
    });
  }

  async getWealthPriceHistory(fundId: string, range = "3M"): Promise<DailySeriesPoint[]> {
    const res = await this.get<{ points?: Array<{ ts: number; close: string }>; candles?: Array<{ ts: number; close: string }> }>(
      `/wealth/funds/${encodeURIComponent(fundId)}/price-history?interval=1d&range=${encodeURIComponent(range)}&type=line`
    );
    const pts = res.points ?? res.candles ?? [];
    return pts
      .map((p) => ({
        date: new Date(p.ts).toISOString().slice(0, 10),
        close: safeNum(p.close)
      }))
      .filter((p) => p.close > 0);
  }
}
