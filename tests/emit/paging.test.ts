/**
 * A page built in pages of one of its lists (`src/emit/paging.ts`): the file, `$paths`, title, head
 * and redirect a claim makes, and a real `jx build` of the result (the numbered pages, their pager
 * and their canonical addresses).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  pagedFile,
  pagedHead,
  pagedPage,
  pagedPaths,
  pagedRedirect,
  pagedTitle,
} from "../../src/emit/paging.ts";
import { createReport } from "../../src/report.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../helpers/jx-build.ts";

setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

describe("the parts of a paged page", () => {
  test("the file is a catch-all where the page stood: its first page keeps the page's address", () => {
    expect(pagedFile("pages/essays.json")).toBe("pages/essays/[...page].json");
    expect(pagedFile("pages/index.json")).toBe("pages/[...page].json");
    expect(pagedFile("pages/about/index.json")).toBe("pages/about/[...page].json");
    expect(pagedFile("pages/about/team.json")).toBe("pages/about/team/[...page].json");
    expect(pagedFile("pages/category/[slug].json")).toBe("pages/category/[slug]/[...page].json");
  });

  test("$paths page the claimed list, once per value of the page's own $paths where it had some", () => {
    const claim = { key: "post_q1", pageSize: 10 };
    expect(pagedPaths(undefined, claim)).toEqual({
      paginate: { $ref: "#/state/post_q1" },
      pageSize: 10,
    });
    const own = { values: ["bible", "church"], param: "slug" };
    expect(pagedPaths(own, claim)).toEqual({
      each: own,
      paginate: { $ref: "#/state/post_q1" },
      pageSize: 10,
    });
  });

  test("the title says the page past the first; the canonical and og:url are the page's own", () => {
    expect(pagedTitle("Essays")).toBe(
      "Essays${state.$page.pagination.number > 1 ? ' - Page ' + state.$page.pagination.number : ''}",
    );
    const head = pagedHead([
      { tagName: "link", attributes: { rel: "canonical", href: "https://x.org/essays/" } },
      {
        tagName: "meta",
        attributes: { property: "og:url", content: "https://x.org${state.term.data.url ?? ''}" },
      },
      { tagName: "meta", attributes: { name: "description", content: "About essays" } },
      { tagName: "link", attributes: { rel: "canonical", href: "https://x.org/no-slash" } },
    ]) as { attributes: Record<string, string> }[];
    expect(head[0]!.attributes.href).toBe(
      "https://x.org/essays/${state.$page.pagination.number > 1 ? state.$page.pagination.number + '/' : ''}",
    );
    expect(head[1]!.attributes.content).toEndWith(
      "${state.$page.pagination.number > 1 ? state.$page.pagination.number + '/' : ''}",
    );
    expect(head[2]!.attributes.content).toBe("About essays");
    expect(head[3]!.attributes.href).toBe(
      "https://x.org/no-slash${state.$page.pagination.number > 1 ? '/' + state.$page.pagination.number + '/' : ''}",
    );
  });

  test("WordPress's own addresses of the later pages are redirected to the paged route's", () => {
    expect(pagedRedirect("/essays/")).toEqual({ from: "/essays/page/:n", to: "/essays/:n/" });
    expect(pagedRedirect("/")).toEqual({ from: "/page/:n", to: "/:n/" });
    expect(pagedRedirect("/category/:slug")).toEqual({
      from: "/category/:slug/page/:n",
      to: "/category/:slug/:n/",
    });
  });

  test("the page is copied, its components named from the new file, and the report says it", () => {
    const report = createReport();
    const doc = {
      title: "Essays",
      $layout: "./layouts/page.json",
      $elements: [{ $ref: "../components/x-card.json" }],
      state: { post_q1: {} },
      children: [],
    };
    const { file, doc: out } = pagedPage(
      "pages/essays.json",
      doc,
      { key: "post_q1", pageSize: 5 },
      report,
    );
    expect(file).toBe("pages/essays/[...page].json");
    expect(Object.keys(out)[0]).toBe("$paths");
    expect(out.$layout).toBe("./layouts/page.json");
    expect(out.$elements).toEqual([{ $ref: "../../components/x-card.json" }]);
    expect(doc.title).toBe("Essays");
    expect(report.entries()).toMatchObject([
      { code: "paging.paged", severity: "info", data: { file, key: "post_q1", pageSize: 5 } },
    ]);
  });
});

describe("built by Jx", () => {
  test("a paged list of three entries a page: the numbered pages, their items, pager links and canonical addresses", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `content/post/post-${i + 1}.md`,
        `---\ntitle: Post ${i + 1}\ndate: 2024-01-${String(10 + i).padStart(2, "0")}\nurl: /post-${i + 1}/\n---\n\nBody.\n`,
      ]),
    );
    const page = pagedPage(
      "pages/essays.json",
      {
        title: "Essays",
        // a page with no layout shows its title as the root's tooltip, bound: the converter writes one
        $layout: "./layouts/base.json",
        $head: [
          { tagName: "link", attributes: { rel: "canonical", href: "https://x.org/essays/" } },
        ],
        state: {
          post_q1: {
            $prototype: "ContentCollection",
            $src: "@jxsuite/parser/ContentCollection.class.json",
            contentType: "post",
            sort: [{ field: "date", order: "desc" }],
            timing: "compiler",
          },
        },
        children: [
          {
            tagName: "ul",
            children: [
              "${(state.post_q1).map(($i0) => ({ tagName: 'li', textContent: $i0.data.title }))}",
            ],
          },
          {
            tagName: "a",
            attributes: {
              rel: "next",
              href: "${state.$page.pagination.next ? state.$page.pagination.next + '/' : ''}",
            },
            textContent: "Older",
          },
        ],
      },
      { key: "post_q1", pageSize: 3 },
    );
    const built = await buildJxProject(
      {
        "project.json": {
          name: "paged",
          url: "https://x.org",
          extensions: ["@jxsuite/parser"],
          content: { post: { source: "content/post", format: "Markdown" } },
        },
        [page.file]: page.doc,
        "layouts/base.json": { tagName: "div", children: [{ tagName: "slot" }] },
        ...entries,
      },
      { name: "paged" },
    );
    const items = (route: string): string[] =>
      [...built.html(route).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]!);
    expect(items("/essays/")).toEqual(["Post 7", "Post 6", "Post 5"]);
    expect(items("/essays/2/")).toEqual(["Post 4", "Post 3", "Post 2"]);
    expect(items("/essays/3/")).toEqual(["Post 1"]);
    expect(built.exists("essays/4/index.html")).toBe(false);
    expect(built.html("/essays/")).toContain('href="/essays/2/"');
    expect(built.html("/essays/2/")).toContain("<title>Essays - Page 2</title>");
    expect(built.html("/essays/")).toContain("<title>Essays</title>");
    expect(built.html("/essays/2/")).toContain('href="https://x.org/essays/2/"');
    expect(built.html("/essays/")).toContain('href="https://x.org/essays/"');
    // a page that pages its list ships no script
    expect(built.html("/essays/2/")).not.toMatch(/app\.js|data-bind/);
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
  });
});
