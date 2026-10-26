/**
 * MATTE TRACK — a video's per-frame background-removal matte, stored compactly (RELEASE_BLOCKERS.md B-04/B-05).
 *
 * Every source frame of the clip has its own matte (no sample-and-hold). Each frame is stored as:
 *
 *   1. ALPHA ONLY, 8-bit: the matte is one channel; RGBA bitmaps spent 4 bytes per pixel on constant white.
 *   2. AT MOST MATTE_TRACK_MAX_SIDE on the long side (area-averaged). The model infers at 320x320 and the refined
 *      matte is smooth, so this is visually lossless — measured on the 720x1280 demo clip at half resolution:
 *      IoU 0.9992 and mean |Δα| 0.26/255 against the full-resolution matte after bilinear upsampling. The compositor
 *      already draws a matte through the layer's crop at whatever resolution it has (drawMediaCropped).
 *   3. NEAR-LOSSLESS PREDICTIVE CODING: planar prediction (left + up - upLeft) from the RECONSTRUCTED neighbours,
 *      residual quantized with a guaranteed max error of `quant` (default 1/255), then deflate. Decoding reproduces
 *      the encoder's reconstruction bit-exactly, so what the editor shows, what an export uses and what a reopened
 *      project shows are the same bytes. Temporal prediction was measured and doesn't help (the model's frame-to-frame
 *      noise costs more than it saves), so every frame decodes on its own — random access is one frame's work.
 *
 * Frames are grouped into chunks of MATTE_TRACK_CHUNK_FRAMES (one project blob each):
 *
 *   "CBMT"  u16 version  u16 quant  u32 width  u32 height  u32 firstFrame  u32 count  u32 length[count]
 *   payload[0] … payload[count-1]   (each a deflate-raw stream of `width*height` residual bytes)
 *
 * All integers little-endian. Pure (Uint8Array in/out; CompressionStream exists in browsers and Node ≥ 18).
 */

export const MATTE_TRACK_MAGIC = "CBMT";
export const MATTE_TRACK_VERSION = 1;
/** Longest stored side (px). */
export const MATTE_TRACK_MAX_SIDE = 640;
/** Frames per stored chunk (one project blob). */
export const MATTE_TRACK_CHUNK_FRAMES = 30;
/** Max |stored - computed| alpha error (of 255). */
export const MATTE_TRACK_QUANT = 1;
const HEADER_FIXED = 4 + 2 + 2 + 4 * 4;

export class MatteTrackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatteTrackError";
  }
}

/** Stored size for a matte of `width`x`height`: scaled so the long side is ≤ maxSide, never upscaled. */
export function matteStorageSize(width: number, height: number, maxSide = MATTE_TRACK_MAX_SIDE): { width: number; height: number } {
  const s = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/**
 * Continuous 0..1 alpha (w x h) -> 8-bit alpha (w2 x h2) by area averaging (exact box coverage, so non-integer ratios
 * don't alias). Identity when the sizes match.
 */
export function downsampleAlpha(alpha: Float32Array, w: number, h: number, w2: number, h2: number): Uint8Array {
  const out = new Uint8Array(w2 * h2);
  if (w === w2 && h === h2) {
    for (let i = 0; i < out.length; i++) {
      const a = alpha[i];
      out[i] = Math.round((a > 1 ? 1 : a < 0 ? 0 : a) * 255);
    }
    return out;
  }
  const sx = w / w2;
  const sy = h / h2;
  // Per output column: the source columns it covers and how much of each.
  const cols: { x: number; wt: number }[][] = [];
  for (let x = 0; x < w2; x++) cols.push(coverage(x * sx, (x + 1) * sx, w));
  const row = new Float64Array(w2);
  for (let y = 0; y < h2; y++) {
    row.fill(0);
    let wy = 0;
    for (const { x: yy, wt: ty } of coverage(y * sy, (y + 1) * sy, h)) {
      wy += ty;
      const base = yy * w;
      for (let x = 0; x < w2; x++) {
        let s = 0;
        for (const { x: xx, wt } of cols[x]) {
          const a = alpha[base + xx];
          s += (a > 1 ? 1 : a < 0 ? 0 : a) * wt;
        }
        row[x] += s * ty;
      }
    }
    for (let x = 0; x < w2; x++) {
      let wx = 0;
      for (const c of cols[x]) wx += c.wt;
      out[y * w2 + x] = Math.round((row[x] / (wx * wy)) * 255);
    }
  }
  return out;
}

function coverage(a: number, b: number, n: number): { x: number; wt: number }[] {
  const out: { x: number; wt: number }[] = [];
  for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i++) {
    const wt = Math.min(b, i + 1) - Math.max(a, i);
    if (wt > 1e-9) out.push({ x: i, wt });
  }
  return out;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Near-lossless predictive encode. Returns the residual bytes and the reconstruction the decoder will produce
 * (|recon - alpha| ≤ quant everywhere).
 */
export function encodeAlphaPlane(alpha: Uint8Array, width: number, height: number, quant = MATTE_TRACK_QUANT): { residuals: Uint8Array; recon: Uint8Array } {
  const q = 2 * quant + 1;
  const recon = new Uint8Array(width * height);
  const residuals = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const p = predict(recon, i, x, y, width);
      const e = alpha[i] - p;
      if (quant === 0) {
        // Lossless: modulo-256 residual (a -255..255 error doesn't fit a signed byte; mod 256 round-trips exactly).
        recon[i] = alpha[i];
        residuals[i] = e & 255;
        continue;
      }
      // |qe| ≤ 255/3 = 85 for quant ≥ 1, so it fits a signed byte.
      const qe = e >= 0 ? Math.floor((e + quant) / q) : -Math.floor((quant - e) / q);
      recon[i] = clamp255(p + qe * q);
      residuals[i] = qe & 255;
    }
  }
  return { residuals, recon };
}

export function decodeAlphaPlane(residuals: Uint8Array, width: number, height: number, quant = MATTE_TRACK_QUANT): Uint8Array {
  const q = 2 * quant + 1;
  const out = new Uint8Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const r = residuals[i];
      const p = predict(out, i, x, y, width);
      out[i] = quant === 0 ? (p + r) & 255 : clamp255(p + (r > 127 ? r - 256 : r) * q);
    }
  }
  return out;
}

function predict(r: Uint8Array, i: number, x: number, y: number, width: number): number {
  const l = x ? r[i - 1] : 0;
  const u = y ? r[i - width] : 0;
  const ul = x && y ? r[i - width - 1] : 0;
  return clamp255(l + u - ul);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
const deflate = (d: Uint8Array) => pipe(d, new CompressionStream("deflate-raw"));
const inflate = (d: Uint8Array) => pipe(d, new DecompressionStream("deflate-raw"));

export interface MatteChunkHeader {
  version: number;
  quant: number;
  width: number;
  height: number;
  firstFrame: number;
  count: number;
  /** Byte offset and length of each frame's payload within the chunk. */
  payloads: { offset: number; length: number }[];
}

/** Validates and reads a chunk header; throws MatteTrackError on anything malformed (a damaged blob is never half-read). */
export function parseChunkHeader(bytes: Uint8Array): MatteChunkHeader {
  if (bytes.length < HEADER_FIXED || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== MATTE_TRACK_MAGIC) throw new MatteTrackError("Not a matte track chunk.");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint16(4, true);
  if (version !== MATTE_TRACK_VERSION) throw new MatteTrackError(`Unsupported matte track version ${version}.`);
  const quant = v.getUint16(6, true);
  const width = v.getUint32(8, true);
  const height = v.getUint32(12, true);
  const firstFrame = v.getUint32(16, true);
  const count = v.getUint32(20, true);
  if (!(width > 0 && height > 0 && count > 0 && quant < 64) || width * height > 1 << 24) throw new MatteTrackError("Matte track chunk header is invalid.");
  let offset = HEADER_FIXED + 4 * count;
  if (offset > bytes.length) throw new MatteTrackError("Matte track chunk is truncated.");
  const payloads: { offset: number; length: number }[] = [];
  for (let k = 0; k < count; k++) {
    const length = v.getUint32(HEADER_FIXED + 4 * k, true);
    payloads.push({ offset, length });
    offset += length;
  }
  if (offset !== bytes.length) throw new MatteTrackError("Matte track chunk length doesn't match its header.");
  return { version, quant, width, height, firstFrame, count, payloads };
}

async function encodeChunk(width: number, height: number, quant: number, firstFrame: number, payloads: Uint8Array[]): Promise<Uint8Array> {
  const head = HEADER_FIXED + 4 * payloads.length;
  const out = new Uint8Array(head + payloads.reduce((s, p) => s + p.length, 0));
  const v = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MATTE_TRACK_MAGIC.charCodeAt(i);
  v.setUint16(4, MATTE_TRACK_VERSION, true);
  v.setUint16(6, quant, true);
  v.setUint32(8, width, true);
  v.setUint32(12, height, true);
  v.setUint32(16, firstFrame, true);
  v.setUint32(20, payloads.length, true);
  let offset = head;
  payloads.forEach((p, k) => {
    v.setUint32(HEADER_FIXED + 4 * k, p.length, true);
    out.set(p, offset);
    offset += p.length;
  });
  return out;
}

export interface MatteChunk {
  firstFrame: number;
  count: number;
  bytes: Uint8Array;
}

/**
 * Streams frames into chunks as they are matted, so generation holds only the compressed result (plus one chunk's
 * worth of payloads) however long the clip is. Frames are consecutive source frames starting at `firstFrame`.
 */
export class MatteTrackBuilder {
  private readonly chunks: MatteChunk[] = [];
  private pending: Uint8Array[] = [];
  private pendingFirst: number;
  private next: number;
  private last: Uint8Array | null = null;
  private bytes = 0;
  private readonly start: number;

  constructor(
    readonly width: number,
    readonly height: number,
    firstFrame: number,
    private readonly opts: { quant?: number; chunkFrames?: number } = {},
  ) {
    this.start = firstFrame;
    this.pendingFirst = firstFrame;
    this.next = firstFrame;
  }

  /** Adds the next frame's 8-bit alpha (width x height). Returns the reconstruction that will be shown. */
  async push(alpha: Uint8Array): Promise<Uint8Array> {
    if (alpha.length !== this.width * this.height) throw new MatteTrackError("Matte frame size doesn't match the track.");
    const { residuals, recon } = encodeAlphaPlane(alpha, this.width, this.height, this.quant);
    this.last = await deflate(residuals);
    await this.add(this.last);
    return recon;
  }

  /** Repeats the previous frame (a frame the engine failed on); false when there is none yet. */
  async repeatLast(): Promise<boolean> {
    if (!this.last) return false;
    await this.add(this.last);
    return true;
  }

  get frameCount(): number {
    return this.next - this.start;
  }

  /** Compressed bytes so far. */
  get byteLength(): number {
    return this.bytes + this.pending.reduce((s, p) => s + p.length, 0);
  }

  async finish(): Promise<MatteChunk[]> {
    await this.flush();
    return this.chunks;
  }

  private get quant() {
    return this.opts.quant ?? MATTE_TRACK_QUANT;
  }

  private async add(payload: Uint8Array) {
    this.pending.push(payload);
    this.next++;
    if (this.pending.length >= (this.opts.chunkFrames ?? MATTE_TRACK_CHUNK_FRAMES)) await this.flush();
  }

  private async flush() {
    if (this.pending.length === 0) return;
    const bytes = await encodeChunk(this.width, this.height, this.quant, this.pendingFirst, this.pending);
    this.chunks.push({ firstFrame: this.pendingFirst, count: this.pending.length, bytes });
    this.bytes += bytes.length;
    this.pendingFirst += this.pending.length;
    this.pending = [];
  }
}

/**
 * A complete matte track: random access to any frame's 8-bit alpha. Frames outside the track's range clamp to its
 * first / last frame (a clip trimmed wider than when it was matted shows the edge matte, never nothing).
 */
export class MatteTrack {
  readonly width: number;
  readonly height: number;
  readonly firstFrame: number;
  readonly frameCount: number;
  readonly byteLength: number;
  private readonly chunks: { header: MatteChunkHeader; bytes: Uint8Array }[];

  /** Validates every chunk: same size/quant, consecutive frames with no gap or overlap. */
  constructor(chunks: readonly Uint8Array[]) {
    if (chunks.length === 0) throw new MatteTrackError("A matte track needs at least one chunk.");
    const parsed = chunks.map((bytes) => ({ header: parseChunkHeader(bytes), bytes })).sort((a, b) => a.header.firstFrame - b.header.firstFrame);
    const h0 = parsed[0].header;
    let expect = h0.firstFrame;
    for (const { header: h } of parsed) {
      if (h.width !== h0.width || h.height !== h0.height || h.quant !== h0.quant) throw new MatteTrackError("Matte track chunks disagree on size.");
      if (h.firstFrame !== expect) throw new MatteTrackError(`Matte track is missing frames ${expect}–${h.firstFrame - 1}.`);
      expect += h.count;
    }
    this.chunks = parsed;
    this.width = h0.width;
    this.height = h0.height;
    this.firstFrame = h0.firstFrame;
    this.frameCount = expect - h0.firstFrame;
    this.byteLength = parsed.reduce((s, c) => s + c.bytes.length, 0);
  }

  /** The stored frame shown at `frame` (clamped into the track). */
  clampFrame(frame: number): number {
    return Math.min(this.firstFrame + this.frameCount - 1, Math.max(this.firstFrame, Math.round(frame)));
  }

  async decodeFrame(frame: number): Promise<Uint8Array> {
    const f = this.clampFrame(frame);
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid].header.firstFrame <= f) lo = mid;
      else hi = mid - 1;
    }
    const { header, bytes } = this.chunks[lo];
    const p = header.payloads[f - header.firstFrame];
    const residuals = await inflate(bytes.subarray(p.offset, p.offset + p.length));
    if (residuals.length !== this.width * this.height) throw new MatteTrackError(`Matte frame ${f} is damaged.`);
    return decodeAlphaPlane(residuals, this.width, this.height, header.quant);
  }
}

/** 8-bit alpha -> RGBA matte bytes (white, alpha = matte) — what the compositor's destination-in draws. */
export function alphaToRgba(alpha: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    out[j] = out[j + 1] = out[j + 2] = 255;
    out[j + 3] = alpha[i];
  }
  return out;
}
