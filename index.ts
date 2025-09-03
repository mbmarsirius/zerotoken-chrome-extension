// index.ts — CLIENT-ONLY (Chrome extension, page context)
// No Deno, no service-role keys here.

import { init, Tiktoken } from "@dqbd/tiktoken/lite/init";
import wasm from "@dqbd/tiktoken/lite/tiktoken_bg.wasm";
import cl100k_base from "@dqbd/tiktoken/encoders/cl100k_base.json";
import { createClient } from "@supabase/supabase-js";

// 1) Expose Supabase client factory for content.core.js
//    (content.core.js bunu window.createSupabaseClient olarak arıyor)
(window as any).createSupabaseClient = createClient;

// 2) TikToken init + encoder helper (content.core.js bazen TikTokenEncode adını arıyor)
let _enc: Tiktoken | null = null;

async function ensureTikToken() {
  if (_enc) return _enc;
  await init((imports) => WebAssembly.instantiate(wasm as any, imports));
  _enc = new Tiktoken(
    (cl100k_base as any).bpe_ranks,
    (cl100k_base as any).special_tokens,
    (cl100k_base as any).pat_str
  );
  // Her iki isimle de dışarı ver (uyumluluk)
  (window as any).encode = (text: string) => _enc!.encode(text);
  (window as any).TikTokenEncode = (text: string) => _enc!.encode(text);
  return _enc;
}

// 3) Global init (isteyene çağırma kancası)
(window as any).TikTokenInit = async function TikTokenInit() {
  await ensureTikToken();
};

// 4) Debug işaretleri (console’da görünsün)
console.info("[ZeroToken] bundle.js booted (client)");
Promise.resolve().then(() => {
  if (typeof (window as any).createSupabaseClient === "function") {
    console.info("[ZeroToken] createSupabaseClient exposed ✓");
  } else {
    console.warn("[ZeroToken] createSupabaseClient missing ✗");
  }
});
