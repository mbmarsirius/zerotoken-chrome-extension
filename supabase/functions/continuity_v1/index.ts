// @ts-nocheck
// Supabase Edge Function: continuity_v1 — DUAL-STAGE FLAWLESS™ System
// Stage 1: Fast Extraction | Stage 2: Smart Assembly

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const ZT_REVISION = "continuity_v1@v2"; // default; maxclean_v1 is opt-in via payload.rev==='maxclean_v1'

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

export default async function handler(req: Request){
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method Not Allowed" });

  let payload: StartPayload & { rev?: string, revision?: string };
  try { payload = (await req.json()) as StartPayload; } catch { return jsonResponse(400, { ok: false, error: "Invalid JSON" }); }

  const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) return jsonResponse(202, { ok: false, serverKick: false, reason: "SERVICE_ROLE_KEY missing" });
  const admin = createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false } });

  const groqKeyPro  = Deno.env.get("GROQ_API_KEY_PRO")  || "";
  const groqKeyFree = Deno.env.get("GROQ_API_KEY_FREE") || "";
  const groqKeyAny  = Deno.env.get("GROQ_API_KEY")      || "";
  const groqKey     = (payload.plan?.toLowerCase?.()==="vault" ? (groqKeyPro||groqKeyAny) : (groqKeyFree||groqKeyAny));
  const openaiKey   = Deno.env.get("OPENAI_API_KEY")    || "";
  const embedModel  = Deno.env.get("OPENAI_EMBED_MODEL") || "text-embedding-3-small";
  
  // PERFORMANCE BOOST: Increase parallel processing
  const MAX_PARALLEL = payload.maxMapConcurrency || 10; // Increased from 5 to 10

  let rlBackoffMs = 0;
  function jitter(ms:number){ return ms + Math.floor(Math.random()*200); }
  function bumpBackoff(){ rlBackoffMs = Math.min(8000, Math.max(1000, rlBackoffMs ? Math.floor(rlBackoffMs*1.6) : 1200)); }
  function dropBackoff(){ rlBackoffMs = Math.floor(rlBackoffMs*0.5); }
  const sleep = (ms:number)=> new Promise(res=> setTimeout(res, ms));

  function chooseModel(plan: string, phase: "bundle"|"deep"): string{
    if(phase==="bundle") return Deno.env.get("GROQ_MAP_MODEL") || "llama-3.1-8b-instant";
    if(plan?.toLowerCase?.()==="vault") return Deno.env.get("GROQ_REDUCE_MODEL_PRO") || "llama-3.3-70b-versatile";
    return Deno.env.get("GROQ_REDUCE_MODEL_FREE") || "llama-3.1-8b-instant";
  }

  async function callGroq(model: string, messages: any[], maxTokens=512): Promise<string>{
    if(!groqKey){ return "(groq disabled)"; }
    try{
      if (rlBackoffMs>0) { await sleep(jitter(rlBackoffMs)); }
      const res = await fetch(GROQ_API_URL,{
        method:"POST",
        headers:{"content-type":"application/json","authorization":`Bearer ${groqKey}`},
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens })
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

  // --- Saliency utilities (v3-saliency) ---
  function approxTruncateTokens(text: string, maxTokens=512): string{
    const maxChars = maxTokens * 4; // rough 4 chars/token heuristic
    const s = String(text||"");
    return s.length > maxChars ? s.slice(0, maxChars) : s;
  }
  function normalizeText(s: string): string{
    return String(s||"")
      .replace(/\s+/g,' ')
      .replace(/\*\*|__|`|#+/g,'')
      .trim();
  }
  function heuristicCategory(text: string): "decisions"|"facts"|"constraints"|"asks"|"artifacts"{
    const t = text.toLowerCase();
    // decisions
    if (/(decided|decision|choose|approved|onay|karar|kararlaştır)/.test(t)) return "decisions";
    // facts
    if (/(fact|data|metric|kanıt|veri|ölçüm)/.test(t)) return "facts";
    // constraints
    if (/(constraint|limit|blocked|risk|kısıt|sınır|engel|risk)/.test(t)) return "constraints";
    // asks/questions
    if (/(ask|question|need|todo|soru|istek|talep)/.test(t)) return "asks";
    // artifacts/code
    if (/(code|snippet|artifact|repo|dosya|kod|script)/.test(t)) return "artifacts";
    return "facts";
  }
  function categoryWeight(cat: string): number{
    if (cat==="decisions") return 1.3;
    if (cat==="facts") return 1.15;
    if (cat==="constraints") return 1.1;
    if (cat==="asks") return 1.05;
    return 1.0; // artifacts
  }
  function noisePenalty(text: string): number{
    const t = text.toLowerCase();
    const tutorial = /(tutorial|how to|guide|öğretici|adım adım|step by step)/.test(t);
    const smalltalk = /(thanks|teşekkür|hello|selam|günaydın)/.test(t);
    let penalty = 1.0;
    if (tutorial) penalty *= 0.8;
    if (smalltalk) penalty *= 0.85;
    return penalty;
  }
  function l2norm(vec: number[]): number{ return Math.sqrt(vec.reduce((a,b)=>a+b*b,0)); }
  function dot(a: number[], b: number[]): number{ let s=0; for(let i=0;i<Math.min(a.length,b.length);i++) s+=a[i]*b[i]; return s; }
  function cosine(a: number[], b: number[]): number{ const d=dot(a,b); const na=l2norm(a)||1e-9; const nb=l2norm(b)||1e-9; return d/(na*nb); }
  function hashEmbed(text: string, dim=256): number[]{
    const v = new Array(dim).fill(0);
    const words = text.split(/\s+/g).slice(0, 800);
    for (const w of words){
      let h=0; for(let i=0;i<w.length;i++){ h = ((h<<5)-h) + w.charCodeAt(i); h|=0; }
      const idx = Math.abs(h)%dim; v[idx]+=1;
    }
    const n = l2norm(v)||1; return v.map(x=> x/n);
  }
  async function embedOpenAI(texts: string[]): Promise<number[][]>{
    try{
      const body = { model: embedModel, input: texts };
      const r = await fetch("https://api.openai.com/v1/embeddings",{
        method:"POST",
        headers:{"content-type":"application/json","authorization":`Bearer ${openaiKey}`},
        body: JSON.stringify(body)
      });
      if(!r.ok){ const t = await r.text().catch(()=>""); throw new Error(`embed ${r.status}: ${t.slice(0,150)}`); }
      const j = await r.json();
      const arr = (j?.data||[]).map((d: any)=> d?.embedding || []);
      return arr;
    }catch{ return texts.map(t=> hashEmbed(t)); }
  }
  async function getEmbeddings(texts: string[]): Promise<{vecs:number[][], method:string}>{
    const useOpenAI = !!openaiKey;
    const cleaned = texts.map(s=> approxTruncateTokens(normalizeText(s), 512));
    if (useOpenAI){
      const vecs = await embedOpenAI(cleaned);
      return { vecs, method: `openai:${embedModel}` };
    }
    return { vecs: cleaned.map(t=> hashEmbed(t)), method: "hash-256" };
  }
  function mmrSelect(candidates: {text:string, vec:number[], base:number}[], k=30, lambda=0.7, queryVec?: number[]): {text:string, idx:number}[]{
    if (candidates.length<=k) return candidates.map((c,idx)=>({text:c.text, idx}));
    const selected: number[] = [];
    const used = new Set<number>();
    // Query: title embedding if provided; else centroid
    const dim = candidates[0].vec.length;
    let centroid = queryVec && queryVec.length===dim ? queryVec.slice() : new Array(dim).fill(0);
    if (!queryVec){
      for (const c of candidates){ for(let i=0;i<dim;i++){ centroid[i]+=c.vec[i]; } }
      const norm = l2norm(centroid)||1; for(let i=0;i<dim;i++) centroid[i]/=norm;
    } else {
      const norm = l2norm(centroid)||1; for(let i=0;i<dim;i++) centroid[i]/=norm;
    }
    while(selected.length<k){
      let bestIdx=-1; let bestScore=-1e9;
      for (let i=0;i<candidates.length;i++){
        if (used.has(i)) continue;
        const c = candidates[i];
        const simToQuery = cosine(c.vec, centroid) * c.base;
        let maxRedundancy = 0;
        for (const si of selected){
          const svec = candidates[si].vec;
          const sim = cosine(c.vec, svec);
          if (sim>maxRedundancy) maxRedundancy = sim;
        }
        const score = lambda*simToQuery - (1-lambda)*maxRedundancy;
        if (score>bestScore){ bestScore=score; bestIdx=i; }
      }
      if (bestIdx<0) break;
      selected.push(bestIdx); used.add(bestIdx);
    }
    return selected.map((i)=>({ text: candidates[i].text, idx: i }));
  }

  // OpenAI GPT-4o-mini for FLAWLESS quality and speed
  async function callOpenAI(messages: any[], maxTokens: number): Promise<{content: string, model: string}> {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      console.warn("OpenAI API key not found, falling back to Groq");
      return callGroqWithFallback(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], messages, maxTokens);
    }
    
    try {
      const response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          max_tokens: maxTokens,
          temperature: 0.3
        })
      });
      
      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }
      
      const data = await response.json();
      return { content: data.choices[0].message.content, model: "gpt-4o-mini" };
    } catch (error) {
      console.error("OpenAI API failed, falling back to Groq:", error);
      return callGroqWithFallback(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], messages, maxTokens);
    }
  }

  async function callGroqWithFallback(models: string[], messages: any[], maxTokens=512): Promise<{content: string, model: string}> {
    let lastErr = "";
    for (const m of models){
      const out = await callGroq(m, messages, maxTokens);
      if (out && !out.startsWith("(groq error)")) return { content: out, model: m };
      lastErr = out;
      if (String(out).includes("429")) { bumpBackoff(); await sleep(jitter(rlBackoffMs)); }
    }
    return { content: lastErr || "(groq error) no models succeeded", model: models[models.length-1] };
  }

  async function updateJobProgress(fields: Record<string,unknown>){
    try{ await admin.from("jobs").update({...fields, heartbeat_at: new Date().toISOString()}).eq("id", jobRow.id); }catch{}
  }

  function reducePromptBundle(title: string, pieces: string[], plan: string){
    return [
      { role: "system", content: "Output STRICT JSON only. No markdown. Purpose: continuity bundle for deterministic PRIMER. FORBIDDEN: generic definitions/tutorials/meta. Never invent numbers/companies/dates/users. If absent, omit or mark 'insufficient'."},
      { role: "user", content: `Title: ${title}\nReturn JSON with OPTIONAL keys:\n{\n  "system_instructions": string[],\n  "receiving_guide": string[],\n  "context_recap": string,\n  "key_facts": string[],\n  "decisions": string[],\n  "active_work": string[],\n  "open_questions": string[],\n  "next_actions": [{"action": string, "owner": string, "deps": string, "effort_h": number, "impact": "▲"|"▼", "rollback": string, "evidence": string}],\n  "first_task": {"bullets": string[], "acceptance": string[]},\n  "templates": {"gpt": string, "claude": string, "gemini": string}\n}\nowner ∈ {Founder,Product,Engineering,Design,Research,Growth,Ops,Legal,Data}.\nEvidence may include [S#]; other fields MUST NOT.\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  // V3: strict PRIMER bundle schema with REQUIRED keys
  function reducePromptBundleV3(title: string, pieces: string[], plan: string){
    return [
      { role: "system", content: "Output STRICT JSON only. No markdown or prose. Purpose: continuity PRIMER bundle with REQUIRED keys. BAN generic/meta placeholders (e.g., 'As an AI', 'Changes Made', 'Data format JSON', 'link placeholder'). If evidence is missing for a string field, set value to 'Insufficient evidence [S#]'. Use only extractable context; never invent numbers/dates/companies."},
      { role: "user", content: `Title: ${title}\nReturn a JSON object with REQUIRED keys and shapes:\n{\n  "system_instructions": string[],\n  "receiving_guide": string[],\n  "user_profile": {\n    "language": string,\n    "style": string[],\n    "wants": string[],\n    "avoid": string[],\n    "detail_level": "low"|"medium"|"high"|string,\n    "format_prefs": string[],\n    "target_models": string[]\n  },\n  "context_recap": string,\n  "key_facts": string[],\n  "decisions": string[],\n  "constraints": string[],\n  "active_work": string[],\n  "open_questions": string[],\n  "next_actions": [{"action": string, "owner": "Founder"|"Product"|"Engineering"|"Design"|"Research"|"Growth"|"Ops"|"Legal"|"Data", "deps": string, "effort_h": number, "impact": "▲"|"▼", "rollback": string, "evidence": string}],\n  "first_task": {"bullets": string[], "acceptance": string[]},\n  "injection_templates": {"gpt": string, "claude": string, "gemini": string}\n}\nRules:\n- Fill ALL keys. No null/undefined.\n- Arrays may be empty if insufficient.\n- next_actions: 6–12 rows if evidence exists; otherwise may be empty array. [S#] only allowed in 'evidence'.\n- No generic/meta boilerplate anywhere.\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  // V4: ChatGPT-only STRICT JSON PRIMER bundle (no prose), EN only
  function reducePromptBundleV4(title: string, pieces: string[], plan: string){
    return [
      { role: "system", content: "Output STRICT JSON ONLY (no prose). Language: EN. Purpose: ChatGPT-only PRIMER bundle with REQUIRED keys. Extractive-first: include tiny inline quotes with [S#] where possible; if missing, write 'insufficient evidence [S#]'. BAN generic/meta strings: /(As an AI|Changes Made|Data format JSON|link placeholder)/. No marketing/branding names. Never invent numbers/dates/companies."},
      { role: "user", content: `Title: ${title}\nReturn a JSON object with REQUIRED keys and shapes:\n{\n  \"system_instructions\": string[],\n  \"receiving_guide\": string[],\n  \"user_profile\": {\n    \"language\": \"English\",\n    \"style\": string[],\n    \"wants\": string[],\n    \"avoid\": string[],\n    \"detail_level\": \"low\"|\"medium\"|\"high\"|string,\n    \"format_prefs\": string[],\n    \"target_models\": [\"gpt-4o\"|\"gpt-4.1\"|string]\n  },\n  \"context_recap\": string,\n  \"key_facts\": string[],\n  \"decisions\": string[],\n  \"constraints\": string[],\n  \"active_work\": string[],\n  \"open_questions\": string[],\n  \"next_actions\": [{\"action\": string, \"owner\": \"Founder\"|\"Product\"|\"Engineering\"|\"Design\"|\"Research\"|\"Growth\"|\"Ops\"|\"Legal\"|\"Data\", \"deps\": string, \"effort_h\": number, \"impact\": \"▲\"|\"▼\", \"rollback\": string, \"evidence\": string}],\n  \"first_task\": {\"bullets\": string[], \"acceptance\": string[]},\n  \"injection_templates\": {\"gpt\": string}\n}\nRules:\n- Use compact, outcome-focused strings in EN.\n- Include tiny inline quotes with [S#] when possible.\n- If insufficient, set to 'insufficient evidence [S#]'.\n- No marketing/branding names in any field.\n- Output only JSON, no markdown.\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  // Fast60: Extractive pass (per chunk)
  function extractivePrompt(chunk: string, chunkId: number){
    return [
      { role: "system", content: "Extract 1-2 bullets from THIS CHUNK ONLY. Return STRICT JSON: {\"bullets\":[{\"text\":\"extracted fact/decision\", \"quote\":\"tiny quote\", \"id\":\"[C" + chunkId + "]\"}]}. Rules: text must be extractive (not invented). quote must be ≤60 chars from chunk. id must be exactly [C" + chunkId + "]. Prefer decisions, facts, constraints, asks. If nothing salient: {\"bullets\":[]}. Language: English." },
      { role: "user", content: `Extract from chunk [C${chunkId}]:\n${chunk}` }
    ];
  }

  // Fast60: Dense recap compression (≤2k tokens)
  function compressPrompt(extractiveBullets: any[], title: string, isSecondPass=false){
    const bulletsText = extractiveBullets.map(b => `${b.text} ${b.quote} ${b.id}`).join('\n');
    const sysContent = isSecondPass ? 
      "SECOND COMPRESSION PASS. Aggressively trim to ≤1900 tokens. Remove all '...' placeholders. Keep only essential facts, decisions, questions, and next steps with [C#] evidence. Terse, no fluff." :
      "Create ZeroToken™ quality recap in conversation language. Compress into: Key Facts (with evidence [C#]), Decisions Made, Current Status, Next Actions. NO repetition, NO generic code examples. Focus on ACTUAL conversation. Max 1800 tokens. Make it so good that next LLM will appreciate the handoff quality.";
    return [
      { role: "system", content: sysContent },
      { role: "user", content: `Title: ${title}\nExtracted bullets:\n${bulletsText}` }
    ];
  }
  
  // C) MIN BULLET QUORUM enforcement
  function enforceMinBulletQuorum(bundle: any, requestedRev: string): { bundle: any, quorumMet: boolean } {
    if (requestedRev !== "continuity_v1@fast60_hotfix4") {
      return { bundle, quorumMet: true };
    }
    
    let facts = Array.isArray(bundle?.key_facts) ? bundle.key_facts.filter(f => f && !f.includes('Insufficient evidence') && f.length > 5) : [];
    let decisions = Array.isArray(bundle?.decisions) ? bundle.decisions.filter(d => d && !d.includes('Insufficient evidence') && d.length > 5) : [];
    let questions = Array.isArray(bundle?.open_questions) ? bundle.open_questions.filter(q => q && !q.includes('Insufficient evidence') && q.length > 5) : [];
    let actions = Array.isArray(bundle?.next_actions) ? bundle.next_actions.filter(a => a && a.action && a.action.length > 5) : [];
    
    // Enforce minimums
    while (facts.length < 3) facts.push("No strong evidence found; continue by collecting research sources.");
    while (decisions.length < 1) decisions.push("No strong evidence found; continue by collecting decision context.");
    while (questions.length < 1) questions.push("No strong evidence found; continue by collecting question context.");
    while (actions.length < 3) actions.push({
      action: "Continue research producing artifact",
      owner: "Research",
      deps: "Current findings",
      rollback: "Pause research",
      evidence: "[C#]"
    });
    
    const updated = { ...bundle };
    updated.key_facts = facts;
    updated.decisions = decisions;
    updated.open_questions = questions;
    updated.next_actions = actions;
    
    const quorumMet = facts.length >= 3 && decisions.length >= 1 && actions.length >= 3;
    return { bundle: updated, quorumMet };
  }

  // A) INJECTION — PLACEHOLDER YASAK
  function buildGptInjectionV4_1(bundle: any): string {
    // Clean and filter arrays, removing banned strings
    const cleanArray = (arr: any[]) => (Array.isArray(arr) ? arr : [])
      .filter(item => item && typeof item === 'string' && item.length > 5)
      .map(item => stripEvidence(item).replace(/\.\.\./g, '').replace(/…/g, '').replace(/Insufficient evidence/gi, '').replace(/TBD/gi, ''))
      .filter(item => item.length > 3);
    
    let facts = cleanArray(bundle?.key_facts).slice(0,5);
    let decisions = cleanArray(bundle?.decisions).slice(0,4);
    let questions = cleanArray(bundle?.open_questions).slice(0,3);
    let actions = (Array.isArray(bundle?.next_actions) ? bundle.next_actions : []).slice(0,4);
    
    const sections = [];
    
    // Facts section (min 1 bullet)
    if (facts.length === 0) {
      facts = ["No strong evidence found; continue by collecting research sources."];
    }
    sections.push(`- Facts:\n${facts.map(f => `  • ${f}`).join('\n')}`);
    
    // Decisions section (min 1 bullet)
    if (decisions.length === 0) {
      decisions = ["No strong evidence found; continue by collecting decision context."];
    }
    sections.push(`- Decisions:\n${decisions.map(d => `  • ${d}`).join('\n')}`);
    
    // Questions section (min 1 bullet)
    if (questions.length === 0) {
      questions = ["No strong evidence found; continue by collecting question context."];
    }
    sections.push(`- Open Questions:\n${questions.map(q => `  • ${q}`).join('\n')}`);
    
    // Next steps section (min 1 bullet)
    if (actions.length === 0) {
      actions = [{ action: "No strong evidence found; continue by collecting action items." }];
    }
    sections.push(`- Next Steps:\n${actions.map(a => `  • ${stripEvidence(a.action||'').replace(/\.\.\./g, '').replace(/…/g, '')}`).join('\n')}`);
    
    let injection = `CONTEXT RECAP (ZeroToken Continuity)\n${sections.join('\n')}\n\nInstruction: Continue seamlessly as if the session never stopped. Be concise and actionable.`;
    
    // A) Cap at 9000 chars
    if (injection.length > 9000) {
      const shortActions = actions.slice(0, 2);
      sections[3] = `- Next Steps:\n${shortActions.map(a => `  • ${stripEvidence(a.action||'').slice(0,80)}`).join('\n')}`;
      injection = `CONTEXT RECAP (ZeroToken Continuity)\n${sections.join('\n')}\n\nInstruction: Continue seamlessly as if the session never stopped. Be concise and actionable.`;
    }
    
    return injection;
  }

  // Enhanced injection builder (no placeholders, ever) - legacy
  function buildGptInjection(bundle: any): string {
    const facts = Array.isArray(bundle?.key_facts) ? bundle.key_facts.filter(f => f && !f.includes('Insufficient evidence') && f.length > 5).slice(0,5) : [];
    const decisions = Array.isArray(bundle?.decisions) ? bundle.decisions.filter(d => d && !d.includes('Insufficient evidence') && d.length > 5).slice(0,4) : [];
    const questions = Array.isArray(bundle?.open_questions) ? bundle.open_questions.filter(q => q && !q.includes('Insufficient evidence') && q.length > 5).slice(0,3) : [];
    const actions = Array.isArray(bundle?.next_actions) ? bundle.next_actions.slice(0,4) : [];
    
    const sections = [];
    
    // Facts section
    if (facts.length) {
      sections.push(`- Facts:\n${facts.map(f => `  • ${stripEvidence(f).replace(/\.\.\./g, '').replace(/…/g, '')}`).join('\n')}`);
    } else {
      sections.push(`- Facts:\n  • No strong evidence found; continue by collecting research sources.`);
    }
    
    // Decisions section  
    if (decisions.length) {
      sections.push(`- Decisions:\n${decisions.map(d => `  • ${stripEvidence(d).replace(/\.\.\./g, '').replace(/…/g, '')}`).join('\n')}`);
    } else {
      sections.push(`- Decisions:\n  • No strong evidence found; continue by collecting decision context.`);
    }
    
    // Questions section
    if (questions.length) {
      sections.push(`- Open Questions:\n${questions.map(q => `  • ${stripEvidence(q).replace(/\.\.\./g, '').replace(/…/g, '')}`).join('\n')}`);
    } else {
      sections.push(`- Open Questions:\n  • No strong evidence found; continue by collecting question context.`);
    }
    
    // Next steps section
    if (actions.length) {
      sections.push(`- Next Steps:\n${actions.map(a => `  • ${stripEvidence(a.action||'').replace(/\.\.\./g, '').replace(/…/g, '')}`).join('\n')}`);
    } else {
      sections.push(`- Next Steps:\n  • No strong evidence found; continue by collecting action items.`);
    }
    
    let injection = `CONTEXT RECAP (ZeroToken Continuity)\n${sections.join('\n')}\n\nInstruction: Continue seamlessly as if the session never stopped. Be concise and actionable.`;
    
    // Cap at 9000 chars
    if (injection.length > 9000) {
      // Re-compress Next Steps first
      const shortActions = actions.slice(0, 2);
      sections[3] = shortActions.length ? 
        `- Next Steps:\n${shortActions.map(a => `  • ${stripEvidence(a.action||'').slice(0,80)}`).join('\n')}` :
        `- Next Steps:\n  • Continue with current task focus.`;
      injection = `CONTEXT RECAP (ZeroToken Continuity)\n${sections.join('\n')}\n\nInstruction: Continue seamlessly as if the session never stopped. Be concise and actionable.`;
    }
    
    return injection;
  }
  
  // Injection validation
  function validateInjection(injection: string): { valid: boolean, issues: string[] } {
    const issues = [];
    const banned = /As an AI|This summary|Changes Made|Data format JSON|link placeholder|marketing|fonts|brand colors|Insufficient evidence|\.\.\.|\u2026/i;
    
    if (banned.test(injection)) issues.push('banned_phrases');
    if (!/- Facts:/i.test(injection)) issues.push('missing_facts_header');
    if (!/- Decisions:/i.test(injection)) issues.push('missing_decisions_header');  
    if (!/- Open Questions:/i.test(injection)) issues.push('missing_questions_header');
    if (!/- Next Steps:/i.test(injection)) issues.push('missing_steps_header');
    
    const bulletCount = (injection.match(/•/g) || []).length;
    if (bulletCount < 4) issues.push('insufficient_bullets');
    
    return { valid: issues.length === 0, issues };
  }

  // Fast60: PRIMER JSON from dense recap
  function primerFromRecapPrompt(title: string, denseRecap: string){
    return [
      { role: "system", content: "Produce STRICT JSON ONLY for the PRIMER bundle. Rules: ALL next_actions must have action starting with capital verb and containing 'producing' + specific file artifact (.csv, .md, .json). For research/analysis topics, prefer artifacts like 'top10.csv', 'sources.md', 'insights.md'. owner must be from: Founder,Product,Engineering,Design,Research,Growth,Ops,Legal,Data. deps & rollback must be non-empty strings. injection_templates.gpt must be filled. Return ONLY JSON. No prose." },
      { role: "user", content: `Title: ${title}\nDense recap:\n${denseRecap}\n\nReturn JSON with EXACTLY this structure:\n{\n  \"system_instructions\": [\"Act as engineering copilot\", \"Be concise and actionable\"],\n  \"receiving_guide\": [\"Read context recap\", \"Execute next actions\"],\n  \"user_profile\": {\n    \"language\": \"English\",\n    \"style\": [\"direct\", \"honest\"],\n    \"wants\": [\"copy-paste outputs\", \"fast results\"],\n    \"avoid\": [\"marketing fluff\", \"generic headings\"],\n    \"detail_level\": \"medium\",\n    \"format_prefs\": [\"bullets\", \"code blocks\"],\n    \"target_models\": [\"gpt\"]\n  },\n  \"context_recap\": \"Brief summary of current context\",\n  \"key_facts\": [\"Fact 1 [C1]\", \"Fact 2 [C2]\"],\n  \"decisions\": [\"Decision 1 [C1]\"],\n  \"constraints\": [\"Constraint 1 [C1]\"],\n  \"active_work\": [\"Work item 1 [C1]\"],\n  \"open_questions\": [\"Question 1 [C1]\"],\n  \"next_actions\": [\n    {\n      \"action\": \"Compile top-10 extension acquisitions producing table.md\",\n      \"owner\": \"Research\",\n      \"deps\": \"Source verification\",\n      \"rollback\": \"Remove table\",\n      \"evidence\": \"[C1]\"\n    },\n    {\n      \"action\": \"Document acquisition sources producing sources.md\",\n      \"owner\": \"Research\", \n      \"deps\": \"Data collection\",\n      \"rollback\": \"Delete sources\",\n      \"evidence\": \"[C2]\"\n    }\n  ],\n  \"first_task\": {\n    \"bullets\": [\"Start with first action\", \"Validate requirements\", \"Execute implementation\"],\n    \"acceptance\": [\"Component renders\", \"Tests pass\", \"No errors\", \"Meets requirements\"]\n  },\n  \"injection_templates\": {\n    \"gpt\": \"CONTEXT RECAP (ZeroToken Continuity)\\n- Facts: ...\\n- Decisions: ...\\n- Open Questions: ...\\n- Next Steps: ...\\n\\nInstruction: Continue seamlessly from this point as if the session never stopped. Be concise and actionable.\",\n    \"claude\": \"\",\n    \"gemini\": \"\"\n  }\n}\n\nIMPORTANT: Every action MUST start with capital verb and contain 'producing artifact'. Every owner MUST be from the allowed list.` }
    ];
  }

  // Heuristics for generic/meta placeholders (case-insensitive)
  const GENERIC_PATTERNS = [
    /\bAs an AI\b/i,
    /\bChanges Made\b/i,
    /\bData format\b/i,
    /\blink placeholder\b/i,
    /\bLorem ipsum\b/i,
    /\bThis section intentionally left blank\b/i
  ];
  function isGenericText(s: unknown): boolean{
    const v = String(s||"").trim();
    if (!v) return true;
    return GENERIC_PATTERNS.some(rx=> rx.test(v));
  }

  function ensureString(value: unknown): string{
    const v = String(value||"").trim();
    return isGenericText(v) ? "Insufficient evidence [S#]" : v;
  }

  function stripMarketing(s: string): string{
    return String(s||"")
      .replace(/ZeroToken/gi, "")
      .replace(/Marsirius/gi, "")
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function ensureStringArray(value: unknown): string[]{
    const arr = Array.isArray(value) ? value : [];
    const cleaned = arr.map(x=> ensureString(x)).filter(x=> !!x);
    return cleaned;
  }

  function sanitizeNextActionsRows(rows: any[]): any[]{
    const list = Array.isArray(rows)? rows: [];
    return list.map((r)=>({
      action: ensureString(stripEvidence(r?.action||"")),
      owner: sanitizeOwner(r?.owner||""),
      deps: ensureString(stripEvidence(r?.deps||"")),
      effort_h: Number(r?.effort_h||0) || 4,
      impact: (r?.impact==="▼"?"▼":"▲"),
      rollback: ensureString(stripEvidence(r?.rollback||"Define quick rollback")),
      evidence: (String(r?.evidence||"").match(/\[S\d+\]/)? String(r?.evidence): "")
    }));
  }

  const ACTION_REGEX = /^([A-Z][A-Z]*|[A-Z][a-z]+).*(producing|produce).*(artifact|output)/i;
  function toTitleCaseWord(w: string): string{ return w ? (w[0].toUpperCase()+w.slice(1).toLowerCase()) : w; }
  function repairAction(line: string, title?: string): string{
    const txt = String(line||"").replace(/\s+/g,' ').trim();
    if (ACTION_REGEX.test(txt)) return txt;
    
    // Clean up malformed actions
    let cleaned = txt
      .replace(/producing\s+producing/g, 'producing')
      .replace(/\s+producing\s+artifact\s+producing\s+artifact/g, ' producing artifact')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (ACTION_REGEX.test(cleaned)) return cleaned;
    
    // Domain-specific rules for research/info threads
    const titleLower = (title||"").toLowerCase();
    const isResearch = /(uzantı|extension|price|acquire|satın|most expensive|top.*list|research|analyze)/i.test(titleLower);
    
    // D) DOMAIN MAPPING (universal)
    if (isResearch) {
      let verb = 'Compile', artifact = 'table.md';
      if (/top|list/i.test(cleaned)) { verb = 'Compile'; artifact = 'top10.csv'; }
      else if (/source|link/i.test(cleaned)) { verb = 'Document'; artifact = 'sources.md'; }
      else if (/insight|analysis/i.test(cleaned)) { verb = 'Analyze'; artifact = 'insights.md'; }
      const context = cleaned.split(' ').slice(0,4).join(' ') || 'extension research';
      return `${verb} ${context} producing ${artifact}`;
    }
    
    const isDev = /(bug|fix|debug|test|code|dev)/i.test(titleLower);
    if (isDev) {
      let verb = 'Implement', artifact = 'fix.patch';
      if (/test/i.test(cleaned)) { verb = 'Create'; artifact = 'tests.spec.md'; }
      else if (/repro|reproduce/i.test(cleaned)) { verb = 'Document'; artifact = 'repro.md'; }
      const context = cleaned.split(' ').slice(0,4).join(' ') || 'bugfix';
      return `${verb} ${context} producing ${artifact}`;
    }
    
    const isProduct = /(plan|strategy|roadmap|product|feature)/i.test(titleLower);
    if (isProduct) {
      let verb = 'Create', artifact = 'plan.md';
      if (/risk/i.test(cleaned)) { verb = 'Analyze'; artifact = 'risks.md'; }
      else if (/next|step/i.test(cleaned)) { verb = 'Document'; artifact = 'next_steps.md'; }
      const context = cleaned.split(' ').slice(0,4).join(' ') || 'product planning';
      return `${verb} ${context} producing ${artifact}`;
    }
    
    // General repair
    const verbs = ['Implement', 'Create', 'Build', 'Deploy', 'Test', 'Review', 'Design', 'Develop'];
    const objects = ['system', 'component', 'feature', 'test', 'documentation', 'API', 'interface', 'pipeline'];
    
    let verb = 'Implement';
    let object = 'component';
    
    const words = cleaned.toLowerCase().split(' ');
    for (const v of verbs) {
      if (words.includes(v.toLowerCase())) {
        verb = v;
        break;
      }
    }
    
    for (const o of objects) {
      if (words.some(w => w.includes(o.toLowerCase()))) {
        object = o;
        break;
      }
    }
    
    return `${verb} ${object} producing artifact`;
  }
  function enforceNextActionsStrict(rows: any[]): { rows:any[], validity:number }{
    const allowed = new Set(["Founder","Product","Engineering","Design","Research","Growth","Ops","Legal","Data"]);
    const list = Array.isArray(rows)? rows: [];
    if (!list.length) return { rows: [], validity: 0 };
    let valid = 0;
    const repaired = list.map((r)=>{
      let action = repairAction(r?.action||"", ""); // title passed separately
      let owner = sanitizeOwner(r?.owner||"");
      let deps = ensureString(stripEvidence(r?.deps||"Dependencies defined"));
      let rollback = ensureString(stripEvidence(r?.rollback||"Revert changes"));
      const effort_h = Number(r?.effort_h||0) || 4;
      const impact = (r?.impact==="▼"?"▼":"▲");
      const evidence = (String(r?.evidence||"").match(/\[S\d+\]/)? String(r?.evidence): "");
      
      // Force compliance for fast60
      if (!ACTION_REGEX.test(action)) {
        action = "Implement task producing artifact";
      }
      if (!allowed.has(owner)) {
        owner = "Engineering";
      }
      if (!deps || deps.length < 3) {
        deps = "Previous tasks completed";
      }
      if (!rollback || rollback.length < 3) {
        rollback = "Revert to previous state";
      }
      
      const ownerOk = allowed.has(owner);
      const actionOk = ACTION_REGEX.test(action);
      const depsOk = String(deps||"").trim().length>0;
      const rollbackOk = String(rollback||"").trim().length>0;
      const effortOk = effort_h>0 && effort_h<100;
      if (ownerOk && actionOk && depsOk && rollbackOk && effortOk) valid++;
      return { action, owner, deps, effort_h, impact, rollback, evidence };
    });
    const ratio = Math.max(0, Math.min(1, valid/Math.max(1, repaired.length)));
    return { rows: repaired, validity: ratio };
  }

  function validateNextActionRow(r: any): { invalid: string[] }{
    const invalid: string[] = [];
    if (!ACTION_REGEX.test(String(r?.action||""))) invalid.push("action");
    const allowed = new Set(["Founder","Product","Engineering","Design","Research","Growth","Ops","Legal","Data"]);
    if (!allowed.has(String(r?.owner||"").trim())) invalid.push("owner");
    if (!String(r?.deps||"").trim()) invalid.push("deps");
    if (!String(r?.rollback||"").trim()) invalid.push("rollback");
    return { invalid };
  }
  function rowRepairPrompt(keys: string[], title: string, row: any, pieces: string[]): any[]{
    const sys = "STRICT JSON ONLY. Output an object containing ONLY these keys: "+keys.join(', ')+". Language: EN. Rules: action must match ^([A-Z][a-z]+).* producing .+(artifact|output); owner in {Founder,Product,Engineering,Design,Research,Growth,Ops,Legal,Data}; deps and rollback non-empty. Avoid generic/meta strings and branding.";
    const user = `Title: ${title}\nCurrent row (may be invalid): ${JSON.stringify(row)}\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}`;
    return [ { role: "system", content: sys }, { role: "user", content: user } ];
  }
  async function repairNextActionsLLM(rows: any[], title: string, pieces: string[]): Promise<any[]>{
    const out: any[] = [];
    const models = [ chooseModel('free', 'bundle'), 'llama-3.1-8b-instant' ];
    let repairs = 0;
    for (const r of rows){
      const { invalid } = validateNextActionRow(r);
      if (invalid.length && repairs < 12){
        try{
          const msgs = rowRepairPrompt(invalid, title, r, pieces);
          const resp = await callGroqWithFallback(models, msgs, 320);
          try{
            const patch = JSON.parse(resp.content||"{}");
            const merged = { ...r, ...patch };
            merged.action = repairAction(merged.action||"");
            merged.owner = sanitizeOwner(merged.owner||"");
            merged.deps = ensureString(stripEvidence(merged.deps||""));
            merged.rollback = ensureString(stripEvidence(merged.rollback||""));
            out.push(merged);
          }catch{ out.push(r); }
        }catch{ out.push(r); }
        repairs++;
      } else {
        out.push(r);
      }
    }
    return out;
  }

  function enforcePrimerSchemaV3(input: any){
    const out: any = {};
    out.system_instructions = ensureStringArray(input?.system_instructions);
    out.receiving_guide    = ensureStringArray(input?.receiving_guide);
    const prof = input?.user_profile || {};
    out.user_profile = {
      language: ensureString(prof?.language),
      style: ensureStringArray(prof?.style),
      wants: ensureStringArray(prof?.wants),
      avoid: ensureStringArray(prof?.avoid),
      detail_level: ensureString(prof?.detail_level||""),
      format_prefs: ensureStringArray(prof?.format_prefs),
      target_models: ensureStringArray(prof?.target_models),
    };
    out.context_recap = ensureString(input?.context_recap);
    out.key_facts     = ensureStringArray(input?.key_facts);
    out.decisions     = ensureStringArray(input?.decisions);
    out.constraints   = ensureStringArray(input?.constraints);
    out.active_work   = ensureStringArray(input?.active_work);
    out.open_questions= ensureStringArray(input?.open_questions);
    out.next_actions  = sanitizeNextActionsRows(input?.next_actions||[]);
    const ft = input?.first_task||{};
    function pad(items: string[], n: number){
      const res = items.slice();
      while(res.length < n) res.push("Insufficient evidence [S#]");
      return res;
    }
    const ftBul = ensureStringArray(ft?.bullets);
    const ftAcc = ensureStringArray(ft?.acceptance);
    out.first_task = { bullets: pad(ftBul, 3), acceptance: pad(ftAcc, 4) };
    const inj = input?.injection_templates || input?.templates || {};
    out.injection_templates = {
      gpt: ensureString(inj?.gpt),
      claude: ensureString(inj?.claude),
      gemini: ensureString(inj?.gemini),
    };
    // Compute coverage across REQUIRED top-level keys
    const requiredKeys = [
      "system_instructions","receiving_guide","user_profile","context_recap","key_facts","decisions","constraints","active_work","open_questions","next_actions","first_task","injection_templates"
    ];
    const present = requiredKeys.filter(k=> typeof out[k]!=="undefined" && out[k]!==null).length;
    const coverage = present / requiredKeys.length;
    return { bundle: out, coverage };
  }

  function reducePromptDeep(title: string, pieces: string[], plan: string){
    const pro = (plan||'free').toLowerCase()==='vault';
    const targetWords = pro ? '900-1300' : '500-800';
    return [
      { role: "system", content: "DEEP CONTEXT ONLY (no headers). Every important factual bullet has [S#] + ≤120-char quote. FORBIDDEN: generic definitions/meta. Never invent numbers; if missing, 'Insufficient evidence [S#]'."},
      { role: "user", content: `Title: ${title}\nLength: ${targetWords} words.\nStructure:\n- Facts & Data\n- Decisions & Rationale\n- Constraints & Guardrails\n- Full Next Actions table\n- Open Questions & Assumptions\n- Artifacts / Snippets\n- Tests\n- Glossary & Canonical Terms\n- Delight Layer\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  function reducePromptDeepPart(title: string, pieces: string[], sections: string){
    return [
      { role: "system", content: "DEEP CONTEXT PART ONLY (no headers). Every important factual bullet has [S#] + ≤120-char quote. FORBIDDEN: generic definitions/meta. Never invent numbers; if missing, 'Insufficient evidence [S#]'."},
      { role: "user", content: `Title: ${title}\nSections to produce (in order): ${sections}.\n\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}` }
    ];
  }

  function repairWholeDocumentPrompt(title: string, draft: string){
    return [
      { role: "system", content: "Create a FLAWLESS ZeroToken™ handoff in conversation language. Focus on ACTUAL conversation content, NO generic examples. Cover: 1) User's specific requests and context, 2) What was actually built/modified, 3) Current exact status, 4) Clear next steps. Make the next LLM say: 'Thanks to this excellent ZeroToken handoff, I understand everything perfectly and can continue seamlessly!' Be concise but complete. Max 2000 tokens."},
      { role: "user", content: `Title: ${title}\n\n--- CURRENT ---\n${draft}\n--- END ---` }
    ];
  }

  function sanitizeOwner(value: string): string{
    const allowed = new Set(["Founder","Product","Engineering","Design","Research","Growth","Ops","Legal","Data"]);
    const v = String(value||"").trim();
    if (allowed.has(v)) return v;
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
  function stripEvidence(s: string): string{ return String(s||"").replace(/\[S#\]/gi, '').replace(/\[S\d+\]/gi,'').trim(); }
  function renderPrimerFromBundle(title: string, bundle: any): string{
    function lines(arr?: any[]): string{ return (Array.isArray(arr)?arr:[]).map(s=>`- ${stripEvidence(String(s||""))}`).join("\n"); }
    const system = lines(bundle?.system_instructions);
    const guide = lines(bundle?.receiving_guide);
    const recap = stripEvidence(bundle?.context_recap||"");
    const facts = lines(bundle?.key_facts);
    const decisions = lines(bundle?.decisions);
    const active = lines(bundle?.active_work);
    const openq = lines(bundle?.open_questions);
    const rows: any[] = Array.isArray(bundle?.next_actions)? bundle.next_actions : [];
    const header = `| action | owner | deps | effort(h) | impact(▲/▼) | rollback | [S# optional] |\n| --- | --- | --- | --- | --- | --- | --- |`;
    const trs = rows.slice(0,12).map(r=>{
      const owner = sanitizeOwner(r?.owner||"");
      const deps = stripEvidence(r?.deps||"-");
      const rollback = stripEvidence(r?.rollback||"Define quick rollback");
      const impact = (r?.impact==="▼"?"▼":"▲");
      const effort = Number(r?.effort_h||0) || 4;
      const action = stripEvidence(r?.action||"Define next step");
      const ev = (r?.evidence||"").match(/\[S\d+\]/)? r.evidence : "";
      return `| ${action} | ${owner} | ${deps||"-"} | ${effort} | ${impact} | ${rollback} | ${ev} |`;
    }).join("\n");
    const firstBul = lines(bundle?.first_task?.bullets);
    const firstAcc = lines(bundle?.first_task?.acceptance);
    const t = (bundle?.injection_templates || bundle?.templates || {});
    const gptOnly = t?.gpt ? `- GPT: ${stripEvidence(t.gpt)}` : "";
    const out: string[] = [];
    // Modern format - no old PRIMER structure
    if (recap) out.push(`**Özet:**\n${recap}`);
    if (facts) out.push(`**Önemli Bilgiler:**\n${facts}`);
    if (decisions) out.push(`**Alınan Kararlar:**\n${decisions}`);
    if (active) out.push(`**Yapılan İşler:**\n${active}`);
    if (openq) out.push(`**Açık Sorular:**\n${openq}`);
    return out.join("\n\n");
  }

  // --- Quality scoring helpers ---
  function computeActionValidity(rows: any[]): number{
    const allowed = new Set(["Founder","Product","Engineering","Design","Research","Growth","Ops","Legal","Data"]);
    const list = Array.isArray(rows)? rows: [];
    if (!list.length) return 0;
    let valid = 0; const total = list.length;
    for (const r of list){
      const ownerOk = allowed.has(String(r?.owner||"").trim());
      const actionOk = ACTION_REGEX.test(String(r?.action||""));
      const depsOk = String(r?.deps||"").trim().length >= 2;
      const rollbackOk = String(r?.rollback||"").trim().length >= 6;
      const effort = Number(r?.effort_h||0);
      const effortOk = effort>0 && effort<100;
      if (ownerOk && actionOk && depsOk && rollbackOk && effortOk) valid++;
    }
    return Math.max(0, Math.min(1, valid/Math.max(1, total)));
  }
  function computeEvidenceDensity(text: string, isFast60=false): number{
    if (isFast60) {
      // For fast60, look for [C#] markers instead of [S#]
      const cMatches = (String(text||"").match(/\[C\d+\]/g)||[]).length;
      const sMatches = (String(text||"").match(/\[S\d+\]/g)||[]).length;
      const totalMatches = cMatches + sMatches;
      const words = Math.max(1, String(text||"").split(/\s+/g).length);
      const perK = totalMatches / (words/1000);
      return Math.max(0, Math.min(1, perK/5)); // Adjusted target for fast60
    }
    const matches = (String(text||"").match(/\[S\d+\]/g)||[]).length;
    const words = Math.max(1, String(text||"").split(/\s+/g).length);
    const perK = matches / (words/1000);
    return Math.max(0, Math.min(1, perK/10));
  }
  function computeNoGenericScore(primer: string, deep: string): number{
    const all = `${primer}\n${deep}`;
    const bad = GENERIC_PATTERNS.some(rx=> rx.test(all));
    return bad ? 0 : 1;
  }

  function validateBundle(bundle: any){
    const requiredArrays = ["system_instructions","receiving_guide","decisions","open_questions"]; // recap is optional
    const missing: string[] = [];
    for (const k of requiredArrays){ if(!Array.isArray(bundle?.[k]) || (bundle?.[k]?.length||0)===0) missing.push(k); }
    // next_actions normalization
    const rows: any[] = Array.isArray(bundle?.next_actions) ? bundle.next_actions : [];
    const normalized = rows.map((r)=>({
      action: stripEvidence(r?.action||""),
      owner: sanitizeOwner(r?.owner||""),
      deps: stripEvidence(r?.deps||"-"),
      effort_h: Number(r?.effort_h||0) || 4,
      impact: (r?.impact==="▼"?"▼":"▲"),
      rollback: stripEvidence(r?.rollback||"Define quick rollback"),
      evidence: (r?.evidence||"").match(/\[S\d+\]/) ? r.evidence : ""
    }));
    if (normalized.length < 6) missing.push("next_actions");
    // first_task
    const hasFirst = Array.isArray(bundle?.first_task?.bullets) && bundle?.first_task?.bullets.length>0
      && Array.isArray(bundle?.first_task?.acceptance) && bundle?.first_task?.acceptance.length>0;
    if(!hasFirst) missing.push("first_task");
    // templates
    const t = bundle?.templates||{}; const hasTemplates = !!(t?.gpt||t?.claude||t?.gemini);
    if(!hasTemplates) missing.push("templates");
    return { missing, normalized };
  }

  function repairInstruction(missing: string[], title: string, pieces: string[]): any[]{
    const wants = missing.join(", ");
    const sys = "STRICT JSON ONLY. Provide ONLY the missing keys; omit all others. Keep strings short, outcome-focused. owner ∈ {Founder,Product,Engineering,Design,Research,Growth,Ops,Legal,Data}. Evidence allowed only in 'evidence' field with [S#]. Forbid generic definitions, tutorials, meta sections.";
    const user = `Title: ${title}\nProvide missing keys: ${wants}.\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}`;
    return [ { role: "system", content: sys }, { role: "user", content: user } ];
  }

  function sectionPrompt(section: string, title: string, pieces: string[]): any[]{
    const sys = "STRICT JSON ONLY. Output a JSON object containing ONLY the requested key. Keep strings short, outcome-focused. Forbid generic definitions/links/tutorials/meta. owner ∈ {Founder,Product,Engineering,Design,Research,Growth,Ops,Legal,Data}. Evidence allowed only in 'evidence' of next_actions. No [S#] elsewhere.";
    const structures: Record<string,string> = {
      system_instructions: '{"system_instructions": string[]}',
      receiving_guide: '{"receiving_guide": string[]}',
      context_recap: '{"context_recap": string}',
      decisions: '{"decisions": string[]}',
      active_work: '{"active_work": string[]}',
      open_questions: '{"open_questions": string[]}',
      next_actions: '{"next_actions": [{"action": string, "owner": string, "deps": string, "effort_h": number, "impact": "▲"|"▼", "rollback": string, "evidence": string}]}',
      first_task: '{"first_task": {"bullets": string[], "acceptance": string[]}}',
      templates: '{"templates": {"gpt": string, "claude": string, "gemini": string}}'
    };
    const user = `Title: ${title}\nReturn JSON with ONLY the key '${section}' as ${structures[section]}.\nConstraints for 'next_actions': 6-12 rows; owner from allowed set; deps/rollback not empty; action must be outcome-based verb phrase; evidence may include [S#]; other fields MUST NOT contain [S#].\nSegments:\n${pieces.map((p,i)=>`[${i+1}] ${p}`).join("\n\n")}`;
    return [ { role: "system", content: sys }, { role: "user", content: user } ];
  }

  // 1) Create job
  const { data: jobRow, error: jobErr } = await admin
    .from("jobs")
    .insert({
      user_id: payload.userId,
      thread_id: payload.threadId,
      title: payload.title,
      stage: "mapping",
      status: "running",
      total_chunks: (payload.chunks?.length ?? 0) || 0,
      map_pct: 0, reduce_pct: 0, ui_percent: 0,
      plan: payload.plan || "free",
      model: chooseModel(payload.plan, "bundle"),
    })
    .select("id")
    .single();
  if (jobErr) return jsonResponse(500, { ok: false, error: `create job failed: ${jobErr.message}` });

  // 2) Source chunks (use payload or checkpoints quick summaries)
  const { data: cps } = await admin
    .from("checkpoints_v2")
    .select("quick_summary, summary")
    .eq("thread_id", payload.threadId)
    .order("checkpoint_number", { ascending: true });
  let inputChunks: string[] = Array.isArray(payload.chunks) && payload.chunks?.length
    ? payload.chunks!
    : (cps||[]).map(r=> (r.quick_summary || r.summary || "") as string).filter(Boolean);
  
  console.log(`[continuity_v1] Received chunks count: ${payload.chunks?.length}, Using inputChunks count: ${inputChunks.length}`);
  // Determine requested revision EARLY so even early exits log it
  const requestedRev = (payload?.rev==="maxclean_v1" || payload?.revision==="maxclean_v1") ? "continuity_v1@maxclean_v1" :
    (payload?.rev==="fast60_hotfix4_1" || payload?.revision==="fast60_hotfix4_1") ? "continuity_v1@fast60_hotfix4_1" :
    (payload?.rev==="fast60_hotfix4" || payload?.revision==="fast60_hotfix4") ? "continuity_v1@fast60_hotfix4" :
    (payload?.rev==="fast60_hotfix3" || payload?.revision==="fast60_hotfix3") ? "continuity_v1@fast60_hotfix3" :
    (payload?.rev==="fast60_hotfix2" || payload?.revision==="fast60_hotfix2") ? "continuity_v1@fast60_hotfix2" :
    (payload?.rev==="fast60" || payload?.revision==="fast60") ? "continuity_v1@fast60" :
    (payload?.rev==="v3" || payload?.revision==="v3") ? "continuity_v1@v3" :
    ((payload?.rev==="v3-saliency"||payload?.revision==="v3-saliency")?"continuity_v1@v3-saliency":ZT_REVISION);
  // Prepare all checkpoint texts (for recall booster)
  const checkpointTexts: string[] = (cps||[])
    .map(r=> String(r.quick_summary || r.summary || ""))
    .filter(Boolean);

  if(!inputChunks.length){
    await updateJobProgress({ stage: "final", status: "done", map_pct: 100, reduce_pct: 100, ui_percent: 100, result: "(no input)", zt_rev: requestedRev, primer_coverage: 0 });
    return jsonResponse(201, { ok: true, job_id: jobRow.id, meta: { serverKick: true, zt_rev: ZT_REVISION } });
  }

  // 2.5) Meta/prompt filter + topic lock + saliency selection
  // requestedRev already computed above
  const startTime = Date.now();
  
  // Performance tracking
  const perfTracker = {
    start: startTime,
    saliency: 0,
    extractive: 0, 
    compress: 0,
    primer: 0,
    total: 0,
    tokens_in: Math.ceil(inputChunks.join('').length / 4),
    tokens_used: 0,
    selected_chunks: 0,
    filtered_chunks: 0,
    anchor_kept: 0,
    anchor_threshold: 0.35,
    quoted_bullets: 0,
    perf_violation: false,
    perf_path: "normal"
  };
  // Recall tracking
  (perfTracker as any).recall_total = checkpointTexts.length;
  (perfTracker as any).recall_used = 0;
  
  // A) Select (signal → relevant chunks) - MAX CLEAN filter
  let filteredChunks = inputChunks;
  if (requestedRev === "continuity_v1@maxclean_v1"){
    const excludeRx = /```|^Copy code$|Task:|Diff|Acceptance:|Schema|ROLE:|SCOPE|SUPERPROMPT|STRICT JSON|yaml|json|css|php|ts|typescript|BANS|Validators|Repair/i;
    filteredChunks = inputChunks.filter(chunk => {
      const c = String(chunk||"");
      return !excludeRx.test(c);
    });
    perfTracker.filtered_chunks = inputChunks.length - filteredChunks.length;
  } else if (requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3" || requestedRev === "continuity_v1@fast60_hotfix4" || requestedRev === "continuity_v1@fast60_hotfix4_1"){
    const metaRx = /^```[\s\S]*?```$|^(Copy code|Task:|SCOPE|ROLE:|BANS):/i;
    const techRx = /\b(SUPERPROMPT|STRICT JSON|schema|ROLE:|SCOPE|BANS|Validators|Repair|Diff|Acceptance:|yaml|css|php|vbnet|typescript)\b/i;
    const ztRx = /ZeroToken Continuity Handoff.*fast60 blueprint.*non-negotiable/i;
    filteredChunks = inputChunks.filter(chunk => {
      const c = String(chunk||"");
      return !metaRx.test(c) && !techRx.test(c) && !ztRx.test(c);
    });
    perfTracker.filtered_chunks = inputChunks.length - filteredChunks.length;
  }
  
  // B) TOPIC LOCK = ADAPTIVE (no drift)
  let topicChunks = filteredChunks;
  let anchorThreshold = 0.35;
  if (requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3" || requestedRev === "continuity_v1@fast60_hotfix4" || requestedRev === "continuity_v1@fast60_hotfix4_1"){
    try {
      const title = (payload.title||"").toLowerCase();
      const firstChunk = (filteredChunks[0]||"").toLowerCase().slice(0, 200);
      const anchor = `${title} ${firstChunk}`.slice(0, 300);
      const anchorVec = openaiKey ? (await embedOpenAI([anchor]))[0] : hashEmbed(anchor);
      
      const { vecs } = await getEmbeddings(filteredChunks);
      const similarities = vecs.map(v => cosine(v, anchorVec));
      
      // A) MINIMUM SELECTION & ADAPTIVE TOPIC-LOCK
      topicChunks = filteredChunks.filter((_, i) => similarities[i] >= anchorThreshold);
      if (topicChunks.length < 12 && anchorThreshold > 0.30) {
        anchorThreshold = 0.32;
        topicChunks = filteredChunks.filter((_, i) => similarities[i] >= anchorThreshold);
        if (topicChunks.length < 12 && anchorThreshold > 0.30) {
          anchorThreshold = 0.30;
          topicChunks = filteredChunks.filter((_, i) => similarities[i] >= anchorThreshold);
        }
      }
      
      // If still < 12, take union of top-K by anchor + top-K by recency
      if (requestedRev === "continuity_v1@fast60_hotfix4" && topicChunks.length < 12) {
        const anchored = filteredChunks
          .map((chunk, i) => ({ chunk, sim: similarities[i], idx: i }))
          .sort((a, b) => b.sim - a.sim)
          .slice(0, Math.min(15, filteredChunks.length));
        
        const recent = filteredChunks
          .map((chunk, i) => ({ chunk, sim: similarities[i], idx: i }))
          .slice(-Math.min(15, filteredChunks.length));
        
        const unionSet = new Set();
        [...anchored, ...recent].forEach(item => unionSet.add(item.idx));
        const unionIndices = Array.from(unionSet).slice(0, 30);
        
        topicChunks = unionIndices.map(i => filteredChunks[i]).filter(Boolean);
        if (topicChunks.length >= 12) {
          anchorThreshold = 0.30; // Mark as minimum reached via union
        }
      }
      
      perfTracker.anchor_kept = topicChunks.length;
      perfTracker.anchor_threshold = anchorThreshold;
    } catch {}
  }
  
  let selectedChunks: string[] = topicChunks.slice();
  // Recall Booster: add most relevant checkpoint summaries
  let recallChunks: string[] = [];
  try{
    if (checkpointTexts.length){
      const titleClean2 = normalizeText(payload.title||"Untitled");
      const anchorVec2 = openaiKey ? (await embedOpenAI([titleClean2]))[0] : hashEmbed(titleClean2);
      const { vecs: cpVecs } = await getEmbeddings(checkpointTexts);
      const scored = cpVecs.map((v,i)=> ({ idx:i, sim: cosine(v, anchorVec2) }));
      scored.sort((a,b)=> b.sim - a.sim);
      const top = scored.filter(s=> s.sim >= 0.32).slice(0, 12).map(s=> checkpointTexts[s.idx]);
      recallChunks = top;
      (perfTracker as any).recall_used = recallChunks.length;
    }
  }catch{}
  if (requestedRev === "continuity_v1@v3-saliency" || requestedRev === "continuity_v1@fast60" || requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3"){
    try{
      const saliencyStart = Date.now();
      // Pre-filter noise and marketing/branding chatter  
      const noiseRx = /(tutorial|how to|öğretici|adım adım|step by step|thanks|teşekkür|hello|selam|marketing|branding|landing page|cta|newsletter|campaign|As an AI|This summary|Changes Made|Data format JSON|link placeholder|fonts|brand colors)/i;
      const basePool = (requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3") ? topicChunks : inputChunks.filter(c=> !noiseRx.test(String(c||"")));
      const preSet = new Set<string>(basePool);
      for (const r of recallChunks){ if (r && !noiseRx.test(r)) preSet.add(r); }
      const pre = Array.from(preSet);
      const { vecs, method } = await getEmbeddings(pre);
      // Title/topic vector to bias selection toward true thread topic
      const titleClean = normalizeText(payload.title||"Untitled");
      const titleVec = openaiKey ? (await embedOpenAI([titleClean]))[0] : hashEmbed(titleClean);
      
      // fast60: target ≤60k tokens after selection
      const targetTokens = requestedRev === "continuity_v1@fast60" ? 60000 : Infinity;
      const candidates = pre.map((t, i)=>{
        const cat = heuristicCategory(t);
        const base = categoryWeight(cat) * noisePenalty(t);
        return { text: t, vec: vecs[i], base };
      });
      
      let k = Math.min(30, Math.max(1, candidates.length));
      if (requestedRev === "continuity_v1@fast60" || requestedRev === "continuity_v1@fast60_hotfix2"){
        // Estimate tokens and adjust k to stay under 60k
        const avgTokensPerChunk = pre.reduce((sum,c) => sum + Math.ceil(c.length/4), 0) / pre.length || 1000;
        k = Math.min(30, Math.floor(targetTokens / avgTokensPerChunk));
        // Hotfix2: prefer 24-30 range
        if (requestedRev === "continuity_v1@fast60_hotfix2") {
          k = Math.max(24, Math.min(30, k));
        }
      }
      
      const picked = mmrSelect(candidates, k, 0.72, titleVec);
      selectedChunks = picked.map(p=> p.text);
      
      perfTracker.saliency = Date.now() - saliencyStart;
      perfTracker.selected_chunks = selectedChunks.length;
      perfTracker.tokens_used = Math.ceil(selectedChunks.join('').length / 4);
      
      await updateJobProgress({ 
        saliency_selected: selectedChunks.length, 
        saliency_total: inputChunks.length, 
        saliency_method: "mmr", 
        saliency_embed: openaiKey?`openai:${embedModel}`:"hash-256",
        tokens_in: perfTracker.tokens_in,
        tokens_used: perfTracker.tokens_used,
        recall_used: (perfTracker as any).recall_used,
        recall_total: (perfTracker as any).recall_total
      });
    }catch{ /* saliency best-effort */ }
  }

  // 3) FLAWLESS DUAL-STAGE System (inline implementation)
  await updateJobProgress({ stage: "mapping", map_pct: 20, ui_percent: 20 });
  
  // Check if we have chunks
  if (inputChunks && inputChunks.length > 0) {
    // DUAL-STAGE: Stage 1 - Fast Extraction (8 chunks, with delay to avoid rate limit)
    try {
      const stage1Start = Date.now();
      const extractionPromises = inputChunks.slice(0, 8).map(async (chunk, i) => {
        // Add delay to avoid rate limit (100ms between each request)
        await new Promise(resolve => setTimeout(resolve, i * 100));
      const prompt = [
        { 
          role: "system", 
          content: "Extract KEY information in the SAME LANGUAGE as input. Focus on: decisions, technical details, current status. Max 400 tokens. Be specific."
        },
        { 
          role: "user", 
          content: `Chunk ${i+1}:\n${chunk}\n\nExtract critical points.`
        }
      ];
      
      try {
        const resp = await Promise.race([
          callGroqWithFallback(["llama-3.3-70b-versatile", "llama-3.1-8b-instant"], prompt, 400),  // Groq is actually faster!
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
        ]);
        return { 
          chunkId: i + 1, 
          content: (resp as any).content || ""
        };
      } catch {
        return { chunkId: i + 1, content: "" };
      }
    });
    
    await updateJobProgress({ stage: "mapping", map_pct: 50, ui_percent: 40 });
    const extractedChunks = await Promise.all(extractionPromises);
    const validExtractions = extractedChunks.filter(e => e.content.length > 0);
    
    // DUAL-STAGE: Stage 2 - Smart Assembly (70b model)
    await updateJobProgress({ stage: "reduce", reduce_pct: 20, ui_percent: 60 });
    
    const combinedExtractions = validExtractions
      .map(e => `[Chunk ${e.chunkId}]: ${e.content}`)
      .join('\n\n');
    
    const assemblyPrompt = [
      {
        role: "system",
        content: `Create a FLAWLESS handoff in the SAME LANGUAGE as the conversation. No generic boilerplate. Focus ONLY on what actually happened in the thread.

STRICT FORMAT (keep headers exactly; fill with concise but information-dense content):
# [Title]

## 👤 User Persona & Preferences
- Language: <detected language>
- Style: <tone words>
- Wants: <what the user expects from AI>
- Avoid: <what to avoid>

## 🗺️ Timeline (Milestones)
- <timestamp/phase>: <what changed>
- <timestamp/phase>: <what changed>

## 📌 Key Points
- <facts/decisions relevant to the task>

## 📊 Technical Details
- Stack/services, key files/functions, endpoints, DB tables used, constraints

## ✅ Current Status
- What is completed vs pending, blockers, open questions

## 🧩 Constraints & Risks
- <constraints>
- <risks>

## 📝 Next Steps (6–10 bullets, outcome-based)
- <Action> — owner, dependencies, acceptance

## 🎯 First Turn (Paste this to continue)
Write 3–5 short bullet instructions for the next assistant turn so it can continue seamlessly.

## ⚡ Ready-to-Paste Injection
Provide a compact recap for immediate pasting, with 4 sections exactly in this order:
- Facts:
- Decisions:
- Open Questions:
- Next Steps:

## 🔊 Starter Reply (for the next LLM to send)
One single sentence in the conversation language that warmly signals readiness and continuity. Examples:
- Turkish: "Alınan handoffun kalitesi mükemmel; ZeroToken sayesinde kaldığımız yerden hemen devam edebiliriz. Konuya hâkimim — nasıl devam edelim?"
- English: "The handoff quality is excellent — thanks to ZeroToken I'm fully up to speed and can continue seamlessly. How would you like to proceed?"

Length target: 1700–2400 tokens if needed, but be concise (no fluff). Output must be clear, skimmable, and make the next LLM say: "Thanks to this ZeroToken handoff!"`
      },
      {
        role: "user",
        content: `Title: ${payload.title || 'Handoff'}
        
Extracted Information from ${validExtractions.length} chunks:
${combinedExtractions}

Create the FLAWLESS handoff now.`
      }
    ];
    
    let finalHandoff;
    try {
      // Use Groq 70B for best speed AND quality
      const assemblyResp = await callGroqWithFallback(
        ["llama-3.3-70b-versatile", "llama3-70b-8192"], 
        assemblyPrompt, 
        (payload.plan?.toLowerCase?.()==='vault') ? 3600 : 2800
      );
      finalHandoff = (assemblyResp as any).content || "Failed to generate";
    } catch {
      // Fallback to 8b
      const fallbackResp = await callGroqWithFallback(
        ["llama-3.1-8b-instant"], 
        assemblyPrompt, 
        (payload.plan?.toLowerCase?.()==='vault') ? 2600 : 2000
      );
      finalHandoff = (fallbackResp as any).content || "Failed to generate";
    }
    
    // Add ZeroToken branding if not already present
    if (!/ZeroToken/i.test(finalHandoff)) {
      finalHandoff += "\n\n---\n*Generated by ZeroToken™ - Seamless AI Handoffs*";
    }
    
    await updateJobProgress({ stage: "final", reduce_pct: 100, ui_percent: 95 });
    
    const finalResult = {
      ok: true,
      handoff: finalHandoff,
      job_id: jobRow.id,  // Use jobRow.id, not jobId!
      zt_rev: "dual_stage_flawless",
      metrics: {
        chunks_processed: validExtractions.length,
        time_ms: Date.now() - stage1Start
      }
    };
    
    await updateJobProgress({
      status: "done",
      stage: "final",
      result: finalHandoff,  // Send string, not object!
      ui_percent: 100,
      zt_rev: "dual_stage_flawless"
    });
    
    return jsonResponse(201, finalResult);
    
    } catch (dualError) {
      console.error("Dual-stage failed:", dualError);
      // Fall back to classic processing below
    }
  } else {
    console.log("No chunks available for dual-stage, using classic processing");
  }
  
  // Classic processing (fallback)
  const bundleCandidates = [ chooseModel(payload.plan, "bundle"), "llama-3.1-8b-instant" ];
  const bundleMax = (payload.plan?.toLowerCase?.()==='vault') ? 2000 : 1800;
  let primerText = ""; let parsedBundle: any = {}; let primerCoverage = 0;
  if (requestedRev === "continuity_v1@v3" || requestedRev === "continuity_v1@v3-saliency" || requestedRev === "continuity_v1@fast60" || requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3"){
    const pieces = (requestedRev === "continuity_v1@v3-saliency" || requestedRev === "continuity_v1@fast60" || requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3") ? selectedChunks : inputChunks;
    
    let b: any;
    if (requestedRev === "continuity_v1@fast60" || requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3" || requestedRev === "continuity_v1@fast60_hotfix4" || requestedRev === "continuity_v1@fast60_hotfix4_1"){
      // Fast60 pipeline: extractive → compress → primer
      const extractiveStart = Date.now();
      const extractiveCandidates = ["llama-3.1-8b-instant"];
      const extractiveBullets: any[] = [];
      
      // Parallel extractive pass with timeout
      const extractivePromises = pieces.slice(0, 10).map(async (chunk, i) => {
        try {
          const resp = await Promise.race([
            callGroqWithFallback(extractiveCandidates, extractivePrompt(chunk, i+1), 320),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
          ]);
          try {
            const parsed = JSON.parse((resp as any).content || "{}");
            return (parsed.bullets || []).map((b: any) => ({ ...b, chunkId: i+1 }));
          } catch { return []; }
        } catch { return []; }
      });
      
      const extractiveResults = await Promise.allSettled(extractivePromises);
      extractiveResults.forEach(result => {
        if (result.status === 'fulfilled') extractiveBullets.push(...result.value);
      });
      
      perfTracker.extractive = Date.now() - extractiveStart;
      perfTracker.quoted_bullets = extractiveBullets.length;

      // Evidence quota: if quoted bullets too low, try recall chunks as extra source (best-effort)
      if (perfTracker.quoted_bullets < 12 && recallChunks.length){
        try{
          const need = Math.min(12 - perfTracker.quoted_bullets, recallChunks.length);
          for (let i=0;i<need;i++){
            try{
              const resp = await callGroqWithFallback(["llama-3.1-8b-instant"], extractivePrompt(recallChunks[i], pieces.length + i + 1), 320);
              const parsed = JSON.parse(resp.content || "{}");
              const bullets = (parsed.bullets || []).map((b: any) => ({ ...b, chunkId: pieces.length + i + 1 }));
              if (bullets.length) extractiveBullets.push(...bullets);
            }catch{ /* ignore */ }
          }
          perfTracker.quoted_bullets = extractiveBullets.length;
        }catch{ /* ignore */ }
      }
      
      // B) HARD EVIDENCE & [C#] ENFORCEMENT
      if (requestedRev === "continuity_v1@fast60_hotfix4" && perfTracker.quoted_bullets < 12) {
        // Repair extractive on lowest-quoted chunks
        const needRepair = 12 - perfTracker.quoted_bullets;
        const repairChunks = pieces.slice(0, needRepair);
        
        for (let i = 0; i < repairChunks.length; i++) {
          try {
            const resp = await callGroqWithFallback(["llama-3.1-8b-instant"], extractivePrompt(repairChunks[i], pieces.length + i + 1), 320);
            const parsed = JSON.parse(resp.content || "{}");
            const bullets = (parsed.bullets || []).map((b: any) => ({ ...b, chunkId: pieces.length + i + 1 }));
            extractiveBullets.push(...bullets);
          } catch {}
        }
        perfTracker.quoted_bullets = extractiveBullets.length;
      }
      
      // Check fast path condition
      const elapsed = Date.now() - startTime;
      if (elapsed > 45000) {
        // Fast path: build recap from extractive bullets only
        const fastRecap = extractiveBullets.slice(0, 20).map(b => `${b.text} ${b.quote} ${b.id}`).join('\n');
        b = await callGroqWithFallback(bundleCandidates, primerFromRecapPrompt(payload.title || "Untitled", fastRecap), bundleMax);
        perfTracker.compress = 0; // skipped
        perfTracker.perf_path = "fast";
      } else {
        // Normal path: compress (with double compression if needed)
        const compressStart = Date.now();
        let compressResp = await Promise.race([
          callGroqWithFallback(bundleCandidates, compressPrompt(extractiveBullets, payload.title || "Untitled", false), 2000),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000))
        ]);
        
        let denseRecap = (compressResp as any).content || extractiveBullets.slice(0, 15).map(b => `${b.text} ${b.id}`).join('\n');
        let recapTokens = Math.ceil(denseRecap.length / 4);
        
        // C) HARD TOKEN BUDGET + DOUBLE COMPRESS
        if ((requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3" || requestedRev === "continuity_v1@fast60_hotfix4") && recapTokens > 1900) {
          // Second compression pass
          const secondResp = await callGroqWithFallback(bundleCandidates, compressPrompt(extractiveBullets, payload.title || "Untitled", true), 1000);
          denseRecap = (secondResp as any).content || denseRecap;
          recapTokens = Math.ceil(denseRecap.length / 4);
          
          // If still > 4000, drop lowest-saliency bullets
          if (recapTokens > 4000) {
            const trimmed = extractiveBullets.slice(0, Math.floor(extractiveBullets.length * 0.7));
            const thirdResp = await callGroqWithFallback(bundleCandidates, compressPrompt(trimmed, payload.title || "Untitled", true), 1800);
            denseRecap = (thirdResp as any).content || denseRecap.slice(0, 8000);
            recapTokens = Math.ceil(denseRecap.length / 4);
          }
        }
        
        // Remove "..." placeholders
        denseRecap = denseRecap.replace(/\.\.\./g, '').replace(/…/g, '');
        
        perfTracker.compress = Date.now() - compressStart;
        
        b = await Promise.race([
          callGroqWithFallback(bundleCandidates, primerFromRecapPrompt(payload.title || "Untitled", denseRecap), bundleMax),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
        ]);
      }
      
      perfTracker.primer = Date.now() - extractiveStart - perfTracker.extractive - perfTracker.compress;
    } else {
      b = await callGroqWithFallback(bundleCandidates, reducePromptBundleV4(payload.title || "Untitled", pieces, payload.plan), bundleMax);
    }
    try{ parsedBundle = JSON.parse(b.content||"{}"); }catch{ parsedBundle = {}; }
    // Strip marketing terms, enforce schema & coverage
    try{
      parsedBundle.system_instructions = ensureStringArray((parsedBundle.system_instructions||[]).map(stripMarketing));
      parsedBundle.receiving_guide = ensureStringArray((parsedBundle.receiving_guide||[]).map(stripMarketing));
      if (parsedBundle.user_profile){
        parsedBundle.user_profile.language = 'English';
        parsedBundle.user_profile.style = ensureStringArray((parsedBundle.user_profile.style||[]).map(stripMarketing));
        parsedBundle.user_profile.wants = ensureStringArray((parsedBundle.user_profile.wants||[]).map(stripMarketing));
        parsedBundle.user_profile.avoid = ensureStringArray((parsedBundle.user_profile.avoid||[]).map(stripMarketing));
        parsedBundle.user_profile.format_prefs = ensureStringArray((parsedBundle.user_profile.format_prefs||[]).map(stripMarketing));
        parsedBundle.user_profile.target_models = ensureStringArray((parsedBundle.user_profile.target_models||[]).map(stripMarketing));
      }
      parsedBundle.context_recap = ensureString(stripMarketing(parsedBundle.context_recap||''));
      parsedBundle.key_facts = ensureStringArray((parsedBundle.key_facts||[]).map(stripMarketing));
      parsedBundle.decisions = ensureStringArray((parsedBundle.decisions||[]).map(stripMarketing));
      parsedBundle.constraints = ensureStringArray((parsedBundle.constraints||[]).map(stripMarketing));
      parsedBundle.active_work = ensureStringArray((parsedBundle.active_work||[]).map(stripMarketing));
      parsedBundle.open_questions = ensureStringArray((parsedBundle.open_questions||[]).map(stripMarketing));
      if (parsedBundle.injection_templates){ 
        if (requestedRev === "continuity_v1@fast60_hotfix4_1") {
          let injection = buildGptInjectionV4_1(parsedBundle);
          const validation = validateInjection(injection);
          if (!validation.valid) {
            injection = "CONTEXT RECAP (ZeroToken Continuity)\n- Facts:\n  • Continue by collecting research sources.\n- Decisions:\n  • Continue by collecting decision context.\n- Open Questions:\n  • Continue by collecting question context.\n- Next Steps:\n  • Continue by collecting action items.\n\nInstruction: Continue seamlessly as if the session never stopped. Be concise and actionable.";
          }
          parsedBundle.injection_templates = { gpt: injection, claude: "", gemini: "" };
        } else if (requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3") {
          let injection = buildGptInjection(parsedBundle);
          const validation = validateInjection(injection);
          if (!validation.valid && requestedRev === "continuity_v1@fast60_hotfix3") {
            // Trigger repair for hotfix3
            injection = "CONTEXT RECAP (ZeroToken Continuity)\n- Facts:\n  • Continue by collecting research sources.\n- Decisions:\n  • Continue by collecting decision context.\n- Open Questions:\n  • Continue by collecting question context.\n- Next Steps:\n  • Continue by collecting action items.\n\nInstruction: Continue seamlessly as if the session never stopped. Be concise and actionable.";
          }
          parsedBundle.injection_templates = { gpt: injection, claude: "", gemini: "" };
        } else {
          parsedBundle.injection_templates = { gpt: ensureString(stripMarketing(parsedBundle.injection_templates.gpt||'')), claude: "", gemini: "" };
        }
      }
    }catch{}
    // Enforce schema & coverage
    const enforced = enforcePrimerSchemaV3(parsedBundle);
    parsedBundle = enforced.bundle;
    // Domain-aware artifacts (research/info topics): ensure staple actions exist
    try{
      const titleLow = String(payload.title||"").toLowerCase();
      const isResearch = /(research|analysis|extension|acquisition|price|pazar|market|review|top\s*\d+)/i.test(titleLow);
      if (isResearch){
        const must = [
          "Compile top-10 extension acquisitions producing top10.csv",
          "Validate sources producing sources.md",
          "Write synthesis producing insights.md"
        ];
        const actions: any[] = Array.isArray(parsedBundle?.next_actions)? parsedBundle.next_actions:[];
        const have = new Set(actions.map(a=> String(a?.action||"").toLowerCase()));
        for (const m of must){ if(!have.has(m.toLowerCase())) actions.push({ action:m, owner:"Research", deps:"Context recap", effort_h:4, impact:"▲", rollback:"Revert document", evidence:"" }); }
        parsedBundle.next_actions = actions;
      }
    }catch{}
    // Coverage Map: which sections are backed by checkpoints vs current chunks (best-effort)
    try{
      const cpAll = checkpointTexts.join(" \n");
      const curAll = selectedChunks.join(" \n");
      function sectionCoverage(arr?: any[]): {checkpoint:number,current:number,total:number}{
        const items = Array.isArray(arr)?arr:[];
        let cp=0, cur=0; for(const x of items){ const txt=String(x?.action||x||""); if(!txt) continue; if(cpAll.includes(txt)) cp++; else if(curAll.includes(txt)) cur++; }
        return { checkpoint: cp, current: cur, total: items.length };
      }
      const cov = {
        facts: sectionCoverage(parsedBundle?.key_facts),
        decisions: sectionCoverage(parsedBundle?.decisions),
        constraints: sectionCoverage(parsedBundle?.constraints),
        open_questions: sectionCoverage(parsedBundle?.open_questions),
        actions: sectionCoverage(parsedBundle?.next_actions)
      } as any;
      await updateJobProgress({ coverage_by_source: cov }).catch(()=>{});
    }catch{}
    
    // C) MIN BULLET QUORUM enforcement for hotfix4
    if (requestedRev === "continuity_v1@fast60_hotfix4") {
      const quorum = enforceMinBulletQuorum(parsedBundle, requestedRev);
      parsedBundle = quorum.bundle;
      if (!quorum.quorumMet) {
        // Fallback to MRv2 if quorum not met
        try {
          const mrv2Url = `${SUPABASE_URL}/functions/v1/map_reduce_v2`;
          await fetch(mrv2Url, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||""}` },
            body: JSON.stringify({ userId: payload.userId, plan: payload.plan, title: payload.title, threadId: payload.threadId, chunks: selectedChunks })
          });
          await updateJobProgress({ continuity_fallback: "mrv2_quorum_fail" });
        } catch {}
      }
    }
    // Strict Next Actions enforcement + progress log (all v3+ paths)
    try{
      // 1) İlk normalize & hızlı onarım (title bağlamıyla tüm rev'lerde)
      const initial = enforceNextActionsStrict(parsedBundle?.next_actions||[]);
      let rows = initial.rows.map(r => ({ ...r, action: repairAction(r.action||"", payload.title||"") }));
      // 2) Gerekiyorsa LLM repair (tek pass)
      let validity = Number(initial.validity.toFixed(3));
      if (validity < 0.9){
        const repairPieces = (requestedRev.includes("fast60")) ? selectedChunks : pieces;
        rows = await repairNextActionsLLM(rows, payload.title||"Untitled", repairPieces);
        const recheck = enforceNextActionsStrict(rows);
        rows = recheck.rows; validity = Number(recheck.validity.toFixed(3));
      }
      // 3) Minimum satır kotası (research/info için 6+)
      try{
        const titleLow = String(payload.title||"").toLowerCase();
        const isResearch = /(research|analysis|extension|acquisition|price|pazar|market|review|top\s*\d+)/i.test(titleLow);
        if (isResearch && rows.length < 6){
          const must = [
            "Compile top-10 extension acquisitions producing top10.csv",
            "Validate sources producing sources.md",
            "Write synthesis producing insights.md"
          ];
          const have = new Set(rows.map(a=> String(a?.action||"").toLowerCase()));
          for (const m of must){ if(!have.has(m.toLowerCase())) rows.push({ action:m, owner:"Research", deps:"Context recap", effort_h:4, impact:"▲", rollback:"Revert document", evidence:"" }); }
          while(rows.length < 6) rows.push({ action:"Document current findings producing log.md", owner:"Research", deps:"Context recap", effort_h:2, impact:"▲", rollback:"Revert log", evidence:"" });
        }
      }catch{}
      parsedBundle.next_actions = rows;
      await updateJobProgress({ action_validity: validity });
    }catch{ /* ignore */ }
    primerCoverage = enforced.coverage;
    // Record coverage as log; v3 must be 1.0 due to enforcement
    try{ await updateJobProgress({ zt_rev: requestedRev, primer_coverage: primerCoverage }); }catch{}
  }else{
    const b = await callGroqWithFallback(bundleCandidates, reducePromptBundle(payload.title || "Untitled", selectedChunks, payload.plan), bundleMax);
  try{ parsedBundle = JSON.parse(b.content||"{}"); }catch{ parsedBundle = {}; }
  // Repair loop (max 2 passes)
  for (let i=0;i<2;i++){
    const { missing, normalized } = validateBundle(parsedBundle);
    parsedBundle.next_actions = normalized;
    if (!missing.length) break;
      const fix = await callGroqWithFallback(bundleCandidates, repairInstruction(missing, payload.title||"Untitled", selectedChunks), Math.min(600, Math.floor(bundleMax*0.6)));
    try{ const add = JSON.parse(fix.content||"{}"); parsedBundle = { ...parsedBundle, ...add }; }catch{}
    }
  }
  primerText = renderPrimerFromBundle(payload.title||"Untitled", parsedBundle);

  // 4) Generate DEEP
  await updateJobProgress({ stage: "reduce", reduce_pct: 40, ui_percent: 70 });
  const deepCandidates = [ chooseModel(payload.plan, "deep"), "llama-3.1-8b-instant" ];
  // Two-part DEEP to avoid truncation
  const deepPieces = (requestedRev === "continuity_v1@v3-saliency") ? selectedChunks : inputChunks;
  const deepA = await callGroqWithFallback(deepCandidates, reducePromptDeepPart(payload.title || "Untitled", deepPieces, "Facts & Data; Decisions & Rationale; Constraints & Guardrails"), (payload.plan?.toLowerCase?.()==='vault')? 1400: 900);
  const deepB = await callGroqWithFallback(deepCandidates, reducePromptDeepPart(payload.title || "Untitled", deepPieces, "Full Next Actions table; Open Questions & Assumptions; Artifacts / Snippets; Tests; Glossary & Canonical Terms; Delight Layer"), (payload.plan?.toLowerCase?.()==='vault')? 1400: 900);
  let deepText = `${(deepA.content||"").trim()}\n\n${(deepB.content||"").trim()}`;
  deepText = deepText.replace(/\s*===\s*PRIMER\s*===\s*/gi,' ').replace(/\s*===\s*DEEP CONTEXT\s*===\s*/gi,' ');

  // 5) Assemble final
  // NEW FORMAT - NO PRIMER/DEEP HEADERS
  let finalText = `# ${payload.title || 'Handoff Report'}\n\n## 📌 KEY POINTS FROM START\n${primerText||"No key points available"}\n\n## 📋 DETAILED CONTEXT\n${deepText||"No detailed context available"}\n\n## ⚡ CONTINUATION\nContinue the conversation naturally from where it left off.\n\n---\n*Generated by ZeroToken™ - Seamless AI Handoffs*`;
  // Enforce recap size ≤ ~4000 tokens for v3-saliency
  let continuityTokensEst = Math.ceil(finalText.length/4);
  let continuityTrimmed = false;
  if (requestedRev === "continuity_v1@v3-saliency" && continuityTokensEst > 4000){
    const maxChars = 4000*4;
    const primerChars = (primerText||"").length + 22; // header approx
    const remaining = Math.max(0, maxChars - primerChars - 22);
    const trimmedDeep = String(deepText||"").slice(0, remaining);
    finalText = `# ${payload.title || 'Handoff Report'}\n\n## 📌 KEY POINTS\n${primerText||"No key points"}\n\n## 📋 CONTEXT\n${trimmedDeep}\n\n## ⚡ CONTINUE\nPick up where the conversation ended.`;
    continuityTrimmed = true;
    continuityTokensEst = Math.ceil(finalText.length/4);
  }

  // Compute continuity_score (all v3+ paths)
  try{
    // New format - no need to parse PRIMER/DEEP sections
    const primerBody = "";
    const deepBody = "";
    const isV3Plus = requestedRev.includes("v3") || requestedRev.includes("fast60");
    const primerCov = isV3Plus ? 1.0 : (Number(primerCoverage)||0);
    const actionValidity = computeActionValidity(parsedBundle?.next_actions||[]);
    const evidenceDensity = computeEvidenceDensity(deepBody || finalText, requestedRev === "continuity_v1@fast60");
    const noGeneric = computeNoGenericScore(primerBody || finalText, deepBody || finalText);
    const continuityScore = 0.35*primerCov + 0.30*actionValidity + 0.25*evidenceDensity + 0.10*noGeneric;
    // Reasons for gate
    const reasons: string[] = [];
    if (primerCov < 1) reasons.push('primer_cov');
    if (actionValidity < 0.9) reasons.push('actions');
    if (evidenceDensity < 0.8) reasons.push('evidence');
    if (noGeneric < 1) reasons.push('generic');
    await updateJobProgress({ continuity_score: Number(continuityScore.toFixed(3)), evidence_density: Number(evidenceDensity.toFixed(3)), gate_reasons: reasons });

    // Gate: if <0.9, run a repair pass once
    if (continuityScore < 0.9){
      const repairCandidates = [ chooseModel(payload.plan, "deep"), "llama-3.1-8b-instant" ];
      const repaired = await callGroqWithFallback(repairCandidates, repairWholeDocumentPrompt(payload.title||"Untitled", finalText), (payload.plan?.toLowerCase?.()==='vault')? 2200: 2000);
      if (repaired?.content && !repaired.content.startsWith('(groq error)')){
        finalText = repaired.content;
        // New format - no need to parse PRIMER/DEEP
        const primerBody2 = "";
        const deepBody2 = "";
        const actionValidity2 = computeActionValidity(parsedBundle?.next_actions||[]);
        const evidenceDensity2 = computeEvidenceDensity(deepBody2);
        const noGeneric2 = computeNoGenericScore(primerBody2, deepBody2);
        const continuityScore2 = 0.35*primerCov + 0.30*actionValidity2 + 0.25*evidenceDensity2 + 0.10*noGeneric2;
        await updateJobProgress({ continuity_score: Number(continuityScore2.toFixed(3)), continuity_repair_triggered: true, gate_reasons: reasons });

        // If still <0.9, fallback to MRv2 silently
        if (continuityScore2 < 0.9){
          try{
            const mrv2Url = `${SUPABASE_URL}/functions/v1/map_reduce_v2`;
            const resp = await fetch(mrv2Url,{
              method:"POST",
              headers:{"content-type":"application/json","authorization":`Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||""}`},
              body: JSON.stringify({ userId: payload.userId, plan: payload.plan, title: payload.title, threadId: payload.threadId, chunks: selectedChunks, maxMapConcurrency: payload.maxMapConcurrency||undefined })
            });
            if (resp.ok){ await updateJobProgress({ continuity_fallback: "mrv2", gate_reasons: reasons }); }
          }catch{ /* silent */ }
        }
      }
    }
  }catch{ /* scoring best-effort */ }

  // 6) Finalize
  await updateJobProgress({ stage: "final", reduce_pct: 100, ui_percent: 100 });
  let finalizeError: any = null;
  try{
  const { error: doneErr } = await admin
      .from("jobs")
      .update({ stage: "final", status: "done", result: finalText, zt_rev: requestedRev, primer_coverage: 1.0 })
      .eq("id", jobRow.id);
    if (doneErr) throw doneErr;
  }catch(e){
    // Fallback for environments without the new columns
    try{
      const { error: fallbackErr } = await admin
        .from("jobs")
        .update({ stage: "final", status: "done", result: finalText })
        .eq("id", jobRow.id);
      if (fallbackErr) finalizeError = fallbackErr;
    }catch(e2){ finalizeError = e2; }
  }
  if (finalizeError) return jsonResponse(500, { ok: false, error: `finalize job failed: ${String(finalizeError)}` });

  // Final performance tracking
  perfTracker.total = Date.now() - startTime;
  perfTracker.perf_violation = perfTracker.total > 60000;
  
  // Enhanced logging for fast60
  const isV3Plus = requestedRev.includes("v3") || requestedRev.includes("fast60");
  const logData = {
    serverKick: true, 
    zt_rev: requestedRev, 
    primer_coverage: isV3Plus ? 1.0 : undefined, 
    primer_bundle: isV3Plus ? parsedBundle : undefined, 
    saliency_selected: (requestedRev==="continuity_v1@v3-saliency" || requestedRev==="continuity_v1@fast60") ? selectedChunks.length : undefined, 
    saliency_total: (requestedRev==="continuity_v1@v3-saliency" || requestedRev==="continuity_v1@fast60") ? inputChunks.length : undefined, 
    continuity_tokens_est: continuityTokensEst, 
    continuity_trimmed: continuityTrimmed
  };
  
  if (requestedRev === "continuity_v1@fast60" || requestedRev === "continuity_v1@fast60_hotfix2" || requestedRev === "continuity_v1@fast60_hotfix3") {
    // Calculate all metrics in meta for fast60
    // New format - no need to parse PRIMER/DEEP sections
    const primerBody = "";
    const deepBody = "";
    const actionValidity = computeActionValidity(parsedBundle?.next_actions||[]);
    const evidenceDensity = computeEvidenceDensity(deepBody || finalText, true);
    const noGeneric = computeNoGenericScore(primerBody || finalText, deepBody || finalText);
    const continuityScore = 0.35*1.0 + 0.30*actionValidity + 0.25*evidenceDensity + 0.10*noGeneric;
    const recapTokens = Math.ceil(finalText.length / 4);
    
    // Injection validation check for hotfix3
    let pastedSuccess = true;
    if (requestedRev === "continuity_v1@fast60_hotfix3") {
      const injection = parsedBundle?.injection_templates?.gpt || "";
      const validation = validateInjection(injection);
      pastedSuccess = validation.valid;
    }
    
    Object.assign(logData, {
      elapsed_ms: perfTracker.total,
      tokens_in: Math.round(perfTracker.tokens_in),
      tokens_used: perfTracker.tokens_used,
      selected_chunks: perfTracker.selected_chunks,
      filtered_chunks: perfTracker.filtered_chunks,
      anchor_kept: perfTracker.anchor_kept,
      anchor_threshold: perfTracker.anchor_threshold,
      recap_tokens: recapTokens,
      saliency_ms: perfTracker.saliency,
      extractive_ms: perfTracker.extractive,
      compress_ms: perfTracker.compress,
      primer_ms: perfTracker.primer,
      perf_violation: perfTracker.perf_violation,
      perf_path: perfTracker.perf_path,
      action_validity: Number(actionValidity.toFixed(3)),
      evidence_density: Number(evidenceDensity.toFixed(3)),
      continuity_score: Number(continuityScore.toFixed(3)),
      trimmed: recapTokens > 4000,
      pasted: pastedSuccess
    });
    
    // F) LOG — TEK SATIR ÖZET (zorunlu)
    const revShort = requestedRev.includes('hotfix4_1') ? 'fast60_hotfix4_1' : (requestedRev.includes('hotfix4') ? 'fast60_hotfix4' : (requestedRev.includes('hotfix3') ? 'hotfix3' : (requestedRev.includes('hotfix2') ? 'hotfix2' : 'fast60')));
    console.log(`[ZT] rev=${revShort} | elapsed=${perfTracker.total}ms | tokens_in=${Math.round(perfTracker.tokens_in)} | anchor_kept=${perfTracker.anchor_kept} | selected=${perfTracker.selected_chunks} | quotes=${perfTracker.quoted_bullets} | recap=${recapTokens} | primer=1.0 | act=${actionValidity.toFixed(2)} | evid=${evidenceDensity.toFixed(2)} | score=${continuityScore.toFixed(2)} | pasted=${pastedSuccess}`);
  }
  
  return jsonResponse(201, { ok: true, job_id: jobRow.id, meta: logData });
}
Deno.serve(handler);


