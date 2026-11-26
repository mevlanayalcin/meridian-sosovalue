import { SoDexClient, SODEX_MAINNET, SODEX_TESTNET } from "../providers/sodex";
import { evaluateTradeFirewall } from "./firewall";
import type { SoDexNetwork } from "./sodex-eip712";
import type { FirewallCheckRequest, FirewallCheckResult } from "../shared/types";

/**
 * Shared live-data Pre-Trade Risk Firewall runner used identically across
 * REST (/api/v1/firewall/check, /api/v1/execution/prepare, /api/v1/execution/submit),
 * MCP (meridian_check_trade_firewall), and standalone CLI (bin/meridian.ts).
 * Always checks live SoDEX symbol metadata status (e.g. HALT / SUSPENDED) and L2 depth.
 */
export async function runFirewallWithLiveData(
  req: FirewallCheckRequest,
  opts?: { network?: SoDexNetwork; limitPrice?: number }
): Promise<FirewallCheckResult> {
  const network: SoDexNetwork = opts?.network === "testnet" ? "testnet" : "mainnet";
  const netClient = new SoDexClient(network === "mainnet" ? SODEX_MAINNET : SODEX_TESTNET);
  const mainnetClient = new SoDexClient(SODEX_MAINNET);

  const book =
    req.marketType === "wealth"
      ? null
      : (await netClient.getOrderbook(req.marketType, req.symbol, 50).catch(() => null)) ??
        (network === "testnet" ? await mainnetClient.getOrderbook(req.marketType, req.symbol, 50).catch(() => null) : null);

  let refPx = book?.midPrice ?? 0;
  let intradayVolPct = 3.2;
  let channelStatus = "clob";
  let assetFound = true;

  if (req.marketType === "wealth") {
    const funds = await mainnetClient.getWealthFunds();
    const f = funds.find((x) => x.fundId === req.symbol);
    assetFound = Boolean(f);
    refPx = f?.price ?? 0;
    channelStatus = f?.channel ?? "not_found";
    intradayVolPct = f?.fundType === "bridged_vault" ? 0.5 : 4.5;
  } else if (req.marketType === "spot") {
    const [tickers, symbols] = await Promise.all([
      netClient.getSpotTickers().catch(() => mainnetClient.getSpotTickers()),
      netClient.getSpotSymbols().catch(() => mainnetClient.getSpotSymbols())
    ]);
    const t = tickers.find((x) => x.symbol === req.symbol);
    const symMeta = symbols.find((s) => s.name === req.symbol);
    assetFound = Boolean(symMeta || t || book);
    if (symMeta?.status) {
      channelStatus = symMeta.status;
    }
    if (t && t.lastPx > 0) {
      refPx = t.lastPx;
      intradayVolPct = ((t.highPx - t.lowPx) / t.lastPx) * 100;
    }
  } else {
    const [tickers, symbols] = await Promise.all([
      netClient.getPerpsTickers().catch(() => mainnetClient.getPerpsTickers()),
      netClient.getPerpsSymbols().catch(() => mainnetClient.getPerpsSymbols())
    ]);
    const t = tickers.find((x) => x.symbol === req.symbol);
    const symMeta = symbols.find((s) => s.name === req.symbol);
    assetFound = Boolean(symMeta || t || book);
    if (symMeta?.status) {
      channelStatus = symMeta.status;
    }
    if (t && t.lastPx > 0) {
      refPx = t.lastPx;
      intradayVolPct = ((t.highPx - t.lowPx) / t.lastPx) * 100;
    }
  }

  return evaluateTradeFirewall(req, {
    orderbook: book,
    intradayVolPct,
    venueChannelStatus: channelStatus,
    referencePrice: refPx,
    assetFound,
    limitPrice: opts?.limitPrice
  });
}
