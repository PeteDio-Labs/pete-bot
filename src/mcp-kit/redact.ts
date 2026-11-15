/**
 * redact: remove credential-shaped text from a tool result before it leaves the process.
 *
 * It is a net under each tool, not a substitute for a tool that never reads a secret. It
 * replaces these shapes: private key blocks, bearer and basic values, JWTs, Vault tokens,
 * AWS access keys, GitHub and `sk-` tokens, credentials inside a URL, and the value in a
 * `name: value` or `name=value` pair whose name ends in token, secret, password, api key,
 * authorization, private key or ssh key. A result that changes reports it, so a reader can tell a redaction from a
 * missing value.
 */

const MARK = '[redacted]';

const NAME = '(?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization|private[_-]?key|secret[_-]?key|ssh[_-]?key)';

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MARK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARK}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, MARK],
  [/\bhv[sbr]\.[A-Za-z0-9_-]{16,}/g, MARK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MARK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MARK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MARK],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+):[^\s@/"']+@/gi, `$1:${MARK}@`],
  // A quoted value is redacted whole, spaces included. The name must END in a credential word,
  // so `token_count` and `tokens` stay readable. The value must be 8 or more characters and
  // not digits alone, so a count or a short word such as `present` is left alone.
  [new RegExp(`\\b(${NAME})(["']?\\s*[:=]\\s*)(["'])(?!\\[redacted\\])[^"']{8,}\\3`, 'gi'), (_m, n, sep, q) => `${n}${sep}${q}${MARK}${q}`],
  [new RegExp(`\\b(${NAME})(["']?\\s*[:=]\\s*)(?!\\[redacted\\])(?!\\d+\\b)[^\\s"',;}]{8,}`, 'gi'), (_m, n, sep) => `${n}${sep}${MARK}`],
];

export function redact(text: string): { text: string; changed: boolean } {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to as string);
  return { text: out, changed: out !== text };
}
