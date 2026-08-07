import { useEffect, useRef, useState } from "react";
import { Camera, Mic, Video } from "lucide-react";
import ResultPanel from "../ResultPanel";
import RecorderControls from "../media/RecorderControls";
import { useMediaRecorder } from "../../../lib/hooks/useMediaRecorder";
import { useMediaDevices } from "../../../lib/hooks/useMediaDevices";
import { stopAllTracks } from "../../../lib/media/mix-audio";
import {
  VIDEO_RECORDER_MIME_CANDIDATES,
  extensionForMimeType,
  pickSupportedMimeType,
} from "../../../lib/media/pick-mime-type";

export default function VideoRecorderTool() {
  const recorder = useMediaRecorder();
  const { devices: cameras, refresh: refreshCameras } = useMediaDevices("videoinput");
  const { devices: mics, refresh: refreshMics } = useMediaDevices("audioinput");

  const [hasPreview, setHasPreview] = useState(false);
  const [cameraId, setCameraId] = useState<string>("");
  const [micId, setMicId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const openPreview = async (constraints?: { videoId?: string; audioId?: string }) => {
    setError(null);
    try {
      stopAllTracks(streamRef.current);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: constraints?.videoId ? { deviceId: { exact: constraints.videoId } } : true,
        audio: constraints?.audioId ? { deviceId: { exact: constraints.audioId } } : true,
      });
      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;
      setHasPreview(true);

      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      if (videoTrack) setCameraId(videoTrack.getSettings().deviceId ?? "");
      if (audioTrack) setMicId(audioTrack.getSettings().deviceId ?? "");

      await refreshCameras();
      await refreshMics();
    } catch {
      setError("Camera access needs your permission. Click Enable camera and allow access.");
    }
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    const mimeType = pickSupportedMimeType(VIDEO_RECORDER_MIME_CANDIDATES);
    recorder.start(streamRef.current, mimeType);
  };

  const stopRecording = () => {
    recorder.stop();
    stopAllTracks(streamRef.current);
    streamRef.current = null;
    setHasPreview(false);
  };

  const reset = () => {
    stopAllTracks(streamRef.current);
    streamRef.current = null;
    setHasPreview(false);
    recorder.reset();
  };

  useEffect(() => () => stopAllTracks(streamRef.current), []);

  if (recorder.result) {
    const ext = extensionForMimeType(recorder.result.blob.type);
    return (
      <ResultPanel
        url={recorder.result.url}
        blob={recorder.result.blob}
        filename={`webcam-recording.${ext}`}
        kind="video"
        onReset={reset}
      />
    );
  }

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-5">
      <div className="overflow-hidden rounded-lg bg-black">
        {hasPreview ? (
          <video ref={previewRef} autoPlay muted playsInline className="max-h-96 w-full -scale-x-100" />
        ) : (
          <div className="flex h-96 flex-col items-center justify-center gap-3 text-white/70">
            <Video size={40} />
            <p className="text-body-sm">Your camera preview will appear here</p>
          </div>
        )}
      </div>

      {hasPreview && recorder.state === "idle" && (cameras.length > 1 || mics.length > 1) && (
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          {cameras.length > 1 && (
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <Camera size={14} />
              <select
                value={cameraId}
                onChange={(e) => {
                  setCameraId(e.target.value);
                  openPreview({ videoId: e.target.value, audioId: micId });
                }}
                className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1 text-caption"
              >
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || "Camera"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mics.length > 1 && (
            <label className="flex items-center gap-2 text-caption text-(--color-text-muted)">
              <Mic size={14} />
              <select
                value={micId}
                onChange={(e) => {
                  setMicId(e.target.value);
                  openPreview({ videoId: cameraId, audioId: e.target.value });
                }}
                className="rounded-md border border-(--color-border) bg-(--color-surface) px-2 py-1 text-caption"
              >
                {mics.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || "Microphone"}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {(error || recorder.error) && (
        <p className="mt-4 text-center text-body-sm text-danger-600">{error ?? recorder.error}</p>
      )}

      <div className="mt-5">
        {!hasPreview ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => openPreview()}
              className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-6 py-3 font-semibold text-white transition-colors hover:bg-primary-600"
            >
              <Camera size={16} />
              Enable camera
            </button>
          </div>
        ) : (
          <RecorderControls
            state={recorder.state}
            elapsedMs={recorder.elapsedMs}
            onStart={startRecording}
            onPause={recorder.pause}
            onResume={recorder.resume}
            onStop={stopRecording}
            startLabel="Start recording"
          />
        )}
      </div>
    </div>
  );
}
