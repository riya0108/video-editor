import { useState } from "react";
import { Download, Link2, RotateCcw, Share2, Check, Info } from "lucide-react";

export default function ResultPanel({
  url,
  blob,
  filename,
  kind,
  previewNote,
  onReset,
}: {
  url: string;
  blob: Blob;
  filename: string;
  kind: "video" | "audio" | "image";
  /**
   * When set, skips the inline `<video>`/`<audio>` player entirely and shows
   * this note instead — for formats known upfront not to preview in a
   * browser (e.g. a qtrle/alpha .mov), so the result looks intentional
   * instead of broken. `videoPreviewFailed` below is the reactive fallback
   * for formats that turn out not to preview but weren't flagged in advance.
   */
  previewNote?: string;
  onReset: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [videoPreviewFailed, setVideoPreviewFailed] = useState(false);

  const flash = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 2400);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      flash("Link copied to clipboard");
    } catch {
      flash("Couldn't copy the link");
    }
  };

  const share = async () => {
    const file = new File([blob], filename, { type: blob.type });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
      if (navigator.share) {
        await navigator.share({ url: window.location.href, title: document.title });
        flash("Your browser can't share files directly, so we shared a link to this tool");
        return;
      }
      await copyLink();
      flash("Sharing isn't supported here — link to this tool copied instead");
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") flash("Sharing was cancelled or failed");
    }
  };

  const showPreviewNote = kind === "video" && (!!previewNote || videoPreviewFailed);

  return (
    <div className="animate-fade-in rounded-xl border border-(--color-border) bg-(--color-surface) p-5 shadow-sm">
      <div className="flex items-center gap-2 text-success-600">
        <Check size={18} />
        <p className="font-semibold">Your file is ready</p>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg bg-black">
        {kind === "video" ? (
          showPreviewNote ? (
            // Some export formats (e.g. a qtrle/alpha .mov) aren't a codec
            // any browser can decode inline — the file itself is still
            // valid, so this is an upfront explanation, not an error state.
            <div className="flex items-start gap-2.5 p-6 text-body-sm text-white/80">
              <Info size={16} className="mt-0.5 shrink-0 text-white/50" />
              <p>{previewNote ?? "This browser can't preview this format inline, but the file exported fine — download it to use it."}</p>
            </div>
          ) : (
            <video src={url} controls className="max-h-96 w-full" onError={() => setVideoPreviewFailed(true)} />
          )
        ) : kind === "image" ? (
          <img src={url} alt="" className="mx-auto max-h-96 w-auto" />
        ) : (
          <audio src={url} controls className="w-full p-4" />
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <a
          href={url}
          download={filename}
          className="inline-flex items-center gap-2 rounded-full bg-primary-500 px-5 py-2.5 text-body-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-600"
        >
          <Download size={16} />
          Download
        </a>
        <button
          type="button"
          onClick={share}
          className="inline-flex items-center gap-2 rounded-full border border-(--color-border) px-5 py-2.5 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
        >
          <Share2 size={16} />
          Share
        </button>
        <button
          type="button"
          onClick={copyLink}
          className="inline-flex items-center gap-2 rounded-full border border-(--color-border) px-5 py-2.5 text-body-sm font-semibold transition-colors hover:border-(--color-border-strong) hover:bg-(--color-bg-subtle)"
        >
          <Link2 size={16} />
          Copy link
        </button>
        <button
          type="button"
          onClick={onReset}
          className="ml-auto inline-flex items-center gap-2 text-body-sm font-medium text-(--color-text-muted) hover:text-(--color-text)"
        >
          <RotateCcw size={14} />
          Start over
        </button>
      </div>

      {notice && <p className="mt-3 text-body-sm text-(--color-text-muted)">{notice}</p>}
    </div>
  );
}
