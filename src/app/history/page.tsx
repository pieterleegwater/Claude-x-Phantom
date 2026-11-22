"use client";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useStore } from "@/lib/client/store";
import { Badge, Button, Card, PageHeader, Segmented, cn, price, usd } from "@/components/ui";

export default function HistoryPage() {
  const paper = useStore((s) => s.paper);
  const [market, setMarket] = useState<"ALL" | "BTC-PERP" | "BTC-SPOT" | "SOL-MEME">("ALL");
  const fills = useMemo(() => [...paper.fills].reverse().filter((f) => market === "ALL" || f.market === market), [paper.fills, market]);
  const closed = useMemo(() => [...paper.closedPositions].reverse().filter((f) => market === "ALL" || f.market === market), [paper.closedPositions, market]);

  const exportCsv = () => {
    const head = ["closed_at", "opened_at", "asset", "market", "side", "qty", "entry", "exit", "reason", "pnl_usd", "fees_usd", "funding_usd", "setup", "simulated"];
    const rows = paper.fills.map((f) => [new Date(f.closedAt).toISOString(), new Date(f.openedAt).toISOString(), f.asset, f.market, f.side, f.qty, f.entry, f.exit, f.reason, f.pnl.toFixed(4), f.fees.toFixed(4), f.funding.toFixed(4), `"${f.setup.replace(/"/g, "'")}"`, "true"]);
    const csv = [head, ...rows].map((r) => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `edgepilot-paper-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Trade History"
        subtitle="Every simulated fill and closed position. All fills are SIMULATED — not exchange executions."
        right={
          <>
            <Segmented size="sm" value={market} onChange={setMarket} options={[{ value: "ALL", label: "All" }, { value: "BTC-PERP", label: "Perp" }, { value: "BTC-SPOT", label: "Spot" }, { value: "SOL-MEME", label: "Meme" }]} />
            <Button size="sm" onClick={exportCsv} disabled={!paper.fills.length}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
          </>
        }
      />
      <Card title="Closed positions" subtitle={`${closed.length} positions`}>
        {closed.length === 0 ? (
          <p className="text-sm text-ink-3">No closed positions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Closed</th>
                  <th className="px-2 py-1.5 font-medium">Asset</th>
                  <th className="px-2 py-1.5 font-medium">Side</th>
                  <th className="px-2 py-1.5 font-medium">Setup</th>
                  <th className="px-2 py-1.5 text-right font-medium">Duration</th>
                  <th className="px-2 py-1.5 text-right font-medium">R</th>
                  <th className="px-2 py-1.5 text-right font-medium">Net PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {closed.map((c) => (
                  <tr key={c.id}>
                    <td className="px-2 py-1.5 text-ink-3">{new Date(c.closedAt).toLocaleString()}</td>
                    <td className="px-2 py-1.5">{c.asset} <Badge>{c.market}</Badge></td>
                    <td className="px-2 py-1.5"><Badge tone={c.side === "long" ? "bull" : "bear"}>{c.side}</Badge></td>
                    <td className="px-2 py-1.5">{c.setup}</td>
                    <td className="num px-2 py-1.5 text-right">{((c.closedAt - c.openedAt) / 3_600_000).toFixed(1)}h</td>
                    <td className={cn("num px-2 py-1.5 text-right", c.r >= 0 ? "text-bull" : "text-bear")}>{c.r.toFixed(2)}</td>
                    <td className={cn("num px-2 py-1.5 text-right", c.pnl >= 0 ? "text-bull" : "text-bear")}>{usd(c.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card className="mt-4" title="Fills (simulated)" subtitle="Partial exits appear as separate fills.">
        {fills.length === 0 ? (
          <p className="text-sm text-ink-3">No fills yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  <th className="px-2 py-1.5 font-medium">Asset</th>
                  <th className="px-2 py-1.5 font-medium">Side</th>
                  <th className="px-2 py-1.5 text-right font-medium">Qty</th>
                  <th className="px-2 py-1.5 text-right font-medium">Entry</th>
                  <th className="px-2 py-1.5 text-right font-medium">Exit</th>
                  <th className="px-2 py-1.5 font-medium">Reason</th>
                  <th className="px-2 py-1.5 text-right font-medium">Fees</th>
                  <th className="px-2 py-1.5 text-right font-medium">Funding</th>
                  <th className="px-2 py-1.5 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {fills.map((f) => (
                  <tr key={f.id}>
                    <td className="px-2 py-1.5 text-ink-3">{new Date(f.closedAt).toLocaleString()}</td>
                    <td className="px-2 py-1.5">{f.asset}</td>
                    <td className="px-2 py-1.5"><Badge tone={f.side === "long" ? "bull" : "bear"}>{f.side}</Badge></td>
                    <td className="num px-2 py-1.5 text-right">{f.qty.toPrecision(4)}</td>
                    <td className="num px-2 py-1.5 text-right">{price(f.entry)}</td>
                    <td className="num px-2 py-1.5 text-right">{price(f.exit)}</td>
                    <td className="px-2 py-1.5"><Badge tone={f.reason.startsWith("tp") ? "bull" : f.reason === "manual" ? "neutral" : "bear"}>{f.reason}</Badge></td>
                    <td className="num px-2 py-1.5 text-right">{usd(f.fees)}</td>
                    <td className="num px-2 py-1.5 text-right">{usd(f.funding)}</td>
                    <td className={cn("num px-2 py-1.5 text-right", f.pnl >= 0 ? "text-bull" : "text-bear")}>{usd(f.pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
