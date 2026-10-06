import { describe, expect, test } from "bun:test";
import { walkBlocks } from "../../src/wp/blocks.ts";
import {
  allSubjects,
  componentsOf,
  cssNamesFor,
  loadSite,
  makeCtx,
  subjectBlocks,
  subjectPost,
} from "./ctx.ts";

describe("ctx helper, fineline", () => {
  test("a page subject gets its own stylesheet, its parts' and its components'", async () => {
    const site = await loadSite("fineline");
    const names = cssNamesFor(site, { kind: "post", id: 1078 });
    expect(names).toContain("cc-global-classes.css");
    expect(names).toContain("cc-post-1078.css");
    // the component files are exactly the refs the post's own blocks name
    const refs = new Set<string>();
    walkBlocks(subjectBlocks(site, { kind: "post", id: 1078 }), (block) => {
      if (block.name === "cwicly/component" && typeof block.attrs.ref === "string")
        refs.add(block.attrs.ref);
    });
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) expect(names).toContain(`cc-cm-${ref}.css`);
    expect(names.filter((n) => n.startsWith("cc-cm-"))).toHaveLength(refs.size);
  });

  test("a template subject pulls in the parts it embeds", async () => {
    const site = await loadSite("fineline");
    const names = cssNamesFor(site, { kind: "template", slug: "single-project" });
    expect(names).toContain("cc-tp-cwicly_single-project.css");
    expect(names).toContain("cc-tp-cwicly_header.css");
    expect(names).toContain("cc-tp-cwicly_footer.css");
  });

  test("makeCtx builds a CSS index that knows the page's own block classes", async () => {
    const site = await loadSite("fineline");
    const ctx = await makeCtx("fineline", { kind: "post", id: 5246 });
    expect(ctx.subject).toMatchObject({ kind: "post", id: "5246" });
    expect(ctx.subject.post?.slug).toBe("home-2");
    const blocks = subjectBlocks(site, { kind: "post", id: 5246 });
    let styled = 0;
    let resolved = 0;
    walkBlocks(blocks, (block) => {
      const classID = block.attrs.classID;
      if (
        block.name?.startsWith("cwicly/") &&
        block.attrs.isStyling === true &&
        typeof classID === "string"
      ) {
        styled++;
        if (ctx.css.classes.has(classID)) resolved++;
      }
    });
    expect(styled).toBeGreaterThan(20);
    // Cwicly writes no rule for a block with no declarations, so not every styled block resolves.
    expect(resolved / styled).toBeGreaterThan(0.6);
  });

  test("components are keyed by their reference meta and carry their props and variants", async () => {
    const site = await loadSite("fineline");
    const components = componentsOf(site.model, "fp");
    expect([...components.keys()].sort()).toEqual(["0a275b695a", "244868a12d"]);
    const card = components.get("0a275b695a")!;
    expect(card.tagName).toBe("fp-icon-card");
    expect(card.props.length).toBe(5);
    expect(new Set(card.props.map((p) => p.key)).size).toBe(card.props.length);
    expect(card.variants.map((v) => v.id)).toEqual(["bmuh8n", "kxrx4"]);
  });

  test("the component subject resolves to the cc_block post", async () => {
    const site = await loadSite("fineline");
    expect(subjectPost(site, { kind: "component", ref: "0a275b695a" })?.slug).toBe("icon-card");
  });

  test("convert is the real driver, and an override replaces it", async () => {
    const ctx = await makeCtx("fineline", { kind: "part", slug: "header" });
    expect(ctx.convert([])).toEqual([]);
    const custom = await makeCtx(
      "fineline",
      { kind: "part", slug: "header" },
      { convert: () => ["x"] },
    );
    expect(custom.convert([])).toEqual(["x"]);
  });

  test("allSubjects lists content, templates, parts and components but not bookkeeping posts", async () => {
    const site = await loadSite("fineline");
    const subjects = allSubjects(site);
    const kinds = new Set(subjects.map((s) => s.kind));
    expect(kinds).toEqual(new Set(["post", "template", "part", "component", "reusable"]));
    expect(subjects.filter((s) => s.kind === "component")).toHaveLength(2);
  });
});

describe("ctx helper, ap", () => {
  test("loads the second site with its own theme and breakpoints", async () => {
    const site = await loadSite("ap");
    expect(site.model.site.url).toBe("https://anabaptistperspectives.org");
    const ctx = await makeCtx("ap", { kind: "part", slug: "header" });
    expect(ctx.cwicly.breakpoints.map((b) => b.key)).toEqual(["lg", "md", "sm"]);
    expect(ctx.css.classes.size).toBeGreaterThan(50);
  });
});
