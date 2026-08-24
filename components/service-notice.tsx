"use client";

/**
 * A one-time popup about the shared Spotify allowance, shown before a host
 * pastes a link rather than after they press Start.
 *
 * It has two states and the difference between them is the whole feature:
 *
 *   - **warning** — the day's allowance is nearly spent and everything still
 *     works. This is the one that is worth having. A host reading it at eight
 *     o'clock can load their playlist while there is allowance for it, or pick
 *     one that has already been played; told at ten, when the refusal lands,
 *     they have no move left. Fires at SPOTIFY_BUDGET_WARN_RATIO.
 *   - **blocked** — new playlists are not loading. The original notice.
 *
 * Driven by `GET /api/status`, which reads the same KV keys the admission gate
 * in lib/playlist-cache.ts writes. That is the whole design: the notice appears
 * when the allowance runs down and disappears when the keys expire, with nobody
 * editing anything. A hand-written banner would need someone to remember to
 * take it down the next morning, and this codebase has a long record of things
 * that depend on someone remembering.
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
  noticeState,
  SELF_HOST_URL,
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

  const state = noticeState(status);
  if (!open || !state || !status?.code) return null;

  const ui = SERVICE_NOTICE_UI[locale];
  // Params are passed for every code. `spotify_cooldown` renders the seconds;
  // `spotify_quota_exhausted` and `spotify_budget_low` carry no {seconds}
  // placeholder on purpose — a countdown measured in hours is a promise the app
  // cannot keep, and the warning is a level with nothing to count down to — so
  // the same call is correct for all of them. See lib/error-messages.ts.
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
      {/*
        The body is several sentences — it has to say who refused, that the app
        is free, and where to go instead — and `document.body` is
        overflow:hidden while this is open, so a card taller than the phone
        would be unreadable with no way to scroll it. `.sn-card` sets the cap.

        It carries two `max-height` declarations, not one: `dvh` is the correct
        unit (it excludes the mobile URL bar) but Safari below 15.4 drops the
        whole declaration, which would silently restore the unscrollable card
        on exactly the old phones most likely to be short. The `vh` line is the
        floor; browsers that understand `dvh` take the second. It lives in the
        stylesheet rather than the inline style because a React style object
        cannot hold two values for one property.
      */}
      <style>{`
        @keyframes sn-fade { from { opacity: 0 } to { opacity: 1 } }
        /* See the note above <style> — two declarations on purpose. */
        .sn-card {
          max-height: calc(100vh - 32px);
          max-height: calc(100dvh - 32px);
          overflow-y: auto;
        }
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
        .sn-repo {
          color: #9a9a9a;
          font-family: Outfit, system-ui, sans-serif;
          font-size: 14px;
          text-decoration: none;
          border-bottom: 1px solid #3a3a3a;
          padding-bottom: 1px;
        }
        .sn-repo:hover { color: #1DB954; border-bottom-color: #1DB954 }
        /* This dialog traps Tab between the button and this link, so keyboard
           focus lands here by design and needs to be visible on #1a1a1a. */
        .sn-repo:focus-visible {
          outline: 2px solid #1DB954;
          outline-offset: 3px;
          border-radius: 3px;
        }
      `}</style>
      <div
        ref={dialogRef}
        className="sn-card"
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
          {ui.title[state]}
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "18px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            className="sn-dismiss"
            onClick={close}
            aria-label={ui.close}
          >
            {ui.dismiss}
          </button>
          {/*
            The one thing a host can actually do about this tonight. The
            message above says the app is free and that the quota is not for
            sale at this size, which is true and leaves the reader with
            nowhere to go; this is the somewhere.
          */}
          <a
            className="sn-repo"
            href={SELF_HOST_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {ui.repo} →
          </a>
        </div>
      </div>
    </div>,
    document.body
  );
}
