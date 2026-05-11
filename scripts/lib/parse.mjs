// Memo parsing.
//
// Format: pipe-separated `key=value` segments. Recognized keys:
//
//   url=<host>[/path]    optional, max 200 chars post-normalization
//   x=<handle>           optional, X.com handle (with or without @)
//   msg=<message>        optional, max 280 chars post-normalization
//
// At least one recognized segment must be present and well-formed.
// Whitespace around `|` and around `=` is tolerated. Returns the parsed
// object (any subset of {url, x, msg}) or `null` if:
//   - raw is not a non-empty string, OR
//   - any segment fails the `key=value` shape, OR
//   - no recognized keys were found
//
// Callers distinguish "no memo" from "memo present but unparseable":
//   raw === null/'' → no memo (pure burn, accepted with empty fields)
//   parseMemo(raw) === null && raw !== '' → quarantine (memo present
//     but doesn't match our schema — could be a burn made via a
//     non-pyrecoin.com tool with arbitrary memo content).

const KEY_RE = /^\s*(url|x|msg)\s*=\s*(.*)$/i;

export function parseMemo(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;

  const out = {};
  for (const seg of t.split('|')) {
    const m = KEY_RE.exec(seg);
    if (!m) return null;
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (key === 'x') val = val.replace(/^@/, '');
    if (val) out[key] = val;
  }
  if (!out.url && !out.msg && !out.x) return null;
  return out;
}
