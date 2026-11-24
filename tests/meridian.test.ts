import { describe, expect, it } from "vitest";
import { verifyTypedData, keccak256, toHex } from "viem";
import {
  buildExchangeActionTypedData,
  buildPerpsOrderPayload,
  buildSpotOrderPayload,
  signExchangeActionWithKey
} from "../src/engine/sodex-eip712";
import { evaluateTradeFirewall, simulateBookFill } from "../src/engine/firewall";
import { detectMarketRegime, runBasketBacktest } from "../src/engine/quant";
import { handleMcpRequest } from "../src/worker/mcp";
import app from "../src/worker/index";
import type { OrderbookSnapshot } from "../src/shared/types";

describe("SoDEX EIP-712 Protocol Serialization & Signing", () => {
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
    expect(signed.wireSignature.length).toBe(134); // 0x01 (4 chars) + 65 bytes (130 hex chars)

    // Convert normalized recovery (00/01) back to 27/28 for viem verifyTypedData check
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

describe("Pre-Trade Risk Firewall", () => {
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
      { orderbook: sampleBook, intradayVolPct: 3.1, venueChannelStatus: "clob", referencePrice: 0.3865 }
    );
    expect(res.verdict).toBe("APPROVE");
    expect(res.slippageBps).toBeLessThan(20);
    expect(res.sha256Digest).toHaveLength(64);
  });

  it("blocks oversized order exhausting L2 depth & breaching concentration", async () => {
    const res = await evaluateTradeFirewall(
      { marketType: "spot", symbol: "vMAG7ssi_vUSDC", side: "BUY", notionalUsd: 8000, portfolioTotalUsd: 10_000 },
      { orderbook: sampleBook, intradayVolPct: 4.5, venueChannelStatus: "clob", referencePrice: 0.3865 }
    );
    expect(res.verdict).toBe("BLOCK");
    expect(res.recommendedMaxUsd).toBeLessThan(3000);
  });

  it("blocks orders on closed venue channels", async () => {
    const sim = simulateBookFill(sampleBook.asks, 200, 0.3865, "BUY", 60);
    expect(sim.filledUsd).toBe(200);
    const res = await evaluateTradeFirewall(
      { marketType: "wealth", symbol: "CXMT", side: "BUY", notionalUsd: 500 },
      { orderbook: null, intradayVolPct: 2.0, venueChannelStatus: "closed:market_closed", referencePrice: 5.71 }
    );
    expect(res.verdict).toBe("BLOCK");
  });
});

describe("Quantitative Regime & Walk-Forward Backtest Engine", () => {
  it("computes deterministic walk-forward metrics, alpha, and bootstrap Monte Carlo VaR", () => {
    const dates = Array.from({ length: 20 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    const mkSeries = (start: number, step: number) =>
      dates.map((date, i) => ({ date, close: Number((start * (1 + step * i)).toFixed(4)) }));

    const result = runBasketBacktest(
      "Unit Test Barbell",
      [
        { symbol: "A", source: "spot", weight: 0.6, label: "Asset A" },
        { symbol: "B", source: "wealth", weight: 0.4, label: "Asset B" }
      ],
      {
        A: { points: mkSeries(100, 0.01), source: "SoDEX Spot CLOB" },
        B: { points: mkSeries(50, 0.005), source: "SoDEX Wealth API" }
      },
      mkSeries(10, 0.003),
      mkSeries(50000, 0.002),
      7,
      10
    );

    expect(result.daysAnalyzed).toBe(20);
    expect(result.totalReturnPct).toBeGreaterThan(10);
    expect(result.alphaVsSsiPct).toBeGreaterThan(0);
    expect(result.annualizedSharpe).toBeGreaterThan(1);
    expect(result.equityCurve).toHaveLength(20);
  });

  it("detects RISK_ON when breadth and crypto momentum are strong", () => {
    const regime = detectMarketRegime(
      [
        { symbol: "vBTC_vUSDC", lastPx: 60000, openPx: 58000, highPx: 60500, lowPx: 57900, volume: 100, quoteVolume: 6e6, changePct: 3.4, bidPx: 59990, askPx: 60010, spreadBps: 3.3 },
        { symbol: "vETH_vUSDC", lastPx: 3200, openPx: 3080, highPx: 3220, lowPx: 3070, volume: 200, quoteVolume: 6.4e5, changePct: 3.9, bidPx: 3199, askPx: 3201, spreadBps: 6.2 },
        { symbol: "vSOL_vUSDC", lastPx: 140, openPx: 135, highPx: 142, lowPx: 134, volume: 300, quoteVolume: 4.2e4, changePct: 3.7, bidPx: 139.9, askPx: 140.1, spreadBps: 14.3 }
      ],
      [],
      []
    );
    expect(regime.label).toBe("RISK_ON");
    expect(regime.breadthAdvancingPct).toBe(100);
  });
});

describe("Worker API & MCP JSON-RPC Endpoints", () => {
  it("responds healthy on /health and serves OpenAPI 3.0.3 schema", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const oas = await app.request("/api/v1/openapi.json");
    expect(oas.status).toBe(200);
    const spec = (await oas.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.paths["/mcp"]).toBeDefined();
  });

  it("handles MCP initialize and tools/list", async () => {
    const init = (await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
      result?: { serverInfo?: { name: string } };
    };
    expect(init.result?.serverInfo?.name).toBe("meridian-finance-mcp");
    const tools = (await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result?: { tools?: unknown[] };
    };
    expect(tools.result?.tools?.length).toBeGreaterThanOrEqual(5);
  });
});
