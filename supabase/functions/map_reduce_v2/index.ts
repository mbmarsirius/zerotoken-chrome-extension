// @ts-nocheck
// Supabase Edge Function: map_reduce_v2 — orchestrator (v1)
// Purpose: Parallel map → single reduce for handoff using Groq; falls back to placeholders if keys missing
// Non-breaking: UI stays unchanged; endpoint opt-in

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";
const ZT_REVISION = "mrv2-cbf1-primer-v1";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

function corsHeaders(){
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,apikey,content-type",
    "cache-control": "no-store",
  } as Record<string,string>;
}
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() } });
}

type StartPayload = {
  userId: string | null;
  plan: string;
  title: string;
  threadId: string;
  chunks?: string[];
  maxMapConcurrency?: number;
};

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method Not Allowed" });

  let payload: StartPayload;
  try { payload = (await req.json()) as StartPayload; } catch { return jsonResponse(400, { ok: false, error: "Invalid JSON" }); }

  const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) return jsonResponse(202, { ok: false, serverKick: false, reason: "SERVICE_ROLE_KEY missing" });

  const admin = createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false } });
  // Key selection by plan with fallbacks
  const groqKeyPro  = Deno.env.get("GROQ_API_KEY_PRO")  || "";
  const groqKeyFree = Deno.env.get("GROQ_API_KEY_FREE") || "";
  const groqKeyAny  = Deno.env.get("GROQ_API_KEY")      || "";
  const groqKey     = (payload.plan?.toLowerCase?.()==="vault" ? (groqKeyPro||groqKeyAny) : (groqKeyFree||groqKeyAny));
  
  // PERFORMANCE BOOST: Increase parallel processing
  const MAX_PARALLEL = payload.maxMapConcurrency || 10; // Increased from 5 to 10

  // Lightweight RL backoff (shared within request)
  let rlBackoffMs = 0;
  function jitter(ms:number){ return ms + Math.floor(Math.random()*200); }
  function bumpBackoff(){ rlBackoffMs = Math.min(8000, Math.max(1000, rlBackoffMs ? Math.floor(rlBackoffMs*1.6) : 1200)); }
  function dropBackoff(){ rlBackoffMs = Math.floor(rlBackoffMs*0.5); }
  const sleep = (ms:number)=> new Promise(res=> setTimeout(res, ms));

  function chooseModel(plan: string, phase: "map"|"reduce"): string{
    if(phase==="map") return Deno.env.get("GROQ_MAP_MODEL") || "llama-3.1-8b-instant";
    if(plan?.toLowerCase?.()==="vault") return Deno.env.get("GROQ_REDUCE_MODEL_PRO") || "llama-3.3-70b-versatile";
    return Deno.env.get("GROQ_REDUCE_MODEL_FREE") || "llama-3.1-8b-instant";
  }

  async function callGroqWithFallback(models: string[], messages: any[], maxTokens=512): Promise<{content: string, model: string}> {
    let lastErr = "";
    for (const m of models){
      const out = await callGroq(m, messages, maxTokens);
      // Heuristic: treat explicit groq error marker as failure
      if (out && !out.startsWith("(groq error)")) return { content: out, model: m };
      lastErr = out;
      // If 429, backoff before trying next model
      if (String(out).includes("429")) { bumpBackoff(); await sleep(jitter(rlBackoffMs)); }
    }
    return { content: lastErr || "(groq error) no models succeeded", model: models[models.length-1] };
  }

  async function callGroq(model: string, messages: any[], maxTokens=512): Promise<string>{
    if(!groqKey){
      return "(groq disabled)";
    }
    try{
      if (rlBackoffMs>0) { await sleep(jitter(rlBackoffMs)); }
      const res = await fetch(GROQ_API_URL,{
        method:"POST",
        headers:{"content-type":"application/json","authorization":`Bearer ${groqKey}`},
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens
        })
      });
      if(!res.ok){
        const t = await res.text().catch(()=>"");
        if (res.status === 429) bumpBackoff(); else dropBackoff();
        throw new Error(`groq ${res.status}: ${t.slice(0,200)}`);
      }
      dropBackoff();
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || "";
    }catch(e){
      return `(groq error) ${String(e).slice(0,180)}`;
    }
  }

  async function updateJobProgress(fields: Record<string,unknown>){
    try{ await admin.from("jobs").update({...fields, heartbeat_at: new Date().toISOString()}).eq("id", jobRow.id); }catch{}
  }

  function clamp(n:number,min:number,max:number){ return Math.max(min, Math.min(max, n)); }

  function mapPromptJSON(chunk: string){
    return [
      { role: "system", content: "Extract ONLY what is explicitly present. Output strict JSON. No templates, no generic boilerplate. Omit empty fields entirely. Prefer extractive, short, self-contained items."},
      { role: "user", content: `From the segment below, output a JSON object with OPTIONAL keys:
{
  "objectives": string[],
  "facts": [{"text": string, "quote": string}],
  "decisions": [{"text": string, "quote": string}],
  "risks": string[],
  "next_actions": string[],
  "terms": string[]
}
Rules:
- Use extractive evidence: each item in facts/decisions must include a short direct quote (≤ 120 chars) from the segment in "quote".
- Do not invent. If unsure, skip.
- Keep each string ≤ 28 words; remove filler words like "Konusu", "Açıklama".
- Output JSON ONLY, no Markdown.

SEGMENT:\n${chunk}` }
    ];
  }
  function mapPromptBullets(chunk: string){
    return [
      { role: "system", content: "You are a precise mapper. Output 6 short bullet lines (if evidence exists). No templates, no placeholder text. Use only facts from the segment."},
      { role: "user", content: `Write up to 6 bullets covering: Objectives; Facts; Decisions; Risks; Next Actions; Terms. Use one compact line per bullet. If a category is missing, skip it (do not write placeholders).\n\nSEGMENT:\n${chunk}` }
    ];
  }
  function reducePrompt(title: string, pieces: string[], plan: string){
    const pro = (plan||'free').toLowerCase()==='vault';
    const targetWords = pro ? '1000-1500' : '650-950';
    return [
      { role: "system", content: "NON-NEGOTIABLES: No boilerplate like 'Konusu/Açıklama'. Do not invent file names, sizes, or CSS unless quoted with [S#]. Use only information traceable to segments. If a section lacks evidence, include a one-line note: 'Insufficient evidence [S#]'. Reference indices MUST be within 1..N (N = number of segments)."},
      { role: "user", content: `Title: ${title}\nLength: ${targetWords} words.\nTone: direct, decisive, warm.\n\nOUTPUT FORMAT (strict):\n=== PRIMER ===\n1) System / Operating Instructions (3–6 bullets): role, style, constraints; include language preference if present.\n2) Receiving LLM Guide (3–5 bullets): what to do first, what to ask if missing.\n3) One-Paragraph Context Recap (≤120 words).\n4) Key Facts (5–9 bullets, short).\n5) Decisions (Most recent → oldest, 5–10 bullets).\n6) Active Work / What's Already Built (3–7 bullets).\n7) Open Questions (prioritized, 3–7 bullets).\n8) Next Actions — table columns: action | owner | deps | effort(h) | impact(▲/▼) | rollback | [S# optional]. Provide 6–10 rows.\n   Owner MUST be one of: Founder, Product, Engineering, Design, Research, Growth, Ops, Legal, Data. Never [S#] or empty.\n   deps must reference task slugs or short nouns (e.g., Research, Data), not [S#].\n   rollback must be a concrete one-liner. No empty cells.\n9) First Task for the New LLM (2–4 bullets) + acceptance criteria (4–6 bullets).\n10) Cross-AI Injection Templates (GPT/Claude/Gemini): 1 short paragraph per target.\n\n=== DEEP CONTEXT ===\n- Facts & Data: dense bullets with [S#] + short quotes (≤120 chars).\n- Decisions & Rationale with [S#].\n- Constraints & Guardrails with [S#].\n- Full Next Actions table (may expand Primer).\n- Open Questions & Assumptions (with [S#] where applicable).\n- Artifacts / Snippets (only if clearly present with [S#]).\n- Tests (acceptance): 6–10 measurable checks.\n- Glossary & Canonical Terms: each term with [S#].\n- Delight Layer (brief): quick_start_script, wow_headlines, trust_tokens, next_three_moves.\n\nRules:\n- Keep PRIMER concise and directly actionable; reserve detailed evidence for DEEP.\n- In DEEP, ensure [S#] evidence markers and ≤120-char quotes for important facts.\n- If evidence is missing, include: 'Insufficient evidence [S#]'.\n- Do not invent beyond segments.\n- SECTION MARKERS '=== PRIMER ===' and '=== DEEP CONTEXT ===' MUST appear exactly once each as section headers only; never inline.\n- Do NOT append extraneous sections after DEEP; do not duplicate 'Receiving LLM Guide' outside PRIMER.\n- Avoid tautologies and repeating the same sentence with different wording.\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  // Two-phase prompts: generate PRIMER and DEEP separately to avoid truncation and marker leakage
  function reducePromptPrimer(title: string, pieces: string[], plan: string){
    const pro = (plan||'free').toLowerCase()==='vault';
    const targetWords = pro ? '600-900' : '450-700';
    return [
      { role: "system", content: "You produce ONLY the PRIMER section for a continuity handoff. No extraneous text before or after. Do not include the '=== PRIMER ===' header; content only. Do not reference [S#] unless in the last evidence column of the Next Actions table. No boilerplate. FORBIDDEN: generic definitions (e.g., 'Chrome extensions are programs...'), tutorial/guides like 'Data format: JSON', meta sections like 'Changes Made'. HARD RULES: Never invent numeric claims, money, dates, user counts, or company facts; if not explicitly present in the segments, avoid numbers and output a qualitative phrase or mark 'Insufficient evidence [S#]'. Do NOT fabricate any facts about 'ZeroToken' unless quoted in segments. Actions MUST be concrete, outcome-based project steps, not product feature names."},
      { role: "user", content: `Title: ${title}\nLength: ${targetWords} words.\nTone: direct, decisive, warm.\n\nPRIMER ONLY (content, no header):\n1) System / Operating Instructions (3–6 bullets): role, style, constraints; include language preference if present.\n2) Receiving LLM Guide (3–5 bullets): what to do first, what to ask if missing.\n3) One-Paragraph Context Recap (≤120 words).\n4) Key Facts (5–9 bullets, short).\n5) Decisions (Most recent → oldest, 5–10 bullets).\n6) Active Work / What's Already Built (3–7 bullets).\n7) Open Questions (prioritized, 3–7 bullets).\n8) Next Actions — table columns: action | owner | deps | effort(h) | impact(▲/▼) | rollback | [S# optional]. Provide 6–10 rows.\n   Owner MUST be one of: Founder, Product, Engineering, Design, Research, Growth, Ops, Legal, Data. Never [S#] or empty.\n   deps must reference task slugs or short nouns (e.g., Research, Data), not [S#].\n   rollback must be a concrete one-liner. No empty cells.\n9) First Task for the New LLM (2–4 bullets) + acceptance criteria (4–6 bullets).\n10) Cross-AI Injection Templates (GPT/Claude/Gemini): 1 short paragraph per target.\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  function reducePromptDeep(title: string, pieces: string[], plan: string){
    const pro = (plan||'free').toLowerCase()==='vault';
    const targetWords = pro ? '900-1300' : '500-800';
    return [
      { role: "system", content: "You produce ONLY the DEEP CONTEXT section. No extraneous text before or after. Do not include the '=== DEEP CONTEXT ===' header; content only. Every important factual bullet carries an inline [S#] and, when useful, a ≤120-char quote. Keep structure compact and dense. FORBIDDEN: generic definitions and meta sections. HARD RULES: Never invent numeric claims, money, dates, user counts, or company facts; only include numbers if they appear in the segments. If evidence is missing, mark 'Insufficient evidence [S#]'. Do NOT fabricate any facts about 'ZeroToken' unless quoted in segments."},
      { role: "user", content: `Title: ${title}\nLength: ${targetWords} words.\nTone: direct, decisive, warm.\n\nDEEP CONTEXT ONLY (content, no header):\n- Facts & Data: dense bullets with [S#] + short quotes.\n- Decisions & Rationale with [S#].\n- Constraints & Guardrails with [S#].\n- Full Next Actions table (may expand Primer).\n- Open Questions & Assumptions (with [S#] where applicable).\n- Artifacts / Snippets (only if clearly present with [S#]).\n- Tests (acceptance): 6–10 measurable checks.\n- Glossary & Canonical Terms: each term with [S#].\n- Delight Layer (brief): quick_start_script, wow_headlines, trust_tokens, next_three_moves.\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  // Strict JSON bundle (CBF-1) for deterministic PRIMER rendering
  function reducePromptBundle(title: string, pieces: string[], plan: string){
    return [
      { role: "system", content: "Output STRICT JSON only. No markdown or text. Purpose: produce a compact continuity bundle used to render a PRIMER deterministically. Do NOT invent numeric claims, companies, dates, or user counts. If evidence is missing, omit the field or use 'insufficient' flags. FORBIDDEN: generic definitions, tutorials, meta commentary."},
      { role: "user", content: `Title: ${title}\nReturn a JSON object with OPTIONAL keys:\n{\n  "system_instructions": string[],\n  "receiving_guide": string[],\n  "context_recap": string,\n  "key_facts": string[],\n  "decisions": string[],\n  "active_work": string[],\n  "open_questions": string[],\n  "next_actions": [{"action": string, "owner": string, "deps": string, "effort_h": number, "impact": "▲"|"▼", "rollback": string, "evidence": string}],\n  "first_task": {"bullets": string[], "acceptance": string[]},\n  "templates": {"gpt": string, "claude": string, "gemini": string}\n}\nConstraints:\n- Keep strings short, outcome-oriented.\n- owner must be one of: Founder, Product, Engineering, Design, Research, Growth, Ops, Legal, Data.\n- evidence may include [S#], other fields MUST NOT include [S#].\n- Use data ONLY extractable from segments; otherwise omit or use generic phrasing without numbers.\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  function sanitizeOwner(value: string): string{
    const allowed = new Set(["Founder","Product","Engineering","Design","Research","Growth","Ops","Legal","Data"]);
    const v = String(value||"").trim();
    if (allowed.has(v)) return v;
    // naive mapping
    const low = v.toLowerCase();
    if (/(eng|dev)/.test(low)) return "Engineering";
    if (/(design|ux|ui)/.test(low)) return "Design";
    if (/(research|analyst)/.test(low)) return "Research";
    if (/(prod|pm)/.test(low)) return "Product";
    if (/(ops|operation)/.test(low)) return "Ops";
    if (/(legal|compliance)/.test(low)) return "Legal";
    if (/(growth|mkt|marketing)/.test(low)) return "Growth";
    if (/(data|ds)/.test(low)) return "Data";
    if (/(founder|ceo)/.test(low)) return "Founder";
    return "Product";
  }

  function stripEvidenceTokens(s: string): string{
    return String(s||"").replace(/\[S#\]/gi, "").replace(/\[S\d+\]/gi, "").trim();
  }

  function renderPrimerFromBundle(title: string, bundle: any): string{
    function lines(arr?: any[]): string{ return (Array.isArray(arr)?arr:[]).map(s=>`- ${stripEvidenceTokens(String(s||""))}`).join("\n"); }
    const system = lines(bundle?.system_instructions);
    const guide = lines(bundle?.receiving_guide);
    const recap = stripEvidenceTokens(bundle?.context_recap||"");
    const facts = lines(bundle?.key_facts);
    const decisions = lines(bundle?.decisions);
    const active = lines(bundle?.active_work);
    const openq = lines(bundle?.open_questions);
    const rows: any[] = Array.isArray(bundle?.next_actions)? bundle.next_actions : [];
    const tableHeader = `| action | owner | deps | effort(h) | impact(▲/▼) | rollback | [S# optional] |\n| --- | --- | --- | --- | --- | --- | --- |`;
    const tableRows = rows.slice(0,12).map(r=>{
      const owner = sanitizeOwner(r?.owner||"");
      const deps = stripEvidenceTokens(r?.deps||"-");
      const rollback = stripEvidenceTokens(r?.rollback||"Define quick rollback");
      const impact = (r?.impact==="▼"?"▼":"▲");
      const effort = Number(r?.effort_h||0) || 4;
      const action = stripEvidenceTokens(r?.action||"Define next step");
      const ev = (r?.evidence||"").match(/\[S\d+\]/)? r.evidence : "";
      return `| ${action} | ${owner} | ${deps||"-"} | ${effort} | ${impact} | ${rollback} | ${ev} |`;
    }).join("\n");
    const firstTaskBul = lines(bundle?.first_task?.bullets);
    const firstTaskAcc = lines(bundle?.first_task?.acceptance);
    const t = bundle?.templates||{};
    const templates = `- GPT: ${stripEvidenceTokens(t?.gpt||"Continue seamlessly from this recap. Ask for missing constraints, then execute the top Next Actions.")}\n- Claude: ${stripEvidenceTokens(t?.claude||"Continue without re-asking context. Confirm assumptions, then execute.")}\n- Gemini: ${stripEvidenceTokens(t?.gemini||"Resume as if the chat never stopped. Prioritize Next Actions.")}`;

    const parts: string[] = [];
    parts.push(`### System / Operating Instructions\n${system||"- Act as a product+engineering copilot.\n- Be concise, decisive, shippable."}`);
    parts.push(`### Receiving LLM Guide\n${guide||"- Read recap.\n- Confirm missing inputs.\n- Execute Next Actions in order."}`);
    if (recap) parts.push(`### One-Paragraph Context Recap\n${recap}`);
    if (facts) parts.push(`### Key Facts\n${facts}`);
    if (decisions) parts.push(`### Decisions (Most recent → oldest)\n${decisions}`);
    if (active) parts.push(`### Active Work / What's Already Built\n${active}`);
    if (openq) parts.push(`### Open Questions\n${openq}`);
    parts.push(`### Next Actions\n${tableHeader}\n${tableRows}`);
    parts.push(`### First Task for the New LLM\n${firstTaskBul||"- Start with the first Next Action."}\n\nAcceptance:\n${firstTaskAcc||"- Produces a concrete artifact or measurable outcome."}`);
    parts.push(`### Cross-AI Injection Templates\n${templates}`);
    return parts.join("\n\n");
  }

  function refinePrompt(title: string, draft: string, plan: string){
    const pro = (plan||'free').toLowerCase()==='vault';
    const targetWords = pro ? '1000-1500' : '650-950';
    return [
      { role: "system", content: "You are an executive editor. Enforce structure, clarity, and completeness without adding new facts. Improve flow, add missing evidence markers if obvious, and ensure every section is present."},
      { role: "user", content: `Refine and strengthen the handoff below. Keep to ${targetWords} words, keep section headings, do not invent content beyond what is implied. Tighten Next Actions with clear rollback and ordering. Ensure Receiving LLM Guide is practical.\n\nTitle: ${title}\n\n--- DRAFT ---\n${draft}\n--- END DRAFT ---` }
    ];
  }

  async function asyncPool<T,R>(limit: number, items: T[], worker: (t:T, idx:number)=>Promise<R>): Promise<R[]>{
    const results: R[] = new Array(items.length);
    let i=0; let inFlight=0; let resolveAll: (v:R[])=>void; const done = new Promise<R[]>(res=>resolveAll=res);
    async function pump(){
      if(i>=items.length && inFlight===0){ resolveAll(results); return; }
      while(inFlight<limit && i<items.length){
        const idx=i++; const v=items[idx]; inFlight++;
        worker(v, idx).then((r)=>{ results[idx]=r; }).catch(()=>{ /* ignore */ }).finally(async()=>{ inFlight--; await pump(); });
      }
    }
    pump();
    return done;
  }

  // 1) Create job (mirrors v1 jobs semantics)
  const { data: jobRow, error: jobErr } = await admin
    .from("jobs")
    .insert({
      user_id: payload.userId,
      thread_id: payload.threadId,
      title: payload.title,
      stage: "mapping",
      status: "running",
      total_chunks: (payload.chunks?.length ?? 0) || 0,
      map_pct: 0,
      reduce_pct: 0,
      ui_percent: 0,
      plan: payload.plan || "free",
      model: "llama-3.1-8b-instant",
    })
    .select("id")
    .single();

  if (jobErr) return jsonResponse(500, { ok: false, error: `create job failed: ${jobErr.message}` });

  // 2) Fetch existing checkpoint maps for this thread (if any)
  const { data: cps } = await admin
    .from("checkpoints_v2")
    .select("checkpoint_number, from_msg_idx, to_msg_idx, summary, quick_summary, content_hash, created_at")
    .eq("thread_id", payload.threadId)
    .order("checkpoint_number", { ascending: true });

  // 3) Build source chunks: prefer payload.chunks; else use checkpoint quick summaries
  const inputChunks: string[] = Array.isArray(payload.chunks) && payload.chunks?.length
    ? payload.chunks!
    : (cps||[]).map(r=> (r.quick_summary || r.summary || "") as string).filter(Boolean);

  if(!inputChunks.length){
    await updateJobProgress({ stage: "final", status: "done", map_pct: 100, reduce_pct: 100, ui_percent: 100, result: "(no input chunks)" });
    return jsonResponse(201, { ok: true, job_id: jobRow.id, meta: { serverKick: true } });
  }

  // Precompute meta for UI header
  const checkpointCount = (cps?.length || 0);
  const tokenEstimate = Math.ceil(inputChunks.join("\n\n").length / 4);
  const anticipatedReduceModel = chooseModel(payload.plan, "reduce");

  // Persist meta early for visibility
  try{
    await admin.from("jobs").update({ model: anticipatedReduceModel, token_estimate: tokenEstimate, checkpoint_count: checkpointCount }).eq("id", jobRow.id);
  }catch{}

  // 4) Map phase (parallel with rate limiting)
  // Coalesce chunks to reduce number of Groq calls under high load
  function coalesce(items:string[]): string[]{
    const n = items.length;
    let group = 1;
    if (n > 140) group = 4; else if (n > 100) group = 3; else if (n > 60) group = 2; else group = 1;
    if (group === 1) return items;
    const out: string[] = [];
    for (let i=0;i<items.length;i+=group){ out.push(items.slice(i,i+group).join("\n\n")); }
    return out;
  }
  const groupedChunks = coalesce(inputChunks);
  const total = groupedChunks.length;
  // Update total_chunks for accurate progress UI
  try{ await admin.from("jobs").update({ total_chunks: total }).eq("id", jobRow.id); }catch{}
  let processed = 0;
  await updateJobProgress({ stage: "mapping", processed_chunks: 0, map_pct: 0, reduce_pct: 0, ui_percent: 5 });
  const mapModel = chooseModel(payload.plan, "map");
  // PERFORMANCE BOOST: Use MAX_PARALLEL for better concurrency
  let mapConcurrency = clamp(MAX_PARALLEL || (payload.plan?.toLowerCase?.()==="vault"?20:10), 1, (payload.plan?.toLowerCase?.()==="vault"?30:15));

  async function generateHighQualityMap(chunk: string): Promise<string>{
    // Try structured JSON first
    const candidates = Array.from(new Set([mapModel, "llama-3.1-8b-instant", "llama-3.1-70b-instant"]));
    const a = await callGroqWithFallback(candidates, mapPromptJSON(chunk), 640);
    let out = (a?.content||"").trim();
    const looksJSON = out.startsWith("{") && /\w+\s*:\s*\[/.test(out);
    const tooShort = out.replace(/[^a-z0-9]/gi,'').length < 60;
    const looksPlaceholder = /^={2,}\s*map segment/i.test(out) || /\b(map segment)\b/i.test(out);
    if (looksJSON && !tooShort && !looksPlaceholder) return out;

    // Fallback: compact bullets
    const b = await callGroqWithFallback(candidates, mapPromptBullets(chunk), 480);
    out = (b?.content||"").trim();
    const okBullets = (out.match(/\n|•|-/g)||[]).length >= 3 && out.length > 120;
    if (okBullets && !looksPlaceholder) return out;

    // If still poor, return empty so reducer ignores this piece
    return "";
  }

  const mapResults = await asyncPool(mapConcurrency, groupedChunks, async (chunk) => {
    const content = await generateHighQualityMap(chunk);
    processed++;
    const mapPct = Math.min(100, Math.round((processed/total)*100));
    const uiPct = Math.min(40, Math.round(mapPct*0.4));
    await updateJobProgress({ stage: "mapping", processed_chunks: processed, map_pct: mapPct, ui_percent: uiPct });
    return content || "";
  });

  // 5) Reduce phase
  await updateJobProgress({ stage: "reduce", reduce_pct: 10, ui_percent: 70 });
  const reduceCandidates = (payload.plan?.toLowerCase?.()==="vault")
    ? [
        chooseModel(payload.plan, "reduce"),
        "llama-3.1-70b-instant",
        "llama-3.1-8b-instant"
      ]
    : [ chooseModel(payload.plan, "reduce") ];
  const reduceMax = (payload.plan?.toLowerCase?.()==='vault') ? 3200 : 1400;
  const mapsFiltered = mapResults.filter(Boolean);
  const reduceInput = mapsFiltered.length ? mapsFiltered : inputChunks.map(s=> String(s||"").slice(0,1000)).slice(0,8);
  // Three-phase reduce: Bundle(JSON) → PRIMER(rendered) + DEEP(LLM)
  const bundleResp = await callGroqWithFallback(reduceCandidates, reducePromptBundle(payload.title || "Untitled Thread", reduceInput, payload.plan), Math.min(1200, Math.floor(reduceMax*0.45)));
  let primerText = "";
  try{
    const parsed = JSON.parse(bundleResp.content||"{}");
    primerText = renderPrimerFromBundle(payload.title || "Untitled Thread", parsed);
  }catch{
    // Fallback to LLM PRIMER if JSON parse fails
    const primerResp = await callGroqWithFallback(reduceCandidates, reducePromptPrimer(payload.title || "Untitled Thread", reduceInput, payload.plan), Math.min(1600, Math.floor(reduceMax*0.55)));
    primerText = (primerResp.content||"").trim();
  }
  const deepResp   = await callGroqWithFallback(reduceCandidates, reducePromptDeep(payload.title || "Untitled Thread", reduceInput, payload.plan), Math.min(2200, Math.floor(reduceMax*0.8)));
  // NEW FORMAT - Modern markdown with richer sections
  let finalText = `# ${payload.title || 'Handoff Report'}

## 👤 User Persona & Preferences
- Language: <auto>
- Style: <auto>
- Wants: continue seamlessly with actionable steps
- Avoid: boilerplate, generic definitions

## 🗺️ Timeline (Milestones)
- (earliest → latest) key turns summarized.

## 📌 Key Points
${primerText}

## 📋 Detailed Context
${(deepResp.content||"").trim()}

## 🎯 First Turn (Paste this to continue)
- Confirm assumptions and missing constraints.
- Execute top Next Actions with concrete outputs.
- Report artifacts produced and blockers.

## ⚡ Ready-to-Paste Injection
- Facts:
- Decisions:
- Open Questions:
- Next Steps:

## ⚡ Continue
Pick up the conversation naturally from where it ended.`;
  // Skip old format checks - using new markdown format
  const hasPrimerMarkers = true; // Always true for new format
  if (false){
    const enforcePrimerCandidates = [ reduceCandidates[0], "llama-3.1-8b-instant" ];
    const primerMsg = [
      { role: "system", content: "Rewrite the handoff into two sections with exact markers '=== PRIMER ===' then '=== DEEP CONTEXT ==='. Keep all facts, preserve [S#] evidence markers, do not invent content. Primer must include a Starter Prompt paragraph and a condensed Next Actions table; Deep must include the full structure. Keep overall length roughly the same."},
      { role: "user", content: `Title: ${payload.title || 'Untitled Thread'}\n\n--- DRAFT ---\n${finalText}\n--- END DRAFT ---` }
    ];
    const enforcedPrimer = await callGroqWithFallback(enforcePrimerCandidates, primerMsg, Math.min(2800, Math.floor(reduceMax*0.9)));
    if (enforcedPrimer.content && !enforcedPrimer.content.startsWith('(groq error)')) finalText = enforcedPrimer.content;
  }

  // After markers are present, run targeted checks for PRIMER completeness and DEEP evidence
  try{
    const primerMatch = finalText.match(/===\s*PRIMER\s*===([\s\S]*?)===\s*DEEP CONTEXT\s*===/i);
    const deepMatch = finalText.match(/===\s*DEEP CONTEXT\s*===([\s\S]*)$/i);
    const primer = primerMatch?.[1] || "";
    let deep = deepMatch?.[1] || "";

    // Sanitize inline markers that leaked into content
    const sanitizeInlineMarkers = (s: string)=> s.replace(/\s*===\s*PRIMER\s*===\s*/gi, " ").replace(/\s*===\s*DEEP CONTEXT\s*===\s*/gi, " ");
    const cleanPrimer = sanitizeInlineMarkers(primer);
    deep = sanitizeInlineMarkers(deep);

    // 1) Ensure PRIMER includes Next Actions table and System/Context blocks
    const hasNextActionsTable = /Next Actions[\s\S]*?\n\|\s*action\s*\|\s*owner\s*\|\s*deps\s*\|\s*effort\(h\)\s*\|\s*impact/i.test(primer);
    const hasSystemOrContext = /(System\s*\/\s*Operating Instructions|One-Paragraph Context Recap|One\-Paragraph Context)/i.test(primer);
    if (!hasNextActionsTable || !hasSystemOrContext){
      const fixPrimerCandidates = [ reduceCandidates[0], "llama-3.1-8b-instant" ];
      const fixPrimerMsg = [
        { role: "system", content: "Strengthen the PRIMER section ONLY: ensure it contains System/Operating Instructions, One-Paragraph Context Recap, and a Next Actions table with columns (action|owner|deps|effort(h)|impact(▲/▼)|rollback|[S# optional]). Keep it concise. Do not modify DEEP CONTENT."},
        { role: "user", content: `Title: ${payload.title || 'Untitled Thread'}\n\n--- PRIMER ---\n${cleanPrimer}\n--- KEEP DEEP AS IS ---` }
      ];
      const fixedPrimer = await callGroqWithFallback(fixPrimerCandidates, fixPrimerMsg, Math.min(1800, Math.floor(reduceMax*0.6)));
      if (fixedPrimer.content && !fixedPrimer.content.startsWith('(groq error)')){
        // Reassemble document: replace PRIMER body
        const rebuilt = finalText.replace(/(===\s*PRIMER\s*===)[\s\S]*?(===\s*DEEP CONTEXT\s*===)/i, `$1\n${fixedPrimer.content}\n$2`);
        if (rebuilt) finalText = rebuilt;
      }
    }

    // 2) Ensure DEEP contains [S#] evidence markers; if not, refine DEEP only
    const deepHasEvidence = /\[S\d+\]/.test(deep);
    if (!deepHasEvidence){
      const addEvidenceCandidates = [ reduceCandidates[0], "llama-3.1-8b-instant" ];
      const addEvidenceMsg = [
        { role: "system", content: "Add inline [S#] evidence markers and ≤120-char short quotes to important factual statements IN THE DEEP CONTEXT SECTION ONLY. Do not change the PRIMER; keep length roughly the same."},
        { role: "user", content: `Title: ${payload.title || 'Untitled Thread'}\n\n--- DEEP CONTEXT ---\n${deep}\n--- END ---` }
      ];
      const deepRefined = await callGroqWithFallback(addEvidenceCandidates, addEvidenceMsg, Math.min(2200, Math.floor(reduceMax*0.8)));
      if (deepRefined.content && !deepRefined.content.startsWith('(groq error)')){
        const rebuilt = finalText.replace(/(===\s*DEEP CONTEXT\s*===)[\s\S]*$/i, `$1\n${deepRefined.content}`);
        if (rebuilt) finalText = rebuilt;
      }
    }

    // 3) Sanitize Next Actions tables: enforce Owner roles and remove [S#] placeholders from non-evidence columns
    const ownerRoles = "Founder|Product|Engineering|Design|Research|Growth|Ops|Legal|Data";
    const hasBadOwner = /(\|\s*\[S#\]\s*\|)|(\|\s*owner\s*\|\s*deps)/i.test(primer);
    if (hasBadOwner){
      const sanitizeCandidates = [ reduceCandidates[0], "llama-3.1-8b-instant" ];
      const sanitizeMsg = [
        { role: "system", content: `Fix Next Actions tables in the PRIMER ONLY: ensure Owner is one of {${ownerRoles}}, replace invalid or empty Owner cells accordingly; remove [S#] tokens from deps/rollback/owner/effort/impact cells, keeping [S#] only in the last evidence column; keep rows concise and do not drop rows.`},
        { role: "user", content: `--- PRIMER ---\n${primer}\n--- END PRIMER ---` }
      ];
      const sanitizedPrimer = await callGroqWithFallback(sanitizeCandidates, sanitizeMsg, 1200);
      if (sanitizedPrimer.content && !sanitizedPrimer.content.startsWith('(groq error)')){
        const rebuilt = finalText.replace(/(===\s*PRIMER\s*===)[\s\S]*?(===\s*DEEP CONTEXT\s*===)/i, `$1\n${sanitizeInlineMarkers(sanitizedPrimer.content)}\n$2`);
        if (rebuilt) finalText = rebuilt;
      }
    }
  }catch{ /* best-effort post-processing */ }

  // If reduce hit RL error, retry once after backoff with smaller context and different order
  if (finalText.startsWith('(groq error)') && finalText.includes('429')){
    bumpBackoff(); await sleep(jitter(rlBackoffMs));
    const altCandidates = Array.from(new Set([ "llama-3.1-70b-instant", "llama-3.1-8b-instant", reduceCandidates[0] ]));
    const smaller = reduceInput.slice(0, Math.max(2, Math.min(6, Math.floor(reduceInput.length/2)||3)));
    const retried = await callGroqWithFallback(altCandidates, reducePrompt(payload.title || "Untitled Thread", smaller, payload.plan), Math.floor(reduceMax*0.7));
    if (retried.content && !retried.content.startsWith('(groq error)')) finalText = retried.content;
  }

  // Enforce evidence markers: if missing, do a targeted refine to add [S#] markers and tables
  const needsEvidence = !/\[S\d+\]/.test(finalText);
  if (needsEvidence){
    const enforce = [ reduceCandidates[0], "llama-3.1-8b-instant" ];
    const msg = [
      { role: "system", content: "Add inline [S#] evidence markers to every important factual statement and ensure Next Actions is a table (action | owner_placeholder | deps | effort(h) | impact(▲/▼) | rollback | [S#]). Do not invent; when evidence is missing, mark as insufficient. Keep length roughly the same."},
      { role: "user", content: `Title: ${payload.title || 'Untitled Thread'}\n\n--- DRAFT ---\n${finalText}\n--- END DRAFT ---` }
    ];
    const enforced = await callGroqWithFallback(enforce, msg, Math.floor(reduceMax*0.8));
    if (enforced.content && !enforced.content.startsWith('(groq error)')) finalText = enforced.content;
  }

  // Optional refine pass for Pro
  if ((payload.plan||'free').toLowerCase()==='vault'){
    await updateJobProgress({ stage: "final", reduce_pct: 95, ui_percent: 95 });
    const refineCandidates = [ reduceCandidates[0], "llama-3.1-8b-instant" ];
    const refined = await callGroqWithFallback(refineCandidates, refinePrompt(payload.title || "Untitled Thread", finalText, payload.plan), 1600);
    if (refined.content && !refined.content.startsWith('(groq error)')) finalText = refined.content;
  }
  await updateJobProgress({ stage: "final", reduce_pct: 100, ui_percent: 100 });

  // 6) Finalize
  const { error: doneErr } = await admin
    .from("jobs")
    .update({ stage: "final", status: "done", result: finalText })
    .eq("id", jobRow.id);
  if (doneErr) return jsonResponse(500, { ok: false, error: `finalize job failed: ${doneErr.message}` });

  return jsonResponse(201, { ok: true, job_id: jobRow.id, meta: { serverKick: true, model: anticipatedReduceModel, token_estimate: tokenEstimate, checkpoint_count: checkpointCount, zt_rev: ZT_REVISION } });
}
Deno.serve(handler);


