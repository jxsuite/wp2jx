/**
 * What the pages, layouts and components say about a class (src/emit/class-styles.ts): read from the
 * Jx files the converters write for the real fineline site, and, for the edge cases a real file does
 * not hold, from small hand-written documents.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { collectClassStyles, sortedJson, type ClassStyles } from "../../src/emit/class-styles.ts";
import { buildTemplates } from "../../src/emit/templates.ts";
import { loadSite } from "../helpers/ctx.ts";

setDefaultTimeout(180_000);

const file = (tree: unknown, path = "pages/x.json") => ({ path, content: JSON.stringify(tree) });
const variants = (styles: ClassStyles, selector: string): unknown[] =>
  [...(styles.get(selector) ?? [])].map((v) => JSON.parse(v));

describe("a document's own elements", () => {
  test("the first class of an element names the rule, whatever follows it, and the style is the element's whole style", () => {
    const styles = collectClassStyles([
      file({
        children: [
          {
            tagName: "div",
            className: "card cs-extra",
            style: { padding: "5px", "@--sm": { width: "100%" } },
            children: [{ tagName: "p", className: "deep", style: { margin: "0" } }],
          },
        ],
      }),
    ]);
    expect(variants(styles, ".card")).toEqual([{ padding: "5px", "@--sm": { width: "100%" } }]);
    expect(variants(styles, ".deep")).toEqual([{ margin: "0" }]);
    expect(styles.has(".cs-extra")).toBe(false);
  });

  test("an element with no class, no style or an empty one says nothing, and a $switch case or a nested list is walked", () => {
    const styles = collectClassStyles([
      file({
        children: [
          { tagName: "div", style: { padding: "1px" } },
          { tagName: "div", className: "bare" },
          { tagName: "div", className: "empty", style: {} },
          {
            tagName: "div",
            cases: { a: { tagName: "span", className: "inCase", style: { color: "red" } } },
          },
        ],
      }),
    ]);
    expect([...styles.keys()]).toEqual([".inCase"]);
  });

  test("two elements of one class with different styles are two variants, and key order does not make a variant", () => {
    const styles = collectClassStyles([
      file({ tagName: "div", className: "c", style: { a: "1", b: "2" } }),
      file({ tagName: "div", className: "c", style: { b: "2", a: "1" } }, "layouts/y.json"),
      file({ tagName: "div", className: "c", style: { a: "9" } }, "components/z.json"),
    ]);
    expect(styles.get(".c")?.size).toBe(2);
    expect(sortedJson({ b: 1, a: { d: 1, c: 2 } })).toBe(sortedJson({ a: { c: 2, d: 1 }, b: 1 }));
  });

  test("what is not a Jx document is skipped: a stylesheet, a file that is not JSON", () => {
    const styles = collectClassStyles([
      { path: "public/css/a.css", content: ".a { color: red }" },
      { path: "pages/broken.json", content: "{ nope" },
    ]);
    expect(styles.size).toBe(0);
  });
});

describe("the items of a query loop, which a converter writes as the text of an expression", () => {
  const item = (inner: string) => `\${items.map(($i0) => ({${inner}}))}`;

  test("a literal is parsed as data: quotes, escapes and braces inside strings are not structure", () => {
    const styles = collectClassStyles([
      file({
        innerHTML: item(
          `'tagName': 'h2', 'className': 'heading-x', 'style': {'padding': '2rem', 'content': '"}\\' {"', '@--sm': {'fontSize': '20px'}}, 'textContent': ($i0.data.title ?? '')`,
        ),
      }),
    ]);
    expect(variants(styles, ".heading-x")).toEqual([
      { padding: "2rem", content: `"}' {"`, "@--sm": { fontSize: "20px" } },
    ]);
  });

  test("an element with no style of its own does not take the style of the next element", () => {
    const styles = collectClassStyles([
      file({
        innerHTML: item(
          `'tagName': 'a', 'className': 'plain', 'children': [{'tagName': 'div', 'className': 'inner', 'style': {'margin': '1px'}}]`,
        ),
      }),
    ]);
    expect(styles.has(".plain")).toBe(false);
    expect(variants(styles, ".inner")).toEqual([{ margin: "1px" }]);
  });

  test("a literal that is not plain data is left alone, never evaluated", () => {
    const styles = collectClassStyles([
      file({ innerHTML: item(`'className': 'evil', 'style': {'a': process.exit(3)}`) }),
      file({ innerHTML: `\${items.map(($i0) => ({'className': 'open', 'style': {'a': '1'` }),
    ]);
    expect(styles.size).toBe(0);
  });
});

describe("the real site", () => {
  let styles: ClassStyles;
  beforeAll(async () => {
    const out = await buildTemplates(await loadSite("fineline"));
    styles = collectClassStyles(out.files);
  });

  test("a template's query loop holds the related-project card, whose heading the entries also style", () => {
    const heading = variants(styles, ".heading-c235f2d");
    expect(heading).toContainEqual({ position: "relative", display: "block", padding: "2rem" });
  });

  test("a class that the layouts and an entry both style is one the entries have to be written against", () => {
    // The card of the project template: its tree has the style directly, not through an expression.
    expect(styles.has(".div-c3a6482")).toBe(true);
    for (const [selector, set] of styles) {
      expect(selector).toMatch(/^\.[^\s.]+$/);
      expect(set.size).toBeGreaterThan(0);
    }
  });
});
