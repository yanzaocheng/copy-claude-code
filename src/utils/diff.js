// Line diff (Myers O(ND)) and hunk construction for displaying edits.

export function diffLines(a, b) {
  const n = a.length, m = b.length;
  const max = n + m;
  if (max === 0) return [];
  // Guard against pathological sizes: fall back to delete-all / insert-all.
  if (n * m > 25_000_000) {
    return [...a.map((line) => ({ op: '-', line })), ...b.map((line) => ({ op: '+', line }))];
  }
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  const off = max + 1;
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // Backtrack.
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: ' ', line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ op: '+', line: b[y - 1] });
      else ops.push({ op: '-', line: a[x - 1] });
    }
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

// Build hunks with line numbers. Returns [{oldStart, newStart, lines:[{op, line, oldNo, newNo}]}]
export function makeHunks(ops, context = 3, oldOffset = 0, newOffset = 0) {
  let oldNo = oldOffset, newNo = newOffset;
  const numbered = ops.map((o) => {
    const r = { ...o, oldNo: null, newNo: null };
    if (o.op !== '+') r.oldNo = ++oldNo;
    if (o.op !== '-') r.newNo = ++newNo;
    return r;
  });
  const hunks = [];
  let cur = null;
  let lastChange = -Infinity;
  for (let i = 0; i < numbered.length; i++) {
    if (numbered[i].op === ' ') continue;
    const start = Math.max(0, i - context);
    if (cur && start <= lastChange + context + 1) {
      for (let j = lastChange + 1; j <= i; j++) cur.lines.push(numbered[j]);
    } else {
      if (cur) {
        for (let j = lastChange + 1; j <= Math.min(numbered.length - 1, lastChange + context); j++) cur.lines.push(numbered[j]);
        hunks.push(cur);
      }
      cur = { lines: numbered.slice(start, i + 1) };
    }
    lastChange = i;
  }
  if (cur) {
    for (let j = lastChange + 1; j <= Math.min(numbered.length - 1, lastChange + context); j++) cur.lines.push(numbered[j]);
    hunks.push(cur);
  }
  return hunks;
}

export function countChanges(ops) {
  let added = 0, removed = 0;
  for (const o of ops) {
    if (o.op === '+') added++;
    else if (o.op === '-') removed++;
  }
  return { added, removed };
}

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
