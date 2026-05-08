// Memo parsing.
//
// Expected memo format:
//   url=<host>[/path] | msg=<message>
//
// Whitespace around the separator is tolerated. Both fields are required;
// memos missing either are rejected. Returns { url, msg } or null.

const MEMO_RE = /^\s*url\s*=\s*([^|]+?)\s*\|\s*msg\s*=\s*(.+?)\s*$/i;

export function parseMemo(raw) {
  if (typeof raw !== 'string') return null;
  const m = MEMO_RE.exec(raw);
  if (!m) return null;
  return { url: m[1].trim(), msg: m[2].trim() };
}
