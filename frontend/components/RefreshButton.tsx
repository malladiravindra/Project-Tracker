"use client";

export type RefreshState =
  | { status: "idle" }
  | { status: "loading"; at?: Date }
  | { status: "done"; at: Date; id: number }
  | { status: "error"; message: string; at?: Date; id: number };

const fmt = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export default function RefreshButton({ state, onRefresh }: { state: RefreshState; onRefresh: () => void }) {
  const loading = state.status === "loading";
  const label =
    state.status === "loading"
      ? "Refreshing…"
      : state.status === "error"
        ? "Refresh failed"
        : state.status === "done"
          ? `Refreshed ${fmt(state.at)}`
          : "";

  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        onClick={onRefresh}
        disabled={loading}
        aria-label="Refresh dashboard data"
        title={state.status === "error" ? state.message : state.status === "done" ? `Refresh dashboard data (last refreshed ${fmt(state.at)})` : "Refresh dashboard data"}
        className="rounded-lg border border-white/25 p-2 text-white/85 hover:bg-white/10 hover:text-white disabled:cursor-progress"
      >
        <svg viewBox="0 0 20 20" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden>
          <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M16.8 3.2v3.6h-3.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span
        role="status"
        title={state.status === "error" ? state.message : undefined}
        className={`hidden whitespace-nowrap text-xs 2xl:inline ${state.status === "error" ? "font-semibold text-red-300" : "text-white/70"}`}
      >
        {label}
      </span>

      {/* Confirmation that stays visible at every screen size, then fades out by itself. */}
      {(state.status === "done" || state.status === "error") && (
        <div
          key={state.id}
          role="alert"
          className={`toast-life fixed left-1/2 top-[4.25rem] z-50 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-lg border px-4 py-2 text-sm font-medium shadow-lg ${
            state.status === "error" ? "border-st-red/40 bg-surface text-st-red-strong" : "border-line bg-surface text-ink"
          }`}
        >
          {state.status === "error" ? (
            <>⚠ {state.message}</>
          ) : (
            <>
              <span className="text-st-green">✓</span> Dashboard refreshed at {fmt(state.at)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
