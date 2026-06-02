import { RefusalCode } from "./refusals";

export const MAX_LEN = 2000;             // tuning param (boundaries #6)
export const NON_ASCII_REFUSE = 0.2;     // >20% non-ASCII -> NON_ENGLISH (boundaries #5)
// Allowlist: letters, digits, whitespace, and common chat punctuation (boundaries #6 caveat —
// keep these or legitimate questions break). Everything else (stray non-ASCII, leftover markup) is stripped.
// NOTE: keeps a few chars beyond the spec §3 enumerated set ('/','@','#',';','&') because they
// appear in legitimate questions (e.g. "#1", "a/b"); input link/handle passthrough is contained
// downstream by no-browse capability (#1) + the OUT link scrub (#4), which strip them from answers.
const ALLOWED = /[^A-Za-z0-9\s'%?!,.:;"()&@#/\-]/g;

export interface PreFilterResult { refusal?: RefusalCode; prompt: string; }

function nonAsciiRatio(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 127) n++;
  return n / [...s].length;
}

export function preFilter(raw: string): PreFilterResult {
  // 1. language proxy on the RAW input (non-Latin scripts trip this; Latin-script
  //    non-English relies on the system prompt — see Plan 2A note).
  if (nonAsciiRatio(raw) > NON_ASCII_REFUSE) return { refusal: "NON_ENGLISH", prompt: "" };
  // 2. strip HTML/script/style (INCLUDING contents) BEFORE the allowlist, else
  //    "<script>alert(1)</script>" survives as "scriptalert(1)/script".
  let p = raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "");
  // 3. allowlist, collapse repeats + whitespace, cap length.
  p = p.replace(ALLOWED, "");
  p = p.replace(/(\b\w+\b)(\s+\1\b){3,}/gi, "$1");   // collapse 4+ repeated words
  p = p.replace(/\s{2,}/g, " ").trim();
  if (p.length > MAX_LEN) p = p.slice(0, MAX_LEN);
  return { prompt: p };
}
