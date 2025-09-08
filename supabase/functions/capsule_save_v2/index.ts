// @ts-nocheck
// Supabase Edge Function: capsule_save_v2
// Purpose: Persist "shadow checkpoint" capsules into checkpoints_v2 and update checkpoint_stats
// Notes:
// - Requires SUPABASE_SERVICE_ROLE_KEY to be set in the Edge Function environment
// - Safe to deploy alongside existing v1 pipeline; this does not change UI behavior

import { createClient } from "jsr:@supabase/supabase-js@2";

type CapsulePayload = {
  userId: string | null;
  threadId: string;
  approxTokens?: number;
  checkpointNumber?: number;
  raw_chunks?: unknown[];
  meta?: Record<string, unknown>;
};
const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";

function corsHeaders(){
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,apikey,content-type",
    "cache-control": "no-store",
  } as Record<string,string>;
}
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

export default async function handler(req: Request) {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "Method Not Allowed" });
    }

    let payload: CapsulePayload;
    try {
      payload = (await req.json()) as CapsulePayload;
    } catch {
      return jsonResponse(400, { ok: false, error: "Invalid JSON" });
    }

    const serviceKey = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceKey) {
      return jsonResponse(202, { ok: false, serverKick: false, reason: "SERVICE_ROLE_KEY missing" });
    }

    const admin = createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false } });

    const userId = payload.userId ?? null;
    const threadId = payload.threadId || "unknown";
    const approxTokens = Number(payload.approxTokens ?? 0) || 0;
    let checkpointNumber = Number(payload.checkpointNumber ?? 0) || 0;
    const raw_chunks = Array.isArray(payload.raw_chunks) ? payload.raw_chunks : [];
    const flat = raw_chunks.map(v => typeof v === "string" ? v : JSON.stringify(v)).join(" \n");
    const quickSummary = (flat || "").slice(0, 700) || "";

    // Derive optional meta
    const meta = (payload.meta || {}) as Record<string, unknown>;
    const fromIdx = (meta["fromIdx"] as number) ?? null;
    const toIdx = (meta["toIdx"] as number) ?? null;
    const title = (meta["title"] as string) ?? null;
    const model = (meta["model"] as string) ?? null;
    const createdByVersion = (meta["createdByVersion"] as string) ?? "capsule_save_v2@v1";

    async function sha256Hex(input: string): Promise<string> {
      try {
        const bytes = new TextEncoder().encode(input || "");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
      } catch {
        return ""; // hashing is best-effort; empty string if crypto unavailable
      }
    }

    // 1) Insert capsule — avoid FK issues by omitting user_id if it violates constraints
    // If checkpointNumber not provided or collides, compute next available
    if (!checkpointNumber) {
      const { data: last, error: lastErr } = await admin
        .from("checkpoints_v2")
        .select("checkpoint_number")
        .eq("thread_id", threadId)
        .order("checkpoint_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!lastErr) checkpointNumber = Number(last?.checkpoint_number || 0) + 1;
    }

    const totalMessages = raw_chunks.length;
    const charCount = flat.length;
    const hash = await sha256Hex(flat);

    const row: Record<string, unknown> = {
      thread_id: threadId,
      checkpoint_number: checkpointNumber,
      summary: quickSummary,
      quick_summary: quickSummary,
      from_msg_idx: fromIdx,
      to_msg_idx: toIdx,
      content_hash: hash || null,
      messages_count: totalMessages || null,
      char_count: charCount || null,
      token_estimate: approxTokens || null,
      title,
      model,
      created_by_version: createdByVersion,
    };
    if (userId) (row as any).user_id = userId;

    const { error: upErr } = await admin
      .from("checkpoints_v2")
      .upsert(row, { onConflict: "thread_id,checkpoint_number" });
    if (upErr) return jsonResponse(500, { ok: false, error: `insert checkpoints_v2 failed: ${upErr.message}` });

    // 2) Stats update (skip writes if it's a VIEW) — non-critical for MVP
    // If needed later, replace with a SECURITY DEFINER function that writes into a base table.

    return jsonResponse(200, { ok: true, threadId, stored: true, meta: { approxTokens, totalMessages } });
  } catch (e) {
    return jsonResponse(500, { ok: false, error: (e as Error)?.message || String(e) });
  }
}
// Deno entrypoint
Deno.serve(handler);


