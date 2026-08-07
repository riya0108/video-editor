import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { getIcon } from "../../lib/icon-map";
import {
  categoryMeta,
  getToolPath,
  tools as allTools,
  type ToolCategory,
  type ToolDefinition,
} from "../../lib/tools-registry";

const categories: (ToolCategory | "all")[] = ["all", "video", "audio", "speech"];

function matches(tool: ToolDefinition, query: string) {
  if (!query) return true;
  const haystack = [tool.name, tool.description, ...(tool.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export default function ToolGrid({
  initialCategory = "all",
  tools = allTools,
  showSearch = true,
}: {
  initialCategory?: ToolCategory | "all";
  tools?: ToolDefinition[];
  showSearch?: boolean;
}) {
  const [category, setCategory] = useState<ToolCategory | "all">(initialCategory);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("category");
    if (fromUrl === "video" || fromUrl === "audio" || fromUrl === "speech") {
      setCategory(fromUrl);
    }
  }, []);

  const filtered = useMemo(
    () =>
      tools.filter((t) => (category === "all" || t.category === category) && matches(t, query)),
    [tools, category, query],
  );

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`rounded-full border px-4 py-1.5 text-body-sm font-medium transition-colors ${
                category === c
                  ? "border-primary-500 bg-primary-500 text-white"
                  : "border-(--color-border) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)"
              }`}
            >
              {c === "all" ? "All tools" : categoryMeta[c].label}
            </button>
          ))}
        </div>

        {showSearch && (
          <label className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--color-text-faint)"
              size={16}
            />
            <span className="sr-only">Search tools</span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools&hellip;"
              className="w-full rounded-md border border-(--color-border) bg-(--color-surface) py-2 pl-9 pr-3 text-body-sm outline-none transition-colors focus:border-primary-400 focus:ring-2 focus:ring-primary-200"
            />
          </label>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="mt-10 text-center text-body-sm text-(--color-text-muted)">
          No tools match &ldquo;{query}&rdquo;. Try another search.
        </p>
      ) : (
        <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((tool) => (
            <ToolCard key={`${tool.category}-${tool.slug}`} tool={tool} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolDefinition }) {
  const Icon = getIcon(tool.icon);
  const accent = categoryMeta[tool.category].accent;

  return (
    <li>
      <a
        href={getToolPath(tool)}
        className="group flex h-full flex-col gap-3 rounded-xl border border-(--color-border) bg-(--color-surface) p-5 transition-all hover:-translate-y-0.5 hover:border-(--color-border-strong) hover:shadow-lg hover:shadow-neutral-900/5"
      >
        <div className="flex items-start justify-between">
          <span
            className={`grid h-10 w-10 place-items-center rounded-lg ${
              accent === "primary"
                ? "bg-primary-100 text-primary-600 dark:bg-primary-900 dark:text-primary-300"
                : accent === "accent"
                  ? "bg-accent-100 text-accent-600 dark:bg-accent-900 dark:text-accent-300"
                  : "bg-success-500/15 text-success-600"
            }`}
          >
            <Icon size={20} strokeWidth={2} />
          </span>
          {tool.status === "soon" && (
            <span className="rounded-full bg-(--color-bg-subtle) px-2.5 py-0.5 text-caption font-medium text-(--color-text-muted)">
              Coming soon
            </span>
          )}
        </div>
        <div>
          <h3 className="font-semibold tracking-tight group-hover:text-primary-600">
            {tool.name}
          </h3>
          <p className="mt-1 text-body-sm text-(--color-text-muted)">{tool.description}</p>
        </div>
      </a>
    </li>
  );
}
