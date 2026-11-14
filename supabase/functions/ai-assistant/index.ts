// Optional AI assistant. Sends ONLY aggregated, non-personal operating figures (from the
// ai_context() database function, which runs with the caller's own permissions) to an
// OpenAI-compatible chat endpoint. Without AI_API_KEY it answers "not configured".
import { admin, env, HttpError, logIntegration, requireStaff, serve, str } from "../_shared/common.ts";

serve(async (req, body) => {
  const staff = await requireStaff(req, "ai.view");
  const question = str(body.question, "question", 3, 1000);
  const key = env("AI_API_KEY");
  if (!key) throw new HttpError(503, "AI_NOT_CONFIGURED", "The AI assistant is not configured. Forecasts and signals on this page are computed from your data without it.");
  const { data: enabled } = await admin().from("system_settings").select("value").eq("key", "feature.ai_assistant").maybeSingle();
  if (enabled?.value !== true) throw new HttpError(403, "AI_DISABLED", "The AI assistant is switched off in Settings › Feature flags.");
  const { data: allowed } = await admin().rpc("check_rate_limit", { p_key: `ai:${staff.staffId}`, p_max: 20, p_window_seconds: 3600 });
  if (allowed === false) throw new HttpError(429, "RATE_LIMITED", "Hourly AI question limit reached.");

  const { data: context, error } = await staff.client.rpc("ai_context");
  if (error) throw new Error(error.message);

  const base = env("AI_BASE_URL") || "https://api.openai.com/v1", model = env("AI_MODEL") || "gpt-4o-mini";
  const started = Date.now();
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.2, max_tokens: 700, messages: [
      { role: "system", content: "You are an operations analyst for an Indian ride-hailing company. Answer ONLY from the JSON data provided. Money is in paise: divide by 100 and show as ₹. If the data does not contain the answer, say so plainly. Never invent numbers. Be brief and practical." },
      { role: "user", content: `DATA:\n${JSON.stringify(context)}\n\nQUESTION: ${question}` }] }) }).catch(() => null);
  const data = await res?.json().catch(() => null);
  await logIntegration("ai", "openai_compatible", "chat", res?.ok ? "ok" : "error", { http: res?.status, ms: Date.now() - started, error: res?.ok ? undefined : String(data?.error?.message ?? "request failed") });
  const answer = data?.choices?.[0]?.message?.content;
  if (!res?.ok || typeof answer !== "string") throw new HttpError(502, "AI_PROVIDER_ERROR", "The AI provider did not return an answer.");
  await admin().from("ai_insights").insert({ insight_type: "assistant_answer", title: question.slice(0, 200), body: answer, payload: {}, source: "llm", model, requested_by: staff.staffId });
  return { ok: true, answer, model, generated_at: new Date().toISOString() };
});
