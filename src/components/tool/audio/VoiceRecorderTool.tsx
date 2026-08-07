import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import ResultPanel from "../ResultPanel";
import RecorderControls from "../media/RecorderControls";
import LevelMeter from "../media/LevelMeter";
import { useMediaRecorder } from "../../../lib/hooks/useMediaRecorder";
import { useMediaDevices } from "../../../lib/hooks/useMediaDevices";
import { useAudioLevel } from "../../../lib/hooks/useAudioLevel";
import { stopAllTracks } from "../../../lib/media/mix-audio";
import {
  AUDIO_RECORDER_MIME_CANDIDATES,
  extensionForMimeType,
  pickSupportedMimeType,
} from "../../../lib/media/pick-mime-type";

export default function VoiceRecorderTool() {
  const recorder = useMediaRecorder();
  const { devices: mics, refresh: refreshMics } = useMediaDevices("audioinput");

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micId, setMicId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const level = useAudioLevel(stream);

  const openMic = async (deviceId?: string) => {
    setError(null);
    try {
      stopAllTracks(streamRef.current);
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      streamRef.current = newStream;
      setStream(newStream);
      const track = newStream.getAudioTracks()[0];
      if (track) setMicId(track.getSettings().deviceId ?? "");
      await refreshMics();
    } catch {
      setError("Microphone access needs your permission. Click Enable microphone and allow access.");
    }
  };

  const startRecording = () => {
    if (!streamRef.current) return;
    const mimeType = pickSupportedMimeType(AUDIO_RECORDER_MIME_CANDIDATES);
    recorder.start(streamRef.current, mimeType);
  };

  const stopRecording = () => {
    recorder.stop();
    stopAllTracks(streamRef.current);
    streamRef.current = null;
    setStream(null);
  };

  const reset = () => {
    stopAllTracks(streamRef.current);
    streamRef.current = null;
    setStream(null);
    recorder.reset();
  };

  useEffect(() => () => stopAllTracks(streamRef.current), []);

  if (recorder.result) {
    const ext = extensionForMimeType(recorder.result.blob.type);
    return (
      <ResultPanel
        url={recorder.result.url}
        blob={recorder.result.blob}
        filename={`voice-recording.${ext}`}
        kind="audio"
        onReset={reset}
      />
    );
  }

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-8">
      <div className="flex flex-col items-center gap-6">
        <span className="grid h-24 w-24 place-items-center rounded-full bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
          <Mic size={36} />
        </span>

        {stream && <LevelMeter level={level} />}

        {stream && mics.length > 1 && recorder.state === "idle" && (
          <select
            value={micId}
            onChange={(e) => {
              setMicId(e.target.value);
              openMic(e.target.value);
            }}
            className="rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-1.5 text-caption"
          >
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || "Microphone"}
              </option>
            ))}
          </select>
        )}

        {(error || recorder.error) && (
          <p className="text-center text-body-sm text-danger-600">{error ?? recorder.error}</p>
        )}

        {!stream ? (
          <button
            type="button"
            onClick={() => openMic()}
            className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-6 py-3 font-semibold text-white transition-colors hover:bg-primary-600"
          >
            <Mic size={16} />
            Enable microphone
          </button>
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
