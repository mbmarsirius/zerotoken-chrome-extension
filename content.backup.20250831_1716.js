const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwdmVyZ3ZmeHRodGhid3Rqc211Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYxODk0MjAsImV4cCI6MjA3MTc2NTQyMH0.GAgKvepBkOaPjFi9i462AGc007dWG-uefj94iw_EgoI";

/* Edge Functions */
const EDGE_START  = `${SUPABASE_URL}/functions/v1/handoff_start`;
const EDGE_STATUS = `${SUPABASE_URL}/functions/v1/handoff_status`;
const EMAIL_ENDPOINT = `${SUPABASE_URL}/functions/v1/handoff_email_proxy`;

/* Visual token limit */
const TOKEN_LIMIT = 200000;

/* ───────────────── Supabase Client ───────────────── */
let supabase = null;
if (window.createSupabaseClient) {
  supabase = window.createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/* ───────────────── Session / Profiles ───────────────── */
let currentUser = null;
let userProfile = null;

async function refreshSessionAndProfile() {
  if (!supabase) return;
  const { data: { user} } = await supabase.auth.getUser();
  currentUser = user || null;
  if (currentUser) {
    const { data } = await supabase.from("profiles").select("*").eq("id", currentUser.id).single();
    userProfile = data || null;
  } else userProfile = null;
}

/* ───────────────── Local counters ───────────────── */
function getThreadId(){ return (location.pathname||location.href||"global").replace(/\W+/g,"_"); }
function readLocalCounters(){ try{ return JSON.parse(localStorage.getItem("zt_counters")||"{}"); }catch{ return {}; } }
function writeLocalCounters(c){ try{ localStorage.setItem("zt_counters", JSON.stringify(c)); }catch{} }
function getLocalCount(kind){ const id=getThreadId(); const c=readLocalCounters(); return (c[id]?.[kind])||0; }
function bumpLocalCount(kind){ const id=getThreadId(); const c=readLocalCounters(); c[id]=c[id]||{cp:0,ho:0}; c[id][kind]++; writeLocalCounters(c); }

/* ───────────────── Token estimate ───────────────── */
let approxTokens=0, lastSavedTokens=0;
function estimateTokensFromText(s){ try{ if(window.TikTokenEncode) return window.TikTokenEncode(s).length; }catch{} return Math.ceil((s||"").length/4); }

/* ───────────────── UI helpers ───────────────── */
let uiMounted=false, uiBusy=false;
function pctColor(p){ if(p<=40) return "#25c277"; if(p<=70) return "#f5c04e"; if(p<=90) return "#f08b4b"; return "#e5484d"; }
function toast(msg){
  let t=document.getElementById("zt-toast");
  if(!t){ t=document.createElement("div"); t.id="zt-toast";
    t.style.cssText="position:fixed;right:22px;bottom:92px;background:#111c;backdrop-filter:blur(6px);color:#fff;padding:10px 14px;border-radius:10px;z-index:999999;font:13px Inter;transition:.2s;opacity:0";
    document.body.appendChild(t);
  }
  t.textContent=msg; t.style.opacity="1"; setTimeout(()=>{ t.style.opacity="0"; }, 2200);
}

/* ───────────────── Chat capture ───────────────── */
const UI_BLACKLIST=/^(zerotoken|checkpoint|generate|login|logout|register|auto-saved|unlimited handoffs active|first handoff|progress|token meter)/i;
const MAX_CHUNK_CHARS=2500;

function collectConversationChunks(maxChunkChars=MAX_CHUNK_CHARS){
  const nodes=Array.from(document.querySelectorAll('[data-message-author-role] .markdown, [data-message-author-role] article, main .markdown, main article'));
  const texts=nodes
    .filter(n=>!n.closest('#zt-panel')&&!n.closest('#zt-handoff-modal')&&!n.closest('#zt-auth-modal'))
    .map(n=>(n.innerText||"").split("\n").filter(line=>!UI_BLACKLIST.test(line.trim())).join("\n"))
    .filter(Boolean);
  const joined=texts.join("\n\n");
  approxTokens=estimateTokensFromText(joined);
  const chunks=[]; for(let i=0;i<joined.length;i+=maxChunkChars) chunks.push(joined.slice(i,i+maxChunkChars));
  return chunks;
}

/* ───────────────── Sanitize (client) ───────────────── */
function sanitizeTextClient(s){
  if(!s) return s;
  s=s.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,"[REDACTED_TOKEN]");
  s=s.replace(/(Bearer\s+[A-Za-z0-9._-]+)/gi,"Bearer [REDACTED]");
  s=s.replace(/\bapikey\s*:\s*[A-Za-z0-9._-]+/gi,"apikey: [REDACTED]");
  s=s.replace(/\bSUPABASE_[A-Z_]*KEY\b.*$/gmi,"SUPABASE_[…]KEY=[REDACTED]");
  s=s.replace(/https?:\/\/[^\s)'"`]+/g,(u)=>{ try{ const url=new URL(u); url.search=""; return url.toString(); }catch{ return u; } });
  return s;
}
function sanitizeChunks(chunks){ return chunks.map(sanitizeTextClient); }

/* ───────────────── Quotas ───────────────── */
async function canTakeCheckpoint(){ if(currentUser&&supabase){ try{ const {data}=await supabase.rpc("can_take_checkpoint",{uid:currentUser.id}); return !!data; }catch{return true;} } return getLocalCount("cp")<3; }
async function markCheckpoint(){ if(currentUser&&supabase){ try{ await supabase.rpc("mark_checkpoint",{uid:currentUser.id}); }catch{} if(userProfile) userProfile.checkpoint_used=(userProfile.checkpoint_used||0)+1; } else bumpLocalCount("cp"); }
async function canTakeHandoff(){ if(currentUser&&supabase){ try{ const {data}=await supabase.rpc("can_take_handoff",{uid:currentUser.id}); return !!data; }catch{return true;} } return getLocalCount("ho")<1; }
async function markHandoff(){ if(currentUser&&supabase){ try{ await supabase.rpc("mark_handoff",{uid:currentUser.id}); }catch{} if(userProfile) userProfile.handoff_used=(userProfile.handoff_used||0)+1; } else bumpLocalCount("ho"); }

/* ───────────────── Lazy-load ───────────────── */
async function silentlyLoadAllHistory(maxSteps=1){
  const el=document.querySelector('[data-testid="conversation-turns"]')||document.documentElement;
  let steps=0; while(steps++<maxSteps){
    const prev=el.scrollTop; el.scrollTop=Math.max(0,prev-1);
    await new Promise(r=>setTimeout(r,60)); el.scrollTop=prev;
    await new Promise(r=>setTimeout(r,120));
  }
}

/* ───────────────── Panel ───────────────── */
function renderOnce(){
  if(uiMounted) return; uiMounted=true;
  const root=document.createElement("div");
  root.id="zt-panel";
  root.style.cssText="position:fixed;right:18px;bottom:18px;width:330px;background:#0b0d12;color:#e6ebff;border:1px solid #1b2030;border-radius:16px;box-shadow:0 12px 44px rgba(0,0,0,.45);padding:14px;z-index:999998;font:13px/1.45 Inter,system-ui";
  root.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font-weight:600">ZeroToken</div>
      <div id="zt-token-fig" style="opacity:.75">0 tokens · 0%</div>
    </div>
    <div style="height:8px;border-radius:6px;background:#1a2234;overflow:hidden;margin-bottom:8px">
      <div id="zt-bar" style="height:8px;width:0%;background:#25c277"></div>
    </div>

    <div id="zt-account" style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin:6px 0 12px 0">
      <div id="zt-account-chip" style="font-size:12px;opacity:.9">Guest mode</div>
      <div id="zt-auth-actions" style="display:flex;gap:6px">
        <button id="zt-login-btn" style="background:#1f2a44;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Login</button>
        <button id="zt-reg-btn"   style="background:#263150;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Register</button>
      </div>
    </div>

    <div style="font-size:12px;opacity:.85;margin-bottom:10px">
      Auto-saved ✓ <span id="zt-saved-ago">just now</span>
    </div>

    <div style="padding:10px;background:#0f1422;border:1px solid #1c2333;border-radius:10px;margin-bottom:10px">
      <div style="font-weight:600;margin-bottom:4px">Checkpoint</div>
      <div id="zt-cp-status" style="opacity:.9">Checking…</div>
    </div>

    <button id="zt-handoff-btn"
      style="width:100%;background:#6a5cff;border:0;border-radius:10px;color:white;padding:10px 12px;cursor:pointer;font-weight:600">
      ⚡ Generate Handoff
    </button>
    <div id="zt-hint" style="text-align:center;font-size:12px;opacity:.8;margin-top:6px"></div>

    <div id="zt-progress" style="display:none;margin-top:8px">
      <div style="display:flex;justify-content:space-between;font-size:12px;opacity:.85">
        <span id="zt-prog-label">Generating…</span><span id="zt-prog-fig">0%</span>
      </div>
      <div style="height:6px;border-radius:6px;background:#1a2234;overflow:hidden;margin-top:4px">
        <div id="zt-prog-bar" style="height:6px;width:0%;background:#5b8cff"></div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  document.getElementById("zt-login-btn").onclick=()=>openAuthMiniModal("login");
  document.getElementById("zt-reg-btn").onclick=()=>openAuthMiniModal("register");
  document.getElementById("zt-handoff-btn").onclick=onHandoffClick;
}

function openAuthMiniModal(mode){
  let w=document.getElementById("zt-auth-modal"); if(w) w.remove();
  w=document.createElement("div"); w.id="zt-auth-modal";
  w.style.cssText="position:fixed;inset:0;background:#0008;z-index:100000;display:flex;align-items:center;justify-content:center;";
  w.innerHTML=`
    <div style="background:#0f1115;color:#fff;border:1px solid #1b2030;border-radius:14px;padding:18px;min-width:320px">
      <div style="font-weight:600;margin-bottom:10px">${mode==="login"?"Login":"Register"}</div>
      <input id="zt-auth-email" placeholder="email@example.com" style="width:100%;padding:8px;border-radius:8px;border:1px solid #263150;background:#0b0d12;color:#fff;margin-bottom:8px"/>
      <input id="zt-auth-pass"  placeholder="password" type="password" style="width:100%;padding:8px;border-radius:8px;border:1px solid #263150;background:#0b0d12;color:#fff;margin-bottom:12px"/>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="zt-auth-cancel" style="background:#222;border:0;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer">Cancel</button>
        <button id="zt-auth-ok" style="background:#6a5cff;border:0;color:#fff;padding:8px 12px;border-radius:8px;cursor:pointer">${mode==="login"?"Login":"Create"}</button>
      </div>
    </div>`;
  document.body.appendChild(w);
  w.querySelector("#zt-auth-cancel").onclick=()=>w.remove();
  w.querySelector("#zt-auth-ok").onclick=async()=>{
    const email=w.querySelector("#zt-auth-email").value.trim();
    const password=w.querySelector("#zt-auth-pass").value;
    try{
      if(mode==="login"){ const {error}=await supabase.auth.signInWithPassword({email,password}); if(error) throw error; }
      else{ const {error}=await supabase.auth.signUp({email,password}); if(error) throw error; }
      await refreshSessionAndProfile(); updateAccountChip(); updateCheckpointStatusUI();
      toast(mode==="login"?"Logged in ✓":"Registered ✓ Check email if required"); w.remove();
    }catch(e){ alert(e?.message||String(e)); }
  };
}

function updateAccountChip(){
  const chip=document.getElementById("zt-account-chip");
  const actions=document.getElementById("zt-auth-actions");
  if(!chip||!actions) return;
  if(currentUser?.email){
    chip.textContent=currentUser.email;
    actions.innerHTML=`<button id="zt-logout-btn" style="background:#2a203a;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Logout</button>`;
    document.getElementById("zt-logout-btn").onclick=async()=>{
      await supabase.auth.signOut().catch(()=>{});
      currentUser=null; userProfile=null; updateAccountChip(); updateCheckpointStatusUI(); toast("Logged out");
    };
  }else{
    chip.textContent="Guest mode";
    actions.innerHTML=`
      <button id="zt-login-btn" style="background:#1f2a44;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Login</button>
      <button id="zt-reg-btn"   style="background:#263150;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Register</button>`;
    document.getElementById("zt-login-btn").onclick=()=>openAuthMiniModal("login");
    document.getElementById("zt-reg-btn").onclick=()=>openAuthMiniModal("register");
  }
}

function updateDynamicUI(){
  const usedPct=Math.min(100,Math.round((approxTokens/TOKEN_LIMIT)*1000)/10);
  const fig=document.getElementById("zt-token-fig");
  const bar=document.getElementById("zt-bar");
  const hint=document.getElementById("zt-hint");
  if(fig) fig.textContent=`${(approxTokens||0).toLocaleString()} tokens · ${usedPct}%`;
  if(bar){ bar.style.width=`${usedPct}%`; bar.style.background=pctColor(usedPct); }
  const plan=(userProfile?.plan||"free");
  if(hint){ hint.textContent=plan==="vault"?"ZeroToken Pro active · unlimited handoffs":"🎁 First handoff is full ZeroToken Pro experience"; }
}

async function updateCheckpointStatusUI(){
  const el=document.getElementById("zt-cp-status"); if(!el) return;
  if(!currentUser){ el.textContent=`Used: ${getLocalCount("cp")}/3 (local)`; return; }
  const used=userProfile?.checkpoint_used ?? 0;
  el.textContent=(userProfile?.plan||"free")==="vault"?"Auto-save: Unlimited":`Used: ${used}/3`;
}

/* ───────────────── Premium Modal ───────────────── */
function openHandoffModal({jobId,title,result,meta,plan}){
  let overlay=document.getElementById("zt-handoff-modal"); if(overlay) overlay.remove();
  overlay=document.createElement("div"); overlay.id="zt-handoff-modal";
  overlay.style.cssText="position:fixed;inset:0;background:rgba(17,17,17,.6);backdrop-filter:blur(2px);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:22px;";
  const modal=document.createElement("div"); modal.style.cssText="width:min(920px,92vw);max-height:86vh;overflow:auto;background:#0b0c10;color:#e8e8e8;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.5);font:14px/1.6 Inter,system-ui;";
  const header=document.createElement("div"); header.style.cssText="position:sticky;top:0;background:#0b0c10;border-bottom:1px solid #1f2229;padding:14px 16px;display:flex;justify-content:space-between;gap:12px;align-items:center;";
  header.innerHTML=`
    <div>
      <div style="font-weight:700;font-size:16px">${escapeHtml(title||"Handoff Report")}</div>
      <div style="opacity:.75;font-size:12px">${meta?.createdAt??""} · ${meta?.model??""} · tokens: ${meta?.tokens??"–"} · checkpoints: ${meta?.checkpoints??"–"}</div>
    </div>
    <div style="display:flex;gap:8px">
      <button data-act="copy" class="zt-btn">Copy</button>
      <button data-act="pdf" class="zt-btn">PDF</button>
      <button data-act="email" class="zt-btn">E-mail</button>
      <button data-act="close" class="zt-btn" style="background:#252833">Close</button>
    </div>`;
  const content=document.createElement("div"); content.style.cssText="padding:18px 16px";
  content.innerHTML=`<div class="zt-md" id="zt-md">${escapeHtml(result).replace(/\n/g,"<br/>")}</div>`;
  const footer=document.createElement("div"); footer.style.cssText="position:sticky;bottom:0;background:#0b0c10;border-top:1px solid #1f2229;padding:12px 16px;";
  footer.innerHTML=(plan==="vault")
    ? `<div style="opacity:.7;font-size:12px">ZeroToken Pro active · unlimited handoffs</div>`
    : `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
         <div style="font-size:13px;opacity:.9">First handoff is full <b>ZeroToken Pro</b> experience. Want unlimited?</div>
         <button data-act="upgrade" class="zt-btn" style="background:#7c5cff">Upgrade to ZeroToken Pro</button>
       </div>`;
  const style=document.createElement("style"); style.textContent=`
    .zt-btn{background:#323644;color:#fff;border:0;padding:8px 12px;border-radius:10px;cursor:pointer;font-weight:600}
    .zt-btn:hover{filter:brightness(1.08)}
    @media print{ body *{visibility:hidden} #zt-printable,#zt-printable *{visibility:visible} #zt-printable{position:absolute;left:0;top:0;width:100%}}
    .zt-md h2{margin:18px 0 8px;font-size:18px} .zt-md p{margin:0 0 10px}
    .zt-md pre{background:#0e1016;padding:12px;border-radius:10px;overflow:auto} .zt-md code{background:#0e1016;padding:2px 6px;border-radius:6px}
  `;
  modal.appendChild(style); modal.appendChild(header); modal.appendChild(content); modal.appendChild(footer);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.addEventListener("click",(e)=>{ if(e.target===overlay) close(); });
  modal.querySelector('[data-act="close"]').addEventListener("click", close);
  modal.querySelector('[data-act="copy"]').addEventListener("click", async ()=>{ try{ await navigator.clipboard.writeText(result); toast("Copied ✓"); }catch{ fallbackCopy(result); toast("Copied (fallback) ✓"); } });
  modal.querySelector('[data-act="pdf"]').addEventListener("click", ()=>{
    const w=window.open("","_blank"); if(!w){ toast("Popup blocked"); return; }
    const html=`<html><head><title>${escapeHtml(title||"Handoff Report")}</title><style>
      body{font:14px/1.6 Inter,system-ui;margin:24px;color:#111} h2{margin:18px 0 6px;font-size:18px}
      pre{background:#f5f7fa;padding:12px;border-radius:8px;overflow:auto} code{background:#f5f7fa;padding:2px 6px;border-radius:4px}
    </style></head><body id="zt-printable">
      <h1 style="font:600 20px Inter;margin:0 0 8px">${escapeHtml(title||"Handoff Report")}</h1>
      <div style="opacity:.7;font-size:12px;margin-bottom:12px">${meta?.createdAt??""} · ${meta?.model??""} · tokens: ${meta?.tokens??"–"} · checkpoints: ${meta?.checkpoints??"–"}</div>
      ${escapeHtml(result).replace(/\n/g,"<br/>")}
    </body></html>`;
    w.document.write(html); w.document.close(); w.focus(); w.print();
  });
  modal.querySelector('[data-act="email"]').addEventListener("click", async ()=>{
    const to=prompt("Send to e-mail:"); if(!to) return;
    let accessToken=null; try{ if(supabase){ const {data:{session}}=await supabase.auth.getSession(); accessToken=session?.access_token||null; } }catch{}
    if(!accessToken){ alert("Please login first to send by email."); return; }
    try{
      const r=await fetch(EMAIL_ENDPOINT,{ method:"POST", headers:{ "Content-Type":"application/json","Authorization":`Bearer ${accessToken}` }, body:JSON.stringify({jobId,to}) });
      if(!r.ok) throw new Error(await r.text()); toast("E-mail sent ✓");
    }catch(e){ console.error(e); toast("E-mail failed"); }
  });
  const upg=modal.querySelector('[data-act="upgrade"]'); if(upg) upg.addEventListener("click", ()=>{ window.open("https://zerotoken.ai/upgrade?plan=pro","_blank"); });
  function close(){ document.body.removeChild(overlay); }
  function fallbackCopy(text){ const ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  function escapeHtml(s){ return s?.replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))??""; }
}

/* ───────────────── Tween helper ───────────────── */
function tweenPercent(from,to,durationMs,onFrame,done){
  const start=performance.now(), delta=to-from;
  function frame(now){
    const t=Math.min(1,(now-start)/durationMs), eased=1-Math.pow(1-t,3), val=from+delta*eased;
    onFrame(val); if(t<1) requestAnimationFrame(frame); else done&&done();
  }
  requestAnimationFrame(frame);
}

/* ───────────────── Start→Status (smoother) ───────────────── */
async function onHandoffClick(){
  if(uiBusy) return; uiBusy=true;
  const btn=document.getElementById("zt-handoff-btn");
  const progress=document.getElementById("zt-progress");
  const progBar=document.getElementById("zt-prog-bar");
  const progFig=document.getElementById("zt-prog-fig");
  const progLabel=document.getElementById("zt-prog-label");

  btn.disabled=true; btn.textContent="⏳ Generating…";
  progress.style.display="block"; if(progLabel) progLabel.textContent="Mapping…";

  let shownPct=0; const setPct=(p)=>{ const c=Math.max(0,Math.min(100,p)); shownPct=c; if(progBar) progBar.style.width=`${c|0}%`; if(progFig) progFig.textContent=`${c|0}%`; };
  setPct(0);

  let optimisticCap=65; // mapping
  let lastServerPct=0, lastServerTs=Date.now();
  let stage="queued";

  const optTimer=setInterval(()=>{ const since=Date.now()-lastServerTs; if(since>1200){ const target=Math.min(optimisticCap, (shownPct+Math.max(0.8,(since/3000)))); if(target>shownPct) tweenPercent(shownPct,target,400,setPct); } },800);

  try{
    const okToHandoff=await canTakeHandoff();
    if(!okToHandoff && (userProfile?.plan||"free")!=="vault"){ alert("You used your free handoff. Upgrade to ZeroToken Pro for unlimited."); return; }

    await silentlyLoadAllHistory();
    const chunks=sanitizeChunks(collectConversationChunks());
    const title=document.title||"Untitled Thread";

    const startRes=await fetch(EDGE_START,{ method:"POST", headers:{ "Content-Type":"application/json","Authorization":`Bearer ${SUPABASE_ANON_KEY}`,"apikey":SUPABASE_ANON_KEY }, body:JSON.stringify({ userId:currentUser?.id||null, plan:(userProfile?.plan||"free").toLowerCase(), title, threadId:getThreadId(), chunks }) });
    if(!startRes.ok) throw new Error(await startRes.text());
    const { job_id, meta }=await startRes.json();

    await new Promise((resolve,reject)=>{
      const safetyTimer=setTimeout(()=>{ try{ if(progress) progress.style.display="none"; }catch{} reject(new Error("Timeout while generating handoff")); },180000);

      const tick=async()=>{
        try{
          const r=await fetch(`${EDGE_STATUS}?job=${job_id}&t=${Date.now()}`,{ headers:{ "Authorization":`Bearer ${SUPABASE_ANON_KEY}`,"apikey":SUPABASE_ANON_KEY } });
          if(!r.ok) throw new Error(await r.text());
          const st=await r.json();

          // stage display + optimistic ceilings
          if(st.stage && st.stage!==stage){
            stage=st.stage;
            if(stage==="mapping"){ optimisticCap=65; if(progLabel) progLabel.textContent="Mapping…"; }
            else if(stage==="reduce"){ optimisticCap=95; if(progLabel) progLabel.textContent="Synthesizing…"; }
            else if(stage==="final"){ optimisticCap=100; }
          }

          // Special: mapping tamamlandıysa ama stage hâlâ "mapping" görünüyorsa, boşlukta akıcı kal:
          if(st.total_chunks>0 && st.processed_chunks>=st.total_chunks && (stage==="mapping" || !stage)){
            optimisticCap=92; if(progLabel) progLabel.textContent="Synthesizing…";
          }

          // server percent tween
          const serverPct=Math.max(0,Math.min(100, st.percent|0));
          if(serverPct>lastServerPct){ lastServerPct=serverPct; lastServerTs=Date.now(); tweenPercent(shownPct,serverPct,300,setPct); }

          const finished=(st.status==="done") || (st.has_result===true) || (!!st.result && st.result.length>0);
          if(finished){
            clearTimeout(safetyTimer); clearInterval(optTimer);
            tweenPercent(shownPct,100,400,setPct,()=>{
              const bar=document.getElementById("zt-prog-bar"); if(bar) bar.style.background="#25c277";
              openHandoffModal({
                jobId:job_id, title, result:st.result||"(empty)",
                meta:{ createdAt:new Date().toLocaleString("en-GB",{hour12:false}), model:meta?.model||"Unknown", tokens:meta?.token_estimate??undefined, checkpoints:meta?.checkpoint_count??undefined },
                plan:(userProfile?.plan||"free")
              });
            });
            resolve(true); return;
          }
          setTimeout(tick,450);
        }catch{ setTimeout(tick,700); }
      };
      tick();
    });

    await markHandoff();

  }catch(e){
    alert("Handoff failed: "+(e?.message||e));
  }finally{
    clearInterval(optTimer);
    const progress=document.getElementById("zt-progress");
    const btn=document.getElementById("zt-handoff-btn");
    if(btn){ btn.disabled=false; btn.textContent="⚡ Generate Handoff"; }
    uiBusy=false; updateCheckpointStatusUI();
    setTimeout(()=>{ if(progress) progress.style.display="none"; },1200);
  }
}

/* ───────────────── Auto-checkpoint ───────────────── */
async function maybeAutoCheckpoint(){
  const delta=approxTokens-lastSavedTokens, threshold=3000;
  if(delta>=threshold){
    const ok=await canTakeCheckpoint();
    if(!ok && (userProfile?.plan||"free")!=="vault"){ lastSavedTokens=approxTokens; return; }
    await markCheckpoint(); lastSavedTokens=approxTokens;
    const ago=document.getElementById("zt-saved-ago"); if(ago) ago.textContent="just now";
    updateCheckpointStatusUI(); toast("Auto-checkpoint saved ✓");
  }
}

/* ───────────────── Main ───────────────── */
(function(){ (async()=>{
  await refreshSessionAndProfile(); renderOnce(); updateAccountChip();
  collectConversationChunks(); updateDynamicUI(); updateCheckpointStatusUI();
  setInterval(()=>{ collectConversationChunks(); updateDynamicUI(); updateCheckpointStatusUI(); maybeAutoCheckpoint().catch(()=>{}); },1500);
})(); })();

