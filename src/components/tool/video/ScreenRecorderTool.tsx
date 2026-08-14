import { useEffect, useRef, useState } from "react";
import { Mic, MonitorPlay } from "lucide-react";
import ResultPanel from "../ResultPanel";
import RecorderControls from "../media/RecorderControls";
import { useMediaRecorder } from "../../../lib/hooks/useMediaRecorder";
import { mixMicIntoStream, stopAllTracks } from "../../../lib/media/mix-audio";
import {
  VIDEO_RECORDER_MIME_CANDIDATES,
  extensionForMimeType,
  pickSupportedMimeType,
} from "../../../lib/media/pick-mime-type";

export default function ScreenRecorderTool() {
  const recorder = useMediaRecorder();
  const [includeMic, setIncludeMic] = useState(true);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);

  const previewRef = useRef<HTMLVideoElement>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    setIsSupported(typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia);
  }, []);

  const cleanupStreams = () => {
    stopAllTracks(displayStreamRef.current, micStreamRef.current);
    displayStreamRef.current = null;
    micStreamRef.current = null;
  };

  const start = async () => {
    setPermissionError(null);
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
      displayStreamRef.current = displayStream;

      let recordStream = displayStream;
      if (includeMic) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micStreamRef.current = micStream;
          recordStream = mixMicIntoStream(displayStream, micStream);
        } catch {
          // Mic denied or unavailable — fall back to screen-only audio.
        }
      }

      if (previewRef.current) previewRef.current.srcObject = displayStream;

      const mimeType = pickSupportedMimeType(VIDEO_RECORDER_MIME_CANDIDATES);
      recorder.start(recordStream, mimeType);

      displayStream.getVideoTracks()[0].onended = () => {
        recorder.stop();
        cleanupStreams();
      };
    } catch {
      setPermissionError(
        "Screen recording needs your permission. Click Start, then choose a screen, window, or tab to share.",
      );
    }
  };

  const stop = () => {
    recorder.stop();
    cleanupStreams();
  };

  const reset = () => {
    cleanupStreams();
    recorder.reset();
  };

  useEffect(() => cleanupStreams, []);

  if (!isSupported) {
    return (
      <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-8 text-center">
        <p className="font-semibold">Screen recording isn&rsquo;t supported in this browser.</p>
        <p className="mt-1 text-body-sm text-(--color-text-muted)">
          Try the latest Chrome, Edge, or Firefox on desktop.
        </p>
      </div>
    );
  }

  if (recorder.result) {
    const ext = extensionForMimeType(recorder.result.blob.type);
    return (
      <ResultPanel
        url={recorder.result.url}
        blob={recorder.result.blob}
        filename={`screen-recording.${ext}`}
        kind="video"
        onReset={reset}
      />
    );
  }

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5 shadow-sm">
      <div className="overflow-hidden rounded-lg bg-black">
        {recorder.state === "idle" ? (
          <div className="flex h-96 flex-col items-center justify-center gap-3 text-white/70">
            <MonitorPlay size={40} />
            <p className="text-body-sm">Your screen will appear here once recording starts</p>
          </div>
        ) : (
          <video ref={previewRef} autoPlay muted playsInline className="max-h-96 w-full" />
        )}
      </div>

      {recorder.state === "idle" && (
        <label className="mt-4 flex items-center justify-center gap-2 text-body-sm text-(--color-text-muted)">
          <input
            type="checkbox"
            checked={includeMic}
            onChange={(e) => setIncludeMic(e.target.checked)}
            className="accent-(--color-primary-500)"
          />
          <Mic size={14} />
          Include microphone audio
        </label>
      )}

      {(permissionError || recorder.error) && (
        <p className="mt-4 text-center text-body-sm text-danger-600">
          {permissionError ?? recorder.error}
        </p>
      )}

      <div className="mt-5">
        <RecorderControls
          state={recorder.state}
          elapsedMs={recorder.elapsedMs}
          onStart={start}
          onPause={recorder.pause}
          onResume={recorder.resume}
          onStop={stop}
          startLabel="Start screen recording"
        />
      </div>
    </div>
  );
}
