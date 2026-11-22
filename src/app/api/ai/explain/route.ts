import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { NextResponse } from "next/server";
import { fail, limited } from "@/lib/server/respond";

// Optional AI analyst. The trading decision is made by the deterministic engine; the model only
// EXPLAINS the computed signal in plain English. It receives the engine's numbers and is told
// not to invent data, change levels, or make price predictions.

const Factor = z.object({ label: z.string().max(80), score: z.number().nullable(), weight: z.number(), detail: z.string().max(500) });
const Body = z.object({
  question: z.string().max(500).optional(),
  signal: z.object({
    asset: z.string().max(40),
    market: z.string().max(20),
    direction: z.string().max(12),
    setupType: z.string().max(80),
    timeframe: z.string().max(12),
    price: z.number(),
    entry: z.object({ low: z.number(), high: z.number() }).nullable(),
    trigger: z.string().max(400).nullable(),
    stopLoss: z.number().nullable(),
    takeProfits: z.array(z.object({ price: z.number(), r: z.number(), closePct: z.number() })).max(5),
    riskReward: z.number().nullable(),
    qualityScore: z.number(),
    factors: z.array(Factor).max(12),
    rules: z.array(z.object({ label: z.string().max(120), passed: z.boolean(), detail: z.string().max(400), severity: z.string().max(10) })).max(15),
    historicalEdge: z.object({ trades: z.number(), winRate: z.number().nullable(), expectancyR: z.number().nullable(), note: z.string().max(400) }).nullable(),
    reasons: z.array(z.string().max(500)).max(15),
    risks: z.array(z.string().max(500)).max(25),
    summary: z.string().max(600),
    position: z
      .object({ leverage: z.number(), riskUsd: z.number(), notionalUsd: z.number(), liquidationPrice: z.number().nullable(), warnings: z.array(z.string().max(400)).max(10) })
      .nullable(),
  }),
});

const SYSTEM = `You are the analyst inside EdgePilot AI, a personal crypto trading assistant for a BEGINNER.
You receive a trade signal that a deterministic, rule-based engine already computed from live market data.

Rules:
- Explain the engine's decision in plain, friendly English a beginner understands. Define jargon briefly when you use it.
- Use ONLY the numbers and facts in the provided JSON. Never invent prices, news, on-chain data, or statistics.
- Do not change the decision, entry, stop, targets or leverage. If you disagree, say what extra caution is warranted, but do not override.
- Never predict future prices or promise profits. Distinguish the quality score (rule-based confidence) from the historical win rate (measured statistics, possibly small sample).
- Always mention the main way the trade could fail and that the stop-loss must be respected.
- If the decision is WAIT or NO_TRADE, explain why patience is the right call.
- Keep it under 220 words. Plain text, short paragraphs, no markdown headings.`;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return fail("AI explanations are not configured. Add ANTHROPIC_API_KEY in your Netlify environment variables. The rule-based explanation is still available.", 501);
  const code = process.env.AI_ACCESS_CODE;
  if (code && req.headers.get("x-access-code") !== code) return fail("Invalid or missing access code (set it in Settings → AI).", 401);
  const rl = limited(req, "ai", 20, 60 * 60_000);
  if (rl) return rl;
  const raw = await req.text();
  if (raw.length > 40_000) return fail("Request too large", 413);
  let body;
  try {
    body = Body.safeParse(JSON.parse(raw));
  } catch {
    return fail("Invalid JSON", 400);
  }
  if (!body.success) return fail("Invalid signal payload", 400);

  const client = new Anthropic();
  const model = process.env.AI_MODEL || "claude-opus-5-5";
  const userText = `Signal JSON:\n${JSON.stringify(body.data.signal)}\n\n${body.data.question ? `The user asks: ${body.data.question}` : "Explain this decision to me."}`;
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      output_config: { effort: "low" },
      // Server-side refusal fallback (routes to another model if the primary declines).
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: userText }],
    });
    if (response.stop_reason === "refusal") return fail("The AI declined to answer this request.", 422);
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    return NextResponse.json({ ok: true, text, model: response.model }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return fail("AI provider rate limit reached — try again shortly.", 429);
    if (e instanceof Anthropic.AuthenticationError) return fail("AI provider rejected the API key. Check ANTHROPIC_API_KEY.", 502);
    if (e instanceof Anthropic.APIError) return fail(`AI provider error (${e.status ?? "network"}).`, 502);
    return fail("AI request failed.");
  }
}
