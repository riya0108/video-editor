/** A transparent full-box layer that reports the fractional click position, for eyedropper-style color picking. */
export default function PickColorOverlay({ onPick }: { onPick: (fx: number, fy: number) => void }) {
  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / rect.width;
        const fy = (e.clientY - rect.top) / rect.height;
        onPick(fx, fy);
      }}
    >
      <div className="absolute inset-0 flex items-center justify-center bg-black/20">
        <span className="rounded-full bg-black/70 px-3 py-1.5 text-caption font-medium text-white">
          Click the video to pick a color
        </span>
      </div>
    </div>
  );
}
