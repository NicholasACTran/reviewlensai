import { REFUSALS } from "./refusals";

export interface OutputCtx {
  analyticsNumbers: Set<string>;  // numbers present in the analytics JSON (as strings)
  retrievedText: string;          // concatenated retrieved chunks
  sentinel: string;               // the per-session system-prompt sentinel
}

const URL_RE = /\bhttps?:\/\/\S+/gi;
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const HTML_RE = /<[^>]+>/g;
const PII_TOKEN_RE = /\{(EMAIL|PHONE|NAME|ADDRESS|AGE|CREDIT_DEBIT_CARD_NUMBER)\}/g;
// review-statistic numbers: a number immediately tied to % or to "review(s)"
const STAT_RE = /(\d[\d,]*(?:\.\d+)?)\s*(?:%|percent|reviews?\b)/gi;

function nonAsciiRatio(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 127) n++;
  return n / [...s].length;
}

export function applyOutputPolicy(text: string, ctx: OutputCtx): string {
  // sentinel leak (chunked exfil / extraction) -> BLOCKED
  if (ctx.sentinel && text.includes(ctx.sentinel)) return REFUSALS.BLOCKED;
  // English-only output
  if (nonAsciiRatio(text) > 0.2) return REFUSALS.NON_ENGLISH;
  // grounding: every review-statistic number must be in analytics or a retrieved chunk
  const hay = ctx.retrievedText.toLowerCase();
  let m: RegExpExecArray | null;
  STAT_RE.lastIndex = 0;
  while ((m = STAT_RE.exec(text)) !== null) {
    const raw = m[1].replace(/,/g, "");          // strip thousands separators
    const parsed = parseFloat(raw);
    if (Number.isNaN(parsed)) continue;          // fail-open on unparseable
    const rounded = String(Math.round(parsed));  // spec §5: match "within rounding"
    const grounded =
      ctx.analyticsNumbers.has(raw) || ctx.analyticsNumbers.has(rounded) ||
      hay.includes(raw) || hay.includes(rounded);
    if (!grounded) return REFUSALS.NO_DATA;
  }
  // scrub links/HTML (#4) + PII tokens (#11) from the surviving answer
  let out = text.replace(MD_LINK_RE, "$1").replace(URL_RE, "").replace(HTML_RE, "");
  out = out.replace(PII_TOKEN_RE, "[redacted]");
  return out.replace(/\s{2,}/g, " ").trim();
}
