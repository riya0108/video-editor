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
  // A file is picked well before the browser finishes decoding its metadata
  // (or discovers it can't be decoded at all, e.g. an unsupported codec).
  // Tools must not let the user trigger an export in that window, and must
  // tell them why if decoding fails outright — otherwise export buttons look
  // like they're doing nothing.
  const [isMetadataLoading, setIsMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
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
    setIsMetadataLoading(true);
    setMetadataError(null);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(video.duration || 0);
    setVideoWidth(video.videoWidth);
    setVideoHeight(video.videoHeight);
    setIsMetadataLoading(false);
    setMetadataError(null);
  }, []);

  const onError = useCallback(() => {
    setIsMetadataLoading(false);
    setMetadataError(
      "Your browser couldn't read this video. Try converting it to MP4 (H.264) first.",
    );
  }, []);

  const reset = useCallback(() => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(null);
    setSourceUrl(null);
    setDuration(0);
    setVideoWidth(0);
    setVideoHeight(0);
    setIsMetadataLoading(false);
    setMetadataError(null);
  }, [sourceUrl]);

  return {
    file,
    sourceUrl,
    duration,
    videoWidth,
    videoHeight,
    videoRef,
    isMetadataLoading,
    metadataError,
    onLoadedMetadata,
    onError,
    handleFiles,
    reset,
    hasFile: !!file,
  };
}
