import { fetchJson } from "./http";
import type { SsiParityRow } from "../shared/types";

const VALUECHAIN_MAINNET_RPC = "https://mainnet.valuechain.xyz";
const VALUECHAIN_TESTNET_RPC = "https://testnet.valuechain.xyz";
const BASE_MAINNET_RPC = "https://mainnet.base.org";

export const BASE_SSI_TOKENS = [
  { symbol: "MAG7.ssi", sodexSymbol: "vMAG7ssi_vUSDC", address: "0x9E6A46f294bB67c20F1D1E7AfB0bBEf614403B55" },
  { symbol: "MEME.ssi", sodexSymbol: "vMEMEssi_vUSDC", address: "0xdd3acDBDc7b358Df453a6CB6bCA56C92aA5743aA" },
  { symbol: "DEFI.ssi", sodexSymbol: null, address: "0x164ffdaE2fe3891714bc2968f1875ca4fA1079D0" },
  { symbol: "USSI", sodexSymbol: null, address: "0x3a46ed8FCeb6eF1ADA2E4600A522AE7e24D2Ed18" }
] as const;

interface RpcResponse {
  result?: string;
  error?: { message: string };
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetchJson<RpcResponse>(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    },
    8000
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

export async function readErc20TotalSupply(rpcUrl: string, tokenAddress: string): Promise<number> {
  const hex = await rpcCall(rpcUrl, "eth_call", [{ to: tokenAddress, data: "0x18160ddd" }, "latest"]);
  const raw = BigInt(hex === "0x" ? "0x0" : hex);
  return Number(raw / 10n ** 14n) / 10_000;
}

interface DexScreenerResponse {
  pairs?: Array<{
    chainId?: string;
    priceUsd?: string;
    baseToken?: { address?: string };
    liquidity?: { usd?: number };
  }>;
}

/**
 * Reads live on-chain Base SSI token supply via eth_call + DexScreener Base liquidity price
 * and reconciles against SoDEX Spot CLOB orderbook prices to detect cross-venue parity spreads.
 */
export async function computeSsiParity(
  sodexPriceMap: Record<string, { lastPx: number; spreadBps: number }>
): Promise<SsiParityRow[]> {
  const addresses = BASE_SSI_TOKENS.map((t) => t.address).join(",");
  const [supplies, dexData] = await Promise.all([
    Promise.all(BASE_SSI_TOKENS.map((t) => readErc20TotalSupply(BASE_MAINNET_RPC, t.address).catch(() => 0))),
    fetchJson<DexScreenerResponse>(`https://api.dexscreener.com/latest/dex/tokens/${addresses}`, {}, 8000).catch(
      () => ({ pairs: [] })
    )
  ]);

  const dexPriceByAddr = new Map<string, number>();
  for (const pair of dexData.pairs ?? []) {
    if (pair.chainId !== "base") continue;
    const addr = pair.baseToken?.address?.toLowerCase();
    const px = pair.priceUsd ? Number.parseFloat(pair.priceUsd) : NaN;
    if (addr && Number.isFinite(px) && !dexPriceByAddr.has(addr)) {
      dexPriceByAddr.set(addr, px);
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
      constituentFairValueUsd: baseDexPriceUsd,
      premiumDiscountBps,
      signal
    };
  });
}
