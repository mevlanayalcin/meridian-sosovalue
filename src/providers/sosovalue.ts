import { fetchJson } from "./http";

const SOSO_BASE = "https://openapi.sosovalue.com";

export interface SosoEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface SosoEtfSummaryRow {
  date: string;
  total_net_inflow: number;
  total_value_traded: number;
  total_net_assets: number;
  cum_net_inflow: number;
}

export interface SosoMarketOverview {
  total_market_cap?: number;
  total_market_cap_change_pct?: number;
  total_volume_24h?: number;
  eth_gas_gwei?: number;
  btc_gas_sat_vb?: number;
}

export interface SosoNewsItem {
  id: number | string;
  title?: string;
  content?: string;
  source_link?: string;
  release_time?: number;
  category?: string;
  tags?: string[];
}

export interface SosoFomcProbabilities {
  meetings?: Array<{
    meeting_date?: string;
    probabilities?: Array<{ rate_range: string; probability: number }>;
  }>;
  [k: string]: unknown;
}

/**
 * Full client for SoSoValue OpenAPI v1 (/openapi/v1) and Market Data v3 (/openapi/v3).
 * Uses `x-soso-api-key` authentication per official GitBook OpenAPI 3.0 spec.
 */
export class SoSoValueClient {
  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string): Promise<T> {
    const res = await fetchJson<SosoEnvelope<T>>(`${SOSO_BASE}${path}`, {
      headers: { "x-soso-api-key": this.apiKey }
    });
    if (res.code !== 0) {
      throw new Error(`SoSoValue API error ${res.code}: ${res.message}`);
    }
    return res.data;
  }

  getMarketOverview(): Promise<SosoMarketOverview> {
    return this.request("/openapi/v1/market/overview");
  }

  getEtfSummaryHistory(symbol = "BTC", country = "US", limit = 15): Promise<SosoEtfSummaryRow[]> {
    return this.request(`/openapi/v1/etfs/summary-history?symbol=${encodeURIComponent(symbol)}&country_code=${encodeURIComponent(country)}&limit=${limit}`);
  }

  getEtfs(symbol = "BTC", country = "US"): Promise<Array<{ ticker: string; name: string; exchange: string }>> {
    return this.request(`/openapi/v1/etfs?symbol=${encodeURIComponent(symbol)}&country_code=${encodeURIComponent(country)}`);
  }

  getIndices(): Promise<string[]> {
    return this.request("/openapi/v1/indices");
  }

  getIndexConstituents(ticker: string): Promise<Array<{ currency_id: string; symbol: string; weight: number }>> {
    return this.request(`/openapi/v1/indices/${encodeURIComponent(ticker)}/constituents`);
  }

  getIndexSnapshot(ticker: string): Promise<{ price: number; change_pct_24h: number; roi_7d: number; roi_1m: number; ytd: number }> {
    return this.request(`/openapi/v1/indices/${encodeURIComponent(ticker)}/market-snapshot`);
  }

  getNews(pageSize = 10): Promise<{ list: SosoNewsItem[]; total: number }> {
    return this.request(`/openapi/v1/news?page=1&page_size=${pageSize}`);
  }

  getHotNews(pageSize = 10): Promise<{ list: SosoNewsItem[]; total: number }> {
    return this.request(`/openapi/v1/news/hot?page=1&page_size=${pageSize}`);
  }

  getFomcProbabilities(): Promise<SosoFomcProbabilities> {
    return this.request("/openapi/v1/macro/fomc-probabilities");
  }

  getMacroRates(): Promise<unknown> {
    return this.request("/openapi/v1/macro/rates");
  }

  getMacroEvents(): Promise<unknown> {
    return this.request("/openapi/v1/macro/events");
  }

  getCryptoStocks(): Promise<unknown> {
    return this.request("/openapi/v1/crypto-stocks");
  }

  getBtcTreasuries(): Promise<unknown> {
    return this.request("/openapi/v1/btc-treasuries");
  }

  getV3Instruments(type = "equity", expand = "quote", pageSize = 20): Promise<unknown> {
    return this.request(`/openapi/v3/instruments?type=${encodeURIComponent(type)}&expand=${encodeURIComponent(expand)}&page_size=${pageSize}`);
  }
}
