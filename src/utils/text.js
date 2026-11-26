// Text that can be sent: no half of a UTF-16 surrogate pair.
//
// A string cut with slice(0, n) can end in the first half of an emoji (\ud83d without its \udea8). JSON.stringify
// writes that half as a lone escape, "\ud83d", which strict JSON parsers refuse: the API answered "The request body is
// not valid JSON: unexpected end of hex escape" (2026-11-27, a tab title cut by the Browser tool), and as the half was
// in the conversation every request after it failed the same way.

// `value` (a string, or arrays and objects of them) with every lone half replaced by U+FFFD; the same value, not a
// copy, when there is none (the check is the engine's own, cheap even on a megabyte of base64).
export function wellFormed(value) {
  if (typeof value === 'string') return value.isWellFormed() ? value : value.toWellFormed();
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const v = wellFormed(value[i]);
      if (v !== value[i]) (out ??= value.slice())[i] = v;
    }
    return out || value;
  }
  if (value && typeof value === 'object') {
    let out = null;
    for (const k of Object.keys(value)) {
      const v = wellFormed(value[k]);
      if (v !== value[k]) (out ??= { ...value })[k] = v;
    }
    return out || value;
  }
  return value;
}

// `s` cut to `n` UTF-16 units at most with … at the end, never between the two halves of a pair.
export function cutText(s, n) {
  if (s.length <= n) return s;
  let k = Math.max(0, n - 1);
  const c = s.charCodeAt(k - 1);
  if (c >= 0xd800 && c <= 0xdbff) k--;
  return `${s.slice(0, k)}…`;
}
