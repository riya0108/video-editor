import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "paused" | "stopped";

export interface RecordingResult {
  blob: Blob;
  url: string;
}

/** Wraps the MediaRecorder API with a pause-aware timer and a simple state machine. */
export function useMediaRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const pausedMsRef = useRef(0);
  const pausedAtRef = useRef(0);

  const clearTimer = () => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const start = useCallback((stream: MediaStream, mimeType: string) => {
    setError(null);
    setResult(null);
    chunksRef.current = [];

    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onerror = () => setError("Recording stopped unexpectedly.");
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      setResult({ blob, url: URL.createObjectURL(blob) });
    };

    recorder.start(250);
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    pausedMsRef.current = 0;
    setElapsedMs(0);
    setState("recording");

    clearTimer();
    intervalRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current - pausedMsRef.current);
    }, 200);
  }, []);

  const pause = useCallback(() => {
    if (recorderRef.current?.state !== "recording") return;
    recorderRef.current.pause();
    pausedAtRef.current = Date.now();
    clearTimer();
    setState("paused");
  }, []);

  const resume = useCallback(() => {
    if (recorderRef.current?.state !== "paused") return;
    pausedMsRef.current += Date.now() - pausedAtRef.current;
    recorderRef.current.resume();
    setState("recording");
    intervalRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current - pausedMsRef.current);
    }, 200);
  }, []);

  const stop = useCallback(() => {
    clearTimer();
    recorderRef.current?.stop();
    setState("stopped");
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    if (result) URL.revokeObjectURL(result.url);
    recorderRef.current = null;
    chunksRef.current = [];
    setResult(null);
    setError(null);
    setElapsedMs(0);
    setState("idle");
  }, [result]);

  useEffect(() => clearTimer, []);

  return { state, elapsedMs, result, error, start, pause, resume, stop, reset, setError };
}
