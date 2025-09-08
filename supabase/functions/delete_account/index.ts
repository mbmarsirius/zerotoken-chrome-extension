// @ts-nocheck
import { createClient } from "jsr:@supabase/supabase-js@2";

function cors(){ return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type", "cache-control":"no-store" }; }

const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";

export default async function handler(req: Request){
  if (req.method === 'OPTIONS') return new Response(null,{ status:204, headers:cors() });
  if (req.method !== 'POST') return new Response(JSON.stringify({ok:false,error:'method'}),{ status:405, headers:{...cors(),"content-type":"application/json"} });
  try{
    const auth = req.headers.get('authorization')||'';
    const token = auth.replace(/^Bearer\s+/i,'');
    if(!token) return new Response(JSON.stringify({ok:false,error:'unauthorized'}),{ status:401, headers:{...cors(),"content-type":"application/json"} });
    const userClient = createClient(SUPABASE_URL, token);
    const { data: { user } } = await userClient.auth.getUser();
    if(!user) return new Response(JSON.stringify({ok:false,error:'unauthorized'}),{ status:401, headers:{...cors(),"content-type":"application/json"} });

    // Service role for destructive operations
    const service = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'');
    const uid = user.id;
    // Best-effort unlink Stripe
    try{ await service.from('profiles').update({ stripe_customer_id: null }).eq('id', uid); }catch{}
    // Delete user-owned records (order matters if FKs exist)
    try{ await service.from('jobs').delete().eq('user_id', uid); }catch{}
    try{ await service.from('profiles').delete().eq('id', uid); }catch{}
    return new Response(JSON.stringify({ok:true}),{ status:200, headers:{...cors(),"content-type":"application/json"} });
  }catch(e){
    return new Response(JSON.stringify({ok:false,error:String(e)}),{ status:500, headers:{...cors(),"content-type":"application/json"} });
  }
}

Deno.serve(handler);


