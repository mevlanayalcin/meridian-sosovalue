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
  rate_ranges?: string[];
  meetings?: Array<{
    meeting_date?: string;
    probabilities?: Array<
      | string
      | number
      | null
      | { rate_range?: string; probability?: number | string | null }
    >;
  }>;
  as_of?: number;
  [k: string]: unknown;
}

export interface ParsedFomcNextMeeting {
  meetingDate: string | null;
  probabilities: Array<{ rateRange: string; probabilityPct: number }>;
}

/**
 * Parses SoSoValue OpenAPI /openapi/v1/macro/fomc-probabilities payloads cleanly.
 * Handles the live schema (`rate_ranges: string[]` + `meetings[].probabilities: Array<string | number | null>`)
 * as well as legacy `{ rate_range, probability }` objects, skipping null/non-finite entries without throwing.
 */
export function parseFomcNextProbabilities(
  fomc: SosoFomcProbabilities | null | undefined
): ParsedFomcNextMeeting {
  if (!fomc || !Array.isArray(fomc.meetings) || fomc.meetings.length === 0) {
    return { meetingDate: null, probabilities: [] };
  }

  const rateRanges = Array.isArray(fomc.rate_ranges) ? fomc.rate_ranges : [];
  for (const meeting of fomc.meetings) {
    if (!meeting || !Array.isArray(meeting.probabilities)) continue;
    const parsed: Array<{ rateRange: string; probabilityPct: number }> = [];

    for (let i = 0; i < meeting.probabilities.length; i++) {
      const entry = meeting.probabilities[i];
      if (entry === null || entry === undefined) continue;

      if (typeof entry === "string" || typeof entry === "number") {
        const range = rateRanges[i];
        const num = typeof entry === "number" ? entry : Number.parseFloat(entry);
        if (!range || !Number.isFinite(num)) continue;
        // SoSoValue returns percentage strings like "98.9"; normalize 0..1 fractional values if ever returned
        const pct = num > 0 && num <= 1 && typeof entry === "number" ? num * 100 : num;
        parsed.push({
          rateRange: range,
          probabilityPct: Number(pct.toFixed(1))
        });
      } else if (typeof entry === "object") {
        const range = entry.rate_range ?? rateRanges[i];
        const rawProb = entry.probability;
        if (!range || rawProb === null || rawProb === undefined) continue;
        const num = typeof rawProb === "number" ? rawProb : Number.parseFloat(String(rawProb));
        if (!Number.isFinite(num)) continue;
        const pct = num >= 0 && num <= 1 ? num * 100 : num;
        parsed.push({
          rateRange: range,
          probabilityPct: Number(pct.toFixed(1))
        });
      }
    }

    if (parsed.length > 0) {
      return {
        meetingDate: meeting.meeting_date ?? null,
        probabilities: parsed
      };
    }
  }

  return { meetingDate: fomc.meetings[0]?.meeting_date ?? null, probabilities: [] };
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
