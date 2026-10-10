// On-demand route (opted out of static prerendering below) — the only part
// of this app that runs server-side. Resolves a YouTube/Instagram/TikTok/or
// other yt-dlp-supported link to its audio track so the browser can hand
// that to the same in-browser Whisper pipeline used for file uploads. The
// video/audio itself is never kept: it's extracted to a per-request temp
// dir, streamed back in the response, then deleted.
export const prerender = false;

import type { APIRoute } from "astro";
import { execFile } from "node:child_process";
import { resolvePublicHttpUrl } from "../../lib/net/public-url";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const YTDLP_TIMEOUT_MS = 120_000;
const MAX_SOURCE_DURATION_S = 60 * 60; // 1 hour — keeps extraction + client-side transcription time reasonable
const MAX_FILESIZE = "300M";

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "audio/webm",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  mkv: "video/x-matroska",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Rejects anything that isn't a plain http(s) URL to a public host — this endpoint accepts arbitrary user-supplied URLs
// and hands them to a shelled out process, so it must not be usable to probe the server's own network. The guard (and
// its residual risk: redirects / DNS rebinding need egress filtering at the deployment) lives in lib/net/public-url.ts.
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Expected a JSON body with a `url` field." }, 400);
  }

  const raw = typeof (body as { url?: unknown })?.url === "string" ? (body as { url: string }).url.trim() : "";
  const url = raw ? await resolvePublicHttpUrl(raw) : null;
  if (!url) {
    return jsonResponse({ error: "Enter a valid http(s) link." }, 400);
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "clipbench-transcript-"));
    const outputTemplate = join(dir, "audio.%(ext)s");

    await new Promise<void>((resolve, reject) => {
      execFile(
        "yt-dlp",
        [
          "--no-playlist",
          "--no-warnings",
          "--no-progress",
          "-f",
          "bestaudio/best",
          "--max-filesize",
          MAX_FILESIZE,
          "--match-filter",
          `duration <? ${MAX_SOURCE_DURATION_S}`,
          "--socket-timeout",
          "20",
          "-o",
          outputTemplate,
          url.toString(),
        ],
        { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(stderr?.toString().trim() || error.message));
          else resolve();
        },
      );
    });

    const files = await readdir(dir);
    const audioFile = files.find((f) => f.startsWith("audio."));
    if (!audioFile) {
      return jsonResponse({ error: "Couldn't find an audio track at that link." }, 502);
    }

    const ext = audioFile.split(".").pop()?.toLowerCase() ?? "";
    const data = await readFile(join(dir, audioFile));

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": AUDIO_MIME_BY_EXT[ext] ?? "application/octet-stream",
        "X-Source-Extension": ext,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/transcribe-source] yt-dlp failed:", message);

    if (/ENOENT/.test(message)) {
      return jsonResponse(
        { error: "yt-dlp isn't installed on the server. Install it (e.g. `brew install yt-dlp`) and restart the server." },
        500,
      );
    }
    if (/duration/i.test(message) && /filter/i.test(message)) {
      return jsonResponse({ error: "That video is too long (over 1 hour) to transcribe from a link." }, 422);
    }
    if (/Requested format is not available|Unsupported URL|is not a valid URL/i.test(message)) {
      return jsonResponse({ error: "Couldn't find a video at that link, or the site isn't supported." }, 422);
    }
    return jsonResponse({ error: "Couldn't download that link. Double-check the URL and try again." }, 502);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};
