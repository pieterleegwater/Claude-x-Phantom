"use client";
// Shared wallet-transaction flow: deserialize an UNSIGNED transaction from the server,
// simulate it, hand it to the wallet for the user's approval, then wait for confirmation.
// EdgePilot never signs: the wallet (Phantom) shows the transaction and the user approves.
import { VersionedTransaction, type Connection, type TransactionSignature } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";

export function decodeTx(b64: string) {
  return VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

export async function simulateAndSend(b64: string, connection: Connection, wallet: WalletContextState, onStatus?: (s: string) => void): Promise<TransactionSignature> {
  if (!wallet.publicKey) throw new Error("Wallet not connected");
  const tx = decodeTx(b64);
  onStatus?.("Simulating transaction…");
  const sim = await connection.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
  onStatus?.("Simulation OK — approve in your wallet…");
  return wallet.sendTransaction(tx, connection);
}

/** Poll signature status (read-only RPC) for up to `timeoutMs`. */
export async function waitForConfirmation(connection: Connection, sig: string, timeoutMs = 45_000): Promise<"confirmed" | "failed" | "unknown"> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await connection.getSignatureStatuses([sig]);
      const st = r.value[0];
      if (st?.err) return "failed";
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "confirmed";
    } catch {
      /* transient RPC error — keep polling */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "unknown";
}
