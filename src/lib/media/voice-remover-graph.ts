/**
 * Exact Web Audio replica of the ffmpeg voice-remover filter
 * (`pan=stereo|c0=c0-c1|c1=c1-c0`): stereo channel-difference cancellation.
 * `c0_out = c0 - c1`, `c1_out = c1 - c0` — a ChannelSplitter feeds each
 * merger input directly plus the other channel inverted.
 */
export function buildVoiceRemoverNodes(ctx: AudioContext): { input: AudioNode; output: AudioNode } {
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const invertForLeft = ctx.createGain();
  invertForLeft.gain.value = -1;
  const invertForRight = ctx.createGain();
  invertForRight.gain.value = -1;

  // c0_out = c0 + (-1 * c1)
  splitter.connect(merger, 0, 0);
  splitter.connect(invertForLeft, 1);
  invertForLeft.connect(merger, 0, 0);

  // c1_out = c1 + (-1 * c0)
  splitter.connect(merger, 1, 1);
  splitter.connect(invertForRight, 0);
  invertForRight.connect(merger, 0, 1);

  return { input: splitter, output: merger };
}
