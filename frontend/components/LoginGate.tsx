"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/api";
import { AUTH_EVENT, hasSession } from "@/lib/auth";

// Protects the dashboard: without a session it sends the visitor to /login (which sends signed-in users back here).
export default function LoginGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<boolean | null>(null); // null until sessionStorage has been read
  const wasSignedIn = useRef(false);

  useEffect(() => {
    const sync = () => {
      const now = hasSession();
      // A session that disappears while the dashboard is open means it expired or was revoked.
      if (!now) router.replace(wasSignedIn.current ? "/login?reason=expired" : "/login");
      wasSignedIn.current = now;
      setSignedIn(now);
    };
    sync();
    window.addEventListener(AUTH_EVENT, sync);
    return () => window.removeEventListener(AUTH_EVENT, sync);
  }, [router]);

  if (!signedIn) return null;

  return (
    <>
      {children}
      <button
        type="button"
        onClick={() => {
          wasSignedIn.current = false; // an intentional sign-out is not an expiry
          void logout();
        }}
        className="fixed bottom-3 right-3 z-40 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-muted shadow hover:text-ink print:hidden"
      >
        Sign out
      </button>
    </>
  );
}
