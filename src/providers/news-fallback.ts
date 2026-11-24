import { fetchJson } from "./http";
import type { ProvenanceSource } from "../shared/types";

export interface PublicNewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  tags: string[];
  provenance: ProvenanceSource;
}

const BULL_WORDS = /\b(surge|rally|inflow|approve|adoption|record|launch|partner|growth|breakout|gain)\b/i;
const BEAR_WORDS = /\b(hack|exploit|outflow|drop|crash|lawsuit|ban|decline|liquidation|sec|warning|selloff)\b/i;

export function classifyHeadlineSentiment(title: string): "BULLISH" | "BEARISH" | "NEUTRAL" {
  const bull = BULL_WORDS.test(title);
  const bear = BEAR_WORDS.test(title);
  if (bull && !bear) return "BULLISH";
  if (bear && !bull) return "BEARISH";
  return "NEUTRAL";
}

interface CryptoCompareNewsResponse {
  Data?: Array<{
    id: string;
    title: string;
    url: string;
    source: string;
    published_on: number;
    categories?: string;
  }>;
}

interface TavilySearchResponse {
  results?: Array<{
    title: string;
    url: string;
    content?: string;
    published_date?: string;
  }>;
}

export async function fetchPublicNews(tavilyApiKey?: string): Promise<PublicNewsItem[]> {
  if (tavilyApiKey) {
    try {
      const res = await fetchJson<TavilySearchResponse>(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyApiKey,
            query: "Bitcoin ETF inflow crypto macro SoSoValue FOMC institutional markets",
            topic: "news",
            max_results: 8
          })
        },
        7000
      );
      if (res.results?.length) {
        return res.results.map((r, i) => ({
          id: `tavily-${i}-${Date.now()}`,
          title: r.title,
          source: new URL(r.url).hostname.replace(/^www\./, ""),
          url: r.url,
          publishedAt: r.published_date || new Date().toISOString(),
          sentiment: classifyHeadlineSentiment(r.title + " " + (r.content ?? "")),
          tags: ["News", "Macro"],
          provenance: "Public Market Feed"
        }));
      }
    } catch {
      // Fall through to CryptoCompare live feed
    }
  }

  try {
    const res = await fetchJson<CryptoCompareNewsResponse>(
      "https://min-api.cryptocompare.com/data/v2/news/?lang=EN",
      {},
      7000
    );
    return (res.Data ?? []).slice(0, 12).map((item) => ({
      id: String(item.id),
      title: item.title,
      source: item.source,
      url: item.url,
      publishedAt: new Date(item.published_on * 1000).toISOString(),
      sentiment: classifyHeadlineSentiment(item.title),
      tags: (item.categories ?? "Crypto").split("|").slice(0, 3),
      provenance: "Public Market Feed"
    }));
  } catch {
    return [];
  }
}
