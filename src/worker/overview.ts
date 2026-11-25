import { SoDexClient } from "../providers/sodex";
import { SoSoValueClient } from "../providers/sosovalue";
import { computeSsiParity, getValueChainBlocks } from "../providers/onchain";
import { classifyHeadlineSentiment, fetchPublicNews } from "../providers/news-fallback";
import { detectMarketRegime } from "../engine/quant";
import type { MarketOverviewBundle, ProvenanceSource } from "../shared/types";

export async function buildMarketOverview(opts: {
  sosoApiKey?: string;
  keyOrigin: "server_env" | "request_header" | "none";
  tavilyApiKey?: string;
}): Promise<MarketOverviewBundle> {
  const sodex = new SoDexClient();

  const [spotTickers, perpsTickers, wealthFunds, blocks, publicNews] = await Promise.all([
    sodex.getSpotTickers(),
    sodex.getPerpsTickers(),
    sodex.getWealthFunds(),
    getValueChainBlocks(),
    fetchPublicNews(opts.tavilyApiKey)
  ]);

  const sodexPriceMap: Record<string, { lastPx: number; spreadBps: number }> = {};
  for (const t of spotTickers) {
    sodexPriceMap[t.symbol] = { lastPx: t.lastPx, spreadBps: t.spreadBps };
  }

  const ssiParity = await computeSsiParity(sodexPriceMap);

  const provenanceSet = new Set<ProvenanceSource>([
    "SoDEX Spot CLOB",
    "SoDEX Perps CLOB",
    "SoDEX Wealth API",
    "ValueChain RPC (286623)",
    "Base SSI On-Chain (8453)"
  ]);

  let newsFeed = publicNews;
  if (publicNews.length > 0) provenanceSet.add("Public Market Feed");

  const sosoOpenApi: MarketOverviewBundle["sosoOpenApi"] = {
    connected: false,
    keyOrigin: opts.keyOrigin,
    etfNetInflowUsd: null,
    etfLatestDate: null,
    btcDominancePct: null,
    totalMarketCapUsd: null,
    fomcNextProbabilities: [],
    indicesCount: 0
  };

  if (opts.sosoApiKey) {
    const soso = new SoSoValueClient(opts.sosoApiKey);
    try {
      const [overview, etfHist, indices, sosoNews, fomc] = await Promise.all([
        soso.getMarketOverview().catch(() => null),
        soso.getEtfSummaryHistory("BTC", "US", 5).catch(() => []),
        soso.getIndices().catch(() => []),
        soso.getHotNews(8).catch(() => ({ list: [], total: 0 })),
        soso.getFomcProbabilities().catch(() => null)
      ]);

      sosoOpenApi.connected = Boolean(overview || etfHist.length || indices.length);
      if (sosoOpenApi.connected) provenanceSet.add("SoSoValue OpenAPI v1/v3");

      if (overview) {
        const capNum = Number(overview.total_market_cap);
        sosoOpenApi.totalMarketCapUsd = Number.isFinite(capNum) && capNum > 0 ? capNum : null;
      }
      if (etfHist.length) {
        const latestSettled = etfHist.find((r) => r.total_net_inflow !== null) ?? etfHist[0];
        sosoOpenApi.etfNetInflowUsd = latestSettled.total_net_inflow ?? null;
        sosoOpenApi.etfLatestDate = latestSettled.date ?? null;
      }
      sosoOpenApi.indicesCount = indices.length;

      if (fomc?.meetings?.[0]?.probabilities) {
        sosoOpenApi.fomcNextProbabilities = fomc.meetings[0].probabilities.map((p) => ({
          rateRange: p.rate_range,
          probabilityPct: Number((p.probability * 100).toFixed(1))
        }));
      }

      if (sosoNews.list?.length) {
        newsFeed = sosoNews.list.map((n) => {
          let publishedIso = new Date().toISOString();
          if (n.release_time !== undefined && n.release_time !== null) {
            const rawNum = Number(n.release_time);
            const dt = Number.isFinite(rawNum)
              ? new Date(rawNum < 1e12 ? rawNum * 1000 : rawNum)
              : new Date(String(n.release_time));
            if (Number.isFinite(dt.getTime())) publishedIso = dt.toISOString();
          }
          return {
            id: `soso-${n.id}`,
            title: n.title || n.content?.slice(0, 120) || "SoSoValue Market Flash",
            source: "SoSoValue News",
            url: n.source_link || "https://sosovalue.com",
            publishedAt: publishedIso,
            sentiment: classifyHeadlineSentiment((n.title ?? "") + " " + (n.content ?? "")),
            tags: n.tags ?? ["SoSoValue"],
            provenance: "SoSoValue OpenAPI v1/v3"
          };
        });
      }
    } catch (err) {
      sosoOpenApi.errorNote = err instanceof Error ? err.message : "SoSoValue OpenAPI request failed";
    }
  }

  // Feed SoSoValue ETF flows and news sentiment directly into market regime classification
  const sentimentNumeric: number[] = newsFeed.map((n) => (n.sentiment === "BULLISH" ? 1 : n.sentiment === "BEARISH" ? -1 : 0));
  const newsSentimentScore = sentimentNumeric.length
    ? sentimentNumeric.reduce((a, b) => a + b, 0) / sentimentNumeric.length
    : null;

  const regime = detectMarketRegime(spotTickers, perpsTickers, wealthFunds, {
    etfNetInflowUsd: sosoOpenApi.etfNetInflowUsd,
    newsSentimentScore
  });

  return {
    timestamp: new Date().toISOString(),
    valueChainMainnetBlock: blocks.mainnetBlock,
    valueChainTestnetBlock: blocks.testnetBlock,
    regime,
    spotTickers,
    perpsTickers,
    wealthFunds,
    ssiParity,
    newsFeed,
    sosoOpenApi,
    provenanceList: Array.from(provenanceSet)
  };
}
