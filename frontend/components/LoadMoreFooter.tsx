"use client";

/** "Showing X of Y" with a Load more button for a paged list, so a partial list is never presented as complete. */
export default function LoadMoreFooter({
  noun,
  loaded,
  total,
  loading,
  error,
  onMore,
  filtering = false,
}: {
  noun: string;
  loaded: number;
  total: number;
  loading: boolean;
  error: string | null;
  onMore: () => void;
  filtering?: boolean; // filters are active: the remaining pages are being loaded automatically
}) {
  if (loaded >= total && !error) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
      <span role="status">
        Showing {loaded} of {total} {noun}
        {filtering && !error ? " · loading the rest so the filters cover everything" : ""}
      </span>
      {error && (
        <span role="alert" className="font-medium text-st-red-strong">
          Could not load more. {error}
        </span>
      )}
      <button
        onClick={onMore}
        disabled={loading}
        className="rounded-lg border border-line bg-surface px-3.5 py-1.5 font-medium text-ink shadow-sm hover:bg-track disabled:cursor-wait disabled:opacity-60"
      >
        {loading ? "Loading..." : error ? "Retry" : "Load more"}
      </button>
    </div>
  );
}
