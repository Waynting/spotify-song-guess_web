"use client";

/**
 * A one-time popup telling a host that new playlists are not loading, shown
 * before they paste a link rather than after they press Start.
 *
 * Driven by `GET /api/status`, which reads the same KV cooldown key the
 * admission gate in lib/playlist-cache.ts writes. That is the whole design:
 * the notice appears when Spotify starts refusing and disappears when the key
 * expires, with nobody editing anything. A hand-written banner would need
 * someone to remember to take it down the next morning, and this codebase has
 * a long record of things that depend on someone remembering.
 *
 * Renders through a portal into document.body for the reason
 * components/changelog-modal.tsx documents: the landing pages' `.fade-in`
 * containers leave a transform behind, which makes them the containing block
 * for `position: fixed` descendants and would clip an inline overlay.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { errorMessage, type ErrorLocale } from "@/lib/error-messages";
import { useErrorLocale } from "@/lib/use-error-locale";
import {
  NOTICE_DISMISS_KEY,
  SERVICE_NOTICE_UI,
  shouldShowNotice,
} from "@/lib/service-notice";
import type { SpotifyServiceStatus } from "@/types/service-status";

/**
 * Module scope, so a client-side navigation between the pages that mount this
 * does not re-ask. Same shape of memo as lib/preview-cache.ts's cooldown memo,
 * and for the same reason: a site-wide, minute-scale signal is not worth one
 * request per mount. Throttling lasts minutes to hours, so a minute of
 * staleness costs nothing.
 */
const STATUS_MEMO_MS = 60_000;
let memo: { at: number; status: SpotifyServiceStatus } | null = null;

async function readStatus(signal: AbortSignal): Promise<SpotifyServiceStatus | null> {
  if (memo && Date.now() - memo.at < STATUS_MEMO_MS) return memo.status;
  try {
    const res = await fetch("/api/status", { signal });
    if (!res.ok) return null;
    const status = (await res.json()) as SpotifyServiceStatus;
    memo = { at: Date.now(), status };
    return status;
  } catch {
    // Fail quiet. A notice that cannot confirm there is a problem must not
    // invent one — the same fail-open rule getSpotifyServiceStatus follows.
    return null;
  }
}

export interface ServiceNoticeProps {
  /**
   * Forces the language, the way SiteFooter and ChangelogModal are given one.
   *
   * Without it this notice reads the *device* language, which is right for an
   * error — one room is read by several phones — and wrong for `/zh`, a page
   * written natively in Chinese. An English string there is a visible defect
   * rather than a fallback, so that page states its language instead of
   * hoping the reader's device agrees.
   */
  locale?: ErrorLocale;
}

export function ServiceNotice({ locale: forced }: ServiceNoticeProps = {}) {
  const detected = useErrorLocale();
  const locale = forced ?? detected;
  const [status, setStatus] = useState<SpotifyServiceStatus | null>(null);
  const [dismissedCode, setDismissedCode] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    try {
      setDismissedCode(sessionStorage.getItem(NOTICE_DISMISS_KEY));
    } catch {
      // Private mode and blocked site data both throw here. Not knowing about
      // a past dismissal is the harmless direction: the host sees it again.
    }
    const controller = new AbortController();
    readStatus(controller.signal).then(setStatus);
    return () => controller.abort();
  }, []);

  const open = mounted && shouldShowNotice(status, dismissedCode);

  const close = useCallback(() => {
    const code = status?.code;
    if (code) {
      try {
        sessionStorage.setItem(NOTICE_DISMISS_KEY, code);
      } catch {
        // Dismissal then lasts for this render only. Better than failing the
        // click.
      }
      setDismissedCode(code);
    }
  }, [status]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  if (!open || !status?.code) return null;

  const ui = SERVICE_NOTICE_UI[locale];
  // Params are passed for both codes. `spotify_cooldown` renders the seconds;
  // `spotify_quota_exhausted` carries no {seconds} placeholder on purpose (a
  // countdown measured in hours is a promise the app cannot keep) so the same
  // call is correct for both. See lib/error-messages.ts.
  const body = errorMessage(status.code, locale, {
    params: { seconds: status.retryAfterSeconds },
  });

  return createPortal(
    <div
      role="presentation"
      onClick={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
        animation: "sn-fade 0.15s ease-out",
      }}
    >
      <style>{`
        @keyframes sn-fade { from { opacity: 0 } to { opacity: 1 } }
        .sn-dismiss {
          background: #1DB954;
          color: #06210f;
          border: 0;
          border-radius: 999px;
          padding: 11px 26px;
          font-family: Outfit, system-ui, sans-serif;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
        }
        .sn-dismiss:hover { background: #24d363 }
      `}</style>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sn-title"
        aria-describedby="sn-body"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1a1a1a",
          border: "1px solid #2c2c2c",
          borderRadius: "16px",
          maxWidth: "460px",
          width: "100%",
          padding: "26px 24px 22px",
          outline: "none",
          boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
        }}
      >
        <h2
          id="sn-title"
          style={{
            margin: "0 0 12px",
            fontFamily: "'Bebas Neue', Impact, sans-serif",
            fontSize: "27px",
            letterSpacing: "0.5px",
            color: "#fff",
            lineHeight: 1.15,
          }}
        >
          {ui.title}
        </h2>
        <p
          id="sn-body"
          style={{
            margin: "0 0 20px",
            fontFamily: "Outfit, system-ui, sans-serif",
            fontSize: "15px",
            lineHeight: 1.65,
            color: "#bdbdbd",
          }}
        >
          {body}
        </p>
        <button
          type="button"
          className="sn-dismiss"
          onClick={close}
          aria-label={ui.close}
        >
          {ui.dismiss}
        </button>
      </div>
    </div>,
    document.body
  );
}
