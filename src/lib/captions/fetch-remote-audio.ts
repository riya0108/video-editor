/**
 * Resolves a YouTube/Instagram/TikTok/or other link to its audio track via
 * the server-side `/api/transcribe-source` route (backed by yt-dlp), so it
 * can be fed into the same in-browser Whisper pipeline used for uploads.
 */
export async function fetchRemoteAudio(url: string): Promise<Blob> {
  const res = await fetch("/api/transcribe-source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // response wasn't JSON — fall back to the generic message above
    }
    throw new Error(message);
  }

  return res.blob();
}
