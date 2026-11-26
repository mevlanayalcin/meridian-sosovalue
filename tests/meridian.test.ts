import { describe, expect, it, vi } from "vitest";
import { verifyTypedData, keccak256, toHex, hashTypedData } from "viem";
import {
  buildExchangeActionTypedData,
  buildMetaMaskTypedDataV4,
  buildPerpsOrderPayload,
  buildSpotOrderPayload,
  normalizeSoDexSignature,
  roundToStep,
  signExchangeActionWithKey
} from "../src/engine/sodex-eip712";
import { evaluateTradeFirewall, simulateBookFill } from "../src/engine/firewall";
import { detectMarketRegime, runBasketBacktest } from "../src/engine/quant";
import { hasHallucinatedPercentage, sanitizeVaultApy } from "../src/engine/ai-analyst";
import { scaleTokenSupply } from "../src/providers/onchain";
import { parseFomcNextProbabilities, SoSoValueClient } from "../src/providers/sosovalue";
import { classifyHeadlineSentiment } from "../src/providers/news-fallback";
import { handleMcpRequest } from "../src/worker/mcp";
import { app } from "../src/worker/index";
import type { OrderbookSnapshot } from "../src/shared/types";

describe("SoDEX EIP-712 Protocol Serialization, Tick Rounding & MetaMask Parity", () => {
  it("preserves exact Go struct key order in Spot BatchNewOrder payloadHash", () => {
    const built = buildSpotOrderPayload({
      accountID: 1010,
      symbolID: 7,
      clOrdID: "mrd-spot-1",
      side: 1,
      type: 1,
      timeInForce: 1,
      price: "0.3860",
      quantity: "100"
    });
    expect(built.canonicalJson).toBe(
      '{"type":"batchNewOrder","params":{"accountID":1010,"orders":[{"symbolID":7,"clOrdID":"mrd-spot-1","side":1,"type":1,"timeInForce":1,"price":"0.3860","quantity":"100"}]}}'
    );
    expect(built.payloadHash).toBe(keccak256(toHex(built.canonicalJson)));
  });

  it("preserves exact Go struct key order in Perps NewOrder payloadHash", () => {
    const built = buildPerpsOrderPayload({
      accountID: 12345,
      symbolID: 1,
      clOrdID: "my-order-1",
      modifier: 1,
      side: 1,
      type: 2,
      timeInForce: 3,
      quantity: "0.001",
      reduceOnly: false,
      positionSide: 1
    });
    expect(built.canonicalJson).toBe(
      '{"type":"newOrder","params":{"accountID":12345,"symbolID":1,"orders":[{"clOrdID":"my-order-1","modifier":1,"side":1,"type":2,"timeInForce":3,"quantity":"0.001","reduceOnly":false,"positionSide":1}]}}'
    );
  });

  it("includes explicit EIP712Domain for MetaMask v4 matching viem digest byte-for-byte", () => {
    const payloadHash = keccak256(toHex("test-order"));
    const nonce = 1795550000123;
    const viemTd = buildExchangeActionTypedData("spot", "testnet", payloadHash, nonce);
    const mmTd = buildMetaMaskTypedDataV4("spot", "testnet", payloadHash, nonce);

    expect(mmTd.types.EIP712Domain).toHaveLength(4);
    expect(mmTd.types.EIP712Domain.map((f) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);

    const viemDigest = hashTypedData(viemTd);
    const mmDigest = hashTypedData({
      domain: mmTd.domain,
      types: { ExchangeAction: mmTd.types.ExchangeAction },
      primaryType: mmTd.primaryType,
      message: { payloadHash: mmTd.message.payloadHash, nonce: BigInt(mmTd.message.nonce) }
    });
    expect(mmDigest).toBe(viemDigest);
  });

  it("rounds prices & quantities via symbol tickSize/stepSize and strips trailing zeros for SoDEX API", () => {
    expect(roundToStep(0.00000843, "0.00000001")).toBe("0.00000843");
    expect(roundToStep(0.386, "0.0001")).toBe("0.386");
    expect(roundToStep(0.001, "0.00001")).toBe("0.001");
    expect(roundToStep(50, "0.00001")).toBe("50");
    expect(roundToStep(95432.67, "0.1")).toBe("95432.7");
  });

  it("produces verifiable 0x01-prefixed EIP-712 ExchangeAction signature on testnet 138565", async () => {
    const testPrivKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const built = buildPerpsOrderPayload({
      accountID: 55,
      symbolID: 1,
      clOrdID: "verify-1",
      side: 1,
      type: 2,
      timeInForce: 3,
      quantity: "0.01"
    });
    const nonce = 1795550000123;
    const signed = await signExchangeActionWithKey(testPrivKey, "futures", "testnet", built.payloadHash, nonce);
    expect(signed.wireSignature.startsWith("0x01")).toBe(true);
    expect(signed.wireSignature.length).toBe(134);
    // Normalization must be idempotent
    expect(normalizeSoDexSignature(signed.wireSignature)).toBe(signed.wireSignature);

    const rawBody = signed.wireSignature.slice(4);
    const vNorm = Number.parseInt(rawBody.slice(-2), 16);
    expect([0, 1]).toContain(vNorm);
    const ethSig = `0x${rawBody.slice(0, -2)}${(vNorm + 27).toString(16)}` as `0x${string}`;
    const td = buildExchangeActionTypedData("futures", "testnet", built.payloadHash, nonce);
    const ok = await verifyTypedData({
      address: signed.signerAddress,
      domain: td.domain,
      types: td.types,
      primaryType: "ExchangeAction",
      message: td.message,
      signature: ethSig
    });
    expect(ok).toBe(true);
  });
});

describe("Pre-Trade Risk Firewall (Fail-Closed & Edge Cases)", () => {
  const sampleBook: OrderbookSnapshot = {
    marketType: "spot",
    symbol: "vMAG7ssi_vUSDC",
    bestBid: 0.386,
    bestAsk: 0.387,
    midPrice: 0.3865,
    spreadBps: 25.87,
    bidDepthUsd: 2500,
    askDepthUsd: 2400,
    imbalanceRatio: 0.02,
    bids: [
      { price: 0.386, size: 3000, notionalUsd: 1158, cumNotionalUsd: 1158 },
      { price: 0.385, size: 3500, notionalUsd: 1347.5, cumNotionalUsd: 2505.5 }
    ],
    asks: [
      { price: 0.387, size: 3000, notionalUsd: 1161, cumNotionalUsd: 1161 },
      { price: 0.391, size: 3200, notionalUsd: 1251.2, cumNotionalUsd: 2412.2 }
    ],
    blockHeight: 1000,
    blockTime: 1795550000
  };

  it("approves small well-within-depth order with tight spread", async () => {
    const res = await evaluateTradeFirewall(
      { marketType: "spot", symbol: "vMAG7ssi_vUSDC", side: "BUY", notionalUsd: 500, portfolioTotalUsd: 10_000 },
      { orderbook: sampleBook, intradayVolPct: 3.1, venueChannelStatus: "clob", referencePrice: 0.3865, assetFound: true }
    );
    expect(res.verdict).toBe("APPROVE");
    expect(res.slippageBps).toBeLessThan(20);
    expect(res.sha256Digest).toHaveLength(64);
  });

  it("returns recommendedMaxUsd === 0 when existing position already exhausts concentration cap", async () => {
    const res = await evaluateTradeFirewall(
      {
        marketType: "spot",
        symbol: "vMAG7ssi_vUSDC",
        side: "BUY",
        notionalUsd: 500,
        portfolioTotalUsd: 10_000,
        existingAssetUsd: 4000,
        maxConcentrationPct: 35
      },
      { orderbook: sampleBook, intradayVolPct: 3.1, venueChannelStatus: "clob", referencePrice: 0.3865, assetFound: true }
    );
    expect(res.recommendedMaxUsd).toBe(0);
    expect(res.verdict).not.toBe("APPROVE");
  });

  it("blocks unknown/unlisted Wealth vaults rather than approving", async () => {
    const res = await evaluateTradeFirewall(
      { marketType: "wealth", symbol: "NON_EXISTENT_VAULT", side: "BUY", notionalUsd: 500 },
      { orderbook: null, intradayVolPct: 4.5, venueChannelStatus: "not_found", referencePrice: 0, assetFound: false }
    );
    expect(res.verdict).toBe("BLOCK");
    expect(res.recommendedMaxUsd).toBe(0);
  });

  it("blocks oversized order exhausting L2 depth & breaching concentration", async () => {
    const res = await evaluateTradeFirewall(
      { marketType: "spot", symbol: "vMAG7ssi_vUSDC", side: "BUY", notionalUsd: 8000, portfolioTotalUsd: 10_000 },
      { orderbook: sampleBook, intradayVolPct: 4.5, venueChannelStatus: "clob", referencePrice: 0.3865, assetFound: true }
    );
    expect(res.verdict).toBe("BLOCK");
    expect(res.recommendedMaxUsd).toBeLessThan(3000);
  });

  it("blocks orders on closed or HALT venue channels", async () => {
    const sim = simulateBookFill(sampleBook.asks, 200, 0.3865, "BUY", 60);
    expect(sim.filledUsd).toBe(200);
    const res = await evaluateTradeFirewall(
      { marketType: "wealth", symbol: "CXMT", side: "BUY", notionalUsd: 500 },
      { orderbook: null, intradayVolPct: 2.0, venueChannelStatus: "closed:market_closed", referencePrice: 5.71, assetFound: true }
    );
    expect(res.verdict).toBe("BLOCK");

    const halted = await evaluateTradeFirewall(
      { marketType: "spot", symbol: "vAMD_vUSDC", side: "BUY", notionalUsd: 200 },
      { orderbook: sampleBook, intradayVolPct: 2.0, venueChannelStatus: "HALT", referencePrice: 0.3865, assetFound: true }
    );
    expect(halted.verdict).toBe("BLOCK");
  });

  it("blocks off-market limit price collar bypasses (e.g. SELL at 99% below mid)", async () => {
    const res = await evaluateTradeFirewall(
      { marketType: "spot", symbol: "vMAG7ssi_vUSDC", side: "SELL", notionalUsd: 500, portfolioTotalUsd: 100_000 },
      { orderbook: sampleBook, intradayVolPct: 2.5, venueChannelStatus: "NORMAL", referencePrice: 0.3865, assetFound: true, limitPrice: 0.01 }
    );
    expect(res.verdict).toBe("BLOCK");
    expect(res.checks.some((c) => c.name.includes("Price Collar") && c.status === "FAIL")).toBe(true);
  });

  it("blocks oversized Wealth vault orders exceeding single-clip cap (e.g. $5M SELL UNITREE)", async () => {
    const res = await evaluateTradeFirewall(
      { marketType: "wealth", symbol: "UNITREE", side: "SELL", notionalUsd: 5_000_000, portfolioTotalUsd: 10_000_000 },
      { orderbook: null, intradayVolPct: 4.5, venueChannelStatus: "rfq", referencePrice: 5.2, assetFound: true }
    );
    expect(res.verdict).toBe("BLOCK");
    expect(res.recommendedMaxUsd).toBe(25_000);
  });
});

describe("On-Chain 8-Decimal SSI Supply, APY Sanitizer & SoSoValue Client", () => {
  it("scales Base 8-decimal SSI totalSupply accurately (~167M instead of 0.0167)", () => {
    const raw8Dec = 167_000_000_00000000n;
    expect(scaleTokenSupply(raw8Dec, 8)).toBe(167_000_000);
  });

  it("filters pathological APY outliers & equity 7d swings and catches >=1000% hallucinations without false-positiving funding rates", () => {
    expect(sanitizeVaultApy(215214.5)).toBeNull();
    expect(sanitizeVaultApy(-64.58)).toBeNull();
    expect(sanitizeVaultApy(8.423)).toBe(8.42);
    expect(hasHallucinatedPercentage("UNITREE offers 215,214% APY right now.")).toBe(true);
    expect(hasHallucinatedPercentage("Annualized return of 61,338.43% APY")).toBe(true);
    expect(hasHallucinatedPercentage("Extreme 215214% yield")).toBe(true);
    expect(hasHallucinatedPercentage("Spaced 61338 % outlier")).toBe(true);
    expect(hasHallucinatedPercentage("Written out 61338 percent yield")).toBe(true);
    expect(hasHallucinatedPercentage("British 61338 per cent yield")).toBe(true);
    expect(hasHallucinatedPercentage("Abbreviated 61338 pct yield")).toBe(true);
    expect(hasHallucinatedPercentage("Fullwidth 61338％ yield")).toBe(true);
    expect(hasHallucinatedPercentage("Morpho-Earn carries 8.42% APY")).toBe(false);
    expect(hasHallucinatedPercentage("BTC-USD Perp funding rate is 0.0013% (-0.0009% 8h)")).toBe(false);
  });

  it("parses live SoSoValue FOMC rate_ranges + string arrays cleanly and ignores null cells", () => {
    const parsed = parseFomcNextProbabilities({
      rate_ranges: ["375-400", "400-425", "425-450"],
      meetings: [
        {
          meeting_date: "2026-12-09",
          probabilities: ["1.1", "98.9", null]
        }
      ]
    });
    expect(parsed.meetingDate).toBe("2026-12-09");
    expect(parsed.probabilities).toEqual([
      { rateRange: "375-400", probabilityPct: 1.1 },
      { rateRange: "400-425", probabilityPct: 98.9 }
    ]);
  });

  it("classifies exchange breach, crash, and security incident headlines as BEARISH", () => {
    expect(classifyHeadlineSentiment("Bithumb data breach exposes customer records")).toBe("BEARISH");
    expect(classifyHeadlineSentiment("Market crashes as leverage unwinds")).toBe("BEARISH");
    expect(classifyHeadlineSentiment("Hackers steal $100M from DeFi bridge")).toBe("BEARISH");
    expect(classifyHeadlineSentiment("Record exchange hack drains $40M in hot wallet funds")).toBe("BEARISH");
    expect(classifyHeadlineSentiment("Spot Bitcoin ETF sees $450M institutional inflow")).toBe("BULLISH");
  });

  it("sends x-soso-api-key header and unwraps SoSoValue OpenAPI v1 envelopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, message: "ok", data: ["MAG7", "MEME", "DEFI"] })
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new SoSoValueClient("test-soso-key-123");
      const indices = await client.getIndices();
      expect(indices).toEqual(["MAG7", "MEME", "DEFI"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("https://openapi.sosovalue.com/openapi/v1/indices");
      expect(new Headers(calledInit.headers).get("x-soso-api-key")).toBe("test-soso-key-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Quantitative Regime (SoSoValue Overlay) & Periodic Backtest Engine", () => {
  it("drops legs with missing historical points instead of filling with $1 flat prices", () => {
    const dates = Array.from({ length: 20 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    const mkSeries = (start: number, step: number) =>
      dates.map((date, i) => ({ date, close: Number((start * (1 + step * i)).toFixed(4)) }));

    const result = runBasketBacktest(
      "Unit Test Barbell",
      [
        { symbol: "A", source: "spot", weight: 0.6, label: "Asset A" },
        { symbol: "B", source: "wealth", weight: 0.3, label: "Asset B" },
        { symbol: "MISSING", source: "spot", weight: 0.1, label: "Empty" }
      ],
      {
        A: { points: mkSeries(100, 0.01), source: "SoDEX Spot CLOB" },
        B: { points: mkSeries(50, 0.005), source: "SoDEX Wealth API" },
        MISSING: { points: [], source: "SoDEX Spot CLOB" }
      },
      mkSeries(10, 0.003),
      mkSeries(50000, 0.002),
      7,
      10
    );

    expect(result.legsEvaluated.map((l) => l.symbol)).toEqual(["A", "B"]);
    expect(result.daysAnalyzed).toBe(20);
    expect(result.totalReturnPct).toBeGreaterThan(10);
    expect(result.alphaVsSsiPct).toBeGreaterThan(0);
    expect(result.annualizedSharpe).toBeGreaterThan(1);
    expect(result.equityCurve).toHaveLength(20);
  });

  it("integrates SoSoValue ETF net-flows directly into regime classification & confidence", () => {
    const borderSpot = [
      { symbol: "vBTC_vUSDC", lastPx: 60000, openPx: 59700, highPx: 60500, lowPx: 59500, volume: 100, quoteVolume: 6e6, changePct: 0.6, bidPx: 59990, askPx: 60010, spreadBps: 3.3 },
      { symbol: "vETH_vUSDC", lastPx: 3200, openPx: 3180, highPx: 3220, lowPx: 3160, volume: 200, quoteVolume: 6.4e5, changePct: 0.5, bidPx: 3199, askPx: 3201, spreadBps: 6.2 },
      { symbol: "vSOL_vUSDC", lastPx: 140, openPx: 139, highPx: 141, lowPx: 138, volume: 300, quoteVolume: 4.2e4, changePct: 0.4, bidPx: 139.9, askPx: 140.1, spreadBps: 14.3 }
    ];
    const withoutEtf = detectMarketRegime(borderSpot, [], []);
    const withBigInflow = detectMarketRegime(borderSpot, [], [], { etfNetInflowUsd: 420_000_000 });
    expect(withoutEtf.label).toBe("ROTATION");
    expect(withBigInflow.label).toBe("RISK_ON");
    expect(withBigInflow.rationale.some((r) => r.includes("SoSoValue BTC Spot ETF"))).toBe(true);
  });
});

describe("Worker API, Batch Anti-Splitting, Security Headers & MCP JSON-RPC Endpoints", () => {
  it("responds healthy on /health with strict security headers and serves OpenAPI 3.0.3 schema", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const oas = await app.request("/api/v1/openapi.json");
    expect(oas.status).toBe(200);
    const spec = (await oas.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.paths["/mcp"]).toBeDefined();
    expect(spec.paths["/api/v1/execution/submit"]).toBeDefined();
  });

  it("handles MCP initialize, notifications/initialized (202), batch arrays (200), and 6 tools", async () => {
    const init = (await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
      result?: { serverInfo?: { name: string } };
    };
    expect(init.result?.serverInfo?.name).toBe("meridian-finance-mcp");

    const notifRes = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });
    expect(notifRes.status).toBe(202);

    const batchRes = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 10, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 11, method: "tools/list" }
      ])
    });
    expect(batchRes.status).toBe(200);
    const batchJson = (await batchRes.json()) as Array<{ id: number }>;
    expect(batchJson).toHaveLength(2);
    expect(batchJson.map((x) => x.id)).toEqual([10, 11]);

    const tools = (await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(tools.result?.tools?.length).toBeGreaterThanOrEqual(6);
    expect(tools.result?.tools?.some((t) => t.name === "meridian_sosovalue_macro")).toBe(true);
  });

  it("blocks HALT symbols consistently via MCP meridian_check_trade_firewall", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/spot/markets/symbols")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: [{ id: 99, name: "vSPCX_vUSDC", status: "HALT", tickSize: "0.01", stepSize: "0.01" }]
          })
        };
      }
      if (url.includes("/spot/markets/tickers")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: [
              {
                symbol: "vSPCX_vUSDC",
                lastPx: "120",
                openPx: "120",
                highPx: "121",
                lowPx: "119",
                volume: "10",
                quoteVolume: "1200",
                changePct: 0,
                bidPx: "119.9",
                askPx: "120.1"
              }
            ]
          })
        };
      }
      if (url.includes("/orderbook")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              bids: [["119.9", "100"]],
              asks: [["120.1", "100"]],
              blockHeight: 1,
              blockTime: 1
            }
          })
        };
      }
      return { ok: true, json: async () => ({ code: 0, data: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = (await handleMcpRequest({
        jsonrpc: "2.0",
        id: 55,
        method: "tools/call",
        params: {
          name: "meridian_check_trade_firewall",
          arguments: { marketType: "spot", symbol: "vSPCX_vUSDC", side: "BUY", notionalUsd: 500 }
        }
      })) as { result?: { content?: Array<{ text: string }> } };
      const parsed = JSON.parse(res.result?.content?.[0]?.text ?? "{}") as { verdict: string; venueChannelStatus: string };
      expect(parsed.verdict).toBe("BLOCK");
      expect(parsed.venueChannelStatus).toBe("HALT");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defeats batch order-splitting on /api/v1/execution/submit (20 x 0.25 vBTC exceeding book depth -> 403)", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/spot/markets/symbols")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: [{ id: 1, name: "vBTC_vUSDC", status: "NORMAL", tickSize: "0.1", stepSize: "0.0001" }]
          })
        };
      }
      if (url.includes("/spot/markets/tickers")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: [
              {
                symbol: "vBTC_vUSDC",
                lastPx: "60000",
                openPx: "59900",
                highPx: "60500",
                lowPx: "59500",
                volume: "100",
                quoteVolume: "6000000",
                changePct: 0.16,
                bidPx: "59995",
                askPx: "60005"
              }
            ]
          })
        };
      }
      if (url.includes("/orderbook")) {
        // Total bid depth = $180,000 -> single 0.25 BTC ($15k) passes easily, 20 x 0.25 BTC ($300k) exhausts book!
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              bids: [
                ["59995", "1.5"],
                ["59980", "1.5"]
              ],
              asks: [
                ["60005", "1.5"],
                ["60020", "1.5"]
              ],
              blockHeight: 1,
              blockTime: 1
            }
          })
        };
      }
      return { ok: true, json: async () => ({ code: 0, data: {} }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const splitOrders = Array.from({ length: 20 }, (_, i) => ({
        symbolID: 1,
        clOrdID: `split-${i}`,
        side: 2,
        type: 2,
        timeInForce: 3,
        quantity: "0.25"
      }));
      const res = await app.request("/api/v1/execution/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "mainnet",
          marketType: "spot",
          httpBody: { accountID: 1001, orders: splitOrders },
          wireSignature: "0x01" + "ab".repeat(65),
          nonce: Date.now()
        })
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok: boolean; blocked: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.blocked).toBe(true);
      expect(body.error).toContain("Batch submission rejected");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
