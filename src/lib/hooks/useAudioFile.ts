import { useCallback, useEffect, useState } from "react";

/** Manages the "primary" audio file a tool is operating on: the picked File and its object URL. */
export function useAudioFile() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);

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

  const reset = useCallback(() => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setFile(null);
    setSourceUrl(null);
    setDuration(0);
  }, [sourceUrl]);

  return { file, sourceUrl, duration, setDuration, handleFiles, reset, hasFile: !!file };
}
