export type RefusalCode = "OFF_TOPIC" | "NON_ENGLISH" | "NO_DATA" | "BLOCKED";

// Placeholder copy (boundaries spec §2). Asserted as constants so the corpus's
// equals_refusal / refusal_in checks compare against these exact strings.
export const REFUSALS: Record<RefusalCode, string> = {
  OFF_TOPIC: "I can only discuss the review data for this analysis.",
  NON_ENGLISH: "I can only chat in English about this analysis.",
  NO_DATA: "I don't have that in the review data for this analysis.",
  BLOCKED: "I can't help with that.",
};
