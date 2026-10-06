// Minimal GLB reader for Node scripts (no three.js): returns world-space triangles.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGlb(path) {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const binLen = buf.readUInt32LE(20 + jsonLen);
  const bin = buf.subarray(binStart, binStart + binLen);
  return { json, bin };
}

function accessor(glb, idx) {
  const a = glb.json.accessors[idx];
  const bv = glb.json.bufferViews[a.bufferView];
  const Ctor = COMPONENT[a.componentType];
  const n = SIZE[a.type];
  const offset = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = bv.byteStride ?? 0;
  const out = new Float64Array(a.count * n);
  const ab = glb.bin.buffer.slice(glb.bin.byteOffset, glb.bin.byteOffset + glb.bin.byteLength);
  if (!stride || stride === n * Ctor.BYTES_PER_ELEMENT) {
    const arr = new Ctor(ab, offset, a.count * n);
    out.set(arr);
  } else {
    const dv = new DataView(ab);
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < n; k++) {
        const o = offset + i * stride + k * Ctor.BYTES_PER_ELEMENT;
        out[i * n + k] = Ctor === Float32Array ? dv.getFloat32(o, true) : dv.getUint16(o, true);
      }
    }
  }
  return { data: out, n, count: a.count };
}

function mat4FromTRS(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  // column-major
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function apply(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** Returns { tris: [{a,b,c, uva,uvb,uvc}], nodes: [{name, worldPos}] } */
export function worldTriangles(glb) {
  const tris = [];
  const nodes = [];
  const scene = glb.json.scenes[glb.json.scene ?? 0];
  const visit = (ni, parent, top) => {
    const node = glb.json.nodes[ni];
    const topName = top ?? node.name;
    const local = node.matrix ?? mat4FromTRS(node.translation, node.rotation, node.scale);
    const world = mul(parent, local);
    nodes.push({ name: node.name, worldPos: [world[12], world[13], world[14]] });
    if (node.mesh !== undefined) {
      for (const prim of glb.json.meshes[node.mesh].primitives) {
        const pos = accessor(glb, prim.attributes.POSITION);
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? accessor(glb, prim.attributes.TEXCOORD_0) : null;
        const idx = prim.indices !== undefined ? accessor(glb, prim.indices).data : Float64Array.from({ length: pos.count }, (_, i) => i);
        const P = (i) => apply(world, pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]);
        const U = (i) => (uv ? [uv.data[i * 2], uv.data[i * 2 + 1]] : [0, 0]);
        for (let i = 0; i < idx.length; i += 3) {
          tris.push({ a: P(idx[i]), b: P(idx[i + 1]), c: P(idx[i + 2]), uva: U(idx[i]), uvb: U(idx[i + 1]), uvc: U(idx[i + 2]), node: topName });
        }
      }
    }
    // children of a single root node are the meaningful parts (body, wheel-*)
    for (const c of node.children ?? []) visit(c, world, top ?? (scene.nodes.length === 1 && (node.children ?? []).length > 1 ? undefined : topName));
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const ni of scene.nodes) visit(ni, I, undefined);
  return { tris, nodes };
}

/** Bounding boxes of triangles grouped by top-level node name. */
export function nodeBoxes(tris) {
  const map = new Map();
  for (const t of tris) {
    let b = map.get(t.node);
    if (!b) map.set(t.node, (b = { name: t.node, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    for (const p of [t.a, t.b, t.c]) for (let i = 0; i < 3; i++) { b.min[i] = Math.min(b.min[i], p[i]); b.max[i] = Math.max(b.max[i], p[i]); }
  }
  return [...map.values()];
}

/** Vertical ray from above at (x,z): returns highest hit {y, uv} or null. */
export function castDown(tris, x, z) {
  let best = null;
  for (const t of tris) {
    const { a, b, c } = t;
    // barycentric in XZ plane
    const v0x = b[0] - a[0], v0z = b[2] - a[2];
    const v1x = c[0] - a[0], v1z = c[2] - a[2];
    const v2x = x - a[0], v2z = z - a[2];
    const den = v0x * v1z - v1x * v0z;
    if (Math.abs(den) < 1e-12) continue;
    const v = (v2x * v1z - v1x * v2z) / den;
    const w = (v0x * v2z - v2x * v0z) / den;
    const u = 1 - v - w;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const y = u * a[1] + v * b[1] + w * c[1];
    if (!best || y > best.y) {
      best = { y, uv: [u * t.uva[0] + v * t.uvb[0] + w * t.uvc[0], u * t.uva[1] + v * t.uvb[1] + w * t.uvc[1]] };
    }
  }
  return best;
}

/** Tiny PNG decoder (8-bit RGB/RGBA, non-interlaced). */
export function readPng(path) {
  const buf = readFileSync(path);
  let pos = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  let palette = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 0 ? 1 : 2;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return {
    width, height,
    sample(u, v) {
      const x = Math.min(width - 1, Math.max(0, Math.floor(u * width)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(v * height)));
      const i = y * stride + x * bpp;
      if (colorType === 3) { const p = out[i] * 3; return [palette[p], palette[p + 1], palette[p + 2]]; }
      if (colorType === 0) return [out[i], out[i], out[i]];
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}
