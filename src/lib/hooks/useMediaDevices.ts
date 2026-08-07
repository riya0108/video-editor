import { useCallback, useEffect, useState } from "react";

/** Lists available input devices of a given kind; labels populate once permission has been granted. */
export function useMediaDevices(kind: "videoinput" | "audioinput") {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((d) => d.kind === kind));
  }, [kind]);

  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  return { devices, refresh };
}
