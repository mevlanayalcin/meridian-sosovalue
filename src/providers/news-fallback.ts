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

const BULL_WORDS = /\b(surge|rally|inflow|approve|adoption|record|launch|partner|growth|breakout|gain|soar|etf)\b/i;
const BEAR_WORDS = /\b(hack|exploit|outflow|drop|crash|lawsuit|ban|decline|liquidation|sec|warning|selloff|slump)\b/i;

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

function parseRssItems(xml: string, sourceLabel: string): PublicNewsItem[] {
  const items: PublicNewsItem[] = [];
  const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of itemMatches) {
    const block = m[1];
    const titleRaw = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() ?? "";
    const linkRaw = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    const pubRaw = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    const title = titleRaw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (title && linkRaw) {
      items.push({
        id: `rss-${items.length}-${pubRaw.slice(0, 16)}`,
        title,
        source: sourceLabel,
        url: linkRaw,
        publishedAt: pubRaw ? new Date(pubRaw).toISOString() : new Date().toISOString(),
        sentiment: classifyHeadlineSentiment(title),
        tags: ["Crypto", "Market"],
        provenance: "Public Market Feed"
      });
    }
    if (items.length >= 10) break;
  }
  return items;
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
      // Fall through to public RSS / CryptoCompare feeds
    }
  }

  for (const [rssUrl, sourceLabel] of [
    ["https://cointelegraph.com/rss", "Cointelegraph"],
    ["https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk"]
  ] as const) {
    try {
      const res = await fetch(rssUrl, { headers: { "User-Agent": "Meridian-Finance-Desk/1.0" } });
      if (res.ok) {
        const xml = await res.text();
        const parsed = parseRssItems(xml, sourceLabel);
        if (parsed.length > 0) return parsed;
      }
    } catch {
      // Try next feed
    }
  }

  try {
    const res = await fetchJson<CryptoCompareNewsResponse>(
      "https://min-api.cryptocompare.com/data/v2/news/?lang=EN",
      {},
      7000
    );
    return (res.Data ?? []).slice(0, 10).map((item) => ({
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
