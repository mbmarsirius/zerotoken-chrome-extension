import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    // Include Supabase SDK headers to avoid CORS preflight 403
    "access-control-allow-headers": "authorization,apikey,content-type,x-client-info,x-supabase-authorization",
    "cache-control": "no-store",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    const url = new URL(req.url);
    const jobId = url.searchParams.get("job");
    
    if (!jobId) {
      return new Response(
        JSON.stringify({ ok: false, error: "job parameter required" }),
        { status: 400, headers: { ...corsHeaders(), "content-type": "application/json" } }
      );
    }

    // Prefer service role on server to avoid RLS 404s during polling
    // Note: this code runs on the server (Edge Function); the key is NOT exposed to the client
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY");
    const supabase = createClient(
      SUPABASE_URL,
      serviceKey || (Deno.env.get("SUPABASE_ANON_KEY") ?? "")
    );

    // Query job status
    const { data: job, error } = await supabase
      .from("jobs")
      .select("id, status, stage, ui_percent, result, map_pct, reduce_pct, total_chunks, processed_chunks")
      .eq("id", jobId)
      .single();

    if (error || !job) {
      return new Response(
        JSON.stringify({ ok: false, error: "Job not found" }),
        { status: 404, headers: { ...corsHeaders(), "content-type": "application/json" } }
      );
    }

    // Return status
    const response: Record<string, unknown> = {
      ok: true,
      job_id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.ui_percent || 0,
      percent: job.ui_percent || 0, // backward-compat field expected by some clients
      map_pct: job.map_pct || 0,
      reduce_pct: job.reduce_pct || 0,
      processed_chunks: job.processed_chunks ?? null,
      total_chunks: job.total_chunks ?? null,
      has_result: !!(job as any).result && String((job as any).result||"").length>0
    };

    // Include result when finalized; our pipeline uses status 'done'
    if ((job.status === "done" || job.status === "completed") && (job as any).result) {
      (response as any).result = (job as any).result;
    }

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders(), "content-type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in handoff_status:", error);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { ...corsHeaders(), "content-type": "application/json" } }
    );
  }
});
