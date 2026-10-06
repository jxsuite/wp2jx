import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { WpBlock } from "../../src/types.ts";
import { countBlocks, parseBlocks, walkBlocks } from "../../src/wp/blocks.ts";
import { fixtureDb } from "../helpers/fixture-db.ts";

// ── Real posts, read straight from the SQLite files ─────────────────────────────────────────────

interface PostRow {
  id: number;
  type: string;
  status: string;
  content: string;
}

async function loadPosts(site: string): Promise<PostRow[]> {
  const { path, prefix } = await fixtureDb(site);
  const db = new Database(path, { readonly: true });
  const rows = db
    .query(
      `select ID as id, post_type as type, post_status as status, post_content as content from ${prefix}posts order by ID`,
    )
    .all() as PostRow[];
  db.close();
  return rows;
}

const sites = { fineline: await loadPosts("fineline"), ap: await loadPosts("ap") };

/** An opener or a void block: `<!-- wp:ns/name` or `<!-- wp:name` (core). Closers start `<!-- /wp:`. */
const OPENER = /<!-- wp:(?:([a-z][a-z0-9_-]*)\/)?([a-z][a-z0-9_-]*)/g;

/** Independent per-name block counts, straight from the markup. */
function regexCounts(content: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of content.matchAll(OPENER)) {
    const name = `${m[1] ?? "core"}/${m[2]}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

const sum = (m: Map<string, number>, prefix = ""): number =>
  [...m].filter(([k]) => k.startsWith(prefix)).reduce((n, [, c]) => n + c, 0);

// ── parseBlocks ──────────────────────────────────────────────────────────────────────────────────

describe("parseBlocks", () => {
  test("an empty document has no blocks", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("  \n\n ")).toEqual([]);
  });

  test("a core block: namespace defaulted, attrs an object, markup kept", () => {
    const blocks = parseBlocks("<!-- wp:paragraph -->\n<p>Hi</p>\n<!-- /wp:paragraph -->");
    expect(blocks).toEqual([
      {
        name: "core/paragraph",
        attrs: {},
        innerBlocks: [],
        innerHTML: "\n<p>Hi</p>\n",
        innerContent: ["\n<p>Hi</p>\n"],
      },
    ]);
  });

  test("attributes are parsed from the comment's JSON", () => {
    const [block] = parseBlocks(
      '<!-- wp:cwicly/div {"uniqueID":"da0bc8a","isStyling":true,"marginTop":{"lg":"90px"}} -->\n<div></div>\n<!-- /wp:cwicly/div -->',
    );
    expect(block?.name).toBe("cwicly/div");
    expect(block?.attrs).toEqual({
      uniqueID: "da0bc8a",
      isStyling: true,
      marginTop: { lg: "90px" },
    });
  });

  test("a void block has no inner markup", () => {
    const [block] = parseBlocks('<!-- wp:cwicly/image {"imageID":5} /-->');
    expect(block).toEqual({
      name: "cwicly/image",
      attrs: { imageID: 5 },
      innerBlocks: [],
      innerHTML: "",
      innerContent: [],
    });
  });

  test("nested blocks: innerBlocks recurse and innerContent keeps a null where each one goes", () => {
    const content = [
      '<!-- wp:columns {"columns":2} -->',
      '<div class="wp-block-columns"><!-- wp:column -->',
      '<div class="wp-block-column"><!-- wp:paragraph --><p>Left</p><!-- /wp:paragraph --></div>',
      "<!-- /wp:column -->",
      "",
      "<!-- wp:column -->",
      '<div class="wp-block-column"></div>',
      "<!-- /wp:column --></div>",
      "<!-- /wp:columns -->",
    ].join("\n");
    const [columns] = parseBlocks(content);
    expect(columns?.name).toBe("core/columns");
    expect(columns?.attrs).toEqual({ columns: 2 });
    expect(columns?.innerBlocks.map((b) => b.name)).toEqual(["core/column", "core/column"]);
    expect(columns?.innerBlocks[0]?.innerBlocks.map((b) => b.name)).toEqual(["core/paragraph"]);
    expect(columns?.innerBlocks[0]?.innerBlocks[0]?.innerHTML).toBe("<p>Left</p>");
    expect(columns?.innerContent.filter((c) => c === null)).toHaveLength(2);
    expect(columns?.innerHTML).not.toContain("wp:column");
  });

  test("freeform HTML is a block with name null; whitespace between blocks is dropped", () => {
    expect(parseBlocks("\n\n<!-- wp:a /-->\n\n<!-- wp:b /-->\n").map((b) => b.name)).toEqual([
      "core/a",
      "core/b",
    ]);
    const blocks = parseBlocks("Hello <!-- wp:a /--> world");
    expect(blocks.map((b) => b.name)).toEqual([null, "core/a", null]);
    expect(blocks[0]).toEqual({
      name: null,
      attrs: {},
      innerBlocks: [],
      innerHTML: "Hello ",
      innerContent: ["Hello "],
    });
    expect(blocks[2]?.innerHTML).toBe(" world");
  });

  test("whitespace of any kind between blocks is not content, a no-break space and a BOM included", () => {
    // An editor leaves more than newlines between two block comments. Whitespace here is Unicode's,
    // wider than ASCII's, so these gaps are dropped too.
    const gaps = [" ", "\t", "\r\n", " ", "﻿", " ", " ", "　", "\n   \n"];
    for (const gap of gaps) {
      const blocks = parseBlocks(`${gap}<!-- wp:a /-->${gap}<!-- wp:b /-->${gap}`);
      expect(
        blocks.map((b) => b.name),
        JSON.stringify(gap),
      ).toEqual(["core/a", "core/b"]);
    }
    // Text that only looks empty is content: a reference to a no-break space is text, not whitespace.
    for (const text of ["&nbsp;", "x", "<br>", "<p></p>"]) {
      const blocks = parseBlocks(`<!-- wp:a /-->${text}<!-- wp:b /-->`);
      expect(
        blocks.map((b) => b.name),
        text,
      ).toEqual(["core/a", null, "core/b"]);
      expect(blocks[1]?.innerHTML).toBe(text);
    }
  });

  test("classic content with no block comments is one freeform block", () => {
    const html = "<p>One</p>\n<p>Two</p>";
    expect(parseBlocks(html)).toEqual([
      { name: null, attrs: {}, innerBlocks: [], innerHTML: html, innerContent: [html] },
    ]);
  });

  test("a comment whose JSON does not parse still yields its block, with no attributes", () => {
    const [block] = parseBlocks("<!-- wp:foo {not json} -->x<!-- /wp:foo -->");
    expect(block?.name).toBe("core/foo");
    expect(block?.attrs).toEqual({});
    expect(block?.innerHTML).toBe("x");
  });

  test("custom namespaces and hyphenated names", () => {
    const names = parseBlocks(
      "<!-- wp:my-plugin/big_thing-2 /--><!-- wp:query-pagination-numbers /-->",
    ).map((b) => b.name);
    expect(names).toEqual(["my-plugin/big_thing-2", "core/query-pagination-numbers"]);
  });

  test("stray closers are markup, not blocks", () => {
    const blocks = parseBlocks("<!-- /wp:paragraph -->text");
    expect(blocks.map((b) => b.name)).toEqual([null]);
  });

  test("an unclosed block takes the rest of the document", () => {
    const [block] = parseBlocks("<!-- wp:group --><p>never closed</p>");
    expect(block?.name).toBe("core/group");
    expect(block?.innerHTML).toBe("<p>never closed</p>");
  });

  test("the result does not alias the parser's state between calls", () => {
    const first = parseBlocks("<!-- wp:a /-->");
    parseBlocks("<!-- wp:b /--><!-- wp:c /-->");
    expect(first.map((b) => b.name)).toEqual(["core/a"]);
  });

  test("a document nested twenty thousand deep neither overflows the stack nor loses a level", () => {
    const depth = 20_000;
    const content = `${"<!-- wp:group -->".repeat(depth)}x${"<!-- /wp:group -->".repeat(depth)}`;
    const blocks = parseBlocks(content);
    expect(blocks).toHaveLength(1);
    let levels = 0;
    walkBlocks(blocks, () => {
      levels++;
    });
    expect(levels).toBe(depth);
    expect(countBlocks(blocks).get("core/group")).toBe(depth);
  });
});

// ── walkBlocks and countBlocks ───────────────────────────────────────────────────────────────────

describe("walkBlocks", () => {
  const tree = parseBlocks(
    [
      "<!-- wp:a -->",
      "<!-- wp:b --><!-- wp:c /--><!-- /wp:b -->",
      "<!-- wp:d /-->",
      "<!-- /wp:a -->",
      "<!-- wp:e /-->",
    ].join(""),
  );

  test("depth first, parents before children, siblings in order", () => {
    const seen: string[] = [];
    walkBlocks(tree, (block) => {
      seen.push(block.name ?? "freeform");
    });
    expect(seen).toEqual(["core/a", "core/b", "core/c", "core/d", "core/e"]);
  });

  test("passes the enclosing block, null at the top level", () => {
    const parents: [string, string | null][] = [];
    walkBlocks(tree, (block, parent) => {
      parents.push([block.name!, parent?.name ?? null]);
    });
    expect(parents).toEqual([
      ["core/a", null],
      ["core/b", "core/a"],
      ["core/c", "core/b"],
      ["core/d", "core/a"],
      ["core/e", null],
    ]);
  });

  test("visits freeform blocks too, and nothing for an empty list", () => {
    let n = 0;
    walkBlocks([], () => {
      n++;
    });
    expect(n).toBe(0);
    const names: (string | null)[] = [];
    walkBlocks(parseBlocks("a<!-- wp:x /-->b"), (block) => {
      names.push(block.name);
    });
    expect(names).toEqual([null, "core/x", null]);
  });

  test("the parent handed over is the very object that holds the child", () => {
    for (const post of sites.fineline.slice(0, 200)) {
      walkBlocks(parseBlocks(post.content), (block, parent) => {
        if (parent) expect(parent.innerBlocks).toContain(block);
      });
    }
  });
});

describe("countBlocks", () => {
  test("counts by name, nested blocks included, freeform excluded", () => {
    const counts = countBlocks(
      parseBlocks(
        "x<!-- wp:a --><!-- wp:b /--><!-- wp:b /--><!-- /wp:a --><!-- wp:b /--> y <!-- wp:ns/b /-->",
      ),
    );
    expect(Object.fromEntries(counts)).toEqual({ "core/a": 1, "core/b": 3, "ns/b": 1 });
  });

  test("an empty tree counts nothing", () => {
    expect(countBlocks([]).size).toBe(0);
  });
});

// ── Every post of both fixture sites ─────────────────────────────────────────────────────────────

describe.each(Object.entries(sites))("%s: every post", (_site, posts) => {
  const parsed = posts.map((post) => ({ post, tree: parseBlocks(post.content) }));

  test("parses without throwing", () => {
    expect(parsed).toHaveLength(posts.length);
    expect(posts.length).toBeGreaterThan(1000);
  });

  test("the cwicly/* blocks match an independent count of the '<!-- wp:cwicly/' openers, post by post", () => {
    const wrong: string[] = [];
    let total = 0;
    let opener = 0;
    for (const { post, tree } of parsed) {
      const fromTree = sum(countBlocks(tree), "cwicly/");
      const fromRegex = (post.content.match(/<!-- wp:cwicly\//g) ?? []).length;
      total += fromTree;
      opener += fromRegex;
      if (fromTree !== fromRegex)
        wrong.push(`post ${post.id} (${post.type}): tree ${fromTree}, regex ${fromRegex}`);
    }
    expect(wrong).toEqual([]);
    expect(total).toBe(opener);
    expect(total).toBeGreaterThan(500);
  });

  test("every block name and its count matches the markup, post by post", () => {
    const wrong: string[] = [];
    for (const { post, tree } of parsed) {
      const fromTree = countBlocks(tree);
      const fromRegex = regexCounts(post.content);
      if (JSON.stringify([...fromTree].sort()) !== JSON.stringify([...fromRegex].sort()))
        wrong.push(`post ${post.id}`);
    }
    expect(wrong).toEqual([]);
  });

  test("the tree is normalised to the WpBlock contract everywhere", () => {
    const problems: string[] = [];
    for (const { post, tree } of parsed) {
      walkBlocks(tree, (block: WpBlock) => {
        const where = `post ${post.id} ${block.name}`;
        if (block.attrs === null || typeof block.attrs !== "object" || Array.isArray(block.attrs))
          problems.push(`${where}: attrs`);
        if (!Array.isArray(block.innerBlocks)) problems.push(`${where}: innerBlocks`);
        if (typeof block.innerHTML !== "string") problems.push(`${where}: innerHTML`);
        if (block.innerContent.filter((c) => c === null).length !== block.innerBlocks.length)
          problems.push(`${where}: innerContent`);
        if (block.innerContent.filter((c): c is string => c !== null).join("") !== block.innerHTML)
          problems.push(`${where}: innerHTML != innerContent`);
        if (block.name === null) {
          if (/^\s*$/.test(block.innerHTML))
            problems.push(`${where}: whitespace-only freeform kept`);
          if (block.innerBlocks.length > 0) problems.push(`${where}: freeform with children`);
          if (JSON.stringify(block.attrs) !== "{}") problems.push(`${where}: freeform with attrs`);
        } else if (!/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(block.name)) {
          problems.push(`${where}: name`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  test("no comment's attributes were lost to a JSON error", () => {
    // A block whose comment carries `{...}` must have come back with attributes, unless the JSON
    // really is invalid; the fixtures contain no such comment.
    let withBraces = 0;
    let withAttrs = 0;
    for (const { post, tree } of parsed) {
      withBraces += (post.content.match(/<!-- wp:[a-z][a-z0-9_/-]* \{/g) ?? []).length;
      walkBlocks(tree, (block) => {
        if (Object.keys(block.attrs).length > 0) withAttrs++;
      });
    }
    expect(withAttrs).toBe(withBraces);
    expect(withBraces).toBeGreaterThan(100);
  });

  test("blocks in the whole site add up to the number of openers", () => {
    let blocks = 0;
    let openers = 0;
    for (const { post, tree } of parsed) {
      blocks += sum(countBlocks(tree));
      openers += (post.content.match(/<!-- wp:/g) ?? []).length;
    }
    expect(blocks).toBe(openers);
  });
});

describe("the two sites differ the way the design says they do", () => {
  const count = (posts: PostRow[]) => {
    const total = new Map<string, number>();
    for (const post of posts) {
      for (const [name, n] of countBlocks(parseBlocks(post.content)))
        total.set(name, (total.get(name) ?? 0) + n);
    }
    return total;
  };

  test("finelinepainting is Cwicly-heavy", () => {
    const total = count(sites.fineline);
    expect(sum(total, "cwicly/")).toBeGreaterThan(sum(total, "core/"));
    expect(total.get("cwicly/heading")).toBeGreaterThan(1000);
    expect(total.get("cwicly/component")).toBeGreaterThan(200);
  });

  test("anabaptistperspectives is core-heavy", () => {
    const total = count(sites.ap);
    expect(sum(total, "core/")).toBeGreaterThan(sum(total, "cwicly/") * 3);
    expect(total.get("core/paragraph")).toBeGreaterThan(2000);
  });

  test("classic posts (the podcast CPT) come back as freeform HTML", () => {
    const classic = sites.ap.filter(
      (p) => p.type === "captivate_podcast" && p.content.trim() !== "",
    );
    expect(classic.length).toBeGreaterThan(50);
    const withBlocks = classic.filter((p) => parseBlocks(p.content).some((b) => b.name !== null));
    expect(withBlocks).toEqual([]);
    for (const post of classic.slice(0, 20)) {
      const blocks = parseBlocks(post.content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.name).toBeNull();
      expect(blocks[0]?.innerHTML).toBe(post.content);
    }
  });
});
