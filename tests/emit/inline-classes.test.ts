import { describe, expect, test } from "bun:test";
import { inlineClasses, type ProjectRule } from "../../src/emit/inline-classes.ts";

const MEDIA = { "--md": "(max-width: 992px)", "--sm": "(max-width: 576px)" };

let rank = 0;
const rule = (
  selector: string | null,
  declarations: Record<string, string>,
  context: string[] = [],
): ProjectRule => ({ selector, context, declarations: Object.entries(declarations), rank: ++rank });

const run = (
  rules: ProjectRule[],
  doc: any,
  extra: { markdown?: string[]; scripts?: string[]; protect?: string[] } = {},
) => {
  const documents = [{ path: "pages/index.json", doc }];
  const result = inlineClasses({
    rules,
    documents,
    markdown: extra.markdown ?? [],
    scripts: extra.scripts ?? [],
    protect: extra.protect ?? [],
    media: MEDIA,
  });
  return { ...result, doc: doc as any };
};

describe("inlineClasses", () => {
  test("a class's rules move into the element, its own style wins a tie, and the class goes", () => {
    const doc = {
      tagName: "div",
      children: [
        {
          tagName: "a",
          className: "button-c1 button-default",
          style: { color: "white", "@--sm": { color: "black" } },
        },
      ],
    };
    const {
      rules,
      doc: out,
      stats,
    } = run(
      [
        rule(".button-default", { color: "red", padding: "1rem" }),
        rule(".button-default:hover", { color: "blue" }),
        rule("a.button-default svg", { fill: "currentColor" }),
        rule(".button-default", { margin: "0" }, ["@--md"]),
        rule("p", { margin: "0" }),
      ],
      doc,
    );
    expect(out.children[0]).toEqual({
      tagName: "a",
      style: {
        padding: "1rem",
        color: "white",
        "&:hover": { color: "blue" },
        "&:is(a) svg": { fill: "currentColor" },
        "@--md": { margin: "0" },
        "@--sm": { color: "black" },
      },
    });
    expect(rules.map((r) => r.selector)).toEqual(["p"]);
    expect(stats.classesRemoved).toBe(2);
  });

  test("a class another selector needs stays on the element, and the rule that needs it is written against &", () => {
    const doc = {
      tagName: "section",
      className: "dark",
      children: [{ tagName: "h2", className: "title" }],
    };
    const { rules, doc: out } = run(
      [rule(".title", { margin: "0" }), rule(".dark .title", { color: "white" })],
      doc,
    );
    expect(out).toEqual({
      tagName: "section",
      className: "dark",
      children: [{ tagName: "h2", style: { margin: "0", "&:is(.dark *)": { color: "white" } } }],
    });
    expect(rules).toEqual([]);
  });

  test("what text can see keeps its class and its rule: Markdown, HTML in a string, scripts, protected names", () => {
    const doc = {
      tagName: "div",
      children: [
        { tagName: "p", className: "md-too" },
        { tagName: "p", className: "html-too" },
        { tagName: "p", className: "scripted" },
        { tagName: "div", className: "cf-turnstile" },
        { tagName: "div", innerHTML: '<span class="html-too">x</span>' },
      ],
    };
    const { rules, doc: out } = run(
      [
        rule(".md-too", { color: "red" }),
        rule(".html-too", { color: "green" }),
        rule(".scripted", { color: "blue" }),
      ],
      doc,
      {
        markdown: [':::p{className="md-too"}\nx\n:::'],
        scripts: ["el.classList.add('scripted')"],
        protect: ["cf-turnstile"],
      },
    );
    expect(rules.map((r) => r.selector)).toEqual([".md-too", ".html-too", ".scripted"]);
    // The elements carry the rules themselves; only what a script looks for keeps its class.
    expect(out.children.slice(0, 4).map((c: any) => [c.className, c.style])).toEqual([
      [undefined, { color: "red" }],
      [undefined, { color: "green" }],
      [expect.stringMatching(/^jx-w[0-9a-f]{8} scripted$/), { color: "blue" }],
      ["cf-turnstile", undefined],
    ]);
  });

  test("an element with an id, a custom element and a bound className are not rewritten", () => {
    const doc = {
      tagName: "div",
      children: [
        { tagName: "p", id: "intro", className: "lead" },
        { tagName: "fp-card", className: "lead" },
        { tagName: "p", className: "${state.cls}" },
        { tagName: "p", className: "lead" },
      ],
    };
    const { rules, doc: out } = run([rule(".lead", { fontSize: "2rem" })], doc);
    expect(rules.map((r) => r.selector)).toEqual([".lead"]);
    expect(out.children[0]).toEqual({ tagName: "p", id: "intro", className: "lead" });
    expect(out.children[1]).toEqual({ tagName: "fp-card", className: "lead" });
    expect(out.children[3]).toEqual({ tagName: "p", style: { fontSize: "2rem" } });
  });

  test("a rule for a class nothing carries is dropped; a two-class rule reaches only elements with both", () => {
    const doc = {
      tagName: "div",
      children: [
        { tagName: "p", className: "a b" },
        { tagName: "p", className: "a" },
      ],
    };
    const {
      rules,
      doc: out,
      stats,
    } = run(
      [
        rule(".ghost", { color: "red" }),
        rule(".a.b", { color: "blue" }),
        rule(".a", { margin: "0" }),
      ],
      doc,
    );
    expect(rules).toEqual([]);
    expect(stats.rulesDead).toBe(1);
    const [both] = out.children as any[];
    expect(both.className).toMatch(/^jx-w[0-9a-f]{8} b$/);
    expect(both.style).toEqual({ "&.b": { color: "blue" }, margin: "0" });
    expect(out.children[1]).toEqual({ tagName: "p", style: { margin: "0" } });
  });

  test("a styled element that keeps a shared class first gets a class of its own, so its style does not leak", () => {
    const doc = {
      tagName: "div",
      children: [
        {
          tagName: "p",
          className: "own shared",
          style: { color: "red" },
          children: [{ tagName: "span", className: "y" }],
        },
      ],
    };
    const { doc: out } = run(
      [rule(".own", { margin: "0" }), rule(".shared .y", { color: "blue" })],
      doc,
    );
    const className = out.children[0].className as string;
    expect(className).toMatch(/^jx-w[0-9a-f]{8} shared$/);
  });

  test("a shorthand the element partly overrides is split, so its own value needs no alias", () => {
    const doc = {
      tagName: "div",
      children: [{ tagName: "section", className: "s", style: { paddingTop: "60px" } }],
    };
    const { doc: out, stats } = run([rule(".s", { padding: "3rem 1rem" }, ["@--sm"])], doc);
    expect(out.children[0].style).toEqual({
      paddingTop: "60px",
      "@--sm": { paddingRight: "1rem", paddingBottom: "3rem", paddingLeft: "1rem" },
    });
    expect(stats.aliased).toBe(0);
  });

  test("an element's style, which Jx writes for its first class, still reaches the other elements of the page that carry it", () => {
    const doc = {
      tagName: "div",
      children: [
        { tagName: "div", className: "promo", style: { color: "red", padding: "1rem" } },
        { tagName: "div", className: "promo2 promo", style: { padding: "2rem" } },
      ],
    };
    const { doc: out } = run([], doc);
    expect(out.children[0]).toEqual({ tagName: "div", style: { color: "red", padding: "1rem" } });
    // The second comes later in the tree, so its own padding wins, as it did.
    expect(out.children[1]).toEqual({ tagName: "div", style: { color: "red", padding: "2rem" } });
  });

  test("an element whose first class an entry also carries is left as it is, its class styling the entry", () => {
    const doc = {
      tagName: "div",
      children: [{ tagName: "div", className: "promo extra", style: { color: "red" } }],
    };
    const { doc: out, rules } = run([rule(".extra", { margin: "0" })], doc, {
      markdown: [':::div{className="promo"}\nx\n:::'],
    });
    expect(out.children[0]).toEqual({
      tagName: "div",
      className: "promo extra",
      style: { color: "red" },
    });
    expect(rules.map((r) => r.selector)).toEqual([".extra"]);
  });
});
