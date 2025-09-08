// @ts-nocheck
// Supabase Edge Function: handoff_result — blocking fetch for FINAL full result
// Goal: return the COMPLETE jobs.result for a given job id, waiting until stage='final'

import { createClient } from "jsr:@supabase/supabase-js@2";

function corsHeaders(){
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    // Allow Supabase SDK headers to avoid 403 on preflight
    "access-control-allow-headers": "authorization,apikey,content-type,x-client-info,x-supabase-authorization",
    "cache-control": "no-store",
  } as Record<string,string>;
}
function json(status: number, body: unknown){
  return new Response(JSON.stringify(body), { status, headers: { "content-type":"application/json; charset=utf-8", ...corsHeaders() } });
}

const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";

export default async function handler(req: Request){
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  // Accept both GET ?job= and POST { job }
  let jobId = "";
  if (req.method === "GET"){
    const url = new URL(req.url);
    jobId = url.searchParams.get("job")||"";
  } else if (req.method === "POST"){
    try{ const b = await req.json(); jobId = String(b?.job||""); }catch{}
  } else {
    return json(405, { ok:false, error:"Method Not Allowed" });
  }
  if(!jobId) return json(400, { ok:false, error:"Missing job id" });

  const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("ANON_KEY") || "";
  if (!serviceKey) return json(500, { ok:false, error:"Service key missing" });
  const db = createClient(SUPABASE_URL, serviceKey, { auth:{ persistSession:false } });

  const sleep = (ms:number)=> new Promise(res=> setTimeout(res, ms));
  let lastLen = 0; let stableCount = 0;
  const started = Date.now(); const timeoutMs = 60000; // 60s hard cap

  while(Date.now()-started < timeoutMs){
    try{
      const { data, error } = await db.from("jobs").select("stage,status,result,zt_rev,primer_coverage,continuity_score,action_validity,evidence_density,tokens_in,tokens_used").eq("id", jobId).single();
      if(!error && data){
        const result = String(data.result||"");
        const len = result.length;
        if (len>0 && data.stage==="final"){ // wait for stability across two reads to avoid race
          if (len===lastLen) stableCount++; else stableCount=0;
          lastLen = len;
          if (stableCount>=1){
            return json(200, { ok:true, job_id: jobId, meta: data, result });
          }
        }
      }
    }catch{}
    await sleep(300);
  }
  return json(504, { ok:false, error:"Timeout waiting for final result" });
}

Deno.serve(handler);


