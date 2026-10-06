import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeJxMarkdown } from "@jxsuite/parser/serialize";
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";
import { parse as parseBlocks } from "@wordpress/block-serialization-default-parser";
import { fromHtml } from "hast-util-from-html";
import { parseFragment } from "parse5";
import { escapeTemplate, htmlToContent, htmlToNodes, nodesToHtml } from "../src/html.ts";
import type { HtmlOptions } from "../src/html.ts";
import { isBinding } from "../src/jx-util.ts";
import type { JxElement, JxNode, Report, ReportEntry } from "../src/types.ts";
import { FIXTURES } from "./helpers/fixture-db.ts";

const one = (html: string, opts?: Parameters<typeof htmlToNodes>[1]): JxElement => {
  const nodes = htmlToNodes(html, opts);
  expect(nodes).toHaveLength(1);
  return nodes[0] as JxElement;
};

const collect = (): Report & { all: ReportEntry[] } => {
  const all: ReportEntry[] = [];
  return { all, add: (entry) => void all.push(entry), entries: () => all };
};

describe("element mapping", () => {
  test("class becomes a whitespace-normalised className, id stays id", () => {
    expect(one(`<div class="  a   b\n c " id="x">t</div>`)).toEqual({
      tagName: "div",
      id: "x",
      className: "a b c",
      textContent: "t",
    });
  });

  test("an empty class or id is not carried", () => {
    expect(one(`<div class="" id="">t</div>`)).toEqual({ tagName: "div", textContent: "t" });
    expect(one(`<div class=" \t">t</div>`)).toEqual({ tagName: "div", textContent: "t" });
  });

  test("never writes class, id or style under attributes", () => {
    const node = one(`<a class="c" id="i" style="color:red" href="/x" data-n="1">t</a>`, {
      scopeStyle: false,
    });
    expect(Object.keys(node.attributes ?? {})).toEqual(["href", "data-n"]);
  });

  test("inline style becomes a camelCase style object", () => {
    // anabaptistperspectives.org essay pages: a comment avatar styled through a custom property.
    const node = one(
      `<div class="div-comment-avatar" style="--background-image:url(https://secure.gravatar.com/avatar/?s=96&amp;d=blank&amp;r=g);"></div>`,
      { scopeStyle: false },
    );
    expect(node).toEqual({
      tagName: "div",
      className: "div-comment-avatar",
      style: { "--background-image": "url(https://secure.gravatar.com/avatar/?s=96&d=blank&r=g)" },
    });
    expect(
      one(`<div style="opacity: 0;height: 0 !important;overflow: hidden !important"></div>`).style,
    ).toEqual({ opacity: "0", height: "0 !important", overflow: "hidden !important" });
    expect(one(`<p style="Margin-Top: 3rem; -webkit-box-orient: vertical">x</p>`).style).toEqual({
      marginTop: "3rem",
      WebkitBoxOrient: "vertical",
    });
  });

  test("everything else goes under attributes with its real name and string value", () => {
    // fineline home.html: the mobile menu backdrop.
    expect(
      one(`<a href="#" class="cc-nav-backdrop" aria-hidden="true" tabindex="-1"></a>`),
    ).toEqual({
      tagName: "a",
      className: "cc-nav-backdrop",
      attributes: { href: "#", "aria-hidden": "true", tabindex: "-1" },
    });
    // The query block's own attributes, underscores included.
    expect(
      one(`<div id="query-cb329f4" data-query_id="1" data-cc_fr="true" data-cc_il="scroll"></div>`)
        .attributes,
    ).toEqual({ "data-query_id": "1", "data-cc_fr": "true", "data-cc_il": "scroll" });
    // A dash before a digit has no camelCase spelling, which is where a property round trip fails.
    expect(one(`<div data-slide-1="a" data-x-2-y="b" role="note"></div>`).attributes).toEqual({
      "data-slide-1": "a",
      "data-x-2-y": "b",
      role: "note",
    });
  });

  test("keeps attribute values exactly: no number parsing, no list splitting, entities decoded", () => {
    // Cwicly writes empty values for image attributes it fills in at render time.
    expect(
      one(`<img class="image-cb08483" src="/a.svg" srcset="" sizes="" width="" height="" alt=""/>`)
        .attributes,
    ).toEqual({ src: "/a.svg", srcset: "", sizes: "", width: "", height: "", alt: "" });
    expect(one(`<img width="0100" height="1.0" tabindex="007" src="x">`).attributes).toEqual({
      width: "0100",
      height: "1.0",
      tabindex: "007",
      src: "x",
    });
    const srcset = "https://cdn.test/w_300,h_200/a.jpg 1x,  https://cdn.test/b.jpg 2x";
    expect(one(`<img srcset="${srcset}">`).attributes).toEqual({ srcset });
    expect(
      one(`<a rel="noopener  noreferrer" href="/x?a=1&amp;b=2&#8217;"></a>`).attributes,
    ).toEqual({
      rel: "noopener  noreferrer",
      href: "/x?a=1&b=2’",
    });
    // fineline: a popover carries its interactions as JSON in a single-quoted attribute.
    const json = `{"mouseover":[{"action":"addclass","targets":[{"data":"#paragraph-content"}]}]}`;
    expect(one(`<div data-interaction='${json}'></div>`).attributes).toEqual({
      "data-interaction": json,
    });
  });

  test("boolean attributes get the empty string, whatever the source spelled", () => {
    // fineline: the search form input, and the hamburger button.
    expect(
      one(`<input class="wp-block-search__input" type="search" name="s" required>`).attributes,
    ).toEqual({
      type: "search",
      name: "s",
      required: "",
    });
    expect(one(`<button disabled aria-hidden="true"></button>`).attributes).toEqual({
      disabled: "",
      "aria-hidden": "true",
    });
    expect(one(`<input disabled="disabled" checked="CHECKED" readonly=""/>`).attributes).toEqual({
      disabled: "",
      checked: "",
      readonly: "",
    });
    expect(one(`<p hidden>x</p>`).attributes).toEqual({ hidden: "" });
    // An attribute that is only sometimes boolean keeps a real value.
    expect(one(`<a download="report.pdf" href="/r"></a>`).attributes).toEqual({
      download: "report.pdf",
      href: "/r",
    });
    // aria-* are strings, never booleans.
    expect(one(`<div aria-hidden="false" aria-expanded=""></div>`).attributes).toEqual({
      "aria-hidden": "false",
      "aria-expanded": "",
    });
  });

  test("tag names are lowercase and attribute names are what the source said, lowercased", () => {
    expect(one(`<DIV CLASS="A" DATA-X="1">t</DIV>`)).toEqual({
      tagName: "div",
      className: "A",
      attributes: { "data-x": "1" },
      textContent: "t",
    });
  });

  test("a duplicate attribute keeps the first, as a browser does", () => {
    expect(one(`<a href="/one" href="/two"></a>`).attributes).toEqual({ href: "/one" });
  });

  test("custom elements and unknown tags pass through", () => {
    // Cwicly's pseudo-elements that PHP replaces at render time.
    expect(one(`<ccd>custom_current_date=Y</ccd>`)).toEqual({
      tagName: "ccd",
      textContent: "custom_current_date=Y",
    });
    expect(one(`<fp-icon-card label="x"></fp-icon-card>`)).toEqual({
      tagName: "fp-icon-card",
      attributes: { label: "x" },
    });
  });

  test("an element Jx cannot name is dropped, its content kept, and the report says so", () => {
    const report = collect();
    const nodes = htmlToNodes(`<p>a<o:p>b</o:p>c <i>d</i></p>`, { report, where: "post:1" });
    expect(nodes).toEqual([
      { tagName: "p", children: ["abc ", { tagName: "i", textContent: "d" }] },
    ]);
    expect(report.all).toHaveLength(1);
    expect(report.all[0]).toMatchObject({
      code: "html.tag-invalid",
      severity: "warn",
      where: "post:1",
    });
  });

  test("an inline style declaration that cannot be read is reported, not lost silently", () => {
    const report = collect();
    const node = one(`<p style="color:red;*zoom:1;width:">x</p>`, { report });
    expect(node.style).toEqual({ color: "red" });
    expect(report.all).toHaveLength(1);
    expect(report.all[0]).toMatchObject({
      code: "html.style-skipped",
      data: { tag: "p", skipped: ["*zoom:1", "width:"] },
    });
  });

  test("a style with nothing readable in it is not carried as an empty object", () => {
    for (const style of ["", " ; ", "/* c */", ";;"]) {
      expect(one(`<p style="${style}">x</p>`)).toEqual({ tagName: "p", textContent: "x" });
    }
    const report = collect();
    expect(one(`<p style="*zoom:1">x</p>`, { report })).toEqual({ tagName: "p", textContent: "x" });
    expect(report.all).toHaveLength(1);
  });

  test("an unbalanced quote or bracket in a style is closed or skipped, so it cannot swallow the rules after it", () => {
    const report = collect();
    expect(
      one(`<p style="font-family:'Arial;width:calc(1px + 2px">x</p>`, {
        report,
        scopeStyle: false,
      }),
    ).toEqual({
      tagName: "p",
      // The string runs to the end of the text, taking the width with it: that is what CSS reads.
      style: { fontFamily: "'Arial;width:calc(1px + 2px'" },
      textContent: "x",
    });
    expect(one(`<p style="width:calc(1px + 2px">x</p>`).style).toEqual({
      width: "calc(1px + 2px)",
    });
    expect(one(`<p style="color:red}">x</p>`, { report })).toEqual({
      tagName: "p",
      textContent: "x",
    });
    expect(report.all).toMatchObject([
      { code: "html.style-skipped", data: { tag: "p", skipped: ["color:red}"] } },
    ]);
  });

  test("an attribute named like a property every object has is an attribute like any other", () => {
    // `constructor` and `__proto__` are keys of Object.prototype, and property-information looks
    // names up in plain objects, so it found the prototype's own entry and came back with nothing.
    const html = `<div constructor="x" __proto__="y" tostring="z" data-a="1">t</div>`;
    const node = one(html);
    const attributes = node.attributes as Record<string, string>;
    expect(Object.getOwnPropertyNames(attributes)).toEqual([
      "constructor",
      "__proto__",
      "tostring",
      "data-a",
    ]);
    expect(Object.getOwnPropertyDescriptor(attributes, "__proto__")?.value).toBe("y");
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    // JSON is how it reaches Jx, and the names must survive it.
    expect(JSON.stringify(attributes)).toBe(
      `{"constructor":"x","__proto__":"y","tostring":"z","data-a":"1"}`,
    );
    expect(nodesToHtml([node])).toBe(html);
    const [filled] = htmlToContent(html).children as JxElement[];
    expect(Object.getOwnPropertyNames(filled?.attributes as object)).toEqual([
      "constructor",
      "__proto__",
      "tostring",
      "data-a",
    ]);
    // Its value is kept as written, even when it names the attribute (what a boolean attribute does).
    expect(one(`<div constructor="constructor">t</div>`).attributes).toEqual({
      constructor: "constructor",
    });
  });

  test("so is one on an element of an svg tree, where an assignment would have dropped __proto__", () => {
    const [path] = (one(`<svg><path __proto__="x" constructor="y" d="M0 0"/></svg>`, {
      svg: "tree",
    }).children ?? []) as JxElement[];
    expect(Object.getOwnPropertyNames(path?.attributes as object)).toEqual([
      "__proto__",
      "constructor",
      "d",
    ]);
    expect(Object.getOwnPropertyDescriptor(path?.attributes as object, "__proto__")?.value).toBe(
      "x",
    );
    // And as markup it was never in doubt.
    expect(one(`<svg><path __proto__="x" d="M0 0"/></svg>`).innerHTML).toBe(
      `<path __proto__="x" d="M0 0"/>`,
    );
  });
});

describe("the report", () => {
  test("one finding repeated through a fragment is one entry", () => {
    const report = collect();
    htmlToNodes(`<p style="*zoom:1">a</p><p style="*zoom:1">b</p><p><o:p>c</o:p><o:p>d</o:p></p>`, {
      report,
    });
    expect(report.all.map((e) => e.code)).toEqual(["html.style-skipped", "html.tag-invalid"]);
  });

  test("two different findings of one code are two entries", () => {
    const report = collect();
    htmlToNodes(`<p><o:p>a</o:p><v:shape>b</v:shape></p>`, { report });
    expect(report.all.map((e) => e.data?.tag)).toEqual(["o:p", "v:shape"]);
    // The same declaration on another tag is another finding.
    const styles = collect();
    htmlToNodes(`<p style="*zoom:1">a</p><div style="*zoom:1">b</div>`, { report: styles });
    expect(styles.all.map((e) => e.data?.tag)).toEqual(["p", "div"]);
  });

  test("each entry is located as the caller said, and a second fragment reports afresh", () => {
    const report = collect();
    const options = { report, where: "post:5", url: "https://x.test/p" };
    htmlToNodes(`<o:p>a</o:p>`, options);
    htmlToNodes(`<o:p>a</o:p>`, options);
    expect(report.all).toHaveLength(2);
    expect(report.all[0]).toEqual({
      severity: "warn",
      code: "html.tag-invalid",
      message: expect.stringContaining("o:p"),
      where: "post:5",
      url: "https://x.test/p",
      data: { tag: "o:p" },
    });
    // Without a location the entry has none.
    const bare = collect();
    htmlToNodes(`<o:p>a</o:p>`, { report: bare });
    expect(Object.keys(bare.all[0] ?? {}).sort()).toEqual(["code", "data", "message", "severity"]);
  });

  test("a caller's mistake is thrown, not reported as markup too deep", () => {
    expect(() => htmlToNodes(undefined as never)).toThrow(TypeError);
    expect(() => htmlToContent(null as never)).toThrow(TypeError);
  });
});

describe("a property declared twice in an inline style", () => {
  // `width:100px; width:90px\9` is how a fallback is written: a browser throws away a declaration it
  // cannot read, so the first survives. A style object keeps one value per property and the build
  // writes it into a rule, so the converter could only guess which one the browser would have kept.

  test("keeps the style as it was written, where a browser still picks the declaration it can read", () => {
    const report = collect();
    const node = one(`<div style="width:100px;width:90px\\9">x</div>`, { report, where: "post:2" });
    expect(node).toEqual({
      tagName: "div",
      attributes: { style: "width:100px;width:90px\\9" },
      textContent: "x",
    });
    expect(report.all).toMatchObject([
      {
        code: "html.style-fallback",
        severity: "info",
        where: "post:2",
        data: { tag: "div", property: "width" },
      },
    ]);
  });

  test("for each of the usual idioms, and without a generated class for a style that is not a rule", () => {
    for (const style of [
      "display:flex;display:-ms-flexbox",
      "width:100%;width:-moz-calc(100% - 10px)",
      "color:red;color:invalid",
      "display:-webkit-box;display:flex",
    ]) {
      expect(one(`<p class="a b" style="${style}">x</p>`)).toEqual({
        tagName: "p",
        className: "a b",
        attributes: { style },
        textContent: "x",
      });
    }
  });

  test("a property repeated with the same value, or only ever once, is an ordinary style object", () => {
    expect(one(`<div style="color:red;color:red;top:1px">x</div>`).style).toEqual({
      color: "red",
      top: "1px",
    });
    expect(one(`<div style="margin-top:1px;margin:0">x</div>`).style).toEqual({
      marginTop: "1px",
      margin: "0",
    });
  });

  test("an !important declaration that beats a later plain one counts as a repeat as well", () => {
    expect(one(`<p style="color:red !important;color:blue">x</p>`).attributes).toEqual({
      style: "color:red !important;color:blue",
    });
  });

  test("inlineStyle: attribute keeps it inline anyway, so there is nothing to report", () => {
    const report = collect();
    const node = one(`<p style="width:1px;width:2px">x</p>`, { inlineStyle: "attribute", report });
    expect(node.attributes).toEqual({ style: "width:1px;width:2px" });
    expect(report.all).toEqual([]);
  });
});

describe("style scoping", () => {
  // The Jx build writes an element's own style to `#id`, else to `.firstClass`. These are the two
  // avatars from an essay's comment list: same class, different style.
  const avatar = (n: number) =>
    `<div class="div-comment-avatar" style="--background-image:url(https://x.test/a${n}.jpg);"></div>`;

  test("an element with a class, a style and no id gets a generated first class", () => {
    const [first, second] = [one(avatar(1)), one(avatar(2))];
    expect(first.className).toMatch(/^jx-[0-9a-f]{10} div-comment-avatar$/);
    expect(second.className).toMatch(/^jx-[0-9a-f]{10} div-comment-avatar$/);
    expect(first.className?.split(" ")[0]).not.toBe(second.className?.split(" ")[0]);
  });

  test("the same style always gets the same class", () => {
    expect(one(avatar(1)).className).toBe(one(avatar(1)).className);
  });

  test("no class or an id needs none, and scopeStyle: false turns it off", () => {
    expect(one(`<div style="color:red"></div>`).className).toBeUndefined();
    expect(one(`<div id="x" class="a" style="color:red"></div>`).className).toBe("a");
    expect(one(avatar(1), { scopeStyle: false }).className).toBe("div-comment-avatar");
    expect(one(`<div class="a">x</div>`).className).toBe("a");
  });

  test("an id that is not a CSS identifier keeps the style inline: `#id` would not be a selector", () => {
    // ap: a Cwicly token still in an id. The build writes `#cancel-comment-reply-link{idadd}`, which
    // no browser reads as a rule, so the button the style hides would show.
    expect(
      one(
        `<button id="cancel-comment-reply-link{idadd}" class="button-cancel" style="display:none;">cancel</button>`,
      ),
    ).toEqual({
      tagName: "button",
      id: "cancel-comment-reply-link{idadd}",
      className: "button-cancel",
      attributes: { style: "display:none;" },
      textContent: "cancel",
    });
    expect(one(`<div id="1st" style="color:red">x</div>`).attributes).toEqual({
      style: "color:red",
    });
    expect(one(`<div id="a.b" class="c" style="color:red">x</div>`).style).toBeUndefined();
    expect(one(`<div id="menu-item-5" style="color:red">x</div>`).style).toEqual({ color: "red" });
  });

  test("so does a first class that is not one, when nothing scopes it", () => {
    const html = `<div class="w-1/2 b" style="color:red">x</div>`;
    expect(one(html, { scopeStyle: false })).toEqual({
      tagName: "div",
      className: "w-1/2 b",
      attributes: { style: "color:red" },
      textContent: "x",
    });
    expect(one(html).style).toEqual({ color: "red" });
  });

  test("inlineStyle: attribute leaves every style where the source had it", () => {
    expect(
      one(`<p class="has-text-align-center" style="font-size:1.2em;color:red !important">x</p>`, {
        inlineStyle: "attribute",
      }),
    ).toEqual({
      tagName: "p",
      className: "has-text-align-center",
      attributes: { style: "font-size:1.2em;color:red !important" },
      textContent: "x",
    });
  });
});

describe("an id used more than once", () => {
  // The build writes an element's own style to `#id`, and a selector matches every element with the
  // id, so two elements that share one and differ in style would all get the last rule written.
  const red = `<div id="card" style="color:rgb(255,0,0)">a</div>`;
  const blue = `<div id="card" style="color:rgb(0,0,255)">b</div>`;

  test("keeps each of their styles as an attribute, and says so", () => {
    const report = collect();
    const nodes = htmlToNodes(red + blue, { report, where: "post:3" });
    expect(nodes).toEqual([
      { tagName: "div", id: "card", attributes: { style: "color:rgb(255,0,0)" }, textContent: "a" },
      { tagName: "div", id: "card", attributes: { style: "color:rgb(0,0,255)" }, textContent: "b" },
    ]);
    expect(report.all).toHaveLength(1);
    expect(report.all[0]).toMatchObject({
      code: "html.id-duplicate",
      severity: "info",
      where: "post:3",
      data: { id: "card", count: 2 },
    });
  });

  test("an unstyled twin counts: a rule on the id would restyle it", () => {
    expect(htmlToNodes(`<div id="a" style="color:red">x</div><p id="a">y</p>`)).toEqual([
      { tagName: "div", id: "a", attributes: { style: "color:red" }, textContent: "x" },
      { tagName: "p", id: "a", textContent: "y" },
    ]);
  });

  test("so does a twin nested in another element, or inside markup the build writes as it is", () => {
    const nested = htmlToNodes(
      `<div id="a" style="color:red">x</div><section><p id="a">y</p></section>`,
    ) as JxElement[];
    expect(nested[0]?.attributes).toEqual({ style: "color:red" });
    expect(nested[0]?.style).toBeUndefined();
    const raw = htmlToNodes(
      `<div id="g" style="fill:red">x</div><svg><linearGradient id="g"></linearGradient></svg>`,
    ) as JxElement[];
    expect(raw[0]?.attributes).toEqual({ style: "fill:red" });
    expect(raw[1]?.innerHTML).toBe(`<linearGradient id="g"></linearGradient>`);
  });

  test("an id used once, in a fragment where another is repeated, still gets its style as a rule", () => {
    const nodes = htmlToNodes(
      `<div id="one" style="color:red">a</div><div id="two" style="color:blue">b</div><i id="two"></i>`,
    ) as JxElement[];
    expect(nodes[0]?.style).toEqual({ color: "red" });
    expect(nodes[1]?.attributes).toEqual({ style: "color:blue" });
  });

  test("ids are compared as written, and an empty id is none", () => {
    const nodes = htmlToNodes(
      `<p id="A" style="color:red">a</p><p id="a" style="color:blue">b</p><p id="" style="top:1px">c</p><p id="" style="top:2px">d</p>`,
    ) as JxElement[];
    expect(nodes.map((n) => n.style)).toEqual([
      { color: "red" },
      { color: "blue" },
      { top: "1px" },
      { top: "2px" },
    ]);
  });

  test("with inlineStyle: attribute there is nothing to decide, and nothing to report", () => {
    const report = collect();
    htmlToNodes(red + blue, { report, inlineStyle: "attribute" });
    expect(report.all).toEqual([]);
  });

  test("an element with an id of its own and no style costs its twin nothing", () => {
    expect(one(`<div id="menu-item-5" style="color:red">x</div>`).style).toEqual({ color: "red" });
    expect(htmlToNodes(`<p id="x">a</p><p id="x">b</p>`)).toEqual([
      { tagName: "p", id: "x", textContent: "a" },
      { tagName: "p", id: "x", textContent: "b" },
    ]);
  });
});

describe("whitespace", () => {
  test("collapses runs of whitespace to one space", () => {
    expect(one(`<p>a  b\n\t c</p>`).textContent).toBe("a b c");
    // fineline: a paragraph the editor wrapped at 80 columns.
    expect(
      one(`<p>My desire for this blog is that\nGod would receive all the glory.</p>`).textContent,
    ).toBe("My desire for this blog is that God would receive all the glory.");
  });

  test("leaves a no-break space alone, and decodes entities", () => {
    expect(one(`<p>a&nbsp;&nbsp;b &amp; c &#8217;d&ldquo;</p>`).textContent).toBe("a  b & c ’d“");
    expect(one(`<p>&nbsp;Ready to protect&nbsp;</p>`).textContent).toBe(" Ready to protect ");
  });

  test("drops whitespace between block elements, and at the start and end of any element", () => {
    // fineline: a list as the editor saved it, blank lines between the items.
    const list = one(
      `<ul class="wp-block-list">\n<li>Protect&nbsp;</li>\n\n\n\n<li>Give a finish</li>\n</ul>`,
    );
    expect(list).toEqual({
      tagName: "ul",
      className: "wp-block-list",
      children: [
        { tagName: "li", textContent: "Protect " },
        { tagName: "li", textContent: "Give a finish" },
      ],
    });
    expect(one(`<p>  \n a b \n </p>`).textContent).toBe("a b");
    expect(one(`<div> <p>x</p> </div>`).children).toEqual([{ tagName: "p", textContent: "x" }]);
    expect(htmlToNodes(`\n <p>a</p> \n <p>b</p>\n`)).toHaveLength(2);
  });

  test("keeps one space between inline siblings", () => {
    expect(one(`<p><a>x</a> <b>y</b></p>`).children).toEqual([
      { tagName: "a", textContent: "x" },
      " ",
      { tagName: "b", textContent: "y" },
    ]);
    // anabaptistperspectives: two links of a paragraph, a single space between them.
    const { children } = one(
      `<p><a href="/essay">Part 1</a> <a href="#note2context" class="ek-link">Return to context</a></p>`,
    );
    expect(children).toHaveLength(3);
    expect((children as JxNode[])[1]).toBe(" ");
  });

  test("one space where a space ends one inline and starts the next", () => {
    expect(one(`<p>foo <b> bar</b></p>`).children).toEqual([
      "foo ",
      { tagName: "b", textContent: "bar" },
    ]);
    expect(one(`<p><b>foo </b> bar</p>`).children).toEqual([
      { tagName: "b", textContent: "foo " },
      "bar",
    ]);
  });

  test("keeps a space inside an inline element that separates its neighbours", () => {
    // As children the build's separator would land in front of the element's own space and win it,
    // moving the space out of the element, so the markup is kept as it is.
    expect(one(`<p>foo<a> </a>bar</p>`).innerHTML).toBe("foo<a> </a>bar");
    // anabaptistperspectives: a link whose text starts with the space after the word before it.
    expect(one(`<h3>Why<a href="/x"> Painting</a></h3>`).innerHTML).toBe(
      `Why<a href="/x"> Painting</a>`,
    );
  });

  test("a space before a line break or a block, and after one, is not text", () => {
    expect(one(`<p>a <br> b</p>`).children).toEqual(["a", { tagName: "br" }, "b"]);
    expect(one(`<p>a <b>b </b></p>`).children).toEqual(["a ", { tagName: "b", textContent: "b" }]);
    expect(one(`<div>text <div>block</div> more</div>`).children).toEqual([
      "text",
      { tagName: "div", textContent: "block" },
      "more",
    ]);
  });

  test("a q draws quotation marks, so a space at its edge is not at a line edge", () => {
    expect(one(`<p><q> a </q></p>`).children).toEqual([{ tagName: "q", textContent: " a " }]);
    expect(one(`<p>x <q> a </q> y</p>`).children).toEqual([
      "x ",
      { tagName: "q", textContent: " a " },
      " y",
    ]);
    expect(one(`<q style="display:block"> a </q>`).textContent).toBe(" a ");
    // The same two inline siblings as anywhere else: the separator would show.
    const inner = one(`<p><q><b>a</b><i>b</i></q></p>`).children as JxElement[];
    expect(inner[0]?.innerHTML).toBe("<b>a</b><i>b</i>");
  });

  test("an out-of-flow element separates nothing", () => {
    expect(one(`<p>foo <span style="float:right">x</span> bar</p>`).children).toEqual([
      "foo ",
      { tagName: "span", style: { float: "right" }, textContent: "x" },
      "bar",
    ]);
    expect(one(`<p>foo<span style="position:absolute">x</span>bar</p>`).innerHTML).toBe(
      `foo<span style="position:absolute">x</span>bar`,
    );
  });

  test("trims inside a button and keeps a space between two", () => {
    expect(one(`<button> Go </button>`).textContent).toBe("Go");
    expect(htmlToNodes(`<button>a</button> <button>b</button>`)).toHaveLength(3);
  });

  test("keeps whitespace in pre, textarea, and an element styled white-space: pre", () => {
    expect(one(`<pre>  a\n   b\n</pre>`).textContent).toBe("  a\n   b\n");
    expect(one(`<textarea>  x\n  y </textarea>`).textContent).toBe("  x\n  y ");
    const node = one(`<pre><code>  a  \n  b</code></pre>`);
    expect(node.children).toEqual([{ tagName: "code", textContent: "  a  \n  b" }]);
    expect(one(`<p style="white-space:pre-wrap">a  b\n</p>`).textContent).toBe("a  b\n");
    // fineline's one preformatted block holds only inline markup.
    expect(
      one(
        `<pre class="wp-block-preformatted"><em><span style="font-weight: 400;">With my parents</span></em></pre>`,
        { scopeStyle: false },
      ),
    ).toEqual({
      tagName: "pre",
      className: "wp-block-preformatted",
      children: [
        {
          tagName: "em",
          children: [
            { tagName: "span", style: { fontWeight: "400" }, textContent: "With my parents" },
          ],
        },
      ],
    });
  });

  test("does not render what is not rendered: a hidden element does not separate its neighbours", () => {
    // Cwicly schema markup: a <meta> between the title and the text.
    expect(one(`<p>a <meta itemprop="x" content="y"> b</p>`).children).toEqual([
      "a ",
      { tagName: "meta", attributes: { itemprop: "x", content: "y" } },
      "b",
    ]);
  });
});

describe("content carriers", () => {
  test("a lone string is textContent, a lone element is children, nothing is neither", () => {
    expect(one(`<p>x</p>`)).toEqual({ tagName: "p", textContent: "x" });
    expect(one(`<p><b>x</b></p>`)).toEqual({
      tagName: "p",
      children: [{ tagName: "b", textContent: "x" }],
    });
    expect(one(`<p></p>`)).toEqual({ tagName: "p" });
    expect(one(`<p> \n </p>`)).toEqual({ tagName: "p" });
  });

  test("strings and elements mix in children", () => {
    expect(one(`<p>Hello <em>big</em> world</p>`).children).toEqual([
      "Hello ",
      { tagName: "em", textContent: "big" },
      " world",
    ]);
  });

  test("comments are dropped, and the text around one is one string", () => {
    expect(
      htmlToNodes(`<!-- Google Tag Manager (noscript) --><p>a<!-- x -->b</p><!-- y -->`),
    ).toEqual([{ tagName: "p", textContent: "ab" }]);
  });

  test("void elements have no content", () => {
    for (const html of [
      `<br>`,
      `<hr>`,
      `<img src="x">`,
      `<input type="text">`,
      `<source src="x">`,
    ]) {
      const node = one(html);
      expect(node.children).toBeUndefined();
      expect(node.textContent).toBeUndefined();
      expect(node.innerHTML).toBeUndefined();
    }
  });

  test("a template's content is its children", () => {
    expect(one(`<template><b>t</b></template>`)).toEqual({
      tagName: "template",
      children: [{ tagName: "b", textContent: "t" }],
    });
  });

  test("table parts parse as table parts, and the implied tbody is real", () => {
    expect(htmlToNodes(`<tr><td>a</td><td>b</td></tr>`)).toEqual([
      {
        tagName: "tr",
        children: [
          { tagName: "td", textContent: "a" },
          { tagName: "td", textContent: "b" },
        ],
      },
    ]);
    expect(one(`<table><tr><td>x</td></tr></table>`).children).toEqual([
      {
        tagName: "tbody",
        children: [{ tagName: "tr", children: [{ tagName: "td", textContent: "x" }] }],
      },
    ]);
  });

  test("script and style hold their text verbatim in innerHTML, not textContent", () => {
    // The static build HTML-escapes textContent, which is wrong for raw-text elements.
    const js = `if (a < b && c > d) { x = "q"; }`;
    expect(one(`<script>${js}</script>`)).toEqual({ tagName: "script", innerHTML: js });
    expect(one(`<style>a > b { content: "x" }</style>`)).toEqual({
      tagName: "style",
      innerHTML: `a > b { content: "x" }`,
    });
    expect(one(`<script type="application/ld+json" async>{"a":"A & B"}</script>`)).toEqual({
      tagName: "script",
      attributes: { type: "application/ld+json", async: "" },
      innerHTML: `{"a":"A & B"}`,
    });
    expect(one(`<script src="/x.js" defer></script>`)).toEqual({
      tagName: "script",
      attributes: { src: "/x.js", defer: "" },
    });
  });

  test("noscript content is converted, not kept as text", () => {
    expect(one(`<noscript><img src="x" alt=""></noscript>`)).toEqual({
      tagName: "noscript",
      children: [{ tagName: "img", attributes: { src: "x", alt: "" } }],
    });
  });
});

describe("svg", () => {
  // Heroicons-style: what an icon library emits. The attribute names are what must survive.
  const icon =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.5" class="icon  size-6" style="display:block">` +
    `<!-- generator --><use xlink:href="#a"/><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>` +
    `<foreignObject width="1" height="1"><p>x &amp; y</p></foreignObject></svg>`;

  test("a root becomes its attributes plus its children's markup as innerHTML", () => {
    expect(one(icon, { scopeStyle: false })).toEqual({
      tagName: "svg",
      className: "icon size-6",
      style: { display: "block" },
      attributes: {
        xmlns: "http://www.w3.org/2000/svg",
        "xmlns:xlink": "http://www.w3.org/1999/xlink",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.5",
      },
      innerHTML:
        `<use xlink:href="#a"></use><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"></path>` +
        `<foreignObject width="1" height="1"><p>x &amp; y</p></foreignObject>`,
    });
  });

  test("a real icon from the fineline header keeps its markup", () => {
    const real = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><path fill="unset" d="M26.297 12.625l-11.594 11.578c-0.391 0.391-1.016 0.391-1.406 0l-11.594-11.578"/></svg>`;
    expect(one(real)).toEqual({
      tagName: "svg",
      attributes: { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 28 28" },
      innerHTML: `<path fill="unset" d="M26.297 12.625l-11.594 11.578c-0.391 0.391-1.016 0.391-1.406 0l-11.594-11.578"/>`,
    });
  });

  test("the markup between the tags is the source's own, unless it has a comment or a literal ${", () => {
    const body = `<path d="M0 0" stroke-width='2'/><g><circle r="1" /></g>`;
    expect(one(`<svg viewBox="0 0 1 1">${body}</svg>`).innerHTML).toBe(body);
    // A comment is dropped here as everywhere, and a literal needs its character reference.
    expect(one(`<svg><!-- c --><path d="M0 0"/></svg>`).innerHTML).toBe(`<path d="M0 0"></path>`);
    expect(one(`<svg><text>\${a}</text></svg>`).innerHTML).toBe(`<text>&#36;{a}</text>`);
    // No end tag, so no end to slice to.
    expect(one(`<svg><path d="M0 0"/>`).innerHTML).toBe(`<path d="M0 0"></path>`);
  });

  test("an empty root has no innerHTML", () => {
    expect(one(`<svg viewBox="0 0 1 1"></svg>`)).toEqual({
      tagName: "svg",
      attributes: { viewBox: "0 0 1 1" },
    });
  });

  test("svg: tree converts the elements, with real attribute names and namespaced attributes", () => {
    const node = one(icon, { svg: "tree", scopeStyle: false });
    expect(node.innerHTML).toBeUndefined();
    expect(node.attributes).toMatchObject({ viewBox: "0 0 24 24", "stroke-width": "1.5" });
    const [use, path, foreign] = node.children as JxElement[];
    expect(use).toEqual({ tagName: "use", attributes: { "xlink:href": "#a" } });
    expect(path).toEqual({
      tagName: "path",
      attributes: {
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        d: "M4.5 12.75l6 6 9-13.5",
      },
    });
    // foreignObject keeps its camelCase name and its HTML children are HTML again.
    expect(foreign).toEqual({
      tagName: "foreignObject",
      attributes: { width: "1", height: "1" },
      children: [{ tagName: "p", textContent: "x & y" }],
    });
  });

  test("svg: tree drops whitespace between shapes but not inside text", () => {
    const node = one(`<svg>\n  <g>\n    <text>a  <tspan>b</tspan> c</text>\n  </g>\n</svg>`, {
      svg: "tree",
    });
    expect(node.children).toEqual([
      {
        tagName: "g",
        children: [
          {
            tagName: "text",
            children: ["a ", { tagName: "tspan", textContent: "b" }, " c"],
          },
        ],
      },
    ]);
  });

  test("an svg inside text does not make the text a gap", () => {
    // Hand-written: an icon followed by its label, with the space the source had.
    const link = one(`<a href="/x"><svg viewBox="0 0 1 1"></svg> Services</a>`);
    expect(link.children).toHaveLength(2);
  });

  test("math roots are kept as markup too", () => {
    expect(one(`<p><math><mi>x</mi></math></p>`).children).toEqual([
      { tagName: "math", innerHTML: "<mi>x</mi>" },
    ]);
  });
});

describe("a literal ${ in content", () => {
  test("escapeTemplate is the one from jx-util", () => {
    expect(escapeTemplate("a ${b}")).toBe("a &#36;{b}");
  });

  test("text holding one makes its element carry innerHTML with a character reference", () => {
    expect(one(`<p>Pay \${amount} now</p>`)).toEqual({
      tagName: "p",
      innerHTML: "Pay &#36;{amount} now",
    });
    expect(one(`<p>Pay \${a} <b>now</b> &amp; \${b}</p>`)).toEqual({
      tagName: "p",
      innerHTML: "Pay &#36;{a} <b>now</b> &amp; &#36;{b}",
    });
  });

  test("an attribute value holding one makes the parent carry the element as innerHTML", () => {
    const node = one(`<div class="box"><a title="\${x}" href="/y?q=\${z}">link</a> <b>t</b></div>`);
    expect(node).toEqual({
      tagName: "div",
      className: "box",
      innerHTML: `<a title="&#36;{x}" href="/y?q=&#36;{z}">link</a> <b>t</b>`,
    });
  });

  test("nothing in the output is a template", () => {
    const html = `<div class="box"><p>\${a}</p><a title="\${x}">l</a><ul><li data-t="\${t}">\${u}</li></ul></div>`;
    const walk = (n: JxNode): boolean => {
      if (typeof n === "string") return isBinding(n);
      const own = [n.textContent, n.className, n.id, ...Object.values(n.attributes ?? {})];
      return (
        own.some((v) => isBinding(v)) ||
        isBinding(Object.values(n.style ?? {}).join(" ")) ||
        (Array.isArray(n.children) && n.children.some(walk))
      );
    };
    expect(htmlToNodes(html).some(walk)).toBe(false);
  });

  test("a top-level node that holds one is wrapped in an element that lays out as nothing", () => {
    const report = collect();
    const nodes = htmlToNodes(`<div title="\${x}">y</div> \${z}`, { report });
    expect(nodes).toEqual([
      {
        tagName: "div",
        style: { display: "contents" },
        innerHTML: `<div title="&#36;{x}">y</div>`,
      },
      { tagName: "span", style: { display: "contents" }, innerHTML: "&#36;{z}" },
    ]);
    expect(report.all.map((e) => e.code)).toEqual([
      "html.template-wrapped",
      "html.template-wrapped",
    ]);
  });

  test("htmlToContent puts it in the parent instead of wrapping it", () => {
    expect(htmlToContent(`Pay \${amount} <b>now</b>`)).toEqual({
      innerHTML: "Pay &#36;{amount} <b>now</b>",
    });
  });

  test("a literal in script or style cannot be escaped and is reported as an error", () => {
    const report = collect();
    const node = one("<script>console.log(`x ${a} y`)</script>", { report });
    expect(node.innerHTML).toBe("console.log(`x ${a} y`)");
    expect(report.all).toHaveLength(1);
    expect(report.all[0]).toMatchObject({ code: "html.template-raw-text", severity: "error" });
  });

  test("raw text inside a raw-serialised parent is left alone", () => {
    const node = one(
      `<div><p title="\${x}">t</p><style>.a::before { content: "\${" }</style></div>`,
    );
    expect(node.innerHTML).toBe(
      `<p title="&#36;{x}">t</p><style>.a::before { content: "\${" }</style>`,
    );
  });

  test("a $ and a { that a comment separated are adjacent once it is gone, and escaped", () => {
    expect(one(`<p>$<!-- c -->{x} <b>y</b></p>`).innerHTML).toBe("&#36;{x} <b>y</b>");
    expect(one(`<p>a$<!-- c -->{x}</p>`)).toEqual({ tagName: "p", innerHTML: "a&#36;{x}" });
  });

  test("a newline that starts a pre is written twice, whatever protected it in the source", () => {
    // The newline after <pre><!-- c --> is real text; once the comment is gone it would be the one
    // the parser throws away.
    expect(one(`<pre><!-- c -->\n<b>a</b><i>b</i></pre>`).innerHTML).toBe("\n\n<b>a</b><i>b</i>");
    // As the pre's own innerHTML (here because of the literal), the host is a pre.
    const node = one(`<pre><!-- c -->\n<b>a</b>x${"${"}y</pre>`);
    expect(node).toEqual({ tagName: "pre", innerHTML: "\n\n<b>a</b>x&#36;{y" });
    // Inside another element's markup it is the same rule, written out.
    expect(one(`<div>\${a} <pre>\n\nx</pre></div>`).innerHTML).toBe("&#36;{a} <pre>\n\nx</pre>");
  });

  test("a $ and a { that are not adjacent are ordinary text", () => {
    expect(one(`<p>$5 {sale} $ {x}</p>`).textContent).toBe("$5 {sale} $ {x}");
    expect(one(`<p>{postexcerpt=75} \${</p>`).innerHTML).toBe("{postexcerpt=75} &#36;{");
  });
});

describe("the build's gap between inline siblings", () => {
  test("an element whose children would show a space holds its content as innerHTML", () => {
    // fineline: a price list item. Children would render `Low-end : $450`.
    expect(one(`<li><strong>Low-end</strong>: $450 - $600</li>`)).toEqual({
      tagName: "li",
      innerHTML: "<strong>Low-end</strong>: $450 - $600",
    });
    expect(one(`<p>word<sup>1</sup> and<em>it</em></p>`).innerHTML).toBe(
      "word<sup>1</sup> and<em>it</em>",
    );
    expect(one(`<p><a href="/x">a</a><a href="/y">b</a></p>`).innerHTML).toBe(
      `<a href="/x">a</a><a href="/y">b</a>`,
    );
    expect(one(`<p><img src="a"><img src="b"></p>`).innerHTML).toBe(`<img src="a"><img src="b">`);
  });

  test("keeps the markup exact, including attributes and nested elements", () => {
    const node = one(
      `<h3><a href="/x?a=1&amp;b=2" class="k">Learn</a> Brick Paint<a href="/y">!</a></h3>`,
    );
    expect(node.innerHTML).toBe(
      `<a href="/x?a=1&amp;b=2" class="k">Learn</a> Brick Paint<a href="/y">!</a>`,
    );
  });

  test("writes an angle bracket in an attribute value as a character reference, as the compiler does", () => {
    // Jx's image pass finds an `<img>` in an innerHTML string with `/<img\b([^>]*)>/`, which ends the
    // tag at the first `>` even inside a quoted value: `alt="Q&A -> answers"` would be cut in two.
    expect(
      one(
        `<p><img src="/a.jpg" alt="Q&amp;A -&gt; answers &lt;b&gt;"><img src="/b.jpg" alt="plain"></p>`,
      ).innerHTML,
    ).toBe(
      `<img src="/a.jpg" alt="Q&amp;A -&gt; answers &lt;b&gt;"><img src="/b.jpg" alt="plain">`,
    );
    // Text was always escaped.
    expect(one(`<p><b>1 &lt; 2</b> &gt; 0<i>x</i></p>`).innerHTML).toBe(
      `<b>1 &lt; 2</b> &gt; 0<i>x</i>`,
    );
    // The markup between an svg's tags is the source's own, unless the source could cut an img in two.
    expect(one(`<svg><foreignObject><img alt="a>b"></foreignObject></svg>`).innerHTML).toBe(
      `<foreignObject><img alt="a&gt;b"></foreignObject>`,
    );
    expect(one(`<svg><path d="M0 0" data-x="a>b"/></svg>`).innerHTML).toBe(
      `<path d="M0 0" data-x="a>b"/>`,
    );
  });

  test("a space on either side, a break, or a block makes the gap invisible", () => {
    expect(one(`<p>word <sup>1</sup></p>`).children).toBeDefined();
    expect(one(`<p><b>a</b> text</p>`).children).toBeDefined();
    expect(one(`<p><b>a </b>text</p>`).children).toBeDefined();
    expect(one(`<p><b>a</b><br><b>b</b></p>`).children).toBeDefined();
    expect(one(`<div><b>a</b><p>b</p>c</div>`).children).toBeDefined();
    expect(one(`<p><b>a</b> <i>b</i></p>`).children).toBeDefined();
  });

  test("a space that starts an inline element after something visible is not a space to the build", () => {
    // The separator comes first and wins the space: it ends up outside the element.
    expect(one(`<p>word<sup> 1</sup></p>`).innerHTML).toBe("word<sup> 1</sup>");
    expect(one(`<p><b>a</b><i> b</i></p>`).innerHTML).toBe("<b>a</b><i> b</i>");
  });

  test("an empty inline element is still something: an icon font draws it", () => {
    expect(one(`<a>Home<i class="icon"></i></a>`).innerHTML).toBe(`Home<i class="icon"></i>`);
    expect(one(`<a>Home <i class="icon"></i></a>`).children).toBeDefined();
  });

  test("a flex or grid container does not care", () => {
    const node = one(`<div style="display:flex"><span>a</span><span>b</span></div>`);
    expect(node.children).toHaveLength(2);
    expect(node.innerHTML).toBeUndefined();
  });

  test("inlineGaps: children keeps structured children and accepts the gap", () => {
    expect(one(`<li><strong>Low-end</strong>: $450</li>`, { inlineGaps: "children" })).toEqual({
      tagName: "li",
      children: [{ tagName: "strong", textContent: "Low-end" }, ": $450"],
    });
  });

  test("a preformatted element has no separators to fear", () => {
    expect(one(`<pre><b>a</b>b</pre>`).children).toBeDefined();
  });

  test("an element styled white-space: pre outside a pre tag has no safe boundary", () => {
    const node = one(`<p style="white-space:pre-wrap">a<b>b</b></p>`);
    expect(node.innerHTML).toBe("a<b>b</b>");
  });

  test("htmlToContent decides for the element the nodes are going into", () => {
    expect(htmlToContent(`Hello <em>world</em>!`)).toEqual({ innerHTML: "Hello <em>world</em>!" });
    expect(htmlToContent(`Hello <em>world</em> !`)).toEqual({
      children: ["Hello ", { tagName: "em", textContent: "world" }, " !"],
    });
    expect(htmlToContent(`Just text`)).toEqual({ textContent: "Just text" });
    expect(htmlToContent(`  `)).toEqual({});
    expect(htmlToContent(`<p>a</p><p>b</p>`)).toEqual({
      children: [
        { tagName: "p", textContent: "a" },
        { tagName: "p", textContent: "b" },
      ],
    });
    expect(htmlToContent(`<b>x</b>.`, { inlineGaps: "children" })).toEqual({
      children: [{ tagName: "b", textContent: "x" }, "."],
    });
  });
});

describe("what shows in a line, and what does not", () => {
  // Each of these is a place where the build's separator between siblings would show or not, so the
  // model of a line must get the element's display right. They are pinned one rule at a time: a
  // wrong rule changes one case and nothing else, so the real pages do not notice it.

  test("a quotation mark is drawn at the edge of a q, so a space inside the edge is not at a line edge", () => {
    expect(one(`<p><q>y </q>z</p>`).innerHTML).toBe("<q>y </q>z");
    expect(one(`<p>a<q> y</q></p>`).innerHTML).toBe("a<q> y</q>");
  });

  test("a hidden element is not rendered, and hidden=until-found is", () => {
    expect(one(`<p><b>x</b><span hidden>h</span></p>`).children).toEqual([
      { tagName: "b", textContent: "x" },
      { tagName: "span", attributes: { hidden: "" }, textContent: "h" },
    ]);
    expect(one(`<p><b>x</b><span hidden="until-found">h</span></p>`).innerHTML).toBe(
      `<b>x</b><span hidden="until-found">h</span>`,
    );
  });

  test("a closed dialog is not rendered and an open one is a block", () => {
    expect(one(`<div>a<dialog>b</dialog>c</div>`).innerHTML).toBe("a<dialog>b</dialog>c");
    expect(one(`<div>a<dialog open>b</dialog>c</div>`).children).toEqual([
      "a",
      { tagName: "dialog", attributes: { open: "" }, textContent: "b" },
      "c",
    ]);
  });

  test("a template is not rendered: it separates nothing, and its content is not part of the line", () => {
    expect(one(`<p>a <template>t</template> b</p>`).children).toEqual([
      "a ",
      { tagName: "template", textContent: "t" },
      "b",
    ]);
  });

  test("inline-block and inline-flex are one box to the line, display: contents is not a box at all", () => {
    expect(one(`<p>a<span style="display:inline-block">b</span>c</p>`).innerHTML).toBe(
      `a<span style="display:inline-block">b</span>c`,
    );
    expect(one(`<p>a<span style="display:contents">b</span>c</p>`).innerHTML).toBe(
      `a<span style="display:contents">b</span>c`,
    );
    // A flex container ignores the whitespace between its items, an inline one just as much.
    const flex = one(`<span style="display:inline-flex"><b>a</b><i>b</i></span>`);
    expect(flex.innerHTML).toBeUndefined();
    expect(flex.children).toHaveLength(2);
  });

  test("a button is one box to the line and lays out its own content", () => {
    expect(one(`<p>x <button> y </button> z</p>`).children).toEqual([
      "x ",
      { tagName: "button", textContent: "y" },
      " z",
    ]);
  });

  test("a pre-formatted element that holds no text separates nothing the line can see", () => {
    expect(
      one(`<p>a <span style="white-space:pre"></span> b</p>`, { inlineGaps: "children" }).children,
    ).toEqual(["a ", { tagName: "span", style: { whiteSpace: "pre" } }, "b"]);
    // With text in it, what follows the element is on the far side of something, so its space stays.
    expect(
      one(`<p>a <span style="white-space:pre"> x </span> b</p>`, { inlineGaps: "children" })
        .children,
    ).toEqual(["a ", { tagName: "span", style: { whiteSpace: "pre" }, textContent: " x " }, " b"]);
  });

  test("a wbr is a void element, written without an end tag", () => {
    expect(one(`<p>a<wbr>b</p>`).innerHTML).toBe("a<wbr>b");
  });

  test("a listing is preformatted like a pre", () => {
    expect(one(`<listing>  a\n   b</listing>`).textContent).toBe("  a\n   b");
  });

  test("an element inside a pre writes no separators either, however deep", () => {
    // The build adds none inside a pre, so the two siblings of the inner span need no guard.
    const pre = one(`<pre><span><b>a</b><i>b</i></span></pre>`);
    const [span] = pre.children as JxElement[];
    expect(span?.innerHTML).toBeUndefined();
    expect(span?.children).toEqual([
      { tagName: "b", textContent: "a" },
      { tagName: "i", textContent: "b" },
    ]);
  });

  test("an iframe's content is raw text, like a script's", () => {
    expect(one(`<iframe src="/x"><b>x</b> &amp;</iframe>`)).toEqual({
      tagName: "iframe",
      attributes: { src: "/x" },
      innerHTML: "<b>x</b> &amp;",
    });
  });

  test("the text of a script is not trimmed", () => {
    expect(one(`<script>\n x \n</script>`).innerHTML).toBe("\n x \n");
  });

  test("an svg tree drops the whitespace between shapes, and keeps it inside a tspan", () => {
    const [g] = one(`<svg><g><path d="M0 0"/>\n<path d="M1 1"/></g></svg>`, { svg: "tree" })
      .children as JxElement[];
    expect(g?.children).toEqual([
      { tagName: "path", attributes: { d: "M0 0" } },
      { tagName: "path", attributes: { d: "M1 1" } },
    ]);
    const [text] = one(`<svg><text>x<tspan> </tspan>y</text></svg>`, {
      svg: "tree",
      inlineGaps: "children",
    }).children as JxElement[];
    expect(text?.children).toEqual(["x", { tagName: "tspan", textContent: " " }, "y"]);
  });

  test("a last child that is not rendered leaves the build's separator at the end of an inline element", () => {
    // `link<meta>` is built as `link\n  <meta>`: the newline is a space after the word, inside the
    // link, and it takes the place of the one that follows the link, so the link is a space wider.
    const link = one(`<p><a href="/x">link<meta itemprop="name" content="v"></a> text</p>`);
    const [a, text] = link.children as JxNode[];
    expect(text).toBe(" text");
    expect(a).toEqual({
      tagName: "a",
      attributes: { href: "/x" },
      innerHTML: `link<meta itemprop="name" content="v">`,
    });
    const underline = one(`<p><u>a <b>b</b><span hidden>h</span></u> c</p>`)
      .children as JxElement[];
    expect(underline[0]?.innerHTML).toBe(`a <b>b</b><span hidden="">h</span>`);
    // Floated out of the flow, an element is not part of the line either.
    const floated = one(`<p><a href="/x">link<span style="float:right">x</span></a> text</p>`);
    expect((floated.children as JxElement[])[0]?.innerHTML).toBe(
      `link<span style="float:right">x</span>`,
    );
  });

  test("a block, an atom and a flow that is not inline have no such edge", () => {
    // A block's last line ends at the block, and the trailing space of a block-level paragraph is dropped.
    expect(one(`<p>text<meta itemprop="x" content="y"></p>`).children).toEqual([
      "text",
      { tagName: "meta", attributes: { itemprop: "x", content: "y" } },
    ]);
    expect(one(`<button>go<meta itemprop="x" content="y"></button>`).children).toEqual([
      "go",
      { tagName: "meta", attributes: { itemprop: "x", content: "y" } },
    ]);
    // A hidden first child is covered by the boundary before the element, which already has a gap
    // if anything visible comes first, and none if a space or a break does.
    expect(one(`<p>foo <a href="/x"><meta itemprop="x" content="y">link</a></p>`).children).toEqual(
      [
        "foo ",
        {
          tagName: "a",
          attributes: { href: "/x" },
          children: [{ tagName: "meta", attributes: { itemprop: "x", content: "y" } }, "link"],
        },
      ],
    );
    expect(
      one(`<p>foo<a href="/x"><meta itemprop="x" content="y">link</a></p>`).innerHTML,
    ).toContain(`<meta itemprop="x" content="y">link`);
    // One child alone has no separator.
    expect(one(`<div><a href="/x"><meta itemprop="x" content="y"></a></div>`).children).toEqual([
      {
        tagName: "a",
        attributes: { href: "/x" },
        children: [{ tagName: "meta", attributes: { itemprop: "x", content: "y" } }],
      },
    ]);
  });

  test("a segment break next to a zero-width space or a wbr is removed, and a space beside it with it", () => {
    // CSS Text drops a segment break that touches U+200B, and Blink treats <wbr> as one, so the
    // build's separator is nothing there, and so is the space the source wrote next to it.
    expect(one(`<p>x&#8203; <b>y</b></p>`).innerHTML).toBe("x​ <b>y</b>");
    expect(one(`<p><b>y</b> &#8203;x</p>`).innerHTML).toBe("<b>y</b> ​x");
    expect(one(`<p><span>x<wbr></span> y</p>`).innerHTML).toBe("<span>x<wbr></span> y");
    expect(one(`<p>x <wbr><b>y</b></p>`).innerHTML).toBe("x <wbr><b>y</b>");
    // Beside a block or a break it is a line edge, as for any other character.
    expect(one(`<div>x&#8203;<p>y</p></div>`).children).toEqual([
      "x​",
      { tagName: "p", textContent: "y" },
    ]);
    expect(one(`<p>x&#8203;<br>y</p>`).children).toEqual(["x​", { tagName: "br" }, "y"]);
    // inlineGaps: children accepts every gap, this one too.
    expect(one(`<p>x&#8203; <b>y</b></p>`, { inlineGaps: "children" }).children).toEqual([
      "x​ ",
      { tagName: "b", textContent: "y" },
    ]);
  });
});

describe("degenerate input", () => {
  test("nothing, whitespace and comments convert to nothing", () => {
    expect(htmlToNodes("")).toEqual([]);
    expect(htmlToNodes(" \n\t ")).toEqual([]);
    expect(htmlToNodes("<!-- only a comment -->")).toEqual([]);
    expect(htmlToContent("")).toEqual({});
    expect(htmlToContent("<!-- c --> ")).toEqual({});
    expect(nodesToHtml([])).toBe("");
  });

  test("markup nested thousands deep is kept whole and reported, not a stack overflow", () => {
    // An unclosed <div> repeated by a plugin: browsers stop at 512 levels, so nothing real is deeper.
    const deep = "<div>".repeat(30_000) + "x";
    const report = collect();
    const nodes = htmlToNodes(deep, { report, where: "post:9" });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ tagName: "div", style: { display: "contents" } });
    expect((nodes[0] as JxElement).innerHTML).toBe(deep);
    expect(report.all).toHaveLength(1);
    expect(report.all[0]).toMatchObject({
      code: "html.too-deep",
      severity: "warn",
      where: "post:9",
    });
    expect(htmlToContent(deep)).toEqual({ innerHTML: deep });
    // parse5 itself takes over a second for each of the three parses (its open-element stack is
    // scanned for every tag), so the default five seconds is not enough under instrumentation.
  }, 60_000);

  test("a literal ${ in markup that deep is still escaped", () => {
    expect(htmlToContent("<span>".repeat(30_000) + "${x}")).toMatchObject({
      innerHTML: expect.stringContaining("&#36;{x}"),
    });
  }, 60_000);
});

describe("markup nested as deep as a browser nests it", () => {
  // Browsers stop building the tree at 512 levels. Jx's build overflows its stack at about 1,300
  // and `jx validate` at 39, so the converter must not hand it anything a browser would not have
  // built, and must not wait for its own recursion to run out to find out.
  const nest = (tag: string, depth: number, inner = "x"): string =>
    `<${tag}>`.repeat(depth) + inner + `</${tag}>`.repeat(depth);

  test("512 levels are converted as elements, with nothing reported", () => {
    const report = collect();
    const nodes = htmlToNodes(nest("div", 512), { report });
    expect(report.all).toEqual([]);
    let levels = 1;
    let node = nodes[0] as JxElement;
    while (Array.isArray(node.children)) {
      levels++;
      node = node.children[0] as JxElement;
    }
    expect(levels).toBe(512);
    expect(node.textContent).toBe("x");
  });

  test("513 levels are kept whole as markup and reported, however they are nested", () => {
    for (const html of [
      nest("div", 513),
      nest("span", 513),
      nest("div", 512, "<b>x</b>"),
      // A p would be closed by the first div inside it, so the chain would start over at the top.
      `<section>${nest("div", 512)}</section>`,
      `<svg>${"<g>".repeat(520)}</svg>`,
      `<template>${nest("b", 512)}</template>`,
    ]) {
      const report = collect();
      const nodes = htmlToNodes(html, { report, where: "post:7" });
      expect(nodes).toEqual([{ tagName: "div", style: { display: "contents" }, innerHTML: html }]);
      expect(report.all).toMatchObject([
        { code: "html.too-deep", severity: "warn", where: "post:7" },
      ]);
      expect(htmlToContent(html)).toEqual({ innerHTML: html });
    }
  });

  test("the depth is counted in elements, not in characters or text nodes", () => {
    const report = collect();
    htmlToNodes("<p>x</p>".repeat(2_000) + nest("em", 512, "y".repeat(5_000)), { report });
    expect(report.all).toEqual([]);
  });
});

describe("nodesToHtml", () => {
  test("renders className as class, attributes, flat style, text and children", () => {
    const html = nodesToHtml([
      {
        tagName: "a",
        id: "i",
        className: "a b",
        style: { marginTop: "1px", "--x": "2", ":hover": { color: "red" } },
        attributes: {
          href: "/x?a=1&b=2",
          "data-q": 'say "hi"',
          hidden: "",
          async: true,
          gone: false,
        },
        children: ["x < y", { tagName: "br" }, { tagName: "img", attributes: { src: "s" } }],
      },
    ]);
    expect(html).toBe(
      `<a id="i" class="a b" style="margin-top: 1px; --x: 2" href="/x?a=1&amp;b=2" data-q="say &quot;hi&quot;" hidden="" async>x &lt; y<br><img src="s"></a>`,
    );
  });

  test("escapes textContent, writes innerHTML and script text raw", () => {
    expect(
      nodesToHtml([
        { tagName: "p", textContent: "a & <b>" },
        { tagName: "p", innerHTML: "a &amp; <b>x</b>" },
        { tagName: "script", textContent: "if (a < b && c) {}" },
        { tagName: "style", children: ["a > b {}"] },
      ]),
    ).toBe(
      `<p>a &amp; &lt;b&gt;</p><p>a &amp; <b>x</b></p><script>if (a < b && c) {}</script><style>a > b {}</style>`,
    );
  });

  test("a leading newline in pre needs a second to survive a parse", () => {
    const html = nodesToHtml([{ tagName: "pre", textContent: "\nx" }]);
    expect(html).toBe("<pre>\n\nx</pre>");
    const text = (
      fromHtml(html, { fragment: true }).children[0] as { children: { value: string }[] }
    ).children[0]?.value;
    expect(text).toBe("\nx");
  });

  test("writes innerHTML as it is, so the second newline htmlToNodes put at the start of a pre is not doubled again", () => {
    // The text of `<pre>\n\nx</pre>` is "\nx" (the parser drops the first newline), and htmlToNodes
    // keeps it as markup with both newlines for the Jx emitter, which writes innerHTML verbatim.
    const text = (html: string): string => {
      const walk = (node: { value?: string; childNodes?: unknown[] }): string =>
        node.value ?? (node.childNodes ?? []).map((c) => walk(c as never)).join("");
      return walk(parseFragment(html) as never);
    };
    for (const html of [
      `<pre>\n\nx</pre>`,
      `<textarea>\n\nx</textarea>`,
      `<listing>\n\nx</listing>`,
      `<pre>\n\n<b>a</b></pre>`,
      `<pre>\n\n\nx</pre>`,
    ]) {
      const rendered = nodesToHtml(htmlToNodes(html));
      expect(rendered).toBe(html);
      expect(text(rendered)).toBe(text(html));
    }
    expect(nodesToHtml([{ tagName: "pre", innerHTML: "\n\nx" }])).toBe("<pre>\n\nx</pre>");
  });

  test("a leading newline in the text of a pre, textarea or listing still needs its second", () => {
    for (const tag of ["pre", "textarea", "listing"]) {
      expect(nodesToHtml([{ tagName: tag, textContent: "\nx" }])).toBe(`<${tag}>\n\nx</${tag}>`);
      expect(nodesToHtml([{ tagName: tag, children: ["\nx", { tagName: "b" }] }])).toBe(
        `<${tag}>\n\nx<b></b></${tag}>`,
      );
    }
    // And no other element's.
    expect(nodesToHtml([{ tagName: "div", textContent: "\nx" }])).toBe("<div>\nx</div>");
  });

  test("writes a false that the real emitter writes: enumerated attributes carry the word, not its presence", () => {
    // `jx build` writes `aria-hidden="false"` for a false and a bare `hidden` for a true; the other
    // way round, `draggable=""` or no `contenteditable` at all, means something else in HTML.
    expect(
      nodesToHtml([
        {
          tagName: "div",
          attributes: {
            "aria-hidden": false,
            "aria-expanded": true,
            draggable: false,
            contenteditable: false,
            spellcheck: true,
            disabled: true,
            async: false,
          },
        },
      ]),
    ).toBe(
      `<div aria-hidden="false" aria-expanded="true" draggable="false" contenteditable="false" spellcheck="true" disabled></div>`,
    );
  });

  test("writes tabindex, title, lang, dir and a style with numbers in it", () => {
    expect(
      nodesToHtml([
        {
          tagName: "p",
          tabIndex: 0,
          title: "t",
          lang: "fr",
          dir: "rtl",
          style: { opacity: 0, zIndex: 2, lineHeight: "1.5" },
          textContent: "x",
        },
      ]),
    ).toBe(
      `<p style="opacity: 0; z-index: 2; line-height: 1.5" tabindex="0" title="t" lang="fr" dir="rtl">x</p>`,
    );
  });

  test("defaults to div, and refuses a computed tag", () => {
    expect(nodesToHtml([{ textContent: "x" }])).toBe("<div>x</div>");
    expect(() =>
      nodesToHtml([
        { tagName: { $expression: { operator: "?:", target: 1, value: "a", initial: "b" } } },
      ]),
    ).toThrow("computed tagName");
  });

  test("is the inverse of htmlToNodes: parsing its output gives back the markup it was given", () => {
    const sources = [
      `<p class="a b" style="color:red;margin-top:1px">x <b>y</b> z</p>`,
      `<ul class="wp-block-list"><li>One</li><li><a href="/x?a=1&amp;b=2" target="_blank">Two</a></li></ul>`,
      `<figure class="wp-block-image size-large"><img src="https://x.test/a.jpeg" alt="a b" class="wp-image-2173"/></figure>`,
      `<table><tbody><tr><td><strong>Videos</strong></td><td>38</td></tr></tbody></table>`,
      `<form id="searchform" role="search" method="get" action="/"><input type="search" name="s" required></form>`,
    ];
    for (const source of sources) {
      const rendered = nodesToHtml(htmlToNodes(source, { scopeStyle: false }));
      expect(shape(rendered)).toEqual(shape(source));
    }
  });
});

/** Tag, attributes (class and style normalised) and collapsed text: enough to compare two parses. */
function shape(html: string): unknown {
  const walk = (node: { type: string; [key: string]: unknown }): unknown => {
    if (node.type === "text") return String(node.value).replaceAll(/\s+/g, " ");
    if (node.type !== "element") return null;
    const props = node.properties as Record<string, unknown>;
    const attrs = Object.entries(props)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(" ") : String(v)])
      .map(([k, v]) => [
        k,
        k === "style" ? v?.replaceAll(/\s*([:;])\s*/g, "$1").replace(/;$/, "") : v,
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    const kids = (node.children as { type: string }[]).map(walk).filter((c) => c !== null);
    return [node.tagName, attrs, kids];
  };
  return fromHtml(html, { fragment: true }).children.map((c) => walk(c as never));
}

describe("the attribute hook", () => {
  // A converter has to move media and links to where the Jx site has them. Two in five of the links
  // of real block markup end up inside an element's innerHTML, a string, so a rewrite that only
  // sees structured attributes (or a regular expression over the source) would miss them.
  type Hook = NonNullable<HtmlOptions["attribute"]>;
  const upload = /^https?:\/\/[^/]+\/wp-content\/uploads\//;
  const media: Hook = (_tag, name, value) =>
    name === "srcset" || name === "sizes" ? null : value.replace(upload, "/media/");

  test("is called for every attribute of every element, once, in document order", () => {
    const seen: string[] = [];
    htmlToNodes(
      `<div class="a" id="x"><a href="/y">t</a>u<b>v</b><svg><path d="M0 0"/></svg><template><i title="z"></i></template></div>`,
      {
        attribute: (tag, name, value) => {
          seen.push(`${tag}.${name}=${value}`);
          return undefined;
        },
      },
    );
    expect(seen).toEqual(["div.class=a", "div.id=x", "a.href=/y", "path.d=M0 0", "i.title=z"]);
  });

  test("names a namespaced attribute as the source wrote it", () => {
    const seen: string[] = [];
    const svg = one(
      `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="/old#a"/></svg>`,
      {
        svg: "tree",
        attribute: (tag, name, value) => {
          seen.push(`${tag}.${name}`);
          return name === "xlink:href" ? value.replace("/old", "") : value;
        },
      },
    );
    expect(seen).toEqual(["svg.xmlns:xlink", "use.xlink:href"]);
    expect((svg.children as JxElement[])[0]?.attributes).toEqual({ "xlink:href": "#a" });
  });

  test("is called once even when the element ends up inside markup written out afterwards", () => {
    const seen: string[] = [];
    // The p's content is held as innerHTML, which walks the same attributes again.
    htmlToNodes(`<p>a<a href="/y">b</a>c</p>`, {
      attribute: (_tag, name) => void seen.push(name),
    });
    expect(seen).toEqual(["href"]);
  });

  test("rewrites an attribute that stays an attribute, and the one inside a style", () => {
    const anywhere = /https?:\/\/[^/]+\/wp-content\/uploads\//g;
    const node = one(
      `<a href="https://x.test/wp-content/uploads/2023/a.pdf" data-n="1" style="background-image:url(https://x.test/wp-content/uploads/b.jpg)">t</a>`,
      {
        attribute: (_tag, name, value) =>
          name === "href" || name === "style" ? value.replace(anywhere, "/media/") : value,
      },
    );
    expect(node).toEqual({
      tagName: "a",
      attributes: { href: "/media/2023/a.pdf", "data-n": "1" },
      style: { backgroundImage: "url(/media/b.jpg)" },
      textContent: "t",
    });
  });

  test("rewrites the attributes of markup held as innerHTML, and of an svg's markup", () => {
    const raw = one(
      `<p>See <a href="https://x.test/wp-content/uploads/a.pdf">this</a>.<img src="https://x.test/wp-content/uploads/b.jpg" srcset="https://x.test/wp-content/uploads/b-2x.jpg 2x" sizes="50vw" alt="b"></p>`,
      { attribute: media },
    );
    expect(raw.innerHTML).toBe(
      `See <a href="/media/a.pdf">this</a>.<img src="/media/b.jpg" alt="b">`,
    );
    const svg = one(`<svg><image href="https://x.test/wp-content/uploads/c.png"/></svg>`, {
      attribute: media,
    });
    expect(svg.innerHTML).toBe(`<image href="/media/c.png"></image>`);
    // Without it the markup between the tags is the source's own.
    expect(one(`<svg><image href="/u/c.png"/></svg>`).innerHTML).toBe(`<image href="/u/c.png"/>`);
  });

  test("null drops an attribute, undefined leaves it, and the hook sees class, id and style too", () => {
    const node = one(`<img class="c" id="i" src="/a" srcset="/a 1x" sizes="10vw" alt="x">`, {
      attribute: (_tag, name) => (name === "srcset" || name === "sizes" ? null : undefined),
    });
    expect(node).toEqual({
      tagName: "img",
      id: "i",
      className: "c",
      attributes: { src: "/a", alt: "x" },
    });
    const renamed = one(`<p class="old" id="a">t</p>`, {
      attribute: (_tag, name, value) => (name === "class" ? value.replace("old", "new") : value),
    });
    expect(renamed.className).toBe("new");
    // Dropping the style attribute drops the style, and dropping the class takes the class.
    expect(
      one(`<p class="c" style="color:red">t</p>`, {
        attribute: (_tag, name) => (name === "style" || name === "class" ? null : undefined),
      }),
    ).toEqual({ tagName: "p", textContent: "t" });
  });

  test("a value with a literal ${ in it, once rewritten, is handled as any other", () => {
    expect(
      one(`<div><a href="/x" title="t">a</a> b</div>`, {
        attribute: (_tag, name, value) => (name === "title" ? "${y}" : value),
      }),
    ).toEqual({
      tagName: "div",
      innerHTML: `<a href="/x" title="&#36;{y}">a</a> b`,
    });
  });

  test("the ids it rewrites are the ones counted for a repeated id", () => {
    const nodes = htmlToNodes(
      `<div id="a" style="color:red">x</div><div id="b" style="color:blue">y</div>`,
      { attribute: (_tag, name, value) => (name === "id" ? "same" : value) },
    ) as JxElement[];
    expect(nodes.map((n) => n.attributes)).toEqual([
      { style: "color:red" },
      { style: "color:blue" },
    ]);
  });

  test("a hook that throws is not a reason to say the markup was too deep", () => {
    const attribute: Hook = () => {
      throw new Error("no way");
    };
    expect(() => htmlToNodes(`<p a="1">x</p>`, { attribute })).toThrow("no way");
    expect(() => htmlToContent(`<p a="1">x</p>`, { attribute })).toThrow("no way");
  });

  test("markup too deep to convert is kept as it was written, and the hook never sees it", () => {
    const seen: string[] = [];
    const html = `<div class="a">`.repeat(600) + "x";
    const report = collect();
    const nodes = htmlToNodes(html, { report, attribute: (_t, n) => void seen.push(n) });
    expect((nodes[0] as JxElement).innerHTML).toBe(html);
    expect(seen).toEqual([]);
    expect(report.all.map((e) => e.code)).toEqual(["html.too-deep"]);
  });

  test("without one, nothing about the output changes", () => {
    // (An svg's markup is the source's own without a hook, and written out from the tree with one.)
    const html = `<p class="a" style="color:red">x <b title="t">y</b></p><p>a<i>b</i></p>`;
    expect(htmlToNodes(html, { attribute: () => undefined })).toEqual(htmlToNodes(html));
    expect(htmlToNodes(html, { attribute: (_t, _n, value) => value })).toEqual(htmlToNodes(html));
  });
});

describe("target: markdown", () => {
  // `serializeJxMarkdown` is the one way the design allows a content entry to be written, and it
  // writes no `innerHTML`: an element that holds its content that way comes out empty, and nothing
  // says so. That is every element htmlToNodes keeps as markup to hide a gap the build would show.
  const AP = JSON.parse(readFileSync(join(FIXTURES, "ap/rows/posts.json"), "utf8")) as {
    ID: number;
    post_content: string;
  }[];
  const paragraphs = (): string[] => {
    const out: string[] = [];
    const walk = (blocks: ReturnType<typeof parseBlocks>): void => {
      for (const block of blocks) {
        if (block.blockName === "core/paragraph") out.push(block.innerHTML);
        walk(block.innerBlocks);
      }
    };
    walk(parseBlocks(AP.find((row) => row.ID === 738)?.post_content ?? ""));
    return out;
  };
  const words = (text: string): string => text.replaceAll(/\s+/g, " ").trim().normalize("NFC");
  const COLON_TAIL = /:[A-Za-z0-9]+/g;
  const textOf = (nodes: JxNode[]): string => {
    const walk = (node: JxNode): string => {
      if (typeof node === "string") return node;
      if (typeof node.textContent === "string") return node.textContent;
      return Array.isArray(node.children) ? node.children.map(walk).join(" ") : "";
    };
    return words(nodes.map(walk).join(" "));
  };
  const plain = (html: string): string => {
    const walk = (node: { value?: string; childNodes?: unknown[] }): string =>
      node.value ?? (node.childNodes ?? []).map((c) => walk(c as never)).join("");
    return words(walk(parseFragment(html) as never));
  };
  const entry = (nodes: JxNode[]): string =>
    serializeJxMarkdown({ children: nodes } as never, { mode: "roundtrip" });

  test("the serializer drops innerHTML, which is why the page target loses an essay's paragraphs", () => {
    // If this starts to fail, serializeJxMarkdown writes innerHTML and the markdown target is no
    // longer needed: the transpiler already reads `innerHTML=` as a directive attribute.
    expect(entry([{ tagName: "p", innerHTML: "Hello <b>bold</b>." }])).toBe("\n");
    const lost = paragraphs()
      .map((html) => htmlToNodes(html))
      .filter((nodes) => (nodes[0] as JxElement).innerHTML !== undefined);
    expect(lost.length).toBeGreaterThan(0);
    for (const nodes of lost) expect(words(entry(nodes))).toBe("");
  });

  test("keeps the content structured, so the real paragraphs of an essay come out of the serializer whole", () => {
    const source = paragraphs();
    expect(source.length).toBeGreaterThan(10);
    for (const html of source) {
      const nodes = htmlToNodes(html, { target: "markdown" });
      expect(JSON.stringify(nodes)).not.toContain("innerHTML");
      // (An empty paragraph is no entry content at all.)
      const back = (transpileJxMarkdown(entry(nodes)).children ?? []) as JxNode[];
      // Not the colon and what follows it: see the next test.
      expect(textOf(back).replaceAll(" ", "")).toBe(
        plain(html).replaceAll(COLON_TAIL, "").replaceAll(" ", ""),
      );
    }
  });

  test("the serializer loses a colon followed by a letter or digit, which is not this module's to mend", () => {
    // `John 19:26` is written as is, and `:26` is read back as a text directive named 26. It is in
    // the essay above. If this starts to fail, Jx escapes the colon and the exemption goes.
    const nodes = htmlToNodes(`<p>John 19:26 and 9:00 AM</p>`, { target: "markdown" });
    expect(textOf((transpileJxMarkdown(entry(nodes)).children ?? []) as JxNode[])).toBe(
      "John 19 and 9 AM",
    );
  });

  test("is the page target with inlineGaps: children and svg: tree, whatever those say", () => {
    const html = `<p>Hello <strong>bold</strong>.</p><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>`;
    expect(htmlToNodes(html, { target: "markdown" })).toEqual([
      {
        tagName: "p",
        children: ["Hello ", { tagName: "strong", textContent: "bold" }, "."],
      },
      {
        tagName: "svg",
        attributes: { viewBox: "0 0 1 1" },
        children: [{ tagName: "path", attributes: { d: "M0 0" } }],
      },
    ]);
    expect(htmlToNodes(html, { target: "markdown", inlineGaps: "raw", svg: "innerHTML" })).toEqual(
      htmlToNodes(html, { target: "markdown" }),
    );
    expect(htmlToNodes(html, { target: "page" })).toEqual(htmlToNodes(html));
    expect(htmlToContent(`Hello <b>bold</b>.`, { target: "markdown" })).toEqual({
      children: ["Hello ", { tagName: "b", textContent: "bold" }, "."],
    });
  });

  test("reports what still has to be markup, because the serializer will not write it", () => {
    const cases: [string, string, string][] = [
      [`<script>var a = 1;</script>`, "script", "raw-text"],
      [`<style>a { color: red }</style>`, "style", "raw-text"],
      [`<p>Pay \${amount}</p>`, "p", "template"],
      [`<pre>\n\nx</pre>`, "pre", "pre-newline"],
    ];
    for (const [html, tag, reason] of cases) {
      const report = collect();
      const node = one(html, {
        target: "markdown",
        report,
        where: "post:9",
        url: "https://x.test/",
      });
      expect(node.innerHTML).toBeDefined();
      expect(report.all.filter((e) => e.code === "html.innerhtml-unserialisable")).toEqual([
        {
          severity: "warn",
          code: "html.innerhtml-unserialisable",
          message: expect.stringContaining(`<${tag}>`),
          where: "post:9",
          url: "https://x.test/",
          data: { tag, reason },
        },
      ]);
      // On a page it is carried, and there is nothing to say.
      const page = collect();
      one(html, { report: page });
      expect(page.all.map((e) => e.code)).not.toContain("html.innerhtml-unserialisable");
    }
  });

  test("reports the same for the content of the element a caller is filling, and for markup too deep", () => {
    const report = collect();
    expect(htmlToContent(`Pay \${amount} now`, { target: "markdown", report })).toEqual({
      innerHTML: "Pay &#36;{amount} now",
    });
    const deep = "<div>".repeat(600);
    htmlToNodes(deep, { target: "markdown", report });
    htmlToContent(deep, { target: "markdown", report });
    expect(
      report.all.map((e) => [e.code, (e.data as { reason?: string } | undefined)?.reason]),
    ).toEqual([
      ["html.innerhtml-unserialisable", "template"],
      ["html.too-deep", undefined],
      ["html.innerhtml-unserialisable", "too-deep"],
      ["html.too-deep", undefined],
      ["html.innerhtml-unserialisable", "too-deep"],
    ]);
  });

  test("keeps every style an object: the serializer writes an attribute as a string Jx rejects", () => {
    // `attributes.style` comes back from serializeJxMarkdown as an element-level `style` string,
    // which `jx validate` refuses ("must be object"), so nothing here is kept as an attribute.
    const nodes = [{ tagName: "div", attributes: { style: "color:red" }, textContent: "a" }];
    const back = transpileJxMarkdown(entry(nodes as JxNode[])).children as JxElement[];
    expect(back[0]?.style as unknown).toBe("color:red");
    expect(
      one(`<p class="a" style="color:red">x</p>`, {
        target: "markdown",
        inlineStyle: "attribute",
        scopeStyle: false,
      }),
    ).toEqual({ tagName: "p", className: "a", style: { color: "red" }, textContent: "x" });
  });

  test("where a page keeps a style as an attribute, an entry keeps the object and warns", () => {
    const report = collect();
    const options = { target: "markdown", report, scopeStyle: false } as const;
    // A repeated id, a repeated property and an id that is not a selector.
    expect(
      htmlToNodes(
        `<div id="card" style="color:red">a</div><div id="card" style="color:blue">b</div>`,
        options,
      ),
    ).toEqual([
      { tagName: "div", id: "card", style: { color: "red" }, textContent: "a" },
      { tagName: "div", id: "card", style: { color: "blue" }, textContent: "b" },
    ]);
    expect(one(`<p class="a" style="width:100px;width:90px\\9">x</p>`, options)).toEqual({
      tagName: "p",
      className: "a",
      style: { width: "90px\\9" },
      textContent: "x",
    });
    expect(
      one(`<button id="cancel{idadd}" class="b" style="display:none">x</button>`, options),
    ).toEqual({
      tagName: "button",
      id: "cancel{idadd}",
      className: "b",
      style: { display: "none" },
      textContent: "x",
    });
    expect(report.all.map((e) => [e.severity, e.code])).toEqual([
      ["warn", "html.id-duplicate"],
      ["warn", "html.style-fallback"],
      ["warn", "html.style-selector"],
    ]);
    expect(report.all[2]).toMatchObject({
      data: { tag: "button", target: "cancel{idadd}" },
      message: expect.stringContaining("`#cancel{idadd}`"),
    });
    // On a page they are all attributes, and only said in passing.
    const page = collect();
    htmlToNodes(
      `<div id="card" style="color:red">a</div><div id="card" style="color:blue">b</div>`,
      { report: page },
    );
    expect(page.all.map((e) => e.severity)).toEqual(["info"]);
  });

  test("a literal ${ at the top of a fragment is wrapped, and reported as lost from an entry too", () => {
    const report = collect();
    htmlToNodes(`Pay \${amount}`, { target: "markdown", report });
    expect(report.all.map((e) => e.code)).toEqual([
      "html.template-wrapped",
      "html.innerhtml-unserialisable",
    ]);
  });
});

describe("the real pages", () => {
  const bodies: { name: string; html: string }[] = [];
  for (const site of ["fineline", "ap"]) {
    const dir = join(FIXTURES, site, "html");
    for (const file of readdirSync(dir)) {
      const html = readFileSync(join(dir, file), "utf8");
      bodies.push({
        name: `${site}/${file}`,
        html: html.slice(html.indexOf("<body"), html.lastIndexOf("</body>")),
      });
    }
  }

  test("every rendered page converts without throwing or reporting", () => {
    const report = collect();
    for (const { name, html } of bodies) {
      const nodes = htmlToNodes(html, { report, where: name });
      expect(nodes.length).toBeGreaterThan(0);
    }
    expect(report.all.filter((e) => e.severity === "error")).toEqual([]);
  });

  test("the output is plain Jx: no class, id or style under attributes, no kebab-case style keys", () => {
    const problems: string[] = [];
    const walk = (node: JxNode, name: string): void => {
      if (typeof node === "string") return;
      const attrs = node.attributes ?? {};
      for (const key of ["class", "id", "style"]) {
        if (key in attrs) problems.push(`${name}: attributes.${key}`);
      }
      for (const key of Object.keys(node.style ?? {})) {
        if (!key.startsWith("--") && key.includes("-")) problems.push(`${name}: style key ${key}`);
      }
      if (typeof node.tagName !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(node.tagName)) {
        problems.push(`${name}: tagName ${String(node.tagName)}`);
      }
      if (Array.isArray(node.children)) for (const child of node.children) walk(child, name);
    };
    for (const { name, html } of bodies) for (const node of htmlToNodes(html)) walk(node, name);
    expect(problems).toEqual([]);
  });

  test("conversion is deterministic", () => {
    for (const { html } of bodies) {
      expect(JSON.stringify(htmlToNodes(html))).toBe(JSON.stringify(htmlToNodes(html)));
    }
  });
});
