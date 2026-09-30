/**
 * 4-connected flood-fill labeling over a binary mask — the shared primitive
 * behind small-hole and small-island cleanup (cleanup.ts). Iterative
 * (explicit stack), not recursive, so it doesn't blow the call stack on a
 * large image with one giant connected region.
 */
export interface ConnectedComponents {
  /** -1 for a pixel not in the mask; otherwise its component's index. */
  labels: Int32Array;
  /** Pixel count of each component, indexed by label. */
  sizes: number[];
  /** True if that component touches the image border — used to distinguish a genuine enclosed hole from the actual surrounding background/frame edge. */
  touchesBorder: boolean[];
  /** Every pixel index belonging to each component, indexed by label — lets a caller (e.g. cleanup.ts's fine-detail overlap check) inspect a component's actual pixels without a second labeling pass. */
  pixelsByLabel: number[][];
}

export function labelConnectedComponents(mask: Uint8Array, width: number, height: number): ConnectedComponents {
  const labels = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const touchesBorder: boolean[] = [];
  const pixelsByLabel: number[][] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || labels[start] !== -1) continue;

    const label = sizes.length;
    const pixels: number[] = [];
    let border = false;
    stack.push(start);
    labels[start] = label;

    while (stack.length > 0) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % width;
      const y = (i / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;

      if (x > 0) {
        const n = i - 1;
        if (mask[n] !== 0 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (x < width - 1) {
        const n = i + 1;
        if (mask[n] !== 0 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (y > 0) {
        const n = i - width;
        if (mask[n] !== 0 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
      if (y < height - 1) {
        const n = i + width;
        if (mask[n] !== 0 && labels[n] === -1) {
          labels[n] = label;
          stack.push(n);
        }
      }
    }

    sizes.push(pixels.length);
    touchesBorder.push(border);
    pixelsByLabel.push(pixels);
  }

  return { labels, sizes, touchesBorder, pixelsByLabel };
}
