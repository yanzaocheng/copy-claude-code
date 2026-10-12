// QR codes in the terminal: /status prints one of the session's page, so that a phone opens it by pointing its camera
// at the screen. Byte mode, error correction level L, versions 1-6 (up to 134 bytes, which a URL with a token
// fits in easily); the mask is chosen with the standard penalty rules.

// [EC codewords per block, blocks, data codewords per block] at level L, by version.
const EC_L = [null, [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108], [18, 2, 68]];
const MAX_VERSION = 6;

// GF(256) with the polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsRemainder(data, n) {
  let gen = [1]; // (x - a^0)(x - a^1)...(x - a^(n-1)), highest degree first
  for (let i = 0; i < n; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
    gen = next;
  }
  const rem = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

function codewords(bytes, version) {
  const [ecLen, blocks, dataLen] = EC_L[version];
  const capacity = blocks * dataLen;
  const bits = [];
  const put = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < blocks; b++) {
    const d = data.slice(b * dataLen, (b + 1) * dataLen);
    dataBlocks.push(d);
    ecBlocks.push(rsRemainder(d, ecLen));
  }
  const out = [];
  for (let i = 0; i < dataLen; i++) for (const d of dataBlocks) out.push(d[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecBlocks) out.push(e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m) {
  const n = m.length;
  let score = 0;
  let dark = 0;
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(m[i]);
    lines.push(m.map((row) => row[i]));
  }
  for (const line of lines) {
    for (let i = 0; i < n;) {
      let j = i;
      while (j < n && line[j] === line[i]) j++;
      if (j - i >= 5) score += 3 + (j - i - 5);
      i = j;
    }
    const s = line.map((v) => (v ? 1 : 0)).join('');
    for (const p of ['10111010000', '00001011101']) for (let k = s.indexOf(p); k >= 0; k = s.indexOf(p, k + 1)) score += 40;
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  return score + 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
}

// The modules of the QR code for `text` (rows of booleans, true = dark), or null when it is too long.
// `mask`: use this mask (0-7) instead of the best one.
export function qrMatrix(text, { mask: forcedMask } = {}) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 1;
  while (version <= MAX_VERSION && EC_L[version][1] * EC_L[version][2] * 8 < 12 + 8 * bytes.length) version++;
  if (version > MAX_VERSION) return null;
  const size = 17 + 4 * version;
  const base = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (m, x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(base, x, y, d !== 2 && d !== 4);
      }
    }
  }
  for (let i = 0; i < size; i++) {
    if (!fn[6][i]) set(base, i, 6, i % 2 === 0);
    if (!fn[i][6]) set(base, 6, i, i % 2 === 0);
  }
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(base, c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (m, mask) => {
    const data = (1 << 3) | mask; // level L = 01
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(m, 8, i, bit(i));
    set(m, 8, 7, bit(6));
    set(m, 8, 8, bit(7));
    set(m, 7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(m, 14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(m, size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(m, 8, size - 15 + i, bit(i));
    set(m, 8, size - 8, true);
  };
  drawFormat(base, 0); // reserves the format areas before the data goes in

  const data = codewords(bytes, version);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        if (bitIndex < data.length * 8) base[y][x] = ((data[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex++;
      }
    }
  }

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forcedMask !== undefined && mask !== forcedMask) continue;
    const m = base.map((row, y) => row.map((v, x) => (fn[y][x] ? v : v !== MASKS[mask](x, y))));
    drawFormat(m, mask);
    const score = forcedMask !== undefined ? 0 : penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m;
}

// The QR code as terminal lines, two rows of modules per line. With colors it is drawn black on white whatever the
// terminal's theme; without, it assumes a dark background (light modules are the drawn ones). Null when too long.
export function qrLines(text, { color = true, quiet = 2 } = {}) {
  const m = qrMatrix(text);
  if (!m) return null;
  const n = m.length + quiet * 2;
  const dark = (x, y) => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my][mx];
  };
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    let last = null;
    for (let x = 0; x < n; x++) {
      const top = dark(x, y);
      const bottom = y + 1 < n && dark(x, y + 1);
      if (color) {
        const sgr = `\x1b[${top ? 30 : 97};${bottom ? 40 : 107}m`;
        if (sgr !== last) { line += sgr; last = sgr; }
        line += '▀';
      } else {
        line += !top && !bottom ? '█' : !top ? '▀' : !bottom ? '▄' : ' ';
      }
    }
    lines.push(color ? `${line}\x1b[0m` : line);
  }
  return lines;
}
