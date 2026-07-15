#!/usr/bin/env node
// Generates assets/qr.svg — the link tree's QR code.
//
// Everything here is from scratch: encoder, Reed-Solomon, masking, and the
// logo knockout. Nothing ships to the browser; the output is a static SVG.
//
//   node tools/qr.mjs            build assets/qr.svg + print the damage report
//   node tools/qr.mjs --selftest cross-check the encoder against qrencode(1)
//
// The knockout is the interesting part. The OSDC logo is a wide wordmark
// (1191x633), so a square mask would blank a lot of modules that the letters
// never touch. Instead we rasterise the real silhouette, dilate it to give the
// glyphs breathing room, and drop only the modules it actually covers. Fewer
// dead modules means more error-correction budget left over, so the
// content-aware version is both better looking and easier to scan.
//
// Usage note: modules under the logo's *ink* still read dark, so a dark module
// beneath a stroke costs nothing. Only mismatches count as damage — see
// analyseDamage().

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ── configuration ───────────────────────────────────────────────────────── */

// Uppercase so the payload fits QR's alphanumeric mode (~5.5 bits/char instead
// of 8). Scheme and host are case-insensitive per RFC 3986, so scanners open
// this exactly like the lowercase form.
const PAYLOAD = "HTTPS://LINKS.OSDC.DEV";

// 0.40 is the largest the logo goes before every candidate version fails: v3/v4
// run out of correction budget, and v7-v10 all put an alignment pattern dead
// centre, which a centred logo would sit on top of. Damaging an alignment
// pattern breaks *detection*, which no amount of error correction recovers, so
// those versions are unusable here regardless of budget. That leaves v5/v6.
const LOGO_WIDTH_FRAC = Number(process.env.QR_LOGO_FRAC ?? 0.4); // logo width, as a fraction of the code's width
const DILATE_MODULES = Number(process.env.QR_DILATE ?? 0.35); // halo around the silhouette, in modules
const QUIET_ZONE = 4; // modules; 4 is the spec minimum
const MAX_BLOCK_DAMAGE = 0.6; // refuse to use more than this share of a block's `t`
const SUBSAMPLES = 8; // raster samples per module, per axis

const INK = "#101012";
const PAPER = "#ffffff";

/* ── version tables (ECC level H only — that's all we generate) ──────────── */

// [ecCodewordsPerBlock, blocksGroup1, dataPerBlockGroup1, blocksGroup2, dataPerBlockGroup2]
const RS_BLOCKS_H = {
  1: [17, 1, 9, 0, 0],
  2: [28, 1, 16, 0, 0],
  3: [22, 2, 13, 0, 0],
  4: [16, 4, 9, 0, 0],
  5: [22, 2, 11, 2, 12],
  6: [28, 4, 15, 0, 0],
  7: [26, 4, 13, 1, 14],
  8: [26, 4, 14, 2, 15],
  9: [24, 4, 12, 4, 13],
  10: [28, 6, 15, 2, 16],
};

const ALIGN_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const ECC_H_FORMAT_BITS = 0b10;

const sizeOf = (version) => version * 4 + 17;
const dataCodewords = (version) => {
  const [ec, b1, d1, b2, d2] = RS_BLOCKS_H[version];
  return b1 * d1 + b2 * d2;
};

/* ── GF(256) ─────────────────────────────────────────────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Generator polynomial for (x - a^0)(x - a^1)...(x - a^(degree-1)), returned
// highest-degree-first with the monic leading term dropped — the form
// rsRemainder() wants.
const divisorCache = new Map();
function rsDivisor(degree) {
  const cached = divisorCache.get(degree);
  if (cached) return cached;

  let poly = [1]; // accumulated lowest-degree-first
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]); // constant term of (x + a^i)
      next[j + 1] ^= poly[j]; // x term
    }
    poly = next;
  }
  const divisor = poly.slice(0, degree).reverse();
  divisorCache.set(degree, divisor);
  return divisor;
}

function rsRemainder(data, degree) {
  const gen = rsDivisor(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

/* ── encoding ────────────────────────────────────────────────────────────── */

function encodeAlphanumeric(text, version) {
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  for (const ch of text) {
    if (!ALNUM.includes(ch)) throw new Error(`'${ch}' is not alphanumeric-mode safe`);
  }

  push(0b0010, 4); // alphanumeric mode indicator
  push(text.length, version <= 9 ? 9 : 11); // char count

  for (let i = 0; i + 1 < text.length; i += 2) {
    push(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
  }
  if (text.length % 2) push(ALNUM.indexOf(text[text.length - 1]), 6);

  const capacityBits = dataCodewords(version) * 8;
  if (bits.length > capacityBits) return null;

  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0); // pad to a byte boundary

  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    bytes.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }
  // Alternating pad bytes, per spec.
  for (let pad = 0xec; bytes.length < dataCodewords(version); pad ^= 0xec ^ 0x11) {
    bytes.push(pad);
  }
  return bytes;
}

// Splits data into RS blocks, appends EC, and interleaves. Also returns, for
// each output codeword, which block it came from — analyseDamage() needs that
// to charge errors to the right block.
function buildCodewords(data, version) {
  const [ecLen, b1, d1, b2, d2] = RS_BLOCKS_H[version];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const chunk = data.slice(offset, offset + len);
    offset += len;
    blocks.push({ data: chunk, ec: rsRemainder(chunk, ecLen) });
  }

  const out = [];
  const owner = []; // out[i] belongs to block owner[i]
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    blocks.forEach((block, b) => {
      if (i < block.data.length) {
        out.push(block.data[i]);
        owner.push(b);
      }
    });
  }
  for (let i = 0; i < ecLen; i++) {
    blocks.forEach((block, b) => {
      out.push(block.ec[i]);
      owner.push(b);
    });
  }
  return { codewords: out, owner, blockCount: blocks.length, t: Math.floor(ecLen / 2) };
}

/* ── matrix ──────────────────────────────────────────────────────────────── */

function newMatrix(version) {
  const size = sizeOf(version);
  return {
    size,
    version,
    modules: Array.from({ length: size }, () => new Uint8Array(size)),
    isFunction: Array.from({ length: size }, () => new Uint8Array(size)),
    // codeword index owning each module, -1 for function/unused modules
    codewordAt: Array.from({ length: size }, () => new Int32Array(size).fill(-1)),
  };
}

function setFunction(m, x, y, dark) {
  m.modules[y][x] = dark ? 1 : 0;
  m.isFunction[y][x] = 1;
}

function drawFunctionPatterns(m) {
  const { size } = m;

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    setFunction(m, 6, i, i % 2 === 0);
    setFunction(m, i, 6, i % 2 === 0);
  }

  // Finders + separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(m, x, y, d !== 2 && d <= 3);
      }
    }
  }

  // Alignment patterns (skipping the three that collide with finders).
  const centers = ALIGN_CENTERS[m.version];
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder =
        (cx === 6 && cy === 6) ||
        (cx === 6 && cy === size - 7) ||
        (cx === size - 7 && cy === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format info is written later, but reserve its cells now.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunction(m, i, 8, false);
      setFunction(m, 8, i, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunction(m, size - 1 - i, 8, false);
    setFunction(m, 8, size - 1 - i, false);
  }
  setFunction(m, 8, size - 8, true); // always-dark module

  if (m.version >= 7) {
    for (let i = 0; i < 18; i++) {
      setFunction(m, i % 3 + size - 11, Math.floor(i / 3), false);
      setFunction(m, Math.floor(i / 3), i % 3 + size - 11, false);
    }
  }
}

function placeCodewords(m, codewords) {
  const { size } = m;
  let bit = 0;
  const total = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (m.isFunction[y][x] || bit >= total) continue;
        m.modules[y][x] = (codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        m.codewordAt[y][x] = bit >>> 3;
        bit++;
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y][x] && MASKS[mask](x, y)) m.modules[y][x] ^= 1;
    }
  }
}

function drawFormatBits(m, mask) {
  const data = (ECC_H_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const get = (i) => (bits >>> i) & 1;
  const { size } = m;

  for (let i = 0; i <= 5; i++) setFunction(m, 8, i, get(i));
  setFunction(m, 8, 7, get(6));
  setFunction(m, 8, 8, get(7));
  setFunction(m, 7, 8, get(8));
  for (let i = 9; i < 15; i++) setFunction(m, 14 - i, 8, get(i));

  for (let i = 0; i < 8; i++) setFunction(m, size - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) setFunction(m, 8, size - 15 + i, get(i));
  setFunction(m, 8, size - 8, true);
}

function drawVersionBits(m) {
  if (m.version < 7) return;
  let rem = m.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (m.version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(m, a, b, bit);
    setFunction(m, b, a, bit);
  }
}

/* ── mask penalty (ISO/IEC 18004 §8.8.2) ─────────────────────────────────── */

function penalty(m) {
  const { size, modules } = m;
  let score = 0;

  const runScore = (run) => (run >= 5 ? 3 + (run - 5) : 0);

  // N1: runs of 5+ same-colour modules, both directions.
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === modules[y][x - 1]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === modules[y - 1][x]) run++;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }

  // N2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y][x];
      if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // N3: finder-like 1:1:3:1:1 patterns with 4 modules of quiet space.
  const PATTERNS = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  const matches = (get) => {
    let hits = 0;
    for (let i = 0; i + 11 <= size; i++) {
      for (const pat of PATTERNS) {
        if (pat.every((v, j) => get(i + j) === v)) hits++;
      }
    }
    return hits;
  };
  for (let y = 0; y < size; y++) score += 40 * matches((i) => modules[y][i]);
  for (let x = 0; x < size; x++) score += 40 * matches((i) => modules[i][x]);

  // N4: deviation from a 50/50 dark ratio.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += modules[y][x];
  const ratio = (dark * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(ratio - 50) / 5);

  return score;
}

function buildMatrix(version, codewords, mask) {
  const m = newMatrix(version);
  drawFunctionPatterns(m);
  placeCodewords(m, codewords);
  drawVersionBits(m);
  applyMask(m, mask);
  drawFormatBits(m, mask);
  m.mask = mask;
  return m;
}

/* ── logo: parse, rasterise, dilate ──────────────────────────────────────── */

// Minimal SVG path reader: absolute/relative M L H V C Z, which is everything
// potrace emits. Curves are flattened into line segments — the raster is
// sampled at SUBSAMPLES per module, so segments finer than that are invisible.
const CURVE_STEPS = 16;

function parsePath(d) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  if (!tokens) throw new Error("logo path is empty");

  const edges = [];
  let cx = 0, cy = 0, sx = 0, sy = 0, cmd = null, i = 0;
  const num = () => parseFloat(tokens[i++]);

  const lineTo = (nx, ny) => {
    if (ny !== cy) edges.push({ x0: cx, y0: cy, x1: nx, y1: ny }); // horizontals never cross a scanline
    cx = nx;
    cy = ny;
  };

  const curveTo = (x1, y1, x2, y2, x, y) => {
    const px = cx, py = cy;
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS;
      const u = 1 - t;
      const bx = u * u * u * px + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x;
      const by = u * u * u * py + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y;
      lineTo(bx, by);
    }
  };

  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) throw new Error("path does not start with a command");

    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();

    if (C === "M") {
      let x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      cx = x; cy = y; sx = x; sy = y;
      cmd = rel ? "l" : "L"; // repeated pairs after a moveto are linetos
    } else if (C === "L") {
      let x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      lineTo(x, y);
    } else if (C === "H") {
      let x = num();
      if (rel) x += cx;
      lineTo(x, cy);
    } else if (C === "V") {
      let y = num();
      if (rel) y += cy;
      lineTo(cx, y);
    } else if (C === "C") {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
      curveTo(x1, y1, x2, y2, x, y);
    } else if (C === "Z") {
      lineTo(sx, sy);
    } else {
      throw new Error(`unsupported path command '${cmd}'`);
    }
  }
  return edges;
}

function loadLogo() {
  const svg = readFileSync(join(ROOT, "assets/logo.svg"), "utf8");
  const viewBox = svg.match(/viewBox="([\d.\s-]+)"/);
  const paths = [...svg.matchAll(/\sd="([^"]+)"/g)];
  if (!viewBox || paths.length === 0) throw new Error("could not read assets/logo.svg");
  const [, , vw, vh] = viewBox[1].trim().split(/\s+/).map(Number);
  const edges = paths.flatMap((p) => parsePath(p[1]));
  return { vw, vh, edges };
}

// Even-odd scanline fill, then a disc dilation. Returns a boolean grid at
// SUBSAMPLES resolution covering the whole code.
function rasteriseLogo(logo, size) {
  const R = size * SUBSAMPLES;
  const grid = new Uint8Array(R * R);

  const w = size * LOGO_WIDTH_FRAC;
  const h = (w * logo.vh) / logo.vw;
  const x0 = (size - w) / 2;
  const y0 = (size - h) / 2;

  const bounds = { x0, y0, x1: x0 + w, y1: y0 + h, w, h };

  for (let py = 0; py < R; py++) {
    const my = (py + 0.5) / SUBSAMPLES; // module-space y
    if (my < y0 || my > y0 + h) continue;
    const ly = ((my - y0) / h) * logo.vh; // logo-space y

    // Even-odd crossings against this scanline.
    const xs = [];
    for (const e of logo.edges) {
      const { x0, y0, x1, y1 } = e;
      if ((y0 <= ly && ly < y1) || (y1 <= ly && ly < y0)) {
        xs.push(x0 + ((ly - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    for (let k = 0; k + 1 < xs.length; k += 2) {
      const mxa = x0 + (xs[k] / logo.vw) * w;
      const mxb = x0 + (xs[k + 1] / logo.vw) * w;
      const pa = Math.max(0, Math.ceil(mxa * SUBSAMPLES - 0.5));
      const pb = Math.min(R - 1, Math.floor(mxb * SUBSAMPLES - 0.5));
      for (let px = pa; px <= pb; px++) grid[py * R + px] = 1;
    }
  }

  return { ink: grid, R, bounds };
}

function dilate(grid, R, radiusPx) {
  const out = new Uint8Array(R * R);
  const r = Math.ceil(radiusPx);
  const offsets = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= radiusPx * radiusPx) offsets.push([dx, dy]);
    }
  }
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      if (!grid[y * R + x]) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < R && ny >= 0 && ny < R) out[ny * R + nx] = 1;
      }
    }
  }
  return out;
}

/* ── occlusion + damage ──────────────────────────────────────────────────── */

function computeOcclusion(m, raster, halo) {
  const { size } = m;
  const { R, ink } = raster;
  const knockedOut = Array.from({ length: size }, () => new Uint8Array(size));
  const inkAtCentre = Array.from({ length: size }, () => new Uint8Array(size));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Knock the module out if the halo touches it anywhere.
      let touched = false;
      for (let sy = 0; sy < SUBSAMPLES && !touched; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          if (halo[(y * SUBSAMPLES + sy) * R + (x * SUBSAMPLES + sx)]) {
            touched = true;
            break;
          }
        }
      }
      knockedOut[y][x] = touched ? 1 : 0;

      // A decoder samples the module centre — that's what decides its value.
      const cx = x * SUBSAMPLES + SUBSAMPLES / 2;
      const cy = y * SUBSAMPLES + SUBSAMPLES / 2;
      inkAtCentre[y][x] = ink[Math.floor(cy) * R + Math.floor(cx)] ? 1 : 0;
    }
  }
  return { knockedOut, inkAtCentre };
}

// A knocked-out module renders as paper unless the logo's ink covers its
// centre. Damage is only where that rendering disagrees with the intended
// module — so ink sitting on a dark module is free, and blanking an already
// light module costs nothing either.
function analyseDamage(m, occ, owner, blockCount) {
  const { size, modules, isFunction, codewordAt } = m;
  const damagedCodewords = new Set();
  const collisions = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!occ.knockedOut[y][x]) continue;
      if (isFunction[y][x]) {
        collisions.push([x, y]);
        continue;
      }
      const rendered = occ.inkAtCentre[y][x] ? 1 : 0;
      if (rendered !== modules[y][x]) {
        const cw = codewordAt[y][x];
        if (cw >= 0) damagedCodewords.add(cw);
      }
    }
  }

  const perBlock = new Array(blockCount).fill(0);
  for (const cw of damagedCodewords) perBlock[owner[cw]]++;
  return { perBlock, damagedCodewords, collisions };
}

/* ── SVG output ──────────────────────────────────────────────────────────── */

function toSvg(m, occ, logo, raster) {
  const { size, modules } = m;
  const total = size + QUIET_ZONE * 2;
  const parts = [];

  // One merged path for every drawn module — keeps the file small.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x] || occ.knockedOut[y][x]) continue;
      parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
    }
  }

  const { bounds } = raster;
  const scale = bounds.w / logo.vw;
  const tx = bounds.x0 + QUIET_ZONE;
  const ty = bounds.y0 + QUIET_ZONE;

  const logoPaths = readFileSync(join(ROOT, "assets/logo.svg"), "utf8")
    .match(/\sd="([^"]+)"/g)
    .map((d) => d.trim().slice(3, -1));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * 8}" height="${total * 8}" shape-rendering="crispEdges" role="img" aria-label="QR code linking to links.osdc.dev">
  <rect width="${total}" height="${total}" fill="${PAPER}"/>
  <path fill="${INK}" d="${parts.join("")}"/>
  <g transform="translate(${tx.toFixed(4)} ${ty.toFixed(4)}) scale(${scale.toFixed(6)})">
${logoPaths.map((d) => `    <path fill="${INK}" fill-rule="evenodd" d="${d}"/>`).join("\n")}
  </g>
</svg>
`;
}

/* ── selftest: compare against qrencode(1) ───────────────────────────────── */

// qrencode picks its own mask, so we assert its matrix equals one of our eight.
// That checks encoding, ECC, and placement against an independent implementation.
function selftest() {
  let failures = 0;

  for (const text of [PAYLOAD, "HELLO WORLD", "HTTPS://OSDC.DEV", "ABC123$%*+-./:"]) {
    let version = 1;
    let data = null;
    while (version <= 10 && !(data = encodeAlphanumeric(text, version))) version++;
    if (!data) {
      console.log(`  SKIP  ${text} (does not fit v1-10 at ECC H)`);
      continue;
    }

    const ref = execFileSync("qrencode", ["-l", "H", "-v", String(version), "-t", "ASCII", "--", text], {
      encoding: "utf8",
    });
    // qrencode's ASCII output uses '#' for dark, two chars per module, and a
    // 4-module quiet zone.
    const refRows = ref
      .split("\n")
      .filter((r) => r.length > 0)
      .map((r) => {
        const cells = [];
        for (let i = 0; i < r.length; i += 2) cells.push(r[i] === "#" ? 1 : 0);
        return cells;
      });
    const trimmed = refRows.slice(QUIET_ZONE, refRows.length - QUIET_ZONE)
      .map((r) => r.slice(QUIET_ZONE, r.length - QUIET_ZONE));

    const { codewords } = buildCodewords(data, version);
    const ours = [];
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(version, codewords, mask);
      ours.push(m.modules.map((row) => Array.from(row)));
    }
    const hit = ours.findIndex(
      (mat) =>
        mat.length === trimmed.length &&
        mat.every((row, y) => row.length === trimmed[y].length && row.every((v, x) => v === trimmed[y][x]))
    );

    if (hit >= 0) {
      console.log(`  ok    "${text}" v${version}-H matches qrencode (mask ${hit})`);
    } else {
      console.log(`  FAIL  "${text}" v${version}-H does not match qrencode under any mask`);
      failures++;
    }
  }
  if (failures) {
    console.error(`\n${failures} selftest failure(s)`);
    process.exit(1);
  }
  console.log("\nencoder agrees with qrencode on every case");
}

/* ── build ───────────────────────────────────────────────────────────────── */

function build() {
  const logo = loadLogo();

  for (let version = 1; version <= 10; version++) {
    const data = encodeAlphanumeric(PAYLOAD, version);
    if (!data) continue;

    const { codewords, owner, blockCount, t } = buildCodewords(data, version);

    // Pick the mask by the spec's penalty rules first, then measure the logo
    // damage on that matrix.
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(version, codewords, mask);
      const score = penalty(m);
      if (!best || score < best.score) best = { m, score, mask };
    }

    const raster = rasteriseLogo(logo, best.m.size);
    const halo = dilate(raster.ink, raster.R, DILATE_MODULES * SUBSAMPLES);
    const occ = computeOcclusion(best.m, raster, halo);
    const { perBlock, damagedCodewords, collisions } = analyseDamage(best.m, occ, owner, blockCount);

    const worst = Math.max(...perBlock);
    const usage = worst / t;

    const label = `v${version}-H (${best.m.size}x${best.m.size})`;
    if (collisions.length) {
      console.log(`  ${label}: logo overlaps ${collisions.length} function module(s) — rejected`);
      continue;
    }
    if (usage > MAX_BLOCK_DAMAGE) {
      console.log(
        `  ${label}: worst block ${worst}/${t} errors (${(usage * 100).toFixed(0)}% of capacity) — too tight`
      );
      continue;
    }

    // Accepted.
    let knocked = 0;
    for (let y = 0; y < best.m.size; y++) {
      for (let x = 0; x < best.m.size; x++) knocked += occ.knockedOut[y][x];
    }

    console.log(`  ${label}: accepted\n`);
    console.log(`  payload            ${PAYLOAD} (alphanumeric, ${PAYLOAD.length} chars)`);
    console.log(`  mask               ${best.mask} (penalty ${best.score})`);
    console.log(`  blocks             ${blockCount} x (${RS_BLOCKS_H[version][0]} EC codewords, t=${t})`);
    console.log(`  modules blanked    ${knocked} of ${best.m.size ** 2} (${((knocked / best.m.size ** 2) * 100).toFixed(1)}%)`);
    console.log(`  codewords damaged  ${damagedCodewords.size} of ${codewords.length}`);
    console.log(`  errors per block   ${perBlock.join(", ")}  (capacity ${t} each)`);
    console.log(`  worst block        ${worst}/${t} = ${(usage * 100).toFixed(0)}% of correction capacity`);
    console.log(`  headroom           ${t - worst} more codeword errors tolerated in the worst block`);

    const svg = toSvg(best.m, occ, logo, raster);
    writeFileSync(join(ROOT, "assets/qr.svg"), svg);
    console.log(`\n  wrote assets/qr.svg (${(svg.length / 1024).toFixed(1)} KB)`);
    return;
  }

  console.error("no version in 1-10 could carry the payload with the logo knockout");
  process.exit(1);
}

export { encodeAlphanumeric, buildCodewords, buildMatrix, penalty, loadLogo };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--selftest") selftest();
  else build();
}
