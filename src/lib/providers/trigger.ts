import "server-only";
// Jupiter Trigger API (limit orders) — used for TAKE-PROFIT orders that execute on-chain even
// when EdgePilot is closed. The user signs the order transaction once in their wallet; tokens are
// held by Jupiter's order program until filled or cancelled.
// NOTE: endpoint shapes follow Jupiter's Trigger API v1 as of 2025. They could not be re-verified
// from this build environment — failures surface as errors and nothing is signed without the
// wallet showing the transaction first.
import { fetchJson } from "../server/http";

const BASE = process.env.JUPITER_API_KEY ? "https://api.jup.ag/trigger/v1" : "https://lite-api.jup.ag/trigger/v1";
const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}) });

export async function createTriggerOrder(o: { inputMint: string; outputMint: string; maker: string; makingAmount: string; takingAmount: string; expiredAt?: number }) {
  const body: Record<string, unknown> = {
    inputMint: o.inputMint,
    outputMint: o.outputMint,
    maker: o.maker,
    payer: o.maker,
    params: { makingAmount: o.makingAmount, takingAmount: o.takingAmount, ...(o.expiredAt ? { expiredAt: String(o.expiredAt) } : {}) },
    computeUnitPrice: "auto",
    wrapAndUnwrapSol: true,
  };
  return fetchJson<{ order: string; transaction: string; requestId?: string }>("Jupiter Trigger", `${BASE}/createOrder`, { method: "POST", headers: headers(), body: JSON.stringify(body), timeoutMs: 12_000 });
}

export async function cancelTriggerOrder(maker: string, order: string) {
  return fetchJson<{ transaction: string; requestId?: string }>("Jupiter Trigger", `${BASE}/cancelOrder`, { method: "POST", headers: headers(), body: JSON.stringify({ maker, order, computeUnitPrice: "auto" }), timeoutMs: 12_000 });
}

export interface TriggerOrder {
  orderKey?: string;
  order?: string;
  inputMint: string;
  outputMint: string;
  makingAmount?: string;
  takingAmount?: string;
  rawMakingAmount?: string;
  rawTakingAmount?: string;
  status?: string;
  createdAt?: string;
}

export async function getTriggerOrders(user: string, status: "active" | "history") {
  const j = await fetchJson<{ orders?: TriggerOrder[] } | TriggerOrder[]>("Jupiter Trigger", `${BASE}/getTriggerOrders?user=${user}&orderStatus=${status}`, { headers: headers() });
  return Array.isArray(j) ? j : (j.orders ?? []);
}
