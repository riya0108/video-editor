import { useCallback, useId, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";

export default function Dropzone({
  accept,
  multiple = false,
  label = "Drop a file here, or click to browse",
  hint,
  onFiles,
}: {
  accept: string;
  multiple?: boolean;
  label?: string;
  hint?: string;
  onFiles: (files: File[]) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      onFiles(Array.from(fileList));
    },
    [onFiles],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
        isDragging
          ? "border-primary-500 bg-primary-50 dark:bg-primary-950/30"
          : "border-(--color-border-strong) bg-(--color-bg-subtle) hover:border-primary-400"
      }`}
    >
      <span className="grid h-12 w-12 place-items-center rounded-full bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
        <UploadCloud size={22} />
      </span>
      <div>
        <p className="font-semibold">{label}</p>
        {hint && <p className="mt-1 text-body-sm text-(--color-text-muted)">{hint}</p>}
      </div>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
