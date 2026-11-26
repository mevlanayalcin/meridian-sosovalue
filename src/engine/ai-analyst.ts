import { fetchJson, sha256Hex } from "../providers/http";
import type { FirewallCheckResult, MarketOverviewBundle, PublishedThesis } from "../shared/types";

interface NimCompletionResponse {
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
  }>;
}

const DEFAULT_NIM_URL = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

export function sanitizeVaultApy(apy: number | null): number | null {
  if (apy === null || !Number.isFinite(apy)) return null;
  if (apy < -25 || apy > 40) return null; // Exclude non-yield annualized 7d equity swings & launch outliers
  return Number(apy.toFixed(2));
}

export function hasHallucinatedPercentage(text: string): boolean {
  // Flags >=1,000% (with or without commas, spaces, decimals, "%", "％", "percent", "per cent", or "pct"),
  // while NEVER flagging tiny decimal percentages such as funding rates ("0.0013%", "-0.0009%").
  const regex = /(?:^|[^\d.])(\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d+)?\s*(?:%|％|percent\b|per\s+cent\b|pct\b)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const numeric = Number.parseFloat(match[1].replace(/,/g, ""));
    if (Number.isFinite(numeric) && numeric >= 1000) {
      return true;
    }
  }
  return false;
}

/**
 * Deterministic SHA-256 thesis content digest over the FINAL thesis fields (including bound firewallVerdict & evidence).
 */
export async function computeThesisDigest(thesis: Omit<PublishedThesis, "sha256Digest">): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      id: thesis.id,
      createdAt: thesis.createdAt,
      title: thesis.title,
      direction: thesis.direction,
      conviction: thesis.conviction,
      targetAsset: thesis.targetAsset,
      summary: thesis.summary,
      allocation: thesis.allocation,
      evidence: thesis.evidence,
      firewallVerdict: thesis.firewallVerdict
    })
  );
}

/**
 * Generates an evidence-grounded institutional investment thesis and allocation proposal.
 * Sanitizes anomalous APY inputs before LLM synthesis and binds firewallVerdict directly
 * to a live evaluateTradeFirewall() verdict rather than a spread stub.
 */
export async function generateGroundedThesis(
  bundle: MarketOverviewBundle,
  promptFocus: string,
  nvidiaApiKey?: string,
  liveFirewall?: FirewallCheckResult | null
): Promise<PublishedThesis> {
  const now = new Date().toISOString();
  const sanitizedWealth = bundle.wealthFunds.map((w) => ({
    ...w,
    cleanApy7d: sanitizeVaultApy(w.apy7d),
    apyAnomalyFiltered: w.apy7d !== null && sanitizeVaultApy(w.apy7d) === null
  }));
  const topRwa = [...sanitizedWealth]
    .filter((f) => f.cleanApy7d !== null && f.cleanApy7d > 0)
    .sort((a, b) => (b.cleanApy7d ?? 0) - (a.cleanApy7d ?? 0))[0];
  const mag7 = bundle.spotTickers.find((t) => t.symbol === "vMAG7ssi_vUSDC");
  const btcPerp = bundle.perpsTickers.find((t) => t.symbol === "BTC-USD");
  const boxx = bundle.wealthFunds.find((f) => f.fundId === "vBOXX");

  const defaultEvidence: PublishedThesis["evidence"] = [
    {
      metric: "Market Regime Classification",
      value: `${bundle.regime.label} (${bundle.regime.confidence}% conf, ${bundle.regime.breadthAdvancingPct.toFixed(0)}% advancing)`,
      source: bundle.sosoOpenApi.connected ? "SoSoValue OpenAPI v1/v3" : "SoDEX Spot CLOB"
    },
    ...(bundle.sosoOpenApi.etfNetInflowUsd !== null
      ? [
          {
            metric: "SoSoValue US BTC Spot ETF Net Flow",
            value: `${bundle.sosoOpenApi.etfNetInflowUsd >= 0 ? "+" : ""}$${(bundle.sosoOpenApi.etfNetInflowUsd / 1_000_000).toFixed(1)}M (${bundle.sosoOpenApi.etfLatestDate ?? "latest"})`,
            source: "SoSoValue OpenAPI v1/v3" as const
          }
        ]
      : []),
    ...(mag7
      ? [
          {
            metric: "SoDEX vMAG7ssi_vUSDC Spot",
            value: `$${mag7.lastPx.toFixed(4)} (${mag7.changePct >= 0 ? "+" : ""}${mag7.changePct.toFixed(2)}% 24h, spread ${mag7.spreadBps.toFixed(1)} bps)`,
            source: "SoDEX Spot CLOB" as const
          }
        ]
      : []),
    ...(btcPerp
      ? [
          {
            metric: "BTC-USD Perp Mark & Funding",
            value: `$${btcPerp.markPx.toLocaleString("en-US", { maximumFractionDigits: 2 })} | Funding ${(btcPerp.fundingRate * 100).toFixed(4)}%`,
            source: "SoDEX Perps CLOB" as const
          }
        ]
      : []),
    ...(topRwa
      ? [
          {
            metric: `SoDEX Wealth ${topRwa.fundId}`,
            value: `NAV $${topRwa.price.toFixed(4)} | 7d APY ${topRwa.cleanApy7d?.toFixed(2)}%`,
            source: "SoDEX Wealth API" as const
          }
        ]
      : []),
    {
      metric: "ValueChain Finality Height",
      value: `Mainnet Block #${bundle.valueChainMainnetBlock.toLocaleString("en-US")}`,
      source: "ValueChain RPC (286623)"
    }
  ];

  const defaultAllocation: PublishedThesis["allocation"] =
    bundle.regime.label === "DEFENSIVE" || bundle.regime.label === "HIGH_VOL_CAUTION"
      ? [
          { asset: boxx?.fundId ?? "vBOXX", weightPct: 45, venue: "SoDEX Wealth / Spot" },
          { asset: "Morpho-Earn", weightPct: 30, venue: "SoDEX Bridged Vault" },
          { asset: "vMAG7ssi_vUSDC", weightPct: 15, venue: "SoDEX Spot CLOB" },
          { asset: "vXAUt_vUSDC", weightPct: 10, venue: "SoDEX Spot CLOB" }
        ]
      : [
          { asset: "vMAG7ssi_vUSDC", weightPct: 40, venue: "SoDEX Spot CLOB" },
          { asset: "vBTC_vUSDC", weightPct: 25, venue: "SoDEX Spot CLOB" },
          { asset: topRwa?.fundId ?? "Morpho-Earn", weightPct: 20, venue: "SoDEX Wealth Vault" },
          { asset: "vQQQ_vUSDC", weightPct: 15, venue: "SoDEX Spot CLOB" }
        ];

  let title = `${bundle.regime.label === "RISK_ON" ? "Risk-On Beta & SSI Capture" : "Barbell Defensive SSI + RWA Carry"}: ${promptFocus.slice(0, 48)}`;
  let summary = `Regime detected as ${bundle.regime.label} (${bundle.regime.confidence}% confidence) across ${bundle.spotTickers.length} SoDEX Spot pairs and ${bundle.perpsTickers.length} Perps contracts. ${bundle.regime.rationale.join(" ")} Proposed barbell allocates between liquid SSI index exposure and SoDEX Wealth yield/RWA buffers.`;
  let direction: PublishedThesis["direction"] =
    bundle.regime.label === "RISK_ON" ? "LONG" : bundle.regime.label === "DEFENSIVE" ? "YIELD_ROTATE" : "HEDGE";
  let conviction = Math.min(92, Math.max(54, Math.round(bundle.regime.confidence * 0.92)));
  let aiModel = "meridian-deterministic-quant-v1";
  let parsedAllocation = defaultAllocation;

  const allowedSymbols = new Set([
    ...bundle.spotTickers.map((s) => s.symbol),
    ...bundle.perpsTickers.map((p) => p.symbol),
    ...bundle.wealthFunds.map((w) => w.fundId)
  ]);

  if (nvidiaApiKey) {
    try {
      const compactFacts = {
        focus: promptFocus,
        regime: bundle.regime,
        valueChainBlock: bundle.valueChainMainnetBlock,
        topSpot: bundle.spotTickers.slice(0, 8).map((s) => ({
          sym: s.symbol,
          px: s.lastPx,
          chg24h: s.changePct,
          spreadBps: s.spreadBps
        })),
        topPerps: bundle.perpsTickers.slice(0, 6).map((p) => ({
          sym: p.symbol,
          mark: p.markPx,
          chg24h: p.changePct,
          funding: p.fundingRate
        })),
        wealthFunds: sanitizedWealth.slice(0, 8).map((w) => ({
          id: w.fundId,
          type: w.fundType,
          px: w.price,
          apy7d: w.cleanApy7d,
          apyAnomalyFiltered: w.apyAnomalyFiltered,
          roi1M: w.roi1M
        })),
        ssiParity: bundle.ssiParity,
        headlines: bundle.newsFeed.slice(0, 5).map((n) => ({ title: n.title, sentiment: n.sentiment })),
        sosoEtfNetInflowUsd: bundle.sosoOpenApi.etfNetInflowUsd
      };

      const res = await fetchJson<NimCompletionResponse>(
        `${DEFAULT_NIM_URL}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${nvidiaApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: DEFAULT_MODEL,
            temperature: 0.2,
            max_tokens: 1400,
            chat_template_kwargs: { enable_thinking: false },
            messages: [
              {
                role: "system",
                content:
                  "You are Meridian's Chief Quantitative Strategist. Return ONLY valid JSON with keys: title (string, <=80 chars), direction (LONG|HEDGE|YIELD_ROTATE|NEUTRAL), conviction (integer 50-95), summary (string, 2-3 concise sentences citing ONLY numbers from the provided JSON; never cite null or anomaly-filtered APYs), allocation (array of 3-4 {asset, weightPct, venue} summing to 100 using ONLY symbols present in the facts; in DEFENSIVE regimes cap single RWA/Pre-IPO sleeves <=35% and favor vBOXX/Morpho-Earn)."
              },
              {
                role: "user",
                content: JSON.stringify(compactFacts)
              }
            ]
          })
        },
        14000
      );

      const raw = res.choices?.[0]?.message?.content ?? "";
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<PublishedThesis>;
        const titleStr = String(parsed.title ?? "");
        const summaryStr = String(parsed.summary ?? "");
        if (titleStr && summaryStr && !hasHallucinatedPercentage(titleStr) && !hasHallucinatedPercentage(summaryStr)) {
          title = String(parsed.title).slice(0, 90);
          summary = summaryStr.slice(0, 600);
          if (
            parsed.direction === "LONG" ||
            parsed.direction === "HEDGE" ||
            parsed.direction === "YIELD_ROTATE" ||
            parsed.direction === "NEUTRAL"
          ) {
            direction = parsed.direction;
          }
          if (typeof parsed.conviction === "number" && parsed.conviction >= 40 && parsed.conviction <= 98) {
            conviction = Math.round(parsed.conviction);
          }
          if (Array.isArray(parsed.allocation) && parsed.allocation.length >= 2) {
            const totalW = parsed.allocation.reduce((acc, x) => acc + (Number(x.weightPct) || 0), 0);
            const allValid = parsed.allocation.every((x) => allowedSymbols.has(String(x.asset)));
            if (totalW > 95 && totalW < 105 && allValid) {
              parsedAllocation = parsed.allocation.map((x) => ({
                asset: String(x.asset),
                weightPct: Number(x.weightPct),
                venue: String(x.venue || "SoDEX")
              }));
            }
          }
          // Enforce direction / allocation coherence: HEDGE or YIELD_ROTATE must not allocate >60% to high-beta crypto/equities
          const defensiveSet = new Set(["vBOXX", "vBOXX_vUSDC", "Morpho-Earn", "vXAUt_vUSDC", "vUSDT_vUSDC"]);
          const defWeight = parsedAllocation
            .filter((a) => defensiveSet.has(a.asset))
            .reduce((acc, a) => acc + a.weightPct, 0);
          if ((direction === "HEDGE" || direction === "YIELD_ROTATE") && defWeight < 40) {
            direction = bundle.regime.label === "RISK_ON" ? "LONG" : "NEUTRAL";
          }
          aiModel = DEFAULT_MODEL;
        }
      }
    } catch {
      // Keep deterministic quantitative thesis on network/timeout issues
    }
  }

  const targetAsset = parsedAllocation[0]?.asset ?? "vMAG7ssi_vUSDC";
  const firewallVerdict: PublishedThesis["firewallVerdict"] =
    liveFirewall?.verdict ?? (bundle.regime.label === "HIGH_VOL_CAUTION" ? "CAUTION" : "APPROVE");

  if (liveFirewall) {
    defaultEvidence.push({
      metric: `Pre-Trade Risk Firewall (${liveFirewall.symbol})`,
      value: `${liveFirewall.verdict} (risk ${liveFirewall.riskScore}/100, slip ${liveFirewall.slippageBps.toFixed(1)} bps, spread ${liveFirewall.spreadBps.toFixed(1)} bps)`,
      source: liveFirewall.marketType === "wealth" ? "SoDEX Wealth API" : "SoDEX Spot CLOB"
    });
  }

  const id = `th_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const unsignedThesis: Omit<PublishedThesis, "sha256Digest"> = {
    id,
    createdAt: now,
    title,
    regime: bundle.regime.label,
    confidence: bundle.regime.confidence,
    conviction,
    targetAsset,
    direction,
    summary,
    evidence: defaultEvidence,
    allocation: parsedAllocation,
    firewallVerdict,
    aiModel
  };
  const sha256Digest = await computeThesisDigest(unsignedThesis);

  return {
    ...unsignedThesis,
    sha256Digest
  };
}
