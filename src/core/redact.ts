// Redaction for everything this module writes to logs or to stripe_events.last_error.
// The module never logs payloads; this is a second line of defence for error messages, which
// can echo ids from a payload or text from a Stripe SDK error.

const RULES: Array<[RegExp, string]> = [
  // No word boundary: a key can sit inside an id-like string such as "sub_sk_live_...".
  [/(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g, '[redacted:stripe_key]'],
  [/whsec_[A-Za-z0-9]+/g, '[redacted:webhook_secret]'],
  [/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted:jwt]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted:email]'],
];

/** Longest stored error message, in characters. */
const MAX_LENGTH = 1000;

/** Replaces Stripe keys, webhook secrets, JWTs and email addresses, and caps the length. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out.length > MAX_LENGTH ? `${out.slice(0, MAX_LENGTH)}…` : out;
}

/** redact() applied to every string value of a log-fields object (one level deep). */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = typeof value === 'string' ? redact(value) : value;
  return out;
}

export function errorMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
