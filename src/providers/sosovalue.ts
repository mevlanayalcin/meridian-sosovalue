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
 * Active client for SoSoValue OpenAPI v1 endpoints wired into Meridian's overview,
 * regime classifier, thesis synthesis, and MCP tools.
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
    return this.request(
      `/openapi/v1/etfs/summary-history?symbol=${encodeURIComponent(symbol)}&country_code=${encodeURIComponent(country)}&limit=${limit}`
    );
  }

  getIndices(): Promise<string[]> {
    return this.request("/openapi/v1/indices");
  }

  getHotNews(pageSize = 10): Promise<{ list: SosoNewsItem[]; total: number }> {
    return this.request(`/openapi/v1/news/hot?page=1&page_size=${pageSize}`);
  }

  getFomcProbabilities(): Promise<SosoFomcProbabilities> {
    return this.request("/openapi/v1/macro/fomc-probabilities");
  }
}
