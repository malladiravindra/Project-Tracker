"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, errorMessage, login } from "@/lib/api";
import { hasSession } from "@/lib/auth";

const field =
  "h-10 w-full rounded-md border bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-[#3B82F6] focus:ring-2 focus:ring-[#3B82F6]/30";

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-8 w-8 flex-col items-start justify-center gap-[3px] rounded-lg bg-[#2A3550] pl-[7px]" aria-hidden>
        <span className="h-[3px] w-[14px] rounded-full bg-[#F5B82E]" />
        <span className="h-[3px] w-[10px] rounded-full bg-white" />
        <span className="h-[3px] w-[6px] rounded-full bg-gray-400" />
      </span>
      <span className="text-lg font-semibold text-white">Project Tracker</span>
    </div>
  );
}

const CHIPS = ["#22A33A", "#F5B82E", "#E5484D"];
// Position as % of the chart width: bar start, filled-to, and where the grey track ends.
const BARS = [
  { c: "#22A33A", from: 0, to: 45, track: 45 },
  { c: "#22A33A", from: 15, to: 50, track: 67 },
  { c: "#F5B82E", from: 30, to: 46, track: 76 },
  { c: "#3B7DDD", from: 46, to: 51, track: 86 },
];
const AVATARS = ["#3B7DDD", "#7B2FB5", "#22A33A", "#E8730C"];

// Decorative project timeline; hidden from assistive technology.
function Illustration() {
  return (
    <div aria-hidden="true" className="mt-11 max-w-[520px] rounded-xl border border-slate-700 bg-slate-800/60 p-4">
      <div className="flex gap-2">
        {CHIPS.map((c) => (
          <span key={c} className="flex items-center gap-1.5 rounded-md bg-slate-700 px-2 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
            <span className="h-1.5 w-6 rounded-full bg-slate-500" />
          </span>
        ))}
      </div>
      <div className="relative mt-4 h-[104px]">
        <div className="absolute inset-0 flex justify-between">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="w-px bg-slate-700/70" />
          ))}
        </div>
        {BARS.map((b, i) => (
          <div key={i} className="absolute h-2.5" style={{ top: 6 + i * 25, left: `${b.from}%`, width: `${b.track - b.from}%` }}>
            <span className="absolute inset-0 rounded-full bg-slate-600/70" />
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${((b.to - b.from) / (b.track - b.from)) * 100}%`, background: b.c }}
            />
          </div>
        ))}
        <span className="absolute inset-y-0 w-px bg-[#F5B82E]" style={{ left: "58%" }} />
        <span className="absolute right-0 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border border-[#F5B82E]" />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-slate-700 pt-3">
        <div className="flex">
          {AVATARS.map((c, i) => (
            <span key={c} className={`h-6 w-6 rounded-full ring-2 ring-[#18253f] ${i ? "-ml-2" : ""}`} style={{ background: c }} />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="h-1.5 w-14 rounded-full bg-slate-600" />
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#22A33A]">
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.5 8.5l3 3 6-6.5" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export default function LoginScreen() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const init = () => {
      if (hasSession()) {
        router.replace("/"); // already signed in
        return;
      }
      if (new URLSearchParams(window.location.search).get("reason") === "expired") {
        setNotice("Your session has expired. Please sign in again.");
      }
      setReady(true);
    };
    init();
  }, [router]);

  const userMissing = touched && !username.trim();
  const passMissing = touched && !password;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (!username.trim() || !password) return;
    setBusy(true);
    try {
      await login(username.trim(), password);
      setPassword("");
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Incorrect username or password." : errorMessage(err));
      setBusy(false);
    }
  }

  if (!ready) return null;

  return (
    <main className="grid flex-1 md:grid-cols-[54fr_46fr]">
      <section className="hidden flex-col bg-[#0F1E3D] p-6 text-white md:flex">
        <Brand />
        <h2 className="mt-20 max-w-[520px] text-3xl font-bold leading-tight lg:text-4xl">Your work. Your projects. One clear view.</h2>
        <p className="mt-4 max-w-[520px] text-sm text-slate-300">
          Project health, deadlines, decisions and team workload, together in one place.
        </p>
        <Illustration />
        <p className="mt-auto pt-8 text-xs text-slate-500">For internal use by authorised managers.</p>
      </section>

      <section className="flex flex-col items-center justify-center bg-[#F3F4F6] px-4 py-10 md:px-6">
        <div className="mb-6 w-full max-w-[376px] md:hidden">
          <span className="inline-block rounded-lg bg-[#0F1E3D] px-3 py-2">
            <Brand />
          </span>
        </div>
        <form onSubmit={submit} noValidate className="w-full max-w-[376px] rounded-xl border border-gray-200 bg-white p-7 shadow-sm">
          <h1 className="text-2xl font-bold text-gray-900">Sign in</h1>
          <p className="mt-1 text-sm text-gray-500">Use your manager account to open the dashboard.</p>

          {notice && !error && (
            <p role="status" className="mt-4 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
              {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="mt-5">
            <label htmlFor="username" className="mb-2 block text-sm font-medium text-gray-900">
              Username
            </label>
            <input
              id="username"
              className={`${field} ${userMissing ? "border-red-500" : "border-gray-300"}`}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              aria-invalid={userMissing}
              aria-describedby={userMissing ? "username-err" : undefined}
            />
            {userMissing && (
              <p id="username-err" className="mt-1 text-xs text-red-600">
                Enter your username.
              </p>
            )}
          </div>

          <div className="mt-5">
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-900">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                className={`${field} pr-10 ${passMissing ? "border-red-500" : "border-gray-300"}`}
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-invalid={passMissing}
                aria-describedby={passMissing ? "password-err" : undefined}
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-pressed={show}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-gray-500 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-[#3B82F6]"
              >
                <EyeIcon off={show} />
              </button>
            </div>
            {passMissing && (
              <p id="password-err" className="mt-1 text-xs text-red-600">
                Enter your password.
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={busy}
            className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#0F1E3D] font-semibold text-white transition hover:bg-[#1a2f58] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3B82F6] disabled:opacity-60"
          >
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-5 max-w-[380px] text-center text-sm text-gray-500">
          Need access? Ask your administrator to set up a manager account for you.
        </p>
      </section>
    </main>
  );
}
