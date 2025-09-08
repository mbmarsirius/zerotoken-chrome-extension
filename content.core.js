/* Core UI + Logic (ZeroToken) — Shadow DOM + robust auth + stable UI + monotonic progress */

/* ───────────────── Config ───────────────── */
const SUPABASE_URL = "https://ppvergvfxththbwtjsmu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwdmVyZ3ZmeHRodGhid3Rqc211Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTYxODk0MjAsImV4cCI6MjA3MTc2NTQyMH0.GAgKvepBkOaPjFi9i462AGc007dWG-uefj94iw_EgoI";

/* Edge Functions */
const EDGE_START  = `${SUPABASE_URL}/functions/v1/continuity_v1`;
const EDGE_STATUS = `${SUPABASE_URL}/functions/v1/handoff_status`;
const EMAIL_ENDPOINT = `${SUPABASE_URL}/functions/v1/handoff_email_proxy`;
// New (flagged) endpoints — may or may not exist; guarded with try/catch
const EDGE_CAPSULE_SAVE = `${SUPABASE_URL}/functions/v1/capsule_save_v2`;
const EDGE_MR = `${SUPABASE_URL}/functions/v1/map_reduce_v2`;
// Removed unused endpoint - using EDGE_START (continuity_v1) directly

/* Visual token limit */
const TOKEN_LIMIT = 200000;

/* ───────────────── Feature Flags (default: all off, UI unchanged) ───────────────── */
function readFlags(){ try{ return JSON.parse(localStorage.getItem("ZT_FLAGS")||"{}"); }catch{ return {}; } }
function isFlagOn(name){ const f=readFlags(); return !!f[name]; }
function trace(){ if(isFlagOn("TRACE")) { try{ console.log.apply(console, ["[ZT][TRACE]", ...arguments]); }catch{} } }
// Flags (opt-in via DevTools): NEW_PIPELINE, SHADOW_CPS, EXACT_TOKENS, TRACE, CONT_V3, CONT_V3_SALIENCY, CONT_V3_FAST60, CONT_V3_FAST60_HOTFIX3, CONT_V3_FAST60_HOTFIX4_1

/* ───────────────── Supabase Client ───────────────── */
let supabase = null;

/* bundle.js content-script dünyasında yüklü; burada bağla */
function ensureSupabase(){
  try{
    if (!supabase && typeof window.createSupabaseClient === "function") {
      supabase = window.createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      window.__zt_supabase = supabase; // debug için görünür
      console.info("[ZeroToken] Supabase client attached ✓");
    }
  }catch(e){
    console.error("[ZeroToken] ensureSupabase error:", e);
  }
}
ensureSupabase();

/* ───────────────── Session / Profiles ───────────────── */
let currentUser = null;
let userProfile = null;

async function refreshSessionAndProfile() {
  ensureSupabase();
  if (!supabase) { trace("[ZT] Supabase client missing"); return; }
  try {
    // First check session to avoid noisy "Auth session missing" on logged-out state
    const { data: { session }, error: sessErr } = await supabase.auth.getSession();
    if (sessErr) { trace("[ZT] getSession warn:", sessErr.message); }
    if (!session) { currentUser = null; userProfile = null; return; }

    const user = session.user || null;
    currentUser = user;

    if (currentUser) {
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", currentUser.id)
        .single();
      userProfile = data || null;
    } else {
      userProfile = null;
    }
  } catch (e) {
    console.error("[ZT] refreshSessionAndProfile failed:", e);
    currentUser = null; userProfile = null;
  }
}

// Ensure user has a row in `profiles` (plan defaults to free). Safe, non-destructive.
async function ensureUserProfileExists(defaultPlan = "free"){
  try{
    ensureSupabase(); if(!supabase) return;
    const { data: { user } } = await supabase.auth.getUser();
    const uid = user?.id; if(!uid) return;
    // Check existing row first to avoid overwriting plan/counters
    const { data: existing } = await supabase
      .from("profiles")
      .select("id, plan")
      .eq("id", uid)
      .maybeSingle();
    if(!existing){
      await supabase.from("profiles").insert({ id: uid, plan: (defaultPlan||"free").toLowerCase(), checkpoint_used: 0, handoff_used: 0 }).catch(()=>{});
    } else if(!existing.plan){
      await supabase.from("profiles").update({ plan: (defaultPlan||"free").toLowerCase() }).eq("id", uid).catch(()=>{});
    }
  }catch(e){ console.warn("[ZT] ensureUserProfileExists failed:", e?.message||e); }
}

/* ───────────────── Shadow host + watchdog ───────────────── */
let ztHost = null;       // shadow host (div#zt-host)
let ztShadow = null;     // shadowRoot
let ztObs = null;        // mutation observer

function ensureHost() {
  if (ztHost && document.documentElement.contains(ztHost)) return ztHost;

  ztHost = document.getElementById('zt-host');
  if (!ztHost) {
    ztHost = document.createElement('div');
    ztHost.id = 'zt-host';
    ztHost.style.position = 'fixed';
    ztHost.style.right = '18px';
    ztHost.style.bottom = '18px';
    ztHost.style.zIndex = '2147483647';
    ztHost.style.pointerEvents = 'none'; // içeride açacağız
    document.documentElement.appendChild(ztHost);
  }
  if (!ztHost.shadowRoot) {
    ztShadow = ztHost.attachShadow({ mode: 'open' });
    const wrap = document.createElement('div');
    wrap.id = 'zt-wrap';
    wrap.style.pointerEvents = 'auto';
    ztShadow.appendChild(wrap);
    const base = document.createElement('style');
    base.textContent = `
      :host{ all: initial; }
      #zt-wrap{ all: initial; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    `;
    ztShadow.appendChild(base);
  } else {
    ztShadow = ztHost.shadowRoot;
  }
  if (!ztObs) {
    ztObs = new MutationObserver(() => {
      if (!document.documentElement.contains(ztHost)) {
        ztHost = null; ztShadow = null;
        ensureHost();
        uiMounted = false;
        renderOnce();
      }
    });
    ztObs.observe(document.documentElement, { childList: true, subtree: true });
  }
  return ztHost;
}

function mountIntoShadow(node) {
  ensureHost();
  const wrap = ztShadow.getElementById('zt-wrap');
  wrap.innerHTML = '';
  wrap.appendChild(node);
}

// Shadow içine assets/theme.css'i <link rel="stylesheet"> ile yükle
function injectThemeCss(retry = 0) {
  try {
    ensureHost();
    if (!ztShadow) return;
    if (ztShadow.getElementById('zt-theme-css')) return; // zaten yüklü

    const href = chrome.runtime.getURL("assets/theme.css"); // sadece URL oluşturuyor
    const link = document.createElement('link');
    link.id = 'zt-theme-css';
    link.rel = 'stylesheet';
    link.href = href;
    ztShadow.appendChild(link);
    console.info("[ZeroToken] theme.css linked into Shadow ✓");
  } catch (e) {
    console.warn("[ZeroToken] theme.css inject failed:", e);
    // Uzantı reload'dan sonra kısa süre invalid olabilir: 1 sn sonra bir kez daha dene
    if (retry < 3) setTimeout(() => injectThemeCss(retry + 1), 1000);
  }
}


// ─────────────── Minimize support (non-invasive) ───────────────
const ZT_MIN_KEY = 'ZT_MINIMIZED';
function isMinimized(){ try{ return localStorage.getItem(ZT_MIN_KEY)==='1'; }catch{ return false; } }
function setMinimized(v){ try{ localStorage.setItem(ZT_MIN_KEY, v?'1':'0'); }catch{} }

function ensureMini(){
  try{
    ensureHost();
    const wrap = ztShadow?.getElementById('zt-wrap');
    if(!wrap) return null;
    let mini = wrap.querySelector('#zt-mini');
    if(!mini){
      mini = document.createElement('div');
      mini.id = 'zt-mini';
      mini.style.cssText = 'position:fixed;right:18px;top:50%;transform:translateY(-50%);background:#0b0d12;color:#e6ebff;border:1px solid #1b2030;border-radius:16px;box-shadow:0 12px 44px rgba(0,0,0,.45);padding:8px 10px;z-index:2147483647;font:12px/1.2 Inter,system-ui;display:none;pointer-events:auto;cursor:pointer;width:max-content;text-align:center;left:auto;';
      const logoUrl = chrome.runtime.getURL('assets/ZTblackbckgrn.png');
      mini.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><span class="zt-mini-wordmark" style="display:inline-block;height:14px;width:80px;max-width:100%;background-image:url(${logoUrl});background-size:contain;background-repeat:no-repeat;background-position:center"></span><span id="zt-mini-fig" style="display:block">0%</span></div>`;
      wrap.appendChild(mini);
      mini.addEventListener('click', ()=>{ setMinimized(false); applyMinimizedState(); });
    }
    // Draggable mini + stored position
    try{ applyStoredPosition(mini, ZT_POS_MINI); makeDraggable(mini, ZT_POS_MINI); }catch{}
    return mini;
  }catch{ return null; }
}

// ─────────────── Drag support (panel + mini, persisted) ───────────────
const ZT_POS_PANEL = 'ZT_POS_PANEL';
const ZT_POS_MINI  = 'ZT_POS_MINI';
function readPos(key){ try{ return JSON.parse(localStorage.getItem(key)||'null'); }catch{ return null; } }
function writePos(key,pos){ try{ localStorage.setItem(key, JSON.stringify(pos)); }catch{} }
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }

function applyStoredPosition(el, key){
  try{
    ensureHost();
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = rect.width, h = rect.height;
    const margin = 10;

    let pos = readPos(key);
    // If no stored position yet, keep default CSS (don't override with 0,0)
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;

    // Clamp within viewport
    const left = clamp(pos.left ?? 0, margin, Math.max(margin, vw - (w||200) - margin));
    const top  = clamp(pos.top  ?? 0, margin, Math.max(margin, vh - (h||80)  - margin));

    el.style.left = `${Math.round(left)}px`;
    el.style.top  = `${Math.round(top)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    // Remove translateY(-50%) used by default centering
    if (el.style.transform) el.style.transform = 'none';
  }catch{}
}

function makeDraggable(el, key){
  if(!el || el.getAttribute('data-drag-attached')==='1') return;
  el.setAttribute('data-drag-attached','1');
  el.style.cursor = 'move';

  let startX=0, startY=0, startLeft=0, startTop=0, dragging=false;

  function onDown(ev){
    try{
      const e = (ev.touches?.[0])||ev;
      dragging = true;
      const rect = el.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startLeft = rect.left; startTop = rect.top;
      el.style.right='auto'; el.style.bottom='auto';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, {passive:false});
      document.addEventListener('touchend', onUp);
      ev.preventDefault?.();
    }catch{}
  }
  function onMove(ev){
    if(!dragging) return;
    const e = (ev.touches?.[0])||ev;
    const dx = e.clientX - startX; const dy = e.clientY - startY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = clamp(startLeft + dx, 0, vw - w);
    const top  = clamp(startTop  + dy, 0, vh - h);
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
    ev.preventDefault?.();
  }
  function onUp(){
    if(!dragging) return;
    dragging=false;
    const rect = el.getBoundingClientRect();
    writePos(key, { left: Math.round(rect.left), top: Math.round(rect.top) });
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  }

  el.addEventListener('mousedown', onDown);
  el.addEventListener('touchstart', onDown, {passive:false});
  // İlk konumu uygula (varsa)
  applyStoredPosition(el, key);
}

function updateMiniUI(){
  try{
    const wrap = ztShadow?.getElementById('zt-wrap');
    const mini = wrap?.querySelector('#zt-mini');
    if(!mini) return;
    const fig = mini.querySelector('#zt-mini-fig');
    const usedPct = Math.min(100, Math.round((approxTokens/TOKEN_LIMIT)*100));
    if(fig){ fig.textContent = `${usedPct}%`; fig.style.color = pctColor(usedPct); }
  }catch{}
}

function applyMinimizedState(){
  try{
    ensureHost();
    const wrap = ztShadow?.getElementById('zt-wrap');
    const panel = wrap?.querySelector('#zt-panel');
    const mini = ensureMini();
    const m = isMinimized();
    if(m){
      if(panel) panel.style.display='none';
      if(mini) mini.style.display='block';
      updateMiniUI();
    } else {
      if(panel) panel.style.display='block';
      if(mini) mini.style.display='none';
    }
  }catch{}
}


function ensurePanelVisible() {
  try {
    ensureHost();
    injectThemeCss(); // shadow yeniden oluştuysa temayı tekrar yükle
    // Minimized ise paneli zorla görünür yapma; mini görünümünü koru
    if (isMinimized()) { ensureMini(); applyMinimizedState(); return; }
    const wrap = ztShadow?.getElementById('zt-wrap');
    let p = wrap?.querySelector('#zt-panel');

    if (!p) {
      uiMounted = false;
      renderOnce();
      p = wrap?.querySelector('#zt-panel');
    }
    if (p) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) {
        p.style.display = 'block';
        p.style.visibility = 'visible';
        p.style.opacity = '1';
      }
      p.style.zIndex = '2147483647';
      p.style.pointerEvents = 'auto';
      // Draggable bağla (bir kez)
      makeDraggable(p, ZT_POS_PANEL);
    }
  } catch (e) {
    console.warn('[ZT] ensurePanelVisible error:', e);
  }
}

/* ───────────────── Local counters ───────────────── */
function getThreadId(){ return (location.pathname||location.href||"global").replace(/\W+/g,"_"); }
function readLocalCounters(){ try{ return JSON.parse(localStorage.getItem("zt_counters")||"{}"); }catch{ return {}; } }
function writeLocalCounters(c){ try{ localStorage.setItem("zt_counters", JSON.stringify(c)); }catch{} }
function getLocalCount(kind){ const id=getThreadId(); const c=readLocalCounters(); return (c[id]?.[kind])||0; }
function bumpLocalCount(kind){ const id=getThreadId(); const c=readLocalCounters(); c[id]=c[id]||{cp:0,ho:0}; c[id][kind]++; writeLocalCounters(c); }
// Global counters (chat-independent)
function readGlobalCounters(){ try{ return JSON.parse(localStorage.getItem('zt_global')||'{}'); }catch{ return {}; } }
function writeGlobalCounters(c){ try{ localStorage.setItem('zt_global', JSON.stringify(c)); }catch{} }
function getGlobalCount(kind){ const g=readGlobalCounters(); return Number(g?.[kind]||0); }
function bumpGlobalCount(kind){ const g=readGlobalCounters(); g[kind]=Number(g?.[kind]||0)+1; writeGlobalCounters(g); }

/* ───────────────── Token estimate ───────────────── */
let approxTokens=0, lastSavedTokens=0;
function estimateTokensFromText(s){
  try{
    if (window.TikTokenEncode) return window.TikTokenEncode(s).length;
    if (window.encode)       return window.encode(s).length;
  }catch{}
  return Math.ceil((s||"").length/4);
}

/* ───────────────── Exact token meter (flagged) ───────────────── */
async function updateExactTokenMeter(jobMeta){
  if(!isFlagOn("EXACT_TOKENS")) return;
  try{
    const wrap = ztShadow?.getElementById('zt-wrap');
    const fig=wrap?.querySelector("#zt-token-fig");
    const serverEst = Number(jobMeta?.token_estimate||0) || 0;
    if (serverEst>0 && fig){ fig.textContent = `${serverEst.toLocaleString()} tokens · ${(Math.min(100, Math.round(serverEst/TOKEN_LIMIT*100)))||0}%`; }
  }catch{}
}

/* ───────────────── Shadow Capsule (flagged, no-op by default) ───────────────── */
async function maybeSaveShadowCapsule(rawChunks){
  if(!isFlagOn("SHADOW_CPS")) return;
  try{
    const threadId=getThreadId();
    // Prefer real user JWT if available (Verify JWT-enabled functions)
    let accessToken=null;
    try{ ensureSupabase(); const s=await supabase?.auth?.getSession?.(); accessToken=s?.data?.session?.access_token||null; }catch{}
    const payload={
      userId: currentUser?.id||null,
      threadId,
      approxTokens,
      checkpointNumber: (getLocalCount("cp")||0)+1,
      raw_chunks: rawChunks||[],
      meta:{ ts: Date.now() }
    };
    trace("capsule_save_v2 →", payload);
    const res=await fetch(EDGE_CAPSULE_SAVE,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        // If user JWT exists, use it; otherwise fall back to anon
        "Authorization": `Bearer ${accessToken||SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY
      },
      body:JSON.stringify(payload)
    });
    if(!res.ok){
      let bodyText=""; try{ bodyText=await res.text(); }catch{}
      trace("capsule_save_v2 ←", res.status, bodyText.slice(0,300));
    } else {
      trace("capsule_save_v2 ←", res.status);
    }
  }catch(e){ trace("capsule_save_v2 error", e?.message||e); }
}

// Auto-save a shadow capsule for heavy chats (no flag needed)
async function saveShadowCapsuleIfHeavy(rawChunks, totalTokens, threshold=20000){
  try{
    if(!Array.isArray(rawChunks)) return;
    if((Number(totalTokens)||0) < threshold) return;
    const threadId=getThreadId();
    let accessToken=null; try{ ensureSupabase(); const s=await supabase?.auth?.getSession?.(); accessToken=s?.data?.session?.access_token||null; }catch{}
    const payload={ userId: currentUser?.id||null, threadId, approxTokens:Number(totalTokens)||0, checkpointNumber:(getLocalCount("cp")||0)+1, raw_chunks: rawChunks||[], meta:{ ts: Date.now(), cause:"auto-heavy" } };
    await fetch(EDGE_CAPSULE_SAVE,{ method:"POST", headers:{ "Content-Type":"application/json","Authorization":`Bearer ${accessToken||SUPABASE_ANON_KEY}`,"apikey":SUPABASE_ANON_KEY }, body:JSON.stringify(payload)}).catch(()=>{});
  }catch{}
}

/* ───────────────── UI helpers ───────────────── */
let uiMounted=false, uiBusy=false;
function pctColor(p){ if(p<=40) return "#25c277"; if(p<=70) return "#f5c04e"; if(p<=90) return "#f08b4b"; return "#e5484d"; }
function toast(msg){
  let t=document.getElementById("zt-toast");
  if(!t){ t=document.createElement("div"); t.id="zt-toast";
    t.style.cssText="position:fixed;right:22px;bottom:92px;background:#111c;backdrop-filter:blur(6px);color:#fff;padding:10px 14px;border-radius:10px;z-index:2147483647;font:13px Inter;transition:.2s;opacity:0";
    document.body.appendChild(t);
  }
  t.textContent=msg; t.style.opacity="1"; setTimeout(()=>{ t.style.opacity="0"; }, 2200);
}

/* ───────────────── Chat capture ───────────────── */
const UI_BLACKLIST=/^(zerotoken|checkpoint|generate|login|logout|register|auto-saved|unlimited handoffs active|first handoff|progress|token meter)/i;
/* SMART CHUNKING - Mesaj sınırlarında böl, ortadan kesme */
const MAX_CHUNK_CHARS=10000; // Increased for better context
const OPTIMAL_CHUNK_TOKENS=3000; // Token-based chunking

function collectConversationChunks(maxChunkChars=MAX_CHUNK_CHARS){
  // Önce her mesajı ayrı ayrı topla
  const messageNodes=Array.from(document.querySelectorAll('[data-message-author-role]'));
  let messages=[];
  
  if(messageNodes.length > 0) {
    // Her mesajı role ile birlikte sakla
    messages = messageNodes
      .filter(n=>!n.closest('#zt-panel')&&!n.closest('#zt-handoff-modal')&&!n.closest('#zt-auth-modal'))
      .map(node => {
        const role = node.getAttribute('data-message-author-role') || 'unknown';
        const content = (node.querySelector('.markdown, article')?.innerText || node.innerText || "")
          .split("\n")
          .filter(line=>!UI_BLACKLIST.test(line.trim()))
          .join("\n");
        return { role, content };
      })
      .filter(m => m.content.trim());
  } else {
    // Fallback: Eski yöntem
    const nodes=Array.from(document.querySelectorAll('[data-message-author-role] .markdown, [data-message-author-role] article, main .markdown, main article'));
    let texts=nodes
      .filter(n=>!n.closest('#zt-panel')&&!n.closest('#zt-handoff-modal')&&!n.closest('#zt-auth-modal'))
      .map(n=>(n.innerText||"").split("\n").filter(line=>!UI_BLACKLIST.test(line.trim())).join("\n"))
      .filter(Boolean);
    
    if(!texts.length){
      try{
        const raw=(document.body?.innerText||"")
          .split("\n")
          .map(l=>l.trim())
          .filter(l=>l && !UI_BLACKLIST.test(l))
          .join("\n");
        const safeRaw = raw.slice(0, 200000); // Increased limit for long conversations
        if(safeRaw.trim()) texts=[safeRaw];
      }catch{}
    }
    
    // Fallback durumunda basit chunking yap
    const joined=texts.join("\n\n");
    approxTokens=estimateTokensFromText(joined);
    const chunks=[]; 
    for(let i=0;i<joined.length;i+=maxChunkChars) {
      chunks.push(joined.slice(i,i+maxChunkChars));
    }
    return chunks;
  }
  
  // SMART CHUNKING: Mesaj sınırlarında böl
  const chunks = [];
  let currentChunk = "";
  let currentTokens = 0;
  
  for(const msg of messages) {
    const msgText = `${msg.role}: ${msg.content}\n\n`;
    const msgTokens = estimateTokensFromText(msgText);
    
    // Eğer tek mesaj bile çok büyükse, onu böl
    if(msgTokens > OPTIMAL_CHUNK_TOKENS) {
      // Önce mevcut chunk'ı kapat
      if(currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
        currentTokens = 0;
      }
      
      // Büyük mesajı parçala
      const words = msgText.split(' ');
      let tempChunk = "";
      let tempTokens = 0;
      
      for(const word of words) {
        const wordTokens = estimateTokensFromText(word + " ");
        if(tempTokens + wordTokens > OPTIMAL_CHUNK_TOKENS) {
          chunks.push(tempChunk);
          tempChunk = word + " ";
          tempTokens = wordTokens;
        } else {
          tempChunk += word + " ";
          tempTokens += wordTokens;
        }
      }
      if(tempChunk) chunks.push(tempChunk);
      
    } else if(currentTokens + msgTokens > OPTIMAL_CHUNK_TOKENS) {
      // Mevcut chunk'ı kapat, yeni chunk başlat
      chunks.push(currentChunk);
      currentChunk = msgText;
      currentTokens = msgTokens;
    } else {
      // Mevcut chunk'a ekle
      currentChunk += msgText;
      currentTokens += msgTokens;
    }
  }
  
  // Son chunk'ı ekle
  if(currentChunk) chunks.push(currentChunk);
  
  // Token sayısını güncelle
  const allText = chunks.join("");
  approxTokens = estimateTokensFromText(allText);
  
  console.log(`[ZT Smart Chunking] Created ${chunks.length} chunks, ~${approxTokens} tokens`);
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
  // Slim, tall, glassy default. Right-center docked.
  root.style.cssText="position:fixed;right:18px;top:50%;transform:translateY(-50%);width:300px;background:rgba(0,0,0,.72);backdrop-filter:saturate(160%) blur(10px);-webkit-backdrop-filter:saturate(160%) blur(10px);color:#e6ebff;border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 12px 44px rgba(0,0,0,.45);padding:12px;z-index:999998;font:13px/1.5 Inter,system-ui";
  root.style.zIndex = '2147483647';
  root.style.pointerEvents = 'auto';

  root.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
  <div class="zt-brand"><div class="zt-wordmark"></div></div>
  <div id="zt-token-fig" style="opacity:.75">0 tokens · 0%</div>
  <button id="zt-min-btn" title="Minimize" style="background:#1f2a44;border:0;color:#fff;width:24px;height:24px;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;margin-left:8px">–</button>
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

    <div id="zt-handoff-library" style="padding:10px;background:#0f1422;border:1px solid #1c2333;border-radius:10px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:600">📚 Your Handoffs</div>
        <button id="zt-library-toggle" style="background:none;border:none;color:#CFFF04;cursor:pointer;font-size:12px">▼</button>
      </div>
      <div id="zt-library-list" style="max-height:150px;overflow-y:auto;display:none">
        <div id="zt-library-empty" style="opacity:0.6;font-size:12px;text-align:center;padding:10px">No handoffs yet</div>
      </div>
      <div id="zt-cp-status" style="opacity:.7;font-size:11px;margin-top:5px">Auto-save: Checking…</div>
    </div>

    <button id="zt-handoff-btn"><span class="label">Generate Handoff</span></button>
    <!-- Continue button removed per user request -->
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

  // Shadow içine yerleştir ve temayı yükle
  mountIntoShadow(root);
  injectThemeCss();
  // Mini widget'i hazırla ve state'i uygula
  ensureMini();
  applyMinimizedState();

  // Event listener'ları Shadow içinden bağla
  const wrap = ztShadow?.getElementById('zt-wrap');
  wrap?.querySelector("#zt-login-btn")?.addEventListener('click', ()=>openAuthMiniModal("login"));
  wrap?.querySelector("#zt-reg-btn")?.addEventListener('click', ()=>openAuthMiniModal("register"));
  wrap?.querySelector("#zt-handoff-btn")?.addEventListener('click', onHandoffClick);
  wrap?.querySelector("#zt-min-btn")?.addEventListener('click', ()=>{ setMinimized(true); applyMinimizedState(); });
  
  // Handoff Library toggle
  wrap?.querySelector("#zt-library-toggle")?.addEventListener('click', ()=>{
    const list = wrap?.querySelector("#zt-library-list");
    const toggle = wrap?.querySelector("#zt-library-toggle");
    if(list && toggle) {
      if(list.style.display === "none") {
        list.style.display = "block";
        toggle.textContent = "▲";
        loadHandoffLibrary();
      } else {
        list.style.display = "none";
        toggle.textContent = "▼";
      }
    }
  });
  // Minimize butonunu panelin sağ üstüne, logo satırı hizasına al (layout'u bozmaz)
  try{
    const btn=wrap?.querySelector('#zt-min-btn');
    const panel=wrap?.querySelector('#zt-panel');
    if(panel && btn){
      if(getComputedStyle(panel).position==='static') panel.style.position='relative';
      Object.assign(btn.style,{position:'absolute', top:'10px', right:'10px', marginLeft:'0'});
    }
  }catch{}
  // Panel sürükleme
  try{ const panel=wrap?.querySelector('#zt-panel'); if(panel) makeDraggable(panel, ZT_POS_PANEL); }catch{}
}

function openAuthMiniModal(mode){
  let w=document.getElementById("zt-auth-modal"); if(w) w.remove();
  w=document.createElement("div"); w.id="zt-auth-modal";
  w.style.cssText="position:fixed;inset:0;background:#0008;z-index:100000;display:flex;align-items:center;justify-content:center;";
  const wm = chrome.runtime.getURL('assets/ZTblackbckgrn.png');
  w.innerHTML=`
    <div style="background:#0b0d12;color:#e6ebff;border:1px solid #1b2030;border-radius:16px;padding:18px;min-width:340px;box-shadow:0 20px 60px rgba(0,0,0,.5);font:13px/1.5 Inter,system-ui;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;position:relative">
        <span style="display:inline-block;height:20px;width:110px;background:url(${wm}) no-repeat left center / contain"></span>
        <span style="opacity:.8;font-weight:600">${mode==="login"?"Login":"Create account"}</span>
      </div>
      <input id="zt-auth-email" placeholder="email@example.com" style="width:100%;padding:10px;border-radius:10px;border:1px solid #263150;background:#0f1422;color:#fff;margin-bottom:8px"/>
      <input id="zt-auth-pass"  placeholder="password" type="password" style="width:100%;padding:10px;border-radius:10px;border:1px solid #263150;background:#0f1422;color:#fff;margin-bottom:12px"/>
      <div style="display:flex;gap:8px;justify-content:space-between;align-items:center">
        <button id="zt-auth-upgrade" style="background:#263150;border:0;color:#fff;padding:10px 12px;border-radius:12px;cursor:pointer;visibility:${mode==='login'?'hidden':'visible'}">Upgrade later</button>
        <div style="display:flex;gap:8px">
          <button id="zt-auth-cancel" style="background:#222;border:0;color:#fff;padding:10px 12px;border-radius:12px;cursor:pointer">Cancel</button>
          <button id="zt-auth-ok" style="background:#c1ff72;border:0;color:#000;padding:10px 14px;border-radius:12px;cursor:pointer;font-weight:800">${mode==="login"?"Login":"Create"}</button>
        </div>
      </div>
      <div style="text-align:center;margin-top:10px;opacity:.85;font-size:12px">
        <span class="zt-mini-wordmark" style="display:inline-block;height:14px;width:72px;vertical-align:middle;background:url(${wm}) no-repeat left center / contain;margin-right:6px"></span>
        ${mode==="login"?"Welcome back":"Create your account"} · <b>Free</b> plan includes <b>3 handoffs</b>. Upgrade anytime for unlimited.
      </div>
    </div>`;
  document.body.appendChild(w);
  w.querySelector("#zt-auth-cancel").onclick=()=>w.remove();
  w.querySelector("#zt-auth-ok").onclick=async()=>{
    const email=w.querySelector("#zt-auth-email").value.trim();
    const password=w.querySelector("#zt-auth-pass").value;

    // Supabase hazır mı? (maks. 2 sn bekle)
    async function waitForSupabase(ms = 2000) {
      const t0 = performance.now();
      while (!supabase && performance.now() - t0 < ms) {
        ensureSupabase();
        await new Promise(r => setTimeout(r, 100));
      }
      return !!supabase;
    }
    if (!(await waitForSupabase())) {
      alert("Connection not ready yet. Please try again in a moment.");
      return;
    }

    try{
      if(mode==="login"){
        const {error}=await supabase.auth.signInWithPassword({email,password});
        if(error) throw error;
      } else {
        const {error}=await supabase.auth.signUp({email,password});
        if(error) throw error;
      }
      await ensureUserProfileExists('free');
      await refreshSessionAndProfile(); updateAccountChip(); updateCheckpointStatusUI();
      toast(mode==="login"?"Logged in ✓":"Registered ✓ Check email if required"); w.remove();
    }catch(e){ alert(e?.message||String(e)); }
  };
}

function updateAccountChip(){
  const wrap = ztShadow?.getElementById('zt-wrap');
  const chip=wrap?.querySelector("#zt-account-chip");
  const actions=wrap?.querySelector("#zt-auth-actions");
  if(!chip||!actions) return;
  if(currentUser?.email){
    chip.textContent=currentUser.email;
    actions.innerHTML=`<button id="zt-logout-btn" style="background:#2a203a;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Logout</button>`;
    wrap.querySelector("#zt-logout-btn").onclick=async()=>{
      ensureSupabase();
      if(supabase) await supabase.auth.signOut().catch(()=>{});
      currentUser=null; userProfile=null; updateAccountChip(); updateCheckpointStatusUI(); loadHandoffLibrary(); toast("Logged out");
    };
    // Refresh per-user handoffs after login
    setTimeout(()=>{ loadHandoffLibrary(); }, 50);
  }else{
    chip.textContent="Guest mode";
    actions.innerHTML=`
      <button id="zt-login-btn" style="background:#1f2a44;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Login</button>
      <button id="zt-reg-btn"   style="background:#263150;border:0;color:#fff;padding:6px 8px;border-radius:8px;cursor:pointer">Register</button>`;
    wrap.querySelector("#zt-login-btn").onclick=()=>openAuthMiniModal("login");
    wrap.querySelector("#zt-reg-btn").onclick=()=>openAuthMiniModal("register");
  }
}

function updateDynamicUI(){
  const wrap = ztShadow?.getElementById('zt-wrap');
  const usedPct=Math.min(100,Math.round((approxTokens/TOKEN_LIMIT)*1000)/10);
  const fig=wrap?.querySelector("#zt-token-fig");
  const bar=wrap?.querySelector("#zt-bar");
  const hint=wrap?.querySelector("#zt-hint");
  if(fig) fig.textContent=`${(approxTokens||0).toLocaleString()} tokens · ${usedPct}%`;
  if(bar){ bar.style.width=`${usedPct}%`; bar.style.background=pctColor(usedPct); }
  const plan=(userProfile?.plan||"free").toLowerCase();
  if(hint){
    if(plan==="vault"){
      hint.textContent = "ZeroToken Pro active · unlimited handoffs";
    } else {
      const used = Number(userProfile?.handoff_used ?? getGlobalCount('ho') ?? 0);
      const remaining = Math.max(0, 3 - used);
      hint.textContent = `Free plan · ${remaining}/3 handoffs remaining — Upgrade for unlimited`;
    }
  }
}

async function updateCheckpointStatusUI(){
  const wrap = ztShadow?.getElementById('zt-wrap');
  const el=wrap?.querySelector("#zt-cp-status"); if(!el) return;
  if(!currentUser){ el.textContent=`Please login to use handoffs`; return; }
  const plan=(userProfile?.plan||"free").toLowerCase();
  if(plan==="vault"){ el.textContent = "Unlimited Handoffs · Pro Account"; return; }
  const used = Number(userProfile?.handoff_used ?? getGlobalCount('ho') ?? 0);
  el.textContent=`Used: ${Math.min(3,used)}/3`;
}

/* ───────────────── Quantum Enhancement Functions ───────────────── */
async function enhanceWithWowMoments(handoffText, jobId) {
  try {
    const wowMoments = computeWowMoments(handoffText);
    const existingModal = document.getElementById("zt-handoff-modal");
    if(existingModal){
      const holder = existingModal.querySelector('#zt-wow-holder');
      if(holder){
        if(wowMoments.length){
          const list = wowMoments.map(x=>`<li>${escapeHtml(String(x))}</li>`).join('');
          holder.innerHTML = `<h3 style=\"margin:18px 0 8px\">✨ WOW Moments</h3><ul style=\"margin:0 0 12px 16px\">${list}</ul>`;
        } else {
          if(holder.querySelector('[data-loading="1"]')){
            holder.innerHTML = '';
          }
        }
      }
    }
    // Persist (per-user)
    try {
      const key = getLibraryKey();
      const library = JSON.parse(localStorage.getItem(key) || '[]');
      const idx = library.findIndex(h => h.jobId === jobId);
      if(idx>=0){ library[idx].wowMoments = wowMoments; localStorage.setItem(key, JSON.stringify(library)); }
    } catch {}
  } catch(e) { console.log('[ZT] WOW enrichment silent'); }
}

/* ───────────────── Handoff Library (per-user) ───────────────── */
function getLibraryKey(){
  const uid = (currentUser?.id)||'anon';
  return `zt_handoff_library::${uid}`;
}

function saveHandoffToLibrary(handoff) {
  try {
    const key = getLibraryKey();
    const library = JSON.parse(localStorage.getItem(key) || '[]');
    const newItem = {
      type: 'handoff',
      id: Date.now().toString(),
      userId: currentUser?.id || 'anon',
      jobId: handoff.jobId,
      title: handoff.title,
      result: handoff.result,
      meta: handoff.meta,
      plan: handoff.plan,
      createdAt: new Date().toISOString(),
      threadId: getThreadId()
    };
    library.unshift(newItem);
    if(library.length > 200) library.length = 200; // reasonable cap
    localStorage.setItem(key, JSON.stringify(library));
    loadHandoffLibrary();
  } catch(e) {
    console.error('[ZT] Failed to save handoff to library:', e);
  }
}

// Helper function - moved up to be available for loadHandoffLibrary
function escapeHtml(s){ 
  return s?.replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))??""; 
}

function loadHandoffLibrary() {
  try {
    const wrap = ztShadow?.getElementById('zt-wrap');
    const list = wrap?.querySelector("#zt-library-list");
    if(!list) return;

    // Guest mode: do not show any handoffs
    if(!currentUser){
      list.innerHTML = '<div style="opacity:0.6;font-size:12px;text-align:center;padding:10px">Please login to view your handoffs</div>';
      return;
    }

    const key = getLibraryKey();

    async function tryFetchFromSupabase(){
      try{
        ensureSupabase(); if(!supabase) return null;
        const { data, error } = await supabase
          .from('jobs')
          .select('id,title,created_at,result,model,token_estimate,checkpoint_count')
          .eq('user_id', currentUser.id)
          .not('result','is', null)
          .order('created_at', { ascending: false })
          .limit(50);
        if(error) return null;
        const mapped = (data||[]).map(r=>({
          type:'handoff',
          id: r.id,
          userId: currentUser.id,
          jobId: r.id,
          title: r.title||'Handoff',
          result: r.result||'',
          meta: { createdAt: new Date(r.created_at).toLocaleString('en-GB',{hour12:false}), model: r.model||'Unknown', tokens: r.token_estimate||undefined, checkpoints: r.checkpoint_count||undefined },
          plan: (userProfile?.plan||'free').toLowerCase(),
          createdAt: r.created_at,
          threadId: getThreadId()
        }));
        // Cache for offline
        try{ localStorage.setItem(key, JSON.stringify(mapped)); }catch{}
        return mapped;
      }catch{ return null; }
    }

    (async ()=>{
      let library = await tryFetchFromSupabase();
      if(!library || !Array.isArray(library)){
        // Fallback to local per-user cache (may be empty)
        library = JSON.parse(localStorage.getItem(key) || '[]');
        // One-time migration from old global key
        try{
          const old = JSON.parse(localStorage.getItem('zt_handoff_library')||'[]');
          if((!Array.isArray(library) || library.length===0) && Array.isArray(old) && old.length){
            const uid = currentUser?.id || 'anon';
            const migrated = old.filter(it=> (it?.userId||'anon')===uid);
            if(migrated.length){
              localStorage.setItem(key, JSON.stringify(migrated));
              library = migrated;
            }
          }
        }catch{}
      }

      if(!Array.isArray(library) || library.length === 0) {
        list.innerHTML = '<div style="opacity:0.6;font-size:12px;text-align:center;padding:10px">No handoffs yet</div>';
        return;
      }

      list.innerHTML = library.map(item => `
        <div class="zt-library-item" data-id="${item.id}" style="padding:8px;border-bottom:1px solid #1c2333;cursor:pointer;transition:background 0.2s">
          <div style="font-weight:500;font-size:12px;margin-bottom:2px">${escapeHtml(item.title || 'Untitled')}</div>
          <div style="opacity:0.6;font-size:10px">${new Date(item.createdAt||Date.now()).toLocaleString()}</div>
        </div>
      `).join('');

      list.querySelectorAll('.zt-library-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = item.getAttribute('data-id');
          const handoff = library.find(h => String(h.id) === String(id));
          if(handoff) { openHandoffModal(handoff); }
        });
        item.addEventListener('mouseenter', () => { item.style.background = '#1a1f2e'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      });
    })();
  } catch(e) {
    console.error('[ZT] Failed to load handoff library:', e);
  }
}

/* ───────────────── Premium Modal ───────────────── */
function openHandoffModal({jobId,title,result,meta,plan}){
  // Save to library
  // Pre-compute WOW moments so they render immediately
  const wowMomentsInitial = computeWowMoments(result);
  saveHandoffToLibrary({jobId,title,result,meta,plan});
  let overlay=document.getElementById("zt-handoff-modal"); if(overlay) overlay.remove();
  overlay=document.createElement("div"); overlay.id="zt-handoff-modal";
  overlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:22px;";
  const modal=document.createElement("div"); modal.style.cssText="width:min(920px,92vw);max-height:86vh;overflow:auto;background:#0b0c10;color:#e8e8e8;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6);font:14px/1.6 Inter,system-ui;border:1px solid rgba(193,255,114,.22)";
  const header=document.createElement("div"); header.style.cssText="position:sticky;top:0;background:#0b0c10;border-bottom:1px solid rgba(193,255,114,.22);padding:14px 16px;display:flex;justify-content:space-between;gap:12px;align-items:center;";
  const ztLogoFull = chrome.runtime?.getURL ? chrome.runtime.getURL('assets/ZTblackbckgrn.png') : '';
  header.innerHTML=`
    <div style="display:flex;align-items:center;gap:10px">
      ${ztLogoFull?`<img src="${ztLogoFull}" alt="ZeroToken" style="height:18px;opacity:.95"/>`:''}
      <div>
        <div style="font-weight:700;font-size:16px">${escapeHtml(title||"Handoff Report")}</div>
        <div style="opacity:.75;font-size:12px">${meta?.createdAt??""} · ${meta?.model??""} · tokens: ${meta?.tokens??"–"} · checkpoints: ${meta?.checkpoints??"–"}</div>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button data-act="copy" class="zt-btn">Copy</button>
      <button data-act="pdf" class="zt-btn">PDF</button>
      <button data-act="email" class="zt-btn">E-mail</button>
      <button data-act="close" class="zt-btn" style="background:#252833">Close</button>
    </div>`;
  const content=document.createElement("div"); content.style.cssText="padding:18px 16px";
  const wowHolderId = 'zt-wow-holder';
  let wowSectionInitial = '';
  if(wowMomentsInitial?.length){
    wowSectionInitial = `<h3 style=\"margin:18px 0 8px\">✨ WOW Moments</h3><ul style=\"margin:0 0 12px 16px\">${wowMomentsInitial.map(x=>`<li>${escapeHtml(String(x))}</li>`).join('')}</ul>`;
  } else {
    wowSectionInitial = `<div style=\"opacity:.7;font-size:12px;margin-top:10px\" data-loading=\"1\">Detecting WOW moments…</div>`;
  }
  content.innerHTML=`<div class=\"zt-md\" id=\"zt-md\" data-result=\"true\">${escapeHtml(result).replace(/\n/g,"<br/>")}</div><div id=\"${wowHolderId}\" class=\"zt-wow-section\">${wowSectionInitial}</div>`;
  const footer=document.createElement("div"); footer.style.cssText="position:sticky;bottom:0;background:#0b0c10;border-top:1px solid rgba(193,255,114,.22);padding:12px 16px;";
  footer.innerHTML=(plan==="vault")
    ? `<div style="opacity:.8;font-size:12px">ZeroToken Pro · Unlimited Handoffs</div>`
    : `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
         <div style="font-size:13px;opacity:.9">First handoff is full <b>ZeroToken Pro</b> experience. Want unlimited?</div>
         <button data-act="upgrade" class="zt-btn" style="background:#c1ff72;color:#000">Upgrade to ZeroToken Pro</button>
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
  modal.querySelector('[data-act="copy"]').addEventListener("click", async ()=>{
    const r = window.__zt_last_handoff_text || result;
    try{ await navigator.clipboard.writeText(r); toast("Copied ✓"); }catch{ fallbackCopy(r); toast("Copied (fallback) ✓"); }
  });
  modal.querySelector('[data-act="pdf"]').addEventListener("click", ()=>{
    const w=window.open("","_blank"); if(!w){ toast("Popup blocked"); return; }
    const r = window.__zt_last_handoff_text || result;
    const html=`<html><head><title>${escapeHtml(title||"Handoff Report")}</title><style>
      body{font:14px/1.6 Inter,system-ui;margin:24px;color:#111} h2{margin:18px 0 6px;font-size:18px}
      pre{background:#f5f7fa;padding:12px;border-radius:8px;overflow:auto} code{background:#f5f7fa;padding:2px 6px;border-radius:4px}
    </style></head><body id="zt-printable">
      <h1 style="font:600 20px Inter;margin:0 0 8px">${escapeHtml(title||"Handoff Report")}</h1>
      <div style="opacity:.7;font-size:12px;margin-bottom:12px">${escapeHtml(meta?.createdAt??"")} · ${escapeHtml(meta?.model??"")} · tokens: ${escapeHtml(String(meta?.tokens??"–"))} · checkpoints: ${escapeHtml(String(meta?.checkpoints??"–"))}</div>
      ${escapeHtml(r).replace(/\n/g,"<br/>")}
    </body></html>`;
    w.document.write(html); w.document.close(); w.focus(); w.print();
  });
  modal.querySelector('[data-act="email"]').addEventListener("click", async ()=>{
    const to=prompt("Send to e-mail:"); if(!to) return;
    let accessToken=null; try{ ensureSupabase(); if(supabase){ const {data:{session}}=await supabase.auth.getSession(); accessToken=session?.access_token||null; } }catch{}
    if(!accessToken){ alert("Please login first to send by email."); return; }
    try{
      const r=await fetch(EMAIL_ENDPOINT,{ method:"POST", headers:{ "Content-Type":"application/json","Authorization":`Bearer ${accessToken}` }, body:JSON.stringify({jobId,to}) });
      if(!r.ok) throw new Error(await r.text()); toast("E-mail sent ✓");
    }catch(e){ console.error(e); toast("E-mail failed"); }
  });
  const upg=modal.querySelector('[data-act="upgrade"]'); if(upg) upg.addEventListener("click", ()=>{ window.open("https://zerotoken.ai/upgrade?plan=pro","_blank"); });
  function close(){ document.body.removeChild(overlay); }
  function fallbackCopy(text){ const ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  // escapeHtml function moved to line 875 to be available for loadHandoffLibrary
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
  // Assert user-initiated
  try{ (window as any).__zt_user_initiated = Date.now(); }catch{}
  if(uiBusy) return; uiBusy=true;
  // Require login before using handoff
  if(!currentUser){ uiBusy=false; openAuthMiniModal('login'); toast('Please login to generate a handoff'); return; }
  // Enforce quota for free plan (frontend, 3 handoffs)
  try{
    const plan = (userProfile?.plan||'free').toLowerCase();
    const used = Number(userProfile?.handoff_used||0);
    if(plan!=='vault' && used>=3){ uiBusy=false; showUpgradeModal(); return; }
  }catch{}
  const wrap = ztShadow?.getElementById('zt-wrap');
  const btn=wrap?.querySelector("#zt-handoff-btn");
  const progress=wrap?.querySelector("#zt-progress");
  const progBar=wrap?.querySelector("#zt-prog-bar");
  const progFig=wrap?.querySelector("#zt-prog-fig");
  const progLabel=wrap?.querySelector("#zt-prog-label");

  // UI: markup bozulmadan loading state
  if (btn) {
    btn.disabled = true;
    btn.classList.add('zt-loading');
    const labelEl = btn.querySelector('.zt-cta-label');
    if (labelEl) labelEl.textContent = "Generating…";
  }
  if (progress) progress.style.display="block"; if(progLabel) progLabel.textContent="Mapping…";

  // === SIMPLE WORKING PROGRESS SYSTEM ===
  const chatMessages = collectConversationChunks();
  const totalTokens = estimateTokensFromText((Array.isArray(chatMessages)?chatMessages.join("\n\n"):String(chatMessages||"")));
  
  // Show initial progress
  if (progBar) progBar.style.width = "5%";
  if (progFig) progFig.textContent = "5%";
  if (progLabel) progLabel.textContent = `Starting... (${totalTokens.toLocaleString()} tokens)`;
  
  // Simple progress tracking
  let lastProgress = 0;
  let stage = "queued";
  let currentStage = 1;
  
  const updateProgress = (serverProgress, serverStage, processedChunks, totalChunks) => {
    // Stage change detection
    if (serverStage && serverStage !== stage) {
      stage = serverStage;
      console.log(`[ZT] Stage change: ${stage}`);
      
      if (stage === "mapping") {
        currentStage = 1;
        if (progLabel) progLabel.textContent = "Mapping conversation...";
        if (progBar) progBar.style.background = "#ff66c4";
      } else if (stage === "reduce") {
        currentStage = 2;
        if (progLabel) progLabel.textContent = "Synthesizing insights...";
        if (progBar) progBar.style.background = "#99acff";
      } else if (stage === "final") {
        currentStage = 3;
        if (progLabel) progLabel.textContent = "Finalizing handoff...";
        if (progBar) progBar.style.background = "#c1ff72";
      }
    }
    
    // Simple progress calculation
    if (processedChunks !== undefined && totalChunks !== undefined && totalChunks > 0) {
      const chunkProgress = (processedChunks / totalChunks) * 100;
      
      // Map to visual progress
      let totalProgress = 0;
      if (currentStage === 1) {
        totalProgress = Math.min(40, chunkProgress * 0.4);
      } else if (currentStage === 2) {
        totalProgress = 40 + Math.min(45, chunkProgress * 0.45);
      } else if (currentStage === 3) {
        totalProgress = 85 + Math.min(14, chunkProgress * 0.14);
      }
      
      // Update UI if progress increased
      if (totalProgress > lastProgress) {
        lastProgress = totalProgress;
        if (progBar) progBar.style.width = `${totalProgress}%`;
        if (progFig) progFig.textContent = `${Math.round(totalProgress)}%`;
        
        console.log(`[ZT] Progress: Stage ${currentStage}, Chunks: ${processedChunks}/${totalChunks} (${chunkProgress.toFixed(1)}%), Visual: ${totalProgress.toFixed(1)}%`);
      }
    }
  };
  
  // === SIMPLE PROGRESS SYSTEM ===
  console.log(`[ZT] Starting with ${totalTokens.toLocaleString()} tokens`);
  
  // Simple time estimate
  const estimatedMinutes = Math.max(1, Math.ceil(totalTokens / 25000));
  console.log(`[ZT] Estimated time: ${estimatedMinutes}-${estimatedMinutes + 1} minutes`);
  
  // === SIMPLE HEARTBEAT SYSTEM ===
  let heartbeatTimer = null;
  let startTime = Date.now();
  
  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      
      if (progLabel && !progLabel.textContent.includes('Complete') && !progLabel.textContent.includes('Starting')) {
        progLabel.textContent = `Processing... (${minutes}m ${seconds}s elapsed)`;
      }
    }, 10000); // Update every 10 seconds
  };
  
  startHeartbeat();
  // Shadow capsule: flag'li ve otomatik ağır sohbet kaydı
  maybeSaveShadowCapsule(chatMessages).catch(()=>{});
  saveShadowCapsuleIfHeavy(chatMessages, totalTokens).catch(()=>{});
  
  try{
    console.log(`[ZT] Starting handoff generation...`);
    
    // Test API connectivity first
    console.log(`[ZT] Testing API connectivity...`);
    try {
      const testResponse = await fetch(`${SUPABASE_URL}/rest/v1/`, {
        headers: { "apikey": SUPABASE_ANON_KEY }
      });
      console.log(`[ZT] Supabase connection test: ${testResponse.status}`);
    } catch (connErr) {
      console.error(`[ZT] Connection test failed:`, connErr);
    }
    
    const okToHandoff=await canTakeHandoff();
    // Allow up to 3 handoffs for free users; fallback to global counter if RPC fails
    const planNow = (userProfile?.plan||"free").toLowerCase();
    const usedCount = Number(userProfile?.handoff_used??getGlobalCount('ho')??0);
    const quotaOk = (planNow==='vault') || (usedCount < 3);
    if(!(okToHandoff || quotaOk)){
      showUpgradeModal();
      return;
    }
    console.log(`[ZT] Handoff allowed: ${okToHandoff||quotaOk}`);

    console.log(`[ZT] Loading conversation history...`);
    await silentlyLoadAllHistory(6);
    const chunks=sanitizeChunks(collectConversationChunks());
    const title=document.title||"Untitled Thread";
    console.log(`[ZT] Collected ${chunks.length} chunks, title: "${title}"`);

    console.log(`[ZT] Sending request (prefer MRv2) ...`);
    
    // Update progress to show we're sending request
    if (progBar) progBar.style.width = "15%";
    if (progFig) progFig.textContent = "15%";
    if (progLabel) progLabel.textContent = "Sending request...";
    
    // Mevcut çalışan sistemi kullan
    let usedEndpoint = EDGE_START; 
    let startRes;
    // Respect cloud-save toggle (ephemeral mode hint only; server may ignore)
    let ephemeral = false; try{ const s=await chrome.storage?.sync?.get?.(['zt_cloud_save_recaps']); ephemeral = s && s.zt_cloud_save_recaps===false; }catch{}
    const basePayload = { 
      userId: currentUser?.id || null, 
      plan: (userProfile?.plan || "free").toLowerCase(), 
      title, 
      threadId: getThreadId(), 
      chunks,
      meta: { ts: Date.now(), cause: "manual", ephemeral }
    };
    const payload = basePayload;
    try{
      startRes = await fetch(usedEndpoint,{ method:"POST", headers:{ "Content-Type":"application/json","Authorization":`Bearer ${SUPABASE_ANON_KEY}`,"apikey":SUPABASE_ANON_KEY }, body:JSON.stringify(payload) });
      if(!startRes.ok){
        const errTxt = await startRes.text().catch(()=>"");
        // If flawless fails, fallback to old system
        if (startRes.status === 404) {
          console.warn("[ZT] Flawless handoff not available, falling back to continuity_v1");
          usedEndpoint = EDGE_START;
          startRes = await fetch(EDGE_START,{ 
            method:"POST", 
            headers:{ "Content-Type":"application/json","Authorization":`Bearer ${SUPABASE_ANON_KEY}`,"apikey":SUPABASE_ANON_KEY }, 
            body:JSON.stringify(basePayload) 
          });
          if(!startRes.ok) {
            throw new Error(`Fallback also failed ${startRes.status}: ${await startRes.text()}`);
          }
        } else {
          throw new Error(`Handoff error ${startRes.status}: ${errTxt}`);
        }
      }
    }catch(e){
      // If any error, try fallback to old system
      console.error("[ZT] Primary handoff failed:", e);
      try {
        usedEndpoint = EDGE_START;
        startRes = await fetch(EDGE_START,{ 
          method:"POST", 
          headers:{ "Content-Type":"application/json","Authorization":`Bearer ${SUPABASE_ANON_KEY}`,"apikey":SUPABASE_ANON_KEY }, 
          body:JSON.stringify(basePayload) 
        });
        if(!startRes.ok){ 
          const errorText = await startRes.text(); 
          throw new Error(`Fallback also failed ${startRes.status}: ${errorText}`); 
        }
      } catch(fallbackErr) {
        throw new Error(`All handoff methods failed: ${fallbackErr.message}`);
      }
    }
    const responseData = await startRes.json();
    console.log(`[ZT] API response:`, responseData);
    
    const { job_id, meta } = responseData;
    console.log(`[ZT] Received job_id: ${job_id}`);
    if (meta?.zt_rev) console.log(`[ZT] Server revision: ${meta.zt_rev}`);
    if (typeof meta?.primer_coverage !== 'undefined') console.log(`[ZT] primer_coverage=`, meta.primer_coverage);
    if (typeof meta?.saliency_selected !== 'undefined') console.log(`[ZT] saliency=`, meta.saliency_selected, '/', meta.saliency_total);
    if (typeof meta?.continuity_tokens_est !== 'undefined') console.log(`[ZT] continuity_tokens_est=`, meta.continuity_tokens_est, 'trimmed=', meta.continuity_trimmed);
    if (typeof meta?.elapsed_ms !== 'undefined') console.log(`[ZT] FAST60 elapsed=${meta.elapsed_ms}ms tokens=${meta.tokens_in}→${meta.tokens_used} perf_violation=${meta.perf_violation}`);
    if (!job_id) {
      throw new Error("No job_id received from API");
    }

    // === LOG REAL TOKEN COUNT ===
    const actualTokens = meta?.token_estimate || totalTokens;
    console.log(`[ZT] Job started: ${actualTokens} tokens, estimated ${estimatedMinutes}-${estimatedMinutes + 1} minutes`);
    updateExactTokenMeter(responseData?.meta||{});
    
    // Update progress to show job started
    if (progBar) progBar.style.width = "25%";
    if (progFig) progFig.textContent = "25%";
    if (progLabel) progLabel.textContent = `Job started via ${usedEndpoint.includes('map_reduce_v2')?'MRv2':'legacy'}; polling...`;
    
    // Start progress animation
    console.log(`[ZT] Progress: 25% - Job started successfully`);

    await new Promise((resolve,reject)=>{
      // Realistic timeout based on token count (43k tokens = ~3 minutes max)
      const maxTimeout = Math.max(300000, Math.ceil(totalTokens / 15000) * 60000); // 15k tokens per minute
      const safetyTimer=setTimeout(()=>{ 
        try{ if(progress) progress.style.display="none"; }catch{} 
        reject(new Error(`Handoff timeout after ${Math.round(maxTimeout/60000)} minutes. Please try again.`)); 
      }, maxTimeout);

      const tick=async()=>{
        try{
          console.log(`[ZT] Polling status for job ${job_id}...`);
          // Forward user access token if logged in; server will fall back to service role
          let accessToken=null; 
          try{ ensureSupabase(); const s=await supabase?.auth?.getSession?.(); accessToken=s?.data?.session?.access_token||null; }catch{}
          const r=await fetch(`${EDGE_STATUS}?job=${job_id}&t=${Date.now()}`,{ 
            headers:{ 
              "Authorization":`Bearer ${accessToken||SUPABASE_ANON_KEY}`,
              "apikey":SUPABASE_ANON_KEY
            }
          });
          
          if(!r || !r.ok) {
            const errorText = r ? await r.text() : "Network error";
            const statusCode = r ? r.status : 0;
            console.error(`[ZT] Status API error ${statusCode}: ${errorText}`);
            console.error(`[ZT] Status polling error:`, errorText);
            throw new Error(`Status API error ${statusCode}: ${errorText}`);
          }
          
          const st=await r.json();
          console.log(`[ZT] Status response:`, st);

          // === REAL-TIME PROGRESS UPDATES ===
          if(st.stage && st.stage!==stage){
            stage=st.stage;
            console.log(`[ZT] Stage change: ${stage}`);
          }

          // Update progress based on server data
          const processedChunks = st.processed_chunks;
          const totalChunks = st.total_chunks;
          const serverPercent = st.percent || 0;
          
          console.log(`[ZT] Status update:`, { processedChunks, totalChunks, serverPercent, stage });
          
          if (processedChunks !== undefined && totalChunks !== undefined) {
            updateProgress(serverPercent, stage, processedChunks, totalChunks);
          } else if (serverPercent > 0) {
            // Fallback to server percent if no chunk data
            const fallbackProgress = Math.min(99, serverPercent);
            if (progBar) progBar.style.width = `${fallbackProgress}%`;
            if (progFig) progFig.textContent = `${Math.round(fallbackProgress)}%`;
            console.log(`[ZT] Fallback progress: ${fallbackProgress}%`);
          }

          const finished=(st.status==="done") || (st.has_result===true) || (!!st.result && st.result.length>0);
          if(finished){
            clearTimeout(safetyTimer);
            if(heartbeatTimer) clearInterval(heartbeatTimer);
            
            // Complete the progress bar
            if(progBar) progBar.style.width = "100%";
            if(progFig) progFig.textContent = "100%";
            if(progLabel) progLabel.textContent = "Complete!";
            
            (async ()=>{
              const bar=ztShadow?.getElementById('zt-wrap')?.querySelector("#zt-prog-bar"); if(bar) bar.style.background="#25c277";
              // Non-blocking finalization: open immediately, upgrade content in background
              let fullResult = st?.result || '';
              function updateModalContent(text){
                const existingModal = document.getElementById("zt-handoff-modal");
                if(!existingModal) return;
                const resultArea = existingModal.querySelector('[data-result="true"]');
                if(!resultArea) return;
                const escaped = String(text||"").replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
                resultArea.innerHTML = escaped.replace(/\n/g,"<br/>");
              }
              try{ window.__zt_last_handoff_text = fullResult; }catch{}
              openHandoffModal({
                jobId:job_id, title, result: fullResult || "(loading...)",
                meta:{ createdAt:new Date().toLocaleString("en-GB",{hour12:false}), model:meta?.model||"Unknown", tokens:(meta?.token_estimate ?? totalTokens), checkpoints:(meta?.checkpoint_count ?? 0) },
                plan:(userProfile?.plan||"free")
              });
              (async ()=>{
                // Try handoff_result with timeout; then brief DB poll as best-effort
                try{
                  ensureSupabase();
                  const invokePromise = (async ()=>{
                    if(supabase?.functions){
                      const { data, error } = await supabase.functions.invoke('handoff_result', { body: { job: job_id } });
                      if(error) throw new Error(error.message||'invoke failed');
                      return data?.result||'';
                    } else {
                      const r = await fetch(`${SUPABASE_URL}/functions/v1/handoff_result`, { method:'POST', headers:{ "Content-Type":"application/json","Authorization":`Bearer ${SUPABASE_ANON_KEY}`, "apikey": SUPABASE_ANON_KEY }, body: JSON.stringify({ job: job_id }) });
                      if(!r.ok) throw new Error(`handoff_result ${r.status}`);
                      const j = await r.json();
                      return j?.result||'';
                    }
                  })();
                  const timeout = new Promise((_,rej)=> setTimeout(()=>rej(new Error('invoke timeout')), 8000));
                  const best = await Promise.race([invokePromise, timeout]).catch(()=>"");
                  if(best && String(best).length > fullResult.length){ fullResult = String(best); updateModalContent(fullResult); try{ window.__zt_last_handoff_text = fullResult; }catch{} }
                }catch{}
                try{
                  ensureSupabase(); if(!supabase) return;
                  for(let i=0;i<3;i++){
                    const { data, error } = await supabase.from('jobs').select('result,stage').eq('id', job_id).single();
                    if(!error && data?.result){
                      const txt = String(data.result||'');
                      if(txt.length > fullResult.length){ fullResult = txt; updateModalContent(fullResult); try{ window.__zt_last_handoff_text = fullResult; }catch{} }
                      if(data.stage==="final") break;
                    }
                    await new Promise(r=> setTimeout(r, 120));
                  }
                  if(fullResult && fullResult.length>100) enhanceWithWowMoments(fullResult, job_id);
                }catch{}
              })();
            })();
            
            resolve(true); return;
          }
          setTimeout(tick,450);
        }catch(err){
          console.error(`[ZT] Status polling error:`, err);
          setTimeout(tick,700); 
        }
      };
      tick();
    });

    await markHandoff();
    // Bump global counter for UI accuracy (free only)
    try{ if(planNow!=='vault'){ bumpGlobalCount('ho'); } }catch{}

  }catch(e){
    alert("Handoff failed: "+(e?.message||e));
  }finally{
    if(heartbeatTimer) clearInterval(heartbeatTimer);
    
    const wrap = ztShadow?.getElementById('zt-wrap');
    const progress=wrap?.querySelector("#zt-progress");
    const btn=wrap?.querySelector("#zt-handoff-btn");
    if(btn){
      btn.disabled=false;
      btn.classList.remove('zt-loading');
      const lbl = btn.querySelector('.zt-cta-label');
      if (lbl) lbl.textContent = "Generate Handoff";
    }
    uiBusy=false; updateCheckpointStatusUI();
    setTimeout(()=>{ if(progress) progress.style.display="none"; },1200);
  }
}

/* ───────────────── Performance Analytics ───────────────── */

// F) REAL BENCH GATE (prove ≤60s @ ≤200k)
window.__zt_bench200k = async function(strict = false) {
  try {
    console.log('[ZT] Starting 200k token benchmark...');
    
    // Collect current conversation
    await silentlyLoadAllHistory(6);
    const baseChunks = sanitizeChunks(collectConversationChunks());
    const title = document.title || "200k Benchmark Test";
    
    // Duplicate chunks to reach ~200k tokens
    const targetTokens = 200000;
    let benchChunks = [...baseChunks];
    let currentTokens = Math.ceil(benchChunks.join('').length / 4);
    
    while (currentTokens < targetTokens && benchChunks.length < 500) {
      benchChunks.push(...baseChunks.slice(0, Math.min(20, baseChunks.length)));
      currentTokens = Math.ceil(benchChunks.join('').length / 4);
    }
    
    console.log(`[ZT] Benchmark: ${benchChunks.length} chunks, ~${currentTokens} tokens`);
    
    const startTime = Date.now();
    const res = await fetch(EDGE_START, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "apikey": SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        userId: currentUser?.id || null,
        plan: (userProfile?.plan || "free").toLowerCase(),
        title,
        threadId: `bench200k-${Date.now()}`,
        chunks: benchChunks,
        rev: "fast60_hotfix4_1"
      })
    });
    
    const elapsed = Date.now() - startTime;
    const json = await res.json();
    
    if (!json.ok) {
      console.error('[ZT] Benchmark failed:', json);
      return;
    }
    
    const meta = json.meta || {};
    const perfViolation = (meta.elapsed_ms || elapsed) > 60000;
    const tokensLow = (meta.tokens_in || currentTokens) < 150000;
    const scoreLow = (meta.continuity_score || 0) < 0.90;
    const strictFail = strict && (tokensLow || perfViolation || scoreLow);
    
    console.log(`[ZT] 200k BENCHMARK RESULTS (strict=${strict}):`);
    console.log(`   elapsed_ms: ${meta.elapsed_ms || elapsed} (SLA: ≤60000)`);
    console.log(`   tokens_in: ${meta.tokens_in || currentTokens}`);
    console.log(`   recap_tokens: ${meta.recap_tokens || 0}`);
    console.log(`   primer_coverage: ${meta.primer_coverage || 0}`);
    console.log(`   action_validity: ${meta.action_validity || 0}`);
    console.log(`   evidence_density: ${meta.evidence_density || 0}`);
    console.log(`   continuity_score: ${meta.continuity_score || 0}`);
    console.log(`   anchor_kept: ${meta.anchor_kept || 0}`);
    console.log(`   selected_chunks: ${meta.selected_chunks || 0}`);
    console.log(`   quoted_bullets: ${meta.quoted_bullets || 0}`);
    console.log(`   trimmed: ${meta.trimmed || false}`);
    console.log(`   perf_path: ${meta.perf_path || 'unknown'}`);
    console.log(`   perf_violation: ${perfViolation}`);
    console.log(`   strict_fail: ${strictFail}`);
    
    if (strictFail) {
      const reasons = [];
      if (tokensLow) reasons.push('tokens_in<150k');
      if (perfViolation) reasons.push('elapsed>60s');
      if (scoreLow) reasons.push('score<0.9');
      
      const toast = document.createElement('div');
      toast.textContent = `Benchmark FAILED: ${reasons.join(', ')}`;
      toast.style.cssText = 'position:fixed;top:20px;right:20px;background:#ff4444;color:white;padding:8px 16px;border-radius:8px;z-index:999999';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 8000);
    } else if (strict) {
      const toast = document.createElement('div');
      toast.textContent = 'Strict benchmark PASSED ✓';
      toast.style.cssText = 'position:fixed;top:20px;right:20px;background:#25c277;color:white;padding:8px 16px;border-radius:8px;z-index:999999';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
    
    return meta;
  } catch (e) {
    console.error('[ZT] Benchmark error:', e);
    return null;
  }
};

// Injection validation function for hotfix3
window.__zt_validate_injection = function(injection) {
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
};

// Helper for manual QA
window.__zt_printLast = () => console.log(window.__zt_last_gpt_template || '(no template)');

// Calculate performance metrics based on token volume and historical data
function calculatePerformanceMetrics(tokenCount, messageCount) {
  // Base performance metrics (adjust these based on your actual logs)
  const baseMetrics = {
    tokensPerSecond: 150,        // Average processing speed
    mappingRatio: 0.4,           // 40% of time spent on mapping
    synthesisRatio: 0.4,         // 40% of time spent on synthesis  
    deliveryRatio: 0.2,          // 20% of time spent on delivery
    minProcessingTime: 30000,    // Minimum 30 seconds
    maxProcessingTime: 300000    // Maximum 5 minutes
  };
  
  // Adjust based on token volume (larger conversations take proportionally longer)
  const volumeMultiplier = Math.max(0.5, Math.min(2.0, tokenCount / 10000));
  
  // Calculate estimated total time
  const estimatedTime = Math.max(
    baseMetrics.minProcessingTime,
    Math.min(
      baseMetrics.maxProcessingTime,
      (tokenCount / baseMetrics.tokensPerSecond) * 1000 * volumeMultiplier
    )
  );
  
  // Distribute time across stages
  return {
    totalTime: estimatedTime,
    stage1Time: estimatedTime * baseMetrics.mappingRatio,      // Mapping
    stage2Time: estimatedTime * baseMetrics.synthesisRatio,    // Synthesizing
    stage3Time: estimatedTime * baseMetrics.deliveryRatio,     // Delivering
    tokensPerSecond: baseMetrics.tokensPerSecond * volumeMultiplier
  };
}

/* ───────────────── Auto-checkpoint ───────────────── */
async function maybeAutoCheckpoint(){
  const delta=approxTokens-lastSavedTokens, threshold=3000;
  if(delta>=threshold){
    const ok=await canTakeCheckpoint();
    if(!ok && (userProfile?.plan||"free")!=="vault"){ lastSavedTokens=approxTokens; return; }
    await markCheckpoint(); lastSavedTokens=approxTokens;
    const wrap = ztShadow?.getElementById('zt-wrap');
    const ago=wrap?.querySelector("#zt-saved-ago"); if(ago) ago.textContent="just now";
    updateCheckpointStatusUI(); toast("Auto-checkpoint saved ✓");
  }
}

/* ───────────────── Main ───────────────── */
(function(){ (async()=>{
  ensureSupabase();
  await refreshSessionAndProfile(); renderOnce(); updateAccountChip();
  collectConversationChunks(); updateDynamicUI(); updateCheckpointStatusUI();
  setInterval(()=>{
    ensureSupabase();
    ensurePanelVisible();        // Shadow içinde paneli canlı tut
    collectConversationChunks(); updateDynamicUI(); updateCheckpointStatusUI();
    updateMiniUI();
    maybeAutoCheckpoint().catch(()=>{});
  },1500);
})(); })();

// === ZeroToken: tag CTA & Logout for stable theming ===
(function tagZtElements(){
  const HOST_ID='zt-host';
  function getShadow(){ return document.getElementById(HOST_ID)?.shadowRoot || null; }
  function tag(){
    const sh = getShadow(); if(!sh) return;
    // CTA: metninde "Generate Handoff" geçen buton
    const btns = Array.from(sh.querySelectorAll('button'));
    const cta  = btns.find(b => /generate\s+handoff/i.test(b.textContent || ''));
    if(cta) cta.setAttribute('data-zt','cta');

    // Logout
    const logout = btns.find(b => /logout/i.test(b.textContent || ''));
    if(logout) logout.setAttribute('data-action','logout');
  }
  const obs = new MutationObserver(tag);
  const sh0 = getShadow();
  if(sh0) obs.observe(sh0, {subtree:true, childList:true});
  tag();
})();

// === ZeroToken: Stable tagging for CTA & Logout (visual theming) ===
(function(){
  // === Chrome Web Store compliance flag (safe default: false). Set true to enable banner/options wiring ===
  const ZTCWS_COMPLIANCE = true;

  // Helper: read/write chrome.storage.sync safely
  const syncGet = (keys)=> new Promise(res=>{
    try{ chrome.storage?.sync?.get?.(keys,(v)=>res(v||{})); }catch{ res({}); }
  });
  const syncSet = (obj)=> new Promise(res=>{ try{ chrome.storage?.sync?.set?.(obj,()=>res(true)); }catch{ res(false);} });

  // First-run consent banner (non-blocking, appears once)
  async function maybeShowConsentBanner(){
    if(!ZTCWS_COMPLIANCE) return;
    const { zt_consent_v1 } = await syncGet(['zt_consent_v1']);
    if(zt_consent_v1===true) return;
    const banner = document.createElement('div');
    banner.id = 'zt-consent-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0b0c10;color:#e6ebff;border-bottom:1px solid rgba(193,255,114,.22);font:13px/1.45 Inter,system-ui;display:flex;gap:10px;align-items:center;justify-content:center;padding:8px 12px';
    banner.innerHTML = `ZeroToken saves your handoff recaps to your account so you can reopen them later. You can turn this off anytime in Settings. <button id="zt-ok" style="background:#c1ff72;color:#000;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:700">OK</button> <a id="zt-privacy" href="#" style="color:#99acff;text-decoration:underline">Privacy</a>`;
    document.documentElement.appendChild(banner);
    banner.querySelector('#zt-ok').addEventListener('click', async ()=>{
      await syncSet({ zt_consent_v1:true, zt_cloud_save_recaps:true });
      banner.remove();
    });
    banner.querySelector('#zt-privacy').addEventListener('click',(e)=>{ e.preventDefault(); window.open('https://zerotoken.ai/privacy','_blank'); });
  }

  // Kick off consent banner without blocking other init
  try{ if(document.readyState!=='loading') { maybeShowConsentBanner(); } else { document.addEventListener('DOMContentLoaded', maybeShowConsentBanner, { once: true }); } }catch{}
  const HOST_ID='zt-host';
  function sh(){ return document.getElementById(HOST_ID)?.shadowRoot || null; }

  function tagOnce(){
    const root = sh(); if(!root) return;

    const all = Array.from(root.querySelectorAll('button, [role="button"]'));
    // CTA
    const cta = all.find(el => /generate\s+handoff/i.test(el.textContent || ''));
    if (cta && !cta.hasAttribute('data-zt')) cta.setAttribute('data-zt','cta');

    // Logout
    const lo = all.find(el => /logout/i.test(el.textContent || ''));
    if (lo && !lo.hasAttribute('data-action')) lo.setAttribute('data-action','logout');
  }

  // İlk etiketleme
  tagOnce();

  // Render değişimlerinde tekrar dener
  const mo = new MutationObserver(() => { try{ tagOnce(); }catch{} });
  const root0 = sh();
  if (root0) mo.observe(root0, { subtree:true, childList:true });
})();

// === ZeroToken: post-render sanitizer (Shadow DOM) ===
(function(){
  const HOST = 'zt-host';
  function sh(){ return document.getElementById(HOST)?.shadowRoot || null; }

  function killUnwantedBranding(root){
    if(!root) return;
    // 1) ZeroTokenTrans.png -> img + inline background KILL
    root.querySelectorAll('img[src*="ZeroTokenTrans.png"]').forEach(img => img.remove());
    root.querySelectorAll('[style*="ZeroTokenTrans.png"]').forEach(el => {
      el.style.background = 'none';
      el.style.backgroundImage = 'none';
    });
  }

  function tagControls(root){
    if(!root) return;
    const btns = Array.from(root.querySelectorAll('button, [role="button"]'));
    // CTA
    const cta = btns.find(b => /generate\s+handoff/i.test(b.textContent || ''));
    if (cta) cta.setAttribute('data-zt','cta');
    // Logout
    const lo  = btns.find(b => /logout/i.test(b.textContent || ''));
    if (lo)  lo.setAttribute('data-action','logout');
  }

  function applyCTAVisual(root){
    const cta = root?.querySelector('button[data-zt="cta"]');
    if(!cta) return;
    // İçerik gizle
    Array.from(cta.children).forEach(ch => ch.style.visibility = 'hidden');
    // Lime zemin + ölçüler
    Object.assign(cta.style, {
      position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', minHeight:'46px', padding:'12px 16px 12px 52px',
      borderRadius:'16px', border:'1px solid rgba(255,255,255,.10)',
      background:'#c1ff72', color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px',
      boxShadow:'0 6px 20px rgba(193,255,114,.28)', overflow:'hidden'
    });
    // Pseudo yerine gerçek overlay (::after cross-origin sorunlarını by-pass)
    let ov = cta.querySelector('.zt-cta-text');
    if(!ov){
      ov = document.createElement('span');
      ov.className = 'zt-cta-text';
      cta.appendChild(ov);
    }
    Object.assign(ov.style, {
      position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
      color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px', lineHeight:'1',
      pointerEvents:'none', visibility:'visible'
    });
    ov.textContent = 'Generate Handoff';

    let icon = cta.querySelector('.zt-cta-icon--disabled--disabled');
    if(!icon){
      icon = document.createElement('span');
      icon.className = 'zt-cta-icon--disabled--disabled';
      cta.appendChild(icon);
    }
    Object.assign(icon.style, {
      position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)',
      width:'0px', height:'0px', backgroundSize:'contain', backgroundRepeat:'no-repeat',
      backgroundImage:"none",
      pointerEvents:'none', visibility:'visible'
    });
  }

  function fixLogout(root){
    const lo = root?.querySelector('button[data-action="logout"]');
    if(!lo) return;
    Object.assign(lo.style, {
      background:'#1e1e1e', color:'#eaeef7',
      border:'1px solid rgba(255,255,255,.1)', borderRadius:'12px',
      padding:'8px 14px', fontWeight:'700'
    });
  }

  function pinSmallWordmark(){
    const panel = sh()?.getElementById?.('zt-panel');
    if(!panel) return;
    panel.style.position = 'relative';
    // Tek seferlik küçük wordmark (ZTblackbckgrn.png)
    if(!panel.querySelector('.zt-wordmark-fixed')){
      const wm = document.createElement('div');
      wm.className = 'zt-wordmark-fixed';
      Object.assign(wm.style, {
        position:'absolute', top:'6px', left:'12px', width:'auto', height:'40px',
        backgroundImage:`url(${chrome.runtime.getURL('assets/ZTblackbckgrn.png')})`,
        backgroundRepeat:'no-repeat', backgroundPosition:'left center', backgroundSize:'contain',
        pointerEvents:'none', filter:'drop-shadow(0 2px 6px rgba(0,0,0,.25))'
      });
      panel.appendChild(wm);
      // panel üst boşluğu
      const padTop = parseInt(getComputedStyle(panel).paddingTop||'0',10);
      if(padTop < 40) panel.style.paddingTop = '40px';
    }
  }

  function run(){
    const root = sh(); if(!root) return;
    killUnwantedBranding(root);
    tagControls(root);
    applyCTAVisual(root);
    fixLogout(root);
    pinSmallWordmark();
  }

  // İlk çalıştır
  run();
  // Reflow'larda tekrar uygula
  const root0 = sh();
  if(root0){
    const mo = new MutationObserver(()=>{ try{ run(); }catch(e){} });
    mo.observe(root0, {subtree:true, childList:true, attributes:true, attributeFilter:['style','class']});
  }
})();

// === ZeroToken: hard sanitizer (kill hero, force CTA) ===
(function(){
  const HOST='zt-host';
  const R_HERO = /(ZeroTokenTrans\.png|ZTblackbckgrn\.png)/i; // dev görsel hangi isimle gelirse gelsin
  function sh(){ return document.getElementById(HOST)?.shadowRoot || null; }

  function killHero(root){
    if(!root) return;
    // 1) Background-image ile gelenler
    root.querySelectorAll('[style*="background"]').forEach(el=>{
      const s = (el.getAttribute('style')||'').toLowerCase();
      if (R_HERO.test(s)) {
        el.style.background = 'none';
        el.style.backgroundImage = 'none';
      }
    });
    // 2) <img> ile gelenler
    root.querySelectorAll('img').forEach(img=>{
      const src=(img.getAttribute('src')||'').toLowerCase();
      if (R_HERO.test(src)) img.remove();
    });
    // 3) Progress bar'ın ÜSTÜNDE kalan "büyük yüksekliğe" sahip görsel blokları süpür
    const pb = root.querySelector('[role="progressbar"]');
    if(pb){
      // Kapsayıcıyı bul (panel)
      const panel = root.getElementById('zt-panel') || pb.closest('#zt-panel') || root;
      // progress bar'dan önceki node'larda 80px'ten büyük backgrounlu alanları sıfırla
      let n = pb.previousElementSibling;
      while(n){
        const cs = getComputedStyle(n);
        if ((parseInt(cs.height)||0) > 80 && /url\(/.test(cs.backgroundImage)) {
          n.style.background = 'none';
          n.style.backgroundImage = 'none';
        }
        n = n.previousElementSibling;
      }
      // Küçük wordmark'ı sabitle
      if (panel && !panel.querySelector('.zt-wordmark-fixed')) {
        const wm = document.createElement('div');
        wm.className='zt-wordmark-fixed';
        Object.assign(wm.style,{
          position:'absolute', top:'6px', left:'12px', width:'auto', height:'40px',
          backgroundImage:`url(${chrome.runtime.getURL('assets/ZTblackbckgrn.png')})`,
          backgroundRepeat:'no-repeat', backgroundPosition:'left center', backgroundSize:'contain',
          pointerEvents:'none', filter:'drop-shadow(0 2px 6px rgba(0,0,0,.25))'
        });
        panel.style.position='relative';
        const padTop=parseInt(getComputedStyle(panel).paddingTop||'0',10);
        if(padTop<40) panel.style.paddingTop='40px';
        panel.appendChild(wm);
      }
    }
  }

  function tagAndForceButtons(root){
    if(!root) return;
    const btns=[...root.querySelectorAll('button, [role="button"]')];

    // CTA tespiti: "Generate Handoff" metni veya ⚡ emojisi
    const CTA_RX = /(generate\s*handoff|handoff oluştur)/i;
    const cta = btns.find(b=> CTA_RX.test(b.textContent||'') || /⚡/.test(b.innerHTML||''));
    if (cta){
      cta.setAttribute('data-zt','cta');
      // içerikleri gizle
      [...cta.children].forEach(ch=> ch.style.visibility='hidden');
      // lime stile zorla (inline => override edilemez)
      Object.assign(cta.style,{
        position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', minHeight:'46px', padding:'12px 16px 12px 52px',
        borderRadius:'16px', border:'1px solid rgba(255,255,255,.10)',
        background:'#c1ff72', color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px',
        boxShadow:'0 6px 20px rgba(193,255,114,.28)', overflow:'hidden'
      });
      // metin overlay
      let text = cta.querySelector('.zt-cta-text');
      if(!text){ text=document.createElement('span'); text.className='zt-cta-text'; cta.appendChild(text); }
      Object.assign(text.style,{
        position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
        color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px', lineHeight:'1',
        pointerEvents:'none', visibility:'visible'
      });
      text.textContent='Generate Handoff';
      // ikon
      let icon = cta.querySelector('.zt-cta-icon--disabled--disabled');
      if(!icon){ icon=document.createElement('span'); icon.className='zt-cta-icon--disabled--disabled'; cta.appendChild(icon); }
      Object.assign(icon.style,{
        position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)',
        width:'0px', height:'0px',
        backgroundImage:"none",
        backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain',
        pointerEvents:'none', visibility:'visible'
      });
      cta.onmouseenter=()=>{ cta.style.background='#a6ff3b'; cta.style.transform='translateY(-1px)'; };
      cta.onmouseleave=()=>{ cta.style.background='#c1ff72'; cta.style.transform='none'; };
    }

    // Logout'u ayır
    const lo = btns.find(b=> /logout/i.test(b.textContent||''));
    if (lo){
      lo.setAttribute('data-action','logout');
      Object.assign(lo.style,{
        background:'#1e1e1e', color:'#eaeef7',
        border:'1px solid rgba(255,255,255,.1)', borderRadius:'12px',
        padding:'8px 14px', fontWeight:'700'
      });
    }
  }

  function run(){
    const root=sh(); if(!root) return;
    killHero(root);
    tagAndForceButtons(root);
  }

  run();
  const r=sh();
  if(r){
    const mo=new MutationObserver(()=>{ try{ run(); }catch{} });
    mo.observe(r,{subtree:true, childList:true, attributes:true, attributeFilter:['style','class']});
  }
})();

// ===== ZeroToken: final hard sanitizer (kill hero + force CTA) =====
(function(){
  const HOST='zt-host';
  const HERO_RX = /(ZeroTokenTrans\.png|ZTblackbckgrn\.png)/i;

  function sh(){ return document.getElementById(HOST)?.shadowRoot || null; }

  function killHeroAndTidy(root){
    const pb = root.querySelector('[role="progressbar"]');
    if(!pb) return;
    let cur = pb.previousElementSibling;
    while(cur){
      const cs = getComputedStyle(cur);
      const bg = cs.backgroundImage||'';
      const h  = parseInt(cs.height)||0;
      const looksHero = h>80 || HERO_RX.test(bg);
      if(looksHero){
        cur.style.background = 'none';
        cur.style.backgroundImage = 'none';
        cur.querySelectorAll('img').forEach(i=>i.remove());
        cur.style.minHeight='0'; cur.style.height='0';
        cur.style.padding='0'; cur.style.margin='0 0 8px 0';
        cur.style.overflow='hidden';
      }
      cur = cur.previousElementSibling;
    }
    // wordmark (küçük) sabitle
    const panel = root.getElementById('zt-panel') || root;
    if (panel && !panel.querySelector('.zt-wordmark-fixed')) {
      const wm = document.createElement('div');
      wm.className='zt-wordmark-fixed';
      Object.assign(wm.style,{
        position:'absolute', top:'6px', left:'12px', width:'auto', height:'40px',
        backgroundImage:`url(${chrome.runtime.getURL('assets/ZTblackbckgrn.png')})`,
        backgroundRepeat:'no-repeat', backgroundPosition:'left center', backgroundSize:'contain',
        pointerEvents:'none', filter:'drop-shadow(0 2px 6px rgba(0,0,0,.25))'
      });
      panel.style.position='relative';
      const padTop=parseInt(getComputedStyle(panel).paddingTop||'0',10);
      if(padTop<40) panel.style.paddingTop='40px';
      panel.appendChild(wm);
    }
  }

  function forceCTA(root){
    const btns=[...root.querySelectorAll('button, [role="button"]')];
    const cta = btns.find(b => /(generate\s*handoff|handoff oluştur)/i.test(b.textContent||'') || /⚡/.test(b.innerHTML||''));
    if(!cta) return;

    // içerikleri gizle
    [...cta.children].forEach(ch=> ch.style.visibility='hidden');

    // inline stillerle lime'a zorla (sınıf ne olursa olsun)
    Object.assign(cta.style,{
      position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
      width:'100%', minHeight:'46px', padding:'12px 16px 12px 52px',
      borderRadius:'16px', border:'1px solid rgba(255,255,255,.10)',
      background:'#c1ff72', color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px',
      boxShadow:'0 6px 20px rgba(193,255,114,.28)', overflow:'hidden'
    });

    // metin overlay
    let text = cta.querySelector('.zt-cta-text');
    if(!text){ text=document.createElement('span'); text.className='zt-cta-text'; cta.appendChild(text); }
    Object.assign(text.style,{
      position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
      color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px', lineHeight:'1',
      pointerEvents:'none', visibility:'visible'
    });
    text.textContent='Generate Handoff';

    // ikon
    let icon = cta.querySelector('.zt-cta-icon--disabled--disabled');
    if(!icon){ icon=document.createElement('span'); icon.className='zt-cta-icon--disabled--disabled'; cta.appendChild(icon); }
    Object.assign(icon.style,{
      position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)',
      width:'0px', height:'0px',
      backgroundImage:"none",
      backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain',
      pointerEvents:'none', visibility:'visible'
    });

    // hover
    cta.onmouseenter=()=>{ cta.style.background='#a6ff3b'; cta.style.transform='translateY(-1px)'; };
    cta.onmouseleave=()=>{ cta.style.background='#c1ff72'; cta.style.transform='none'; };
  }

  function fixLogout(root){
    const lo = [...root.querySelectorAll('button, [role="button"]')].find(b=>/logout/i.test(b.textContent||''));
    if(!lo) return;
    Object.assign(lo.style,{
      background:'#1e1e1e', color:'#eaeef7',
      border:'1px solid rgba(255,255,255,.1)', borderRadius:'12px',
      padding:'8px 14px', fontWeight:'700'
    });
  }

  function run(){
    const root=sh(); if(!root) return;
    killHeroAndTidy(root);
    forceCTA(root);
    fixLogout(root);
  }

  run();
  const root0=sh();
  if(root0){
    const mo=new MutationObserver(()=>{ try{ run(); }catch{} });
    mo.observe(root0,{subtree:true, childList:true, attributes:true, attributeFilter:['style','class']});
  }
})();

// ===== ZeroToken: NUKE ABOVE PROGRESS + FORCE CTA (final) =====
(function(){
  const HOST='zt-host';
  function sh(){ return document.getElementById(HOST)?.shadowRoot || null; }

  // A) Progress bar'ın ÜSTÜNDEKİ TÜM ELEMANLARI kaldır
  function nukeAboveProgress(root){
    const pb = root.querySelector('[role="progressbar"]');
    if(!pb) return false;
    let cur = pb.previousElementSibling, changed=false;
    while(cur){
      const prev = cur.previousElementSibling;
      cur.remove();              // geri dönüş: sayfayı yenilemen yeter
      cur = prev;
      changed=true;
    }
    return changed;
  }

  // B) Küçük wordmark'ı panelin sol üstüne sabitle
  function pinWordmark(root){
    const panel = root.getElementById('zt-panel') || root;
    if(!panel || panel.querySelector('.zt-wordmark-fixed')) return;
    const wm = document.createElement('div');
    wm.className='zt-wordmark-fixed';
    Object.assign(wm.style,{
      position:'absolute', top:'6px', left:'12px', width:'auto', height:'40px',
      backgroundImage:`url(${chrome.runtime.getURL('assets/ZTblackbckgrn.png')})`,
      backgroundRepeat:'no-repeat', backgroundPosition:'left center', backgroundSize:'contain',
      pointerEvents:'none', filter:'drop-shadow(0 2px 6px rgba(0,0,0,.25))'
    });
    panel.style.position='relative';
    const padTop=parseInt(getComputedStyle(panel).paddingTop||'0',10);
    if(padTop<40) panel.style.paddingTop='40px';
    panel.appendChild(wm);
  }

  // C) CTA'yı sınıf bağımsız lime'a zorla; Logout'u ayır
  function forceCTAandLogout(root){
    const btns=[...root.querySelectorAll('button, [role="button"]')];

    // CTA tespiti
    const cta = btns.find(b => /(generate\s*handoff|handoff oluştur)/i.test(b.textContent||'') || /⚡/.test(b.innerHTML||''));
    if (cta){
      [...cta.children].forEach(ch => ch.style.visibility='hidden');
      Object.assign(cta.style,{
        position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', minHeight:'46px', padding:'12px 16px 12px 52px',
        borderRadius:'16px', border:'1px solid rgba(255,255,255,.10)',
        background:'#c1ff72', color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px',
        boxShadow:'0 6px 20px rgba(193,255,114,.28)', overflow:'hidden'
      });
      let text = cta.querySelector('.zt-cta-text');
      if(!text){ text=document.createElement('span'); text.className='zt-cta-text'; cta.appendChild(text); }
      Object.assign(text.style,{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',color:'#000',fontWeight:'800',fontSize:'16px',letterSpacing:'.2px',lineHeight:'1',pointerEvents:'none',visibility:'visible'});
      text.textContent='Generate Handoff';
      let icon = cta.querySelector('.zt-cta-icon--disabled--disabled');
      if(!icon){ icon=document.createElement('span'); icon.className='zt-cta-icon--disabled--disabled'; cta.appendChild(icon); }
      Object.assign(icon.style,{position:'absolute',left:'16px',top:'50%',transform:'translateY(-50%)',width:'0px',height:'0px',backgroundImage:"none",backgroundRepeat:'no-repeat',backgroundPosition:'center',backgroundSize:'contain',pointerEvents:'none',visibility:'visible'});
      cta.onmouseenter=()=>{ cta.style.background='#a6ff3b'; cta.style.transform='translateY(-1px)'; };
      cta.onmouseleave=()=>{ cta.style.background='#c1ff72'; cta.style.transform='none'; };
    }

    // Logout
    const lo = btns.find(b => /logout/i.test(b.textContent||''));
    if (lo){
      Object.assign(lo.style,{
        background:'#1e1e1e', color:'#eaeef7',
        border:'1px solid rgba(255,255,255,.1)', borderRadius:'12px',
        padding:'8px 14px', fontWeight:'700'
      });
    }
  }

  function run(){
    const root = sh(); if(!root) return;
    const nuked = nukeAboveProgress(root);
    if (nuked) pinWordmark(root);
    forceCTAandLogout(root);
  }

  // Çok erken de çalışalım; sonra da reflow'larda tekrar uygula
  let tries = 0;
  const t = setInterval(()=>{ run(); if(++tries>25) clearInterval(t); }, 120);
  const r = sh();
  if(r){
    const mo = new MutationObserver(()=>{ try{ run(); }catch{} });
    mo.observe(r,{subtree:true, childList:true, attributes:true, attributeFilter:['style','class']});
  }
})();

// ==== ZeroToken: ULTRA SANITIZER (panel bg kill + CTA hard reset) ====
(function(){
  const HOST='zt-host';
  const HERO_RX = /(ZeroTokenTrans\.png|ZTblackbckgrn\.png)/i;

  const sh = () => document.getElementById(HOST)?.shadowRoot || null;

  function killPanelAndSiblingsBg(root){
    const panel = root.getElementById('zt-panel') || root;
    // 1) Panelin içindeki ve panelin KENDİ background'ını temizle
    const pcs = getComputedStyle(panel);
    if (HERO_RX.test(pcs.backgroundImage || '')) {
      panel.style.backgroundImage = 'none';
      panel.style.background = (panel.style.background || '').replace(/url\([^)]+\)/g,'none');
    }
    // 2) Progress'in ÜSTÜNDEN zaten nuke yaptık; ALTTAN da kontrol (bazı buildlerde altında geliyor)
    const pb = root.querySelector('[role="progressbar"]');
    if (pb){
      let node = pb.nextElementSibling;
      let guard = 0;
      while(node && guard++ < 5){
        const cs = getComputedStyle(node);
        if (HERO_RX.test(cs.backgroundImage||'')) {
          node.style.backgroundImage = 'none';
          node.style.background = (node.style.background || '').replace(/url\([^)]+\)/g,'none');
          node.style.minHeight='0'; node.style.height='0'; node.style.padding='0'; node.style.overflow='hidden';
        }
        node = node.nextElementSibling;
      }
    }
    // 3) Panelin üst-sol küçük wordmark
    if (!panel.querySelector('.zt-wordmark-fixed')) {
      const wm = document.createElement('div');
      wm.className = 'zt-wordmark-fixed';
      Object.assign(wm.style,{
        position:'absolute', top:'6px', left:'12px', width:'auto', height:'40px',
        backgroundImage:`url(${chrome.runtime.getURL('assets/ZTblackbckgrn.png')})`,
        backgroundRepeat:'no-repeat', backgroundPosition:'left center', backgroundSize:'contain',
        pointerEvents:'none', filter:'drop-shadow(0 2px 6px rgba(0,0,0,.25))'
      });
      panel.style.position='relative';
      const padTop = parseInt(getComputedStyle(panel).paddingTop||'0',10);
      if (padTop < 40) panel.style.paddingTop = '40px';
      panel.appendChild(wm);
    }
  }

  function forceCTAandLogout(root){
    const btns = [...root.querySelectorAll('button, [role="button"]')];

    // --- CTA: metin/emoji ile yakala ---
    const CTA_RX = /(generate\s*handoff|handoff oluştur)/i;
    const cta = btns.find(b => CTA_RX.test(b.textContent||'') || /⚡/.test(b.innerHTML||''));
    if (cta){
      // 1) İçeriği TAMAMEN sıfırla (metin node + svg + emoji her şey gitsin)
      cta.innerHTML = '';
      // 2) Stil – inline (override edilemez)
      Object.assign(cta.style,{
        position:'relative', display:'flex', alignItems:'center', justifyContent:'center',
        width:'100%', minHeight:'46px', padding:'12px 16px 12px 52px',
        borderRadius:'16px', border:'1px solid rgba(255,255,255,.10)',
        background:'#c1ff72', color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px',
        boxShadow:'0 6px 20px rgba(193,255,114,.28)', overflow:'hidden'
      });
      // 3) Bizim metin ve ikon
      const text = document.createElement('span');
      text.textContent = 'Generate Handoff';
      Object.assign(text.style,{
        position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
        color:'#000', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px', lineHeight:'1',
        pointerEvents:'none', visibility:'visible'
      });
      const icon = document.createElement('span');
      Object.assign(icon.style,{
        position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)',
        width:'0px', height:'0px',
        backgroundImage:"none",
        backgroundRepeat:'no-repeat', backgroundPosition:'center', backgroundSize:'contain',
        pointerEvents:'none'
      });
      cta.append(icon, text);
      cta.onmouseenter=()=>{ cta.style.background='#a6ff3b'; cta.style.transform='translateY(-1px)'; };
      cta.onmouseleave=()=>{ cta.style.background='#c1ff72'; cta.style.transform='none'; };
    }

    // --- Logout – ayrı tut ---
    const lo = btns.find(b => /logout/i.test(b.textContent||''));
    if (lo){
      Object.assign(lo.style,{
        background:'#1e1e1e', color:'#eaeef7',
        border:'1px solid rgba(255,255,255,.1)', borderRadius:'12px',
        padding:'8px 14px', fontWeight:'700'
      });
    }
  }

  function run(){
    const root = sh(); if(!root) return;
    killPanelAndSiblingsBg(root);
    forceCTAandLogout(root);
  }

  // İlk saniye boyunca birkaç kez dene; sonra değişimde tekrar uygula
  let tries=0; const t=setInterval(()=>{ run(); if(++tries>25) clearInterval(t); }, 120);
  const r = sh();
  if(r){
    const mo = new MutationObserver(()=>{ try{ run(); }catch{} });
    mo.observe(r,{subtree:true, childList:true, attributes:true, attributeFilter:['style','class']});
  }
})();

// === ZeroToken: post-render UI patch (safe; no template edits) ===
(function(){
  const HOST='zt-host';
  const sh = () => document.getElementById(HOST)?.shadowRoot || null;

  function apply(){
    const root = sh(); if(!root) return;

    // 1) Header wordmark'ı düzelt
    const img = root.querySelector('.zt-wordmark');
    if (img) {
      img.src = chrome.runtime.getURL('assets/ZTblackbckgrn.png');
      Object.assign(img.style, {
        width:'auto', height:'40px', objectFit:'contain', display:'block'
      });
    }

    // 2) CTA: lime + solda ikon + ortada metin
    const btn = root.querySelector('#zt-handoff-btn');
    if (btn) {
      // içeriği sıfırla (kaçış problemi yok)
      btn.innerHTML = '';
      Object.assign(btn.style, {
        position:'relative', width:'100%',
        background:'#c1ff72', color:'#000',
        border:'1px solid rgba(255,255,255,.1)', borderRadius:'16px',
        padding:'12px 16px 12px 52px',
        cursor:'pointer', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px',
        boxShadow:'0 6px 20px rgba(193,255,114,.28)'
      });
      const icon = document.createElement('span');
      Object.assign(icon.style, {
        position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)',
        width:'0px', height:'0px',
        backgroundImage:"none",
        backgroundRepeat:'no-repeat', backgroundSize:'contain', backgroundPosition:'center',
        pointerEvents:'none'
      });
      const label = document.createElement('span');
      label.textContent = 'Generate Handoff';
      Object.assign(label.style, {
        position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
        pointerEvents:'none', fontWeight:'800', fontSize:'16px', letterSpacing:'.2px', color:'#000'
      });
      btn.append(icon, label);
      btn.onmouseenter = ()=>{ btn.style.background='#a6ff3b'; btn.style.transform='translateY(-1px)'; };
      btn.onmouseleave = ()=>{ btn.style.background='#c1ff72'; btn.style.transform='none'; };
    }

    // 3) Footer (yoksa ekle)
    if (!root.querySelector('.zt-footer')) {
      const hint = root.querySelector('#zt-hint') || root.querySelector('#zt-panel');
      if (hint) {
        const f = document.createElement('div');
        f.className = 'zt-footer';
        Object.assign(f.style, { textAlign:'center', fontSize:'12px', opacity:'.8', marginTop:'8px' });

        const logo = document.createElement('span');
        Object.assign(logo.style, {
          display:'inline-block', width:'0px', height:'0px', verticalAlign:'middle',
          backgroundImage:`url(${chrome.runtime.getURL('assets/marsiriusjustlogo.png')})`,
          backgroundRepeat:'no-repeat', backgroundSize:'contain', marginRight:'6px'
        });

        const txt = document.createElement('span');
        txt.textContent = 'Created & Powered by Marsirius AI Labs';

        f.append(logo, txt);
        hint.insertAdjacentElement('afterend', f);
      }
    }
  }

  // İlk uygulama + reflow'larda tekrar
  apply();
  const r = sh();
  if (r) new MutationObserver(()=>{ try{ apply(); }catch{} })
           .observe(r, {subtree:true, childList:true});
})();

// === ZeroToken: generic hero cleaner (name-agnostic) ===
(function(){
  const HOST='zt-host';
  const sh = () => document.getElementById(HOST)?.shadowRoot || null;

  function killGenericHero(){
    const root = sh(); if(!root) return;
    const pb = root.querySelector('[role="progressbar"]'); if(!pb) return;

    // 1) Progress'ten ÖNCEKİ tüm elemanlarda url(...) background varsa ve yükseklik büyükse sıfırla
    let el = pb.previousElementSibling;
    while(el){
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage || '';
      const h  = parseFloat(cs.height) || 0;
      if (bg.includes('url(') || h > 120) {
        el.style.backgroundImage = 'none';
        el.style.background = (el.style.background || '').replace(/url\([^)]+\)/g,'none');
        el.querySelectorAll('img').forEach(n => n.remove());
        el.style.minHeight='0'; el.style.height='0'; el.style.padding='0';
        el.style.margin='0 0 8px 0'; el.style.overflow='hidden';
      }
      el = el.previousElementSibling;
    }

    // 2) Panel'in KENDİ background'ı url(...) ise onu da kaldır
    const panel = root.getElementById('zt-panel') || root;
    const pbg = getComputedStyle(panel).backgroundImage || '';
    if (pbg.includes('url(')) {
      panel.style.backgroundImage = 'none';
      panel.style.background = (panel.style.background || '').replace(/url\([^)]+\)/g,'none');
    }
  }

  // Birkaç kez erken dene + reflow'da uygula
  let tries=0; const t=setInterval(()=>{ killGenericHero(); if(++tries>25) clearInterval(t); }, 120);
  const r = sh();
  if (r) new MutationObserver(()=>{ try{ killGenericHero(); }catch{} })
          .observe(r, {subtree:true, childList:true, attributes:true, attributeFilter:['style','class']});
})();

// === ZeroToken: background sweep (name-agnostic, core-safe) ===
(function(){
  const HOST='zt-host';
  const sh = () => document.getElementById(HOST)?.shadowRoot || null;

  function sweepBigBackgrounds(){
    const root = sh(); if(!root) return;
    const panel = root.getElementById('zt-panel') || root;

    panel.querySelectorAll('*').forEach(el=>{
      // Koruma: rozet ve CTA'ya dokunma
      if (el.classList?.contains('zt-wordmark-fixed')) return;
      if (el.id === 'zt-handoff-btn') return;

      const cs = getComputedStyle(el);
      const hasUrl = /url\(/.test(cs.backgroundImage||'');
      const big    = (parseFloat(cs.height)||0) >= 80 || (parseFloat(cs.minHeight)||0) >= 80;

      if (hasUrl && big){
        el.style.setProperty('background-image','none','important');
        el.style.setProperty('background','none','important');
        // Bazı build'lerde img ile basılıyor; varsa iç img'yi de kaldır
        el.querySelectorAll('img').forEach(img=>{
          const w = parseFloat(getComputedStyle(img).width)||0;
          const h = parseFloat(getComputedStyle(img).height)||0;
          if (w>=160 || h>=80) img.remove();
        });
      }
    });
  }

  // İlk birkaç saniye tekrarlı uygula + reflow'da yeniden
  let n=0; const tick=setInterval(()=>{sweepBigBackgrounds(); if(++n>25) clearInterval(tick);},120);
  const r = sh();
  if (r) new MutationObserver(()=>{ try{sweepBigBackgrounds();}catch{} })
          .observe(r,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class']});
})();

// === ZeroToken: FINAL brand sweep (name-agnostic, core-safe) ===
(function(){
  const HOST='zt-host';
  const SH = ()=>document.getElementById(HOST)?.shadowRoot||null;

  // Büyük arka planlı blokları ve büyük marka img'lerini temizler
  function sweep(){
    const root = SH(); if(!root) return;
    const panel = root.getElementById('zt-panel') || root;

    // 1) url(...) background + yüksek blok => sıfırla (isim bağımsız)
    panel.querySelectorAll('*').forEach(el=>{
      if (el.classList?.contains('zt-wordmark-fixed')) return;  // küçük rozet kalsın
      if (el.id === 'zt-handoff-btn') return;                    // CTA kalsın

      const cs = getComputedStyle(el);
      const hasUrl = /url\(/.test(cs.backgroundImage||'');
      const big    = (parseFloat(cs.height)||0) >= 80 || (parseFloat(cs.minHeight)||0) >= 80;

      if (hasUrl && big){
        el.style.setProperty('background-image','none','important');
        el.style.setProperty('background','none','important');
        el.style.setProperty('min-height','0','important');
        el.style.setProperty('height','0','important');
        el.style.setProperty('padding','0','important');
        el.style.setProperty('margin','0 0 8px 0','important');
        el.style.setProperty('overflow','hidden','important');
      }
    });

    // 2) Büyük marka IMG'leri kaldır (isim bağımsız)
    const IMG_RX = /(ZT.*\.png|ZeroToken.*\.png)/i;
    panel.querySelectorAll('img').forEach(img=>{
      const src=(img.getAttribute('src')||'').toLowerCase();
      const w = Math.max(img.naturalWidth||0, img.clientWidth||0);
      const h = Math.max(img.naturalHeight||0, img.clientHeight||0);
      if (IMG_RX.test(src) && (w>=160 || h>=80)) {
        img.remove();
      }
    });

    // 3) Panel kendi background'ında url(...) varsa temizle
    const pbg = getComputedStyle(panel).backgroundImage||'';
    if (/url\(/.test(pbg)){
      panel.style.setProperty('background-image','none','important');
      panel.style.setProperty('background','none','important');
    }
  }

  // İlk saniyelerde birkaç kez dene, sonra reflow'da tekrar uygula
  let n=0; const t=setInterval(()=>{sweep(); if(++n>25) clearInterval(t);}, 120);
  const r=SH();
  if (r) new MutationObserver(()=>{ try{sweep();}catch{} })
          .observe(r,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','src']});
})();

// === ZeroToken: add Marsirius footer (once) ===
(function(){
  const HOST='zt-host';
  const sh = ()=>document.getElementById(HOST)?.shadowRoot||null;

  function addFooter(){
    const root = sh(); if(!root) return;
    if (root.querySelector('.zt-footer')) return;

    // CTA veya hint'ten sonra yerleştir
    const anchor = root.querySelector('#zt-hint') || root.querySelector('#zt-panel');
    if (!anchor) return;

    const f = document.createElement('div');
    f.className='zt-footer';
    Object.assign(f.style,{textAlign:'center',fontSize:'12px',opacity:'.85',marginTop:'8px',color:'#eaeef7'});

    const logo=document.createElement('span');
    Object.assign(logo.style,{
      display:'inline-block',width:'0px',height:'0px',verticalAlign:'middle',
      backgroundImage:`url(${chrome.runtime.getURL('assets/marsiriusjustlogo.png')})`,
      backgroundRepeat:'no-repeat',backgroundSize:'contain',marginRight:'6px'
    });

    const txt=document.createElement('span');
    txt.textContent='Created & Powered by Marsirius AI Labs';

    f.append(logo,txt);
    anchor.insertAdjacentElement('afterend', f);
  }

  addFooter();
  const r=sh();
  if(r) new MutationObserver(()=>{ try{ addFooter(); }catch{} })
         .observe(r,{subtree:true,childList:true});
})();

// === ZeroToken: pin Marsirius footer UNDER "ZeroToken Pro active · unlimited handoffs" ===
(function(){
  const HOST='zt-host';
  const sh = ()=>document.getElementById(HOST)?.shadowRoot||null;

  function findProRow(root){
    // Alttaki satırı bul: "ZeroToken Pro active · unlimited handoffs"
    // Metin değişse bile "ZeroToken Pro active" parçasını yakala.
    const all = Array.from(root.querySelectorAll('#zt-panel, #zt-panel *'));
    return all.find(el=>{
      const t=(el.textContent||'').trim();
      return t.toLowerCase().includes('zerotoken pro active');
    }) || null;
  }

  function ensureFooter(){
    const root = sh(); if(!root) return;
    const anchor = findProRow(root);
    if(!anchor) return;

    // Zaten ekliysek dokunma
    if (anchor.nextElementSibling && anchor.nextElementSibling.classList?.contains('zt-footer-fixed')) return;

    const f = document.createElement('div');
    f.className = 'zt-footer-fixed';
    Object.assign(f.style,{
      display:'flex', alignItems:'center', justifyContent:'center',
      gap:'6px',
      marginTop:'8px',
      fontSize:'12px',
      color:'#eaeef7',
      opacity:'.88',
      textAlign:'center'
    });

    const logo = document.createElement('span');
    Object.assign(logo.style,{
      display:'inline-block',
      width:'0px', height:'0px',
      backgroundImage:`url(${chrome.runtime.getURL('assets/marsiriusjustlogo.png')})`,
      backgroundRepeat:'no-repeat',
      backgroundSize:'contain',
      backgroundPosition:'center'
    });

    const txt = document.createElement('span');
    txt.textContent = 'Created & Powered by Marsirius AI Labs';

    f.append(logo, txt);

    // Metnin HEMEN ALTINA koy
    anchor.insertAdjacentElement('afterend', f);
  }

  // İlk çalıştır + reflow'larda tekrarla (başka dosya silse bile geri koyar)
  ensureFooter();
  const root0 = sh();
  if(root0){
    const mo = new MutationObserver(()=>{ try{ ensureFooter(); }catch{} });
    mo.observe(root0, {subtree:true, childList:true, characterData:true});
  }
})();

// === ZeroToken: bottom-pinned Marsirius footer (reflow-safe) ===
(function(){
  const HOST='zt-host';
  const sh = ()=>document.getElementById(HOST)?.shadowRoot||null;

  function ensureBottomFooter(){
    const root = sh(); if(!root) return;
    const panel = root.getElementById('zt-panel') || root;

    // Zaten varsa güncelle ve sona taşı
    let f = root.querySelector('.zt-footer-fixed');
    if (!f){
      f = document.createElement('div');
      f.className = 'zt-footer-fixed';
      panel.appendChild(f);
    } else if (f.parentElement !== panel || panel.lastElementChild !== f){
      panel.appendChild(f); // en sona al
    }

    Object.assign(f.style,{
      display:'flex', alignItems:'center', justifyContent:'center',
      gap:'6px', marginTop:'8px', marginBottom:'2px',
      fontSize:'12px', color:'#eaeef7', opacity:'.88', textAlign:'center'
    });

    // İçeriği her seferinde idempotent kur
    if (!f.querySelector('.zt-footer-logo')){
      const logo = document.createElement('span');
      logo.className='zt-footer-logo';
      f.prepend(logo);
    }
    const logo=f.querySelector('.zt-footer-logo');
    Object.assign(logo.style,{
      display:'inline-block', width:'0px', height:'0px',
      backgroundImage:`url(${chrome.runtime.getURL('assets/marsiriusjustlogo.png')})`,
      backgroundRepeat:'no-repeat', backgroundSize:'contain', backgroundPosition:'center'
    });

    if (!f.querySelector('.zt-footer-text')){
      const txt=document.createElement('span');
      txt.className='zt-footer-text';
      f.append(txt);
    }
    f.querySelector('.zt-footer-text').textContent='Created & Powered by Marsirius AI Labs';
  }

  // İlk kurulum + reflow'da geri getir
  ensureBottomFooter();
  const r=sh();
  if(r){
    new MutationObserver(()=>{ try{ ensureBottomFooter(); }catch{} })
      .observe(r,{subtree:true,childList:true,characterData:true});
  }
})();

// === ZeroToken: absolute bottom footer (panel içine pin'li) ===
(function(){
  const HOST='zt-host';
  const sh = ()=>document.getElementById(HOST)?.shadowRoot||null;

  function ensureBottomFooterAbs(){
    const root = sh(); if(!root) return;
    const panel = root.getElementById('zt-panel'); if(!panel) return;

    // Panel alt kırpmayı önle
    const padB = parseInt(getComputedStyle(panel).paddingBottom||'0', 10);
    if (padB < 40) panel.style.paddingBottom = '40px';

    // Panel pozisyonlayalım (absolute için referans)
    if (getComputedStyle(panel).position === 'static') {
      panel.style.position = 'relative';
    }

    // Footer DIV'i oluştur/yeniden konumlandır
    let f = root.querySelector('.zt-footer-fixedabs');
    if (!f){
      f = document.createElement('div');
      f.className = 'zt-footer-fixedabs';
      panel.appendChild(f);
    }
    Object.assign(f.style, {
      position:'absolute',
      left:'50%',
      bottom:'8px',
      transform:'translateX(-50%)',
      display:'flex',
      alignItems:'center',
      justifyContent:'center',
      gap:'6px',
      fontSize:'12px',
      color:'#eaeef7',
      opacity:'.9',
      background:'transparent',
      pointerEvents:'none'   // tıklamaları engellemesin
    });

    // İçerik (ikon + metin) — idempotent
    if (!f.querySelector('.zt-footer-logo')){
      const logo = document.createElement('span');
      logo.className='zt-footer-logo';
      f.appendChild(logo);
    }
    const logo=f.querySelector('.zt-footer-logo');
    Object.assign(logo.style,{
      display:'inline-block', width:'0px', height:'0px',
      backgroundImage:`url(${chrome.runtime.getURL('assets/marsiriusjustlogo.png')})`,
      backgroundRepeat:'no-repeat', backgroundSize:'contain', backgroundPosition:'center',
      marginRight:'6px'
    });

    if (!f.querySelector('.zt-footer-text')){
      const txt = document.createElement('span');
      txt.className='zt-footer-text';
      f.appendChild(txt);
    }
    f.querySelector('.zt-footer-text').textContent = 'Created & Powered by Marsirius AI Labs';
  }

  // İlk kurulum + reflow'da geri getir
  ensureBottomFooterAbs();
  const r = sh();
  if (r) new MutationObserver(()=>{ try{ ensureBottomFooterAbs(); }catch{} })
          .observe(r, {subtree:true, childList:true, attributes:true, characterData:true});
})();
// === ZeroToken: single-brand & single-footer enforcer (core-safe) ===
(function(){
  const HOST='zt-host';
  const sh = ()=>document.getElementById(HOST)?.shadowRoot||null;

  // Panel referansı + padding güvenliği
  function getPanel(){
    const root = sh(); if(!root) return null;
    const panel = root.getElementById('zt-panel') || root;
    if (getComputedStyle(panel).position === 'static') panel.style.position='relative';
    // footer için alt boşluk
    const pb = parseInt(getComputedStyle(panel).paddingBottom||'0',10);
    if (pb < 40) panel.style.paddingBottom = '40px';
    return panel;
  }

  // 1) ÜST LOGO — tek kopya
  function enforceSingleBrand(){
    const root = sh(); const panel = getPanel(); if(!root||!panel) return;

    // Tüm muhtemel markalama elemanlarını topla
    const candidates = [
      ...root.querySelectorAll('.zt-wordmark'),
      ...root.querySelectorAll('img.zt-wordmark'),
      ...root.querySelectorAll('img[src*="ZT"][src$=".png"]'),
      ...root.querySelectorAll('img[src*="ZeroToken"][src$=".png"]')
    ];

    // Hepsini kaldır
    candidates.forEach(el=> el.remove());

    // Sadece 1 adet oluştur (sol üst)
    let wm = root.querySelector('.zt-wordmark-fixed');
    if (!wm){
      wm = document.createElement('div');
      wm.className = 'zt-wordmark-fixed';
      panel.appendChild(wm);
    }
    Object.assign(wm.style,{
      position:'absolute', top:'6px', left:'12px',
      width:'auto', height:'40px',
      backgroundImage:`url(${chrome.runtime.getURL('assets/ZTblackbckgrn.png')})`,
      backgroundRepeat:'no-repeat', backgroundPosition:'left center', backgroundSize:'contain',
      pointerEvents:'none', filter:'drop-shadow(0 2px 6px rgba(0,0,0,.25))'
    });
  }

  // 2) FOOTER — tek kopya (panelin en altına sabit)
  function enforceSingleFooter(){
    const root = sh(); const panel = getPanel(); if(!root||!panel) return;

    // Varsa tüm footer varyantlarını temizle (bizim önceki class'larımız dahil)
    [...root.querySelectorAll('.zt-footer, .zt-footer-fixed, .zt-footer-fixedabs')].forEach(el=> el.remove());

    // Tek footer yarat veya güncelle
    let f = root.querySelector('.zt-footer-final');
    if (!f){
      f = document.createElement('div');
      f.className='zt-footer-final';
      panel.appendChild(f);
    }
    Object.assign(f.style,{
      position:'absolute', left:'50%', bottom:'8px', transform:'translateX(-50%)',
      display:'flex', alignItems:'center', justifyContent:'center', gap:'6px',
      fontSize:'12px', color:'#eaeef7', opacity:'.9', pointerEvents:'none'
    });

    // içerik (idempotent)
    let logo = f.querySelector('.logo'); if(!logo){ logo=document.createElement('span'); logo.className='logo'; f.appendChild(logo); }
    Object.assign(logo.style,{
      display:'inline-block', width:'0px', height:'0px',
      backgroundImage:`url(${chrome.runtime.getURL('assets/marsiriusjustlogo.png')})`,
      backgroundRepeat:'no-repeat', backgroundSize:'contain', backgroundPosition:'center'
    });

    let txt = f.querySelector('.txt'); if(!txt){ txt=document.createElement('span'); txt.className='txt'; f.appendChild(txt); }
    txt.textContent = 'Created & Powered by Marsirius AI Labs';
  }

  function run(){ enforceSingleBrand(); enforceSingleFooter(); }

  // İlk çalıştır + reflow'da tekrar
  run();
  const r = sh();
  if (r){
    new MutationObserver(()=>{ try{ run(); }catch{} })
      .observe(r,{subtree:true, childList:true, attributes:true, attributeFilter:['style','class','src']});
  }
})();

// === ZeroToken: inject bundle.js into page context (not isolated) ===
(function(){
  const BUNDLE_ID = 'zt-bundle-js';
  function injectBundleOnce(){
    if (document.getElementById(BUNDLE_ID)) return Promise.resolve(true);
    return new Promise((resolve, reject)=>{
      try {
        const s = document.createElement('script');
        s.id = BUNDLE_ID;
        s.src = chrome.runtime.getURL('bundle.js');  // page context yüklenir
        s.onload = ()=> resolve(true);
        s.onerror = (e)=> reject(e);
        (document.documentElement || document.head || document.body).appendChild(s);
      } catch(e){ reject(e); }
    });
  }
  async function ensureCreateClient(timeoutMs=5000){
    const t0 = Date.now();
    while (typeof window.createSupabaseClient !== 'function'){
      if (Date.now() - t0 > timeoutMs) return false;
      await new Promise(r=>setTimeout(r,150));
    }
    return true;
  }
  (async ()=>{
    try{
      await injectBundleOnce();
      const ok = await ensureCreateClient(5000);
      if (!ok) console.warn('[ZeroToken] createSupabaseClient görünmedi (page ctx)!');
      else     console.info('[ZeroToken] createSupabaseClient page ctx ✓');
    }catch(e){
      console.warn('[ZeroToken] bundle inject error:', e);
    }
  })();
})();

// === ZeroToken: inject bundle.js into page context (not isolated) ===
(function(){
  const BUNDLE_ID='zt-bundle-js';
  function injectBundleOnce(){
    if (document.getElementById(BUNDLE_ID)) return Promise.resolve(true);
    return new Promise((resolve,reject)=>{
      try{
        const s=document.createElement('script');
        s.id=BUNDLE_ID;
        s.src=chrome.runtime.getURL('bundle.js');
        s.onload=()=>resolve(true);
        s.onerror=(e)=>reject(e);
        (document.documentElement||document.head||document.body).appendChild(s);
      }catch(e){reject(e);}
    });
  }
  async function waitCreateClient(ms=5000){
    const t0=Date.now();
    while(typeof window.createSupabaseClient!=='function'){
      if(Date.now()-t0>ms) return false;
      await new Promise(r=>setTimeout(r,150));
    }
    return true;
  }
  (async()=>{
    try{
      await injectBundleOnce();
      const ok=await waitCreateClient(5000);
      if(!ok) console.warn('[ZeroToken] createSupabaseClient görünmedi (page ctx)!');
      else    console.info('[ZeroToken] createSupabaseClient page ctx ✓');
    }catch(e){ console.warn('[ZeroToken] bundle inject error:',e); }
  })();
})();
// === ZeroToken: sweep ALL brand pseudos (UI-only, core untouched) ===
(function(){
  const HOST='zt-host';
  const sh = ()=>document.getElementById(HOST)?.shadowRoot||null;
  const IMG_RX = /(ZT.*\.png|ZeroToken.*\.png)/i;

  function sweepAll(){
    const root = sh(); if(!root) return;
    const panel = root.getElementById('zt-panel') || root;

    // 1) Tüm çocukları dolaş: ::before'unda ZT* / ZeroToken* varsa görünmez yap
    panel.querySelectorAll('*').forEach(el=>{
      try{
        const bg = getComputedStyle(el,'::before').backgroundImage || '';
        if (IMG_RX.test(bg)) {
          el.style.setProperty('--zt_hide_before','1'); // işaret
          // content ve display'i kapatmak için inline CSS kancası
          const ex = el.getAttribute('style')||'';
          if (!/content:/.test(ex)) el.style.setProperty('content','none');
          el.style.setProperty('display',''); // mevcut display'i korur
        }
      }catch{} // bazı pseudo'lar okunamayabilir, sorun değil
    });

    // 2) Inline <img> wordmark'ları da kapat (sadece görsel)
    panel.querySelectorAll('img.zt-wordmark, .zt-brand img, header img, [data-role="header"] img, img[src*="ZT"], img[src*="ZeroToken"], img[src*="zerotoken"]')
      .forEach(img=>{ img.style.setProperty('display','none','important'); });
  }

  // İlk uygulama + reflow'da tekrar
  sweepAll();
  const r=sh();
  if(r) new MutationObserver(()=>{ try{ sweepAll(); }catch{} })
         .observe(r,{subtree:true,childList:true,attributes:true,attributeFilter:['style','class','src']});
})();

// WOW helpers
function computeWowMoments(handoffText){
  try{
    const lines = String(handoffText||"").split('\n');
    const wow = [];
    const patterns = [
      /initial|başlangıç|ilk.*mesaj/i,
      /decided|karar|seçim|onay/i,
      /important|önemli|kritik|dikkat/i,
      /remember|hatırla|unutma/i,
      /preference|tercih|istek|talep/i
    ];
    for(const line of lines.slice(0, 120)){
      for(const p of patterns){ if(p.test(line)){ wow.push(line.trim()); break; } }
      if(wow.length>=6) break;
    }
    return wow;
  }catch{ return []; }
}

function showUpgradeModal(){
  let w=document.getElementById('zt-upgrade-modal'); if(w) w.remove();
  w=document.createElement('div'); w.id='zt-upgrade-modal';
  w.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:22px';
  const logo = chrome.runtime?.getURL ? chrome.runtime.getURL('assets/zticontrans.png') : '';
  w.innerHTML=`<div style="background:#0b0c10;color:#e6ebff;border:1px solid rgba(193,255,114,.22);border-radius:16px;padding:18px;min-width:360px;box-shadow:0 20px 60px rgba(0,0,0,.6);font:13px/1.5 Inter,system-ui;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      ${logo?`<img src="${logo}" alt="ZeroToken" style="width:18px;height:18px;opacity:.95"/>`:''}
      <b>Upgrade your ZeroToken plan</b>
    </div>
    <div style="opacity:.85;margin-bottom:12px">Free plan includes 3 handoffs (after registration). Choose one:</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button id="zt-go-lite" class="zt-btn" style="background:#c1ff72;color:#000">Lite · $2.99 / handoff</button>
      <button id="zt-go-pro" class="zt-btn" style="background:#7c5cff">Pro · $9.99 / month (Unlimited)</button>
    </div>
    <div style="margin-top:12px;opacity:.7;font-size:12px">Payments handled securely. Prices excl. Stripe fees.</div>
    <div style="text-align:right;margin-top:10px"><button id="zt-upg-close" class="zt-btn" style="background:#252833">Close</button></div>
  </div>`;
  document.body.appendChild(w);
  w.querySelector('#zt-upg-close').onclick=()=>w.remove();
  w.querySelector('#zt-go-lite').onclick=()=>{ window.open('https://zerotoken.ai/upgrade?plan=lite','_blank'); };
  w.querySelector('#zt-go-pro').onclick=()=>{ window.open('https://zerotoken.ai/upgrade?plan=pro','_blank'); };
}
