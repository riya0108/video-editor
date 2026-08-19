import { Tensor } from "@huggingface/transformers";
import { pow, abs, quantile } from "./tensor-ext";

export function calculateRMS(t: Tensor): number {
  const squared = pow(t, 2);
  const meanTensor = squared.mean();
  return Number(pow(meanTensor, 0.5).item());
}

export function normalizeToInt16(t: Tensor, quantileP = 0.999): Tensor {
  const maxVal = Number(quantile(abs(t), quantileP).item());
  const scale = maxVal > 0 ? 32767 / maxVal : 1;
  return t.mul(scale).round().clamp(-32768, 32767).to("int16");
}
