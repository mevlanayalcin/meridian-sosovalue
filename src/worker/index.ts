import { Hono } from "hono";
import { cors } from "hono/cors";
import { generatePrivateKey } from "viem/accounts";
import { buildMarketOverview } from "./overview";
import { handleMcpRequest } from "./mcp";
import { SoDexClient, SODEX_MAINNET, SODEX_TESTNET } from "../providers/sodex";
import { fetchJson, sha256Hex } from "../providers/http";
import { runFirewallWithLiveData } from "../engine/live-firewall";
import { runBasketBacktest } from "../engine/quant";
import { generateGroundedThesis } from "../engine/ai-analyst";
import {
  buildMetaMaskTypedDataV4,
  buildPerpsOrderPayload,
  buildSpotOrderPayload,
  getSoDexBaseUrl,
  normalizeSoDexSignature,
  roundToStep,
  signExchangeActionWithKey,
  type SoDexNetwork
} from "../engine/sodex-eip712";
import type { BasketLeg, FirewallCheckRequest, PublishedThesis } from "../shared/types";

export interface Env {
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  DB?: D1Database;
  SOSOVALUE_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  TAVILY_API_KEY?: string;
}

const ALLOWED_MUTATION_ORIGINS = new Set([
  "https://meridian.bedir-ai.workers.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
]);

const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function checkRateLimit(bucket: string, ip: string, maxPerMin: number): boolean {
  if (!ip) return true;
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const prev = (rateBuckets.get(key) ?? []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (prev.length >= maxPerMin) {
    rateBuckets.set(key, prev);
    return false;
  }
  prev.push(now);
  rateBuckets.set(key, prev);
  if (rateBuckets.size > 1000) rateBuckets.clear();
  return true;
}

function getClientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

const app = new Hono<{ Bindings: Env }>();

// Strict security headers on all responses (HTML, assets, REST API, MCP)
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  );
});

// Public read endpoints & /mcp allow cross-origin agent access; state-mutating / paid-key POSTs restrict browser Origin
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      if (!origin) return "";
      if (c.req.method === "GET" || c.req.method === "HEAD") return origin;
      return ALLOWED_MUTATION_ORIGINS.has(origin) ? origin : "";
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Soso-Api-Key"]
  })
);
app.use(
  "/mcp",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Soso-Api-Key"]
  })
);

function resolveSosoKey(c: { req: { header: (k: string) => string | undefined }; env?: Env }) {
  const hdr = c.req.header("x-soso-api-key")?.trim();
  if (hdr) return { key: hdr, origin: "request_header" as const };
  if (c.env?.SOSOVALUE_API_KEY) return { key: c.env?.SOSOVALUE_API_KEY, origin: "server_env" as const };
  return { key: undefined, origin: "none" as const };
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "meridian-finance-desk",
    timestamp: new Date().toISOString(),
    hasServerSosoKey: Boolean(c.env?.SOSOVALUE_API_KEY),
    hasAiKey: Boolean(c.env?.NVIDIA_API_KEY),
    hasDatabase: Boolean(c.env?.DB)
  })
);

app.get("/api/v1/overview", async (c) => {
  try {
    const { key, origin } = resolveSosoKey(c);
    const bundle = await buildMarketOverview({
      sosoApiKey: key,
      keyOrigin: origin,
      tavilyApiKey: c.env?.TAVILY_API_KEY
    });
    return c.json({ ok: true, data: bundle });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Overview fetch failed" }, 500);
  }
});

app.get("/api/v1/orderbook/:marketType/:symbol", async (c) => {
  const marketType = c.req.param("marketType") === "perps" ? "perps" : "spot";
  const symbol = c.req.param("symbol");
  const sodex = new SoDexClient();
  try {
    const book = await sodex.getOrderbook(marketType, symbol, 30);
    return c.json({ ok: true, data: book });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Orderbook fetch failed" }, 502);
  }
});

app.post("/api/v1/firewall/check", async (c) => {
  if (!checkRateLimit("firewall", getClientIp(c), 40)) {
    return c.json({ ok: false, error: "Rate limit exceeded on firewall checks. Please retry shortly." }, 429);
  }
  try {
    const body = (await c.req.json()) as FirewallCheckRequest;
    const result = await runFirewallWithLiveData(body);

    if (c.env?.DB) {
      await c.env?.DB.prepare(
        `INSERT INTO firewall_audits (id, created_at, market_type, symbol, side, notional_usd, verdict, slippage_bps, spread_bps, risk_score, reasons_json, sha256_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          result.id,
          result.createdAt,
          result.marketType,
          result.symbol,
          result.side,
          result.requestedNotionalUsd,
          result.verdict,
          result.slippageBps,
          result.spreadBps,
          result.riskScore,
          JSON.stringify(result.checks),
          result.sha256Digest
        )
        .run()
        .catch(() => undefined);
    }

    return c.json({ ok: true, data: result });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Firewall check failed" }, 400);
  }
});

app.get("/api/v1/firewall/audits", async (c) => {
  if (!c.env?.DB) return c.json({ ok: true, data: [] });
  const rows = await c.env?.DB.prepare(
    "SELECT id, created_at, market_type, symbol, side, notional_usd, verdict, slippage_bps, spread_bps, risk_score, sha256_digest FROM firewall_audits ORDER BY created_at DESC LIMIT 20"
  )
    .all()
    .catch(() => ({ results: [] }));
  return c.json({ ok: true, data: rows.results ?? [] });
});

app.post("/api/v1/backtest", async (c) => {
  try {
    const body = (await c.req.json()) as {
      basketName?: string;
      legs?: BasketLeg[];
      rebalanceIntervalDays?: number;
      feeBps?: number;
      persist?: boolean;
    };
    const legs: BasketLeg[] = body.legs?.length
      ? body.legs
      : [
          { symbol: "vMAG7ssi_vUSDC", source: "spot", weight: 0.4, label: "MAG7.ssi" },
          { symbol: "vQQQ_vUSDC", source: "spot", weight: 0.3, label: "vQQQ" },
          { symbol: "vBOXX_vUSDC", source: "spot", weight: 0.15, label: "vBOXX" },
          { symbol: "UNITREE", source: "wealth", weight: 0.15, label: "Unitree RWA" }
        ];

    const sodex = new SoDexClient();
    const [seriesArr, ssiBench, btcBench] = await Promise.all([
      Promise.all(
        legs.map(async (l) => ({
          symbol: l.symbol,
          points:
            l.source === "wealth"
              ? await sodex.getWealthPriceHistory(l.symbol, "3M").catch(() => [])
              : await sodex.getKlines("spot", l.symbol, "1d", 60).catch(() => []),
          source: l.source === "wealth" ? ("SoDEX Wealth API" as const) : ("SoDEX Spot CLOB" as const)
        }))
      ),
      sodex.getKlines("spot", "vMAG7ssi_vUSDC", "1d", 60),
      sodex.getKlines("spot", "vBTC_vUSDC", "1d", 60)
    ]);

    const seriesMap = Object.fromEntries(seriesArr.map((x) => [x.symbol, { points: x.points, source: x.source }]));
    const result = runBasketBacktest(
      body.basketName ?? "Meridian Custom SSI + RWA Basket",
      legs,
      seriesMap,
      ssiBench,
      btcBench,
      body.rebalanceIntervalDays ?? 7,
      body.feeBps ?? 10
    );

    if (body.persist && c.env?.DB) {
      const id = `bsk_${Date.now().toString(36)}`;
      const digest = await sha256Hex(JSON.stringify({ id, legs, result }));
      await c.env?.DB.prepare(
        "INSERT INTO baskets (id, created_at, name, thesis, weights_json, metrics_json, sha256_digest) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, new Date().toISOString(), result.basketName, "Custom adaptive basket", JSON.stringify(legs), JSON.stringify(result), digest)
        .run()
        .catch(() => undefined);
    }

    return c.json({ ok: true, data: result });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Backtest error" }, 400);
  }
});

app.get("/api/v1/baskets", async (c) => {
  if (!c.env?.DB) return c.json({ ok: true, data: [] });
  const rows = await c.env?.DB.prepare("SELECT * FROM baskets ORDER BY created_at DESC LIMIT 15")
    .all()
    .catch(() => ({ results: [] }));
  return c.json({ ok: true, data: rows.results ?? [] });
});

app.get("/api/v1/theses", async (c) => {
  if (!c.env?.DB) return c.json({ ok: true, data: [] });
  const rows = await c.env?.DB.prepare("SELECT * FROM theses ORDER BY created_at DESC LIMIT 20")
    .all()
    .catch(() => ({ results: [] }));
  const parsed = (rows.results ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    createdAt: r.created_at,
    title: r.title,
    regime: r.regime,
    confidence: r.confidence,
    conviction: r.conviction,
    targetAsset: r.target_asset,
    direction: r.direction,
    summary: r.summary,
    evidence: JSON.parse(String(r.evidence_json || "[]")),
    allocation: JSON.parse(String(r.allocation_json || "[]")),
    firewallVerdict: r.firewall_verdict,
    sha256Digest: r.sha256_digest,
    aiModel: r.author
  }));
  return c.json({ ok: true, data: parsed });
});

async function persistThesis(db: D1Database | undefined, thesis: PublishedThesis) {
  if (!db) return;
  await db
    .prepare(
      `INSERT INTO theses (id, created_at, title, regime, confidence, conviction, target_asset, direction, summary, evidence_json, allocation_json, firewall_verdict, sha256_digest, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      thesis.id,
      thesis.createdAt,
      thesis.title,
      thesis.regime,
      thesis.confidence,
      thesis.conviction,
      thesis.targetAsset,
      thesis.direction,
      thesis.summary,
      JSON.stringify(thesis.evidence),
      JSON.stringify(thesis.allocation),
      thesis.firewallVerdict,
      thesis.sha256Digest,
      thesis.aiModel
    )
    .run()
    .catch(() => undefined);
}

app.post("/api/v1/theses/generate", async (c) => {
  if (!checkRateLimit("theses", getClientIp(c), 12)) {
    return c.json({ ok: false, error: "Rate limit exceeded on AI thesis generation. Please retry in 60 seconds." }, 429);
  }
  try {
    const body = (await c.req.json().catch(() => ({}))) as { focus?: string };
    const { key, origin } = resolveSosoKey(c);
    const bundle = await buildMarketOverview({
      sosoApiKey: key,
      keyOrigin: origin,
      tavilyApiKey: c.env?.TAVILY_API_KEY
    });

    const draftThesis: PublishedThesis = await generateGroundedThesis(
      bundle,
      body.focus?.trim() || "Cross-asset SSI Index & RWA Capital Allocation",
      c.env?.NVIDIA_API_KEY,
      null
    );

    // Run real Pre-Trade Risk Firewall on the thesis's ACTUAL lead target asset
    const leadSymbol = draftThesis.targetAsset || "vMAG7ssi_vUSDC";
    const isWealthLead = bundle.wealthFunds.some((w) => w.fundId === leadSymbol);
    const isPerpsLead = !isWealthLead && bundle.perpsTickers.some((p) => p.symbol === leadSymbol);
    const liveFw = await runFirewallWithLiveData({
      marketType: isWealthLead ? "wealth" : isPerpsLead ? "perps" : "spot",
      symbol: leadSymbol,
      side: "BUY",
      notionalUsd: 1000,
      portfolioTotalUsd: 10_000
    }).catch(() => null);

    const thesis: PublishedThesis = liveFw
      ? {
          ...draftThesis,
          firewallVerdict: liveFw.verdict,
          evidence: [
            ...draftThesis.evidence,
            {
              metric: `Pre-Trade Risk Firewall (${liveFw.symbol})`,
              value: `${liveFw.verdict} (risk ${liveFw.riskScore}/100, slip ${liveFw.slippageBps.toFixed(1)} bps, spread ${liveFw.spreadBps.toFixed(1)} bps)`,
              source: liveFw.source
            }
          ]
        }
      : draftThesis;

    await persistThesis(c.env?.DB, thesis);
    return c.json({ ok: true, data: thesis });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Thesis generation failed" }, 500);
  }
});

app.post("/api/v1/execution/prepare", async (c) => {
  try {
    const body = (await c.req.json()) as {
      network: SoDexNetwork;
      marketType: "spot" | "perps";
      symbol: string;
      side: "BUY" | "SELL";
      orderType: "LIMIT" | "MARKET";
      price?: string;
      quantity: string;
      accountID?: number;
      portfolioTotalUsd?: number;
      existingAssetUsd?: number;
      maxSlippageBps?: number;
      maxConcentrationPct?: number;
      simulateEphemeralSign?: boolean;
    };

    const network: SoDexNetwork = body.network === "mainnet" ? "mainnet" : "testnet";
    const client = new SoDexClient(network === "mainnet" ? SODEX_MAINNET : SODEX_TESTNET);
    const mainnetClient = new SoDexClient(SODEX_MAINNET);

    const symbols =
      body.marketType === "spot"
        ? await client.getSpotSymbols().catch(() => mainnetClient.getSpotSymbols())
        : await client.getPerpsSymbols().catch(() => mainnetClient.getPerpsSymbols());

    const symMeta = symbols.find((s) => s.name === body.symbol);
    if (!symMeta) {
      return c.json(
        {
          ok: false,
          error: `Unknown ${body.marketType} symbol "${body.symbol}" on SoDEX ${network}.`
        },
        400
      );
    }

    const qtyNum = Number.parseFloat(body.quantity || "0");
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return c.json({ ok: false, error: "Order quantity must be a positive number." }, 400);
    }

    // ALWAYS resolve live market reference price so an off-market limit price (e.g. SELL 50 BTC @ $1)
    // cannot shrink notional or bypass the Pre-Trade Risk Firewall!
    let liveMidPx = 0;
    const book =
      (await client.getOrderbook(body.marketType, body.symbol, 20).catch(() => null)) ??
      (network === "testnet" ? await mainnetClient.getOrderbook(body.marketType, body.symbol, 20).catch(() => null) : null);
    if (book && book.midPrice > 0) {
      liveMidPx = book.midPrice;
    } else {
      const ticks =
        body.marketType === "spot"
          ? await client.getSpotTickers().catch(() => mainnetClient.getSpotTickers().catch(() => []))
          : await client.getPerpsTickers().catch(() => mainnetClient.getPerpsTickers().catch(() => []));
      const matched = ticks.find((t) => t.symbol === body.symbol);
      liveMidPx = matched?.lastPx ?? 0;
    }

    const userLimitPx = Number.parseFloat(body.price || "0");
    if (body.orderType === "LIMIT" && (!Number.isFinite(userLimitPx) || userLimitPx <= 0)) {
      return c.json({ ok: false, error: "LIMIT orders require a positive price." }, 400);
    }

    const effectivePriceForSizing =
      body.orderType === "LIMIT" ? Math.max(userLimitPx, liveMidPx) : liveMidPx;
    if (!Number.isFinite(effectivePriceForSizing) || effectivePriceForSizing <= 0) {
      return c.json({ ok: false, error: `Unable to resolve live market reference price for ${body.symbol}.` }, 400);
    }

    const computedNotionalUsd = effectivePriceForSizing * qtyNum;
    const firewall = await runFirewallWithLiveData(
      {
        marketType: body.marketType,
        symbol: body.symbol,
        side: body.side,
        notionalUsd: computedNotionalUsd,
        portfolioTotalUsd: body.portfolioTotalUsd,
        existingAssetUsd: body.existingAssetUsd,
        maxSlippageBps: body.maxSlippageBps,
        maxConcentrationPct: body.maxConcentrationPct
      },
      {
        network,
        limitPrice: body.orderType === "LIMIT" ? userLimitPx : undefined
      }
    );

    const nonce = Date.now();
    const endpoint =
      body.marketType === "spot"
        ? `${getSoDexBaseUrl(network)}/api/v1/spot/trade/orders/batch`
        : `${getSoDexBaseUrl(network)}/api/v1/perps/trade/orders`;

    // Hard fail-closed: BLOCK verdict refuses to produce a signable order payload
    if (firewall.verdict === "BLOCK") {
      return c.json({
        ok: true,
        data: {
          firewall,
          blocked: true,
          network,
          endpoint,
          nonce,
          symbolID: symMeta.id,
          computedNotionalUsd: Number(computedNotionalUsd.toFixed(2)),
          canonicalJson: null,
          payloadHash: null,
          httpBody: null,
          typedData: null,
          demoSigned: null
        }
      });
    }

    const clOrdID = `mrd_${nonce.toString(36)}`;
    const accountID = body.accountID && body.accountID > 0 ? Math.trunc(body.accountID) : 1001;
    const sideNum = body.side === "BUY" ? 1 : 2;
    const typeNum = body.orderType === "MARKET" ? 2 : 1;
    const tifNum = body.orderType === "MARKET" ? 3 : 1;

    const formattedPrice = body.orderType === "LIMIT" ? roundToStep(userLimitPx, symMeta.tickSize) : undefined;
    const formattedQty = roundToStep(qtyNum, symMeta.stepSize);

    const built =
      body.marketType === "spot"
        ? buildSpotOrderPayload({
            accountID,
            symbolID: symMeta.id,
            clOrdID,
            side: sideNum,
            type: typeNum,
            timeInForce: tifNum,
            price: formattedPrice,
            quantity: formattedQty
          })
        : buildPerpsOrderPayload({
            accountID,
            symbolID: symMeta.id,
            clOrdID,
            side: sideNum,
            type: typeNum,
            timeInForce: tifNum,
            price: formattedPrice,
            quantity: formattedQty
          });

    const domainName = body.marketType === "spot" ? "spot" : "futures";
    const typedDataV4 = buildMetaMaskTypedDataV4(domainName, network, built.payloadHash, nonce);

    let demoSigned: { signerAddress: string; wireSignature: string } | null = null;
    if (body.simulateEphemeralSign) {
      const ephKey = generatePrivateKey();
      const signed = await signExchangeActionWithKey(ephKey, domainName, network, built.payloadHash, nonce);
      demoSigned = { signerAddress: signed.signerAddress, wireSignature: signed.wireSignature };
    }

    return c.json({
      ok: true,
      data: {
        firewall,
        blocked: false,
        network,
        endpoint,
        nonce,
        symbolID: symMeta.id,
        computedNotionalUsd: Number(computedNotionalUsd.toFixed(2)),
        canonicalJson: built.canonicalJson,
        payloadHash: built.payloadHash,
        httpBody: built.params,
        typedData: typedDataV4,
        demoSigned
      }
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Execution preparation failed" }, 400);
  }
});

app.post("/api/v1/execution/submit", async (c) => {
  if (!checkRateLimit("submit", getClientIp(c), 15)) {
    return c.json({ ok: false, error: "Rate limit exceeded on order relay. Please retry in 60 seconds." }, 429);
  }
  try {
    const body = (await c.req.json()) as {
      network: SoDexNetwork;
      marketType: "spot" | "perps";
      symbol?: string;
      side?: "BUY" | "SELL";
      notionalUsd?: number;
      portfolioTotalUsd?: number;
      existingAssetUsd?: number;
      httpBody: unknown;
      wireSignature: string;
      nonce: number | string;
      apiKeyName?: string;
    };

    if (!body.wireSignature || !body.wireSignature.startsWith("0x") || body.wireSignature.length < 132) {
      return c.json({ ok: false, error: "Valid EIP-712 hex signature is required." }, 400);
    }

    const network: SoDexNetwork = body.network === "mainnet" ? "mainnet" : "testnet";
    const client = new SoDexClient(network === "mainnet" ? SODEX_MAINNET : SODEX_TESTNET);
    const mainnetClient = new SoDexClient(SODEX_MAINNET);

    // Derive order parameters EXCLUSIVELY from the signed httpBody (never trust client-supplied notionalUsd/symbol!)
    const rawBody = body.httpBody as {
      symbolID?: number;
      orders?: Array<{
        symbolID?: number;
        side?: number;
        type?: number;
        price?: string;
        quantity?: string;
        funds?: string;
      }>;
    } | null;

    if (!rawBody || !Array.isArray(rawBody.orders) || rawBody.orders.length === 0) {
      return c.json({ ok: false, error: "Signed httpBody must contain a non-empty orders array." }, 400);
    }
    if (rawBody.orders.length > 500) {
      return c.json({ ok: false, error: `Batch exceeds hard maximum 500 orders (got ${rawBody.orders.length}).` }, 400);
    }

    const symbols =
      body.marketType === "spot"
        ? await client.getSpotSymbols().catch(() => mainnetClient.getSpotSymbols())
        : await client.getPerpsSymbols().catch(() => mainnetClient.getPerpsSymbols());

    // Resolve live mid price once per unique symbol and aggregate all orders per (symbol, side)
    // in a single pass so both single-order off-market collars AND split batches (e.g. 20 x 2.5 or 100 x 0.5 vBTC)
    // are checked in constant upstream subrequests without exhausting Worker subrequest budgets.
    const midPxCache = new Map<string, number>();
    const aggregateBuckets = new Map<
      string,
      {
        symbol: string;
        side: "BUY" | "SELL";
        totalNotional: number;
        count: number;
        worstLimitPrice?: number;
        worstLimitDevPct: number;
      }
    >();

    for (const ord of rawBody.orders) {
      const symId = body.marketType === "spot" ? ord.symbolID : rawBody.symbolID;
      const symMeta = symbols.find((s) => s.id === symId);
      if (!symMeta) {
        return c.json({ ok: false, error: `Unknown ${body.marketType} symbolID ${String(symId)} inside signed httpBody.` }, 400);
      }

      const qty = Number.parseFloat(ord.quantity || "0");
      const funds = Number.parseFloat(ord.funds || "0");
      const orderPx = Number.parseFloat(ord.price || "0");

      let liveMidPx = midPxCache.get(symMeta.name) ?? 0;
      if (liveMidPx <= 0) {
        const book =
          (await client.getOrderbook(body.marketType, symMeta.name, 20).catch(() => null)) ??
          (network === "testnet" ? await mainnetClient.getOrderbook(body.marketType, symMeta.name, 20).catch(() => null) : null);
        if (book && book.midPrice > 0) {
          liveMidPx = book.midPrice;
        } else {
          const ticks =
            body.marketType === "spot"
              ? await client.getSpotTickers().catch(() => mainnetClient.getSpotTickers().catch(() => []))
              : await client.getPerpsTickers().catch(() => mainnetClient.getPerpsTickers().catch(() => []));
          liveMidPx = ticks.find((t) => t.symbol === symMeta.name)?.lastPx ?? 0;
        }
        if (liveMidPx > 0) midPxCache.set(symMeta.name, liveMidPx);
      }

      const marketNotional = qty > 0 && liveMidPx > 0 ? qty * liveMidPx : 0;
      const limitNotional = qty > 0 && orderPx > 0 ? qty * orderPx : 0;
      const derivedNotional = Math.max(marketNotional, limitNotional, Number.isFinite(funds) ? funds : 0);

      if (!Number.isFinite(derivedNotional) || derivedNotional <= 0) {
        return c.json({ ok: false, error: `Unable to derive positive order notional for ${symMeta.name}.` }, 400);
      }

      const side: "BUY" | "SELL" = ord.side === 2 ? "SELL" : "BUY";
      const bucketKey = `${symMeta.name}:${side}`;
      const limitPx = ord.type === 1 && orderPx > 0 ? orderPx : undefined;
      const devPct = limitPx !== undefined && liveMidPx > 0 ? (Math.abs(limitPx - liveMidPx) / liveMidPx) * 100 : -1;

      const prevBucket = aggregateBuckets.get(bucketKey);
      if (prevBucket) {
        prevBucket.totalNotional += derivedNotional;
        prevBucket.count += 1;
        if (limitPx !== undefined && devPct > prevBucket.worstLimitDevPct) {
          prevBucket.worstLimitPrice = limitPx;
          prevBucket.worstLimitDevPct = devPct;
        }
      } else {
        aggregateBuckets.set(bucketKey, {
          symbol: symMeta.name,
          side,
          totalNotional: derivedNotional,
          count: 1,
          worstLimitPrice: limitPx,
          worstLimitDevPct: devPct
        });
      }
    }

    // Evaluate each aggregated (symbol, side) exposure through the live Pre-Trade Risk Firewall
    for (const bucket of aggregateBuckets.values()) {
      const fw = await runFirewallWithLiveData(
        {
          marketType: body.marketType,
          symbol: bucket.symbol,
          side: bucket.side,
          notionalUsd: bucket.totalNotional,
          portfolioTotalUsd: body.portfolioTotalUsd,
          existingAssetUsd: body.existingAssetUsd
        },
        {
          network,
          limitPrice: bucket.worstLimitPrice
        }
      );
      if (fw.verdict === "BLOCK") {
        return c.json(
          {
            ok: false,
            blocked: true,
            firewall: fw,
            error:
              bucket.count > 1
                ? `Batch submission rejected by aggregate Pre-Trade Risk Firewall on ${bucket.symbol} (${bucket.count} split ${bucket.side} orders totaling $${bucket.totalNotional.toFixed(2)}, verdict=BLOCK).`
                : `Order submission rejected by server-side Pre-Trade Risk Firewall on ${bucket.symbol} (verdict=BLOCK, derived notional $${bucket.totalNotional.toFixed(2)}).`
          },
          403
        );
      }
    }

    const endpoint =
      body.marketType === "spot"
        ? `${getSoDexBaseUrl(network)}/api/v1/spot/trade/orders/batch`
        : `${getSoDexBaseUrl(network)}/api/v1/perps/trade/orders`;

    const normalizedSig = normalizeSoDexSignature(body.wireSignature as `0x${string}`, "0x01");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-Sign": normalizedSig,
      "X-API-Nonce": String(body.nonce)
    };
    if (body.apiKeyName) headers["X-API-Key"] = body.apiKeyName;

    const res = await fetchJson<{ code?: number; error?: string; message?: string; data?: unknown }>(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body.httpBody)
    });
    if (typeof res?.code === "number" && res.code !== 0) {
      return c.json(
        {
          ok: false,
          error: res.error || res.message || `SoDEX rejected order with code ${res.code}`,
          data: res
        },
        422
      );
    }
    return c.json({ ok: true, data: res });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "Order submission failed" }, 502);
  }
});

app.get("/api/v1/openapi.json", (c) =>
  c.json({
    openapi: "3.0.3",
    info: {
      title: "Meridian One-Person On-Chain Finance Business API",
      version: "1.1.0",
      description:
        "Published intelligence, Base 8-decimal SSI cross-venue parity, periodic-rebalanced backtests, and fail-closed pre-trade L2 Risk Firewall API powered by SoSoValue, SoDEX & ValueChain."
    },
    paths: {
      "/api/v1/overview": { get: { summary: "Live cross-asset overview, SoSoValue+SoDEX regime, SSI parity, Wealth RWA & news" } },
      "/api/v1/firewall/check": { post: { summary: "Deterministic L2 orderbook slippage & concentration risk firewall verdict" } },
      "/api/v1/backtest": { post: { summary: "Periodic-rebalanced basket backtest + 500-path Monte Carlo VaR95/CVaR99" } },
      "/api/v1/theses": { get: { summary: "List SHA-256 attested investment theses" } },
      "/api/v1/theses/generate": { post: { summary: "Synthesize evidence-grounded AI thesis with live Firewall verdict" } },
      "/api/v1/execution/prepare": { post: { summary: "Fail-closed SoDEX Go-struct EIP-712 ExchangeAction payload builder" } },
      "/api/v1/execution/submit": { post: { summary: "Firewall-verified SoDEX order relay" } },
      "/mcp": { post: { summary: "Model Context Protocol JSON-RPC 2.0 server (6 tools)" } }
    }
  })
);

app.post("/mcp", async (c) => {
  try {
    const body = await c.req.json();
    const { key } = resolveSosoKey(c);
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((item) => handleMcpRequest(item, { sosoApiKey: key })))).filter(
        (r) => r !== null
      );
      if (results.length === 0) return c.body(null, 202);
      return c.json(results);
    }
    const res = await handleMcpRequest(body, { sosoApiKey: key });
    if (res === null) {
      return c.body(null, 202);
    }
    return c.json(res);
  } catch (err) {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: err instanceof Error ? err.message : "Parse error" } }, 400);
  }
});

app.all("*", async (c) => {
  if (c.env?.ASSETS) {
    return c.env?.ASSETS.fetch(c.req.raw);
  }
  return c.text("Meridian API Worker running. Build client assets with `npm run build`.", 200);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env) {
    const bundle = await buildMarketOverview({
      sosoApiKey: env.SOSOVALUE_API_KEY,
      keyOrigin: env.SOSOVALUE_API_KEY ? "server_env" : "none",
      tavilyApiKey: env.TAVILY_API_KEY
    });
    const leadSymbol = bundle.spotTickers.find((s) => s.symbol === "vMAG7ssi_vUSDC")?.symbol ?? "vMAG7ssi_vUSDC";
    const liveFw = await runFirewallWithLiveData({
      marketType: "spot",
      symbol: leadSymbol,
      side: "BUY",
      notionalUsd: 1000,
      portfolioTotalUsd: 10_000
    }).catch(() => null);
    const thesis = await generateGroundedThesis(
      bundle,
      "Scheduled 6h Autonomous Cross-Asset Regime & SSI Parity Brief",
      env.NVIDIA_API_KEY,
      liveFw
    );
    await persistThesis(env.DB, thesis);
  }
};
export { app };
