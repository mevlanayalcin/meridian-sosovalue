import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { fetchJson } from "./http";
import type { SsiParityRow } from "../shared/types";

const VALUECHAIN_MAINNET_RPC = "https://mainnet.valuechain.xyz";
const VALUECHAIN_TESTNET_RPC = "https://testnet.valuechain.xyz";
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BASE_RPC_ENDPOINTS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base"
] as const;

const MULTICALL3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calldata calls) payable returns (Result[] memory returnData)"
]);

export const BASE_SSI_TOKENS = [
  { symbol: "MAG7.ssi", sodexSymbol: "vMAG7ssi_vUSDC", address: "0x9E6A46f294bB67c20F1D1E7AfB0bBEf614403B55", defaultDecimals: 8 },
  { symbol: "MEME.ssi", sodexSymbol: "vMEMEssi_vUSDC", address: "0xdd3acDBDc7b358Df453a6CB6bCA56C92aA5743aA", defaultDecimals: 8 },
  { symbol: "DEFI.ssi", sodexSymbol: null, address: "0x164ffdaE2fe3891714bc2968f1875ca4fA1079D0", defaultDecimals: 8 },
  { symbol: "USSI", sodexSymbol: null, address: "0x3a46ed8FCeb6eF1ADA2E4600A522AE7e24D2Ed18", defaultDecimals: 8 }
] as const;

interface RpcResponse {
  result?: string;
  error?: { message: string };
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[], timeoutMs = 5000): Promise<string> {
  const res = await fetchJson<RpcResponse>(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    },
    timeoutMs
  );
  if (res.error) throw new Error(res.error.message);
  return res.result ?? "0x0";
}

export async function getValueChainBlocks(): Promise<{ mainnetBlock: number; testnetBlock: number }> {
  const [mHex, tHex] = await Promise.all([
    rpcCall(VALUECHAIN_MAINNET_RPC, "eth_blockNumber", []).catch(() => "0x0"),
    rpcCall(VALUECHAIN_TESTNET_RPC, "eth_blockNumber", []).catch(() => "0x0")
  ]);
  return {
    mainnetBlock: Number.parseInt(mHex, 16) || 0,
    testnetBlock: Number.parseInt(tHex, 16) || 0
  };
}

export function scaleTokenSupply(rawSupply: bigint, decimals: number): number {
  const safeDec = Math.max(0, Math.min(36, Math.trunc(decimals)));
  if (safeDec <= 4) {
    return Number(rawSupply) / 10 ** safeDec;
  }
  const divisor = 10n ** BigInt(safeDec - 4);
  return Number(rawSupply / divisor) / 10_000;
}

export async function readErc20TotalSupply(
  rpcUrl: string,
  tokenAddress: string,
  fallbackDecimals = 8
): Promise<number> {
  const supplyHex = await rpcCall(rpcUrl, "eth_call", [{ to: tokenAddress, data: "0x18160ddd" }, "latest"], 4500);
  const decHex = await rpcCall(rpcUrl, "eth_call", [{ to: tokenAddress, data: "0x313ce567" }, "latest"], 4500).catch(
    () => "0x"
  );
  const raw = BigInt(supplyHex && supplyHex !== "0x" ? supplyHex : "0x0");
  const parsedDec = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : fallbackDecimals;
  const decimals = Number.isFinite(parsedDec) && parsedDec >= 0 && parsedDec <= 36 ? parsedDec : fallbackDecimals;
  return scaleTokenSupply(raw, decimals);
}

interface LlamaCoinsResponse {
  coins?: Record<string, { price?: number; symbol?: string }>;
}

async function readAllBaseSsiSupplies(): Promise<number[]> {
  // Single atomic Multicall3 eth_call reading totalSupply() + decimals() across all 4 Base SSI tokens
  const calls = BASE_SSI_TOKENS.flatMap((tok) => [
    { target: tok.address as `0x${string}`, allowFailure: true, callData: "0x18160ddd" as Hex },
    { target: tok.address as `0x${string}`, allowFailure: true, callData: "0x313ce567" as Hex }
  ]);
  const callData = encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [calls]
  });

  for (const rpcUrl of BASE_RPC_ENDPOINTS) {
    try {
      const hex = await rpcCall(rpcUrl, "eth_call", [{ to: MULTICALL3_ADDRESS, data: callData }, "latest"], 4500);
      if (!hex || hex === "0x" || hex === "0x0") continue;
      const decoded = decodeFunctionResult({
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        data: hex as Hex
      });
      const supplies = BASE_SSI_TOKENS.map((tok, idx) => {
        const supRes = decoded[idx * 2];
        const decRes = decoded[idx * 2 + 1];
        const raw = supRes?.success && supRes.returnData && supRes.returnData !== "0x" ? BigInt(supRes.returnData) : 0n;
        const parsedDec =
          decRes?.success && decRes.returnData && decRes.returnData !== "0x"
            ? Number(BigInt(decRes.returnData))
            : tok.defaultDecimals;
        const decimals = Number.isFinite(parsedDec) && parsedDec >= 0 && parsedDec <= 36 ? parsedDec : tok.defaultDecimals;
        return scaleTokenSupply(raw, decimals);
      });
      if (supplies.some((s) => s > 0)) {
        return supplies;
      }
    } catch {
      // Try next Base RPC endpoint
    }
  }

  // Secondary fallback: sequential single eth_call on primary publicnode RPC
  const fallback: number[] = [];
  for (const tok of BASE_SSI_TOKENS) {
    const val = await readErc20TotalSupply(BASE_RPC_ENDPOINTS[0], tok.address, tok.defaultDecimals).catch(() => 0);
    fallback.push(val);
  }
  return fallback;
}

/**
 * Reads live on-chain Base SSI token supply via single atomic Multicall3 eth_call
 * (reading ERC-20 totalSupply() + decimals() = 8 with multi-RPC fallback) plus
 * DefiLlama Base pool spot pricing and reconciles against SoDEX Spot CLOB orderbook prices.
 */
export async function computeSsiParity(
  sodexPriceMap: Record<string, { lastPx: number; spreadBps: number }>
): Promise<SsiParityRow[]> {
  const llamaKeys = BASE_SSI_TOKENS.map((t) => `base:${t.address}`).join(",");
  const [supplies, llamaData] = await Promise.all([
    readAllBaseSsiSupplies(),
    fetchJson<LlamaCoinsResponse>(`https://coins.llama.fi/prices/current/${llamaKeys}`, {}, 8000).catch(
      () => ({ coins: {} })
    )
  ]);

  const dexPriceByAddr = new Map<string, number>();
  for (const [k, v] of Object.entries(llamaData.coins ?? {}) as Array<[string, { price?: number }]>) {
    const addr = k.replace(/^base:/i, "").toLowerCase();
    if (v?.price && Number.isFinite(v.price) && v.price > 0) {
      dexPriceByAddr.set(addr, v.price);
    }
  }

  return BASE_SSI_TOKENS.map((tok, idx) => {
    const baseDexPriceUsd = dexPriceByAddr.get(tok.address.toLowerCase()) ?? null;
    const sodexInfo = tok.sodexSymbol ? sodexPriceMap[tok.sodexSymbol] : undefined;
    const sodexPriceUsd = sodexInfo ? sodexInfo.lastPx : null;
    const sodexSpreadBps = sodexInfo ? sodexInfo.spreadBps : null;

    let premiumDiscountBps: number | null = null;
    let signal: SsiParityRow["signal"] = "ONCHAIN_ONLY";

    if (baseDexPriceUsd !== null && sodexPriceUsd !== null && baseDexPriceUsd > 0) {
      premiumDiscountBps = Number((((sodexPriceUsd - baseDexPriceUsd) / baseDexPriceUsd) * 10000).toFixed(1));
      if (premiumDiscountBps < -35) signal = "ARBITRAGE_BUY_SODEX";
      else if (premiumDiscountBps > 35) signal = "ARBITRAGE_SELL_SODEX";
      else signal = "PARITY_NEUTRAL";
    }

    return {
      symbol: tok.symbol,
      baseAddress: tok.address,
      baseTotalSupply: supplies[idx],
      baseDexPriceUsd,
      sodexSymbol: tok.sodexSymbol,
      sodexPriceUsd,
      sodexSpreadBps,
      constituentFairValueUsd: null,
      premiumDiscountBps,
      signal
    };
  });
}
