const EMOJIS = [
  "😀", "😂", "😍", "🥳", "😎", "🤔", "😭", "😱", "🙌", "👏",
  "👍", "👎", "🔥", "💯", "✨", "⭐", "❤️", "💔", "👀", "😢",
  "🎉", "🎬", "📸", "🎵", "⚡", "💡", "✅", "❌", "❓", "❗",
  "🚀", "🏆", "💰", "⏰", "📍", "🔔", "👋", "🙏", "💪", "🤩",
];

export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="grid grid-cols-10 gap-1 rounded-lg border border-(--color-border) p-2">
      {EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onPick(emoji)}
          aria-label={`Add ${emoji} sticker`}
          className="grid h-8 w-8 place-items-center rounded text-lg hover:bg-(--color-bg-subtle)"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
