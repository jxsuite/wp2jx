/**
 * Addresses: when two links are the same place, how the URL list is read from sitemaps and files,
 * how a run is sampled and its pages named. The sitemap samples have the shape of the pilot's real
 * Rank Math sitemaps (an index, a urlset with image entries, an XSL processing instruction).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRedirects } from "../../src/verify/redirects.ts";
import {
  createResolver,
  familyName,
  parseSitemap,
  pathOf,
  readLiveSitemaps,
  readUrlFile,
  sample,
  slugOf,
  type Fetcher,
} from "../../src/verify/urls.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

const LIVE = "https://finelinepainting.pro";
const LOCAL = "http://127.0.0.1:4000";
const rules = parseRedirects(`/6833-2 /what-you-need-to-know-about-metal-roof-painting/ 301
/agricultural /service/barn-painting/ 301
/docs/* https://docs.example.com/:splat 301
`);
const resolver = createResolver({ liveUrl: LIVE, localOrigin: LOCAL, rules });

describe("familyName", () => {
  test("drops the extension, the WordPress size and scaled suffixes, and the case", () => {
    expect(familyName("Barn-Painting-In-Lancaster-PA-1-300x200.jpg")).toBe(
      "barn-painting-in-lancaster-pa-1",
    );
    expect(familyName("professional-painters-scaled.jpg")).toBe("professional-painters");
    expect(familyName("50-year-logo-fine-line-painting-1-e1773348994562-768x704.png")).toBe(
      "50-year-logo-fine-line-painting-1-e1773348994562",
    );
    expect(familyName("a%20b.WEBP")).toBe("a b");
    expect(familyName("plain")).toBe("plain");
    // A converter's own extension on top of the original, and dots inside a name that are not an extension.
    expect(familyName("50-year-logo-e1773348994562.png.webp")).toBe("50-year-logo-e1773348994562");
    expect(familyName("WhatsApp-Image-2026-04-13-at-19.54.36-scaled.jpeg")).toBe(
      "whatsapp-image-2026-04-13-at-19.54.36",
    );
    expect(familyName("clip.v2")).toBe("clip.v2");
    // The pipeline's `-<width>-<hash>` goes only for a file the pipeline wrote.
    expect(familyName("barn-1280-c096b2b3.avif", true)).toBe("barn");
    expect(familyName("barn-1280-c096b2b3.avif")).toBe("barn-1280-c096b2b3");
    expect(familyName("whatsapp-image-scaled-640-6cb3ab4e.avif", true)).toBe("whatsapp-image");
  });
});

describe("Resolver.normalize", () => {
  test("same-site addresses become paths with the directory form, whichever origin they came from", () => {
    expect(resolver.normalize("/about-us")).toBe("/about-us/");
    expect(resolver.normalize("/about-us/")).toBe("/about-us/");
    expect(resolver.normalize(`${LIVE}/about-us/`)).toBe("/about-us/");
    expect(resolver.normalize(`${LOCAL}/about-us`)).toBe("/about-us/");
    expect(resolver.normalize("https://www.finelinepainting.pro/about-us/")).toBe("/about-us/");
    expect(resolver.normalize("../contact-us", `${LIVE}/blog/post/`)).toBe("/blog/contact-us/");
    expect(resolver.normalize("/search/?q=paint")).toBe("/search/?q=paint");
  });

  test("a link and its redirect destination are the same place", () => {
    expect(resolver.normalize("/agricultural")).toBe(resolver.normalize("/service/barn-painting/"));
    expect(resolver.normalize(`${LIVE}/6833-2/`)).toBe(
      "/what-you-need-to-know-about-metal-roof-painting/",
    );
  });

  test("a redirect that leaves the site becomes an external address", () => {
    expect(resolver.normalize("/docs/start")).toBe("https://docs.example.com/start");
  });

  test("uploads and migrated media are one thing, whatever the size suffix and folder", () => {
    const live = resolver.normalize(`${LIVE}/wp-content/uploads/2024/03/Barn-300x200.jpg`);
    expect(live).toBe("media:barn");
    expect(resolver.normalize("/media/barn.jpg")).toBe("media:barn");
    expect(resolver.normalize("/media/2024/03/barn.webp")).toBe("media:barn");
  });

  test("external addresses keep their origin and path, lose the trailing slash and the fragment", () => {
    expect(resolver.normalize("https://Example.com/x/#top")).toBe("https://example.com/x");
    expect(resolver.normalize("https://example.com")).toBe("https://example.com");
    expect(resolver.normalize("https://example.com/?a=1")).toBe("https://example.com?a=1");
  });

  test("mail and phone links compare by target, case and spaces ignored", () => {
    expect(resolver.normalize("mailto:Info@Example.com")).toBe("mailto:info@example.com");
    expect(resolver.normalize("tel:+1 717 555 0100")).toBe("tel:+17175550100");
  });

  test("a mail or phone link with a malformed percent sequence is kept as written, not a crash", () => {
    expect(resolver.normalize("mailto:a%zz@b.com")).toBe("mailto:a%zz@b.com");
    expect(resolver.normalize("tel:%")).toBe("tel:%");
    expect(resolver.normalize("mailto:%E0%A4%A")).toBe("mailto:%e0%a4%a");
  });

  test("a file on another host of the same site is the migrated /media/ file", () => {
    const ap = createResolver({
      liveUrl: "https://anabaptistperspectives.org",
      localOrigin: "http://127.0.0.1:1234",
    });
    const live = ap.normalize(
      "https://media.anabaptistperspectives.org/Anabaptist-Perspectives-Essay-Submissions.pdf",
    );
    expect(live).toBe("media:anabaptist-perspectives-essay-submissions.pdf");
    expect(
      ap.normalize("http://127.0.0.1:1234/media/Anabaptist-Perspectives-Essay-Submissions.pdf"),
    ).toBe(live);
    // A page on a subdomain is still somebody else's page.
    expect(ap.normalize("https://shop.anabaptistperspectives.org/cart/")).toBe(
      "https://shop.anabaptistperspectives.org/cart",
    );
    // And another site's files are not ours.
    expect(ap.normalize("https://media.other.org/a.pdf")).toBe("https://media.other.org/a.pdf");
  });

  test("an anchor, an empty href and javascript name nothing", () => {
    for (const href of ["", "  ", "#", "#top", "javascript:void(0)"])
      expect(resolver.normalize(href)).toBeUndefined();
  });

  test("an unparseable address names nothing, an odd scheme is kept as written", () => {
    expect(resolver.normalize("http://[bad")).toBeUndefined();
    expect(resolver.normalize("sms:123")).toBe("sms:123");
  });

  test("a live site that is itself on www owns its bare twin, and the other way round", () => {
    const www = createResolver({ liveUrl: "https://www.example.org", localOrigin: LOCAL });
    expect(www.normalize("https://example.org/about")).toBe("/about/");
    expect(www.normalize("https://www.example.org/about")).toBe("/about/");
    expect(www.isInternal("https://example.org/")).toBe(true);
    expect(www.isInternal("https://blog.example.org/")).toBe(false);
    const bare = createResolver({ liveUrl: "https://example.org", localOrigin: LOCAL });
    expect(bare.normalize("https://www.example.org/about")).toBe("/about/");
    expect(bare.isInternal("https://www.example.org/")).toBe(true);
  });

  test("isInternal knows the live site, its www twin and the local server", () => {
    expect(resolver.isInternal("/x")).toBe(true);
    expect(resolver.isInternal(`${LOCAL}/x`)).toBe(true);
    expect(resolver.isInternal("https://www.finelinepainting.pro/")).toBe(true);
    expect(resolver.isInternal("https://example.com/")).toBe(false);
    expect(resolver.isInternal("http://[bad")).toBe(false);
    expect(resolver.isInternal("mailto:a@b.c")).toBe(false);
  });

  test("imageKey reduces an address to its family", () => {
    expect(resolver.imageKey(`${LIVE}/wp-content/uploads/2024/Barn-1024x768.jpg`)).toBe("barn");
    expect(resolver.imageKey("/media/barn.webp")).toBe("barn");
    // The Jx pipeline's derivative of an upload, and a converter's double extension, are the same picture.
    expect(resolver.imageKey(`${LOCAL}/images/_optimized/Barn-Painting-1280-1627633a.avif`)).toBe(
      "barn-painting",
    );
    expect(resolver.imageKey(`${LIVE}/wp-content/uploads/Barn-Painting.png.webp`)).toBe(
      "barn-painting",
    );
    expect(resolver.imageKey(`${LIVE}/wp-content/uploads/Barn-Painting-768x549.png`)).toBe(
      "barn-painting",
    );
    expect(resolver.imageKey("data:image/svg+xml;base64,AAAA")).toStartWith("data:");
  });
});

const INDEX = `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="//finelinepainting.pro/main-sitemap.xsl"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<sitemap><loc>https://finelinepainting.pro/post-sitemap.xml</loc><lastmod>2026-09-17T16:50:16+00:00</lastmod></sitemap>
	<sitemap><loc>https://finelinepainting.pro/page-sitemap.xml</loc><lastmod>2026-09-17T17:18:14+00:00</lastmod></sitemap>
</sitemapindex>`;
const PAGES = `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="//finelinepainting.pro/main-sitemap.xsl"?>
<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
	<url>
		<loc>https://finelinepainting.pro/</loc>
		<lastmod>2026-09-17T16:09:25+00:00</lastmod>
		<image:image><image:loc>https://finelinepainting.pro/wp-content/uploads/Interior-painting-in-Lebanon-Pa.png</image:loc></image:image>
	</url>
	<url><loc>https://finelinepainting.pro/about-us/?a=1&amp;b=2</loc></url>
	<url><loc>https://finelinepainting.pro/files/menu.pdf</loc></url>
	<url><loc>https://other.example.com/page/</loc></url>
	<url><loc>not a url</loc></url>
</urlset>`;
const POSTS = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://finelinepainting.pro/blog/</loc></url><url><loc>https://finelinepainting.pro/</loc></url></urlset>`;

function fetcherOf(files: Record<string, string>, log: string[] = []): Fetcher {
  return async (url) => {
    log.push(url);
    const body = files[url];
    return { ok: body !== undefined, text: async () => body ?? "" };
  };
}

describe("parseSitemap", () => {
  test("an index lists sitemaps, a urlset lists pages, and the image entries are not pages", () => {
    expect(parseSitemap(INDEX)).toEqual({
      index: true,
      locs: [
        "https://finelinepainting.pro/post-sitemap.xml",
        "https://finelinepainting.pro/page-sitemap.xml",
      ],
    });
    const pages = parseSitemap(PAGES);
    expect(pages.index).toBe(false);
    expect(pages.locs).toEqual([
      "https://finelinepainting.pro/",
      "https://finelinepainting.pro/about-us/?a=1&b=2",
      "https://finelinepainting.pro/files/menu.pdf",
      "https://other.example.com/page/",
      "not a url",
    ]);
  });

  test("entities in a location are decoded", () => {
    expect(
      parseSitemap(
        "<urlset><url><loc>https://x.test/a?b=1&amp;c=&lt;2&gt;&quot;&#39;</loc></url></urlset>",
      ).locs,
    ).toEqual([`https://x.test/a?b=1&c=<2>"'`]);
  });

  test("a location in CDATA, or after other children of its url, is still read", () => {
    expect(
      parseSitemap(
        "<urlset><url><loc><![CDATA[https://x.org/a/?p=1&q=2]]></loc></url><url><lastmod>2020</lastmod><loc>https://x.org/c/</loc></url><url><loc>https://x.org/b/</loc></url></urlset>",
      ).locs,
    ).toEqual(["https://x.org/a/?p=1&q=2", "https://x.org/c/", "https://x.org/b/"]);
    expect(
      parseSitemap(
        "<sitemapindex><sitemap><lastmod>1</lastmod><loc><![CDATA[https://x.org/s.xml]]></loc></sitemap></sitemapindex>",
      ).locs,
    ).toEqual(["https://x.org/s.xml"]);
  });

  test("a doubly escaped ampersand decodes once", () => {
    expect(
      parseSitemap("<urlset><url><loc>https://x.test/a?b=&amp;lt;</loc></url></urlset>").locs,
    ).toEqual(["https://x.test/a?b=&lt;"]);
  });

  test("something that is not a sitemap has no locations", () => {
    expect(parseSitemap("<html></html>")).toEqual({ index: false, locs: [] });
  });
});

describe("readLiveSitemaps", () => {
  test("follows the index, keeps same-site pages only, drops files and repeats, in sitemap order", async () => {
    const log: string[] = [];
    const result = await readLiveSitemaps(
      LIVE,
      fetcherOf(
        {
          [`${LIVE}/robots.txt`]:
            "User-agent: *\nSitemap: https://finelinepainting.pro/sitemap_index.xml\n",
          [`${LIVE}/sitemap_index.xml`]: INDEX,
          [`${LIVE}/post-sitemap.xml`]: POSTS,
          [`${LIVE}/page-sitemap.xml`]: PAGES,
        },
        log,
      ),
    );
    expect(result.urls).toEqual([`${LIVE}/blog/`, `${LIVE}/`, `${LIVE}/about-us/?a=1&b=2`]);
    expect(result.sources).toEqual([
      `${LIVE}/sitemap_index.xml`,
      `${LIVE}/post-sitemap.xml`,
      `${LIVE}/page-sitemap.xml`,
    ]);
    // Once an entry point gave pages, the other names for the same list are not read.
    expect(log).not.toContain(`${LIVE}/wp-sitemap.xml`);
    expect(result.problems).toEqual([]);
  });

  test("every Sitemap line of robots.txt is read, not only the first that yields pages", async () => {
    const result = await readLiveSitemaps(
      "https://s.test",
      fetcherOf({
        "https://s.test/robots.txt":
          "Sitemap: https://s.test/post-sitemap.xml\nSitemap: https://s.test/page-sitemap.xml\n",
        "https://s.test/post-sitemap.xml":
          "<urlset><url><loc>https://s.test/p1/</loc></url></urlset>",
        "https://s.test/page-sitemap.xml":
          "<urlset><url><loc>https://s.test/p2/</loc></url></urlset>",
        "https://s.test/sitemap_index.xml":
          "<urlset><url><loc>https://s.test/conventional/</loc></url></urlset>",
      }),
    );
    expect(result.urls).toEqual(["https://s.test/p1/", "https://s.test/p2/"]);
    expect(result.sources).toEqual([
      "https://s.test/post-sitemap.xml",
      "https://s.test/page-sitemap.xml",
    ]);
  });

  test("falls back to wp-sitemap.xml when the first names are not there", async () => {
    const result = await readLiveSitemaps(LIVE, fetcherOf({ [`${LIVE}/wp-sitemap.xml`]: POSTS }));
    expect(result.urls).toEqual([`${LIVE}/blog/`, `${LIVE}/`]);
  });

  test("a child sitemap that cannot be read is a problem, not a failure", async () => {
    const result = await readLiveSitemaps(LIVE, async (url) => {
      if (url.endsWith("post-sitemap.xml")) throw new Error("timeout");
      const body = (
        { [`${LIVE}/sitemap_index.xml`]: INDEX, [`${LIVE}/page-sitemap.xml`]: PAGES } as Record<
          string,
          string
        >
      )[url];
      return { ok: body !== undefined, text: async () => body ?? "" };
    });
    expect(result.urls).toContain(`${LIVE}/about-us/?a=1&b=2`);
    expect(result.problems).toEqual([`${LIVE}/post-sitemap.xml: timeout`]);
  });

  test("an entry without a readable location is a problem, so a short list is not a silent one", async () => {
    const result = await readLiveSitemaps(
      "https://s.test",
      fetcherOf({
        "https://s.test/sitemap.xml":
          "<urlset><url><lastmod>1</lastmod></url><url><loc>https://s.test/a/</loc></url></urlset>",
      }),
    );
    expect(result.urls).toEqual(["https://s.test/a/"]);
    expect(result.problems).toEqual(["https://s.test/sitemap.xml: 1 entries without a <loc>"]);
  });

  test("a site with no sitemap gives an empty list", async () => {
    expect(await readLiveSitemaps(LIVE, fetcherOf({}))).toEqual({
      urls: [],
      sources: [],
      problems: [],
    });
  });

  test("a sitemap that links back to itself is read once", async () => {
    const loop = `<sitemapindex><sitemap><loc>${LIVE}/sitemap_index.xml</loc></sitemap><sitemap><loc>${LIVE}/p.xml</loc></sitemap></sitemapindex>`;
    const result = await readLiveSitemaps(
      LIVE,
      fetcherOf({ [`${LIVE}/sitemap_index.xml`]: loop, [`${LIVE}/p.xml`]: POSTS }),
    );
    expect(result.urls).toEqual([`${LIVE}/blog/`, `${LIVE}/`]);
  });
});

describe("readUrlFile", () => {
  const dir = mkdtempSync(
    join((mkdirSync(TMP_ROOT, { recursive: true }), TMP_ROOT), "verify-urls-"),
  );
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("one address or path per line, with comments, blanks and repeats", () => {
    const file = join(dir, "urls.txt");
    writeFileSync(
      file,
      `# the pages\n/\n/about-us/   # trailing note\n\n${LIVE}/about-us/\nhttps://finelinepainting.pro/blog/?p=2\n`,
    );
    expect(readUrlFile(file, LIVE)).toEqual([`${LIVE}/`, `${LIVE}/about-us/`, `${LIVE}/blog/?p=2`]);
  });

  test("a JSON array of strings", () => {
    const file = join(dir, "urls.json");
    writeFileSync(file, JSON.stringify(["/a/", `${LIVE}/b/`]));
    expect(readUrlFile(file, LIVE)).toEqual([`${LIVE}/a/`, `${LIVE}/b/`]);
  });

  test("a JSON file that is not an array of strings, and a file that is not there, say so", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify([1, 2]));
    expect(() => readUrlFile(file, LIVE)).toThrow("array of strings");
    writeFileSync(
      file,
      JSON.stringify({ a: 1 }).replace("{", "[").replace("}", "]").replace('"a":1', "1"),
    );
    expect(() => readUrlFile(file, LIVE)).toThrow("array of strings");
    expect(() => readUrlFile(join(dir, "missing.txt"), LIVE)).toThrow("no such file");
  });
});

describe("sample and naming", () => {
  const urls = ["/", ...Array.from({ length: 19 }, (_, i) => `/p${i}/`)].map((p) => `${LIVE}${p}`);

  test("everything when the cap is not reached; nothing for a cap of zero", () => {
    expect(sample(urls, undefined)).toEqual(urls);
    expect(sample(urls, 50)).toEqual(urls);
    expect(sample(urls, 0)).toEqual([]);
  });

  test("the home page first, then an even spread, never a repeat", () => {
    const picked = sample(urls, 5);
    expect(picked).toHaveLength(5);
    expect(picked[0]).toBe(`${LIVE}/`);
    expect(new Set(picked).size).toBe(5);
    expect(pathOf(picked[1] as string)).toBe("/p0/");
    expect(pathOf(picked.at(-1) as string)).not.toBe("/p1/");
    // spread across the list, not its first few
    expect(Number(pathOf(picked.at(-1) as string).slice(2, -1))).toBeGreaterThan(10);
  });

  test("the spread leaves room for the home page: exactly these pages for five of twenty", () => {
    expect(sample(urls, 5).map(pathOf)).toEqual(["/", "/p0/", "/p4/", "/p9/", "/p14/"]);
  });

  test("a list without a home page is sampled evenly too", () => {
    expect(sample(urls.slice(1), 3)).toHaveLength(3);
  });

  test("slugs are short, safe and unique; a query makes a different page", () => {
    const taken = new Set<string>();
    expect(slugOf(`${LIVE}/`, taken)).toBe("index");
    expect(slugOf(`${LIVE}/about-us/`, taken)).toBe("about-us");
    expect(slugOf(`${LIVE}/blog/some post/`, taken)).toBe("blog_some_post");
    expect(slugOf(`${LIVE}/about-us/`, taken)).toBe("about-us-2");
    const q = slugOf(`${LIVE}/search/?q=a`, taken);
    expect(q).toMatch(/^search_q[a-z0-9]+$/);
    expect(slugOf(`${LIVE}/search/?q=b`, taken)).not.toBe(q);
  });

  test("a path of encoded dots never names a folder above the page's own", () => {
    const taken = new Set<string>();
    for (const path of ["/%2e%2e%2f", "/%2e%2f", "/%2e", "/..", "/.hidden/", "/a/%2e%2e/"]) {
      const slug = slugOf(`https://x.org${path}`, taken);
      expect(slug).not.toBe("..");
      expect(slug).not.toBe(".");
      expect(slug.startsWith(".")).toBe(false);
      expect(slug).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
    }
    expect(taken.size).toBe(6);
  });

  test("pathOf keeps the query", () => {
    expect(pathOf(`${LIVE}/a/?b=1`)).toBe("/a/?b=1");
  });
});
