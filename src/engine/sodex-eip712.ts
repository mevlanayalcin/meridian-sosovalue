import { concatHex, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type SoDexNetwork = "mainnet" | "testnet";

export function getSoDexChainId(network: SoDexNetwork): number {
  return network === "mainnet" ? 286623 : 138565;
}

export function getSoDexBaseUrl(network: SoDexNetwork): string {
  return network === "mainnet" ? "https://mainnet-gw.sodex.dev" : "https://testnet-gw.sodex.dev";
}

export interface SpotOrderSpec {
  accountID: number;
  symbolID: number;
  clOrdID: string;
  side: 1 | 2; // 1 = BUY, 2 = SELL
  type: 1 | 2; // 1 = LIMIT, 2 = MARKET
  timeInForce: 1 | 2 | 3 | 4; // 1=GTC, 2=FOK, 3=IOC, 4=GTX
  price?: string;
  quantity?: string;
  funds?: string;
}

export interface PerpsOrderSpec {
  accountID: number;
  symbolID: number;
  clOrdID: string;
  modifier?: 1 | 2 | 3 | 4; // 1=NORMAL
  side: 1 | 2; // 1=BUY, 2=SELL
  type: 1 | 2; // 1=LIMIT, 2=MARKET
  timeInForce: 1 | 2 | 3 | 4;
  price?: string;
  quantity?: string;
  funds?: string;
  reduceOnly?: boolean;
  positionSide?: 1 | 2 | 3; // 1=BOTH, 2=LONG, 3=SHORT
}

/**
 * Serializes Spot BatchNewOrderRequest in exact Go struct field order from
 * sodex-tech/sodex-go-sdk-public/spot/types/batch_new_order_request.go.
 */
export function buildSpotOrderPayload(spec: SpotOrderSpec) {
  const order: Record<string, unknown> = {
    symbolID: spec.symbolID,
    clOrdID: spec.clOrdID,
    side: spec.side,
    type: spec.type,
    timeInForce: spec.timeInForce
  };
  if (spec.price !== undefined) order.price = spec.price;
  if (spec.quantity !== undefined) order.quantity = spec.quantity;
  if (spec.funds !== undefined) order.funds = spec.funds;

  const params = {
    accountID: spec.accountID,
    orders: [order]
  };
  const action = { type: "batchNewOrder", params };
  const canonicalJson = JSON.stringify(action);
  const payloadHash = keccak256(toHex(canonicalJson));
  return { action, params, canonicalJson, payloadHash };
}

/**
 * Serializes Perps NewOrderRequest in exact Go struct field order from
 * sodex-tech/sodex-go-sdk-public/perps/types/new_order_request.go.
 */
export function buildPerpsOrderPayload(spec: PerpsOrderSpec) {
  const order: Record<string, unknown> = {
    clOrdID: spec.clOrdID,
    modifier: spec.modifier ?? 1,
    side: spec.side,
    type: spec.type,
    timeInForce: spec.timeInForce
  };
  if (spec.price !== undefined) order.price = spec.price;
  if (spec.quantity !== undefined) order.quantity = spec.quantity;
  if (spec.funds !== undefined) order.funds = spec.funds;
  order.reduceOnly = spec.reduceOnly ?? false;
  order.positionSide = spec.positionSide ?? 1;

  const params = {
    accountID: spec.accountID,
    symbolID: spec.symbolID,
    orders: [order]
  };
  const action = { type: "newOrder", params };
  const canonicalJson = JSON.stringify(action);
  const payloadHash = keccak256(toHex(canonicalJson));
  return { action, params, canonicalJson, payloadHash };
}

export function buildExchangeActionTypedData(
  domainName: "spot" | "futures",
  network: SoDexNetwork,
  payloadHash: `0x${string}`,
  nonce: number
) {
  return {
    domain: {
      name: domainName,
      version: "1",
      chainId: getSoDexChainId(network),
      verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`
    },
    types: {
      ExchangeAction: [
        { name: "payloadHash", type: "bytes32" },
        { name: "nonce", type: "uint64" }
      ]
    },
    primaryType: "ExchangeAction" as const,
    message: {
      payloadHash,
      nonce: BigInt(nonce)
    }
  };
}

/**
 * Normalizes ECDSA recovery v (27/28 -> 00/01) and prepends SoDEX 0x01 typed signature tag.
 */
export function normalizeSoDexSignature(rawSig: `0x${string}`, prefix: "0x01" | "0x02" = "0x01"): `0x${string}` {
  const vByte = Number.parseInt(rawSig.slice(-2), 16);
  const normalizedV = (vByte >= 27 ? vByte - 27 : vByte).toString(16).padStart(2, "0");
  const wireSig = `${rawSig.slice(0, -2)}${normalizedV}` as `0x${string}`;
  return concatHex([prefix, wireSig]);
}

export async function signExchangeActionWithKey(
  privateKey: `0x${string}`,
  domainName: "spot" | "futures",
  network: SoDexNetwork,
  payloadHash: `0x${string}`,
  nonce: number
) {
  const account = privateKeyToAccount(privateKey);
  const typedData = buildExchangeActionTypedData(domainName, network, payloadHash, nonce);
  const rawSignature = await account.signTypedData(typedData);
  return {
    signerAddress: account.address,
    typedData,
    wireSignature: normalizeSoDexSignature(rawSignature, "0x01")
  };
}
