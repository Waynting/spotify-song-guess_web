"use client";

/**
 * The segment-level error boundary, and the one that matters here.
 *
 * `app/` had none at all, so every client-side throw — a mount effect on
 * `/game`, a chunk that failed to load mid-navigation, a payload that could not
 * be read — landed on Next's built-in fallback and told the host to open a
 * developer console. This catches all of them below the root layout, which
 * means the page keeps its fonts and the host keeps a way out.
 *
 * Deliberately not a `try/catch` at each throw site: the value of a boundary is
 * that it also catches the throw nobody predicted, which is the category the
 * reported bug was in.
 */

import { CrashScreen } from "@/components/crash-screen";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <CrashScreen error={error} reset={reset} boundary="route" />;
}
