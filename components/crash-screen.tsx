"use client";

/**
 * What a host sees when the client throws.
 *
 * Shared by `app/error.tsx` and `app/global-error.tsx` so the two boundaries
 * cannot drift into two different apologies — the same reason
 * `components/site-footer.tsx` replaced three hand-rolled footers.
 *
 * The bar this has to clear is Next's default, which is what the reported bug
 * actually looked like: "Application error: a client-side exception has
 * occurred (see the browser console for more information)". For a host with a
 * room full of people waiting, that sentence has no author, no cause and no
 * next step, and its only instruction is to open a developer console. Three
 * things fix that and nothing else needs to:
 *
 *  - **Say it is ours.** The host's playlist is fine; they will otherwise spend
 *    the evening swapping links, which is what the reporter did.
 *  - **Give them the button.** "Start over" clears the stored game and returns
 *    to setup, which is the recovery for the whole class of causes — a payload
 *    that cannot be read is gone the moment it is dropped. "Try again" re-runs
 *    the render for the transient half (a chunk that failed to load once).
 *  - **Record it.** See the `client_error` event in lib/analytics.ts.
 *
 * Inline styles, matching app/page.tsx and app/game/page.tsx: `global-error`
 * replaces the root layout, so nothing here may depend on a stylesheet the
 * layout would have loaded.
 */

import { useEffect } from "react";
import { trackEvent } from "@/lib/analytics";
import { errorMessage } from "@/lib/error-messages";
import { useErrorLocale } from "@/lib/use-error-locale";
import { clearGame } from "@/lib/game-storage";
import { CRASH_REPORT_URL, CRASH_SCREEN_UI } from "@/lib/crash-screen";

export interface CrashScreenProps {
  error: Error & { digest?: string };
  /** Next's boundary reset. Re-renders the segment that threw. */
  reset: () => void;
  /** Which boundary caught it — see the `client_error` event. */
  boundary: "route" | "root";
}

export function CrashScreen({ error, reset, boundary }: CrashScreenProps) {
  const locale = useErrorLocale();
  const ui = CRASH_SCREEN_UI[locale];

  useEffect(() => {
    // The device's own copy, with the digest, which is the only handle a
    // deployed build gives you on a minified stack. Never sent to GA4.
    console.error("[guesssong] client error", { boundary, digest: error.digest }, error);
    trackEvent("client_error", { boundary });
  }, [error, boundary]);

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "#111",
        color: "#f0f0f0",
        fontFamily: "Outfit, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid #2c2c2c",
          borderRadius: "16px",
          maxWidth: "460px",
          width: "100%",
          padding: "28px 24px 24px",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        }}
      >
        <h1
          style={{
            margin: "0 0 12px",
            fontFamily: "'Bebas Neue', Impact, sans-serif",
            fontSize: "30px",
            letterSpacing: "0.5px",
            lineHeight: 1.15,
            color: "#fff",
          }}
        >
          {ui.title}
        </h1>
        <p style={{ margin: "0 0 22px", fontSize: "15px", lineHeight: 1.65, color: "#bdbdbd" }}>
          {errorMessage("client_error", locale)}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              // Order matters: the stored game is the most likely thing to be
              // unreadable, so it goes before the navigation rather than after
              // one that may never complete.
              clearGame();
              window.location.assign("/");
            }}
            style={{
              background: "#1DB954",
              color: "#06210f",
              border: 0,
              borderRadius: "999px",
              padding: "11px 26px",
              fontSize: "15px",
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {ui.restart}
          </button>
          <button
            type="button"
            onClick={reset}
            style={{
              background: "none",
              border: "1px solid #3a3a3a",
              borderRadius: "999px",
              color: "#bdbdbd",
              padding: "10px 22px",
              fontSize: "14px",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {ui.retry}
          </button>
          <a
            href={CRASH_REPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "#9a9a9a",
              fontSize: "14px",
              textDecoration: "none",
              borderBottom: "1px solid #3a3a3a",
              paddingBottom: "1px",
            }}
          >
            {ui.report} →
          </a>
        </div>
        {error.digest && (
          /* The one thing worth quoting in a bug report, and the only reason
             this screen shows an identifier at all: it is what matches the
             host's crash to a line in the deployed build. */
          <p style={{ margin: "20px 0 0", fontSize: "12px", color: "#555" }}>
            ref {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
