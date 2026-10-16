"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { control } from "./TasksView";

export interface ComboOption {
  value: string;
  label: string;
  hint?: string; // secondary text, e.g. a job title
}

/**
 * Searchable dropdown. Type to filter, arrow keys to move, Enter to pick, Escape to close.
 * With `allowCreate`, text that matches no option can be added as a new value.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  allowCreate = false,
  clearable = false,
  invalid = false,
  describedBy,
  onBlur,
  emptyText = "No matches",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  allowCreate?: boolean;
  clearable?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onBlur?: () => void;
  emptyText?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);
  const shown = selected?.label ?? value; // a created value has no option yet
  const q = query.trim().replace(/\s+/g, " ");
  const matches = options.filter(
    (o) => !q || o.label.toLowerCase().includes(q.toLowerCase()) || o.hint?.toLowerCase().includes(q.toLowerCase()),
  );
  const exact = options.some((o) => o.label.toLowerCase() === q.toLowerCase());
  const items: (ComboOption & { create?: boolean })[] =
    allowCreate && q && !exact ? [...matches, { value: q, label: `Add "${q}"`, create: true }] : matches;

  const openList = () => {
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = (v: string) => {
    onChange(v);
    close();
  };
  const move = (to: number) => {
    const next = (to + items.length) % Math.max(items.length, 1);
    setActive(next);
    listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      move(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && open) {
      e.preventDefault(); // pick instead of submitting the form
      if (items[active]) pick(items[active].value);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); // close the list, not the dialog
      close();
    } else if (e.key === "Tab" && open) {
      close();
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        autoComplete="off"
        value={open ? query : shown}
        placeholder={open && shown ? shown : placeholder}
        onFocus={openList}
        onClick={() => !open && openList()}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          if (!open) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          close();
          onBlur?.();
        }}
        className={`${control} w-full pr-16 font-normal placeholder:text-muted ${invalid ? "border-st-red! focus:ring-st-red/20!" : ""}`}
      />
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 pr-3 text-muted">
        {clearable && value && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange("")}
            className="pointer-events-auto rounded px-1 text-lg leading-none hover:text-ink"
          >
            ×
          </button>
        )}
        <svg viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          <path d="M5.2 7.4a.75.75 0 0 1 1.06.04L10 11.4l3.74-3.96a.75.75 0 1 1 1.1 1.02l-4.3 4.55a.75.75 0 0 1-1.1 0l-4.3-4.55a.75.75 0 0 1 .06-1.06Z" />
        </svg>
      </span>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 text-[15px] shadow-lg"
        >
          {items.map((o, i) => (
            <li
              key={`${o.create ? "+" : ""}${o.value}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
              className={`flex cursor-pointer items-baseline justify-between gap-3 px-3.5 py-2 ${i === active ? "bg-track/70" : ""} ${
                o.create ? "font-medium text-st-blue" : ""
              }`}
            >
              <span className="truncate">
                {o.label}
                {o.value === value && !o.create && <span className="sr-only"> (selected)</span>}
              </span>
              {o.hint && <span className="shrink-0 truncate text-sm text-muted">{o.hint}</span>}
            </li>
          ))}
          {!items.length && <li className="px-3.5 py-2 text-muted">{emptyText}</li>}
        </ul>
      )}
    </div>
  );
}

/** "YYYY-MM-DD" -> "dd-mm-yyyy" */
export const isoToDmy = (iso: string) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : "");

/** "dd-mm-yyyy" (or d/m/yyyy, d.m.yyyy) -> "YYYY-MM-DD", or "" when it is not a real calendar date. */
export function dmyToIso(text: string): string {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text.trim());
  if (!m) return "";
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return "";
  return date.toISOString().slice(0, 10);
}

/**
 * Date field shown and typed as dd-mm-yyyy, with a calendar button for the browser's date picker.
 * `onChange` gets the ISO date, or "" plus `typed: true` while the text is not (yet) a valid date.
 */
export function DateField({
  id,
  value,
  onChange,
  min,
  max,
  invalid = false,
  describedBy,
  onBlur,
}: {
  id: string;
  value: string; // YYYY-MM-DD or ""
  onChange: (iso: string, typed: boolean) => void;
  min?: string;
  max?: string;
  invalid?: boolean;
  describedBy?: string;
  onBlur?: () => void;
}) {
  const [text, setText] = useState(isoToDmy(value));
  const [seen, setSeen] = useState(value);
  const picker = useRef<HTMLInputElement>(null);
  // Follow value changes made from outside the text box (the calendar, a reset).
  if (value !== seen) {
    setSeen(value);
    if (dmyToIso(text) !== value) setText(isoToDmy(value));
  }

  const type = (raw: string) => {
    // Keep digits and separators; add the dashes as the user types plain digits.
    let t = raw.replace(/[^\d\-/.]/g, "").slice(0, 10);
    if (/^\d{3,}$/.test(t) || /^\d{2}-\d{3,}$/.test(t)) {
      const digits = t.replace(/\D/g, "");
      t = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join("-");
    }
    setText(t);
    const iso = dmyToIso(t);
    setSeen(iso);
    onChange(iso, !!t && !iso);
  };

  const openPicker = () => {
    const el = picker.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus(); // older browsers: focusing the native input still offers its picker
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="dd-mm-yyyy"
        value={text}
        onChange={(e) => type(e.target.value)}
        onBlur={onBlur}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className={`${control} w-full pr-11 font-normal tabular-nums placeholder:text-muted ${invalid ? "border-st-red! focus:ring-st-red/20!" : ""}`}
      />
      <button
        type="button"
        onClick={openPicker}
        aria-label="Open calendar"
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted hover:text-ink"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4.5 w-4.5" aria-hidden>
          <path
            fillRule="evenodd"
            d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z"
          />
        </svg>
      </button>
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          setText(isoToDmy(e.target.value));
          setSeen(e.target.value);
          onChange(e.target.value, false);
        }}
        className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 opacity-0"
      />
    </div>
  );
}
