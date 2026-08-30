// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GUIDES,
  getGuide,
  relatedGuides,
  GUIDE_CATEGORIES,
  guidesByCategory,
  guideMetadata,
  formatGuideDate,
} from "@/lib/guides";
import sitemap from "@/app/sitemap";

/**
 * `lib/guides.ts` declares each article once and four things derive from it:
 * the route, the index page, the sitemap, and the "read next" links on its
 * siblings. Every one of those fails silently when it drifts — a guide missing
 * from the sitemap is a page Google never returns for, and a "read next"
 * pointing at a retired slug is a 404 a reader finds before we do. These tests
 * are the join between the metadata and the prose it describes.
 */

const GUIDES_DIR = join(process.cwd(), "app/guides");

/** Article directories under app/guides — the non-route files are not routes. */
function articleDirs(): string[] {
  return readdirSync(GUIDES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe("guides index", () => {
  it("has a page directory for every declared guide", () => {
    for (const guide of GUIDES) {
      const page = join(GUIDES_DIR, guide.slug, "page.tsx");
      expect(existsSync(page), `${guide.slug} is declared but has no page.tsx`).toBe(true);
    }
  });

  it("declares every page directory", () => {
    // The other direction: an article that exists but is not in the index is
    // unreachable from /guides and absent from the sitemap.
    for (const dir of articleDirs()) {
      expect(getGuide(dir), `app/guides/${dir} has no entry in lib/guides.ts`).toBeDefined();
    }
  });

  it("wires each page to its own slug", () => {
    // A copy-pasted article that kept the source's SLUG constant renders the
    // wrong title, description and canonical under the right URL.
    for (const guide of GUIDES) {
      const source = readFileSync(join(GUIDES_DIR, guide.slug, "page.tsx"), "utf8");
      expect(source).toContain(`const SLUG = "${guide.slug}"`);
    }
  });

  it("uses unique slugs", () => {
    const slugs = GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses URL-safe slugs", () => {
    for (const guide of GUIDES) {
      expect(guide.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("gives every guide the copy the index and the article both need", () => {
    for (const guide of GUIDES) {
      expect(guide.title.length).toBeGreaterThan(10);
      expect(guide.navTitle.length).toBeGreaterThan(5);
      expect(guide.lede.length).toBeGreaterThan(20);
      // Google truncates well before 200; a description longer than that is one
      // that gets cut mid-sentence in the only place it is ever read.
      expect(guide.description.length).toBeGreaterThan(60);
      expect(guide.description.length).toBeLessThan(260);
      expect(guide.minutes).toBeGreaterThan(0);
    }
  });

  it("dates every guide as a real ISO day", () => {
    for (const guide of GUIDES) {
      expect(guide.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(new Date(guide.published).getTime())).toBe(false);
    }
  });

  it("puts every guide in a category the index renders", () => {
    // A category the index does not loop over is a guide nobody can reach.
    for (const guide of GUIDES) {
      expect(GUIDE_CATEGORIES).toContain(guide.category);
    }
  });

  it("resolves every related slug, and never to itself", () => {
    for (const guide of GUIDES) {
      for (const slug of guide.related) {
        expect(getGuide(slug), `${guide.slug} links to unknown guide ${slug}`).toBeDefined();
        expect(slug).not.toBe(guide.slug);
      }
      expect(relatedGuides(guide.slug).length).toBe(guide.related.length);
    }
  });

  it("gives every guide at least one inbound link from a sibling", () => {
    // An article nothing links to is one Google reaches only via the sitemap,
    // and one a reader never finds from the article they are already on.
    const linked = new Set(GUIDES.flatMap((g) => g.related));
    for (const guide of GUIDES) {
      expect(linked.has(guide.slug), `nothing links to ${guide.slug}`).toBe(true);
    }
  });
});

describe("homepage guide teaser", () => {
  // app/page.tsx picks a few slugs by hand and resolves them through getGuide,
  // filtering out anything that does not resolve. That filter is deliberate —
  // a retired guide should cost a card rather than crash the homepage — but it
  // makes a *typo* silent in exactly the same way, and the homepage is the one
  // inbound link that reliably gets a new guide crawled. Read as source text
  // because the suite cannot import a .tsx module here; same technique as
  // "wires each page to its own slug" above.
  const source = readFileSync(join(process.cwd(), "app/page.tsx"), "utf8");

  function homeGuideSlugs(): string[] {
    const match = source.match(/const HOME_GUIDES = \[([\s\S]*?)\]/);
    expect(match, "HOME_GUIDES array not found in app/page.tsx").toBeTruthy();
    return Array.from(match![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  }

  it("names at least one guide", () => {
    expect(homeGuideSlugs().length).toBeGreaterThan(0);
  });

  it("resolves every slug it names", () => {
    for (const slug of homeGuideSlugs()) {
      expect(getGuide(slug), `app/page.tsx links to unknown guide "${slug}"`).toBeDefined();
    }
  });

  it("names each guide at most once", () => {
    const slugs = homeGuideSlugs();
    expect(new Set(slugs).size, "a guide is listed twice on the homepage").toBe(slugs.length);
  });
});

describe("guide lookups", () => {
  // The happy paths are covered above by the directory/slug joins. These are
  // the branches those never reach — the ones that only run once a guide is
  // renamed or retired, which is exactly when nobody is looking.
  it("returns undefined for a slug that is not a guide", () => {
    expect(getGuide("no-such-guide")).toBeUndefined();
    expect(getGuide("")).toBeUndefined();
  });

  it("returns no related guides for an unknown slug", () => {
    // relatedGuides reads through getGuide, so an unknown slug must fall out
    // as an empty list rather than throwing. A retired guide should cost its
    // siblings a link, not crash the page they are on.
    expect(relatedGuides("no-such-guide")).toEqual([]);
  });

  it("never returns a guide as its own related guide", () => {
    for (const guide of GUIDES) {
      expect(relatedGuides(guide.slug).map((g) => g.slug)).not.toContain(guide.slug);
    }
  });

  it("resolves related slugs to the guides themselves, in declared order", () => {
    const guide = GUIDES[0];
    expect(relatedGuides(guide.slug).map((g) => g.slug)).toEqual(guide.related);
  });

  it("partitions every guide across the rendered categories exactly once", () => {
    // The index renders GUIDE_CATEGORIES and nothing else, so a guide in a
    // category missing from that list is a page with no route to it from
    // /guides — reachable only from the sitemap, and invisible on the site.
    const rendered = GUIDE_CATEGORIES.flatMap((c) => guidesByCategory(c));
    expect(rendered.map((g) => g.slug).sort()).toEqual(GUIDES.map((g) => g.slug).sort());
  });

  it("returns nothing for a category no guide uses", () => {
    expect(guidesByCategory("Nonexistent" as never)).toEqual([]);
  });
});

describe("guideMetadata", () => {
  it("derives title, description and canonical from the guides index", () => {
    for (const guide of GUIDES) {
      const meta = guideMetadata(guide.slug);
      expect(meta.title).toBe(guide.navTitle);
      expect(meta.description).toBe(guide.description);
      expect(meta.alternates?.canonical).toBe(`/guides/${guide.slug}`);
      expect(meta.openGraph?.title).toBe(guide.title);
    }
  });

  it("throws on an unknown slug rather than returning a hollow page", () => {
    // The slug is written by us, in the same file as the prose, so a bad one
    // is a typo that should fail the build — never a visitor's blank <title>.
    expect(() => guideMetadata("no-such-guide")).toThrow(/Unknown guide slug/);
  });
});

describe("formatGuideDate", () => {
  it("formats an ISO day without touching the locale", () => {
    // Deliberately not toLocaleDateString: the server and the client must
    // produce the same string or React logs a hydration mismatch on a page
    // whose only job is to be read.
    expect(formatGuideDate("2026-08-21")).toBe("21 August 2026");
    expect(formatGuideDate("2026-01-01")).toBe("1 January 2026");
    expect(formatGuideDate("2026-12-31")).toBe("31 December 2026");
  });

  it("formats every guide's own date", () => {
    for (const guide of GUIDES) {
      expect(formatGuideDate(guide.published)).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
    }
  });
});

describe("sitemap", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("lists every guide", () => {
    for (const guide of GUIDES) {
      expect(urls.some((u) => u.endsWith(`/guides/${guide.slug}`))).toBe(true);
    }
  });

  it("lists the guides index itself", () => {
    expect(urls.some((u) => u.endsWith("/guides"))).toBe(true);
  });

  it("lists the policy pages", () => {
    // An ad network's site review looks for these, and a page it cannot find
    // reads exactly like a page that does not exist.
    for (const path of ["/privacy", "/terms", "/contact", "/zh/privacy", "/zh/terms"]) {
      expect(urls.some((u) => u.endsWith(path)), `sitemap is missing ${path}`).toBe(true);
    }
  });

  it("has no duplicate URLs", () => {
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("annotates both halves of every language pair identically", () => {
    // The rule is written at the top of app/sitemap.ts and was broken three
    // entries below it in 1.7.0: the policy pages carried en/zh-TW/x-default on
    // the English half and nothing on the /zh half. A comment did not stop that
    // and would not stop it again — a one-sided cluster still renders, still
    // builds, and just reads to Google as a weaker signal than declaring
    // nothing. This is the assertion that makes it loud.
    const entries = sitemap();
    const byUrl = new Map(entries.map((e) => [e.url, e]));

    for (const entry of entries) {
      const languages = entry.alternates?.languages;
      if (!languages) continue;

      for (const [tag, target] of Object.entries(languages)) {
        const href = String(target);
        // x-default routinely points at a URL already named by another tag;
        // what matters is that the target is in the sitemap and agrees.
        const counterpart = byUrl.get(href);
        expect(
          counterpart,
          `${entry.url} names ${tag}=${href}, which is not in the sitemap`
        ).toBeDefined();
        expect(
          counterpart!.alternates?.languages,
          `${entry.url} and its ${tag} counterpart ${href} declare different alternate sets`
        ).toEqual(languages);
      }
    }
  });

  it("gives every language pair an x-default", () => {
    // Without it Google picks the fallback itself, and the whole point of
    // declaring a cluster is not leaving that to chance.
    const clustered = sitemap().filter((e) => e.alternates?.languages);
    expect(clustered.length).toBeGreaterThan(0);
    for (const entry of clustered) {
      expect(
        Object.keys(entry.alternates!.languages!),
        `${entry.url} declares alternates without an x-default`
      ).toContain("x-default");
    }
  });

  it("keeps every URL absolute and on one origin", () => {
    for (const url of urls) {
      expect(url).toMatch(/^https?:\/\//);
    }
    const origins = new Set(urls.map((u) => new URL(u).origin));
    expect(origins.size).toBe(1);
  });
});
