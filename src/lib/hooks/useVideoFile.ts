import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Manages the "primary" video a tool is operating on: the picked File, an
 * object URL for preview, decoded metadata, and the <video> ref to read it
 * from. Shared by every single-video tool so each one only has to implement
 * its own controls and export args.
 */
export function useVideoFile() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [videoWidth, setVideoWidth] = useState(0);
  const [videoHeight, setVideoHeight] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl]);

  const handleFiles = useCallback((files: File[]) => {
    const picked = files[0];
    if (!picked) return;
    setFile(picked);
    setSourceUrl(URL.createObjectURL(picked));
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration || 0);
    setVideoWidth(video.videoWidth);
    setVideoHeight(video.videoHeight);
  }, []);

  const reset = useCallback(() => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(null);
    setSourceUrl(null);
    setDuration(0);
    setVideoWidth(0);
    setVideoHeight(0);
  }, [sourceUrl]);

  return {
    file,
    sourceUrl,
    duration,
    videoWidth,
    videoHeight,
    videoRef,
    onLoadedMetadata,
    handleFiles,
    reset,
    hasFile: !!file,
  };
}
