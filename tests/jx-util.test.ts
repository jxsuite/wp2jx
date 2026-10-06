import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { camelToKebab } from "@jxsuite/runtime/css";
import { isTemplateString } from "@jxsuite/schema/guards";
import type { Element, Nodes } from "hast";
import { fromHtml } from "hast-util-from-html";
import postcss from "postcss";
import {
  cssTextToStyle,
  escapeTemplate,
  isBinding,
  isEmptyStyle,
  joinClass,
  kebabToCamel,
  mergeStyle,
} from "../src/jx-util.ts";
import type { JxStyle } from "../src/types.ts";
import { FIXTURES } from "./helpers/fixture-db.ts";

const SITES = ["fineline", "ap"] as const;

/** Every declaration property in the committed Cwicly stylesheets: the names real conversions meet. */
function realCssProperties(): string[] {
  const names = new Set<string>();
  for (const site of SITES) {
    const dir = join(FIXTURES, site, "css");
    for (const file of readdirSync(dir)) {
      postcss.parse(readFileSync(join(dir, file), "utf8")).walkDecls((decl) => {
        names.add(decl.prop);
      });
    }
  }
  return [...names];
}

/** Every `style` attribute value in the rendered pages, as the parser decodes it. */
function realStyleAttributes(): string[] {
  const out: string[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "element") {
      const style = (node as Element).properties.style;
      if (typeof style === "string") out.push(style);
    }
    if ("children" in node) for (const child of node.children) walk(child);
  };
  for (const site of SITES) {
    const dir = join(FIXTURES, site, "html");
    for (const file of readdirSync(dir)) walk(fromHtml(readFileSync(join(dir, file), "utf8")));
  }
  return out;
}

describe("kebabToCamel", () => {
  test("camelises ordinary properties", () => {
    expect(kebabToCamel("margin-top")).toBe("marginTop");
    expect(kebabToCamel("border-top-left-radius")).toBe("borderTopLeftRadius");
    expect(kebabToCamel("color")).toBe("color");
  });

  test("keeps custom properties exactly, case and dashes included", () => {
    expect(kebabToCamel("--cc-color-1")).toBe("--cc-color-1");
    expect(kebabToCamel("--fooBar")).toBe("--fooBar");
    expect(kebabToCamel("--background-image")).toBe("--background-image");
  });

  test("capitalises a vendor prefix, which is how the runtime gets its dash back", () => {
    expect(kebabToCamel("-webkit-box-orient")).toBe("WebkitBoxOrient");
    expect(kebabToCamel("-moz-column-gap")).toBe("MozColumnGap");
    expect(kebabToCamel("-ms-flex")).toBe("MsFlex");
    expect(kebabToCamel("-o-object-fit")).toBe("OObjectFit");
  });

  test("leaves a name that is already camelCase alone", () => {
    expect(kebabToCamel("marginTop")).toBe("marginTop");
  });

  test("is the inverse of the runtime's camelToKebab for every property in the real stylesheets", () => {
    const names = realCssProperties();
    expect(names.length).toBeGreaterThan(100);
    const failures = names.filter((name) => {
      const key = kebabToCamel(name);
      return name.startsWith("--") ? key !== name : camelToKebab(key) !== name;
    });
    expect(failures).toEqual([]);
  });
});

describe("cssTextToStyle", () => {
  test("converts a plain declaration list to camelCase keys", () => {
    // fineline home.html: a span Cwicly's editor wrapped around pasted text.
    expect(cssTextToStyle("font-weight: 400;")).toEqual({ fontWeight: "400" });
    expect(cssTextToStyle("position: fixed;left: 3710px;top: 0;")).toEqual({
      position: "fixed",
      left: "3710px",
      top: "0",
    });
  });

  test("keeps colons, slashes and commas in values", () => {
    expect(
      cssTextToStyle(
        "width: 100%; height: auto; aspect-ratio: 2 / 1; display: flex; align-items: flex-end;",
      ),
    ).toEqual({
      width: "100%",
      height: "auto",
      aspectRatio: "2 / 1",
      display: "flex",
      alignItems: "flex-end",
    });
  });

  test("keeps !important on the value", () => {
    expect(cssTextToStyle("opacity: 0;height: 0 !important;overflow: hidden !important")).toEqual({
      opacity: "0",
      height: "0 !important",
      overflow: "hidden !important",
    });
    expect(cssTextToStyle("color: red ! important")).toEqual({ color: "red !important" });
  });

  test("keeps custom properties as written, with an unquoted url that holds a query string", () => {
    const style = cssTextToStyle(
      "--background-image:url(https://secure.gravatar.com/avatar/?s=96&d=blank&r=g);",
    );
    expect(style).toEqual({
      "--background-image": "url(https://secure.gravatar.com/avatar/?s=96&d=blank&r=g)",
    });
    expect(Object.keys(cssTextToStyle("--fooBar: 1; --foo-bar: 2"))).toEqual([
      "--fooBar",
      "--foo-bar",
    ]);
  });

  test("does not split on a semicolon inside url(), a string, or a comment", () => {
    expect(
      cssTextToStyle(
        "background:url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=) no-repeat;color:red",
      ),
    ).toEqual({
      background: "url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=) no-repeat",
      color: "red",
    });
    expect(cssTextToStyle(`content: ";"; quotes: "a;b" 'c;d'`)).toEqual({
      content: '";"',
      quotes: `"a;b" 'c;d'`,
    });
    expect(cssTextToStyle("color: red /* ; margin: 0 */; padding: 1px")).toEqual({
      color: "red",
      padding: "1px",
    });
    expect(cssTextToStyle(`font-family: "A\\";B", serif`)).toEqual({
      fontFamily: `"A\\";B", serif`,
    });
  });

  test("trims, tolerates stray semicolons, and returns nothing for empty input", () => {
    expect(cssTextToStyle("            text-align:left ")).toEqual({ textAlign: "left" });
    expect(cssTextToStyle(";; color:red;;")).toEqual({ color: "red" });
    expect(cssTextToStyle("")).toEqual({});
    expect(cssTextToStyle("   ")).toEqual({});
    expect(cssTextToStyle(undefined)).toEqual({});
    expect(cssTextToStyle(null)).toEqual({});
  });

  test("lowercases property names but not custom properties or values", () => {
    expect(cssTextToStyle("COLOR: Red; Margin-Top: 1PX; --Brand: Blue")).toEqual({
      color: "Red",
      marginTop: "1PX",
      "--Brand": "Blue",
    });
  });

  test("camelises vendor-prefixed properties the way the runtime inverts them", () => {
    const style = cssTextToStyle("-webkit-box-orient: vertical; -moz-user-select: none");
    expect(style).toEqual({ WebkitBoxOrient: "vertical", MozUserSelect: "none" });
    for (const key of Object.keys(style)) expect(camelToKebab(key).startsWith("-")).toBe(true);
  });

  test("applies the cascade to a repeated property: the last one wins and moves to the end", () => {
    const style = cssTextToStyle("margin-top: 1px; margin: 0; margin-top: 2px; margin: 3px");
    expect(style).toEqual({ marginTop: "2px", margin: "3px" });
    // The emitted rule keeps this order, and `margin: 3px` coming after `margin-top: 2px` is what
    // lets it win, as it does in the source. Left where it first appeared it would lose.
    expect(Object.keys(style)).toEqual(["marginTop", "margin"]);
    const longhandLast = cssTextToStyle(
      "margin: 1px; margin-top: 2px; margin: 3px; margin-top: 4px",
    );
    expect(Object.keys(longhandLast)).toEqual(["margin", "marginTop"]);
    expect(Object.entries(cssTextToStyle("margin: 1px; margin-top: 2px; margin: 3px"))).toEqual([
      ["marginTop", "2px"],
      ["margin", "3px"],
    ]);
  });

  test("never lets a later plain declaration replace an earlier !important one", () => {
    expect(cssTextToStyle("color: red !important; color: blue")).toEqual({
      color: "red !important",
    });
    expect(cssTextToStyle("color: red; color: blue !important")).toEqual({
      color: "blue !important",
    });
  });

  test("skips what is not a declaration, and says so", () => {
    const skipped: string[] = [];
    const style = cssTextToStyle("color; : red; *zoom: 1; width: ; height: 2px", (d) =>
      skipped.push(d),
    );
    expect(style).toEqual({ height: "2px" });
    expect(skipped).toEqual(["color", ": red", "*zoom: 1", "width:"]);
  });

  test("a property name written as a string is not a name, whatever colons it holds", () => {
    const skipped: string[] = [];
    expect(cssTextToStyle(`"a:b": c; 'x\\':y': z; color: red`, (d) => skipped.push(d))).toEqual({
      color: "red",
    });
    expect(skipped).toEqual([`"a:b": c`, `'x\\':y': z`]);
  });

  test("reads every style attribute in the rendered pages the way postcss does", () => {
    const attributes = realStyleAttributes();
    expect(attributes.length).toBeGreaterThan(50);
    for (const text of attributes) {
      const skipped: string[] = [];
      const style = cssTextToStyle(text, (d) => skipped.push(d));
      expect(skipped).toEqual([]);

      // postcss keeps repeated declarations; the cascade keeps the last of each property.
      const expected = new Map<string, string>();
      postcss.parse(`a{${text}}`).walkDecls((decl) => {
        const key = decl.prop.startsWith("--") ? decl.prop : kebabToCamel(decl.prop.toLowerCase());
        expected.delete(key);
        expected.set(key, decl.important ? `${decl.value} !important` : decl.value);
      });
      expect(Object.entries(style)).toEqual([...expected]);
    }
  });
});

describe("cssTextToStyle: where a declaration ends", () => {
  // A style attribute is read by the CSS parser, not by a splitter on semicolons. Whatever this
  // reads wrongly is written into a stylesheet, where an unbalanced quote or bracket does not only
  // lose its own declaration: it swallows the rules of the elements after it.

  test("a string, parenthesis or bracket still open at the end is closed there, as CSS does at the end of input", () => {
    expect(cssTextToStyle("font-family:'Arial")).toEqual({ fontFamily: "'Arial'" });
    expect(cssTextToStyle(`content:"a`)).toEqual({ content: `"a"` });
    expect(cssTextToStyle("width:calc(1px + 2px")).toEqual({ width: "calc(1px + 2px)" });
    expect(cssTextToStyle(`grid-template-areas: "a b" "c`)).toEqual({
      gridTemplateAreas: `"a b" "c"`,
    });
    expect(cssTextToStyle("background:url(x")).toEqual({ background: "url(x)" });
    expect(cssTextToStyle("grid-template-columns:[full-start] 1fr [full-end")).toEqual({
      gridTemplateColumns: "[full-start] 1fr [full-end]",
    });
    // Several at once close in the reverse of the order they opened.
    expect(cssTextToStyle(`width:calc(1px + var(--a, "x`)).toEqual({
      width: `calc(1px + var(--a, "x"))`,
    });
    expect(cssTextToStyle("--a:([x")).toEqual({ "--a": "([x])" });
    expect(cssTextToStyle("--a:[(x")).toEqual({ "--a": "[(x)]" });
    // The backslash at the very end escapes nothing, so it must not escape what closes the string or the bracket.
    expect(cssTextToStyle(`content:"a\\`)).toEqual({ content: `"a"` });
    expect(cssTextToStyle("width:calc(1px \\")).toEqual({ width: "calc(1px )" });
    expect(cssTextToStyle("background:url(a\\")).toEqual({ background: "url(a)" });
  });

  test("a closing bracket nothing opened, or a brace that never closes, makes the declaration unreadable", () => {
    const skipped: string[] = [];
    const heard = (d: string): void => void skipped.push(d);
    expect(cssTextToStyle("color:red};margin:0", heard)).toEqual({ margin: "0" });
    expect(cssTextToStyle("color:red)", heard)).toEqual({});
    expect(cssTextToStyle("color:red]; top:1px", heard)).toEqual({ top: "1px" });
    expect(cssTextToStyle("margin:0 {", heard)).toEqual({});
    expect(cssTextToStyle("margin:0 {;color:red", heard)).toEqual({});
    expect(skipped).toEqual([
      "color:red}",
      "color:red)",
      "color:red]",
      "margin:0 {",
      "margin:0 {;color:red",
    ]);
  });

  test("a semicolon inside brackets or braces ends nothing", () => {
    expect(cssTextToStyle("--a:[;];color:red")).toEqual({ "--a": "[;]", color: "red" });
    expect(cssTextToStyle("--a:{x:1;y:2};color:red")).toEqual({ "--a": "{x:1;y:2}", color: "red" });
    expect(cssTextToStyle("--a:(;);color:red")).toEqual({ "--a": "(;)", color: "red" });
    expect(cssTextToStyle("--a:{[(;)]};color:red")).toEqual({ "--a": "{[(;)]}", color: "red" });
  });

  test("a comment opener inside an unquoted url() is part of the address", () => {
    expect(cssTextToStyle("background:url(//x/*.png);color:red")).toEqual({
      background: "url(//x/*.png)",
      color: "red",
    });
    expect(cssTextToStyle("background:url( //x.test/a/*b*/c.png ) ; color:red")).toEqual({
      background: "url( //x.test/a/*b*/c.png )",
      color: "red",
    });
    expect(cssTextToStyle("background:URL(//x/*.png);color:red")).toEqual({
      background: "URL(//x/*.png)",
      color: "red",
    });
    // Escaped characters in the address belong to it.
    expect(cssTextToStyle("background:url(a\\);b.png);color:red")).toEqual({
      background: "url(a\\);b.png)",
      color: "red",
    });
  });

  test("a url() with a quoted address and a function that merely ends in url are not unquoted urls", () => {
    expect(cssTextToStyle("background:url('a/*b');color:red")).toEqual({
      background: "url('a/*b')",
      color: "red",
    });
    expect(cssTextToStyle("background:url( 'a;b' );color:red")).toEqual({
      background: "url( 'a;b' )",
      color: "red",
    });
    // A parenthesis inside the string closes nothing; an unquoted address would end there.
    expect(cssTextToStyle(`background:url('a)b');color:red`)).toEqual({
      background: `url('a)b')`,
      color: "red",
    });
    expect(cssTextToStyle(`background:url("a)b");color:red`)).toEqual({
      background: `url("a)b")`,
      color: "red",
    });
    // `curl(` is a function like any other, so this really is a comment.
    expect(cssTextToStyle("background:curl(/* b */a);color:red")).toEqual({
      background: "curl(a)",
      color: "red",
    });
    expect(cssTextToStyle("background:my-url(/* b */a);color:red")).toEqual({
      background: "my-url(a)",
      color: "red",
    });
  });

  test("a string ends at a raw newline and the declaration is unreadable; an escaped newline continues it", () => {
    const skipped: string[] = [];
    expect(cssTextToStyle("font-family:'Arial\n;color:red", (d) => skipped.push(d))).toEqual({
      color: "red",
    });
    expect(cssTextToStyle('content:"a\r\n;top:1px', (d) => skipped.push(d))).toEqual({
      top: "1px",
    });
    expect(skipped).toEqual(["font-family:'Arial", 'content:"a']);
    expect(cssTextToStyle(`content:"a\\\nb";color:red`)).toEqual({
      content: `"a\\\nb"`,
      color: "red",
    });
  });

  test("every newline form ends a string alike, and a backslash before one escapes it whole", () => {
    // CSS reads CR, FF and CRLF as one newline each, so a string meets one before any `;` after it.
    for (const newline of ["\r", "\f", "\r\n", "\n"]) {
      const skipped: string[] = [];
      expect(cssTextToStyle(`content:"a${newline};top:1px`, (d) => skipped.push(d))).toEqual({
        top: "1px",
      });
      expect(skipped).toEqual(['content:"a']);
      // Escaped, the pair is the string's own, and the string goes on to its quote.
      expect(cssTextToStyle(`content:"a\\${newline}b";top:1px`)).toEqual({
        content: `"a\\\nb"`,
        top: "1px",
      });
    }
  });

  test("whatever it returns is balanced, so a stylesheet written from it stays in step", () => {
    const hostile = [
      "font-family:'Arial",
      'content:"a',
      "width:calc(1px + 2px",
      "margin:0 {",
      'grid-template-areas: "a b" "c',
      "background:url(x",
      "color:red}",
      "--a:[;];color:red",
      "background:url(//x/*.png);color:red",
      "width:calc(1px;color:red",
      "content:'\\",
      "a:((((",
      "a:'\"",
    ];
    for (const text of hostile) {
      for (const value of Object.values(cssTextToStyle(text))) {
        const sheet = postcss.parse(`.a { x: ${String(value)} }\n.b { color: green }`);
        // Both rules survive and the second still holds its own declaration.
        expect(sheet.nodes).toHaveLength(2);
        expect((sheet.nodes[1] as postcss.Rule).nodes).toHaveLength(1);
      }
    }
  });
});

describe("cssTextToStyle: a property declared more than once", () => {
  // A browser drops a declaration it cannot read, so an earlier one survives it: that is how a
  // fallback is written. A style object keeps one value per property and cannot say "the last one
  // that is valid", so the caller is told and can keep the text.

  test("hears about each declaration another displaces, and who displaced it", () => {
    const heard: [string, string, string][] = [];
    const style = cssTextToStyle(
      "width:100px;width:90px\\9;color:red;color:red",
      undefined,
      (...a) => heard.push(a),
    );
    expect(style).toEqual({ width: "90px\\9", color: "red" });
    expect(heard).toEqual([["width", "100px", "90px\\9"]]);
  });

  test("a plain declaration an earlier !important one beats is heard about too", () => {
    const heard: [string, string, string][] = [];
    cssTextToStyle("color: red !important; color: blue", undefined, (...a) => heard.push(a));
    expect(heard).toEqual([["color", "blue", "red !important"]]);
  });

  test("a shorthand after its longhand is a different property, not a repeat", () => {
    const heard: unknown[] = [];
    cssTextToStyle("margin-top: 1px; margin: 0", undefined, (...a) => heard.push(a));
    expect(heard).toEqual([]);
  });

  test("custom properties repeat by their exact name", () => {
    const heard: unknown[] = [];
    cssTextToStyle("--a:1;--A:2;--a:3", undefined, (...a) => heard.push(a));
    expect(heard).toEqual([["--a", "1", "3"]]);
  });

  test("the real style attributes repeat nothing, so none of them is kept as text", () => {
    const heard: unknown[] = [];
    for (const text of realStyleAttributes()) {
      cssTextToStyle(text, undefined, (...a) => heard.push(a));
    }
    expect(heard).toEqual([]);
  });
});

describe("mergeStyle", () => {
  test("lets b win and keeps the rest of a", () => {
    expect(mergeStyle({ color: "red", padding: "1rem" }, { color: "blue", margin: "0" })).toEqual({
      color: "blue",
      padding: "1rem",
      margin: "0",
    });
  });

  test("merges nested blocks key by key, at any depth", () => {
    const a: JxStyle = {
      color: "red",
      ":hover": { color: "blue", textDecoration: "none" },
      "@--md": { padding: "1rem", ":hover": { color: "green" } },
    };
    const b: JxStyle = {
      ":hover": { color: "black" },
      "@--md": { margin: "0", ":hover": { color: "white", outline: "none" } },
      "& a": { color: "inherit" },
    };
    expect(mergeStyle(a, b)).toEqual({
      color: "red",
      ":hover": { color: "black", textDecoration: "none" },
      "@--md": {
        padding: "1rem",
        margin: "0",
        ":hover": { color: "white", outline: "none" },
      },
      "& a": { color: "inherit" },
    });
  });

  test("writes b's keys after a's, so a shorthand in b overrides a longhand in a", () => {
    const merged = mergeStyle({ marginTop: "1px", color: "red" }, { margin: "0", color: "blue" });
    expect(Object.keys(merged)).toEqual(["marginTop", "margin", "color"]);
  });

  test("replaces a scalar with a block and a block with a scalar", () => {
    expect(mergeStyle({ ":hover": "x" }, { ":hover": { color: "red" } })).toEqual({
      ":hover": { color: "red" },
    });
    expect(mergeStyle({ ":hover": { color: "red" } }, { ":hover": "x" })).toEqual({
      ":hover": "x",
    });
  });

  test("concatenates a repeated at-rule instead of replacing it", () => {
    const face = (weight: string): JxStyle => ({ fontFamily: "A", fontWeight: weight });
    expect(
      mergeStyle({ "@font-face": [face("400")] }, { "@font-face": [face("700"), face("900")] }),
    ).toEqual({ "@font-face": [face("400"), face("700"), face("900")] });
  });

  test("ignores undefined in b and treats missing inputs as empty", () => {
    expect(mergeStyle({ color: "red" }, { color: undefined, margin: "0" })).toEqual({
      color: "red",
      margin: "0",
    });
    expect(mergeStyle(undefined, { color: "red" })).toEqual({ color: "red" });
    expect(mergeStyle({ color: "red" }, null)).toEqual({ color: "red" });
    expect(mergeStyle(undefined, undefined)).toEqual({});
  });

  test("never modifies or aliases its inputs", () => {
    const a: JxStyle = { ":hover": { color: "red" }, "@font-face": [{ fontFamily: "A" }] };
    const b: JxStyle = { ":hover": { margin: "0" } };
    const snapshot = structuredClone({ a, b });
    const merged = mergeStyle(a, b);
    expect({ a, b }).toEqual(snapshot);
    (merged[":hover"] as JxStyle).color = "changed";
    ((merged["@font-face"] as JxStyle[])[0] as JxStyle).fontFamily = "changed";
    expect({ a, b }).toEqual(snapshot);
  });

  test("a block only one side has is copied at every depth, not shared", () => {
    // `:hover` and `@--md` are each in one input only, so nothing merges them: they must still be copies.
    const a: JxStyle = { ":hover": { color: "red", "& a": { color: "blue" } } };
    const b: JxStyle = { "@--md": { padding: "1rem", ":hover": { color: "green" } } };
    const snapshot = structuredClone({ a, b });
    const merged = mergeStyle(a, b);
    ((merged[":hover"] as JxStyle)["& a"] as JxStyle).color = "changed";
    (merged[":hover"] as JxStyle).color = "changed";
    ((merged["@--md"] as JxStyle)[":hover"] as JxStyle).color = "changed";
    (merged["@--md"] as JxStyle).padding = "changed";
    expect({ a, b }).toEqual(snapshot);
  });
});

describe("isEmptyStyle", () => {
  test("is true for nothing and for blocks that hold nothing", () => {
    expect(isEmptyStyle(undefined)).toBe(true);
    expect(isEmptyStyle(null)).toBe(true);
    expect(isEmptyStyle({})).toBe(true);
    expect(isEmptyStyle({ color: undefined, margin: "" })).toBe(true);
    expect(isEmptyStyle({ ":hover": {}, "@--md": { ":hover": { color: undefined } } })).toBe(true);
    expect(isEmptyStyle({ "@font-face": [] })).toBe(true);
  });

  test("is false as soon as any declaration is reachable", () => {
    expect(isEmptyStyle({ color: "red" })).toBe(false);
    expect(isEmptyStyle({ opacity: 0 })).toBe(false);
    expect(isEmptyStyle({ ":hover": {}, "@--md": { ":hover": { color: "red" } } })).toBe(false);
    expect(isEmptyStyle({ "@font-face": [{ fontFamily: "A" }] })).toBe(false);
  });
});

describe("joinClass", () => {
  test("joins in order and drops duplicates, first occurrence winning", () => {
    expect(joinClass("div-cf3ac5e", "card section-default", "card", "div-cf3ac5e")).toBe(
      "div-cf3ac5e card section-default",
    );
  });

  test("skips falsy parts and splits on any ASCII whitespace", () => {
    expect(joinClass("a", false, null, undefined, "", "  b\tc\nd ")).toBe("a b c d");
    expect(joinClass()).toBe("");
    expect(joinClass(false, null)).toBe("");
  });

  test("does not treat a no-break space as a separator", () => {
    expect(joinClass("a b", "c")).toBe("a b c");
  });
});

describe("isBinding and escapeTemplate", () => {
  const samples = [
    "plain",
    "",
    "$",
    "${",
    "${state.count}",
    "a ${b} c",
    "$ {not}",
    "$​{x}",
    "{title}",
    "&#36;{x}",
  ];

  test("isBinding agrees with Jx's own template test", () => {
    for (const sample of samples) expect(isBinding(sample)).toBe(isTemplateString(sample));
    expect(isBinding("a ${b} c")).toBe(true);
    expect(isBinding("{title}")).toBe(false);
    expect(isBinding(undefined)).toBe(false);
    expect(isBinding(42)).toBe(false);
    expect(isBinding({ $ref: "#/state/x" })).toBe(false);
  });

  test("escapeTemplate leaves nothing a template pass would read", () => {
    for (const sample of samples) expect(isBinding(escapeTemplate(sample))).toBe(false);
    expect(escapeTemplate("a ${b} c ${d}")).toBe("a &#36;{b} c &#36;{d}");
    expect(escapeTemplate("$${x}")).toBe("$&#36;{x}");
  });

  test("escapeTemplate changes nothing else", () => {
    for (const sample of ["plain", "", "$", "$ {x}", "{title}", "a &amp; b"])
      expect(escapeTemplate(sample)).toBe(sample);
  });

  test("an escaped sequence decodes back to the original text in an HTML parser", () => {
    const original = "Pay ${amount} now";
    const tree = fromHtml(`<p>${escapeTemplate(original)}</p>`, { fragment: true });
    const text = ((tree.children[0] as Element).children[0] as { value: string }).value;
    expect(text).toBe(original);
  });
});
