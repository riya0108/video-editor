/** Combines a display-capture stream's video with a mix of its own audio (if any) plus a mic stream. */
export function mixMicIntoStream(displayStream: MediaStream, micStream: MediaStream): MediaStream {
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextCtor();
  const destination = context.createMediaStreamDestination();

  const displayAudioTracks = displayStream.getAudioTracks();
  if (displayAudioTracks.length > 0) {
    context.createMediaStreamSource(new MediaStream(displayAudioTracks)).connect(destination);
  }
  context.createMediaStreamSource(micStream).connect(destination);

  const combined = new MediaStream();
  for (const track of displayStream.getVideoTracks()) combined.addTrack(track);
  for (const track of destination.stream.getAudioTracks()) combined.addTrack(track);
  return combined;
}

export function stopAllTracks(...streams: (MediaStream | null | undefined)[]) {
  for (const stream of streams) {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
