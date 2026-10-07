/**
 * `_redirects` as the Jx build writes it: parsing, matching (exact, splat, placeholders), chains,
 * and the rules a project carries in `project.json` when no file was written. The sample file is
 * the shape of the pilot's real output (`source destination status`).
 */
import { describe, expect, test } from "bun:test";
import {
  matchRedirect,
  parseRedirects,
  resolveRedirects,
  rulesFromProject,
} from "../../src/verify/redirects.ts";

const FILE = `# wp2jx
/6833-2 /what-you-need-to-know-about-metal-roof-painting/ 301
/agricultural /service/barn-painting/ 301
/blog/premium-paint /the-benefits-of-premium-paint/ 301
/docs/* /documentation/:splat 301
/team/:name /people/:name/ 302

/proxy /somewhere/ 200
/old-a /old-b 301
/old-b /old-c/ 301
/loop-a /loop-b 301
/loop-b /loop-a 301
/leaves /https://example.com/x 301
/gone https://example.com/away 308!
broken-line
`;

describe("parseRedirects", () => {
  const rules = parseRedirects(FILE);

  test("reads source, destination and status, skipping comments, blanks and lines with one field", () => {
    expect(rules).toHaveLength(12);
    expect(rules[0]).toEqual({
      from: "/6833-2",
      to: "/what-you-need-to-know-about-metal-roof-painting/",
      status: 301,
      force: false,
      line: 2,
    });
    expect(rules[5]).toMatchObject({ from: "/proxy", status: 200 });
  });

  test("a status with a bang is forced; a missing status is 301", () => {
    expect(rules.find((r) => r.from === "/gone")).toMatchObject({ status: 308, force: true });
    expect(parseRedirects("/a /b")[0]).toMatchObject({ status: 301, force: false });
  });
});

describe("matchRedirect", () => {
  const rules = parseRedirects(FILE);

  test("an exact source matches with or without the trailing slash, on either side", () => {
    expect(matchRedirect(rules, "/agricultural")?.to).toBe("/service/barn-painting/");
    expect(matchRedirect(rules, "/agricultural/")?.to).toBe("/service/barn-painting/");
    expect(matchRedirect(parseRedirects("/a/ /b 301"), "/a")?.to).toBe("/b");
  });

  test("a splat carries the rest of the path, slashes included", () => {
    expect(matchRedirect(rules, "/docs/a/b/c")?.to).toBe("/documentation/a/b/c");
    expect(matchRedirect(rules, "/docs")?.to).toBe("/documentation/");
  });

  test("a star with text after it answers only the paths that end in that text (anabaptistperspectives' `/*/true`)", () => {
    const tail = parseRedirects("/*/true /:splat 301");
    expect(matchRedirect(tail, "/essays/true")?.to).toBe("/essays");
    expect(matchRedirect(tail, "/a/b/true/")?.to).toBe("/a/b");
    expect(matchRedirect(tail, "/about/")).toBeUndefined();
    expect(matchRedirect(tail, "/")).toBeUndefined();
    expect(matchRedirect(tail, "/true/trues")).toBeUndefined();
  });

  test("only the first star is a wildcard; a second one is the character", () => {
    const two = parseRedirects("/a/*/b/* /z 301");
    expect(matchRedirect(two, "/a/x/b/y")).toBeUndefined();
    expect(matchRedirect(two, "/a/x/b/*")?.to).toBe("/z");
  });

  test("a star inside a segment is a prefix rule (`/essays-*`), and takes the rest as the splat", () => {
    const prefix = parseRedirects("/essays-* /essays/:splat 301");
    expect(matchRedirect(prefix, "/essays-old-name/")?.to).toBe("/essays/old-name");
    expect(matchRedirect(prefix, "/essays/old-name/")).toBeUndefined();
    expect(matchRedirect(prefix, "/essays")).toBeUndefined();
  });

  test("a bare star in the destination is the splat, as the build writes it when the author did", () => {
    expect(matchRedirect(parseRedirects("/x/* /y/* 301"), "/x/q/r")?.to).toBe("/y/q/r");
  });

  test("a dollar sign in the splat is carried as it is, not read as a replacement pattern", () => {
    const star = parseRedirects("/old/* /go/* 301\n/a/* https://other.com/* 301");
    expect(matchRedirect(star, "/old/cost$&x")?.to).toBe("/go/cost$&x");
    expect(matchRedirect(star, "/old/a$$b")?.to).toBe("/go/a$$b");
    expect(matchRedirect(star, "/old/it$'s")?.to).toBe("/go/it$'s");
    expect(matchRedirect(star, "/a/z$`")?.to).toBe("https://other.com/z$`");
  });

  test("a placeholder takes one segment and is substituted by name", () => {
    expect(matchRedirect(rules, "/team/ada")?.to).toBe("/people/ada/");
    expect(matchRedirect(rules, "/team/ada/extra")).toBeUndefined();
    expect(matchRedirect(rules, "/team")).toBeUndefined();
    expect(matchRedirect(rules, "/team//")).toBeUndefined();
  });

  test("a path no rule names is not redirected, and a longer path is not an exact match", () => {
    expect(matchRedirect(rules, "/agricultural/barns")).toBeUndefined();
    expect(matchRedirect(rules, "/")).toBeUndefined();
  });

  test("the first matching rule wins", () => {
    const first = parseRedirects("/a /first 301\n/a /second 301");
    expect(matchRedirect(first, "/a")?.to).toBe("/first");
  });
});

describe("resolveRedirects", () => {
  const rules = parseRedirects(FILE);

  test("follows a chain to its end and records the hops", () => {
    const chain = resolveRedirects(rules, "/old-a/");
    expect(chain.path).toBe("/old-c/");
    expect(chain.hops.map((h) => h.to)).toEqual(["/old-b", "/old-c/"]);
    expect(chain.loop).toBe(false);
  });

  test("a loop is reported, not followed forever", () => {
    const chain = resolveRedirects(rules, "/loop-a");
    expect(chain.loop).toBe(true);
    expect(chain.hops.length).toBeLessThanOrEqual(3);
  });

  test("a destination off the site ends the chain there", () => {
    expect(resolveRedirects(rules, "/gone").path).toBe("https://example.com/away");
  });

  test("a rewrite is not a redirect: the address stays", () => {
    expect(resolveRedirects(rules, "/proxy").path).toBe("/proxy");
  });

  test("a path nothing moves comes back unchanged", () => {
    expect(resolveRedirects(rules, "/about/")).toEqual({ path: "/about/", hops: [], loop: false });
  });
});

describe("rulesFromProject", () => {
  test("string, object and rewrite forms of project.json redirects", () => {
    const rules = rulesFromProject({
      "/a": "/b/",
      "/c/*": { destination: "/d/:splat", status: 302 },
      "/e": { destination: "/f/", rewrite: true },
    });
    expect(rules).toEqual([
      { from: "/a", to: "/b/", status: 301, force: false, line: 0 },
      { from: "/c/*", to: "/d/:splat", status: 302, force: false, line: 0 },
      { from: "/e", to: "/f/", status: 200, force: false, line: 0 },
    ]);
    expect(rulesFromProject(undefined)).toEqual([]);
  });
});
