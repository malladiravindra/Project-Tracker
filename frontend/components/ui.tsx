"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Marker, ProjectStatus } from "@/lib/data";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface p-5 shadow-sm transition-shadow duration-150 hover:shadow-md ${className}`}>
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-4">
      <h2 className="text-lg font-bold">{title}</h2>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
    </header>
  );
}

const markerClass: Record<Marker, string> = {
  "square-red": "h-3 w-3 bg-st-red",
  "dot-red": "h-2 w-2 rounded-full bg-st-red",
  "dot-purple": "h-2 w-2 rounded-full bg-st-purple",
  "dot-blue": "h-2 w-2 rounded-full bg-st-blue",
  "dot-orange": "h-2 w-2 rounded-full bg-st-orange",
  "triangle-amber": "",
};

export function MarkerIcon({ marker }: { marker: Marker }) {
  if (marker === "triangle-amber") {
    return (
      <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 fill-st-amber" aria-hidden>
        <path d="M6 1 11.5 11H.5Z" />
      </svg>
    );
  }
  return <span className={`inline-block shrink-0 ${markerClass[marker]}`} aria-hidden />;
}

const statusMeta: Record<ProjectStatus, { label: string; marker: ReactNode; bar: string }> = {
  "off-track": { label: "Off track", marker: <MarkerIcon marker="square-red" />, bar: "bg-st-red" },
  watch: { label: "Needs watching", marker: <MarkerIcon marker="triangle-amber" />, bar: "bg-st-amber" },
  "on-track": {
    label: "On track",
    marker: <span className="h-2 w-2 rounded-full bg-st-green" aria-hidden />,
    bar: "bg-st-green",
  },
  "not-started": {
    label: "Not started",
    marker: <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-muted" aria-hidden />,
    bar: "bg-muted",
  },
};

export const barColor = (s: ProjectStatus) => statusMeta[s].bar;

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const m = statusMeta[status];
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line whitespace-nowrap px-2.5 py-0.5 text-sm font-medium">
      {m.marker}
      {m.label}
    </span>
  );
}

export function ProgressBar({ done, time, status }: { done: number; time: number; status: ProjectStatus }) {
  return (
    <div
      className="relative h-3 w-full rounded-full bg-track"
      role="img"
      aria-label={`${done}% done, ${time}% of time used`}
    >
      <div className={`h-full rounded-full ${barColor(status)}`} style={{ width: `${done}%` }} />
      {status !== "not-started" && (
        <div
          className="absolute -top-1.5 h-6 w-0.5 -translate-x-1/2 rounded bg-ink"
          style={{ left: `${time}%` }}
          title={`Expected today: ${time}%`}
        />
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode; // stays visible below a scrolling body
  wide?: boolean; // for longer forms
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const header = (
    <div className={`flex items-start justify-between gap-4 ${footer ? "px-6 pb-4 pt-5" : "mb-4"}`}>
      <h3 className="text-lg font-bold">{title}</h3>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md px-2 text-2xl leading-none text-muted hover:bg-track hover:text-ink"
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? "max-w-2xl" : "max-w-xl"} rounded-xl border border-line bg-surface shadow-xl ${
          footer ? "flex max-h-[90vh] flex-col" : "max-h-[85vh] overflow-y-auto p-6"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {header}
        {footer ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>
            <div className="flex shrink-0 justify-end gap-2.5 rounded-b-xl border-t border-line bg-surface px-6 py-4">{footer}</div>
          </>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/**
 * Small confirmation pop-up shown above everything else (including an open Modal).
 * Escape or a click outside cancels it without closing the dialog underneath.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busyLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    // Capture phase runs before the Modal's own Escape listener, so only this pop-up closes.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (!busy) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        e.stopPropagation(); // never reach the Modal's backdrop
        if (!busy) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-st-red/10 text-st-red-strong" aria-hidden>
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path
                fillRule="evenodd"
                d="M8.5 2.75a1.75 1.75 0 0 1 3 0l6.25 11A1.75 1.75 0 0 1 16.25 16.5H3.75a1.75 1.75 0 0 1-1.5-2.75l6.25-11ZM10 6.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6.5Zm0 7.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <h4 id="confirm-title" className="text-lg font-bold">
              {title}
            </h4>
            <div id="confirm-message" className="mt-1.5 text-[15px] text-muted">
              {message}
            </div>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-4 rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2.5">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            disabled={busy}
            className="h-10 rounded-lg border border-line bg-surface px-4 text-[15px] font-medium hover:bg-track/60 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-10 rounded-lg bg-st-red px-4 text-[15px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
