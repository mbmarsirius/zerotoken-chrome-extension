// @ts-nocheck
import { createClient } from "jsr:@supabase/supabase-js@2";

function cors(){ return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type", "cache-control":"no-store" }; }

const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";

export default async function handler(req: Request){
  if (req.method === 'OPTIONS') return new Response(null,{ status:204, headers:cors() });
  try{
    const auth = req.headers.get('authorization')||'';
    const token = auth.replace(/^Bearer\s+/i,'');
    if(!token) return new Response(JSON.stringify({ok:false,error:'unauthorized'}),{ status:401, headers:{...cors(),"content-type":"application/json"} });
    const userClient = createClient(SUPABASE_URL, token);
    const { data: { user } } = await userClient.auth.getUser();
    if(!user) return new Response(JSON.stringify({ok:false,error:'unauthorized'}),{ status:401, headers:{...cors(),"content-type":"application/json"} });

    // Read public profile fields
    const { data: profile } = await userClient.from('profiles').select('id,plan,checkpoint_used,handoff_used').eq('id', user.id).maybeSingle();
    // Jobs/handoffs for this user (limited fields)
    const { data: jobs } = await userClient.from('jobs').select('id,title,created_at,model,token_estimate,checkpoint_count,result').eq('user_id', user.id).order('created_at',{ascending:false}).limit(200);

    const payload = { ok:true, profile: profile||{}, handoffs: jobs||[] };
    return new Response(JSON.stringify(payload),{ status:200, headers:{...cors(),"content-type":"application/json; charset=utf-8"} });
  }catch(e){
    return new Response(JSON.stringify({ok:false,error:String(e)}),{ status:500, headers:{...cors(),"content-type":"application/json"} });
  }
}

Deno.serve(handler);


