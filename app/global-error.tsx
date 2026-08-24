"use client";

/**
 * The last resort: a throw in the root layout itself, which `app/error.tsx`
 * sits inside and therefore cannot catch.
 *
 * It replaces the whole document, so it has to supply `<html>` and `<body>` —
 * and nothing it renders may rely on anything the layout would have set up
 * (fonts, the AdSense loader, GA4). CrashScreen is written to that rule.
 */

import { CrashScreen } from "@/components/crash-screen";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#111" }}>
        <CrashScreen error={error} reset={reset} boundary="root" />
      </body>
    </html>
  );
}
