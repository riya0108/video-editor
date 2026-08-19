import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** The "tool just opened, nothing loaded yet" screen: icon, title, description, then the upload UI. */
export default function ToolUploadScreen({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 px-4 py-16 sm:px-6 lg:px-8">
      <div className="flex w-full max-w-2xl flex-col items-center gap-3 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300">
          <Icon size={26} />
        </span>
        <h1 className="text-h2 font-bold tracking-tight">{title}</h1>
        <p className="max-w-md text-body-sm text-(--color-text-muted)">
          {description}
        </p>
      </div>

      <div className="w-full max-w-2xl">{children}</div>
    </div>
  );
}
