const CACHE_NAME = "clipbench-tts-models-v1";

function hfResolveUrl(repoId: string, filename: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${filename}`;
}

/** Downloads a file from a Hugging Face model repo, caching it in the browser's Cache Storage so repeat visits don't re-download the (large) model weights. */
export async function downloadModelFile(
  repoId: string,
  filename: string,
  onProgress?: (fraction: number) => void,
): Promise<Uint8Array> {
  const url = hfResolveUrl(repoId, filename);
  const cache = await caches.open(CACHE_NAME).catch(() => null);

  const cached = await cache?.match(url);
  if (cached) {
    const buf = await cached.arrayBuffer();
    onProgress?.(1);
    return new Uint8Array(buf);
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${filename} (${response.status})`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && onProgress) onProgress(received / total);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  if (cache) {
    await cache.put(url, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } })).catch(() => {});
  }

  return bytes;
}

export async function downloadModelText(repoId: string, filename: string): Promise<string> {
  const bytes = await downloadModelFile(repoId, filename);
  return new TextDecoder().decode(bytes);
}
