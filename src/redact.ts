/**
 * Token redaction for all output that may carry the extension token.
 * Covers the raw token, its URL-encoded form (the relay puts `?token=<enc>`
 * into connect URLs), and JSON-escaped occurrences.
 */

const MASK = "«chrome-token-redacted»";

export type Redactor = (text: string) => string;

export function makeRedactor(token: string | undefined): Redactor {
  if (!token) return (t) => t;
  const variants = [
    token,
    encodeURIComponent(token),
    JSON.stringify(token).slice(1, -1),
  ];
  return (text) => {
    let out = text;
    for (const v of variants) {
      if (v && v.length >= 4) out = out.split(v).join(MASK);
    }
    return out;
  };
}

/** Redact every known token in an arbitrary JSON-serializable structure (deep). */
export function redactDeep(value: unknown, redact: Redactor): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = redactDeep(v, redact);
    return out;
  }
  return value;
}
