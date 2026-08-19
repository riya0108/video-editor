import { Tensor } from "@huggingface/transformers";

type TypedArray = Float32Array | Float64Array | Int16Array | Int32Array;

/** Element-wise power — `@huggingface/transformers`'s Tensor doesn't ship one. */
export function pow(t: Tensor, exponent: number): Tensor {
  const data = t.data as TypedArray;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.pow(Number(data[i]), exponent);
  return new Tensor("float32", out, t.dims);
}

/** Element-wise absolute value. */
export function abs(t: Tensor): Tensor {
  const data = t.data as TypedArray;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.abs(Number(data[i]));
  return new Tensor("float32", out, t.dims);
}

/** Linear-interpolation quantile over every element (matches numpy/torch's default). Returns a scalar tensor. */
export function quantile(t: Tensor, q: number): Tensor {
  const sorted = Array.from(t.data as TypedArray, Number).sort((a, b) => a - b);
  if (sorted.length === 0) return new Tensor("float32", new Float32Array([0]), [1]);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  return new Tensor("float32", new Float32Array([value]), [1]);
}
