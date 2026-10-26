// Types for gifenc 1.0.3 (MIT, https://github.com/mattdesl/gifenc) — the package ships none.
declare module "gifenc" {
  export type GifFormat = "rgb565" | "rgb444" | "rgba4444";
  export type Palette = number[][];
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: GifFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: GifFormat): Uint8Array;
  export function nearestColorIndex(palette: Palette, pixel: number[]): number;
  export interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: Palette; first?: boolean; transparent?: boolean; transparentIndex?: number; delay?: number; repeat?: number; dispose?: number }): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoder;
}
