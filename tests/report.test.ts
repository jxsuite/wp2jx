import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  createReport,
  renderReportJson,
  renderReportMarkdown,
  SEVERITIES,
  summarise,
} from "../src/report.ts";
import type { ReportEntry, Severity } from "../src/types.ts";
import { fixtureDb, readFixtureJson } from "./helpers/fixture-db.ts";

// ── Locations from the real finelinepainting rows ────────────────────────────────────────────────
// The entries are made up (the report says what the converter found, and the converter is not under
// test here), but where they say they were found is a real post with its real public URL.

const { path, prefix } = await fixtureDb("fineline");
const sqlite = new Database(path, { readonly: true });
const projects = sqlite
  .query(
    `select ID as id, post_name as slug, post_type as type from ${prefix}posts where post_type = 'project' and post_status = 'publish' order by ID`,
  )
  .all() as { id: number; slug: string; type: string }[];
const publicUrls = readFixtureJson<string[]>("fineline", "urls.json");
const urlOf = (slug: string): string | undefined =>
  publicUrls.find((u) => u.replace(/\/$/, "").endsWith(`/${slug}`));

const entry = (over: Partial<ReportEntry> = {}): ReportEntry => ({
  severity: "warn",
  code: "block.unsupported",
  message: "Block icb/image-compare has no Jx equivalent.",
  ...over,
});

function atProjects(count: number, base: Partial<ReportEntry> = {}): ReportEntry[] {
  return projects.slice(0, count).map((p) => {
    const url = urlOf(p.slug);
    return entry({ ...base, where: `post:${p.id}`, ...(url ? { url } : {}) });
  });
}

// ── createReport ─────────────────────────────────────────────────────────────────────────────────

describe("createReport", () => {
  test("starts empty", () => {
    expect(createReport().entries()).toEqual([]);
  });

  test("keeps entries in the order they were added, with every field", () => {
    const report = createReport();
    const a = entry({
      where: "post:5246",
      url: "https://finelinepainting.pro/home-2/",
      data: { block: "icb/image-compare", n: 3 },
    });
    const b = entry({ severity: "info", code: "option.ignored", message: "Not used." });
    report.add(a);
    report.add(b);
    expect(report.entries()).toEqual([a, b]);
    expect(report.entries()[0]?.data).toEqual({ block: "icb/image-compare", n: 3 });
  });

  test("entries() is a snapshot: later additions do not change one already taken", () => {
    const report = createReport();
    report.add(entry());
    const before = report.entries();
    report.add(entry({ code: "css.artifact" }));
    expect(before).toHaveLength(1);
    expect(report.entries()).toHaveLength(2);
  });

  test("an entry the caller keeps editing does not rewrite the report", () => {
    const report = createReport();
    const reused = entry({ where: "post:1" });
    report.add(reused);
    reused.where = "post:2";
    reused.message = "changed";
    expect(report.entries()[0]).toMatchObject({
      where: "post:1",
      message: "Block icb/image-compare has no Jx equivalent.",
    });
  });

  test("optional fields stay absent when they were not given", () => {
    const report = createReport();
    report.add(entry());
    expect(Object.keys(report.entries()[0]!).sort()).toEqual(["code", "message", "severity"]);
  });

  test("a severity the renderers cannot group by is refused where it is added", () => {
    const report = createReport();
    expect(() => report.add({ ...entry(), severity: "warning" as Severity })).toThrow(
      /severity "warning"/,
    );
    expect(() => report.add({ ...entry(), severity: undefined as unknown as Severity })).toThrow(
      TypeError,
    );
    expect(report.entries()).toEqual([]);
  });

  test("a missing code or message is refused too", () => {
    const report = createReport();
    expect(() => report.add({ ...entry(), code: "" })).toThrow(/code/);
    expect(() => report.add({ ...entry(), message: undefined as unknown as string })).toThrow(
      /message/,
    );
  });
});

// ── summarise ────────────────────────────────────────────────────────────────────────────────────

describe("summarise", () => {
  test("an empty report has all three severities at zero", () => {
    expect(summarise([])).toEqual({
      total: 0,
      bySeverity: { error: 0, warn: 0, info: 0 },
      byCode: {},
    });
  });

  test("counts by severity and by code", () => {
    const entries = [
      ...atProjects(5, { code: "block.unsupported" }),
      ...atProjects(3, { code: "token.unresolved", severity: "error" }),
      entry({ code: "css.artifact", severity: "info" }),
      entry({ code: "css.artifact", severity: "info" }),
    ];
    expect(summarise(entries)).toEqual({
      total: 10,
      bySeverity: { error: 3, warn: 5, info: 2 },
      byCode: { "block.unsupported": 5, "token.unresolved": 3, "css.artifact": 2 },
    });
  });

  test("byCode lists the most frequent first, ties by code", () => {
    const entries = [
      entry({ code: "b.x" }),
      entry({ code: "a.y" }),
      entry({ code: "c.z" }),
      entry({ code: "c.z" }),
      entry({ code: "b.x" }),
      entry({ code: "d.w" }),
    ];
    expect(Object.keys(summarise(entries).byCode)).toEqual(["b.x", "c.z", "a.y", "d.w"]);
  });

  test("a tie is broken by code even when the codes arrived in another order", () => {
    // The insertion order here is the reverse of the alphabet, so a sort that kept it would show.
    const entries = [
      entry({ code: "z.t" }),
      entry({ code: "m.t" }),
      entry({ code: "a.t" }),
      entry({ code: "q.hi" }),
      entry({ code: "q.hi" }),
    ];
    expect(Object.keys(summarise(entries).byCode)).toEqual(["q.hi", "a.t", "m.t", "z.t"]);
  });

  test("codes sort by character code, not by any locale, so the report is the same on every machine", () => {
    // `localeCompare` puts a before B and é before f; character order is the other way round.
    const entries = ["a.x", "B.x", "f.x", "é.x", "Z.x", "z.x"].map((code) => entry({ code }));
    expect(Object.keys(summarise(entries).byCode)).toEqual([
      "B.x",
      "Z.x",
      "a.x",
      "f.x",
      "z.x",
      "é.x",
    ]);
    const md = renderReportMarkdown(entries, { site: "s" });
    const order = ["B.x", "Z.x", "a.x", "f.x", "z.x", "é.x"].map((c) => md.indexOf(`### \`${c}\``));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("a code used at two severities is one code, counted across both", () => {
    const s = summarise([
      entry({ code: "css.artifact", severity: "info" }),
      entry({ code: "css.artifact", severity: "warn" }),
    ]);
    expect(s.byCode).toEqual({ "css.artifact": 2 });
    expect(s.bySeverity).toEqual({ error: 0, warn: 1, info: 1 });
  });

  test("works on what report.entries() returns", () => {
    const report = createReport();
    for (const e of atProjects(4)) report.add(e);
    expect(summarise(report.entries()).total).toBe(4);
  });
});

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────

describe("renderReportMarkdown", () => {
  const site = "https://finelinepainting.pro";

  test("the fixture has the 82 published projects the design describes", () => {
    expect(projects).toHaveLength(82);
    expect(projects.filter((p) => urlOf(p.slug))).not.toHaveLength(0);
  });

  test("an empty report says so rather than printing empty tables", () => {
    const md = renderReportMarkdown([], { site });
    expect(md).toContain("# Migration report: https://finelinepainting.pro");
    expect(md).toContain("No entries");
    expect(md).not.toContain("| Severity");
  });

  test("a summary table with a row per severity and a total", () => {
    const md = renderReportMarkdown(
      [
        ...atProjects(4, {
          severity: "error",
          code: "token.unresolved",
          message: "Token {foo} could not be resolved.",
        }),
        ...atProjects(7, { code: "block.unsupported" }),
        ...atProjects(2, {
          severity: "warn",
          code: "condition.dropped",
          message: "Hide condition dropped.",
        }),
        entry({ severity: "info", code: "css.artifact", message: "Artifact." }),
      ],
      { site },
    );
    expect(md).toContain("| Severity | Entries | Codes |");
    expect(md).toContain("| error | 4 | 1 |");
    expect(md).toContain("| warn | 9 | 2 |");
    expect(md).toContain("| info | 1 | 1 |");
    expect(md).toContain("| total | 14 | 4 |");
    expect(md).toContain("14 entries: 4 errors, 9 warnings, 1 info.");
  });

  test("a code used at two severities is two rows' worth of groups but one code in the total", () => {
    const md = renderReportMarkdown(
      [
        entry({ code: "css.artifact", severity: "warn" }),
        entry({ code: "css.artifact", severity: "info" }),
        entry({ code: "css.artifact", severity: "info" }),
      ],
      { site },
    );
    expect(md).toContain("| warn | 1 | 1 |");
    expect(md).toContain("| info | 2 | 1 |");
    expect(md).toContain("| total | 3 | 1 |");
    expect(md).toContain("### `css.artifact` (1)");
    expect(md).toContain("### `css.artifact` (2)");
  });

  test("groups run error, then warn, then info, and codes alphabetically within a severity", () => {
    const md = renderReportMarkdown(
      [
        entry({ severity: "info", code: "a.info" }),
        entry({ severity: "warn", code: "z.warn" }),
        entry({ severity: "warn", code: "b.warn" }),
        entry({ severity: "error", code: "m.error" }),
      ],
      { site },
    );
    const at = (needle: string) => md.indexOf(needle);
    expect(at("## error")).toBeGreaterThan(-1);
    expect(at("## error")).toBeLessThan(at("## warn"));
    expect(at("## warn")).toBeLessThan(at("## info"));
    expect(at("`m.error`")).toBeLessThan(at("`b.warn`"));
    expect(at("`b.warn`")).toBeLessThan(at("`z.warn`"));
    expect(at("`z.warn`")).toBeLessThan(at("`a.info`"));
    // A severity with no entries has no section.
    expect(renderReportMarkdown([entry({ severity: "info" })], { site })).not.toContain("## error");
  });

  test("each group shows its count and its message", () => {
    const md = renderReportMarkdown(
      atProjects(5, { message: "Block icb/image-compare has no Jx equivalent." }),
      { site },
    );
    expect(md).toContain("### `block.unsupported` (5)");
    expect(md).toContain("\nBlock icb/image-compare has no Jx equivalent.\n");
  });

  test("lists each example location with its public URL", () => {
    const entries = atProjects(3);
    const md = renderReportMarkdown(entries, { site });
    for (const e of entries) {
      expect(md).toContain(`\`${e.where}\``);
      if (e.url) expect(md).toContain(`<${e.url}>`);
    }
    expect(entries.some((e) => e.url)).toBe(true);
  });

  test("at most ten examples, then '+N more'", () => {
    const count = (md: string) =>
      md.split("\n").filter((l) => l.startsWith("- ") && !l.startsWith("- +")).length;
    const exactly10 = renderReportMarkdown(atProjects(10), { site });
    expect(count(exactly10)).toBe(10);
    expect(exactly10).not.toContain("more");

    const eleven = renderReportMarkdown(atProjects(11), { site });
    expect(count(eleven)).toBe(10);
    expect(eleven).toContain("- +1 more");

    const all = renderReportMarkdown(atProjects(82), { site });
    expect(count(all)).toBe(10);
    expect(all).toContain("- +72 more");
    expect(all).toContain("### `block.unsupported` (82)");
    // The first ten, in order; the eleventh is not named.
    for (const p of projects.slice(0, 10)) expect(all).toContain(`post:${p.id}\``);
    expect(all).not.toContain(`post:${projects[10]!.id}\``);
  });

  test("the cap applies per group", () => {
    const md = renderReportMarkdown(
      [...atProjects(12, { code: "a.one" }), ...atProjects(13, { code: "b.two" })],
      { site },
    );
    expect(md).toContain("- +2 more");
    expect(md).toContain("- +3 more");
  });

  test("an entry with no location is still listed", () => {
    const md = renderReportMarkdown([entry({ code: "option.malformed" })], { site });
    expect(md).toContain("- (no location)");
  });

  test("a location with only a URL, or only a place, is shown as given", () => {
    const md = renderReportMarkdown(
      [
        entry({ url: "https://finelinepainting.pro/blog/" }),
        entry({ where: "option:cwicly_global_classes" }),
      ],
      { site },
    );
    expect(md).toContain("- <https://finelinepainting.pro/blog/>");
    expect(md).toContain("- `option:cwicly_global_classes`");
  });

  test("an example whose message differs from the group's says what it is", () => {
    const md = renderReportMarkdown(
      [
        entry({ where: "post:1", message: "Block cwicly/slider has no Jx equivalent." }),
        entry({ where: "post:2", message: "Block cwicly/slider has no Jx equivalent." }),
        entry({ where: "post:3", message: "Block cwicly/tablist has no Jx equivalent." }),
      ],
      { site },
    );
    expect(md).toContain("\nBlock cwicly/slider has no Jx equivalent.\n");
    expect(md).toContain("- `post:3`: Block cwicly/tablist has no Jx equivalent.");
    expect(md).toContain("- `post:2`\n");
  });

  test("text that would start a markdown block, and backticks in locations, are neutralised", () => {
    const md = renderReportMarkdown(
      [
        entry({ message: "# not a heading", where: "template:cwicly//header" }),
        entry({ code: "x.y", message: "- not a list", where: "selector:a`b" }),
        entry({ code: "x.z", message: "line one\nline two", url: "https://example.com/a b" }),
      ],
      { site: "# site" },
    );
    expect(md).toContain("# Migration report: \\# site");
    expect(md).toContain("\n\\# not a heading\n");
    expect(md).toContain("\n\\- not a list\n");
    expect(md).toContain("\nline one line two\n");
    expect(md).toContain("`template:cwicly//header`");
    expect(md).toContain("``selector:a`b``");
    expect(md).toContain("`https://example.com/a b`"); // a URL with a space cannot be an autolink
  });

  test("a location is the place, one space, then the address", () => {
    const md = renderReportMarkdown(
      [entry({ where: "post:5246", url: "https://finelinepainting.pro/home-2/" })],
      { site },
    );
    expect(md).toContain("\n- `post:5246` <https://finelinepainting.pro/home-2/>\n");
    // What is not an absolute address without a space cannot be an autolink, and in angle brackets it
    // would be text or, for a bare word, raw HTML. It is shown as code instead.
    const odd = renderReportMarkdown(
      [
        "/home 2/",
        "/home/",
        "?p=1",
        "img",
        "mailto",
        "https://x.test/a b",
        "https://x.test/<b>",
      ].map((url, i) => entry({ where: `post:${i}`, url, code: `x.${i}` })),
      { site },
    );
    for (const [i, url] of [
      "/home 2/",
      "/home/",
      "?p=1",
      "img",
      "mailto",
      "https://x.test/a b",
      "https://x.test/<b>",
    ].entries()) {
      expect(odd).toContain(`\n- \`post:${i}\` \`${url}\`\n`);
    }
    expect(hasHtml(parseMarkdown(odd))).toBe(false);
    // An address with a scheme and no space is a link, however odd its path.
    const links = renderReportMarkdown(
      [entry({ where: "post:1", url: "https://x.test/a_b*c?d=1&e=2#f" })],
      { site },
    );
    expect(links).toContain("\n- `post:1` <https://x.test/a_b*c?d=1&e=2#f>\n");
  });

  test("a place that starts or ends with a backtick is padded, so it is still one code span", () => {
    const places = ["`tick", "tock`", "``both``", "a`b"];
    const md = renderReportMarkdown(
      places.map((where, i) => entry({ where, code: `x.${i}` })),
      { site },
    );
    expect(md).toContain("\n- `` `tick ``\n");
    expect(md).toContain("\n- `` tock` ``\n");
    expect(md).toContain("\n- ``` ``both`` ```\n");
    expect(md).toContain("\n- ``a`b``\n");
    // And a parser reads each one back as exactly the place that was given.
    const codes: string[] = [];
    const walk = (node: Nodes): void => {
      if (node.type === "listItem") codes.push(seen(node));
      if ("children" in node) node.children.forEach(walk);
    };
    walk(parseMarkdown(md));
    expect(codes).toEqual(places);
  });

  test("a message that would open a quote, a list or an ordered list is shown as text", () => {
    const messages = [
      "> quoted",
      "+ plus",
      "* star",
      "- minus",
      "1. one",
      "2) two",
      "1986. A year first",
      "= equals",
    ];
    const md = renderReportMarkdown(
      messages.map((message, i) => entry({ message, code: `a.${i}` })),
      { site },
    );
    for (const expected of [
      "\n\\> quoted\n",
      "\n\\+ plus\n",
      "\n\\* star\n",
      "\n\\- minus\n",
      "\n1\\. one\n",
      "\n2\\) two\n",
      "\n1986\\. A year first\n",
      "\n\\= equals\n",
    ]) {
      expect(md).toContain(expected);
    }
    expect(batchProblems(messages)).toEqual([]);
  });

  test("a number that is not a list marker, and punctuation that is not markup, are left as written", () => {
    const md = renderReportMarkdown(
      [
        "1.5 seconds",
        "2024-05-01 was the day",
        "version 1.2.3",
        "50% of 3 (about)",
        "a - b",
        "x = y",
      ].map((message, i) => entry({ message, code: `a.${i}` })),
      { site },
    );
    for (const line of [
      "1.5 seconds",
      "2024-05-01 was the day",
      "version 1.2.3",
      "50% of 3 (about)",
      "a - b",
      "x = y",
    ])
      expect(md).toContain(`\n${line}\n`);
  });

  test("is deterministic and leaves its input alone", () => {
    const entries = [...atProjects(15), entry({ severity: "error", code: "a.b" })];
    const snapshot = JSON.stringify(entries);
    const first = renderReportMarkdown(entries, { site });
    expect(renderReportMarkdown(entries, { site })).toBe(first);
    expect(JSON.stringify(entries)).toBe(snapshot);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.endsWith("\n\n")).toBe(false);
  });

  test("severity labels are the ones the entries use", () => {
    expect(SEVERITIES).toEqual(["error", "warn", "info"]);
  });
});

// ── The markdown, read back by a CommonMark parser ───────────────────────────────────────────────
// What matters about the report is what a reader sees, and a message is free text. A line that starts
// `<script>` opens an HTML block with no end, so every group after it vanishes into one raw node;
// `---` is a rule, `[x]: y` a link definition, a fence is a code block. So these tests do not look for
// substrings: they parse the output (CommonMark with GFM, the dialect GitHub and every editor
// renders) and check the structure that came out and the text a reader gets.

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const parseMarkdown = (markdown: string): Root => markdownParser.parse(markdown);

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** What a reader sees of a node. Raw HTML is not text, it is a defect, so it is marked to fail equality. */
function seen(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "html":
      return `⟦html ${node.value}⟧`;
    case "break":
      return "\n";
    case "image":
      return node.alt ?? "";
    default:
      return "children" in node ? node.children.map(seen).join("") : "";
  }
}

const hasHtml = (node: Nodes): boolean =>
  node.type === "html" || ("children" in node && node.children.some(hasHtml));

const outline = (tree: Root): string[] =>
  tree.children.map((n) => (n.type === "heading" ? `h${n.depth} ${seen(n)}` : n.type));

/** The top-level shape of a report whose first group holds `inFirst` entries and has two groups after it. */
const expectedOutline = (title: string, inFirst: number): string[] => [
  `h1 Migration report: ${title}`,
  "paragraph",
  "h2 Summary",
  "table",
  `h2 error (${inFirst})`,
  `h3 a.target (${inFirst})`,
  "paragraph",
  "list",
  "h2 warn (1)",
  "h3 b.later (1)",
  "paragraph",
  "list",
  "h2 info (1)",
  "h3 c.last (1)",
  "paragraph",
  "list",
];

const SITE = "https://finelinepainting.pro";

function around(message: string, over: { site?: string; second?: string } = {}): string {
  return renderReportMarkdown(
    [
      { severity: "error", code: "a.target", message, where: "post:1" },
      ...(over.second === undefined
        ? []
        : [
            { severity: "error", code: "a.target", message: over.second, where: "post:2" } as const,
          ]),
      { severity: "warn", code: "b.later", message: "Later group.", where: "post:3" },
      { severity: "info", code: "c.last", message: "Last group.", where: "post:4" },
    ],
    { site: over.site ?? SITE },
  );
}

/**
 * Everything wrong with how `message` renders as the group's message, as an example that differs from
 * it, and as the site title: the groups after it must all still be there, nothing may turn into raw
 * HTML, and the reader must get the message back as written.
 */
function problems(message: string): string[] {
  const out: string[] = [];
  const text = collapse(message);
  const label = JSON.stringify(message);

  // As the message of its group.
  const first = parseMarkdown(around(message));
  if (JSON.stringify(outline(first)) !== JSON.stringify(expectedOutline(SITE, 1)))
    out.push(`${label} as a group message: structure ${JSON.stringify(outline(first))}`);
  else if (hasHtml(first)) out.push(`${label} as a group message: raw HTML`);
  else {
    const at = first.children.findIndex((n) => n.type === "heading" && n.depth === 3);
    const shown = seen(first.children[at + 1]!);
    if (shown !== text) out.push(`${label} as a group message: shown as ${JSON.stringify(shown)}`);
  }

  // As an example whose message differs from the group's.
  const second = parseMarkdown(around("The group's message.", { second: message }));
  if (JSON.stringify(outline(second)) !== JSON.stringify(expectedOutline(SITE, 2)))
    out.push(`${label} as an example: structure ${JSON.stringify(outline(second))}`);
  else if (hasHtml(second)) out.push(`${label} as an example: raw HTML`);
  else {
    const list = second.children.find((n) => n.type === "list");
    const items = list?.type === "list" ? list.children.map(seen) : [];
    if (items.length !== 2 || items[1] !== `post:2: ${text}`)
      out.push(`${label} as an example: items ${JSON.stringify(items)}`);
  }

  // As the site named in the title.
  const titled = parseMarkdown(around("Same.", { site: message }));
  if (JSON.stringify(outline(titled)) !== JSON.stringify(expectedOutline(text, 1)))
    out.push(`${label} as the site: structure ${JSON.stringify(outline(titled))}`);
  else if (hasHtml(titled)) out.push(`${label} as the site: raw HTML`);
  return out;
}

/**
 * `problems` for many messages at once: a hundred groups to a document, each holding its message as the
 * group's own and, in a second group, as an example that differs. One parse covers a hundred messages;
 * a document that is not exactly right is taken apart message by message to name the culprits.
 */
function batchProblems(messages: readonly string[]): string[] {
  const out: string[] = [];
  const usable = messages.filter((m) => collapse(m) !== "");
  for (let i = 0; i < usable.length; i += 100) {
    const chunk = usable.slice(i, i + 100);
    const entries: ReportEntry[] = chunk.flatMap((message, n) => {
      const id = String(n).padStart(3, "0");
      return [
        { severity: "warn", code: `m.${id}`, message, where: `post:${n}` },
        { severity: "info", code: `x.${id}`, message: "The group's message.", where: "post:0" },
        { severity: "info", code: `x.${id}`, message, where: `post:${n}` },
      ] satisfies ReportEntry[];
    });
    const tree = parseMarkdown(renderReportMarkdown(entries, { site: SITE }));
    const ids = chunk.map((_, n) => String(n).padStart(3, "0"));
    const expected = [
      `h1 Migration report: ${SITE}`,
      "paragraph",
      "h2 Summary",
      "table",
      `h2 warn (${chunk.length})`,
      ...ids.flatMap((id) => [`h3 m.${id} (1)`, "paragraph", "list"]),
      `h2 info (${chunk.length * 2})`,
      ...ids.flatMap((id) => [`h3 x.${id} (2)`, "paragraph", "list"]),
    ];
    let ok = JSON.stringify(outline(tree)) === JSON.stringify(expected) && !hasHtml(tree);
    if (ok) {
      const shown = tree.children
        .filter((n) => n.type === "paragraph" || n.type === "list")
        .slice(1) // the summary line
        .map(seen);
      // Per group: [message paragraph, location], then, in the info section, [paragraph, two examples].
      const wanted: string[] = [
        ...chunk.flatMap((message, n) => [collapse(message), `post:${n}`]),
        ...chunk.flatMap((message, n) => [
          "The group's message.",
          `post:0post:${n}: ${collapse(message)}`,
        ]),
      ];
      ok = JSON.stringify(shown) === JSON.stringify(wanted);
    }
    if (!ok) out.push(...chunk.flatMap(problems));
  }
  return out;
}

describe("renderReportMarkdown, read back by a CommonMark parser", () => {
  test("the parser sees what the report promises, for an ordinary message", () => {
    // The oracle works before it is asked anything hard.
    expect(problems("Block icb/image-compare has no Jx equivalent.")).toEqual([]);
    const tree = parseMarkdown(around("Block icb/image-compare has no Jx equivalent."));
    expect(outline(tree)).toEqual(expectedOutline(SITE, 1));
  });

  test("the converter's own message templates, with the tags they name, render as written", () => {
    // The three templates of src/html.ts that put an HTML tag name first or in the middle.
    const real = [
      ...["div", "font", "o:p", "span"].map(
        (tag) => `Skipped 2 unreadable inline style declaration(s) on <${tag}>.`,
      ),
      ...["font", "o:p", "center", "marquee"].map(
        (tag) =>
          `<${tag}> is not a valid Jx tag name; its children were kept and the element dropped.`,
      ),
      ...["script", "style", "iframe", "xmp", "textarea", "title", "noscript"].map(
        (tag) =>
          `<${tag}> contains a literal \${ that cannot be escaped there; the build may evaluate it.`,
      ),
    ];
    const bad = real.flatMap(problems);
    expect(bad).toEqual([]);
  });

  test("a message that opens a raw HTML block does not swallow the groups after it", () => {
    // `<script>`, `<style>`, `<pre>` and `<!--` start an HTML block that only its closing tag ends.
    for (const message of [
      "<script> contains a literal ${ that cannot be escaped there; the build may evaluate it.",
      "<style> block was dropped.",
      "<pre> text",
      "<!-- an unclosed comment",
      "<![CDATA[ x",
      "<?php echo 1; ?>",
    ]) {
      const tree = parseMarkdown(around(message));
      expect(outline(tree), message).toEqual(expectedOutline(SITE, 1));
      expect(hasHtml(tree), message).toBe(false);
    }
  });

  test("a message that is a block-level construct on its own line is still text", () => {
    const messages = [
      "```",
      "~~~",
      "``` js",
      "~~~ js",
      "---",
      "***",
      "___",
      "- - -",
      "* * *",
      "===",
      "# heading",
      "###### six",
      "#hashtag",
      "#",
      "ends with a hash #",
      "ends with hashes ##",
      "# starts and ends #",
      "not a closing sequence#",
      "an escaped one \\#",
      "> quote",
      ">quote",
      "+ plus",
      "- minus",
      "-minus",
      "* star",
      "1. first",
      "1986. A year first",
      "1) Option one",
      "1.",
      "-",
      "[ref]: http://example.com",
      "[^1]: a footnote",
      "[x] done",
      "- [ ] task",
      "| a | b |",
      "|---|---|",
      ":::note",
      "::leaf{a=b}",
      "<div> leading tag",
      "<ccd>name=args</ccd> is a Cwicly token",
      "Unresolved token <ccd>name=args</ccd> on this page.",
    ];
    expect(messages.flatMap(problems)).toEqual([]);
  });

  test("markup inside a message is shown, not applied", () => {
    const messages = [
      "Selector [class*=cc-] and [id*=x] was dropped.",
      "Value width:[object Object]px is not a length.",
      "Palette colour !var=abc! no longer exists.",
      "A_b_c and __proto__ and *emphasis* and _x_ and **strong**",
      "a `code` b and ``double`` and `",
      "~~strike~~ and ~single~",
      "![image](x.png) and [link](http://example.com) and [link][ref]",
      "<https://example.com> and <mailto:a@b.test> and <br> and <br/>",
      '<img src=x onerror=alert(1)> and <a href="x">y</a>',
      "back\\slash \\ and \\* and trailing\\",
      "Path C:\\dir\\file and \\n",
      "$1.00 and ${x} and {y} and %s",
      "Smith &amp; Sons &lt;b&gt; &#039; &#x27; &copy; &nbsp; AT&T &foo; &",
      "Tabs\tand\nnewlines\r\nand  spaces",
      "  leading and trailing  ",
      "Emoji 🎨 and café and ← arrows",
    ];
    expect(messages.flatMap(problems)).toEqual([]);
  });

  test("a URL or an address written in a message is the same text to the reader", () => {
    // GFM turns these into links. Backslash escapes are not read inside a bare link, so escaping the
    // characters of a URL would show the backslashes.
    const messages = [
      "Fetch https://example.com/a_b_c?x=1&y=2 failed.",
      "Fetch http://example.com/a*b*c/~user failed.",
      "See www.example.com/a_b and www.example.com.",
      "Mail a_b@example.com or c*d@example.com.",
      "https://example.com/path_(with)_parens",
      "(https://example.com/a_b)",
      "<https://example.com/a_b>",
    ];
    expect(messages.flatMap(problems)).toEqual([]);
  });

  test("every string of up to two characters from the ones that mean something to markdown", () => {
    const alphabet = [..."\\`*_[]()<>!#+-=~|&;:.$@/?\"' {}^%1aZ\t"];
    const all = alphabet.flatMap((a) => [a, ...alphabet.map((b) => a + b)]);
    expect(batchProblems(all).slice(0, 8)).toEqual([]);
  });

  test("every string of three characters from the ones that start a block", () => {
    const alphabet = [..."\\`*_[<>#+-=~.1 a"];
    const all = alphabet.flatMap((a) => alphabet.flatMap((b) => alphabet.map((c) => a + b + c)));
    expect(batchProblems(all).slice(0, 8)).toEqual([]);
  });

  test("fifteen hundred random strings, with the same seed every run", () => {
    // A small linear congruential generator, so a failure names a message anyone can rebuild.
    let seed = 20_251_001;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed % n;
    };
    const parts = [
      ..."\\`*_[]()<>!#+-=~|&;:.$@/?\"' {}^%09aZ",
      "http://",
      "https://",
      "www.",
      "&amp;",
      "&#35;",
      "<b>",
      "</b>",
      "<!--",
      "-->",
      "```",
      "~~~",
      "[x]: ",
      "1. ",
      "- ",
      "> ",
      "# ",
      "post:1",
      "a_b",
      "x@y.z",
      "\n",
      "\t",
    ];
    const messages: string[] = [];
    for (let i = 0; i < 1500; i++) {
      let message = "";
      for (let n = 1 + next(10); n > 0; n--) message += parts[next(parts.length)];
      messages.push(message);
    }
    expect(batchProblems(messages).slice(0, 8)).toEqual([]);
  });

  test("the escapes are for the parser, not the person: a plain message is not touched", () => {
    const plain = [
      "Block cwicly/slider has no Jx equivalent.",
      "Unresolved token {image=12} on this page.",
      "Term 7 is used by two taxonomies (category, post_tag); only the first is kept.",
      "Hide condition dropped: device = mobile, 3 pages.",
    ];
    for (const message of plain) {
      // No backslash is added to text with nothing in it for markdown to misread (`_` is the exception
      // below: it is escaped everywhere, since whether it opens emphasis depends on its neighbours).
      if (!message.includes("_")) expect(around(message)).toContain(`\n${message}\n`);
    }
  });
});

// ── JSON ─────────────────────────────────────────────────────────────────────────────────────────

describe("renderReportJson", () => {
  test("keeps every entry, in order, with every field", () => {
    const entries = [
      ...atProjects(82, { data: { block: "icb/image-compare" } }),
      entry({
        severity: "error",
        code: "token.unresolved",
        message: "x",
        data: { token: "{foo}", nested: { list: [1, 2, { a: null }] } },
      }),
    ];
    const parsed = JSON.parse(renderReportJson(entries)) as {
      summary: unknown;
      entries: unknown[];
    };
    expect(parsed.entries).toHaveLength(83);
    expect(parsed.entries).toEqual(JSON.parse(JSON.stringify(entries)));
    expect(parsed.summary).toEqual(summarise(entries));
  });

  test("an empty report is an empty list with a zero summary", () => {
    expect(JSON.parse(renderReportJson([]))).toEqual({
      summary: { total: 0, bySeverity: { error: 0, warn: 0, info: 0 }, byCode: {} },
      entries: [],
    });
  });

  test("is indented, ends with a newline, and puts the summary first", () => {
    const json = renderReportJson(atProjects(2));
    expect(json.startsWith('{\n  "summary": {')).toBe(true);
    expect(json.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(json))).toEqual(["summary", "entries"]);
  });

  test("data that JSON.stringify would refuse does not take the report down", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const shared = { n: 1 };
    const entries = [
      entry({
        data: {
          big: 12345678901234567890n,
          map: new Map<unknown, unknown>([
            ["a", 1],
            [2, [3]],
          ]),
          set: new Set([1, 2]),
          error: new RangeError("out of range"),
          date: new Date("2023-05-20T07:20:31.000Z"),
          cyclic,
          twice: [shared, shared],
          fn: () => 1,
          undef: undefined,
        },
      }),
    ];
    const data = (
      JSON.parse(renderReportJson(entries)) as { entries: { data: Record<string, unknown> }[] }
    ).entries[0]!.data;
    expect(data.big).toBe("12345678901234567890");
    expect(data.map).toEqual({ a: 1, "2": [3] });
    expect(data.set).toEqual([1, 2]);
    expect(data.error).toEqual({ name: "RangeError", message: "out of range" });
    expect(data.date).toBe("2023-05-20T07:20:31.000Z");
    expect(data.cyclic).toEqual({ name: "loop", self: "[Circular]" });
    expect(data.twice).toEqual([{ n: 1 }, { n: 1 }]); // shared, not circular: printed in full both times
    expect("fn" in data).toBe(false);
    expect("undef" in data).toBe(false);
  });

  test("an invalid severity is refused rather than rendered", () => {
    expect(() => renderReportJson([{ ...entry(), severity: "fatal" as Severity }])).toThrow(
      TypeError,
    );
    expect(() =>
      renderReportMarkdown([{ ...entry(), severity: "fatal" as Severity }], { site: "x" }),
    ).toThrow(TypeError);
  });
});
