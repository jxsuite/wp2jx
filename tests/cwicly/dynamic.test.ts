/**
 * What a Cwicly block says it contains, read from its attributes: its text, its image, its background
 * and its gallery.
 *
 * The attribute road and the saved-markup road must reach the same place, so the corpus tests resolve
 * every text and image block of both sites both ways (the saved markup through `tokens.ts`, the
 * attributes through `dynamic.ts`) and compare what each prints. The live pages stand behind both.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse, parseFragment } from "parse5";
import { allSubjects, loadSite, makeCtx, subjectBlocks } from "../helpers/ctx.ts";
import type { LoadedSite, SiteName, Subject } from "../helpers/ctx.ts";
import { buildRoutes, createUrlTools } from "../../src/routes.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import { decodeEntities } from "../../src/wp/model.ts";
import type { ConvertCtx, WpBlock, WpPost } from "../../src/types.ts";
import {
  acfLocationArg,
  blockBackground,
  blockContent,
  blockGallery,
  blockImage,
  blockText,
  contentToken,
  galleryIds,
  galleryMarkup,
} from "../../src/cwicly/dynamic.ts";
import { findTokens, postData, resolveTokens, termData } from "../../src/cwicly/tokens.ts";

setDefaultTimeout(120_000);

// ── Real contexts ────────────────────────────────────────────────────────────────────────────────

type N = {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: N[];
  content?: N;
};

const toolCache = new Map<SiteName, ReturnType<typeof createUrlTools>>();

function toolsFor(site: SiteName, loaded: LoadedSite): ReturnType<typeof createUrlTools> {
  let t = toolCache.get(site);
  if (!t) {
    t = createUrlTools(
      loaded.model,
      buildRoutes(loaded.model, loaded.acf, { media: loaded.media }),
      loaded.media,
    );
    toolCache.set(site, t);
  }
  return t;
}

async function realCtx(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
): Promise<{ ctx: ConvertCtx; loaded: LoadedSite }> {
  const loaded = await loadSite(site);
  const t = toolsFor(site, loaded);
  const ctx = await makeCtx(site, subject, { urlFor: t.urlFor, rewriteUrl: t.rewriteUrl, ...over });
  Object.assign(ctx, { urlForAuthor: t.urlForAuthor, urlForArchive: t.urlForArchive });
  return { ctx, loaded };
}

const block = (name: string, attrs: Record<string, unknown> = {}, innerHTML = ""): WpBlock => ({
  name,
  attrs,
  innerBlocks: [],
  innerHTML,
  innerContent: [innerHTML],
});

/** A string as the Jx build evaluates it: only a string with a binding in it is a template. */
function evalTemplate(template: string, state: unknown, map: unknown = undefined): string {
  if (!template.includes("${")) return template;
  const fn = new Function("state", "$map", `return \`${template}\``) as (
    s: unknown,
    m: unknown,
  ) => string;
  return fn(state, map);
}

const shown = (markup: string): string =>
  decodeEntities(markup.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
const escapeText = (t: string): string =>
  t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const walkN = (n: N, f: (n: N) => void): void => {
  f(n);
  for (const c of n.childNodes ?? []) walkN(c, f);
  if (n.content) walkN(n.content, f);
};
const attrsOf = (n: N): Record<string, string> =>
  Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value]));

/** The subjects of a site with the context each is converted in, and a scope to evaluate its bindings over. */
interface Prepared {
  sub: Subject;
  ctx: ConvertCtx;
  state: unknown;
  mode: "static" | "entry" | "component";
}

async function prepare(site: SiteName): Promise<Prepared[]> {
  const loaded = await loadSite(site);
  const t = toolsFor(site, loaded);
  const out: Prepared[] = [];
  for (const sub of allSubjects(loaded)) {
    const slug = "slug" in sub ? sub.slug : "";
    const mode = sub.kind === "post" ? "static" : sub.kind === "component" ? "component" : "entry";
    const over: Partial<ConvertCtx> = { mode, urlFor: t.urlFor, rewriteUrl: t.rewriteUrl };
    let type: string | undefined;
    if (mode === "entry") {
      type =
        /^(?:single|archive)-(.+)$/.exec(slug)?.[1] ?? (slug === "single" ? "post" : undefined);
      if (type !== undefined) over.entryType = type;
      if (slug.startsWith("taxonomy-")) over.termExpr = "state.term";
    }
    const { ctx } = await realCtx(site, sub, over);
    let state: unknown = {};
    if (mode === "entry") {
      const posts = [...loaded.model.posts.values()].filter(
        (p) => p.status === "publish" && p.type === (type ?? "post"),
      );
      const richest = posts
        .map((p) => ({ p, n: JSON.stringify(postData(ctx, p)).length }))
        .sort((a, b) => b.n - a.n)[0]?.p;
      const term = [...loaded.model.terms.values()].find(
        (x) => x.taxonomy === slug.replace(/^taxonomy-/, ""),
      );
      state = {
        entry: { data: richest ? postData(ctx, richest) : {}, $children: [] },
        term: { data: term ? termData(ctx, term) : {} },
      };
    }
    if (mode === "component") {
      ctx.props = new Map(
        ctx.components.get((sub as { ref: string }).ref)?.props.map((p) => [p.id, p.key]),
      );
      state = Object.fromEntries(
        [...(ctx.props?.values() ?? [])].map((k) => [
          k,
          {
            src: `/p/${k}.png`,
            alt: `alt-${k}`,
            width: 10,
            height: 20,
            href: "/h",
            toString: () => `<${k}>`,
          },
        ]),
      );
    }
    out.push({ sub, ctx, state, mode });
  }
  return out;
}

const prepared = new Map<SiteName, Promise<Prepared[]>>();
const preparedFor = (site: SiteName): Promise<Prepared[]> => {
  let p = prepared.get(site);
  if (!p) {
    p = prepare(site);
    prepared.set(site, p);
  }
  return p;
};

// ── Locations and tokens ─────────────────────────────────────────────────────────────────────────

describe("acfLocationArg", () => {
  const keys = { location: "L", id: "I", object: "O" };
  const arg = (attrs: Record<string, unknown>): string => acfLocationArg(attrs, keys);

  test("each location is the argument the editor writes into the token", () => {
    expect(arg({})).toBe("");
    expect(arg({ L: "currentpost" })).toBe("");
    expect(arg({ L: "postid", I: "42" })).toBe("42");
    expect(arg({ L: "postid" })).toBe("");
    expect(arg({ L: "currentuser" })).toBe("currentuser");
    expect(arg({ L: "currentauthor" })).toBe("currentauthor");
    expect(arg({ L: "userid", I: 7 })).toBe("user_7");
    expect(arg({ L: "userid" })).toBe("");
    expect(arg({ L: "option" })).toBe("option");
    expect(arg({ L: "termid" })).toBe("taxterm");
    expect(arg({ L: "termquery" })).toBe("termquery");
    expect(arg({ L: "userquery" })).toBe("userquery");
    expect(arg({ L: "currenttaxonomytermarchive" })).toBe("currenttaxonomytermarchive");
    expect(arg({ L: "taxonomyterm", O: { value: 120, label: "x" } })).toBe("term_120");
    expect(arg({ L: "taxonomyterm" })).toBe("");
  });
});

describe("contentToken", () => {
  test("each dynamic source is the token the editor writes, defaults applied", () => {
    const tok = (attrs: Record<string, unknown>): string | undefined => contentToken(attrs);
    expect(tok({})).toBeUndefined();
    expect(tok({ dynamic: "wordpress", dynamicWordPressType: "title" })).toBe("{title}");
    expect(
      tok({
        dynamic: "wordpress",
        dynamicWordPressType: "postexcerpt",
        dynamicWordPressExcerptLimit: 75,
      }),
    ).toBe("{postexcerpt=75}");
    expect(tok({ dynamic: "wordpress", dynamicWordPressType: "postexcerpt" })).toBe(
      "{postexcerpt}",
    );
    expect(tok({ dynamic: "wordpress", dynamicWordPressType: "postdate" })).toBe(
      "{postdate=published=default}",
    );
    expect(
      tok({
        dynamic: "wordpress",
        dynamicWordPressType: "postdate",
        dynamicWordPressDateType: "modified",
        dynamicWordPressDateFormat: "custom",
        dynamicWordPressDateCustom: "Y",
      }),
    ).toBe("{postdate=modified=custom=Y}");
    expect(tok({ dynamic: "wordpress", dynamicWordPressType: "time" })).toBe(
      "{time=published=default}",
    );
    expect(tok({ dynamic: "wordpress", dynamicWordPressType: "currentdate" })).toBe(
      "{currentdate=default=default}",
    );
    expect(
      tok({
        dynamic: "wordpress",
        dynamicWordPressType: "customcurrentdate",
        dynamicWordPressCustomCurrentDate: "Y",
      }),
    ).toBe("{customcurrentdate=Y}");
    expect(tok({ dynamic: "wordpress", dynamicWordPressType: "postcomments" })).toBe(
      "{postcomments=No Comments=Comment=Comments}",
    );
    expect(
      tok({
        dynamic: "wordpress",
        dynamicWordPressType: "siteoption",
        dynamicWordPressExtra: "blogname",
      }),
    ).toBe("{siteoption=blogname}");
    expect(
      tok({
        dynamic: "wordpress",
        dynamicWordPressType: "customfield",
        dynamicWordPressExtra: "k",
      }),
    ).toBe("{customfield=k}");
    expect(tok({ dynamic: "wordpress", dynamicWordPressType: "authorinfo" })).toBe("{authorinfo}");
    expect(tok({ dynamic: "taxonomyterms", dynamicTaxTermsType: "name" })).toBe("{taxterms=name}");
    expect(tok({ dynamic: "userquery", dynamicWordPressType: "display_name" })).toBe(
      "{userquery=display_name}",
    );
    expect(tok({ dynamic: "taxonomyquery", dynamicWordPressType: "name" })).toBe(
      "{termquery=name}",
    );
    expect(tok({ dynamic: "commentquery", dynamicWordPressType: "comment_author" })).toBe(
      "{commentquery=comment_author}",
    );
    expect(
      tok({
        dynamic: "commentquery",
        dynamicWordPressType: "comment_time",
        dynamicWordPressTimeFormat: "4",
      }),
    ).toBe("{commentquery=comment_time=4}");
    expect(
      tok({
        dynamic: "commentquery",
        dynamicWordPressType: "comment_date",
        dynamicWordPressDateFormat: "custom",
        dynamicWordPressDateCustom: "Y",
      }),
    ).toBe("{commentquery=comment_date=custom=Y}");
    expect(tok({ dynamic: "acf", dynamicACFGroup: "g", dynamicACFField: "field_1" })).toBe(
      "{acffield=field_1}",
    );
    expect(
      tok({
        dynamic: "acf",
        dynamicACFGroup: "g",
        dynamicACFField: "field_1",
        dynamicACFFieldLocation: "currenttaxonomytermarchive",
      }),
    ).toBe("{acffield=field_1=currenttaxonomytermarchive}");
    expect(
      tok({
        dynamic: "acf",
        dynamicACFGroup: "g",
        dynamicACFField: "field_1",
        dynamicACFFieldPlus: "alt",
      }),
    ).toBe("{acffield=field_1=false=alt}");
    expect(
      tok({
        dynamic: "acf",
        dynamicACFGroup: "g",
        dynamicACFField: "field_1",
        dynamicACFFieldLocation: "postid",
        dynamicACFFieldLocationID: "9",
        dynamicACFFieldPlus: "alt",
      }),
    ).toBe("{acffield=field_1=9=alt}");
    expect(tok({ dynamic: "repeater", dynamicRepeaterField: "sub" })).toBe("{acfrepeater=sub}");
    expect(tok({ dynamic: "filterselection" })).toBeUndefined();
  });

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: on every text block the token from the attributes is the token the saved markup holds`, async () => {
      const loaded = await loadSite(site);
      const classes = new Set([
        "class",
        "acl",
        "sacl",
        "gcl",
        "aclv",
        "gclv",
        "cs-index",
        "cccomp",
        "currentpageclass",
        "idadd",
      ]);
      let compared = 0;
      const withoutToken: string[] = [];
      for (const sub of allSubjects(loaded)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (!b.name || !b.attrs.dynamic) return;
          if (!/^cwicly\/(heading|paragraph|button)$/.test(b.name)) return;
          const want = contentToken(b.attrs);
          if (want === undefined) {
            withoutToken.push(`${b.name} dynamic=${String(b.attrs.dynamic)}`);
            return;
          }
          const have = findTokens(b.innerHTML)
            .filter((f) => !classes.has(f.name))
            .map((f) => f.token);
          compared++;
          expect(have).toContain(want);
        });
      }
      expect(compared).toBe(site === "fineline" ? 121 : 98);
      // A dynamic source the editor writes no token for: a filter's selection, which is not carried over.
      expect([...new Set(withoutToken)]).toEqual(
        site === "fineline" ? [] : ["cwicly/paragraph dynamic=filterselection"],
      );
    });
  }
});

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────

function findBlock(blocks: WpBlock[], pred: (b: WpBlock) => boolean): WpBlock | undefined {
  let found: WpBlock | undefined;
  walkBlocks(blocks, (b) => {
    if (!found && pred(b)) found = b;
  });
  return found;
}

async function templateBlock(
  site: SiteName,
  slug: string,
  pred: (b: WpBlock) => boolean,
): Promise<WpBlock> {
  const loaded = await loadSite(site);
  const found = findBlock(subjectBlocks(loaded, { kind: "template", slug }), pred);
  expect(found).toBeDefined();
  return found as WpBlock;
}

describe("blockText", () => {
  test("static text around a dynamic value is joined, in an entry template", async () => {
    const heading = await templateBlock(
      "fineline",
      "single-project",
      (b) => b.attrs.dynamicStaticBefore === "About This ",
    );
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    expect(blockText(heading, ctx)).toEqual({
      kind: "text",
      value: "About This ${state.entry.data.title ?? ''}",
    });
  });

  test("and on a static page, as the text it prints", async () => {
    const heading = await templateBlock(
      "fineline",
      "single-project",
      (b) => b.attrs.dynamicStaticBefore === "About This ",
    );
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "post", id: 1078 },
      { mode: "static" },
    );
    expect(loaded.model.posts.get(1078)?.title).toBe("Log Cabin Staining In Fredericksburg PA");
    expect(blockText(heading, ctx)).toEqual({
      kind: "text",
      value: "About This Log Cabin Staining In Fredericksburg PA",
    });
  });

  test("a text after the value, and an excerpt with a limit", async () => {
    const para = await templateBlock(
      "fineline",
      "index",
      (b) => b.attrs.dynamicWordPressType === "postexcerpt",
    );
    expect(para.attrs.dynamicStaticAfter).toBe("... Read More");
    const { ctx } = await realCtx("fineline", { kind: "post", id: 1078 }, { mode: "static" });
    const spec = blockText(para, ctx);
    expect(spec?.kind).toBe("html");
    // The excerpt keeps its character references, so the result is markup; the text after it is escaped like any text.
    // The post has no excerpt of its own, so its text blocks stand in (Cwicly's own filter), cut to 75 bytes.
    expect(spec?.value).toMatch(
      /^Professional Log Cabin Staining In Fredericksburg, PA\s+Learn More About… Read More$/,
    );
    const entry = (
      await realCtx(
        "fineline",
        { kind: "template", slug: "index" },
        { mode: "entry", entryType: "project" },
      )
    ).ctx;
    const bound = blockText(para, entry);
    expect(bound?.kind).toBe("html");
    expect(bound?.value).toContain("… Read More");
    expect(
      evalTemplate(bound?.value ?? "", { entry: { data: { excerpt: "<p>One two three</p>" } } }),
    ).toBe("One two three… Read More");
  });

  test("a term archive's title with the text in front", async () => {
    const heading = await templateBlock(
      "fineline",
      "taxonomy-location",
      (b) => b.attrs.dynamicStaticBefore === "Professional Painters Serving ",
    );
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry", termExpr: "state.term" },
    );
    expect(blockText(heading, ctx)).toEqual({
      kind: "text",
      value: "Professional Painters Serving ${state.term.data.name ?? ''}",
    });
  });

  test("an ACF field with a fallback: the fallback fills an empty field, in an entry and on a static page", async () => {
    const heading = await templateBlock(
      "fineline",
      "single",
      (b) => b.attrs.dynamicStaticFallback === "Don't Wait, Take Action Now!",
    );
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "single" },
      { mode: "entry", entryType: "post" },
    );
    const spec = blockText(heading, ctx);
    // The pilot's plugin prints a text field as it is stored (markup stays markup), so it is HTML.
    expect(spec?.kind).toBe("html");
    const field = loaded.acf.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === heading.attrs.dynamicACFField);
    expect(field?.name).toBeDefined();
    const key = field?.name as string;
    // The fallback is static text, which WordPress prints through wptexturize.
    // A value of `0` is empty to Cwicly (`if ($field)`), so it falls back too.
    expect(spec?.value).toBe(
      `\${(((t) => t == '0' ? '' : t ?? '')(state.entry.data.${key})) || 'Don’t Wait, Take Action Now!'}`,
    );
    expect(evalTemplate(spec?.value ?? "", { entry: { data: { [key]: "0" } } })).toBe(
      "Don’t Wait, Take Action Now!",
    );
    expect(evalTemplate(spec?.value ?? "", { entry: { data: { [key]: 0 } } })).toBe(
      "Don’t Wait, Take Action Now!",
    );
    expect(evalTemplate(spec?.value ?? "", { entry: { data: {} } })).toBe(
      "Don’t Wait, Take Action Now!",
    );
    expect(evalTemplate(spec?.value ?? "", { entry: { data: { [key]: "Ours" } } })).toBe("Ours");
    const post = loaded.model.posts.get(3371) as WpPost;
    const stat = (await realCtx("fineline", { kind: "post", id: post.id }, { mode: "static" })).ctx;
    const own = postData(stat, post)[key];
    expect(blockText(heading, stat)).toEqual({
      kind: "html",
      value: typeof own === "string" && own !== "" ? own : "Don’t Wait, Take Action Now!",
    });
  });

  test("a wysiwyg field is markup", async () => {
    const para = await templateBlock(
      "fineline",
      "single",
      (b) => b.attrs.dynamicACFField === "field_66a3e100965dd",
    );
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "single" },
      { mode: "entry", entryType: "post" },
    );
    const spec = blockText(para, ctx);
    expect(spec?.kind).toBe("html");
    const name = loaded.acf.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === "field_66a3e100965dd")?.name as string;
    expect(
      loaded.acf.groups.flatMap((g) => g.fields).find((f) => f.key === "field_66a3e100965dd")?.type,
    ).toBe("wysiwyg");
    expect(
      evalTemplate(spec?.value ?? "", { entry: { data: { [name]: "<p>x &amp; y</p>" } } }),
    ).toBe("<p>x &amp; y</p>");
    const stat = (await realCtx("fineline", { kind: "post", id: 3371 }, { mode: "static" })).ctx;
    expect(blockText(para, stat)?.kind).toBe("html");
    expect(blockText(para, stat)?.value).toMatch(/^<p>.*<\/p>\n?$/s);
  });

  test("content with no dynamic source is the saved text: plain stays text, markup is html", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 }, { mode: "static" });
    expect(blockText(block("cwicly/heading", { content: "Fine Line Painting" }), ctx)).toEqual({
      kind: "text",
      value: "Fine Line Painting",
    });
    expect(
      blockText(block("cwicly/paragraph", { content: "Call <b>us</b> &amp; save" }), ctx),
    ).toEqual({ kind: "html", value: "Call <b>us</b> &amp; save" });
    expect(blockText(block("cwicly/paragraph", { content: "&copy; 2024" }), ctx)?.kind).toBe(
      "html",
    );
    expect(blockText(block("cwicly/paragraph", {}), ctx)).toBeUndefined();
    expect(blockText(block("cwicly/paragraph", { content: "" }), ctx)).toBeUndefined();
  });

  test("a token in saved content is resolved, and with a binding in it a backtick and a backslash are escaped for the template", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 }, { mode: "static" });
    const year = new Date().getFullYear();
    const spec = blockText(
      block("cwicly/paragraph", { content: "Copyright <ccd>custom_current_date=Y</ccd> `a` \\" }),
      ctx,
    );
    expect(spec?.kind).toBe("text");
    expect(spec?.value).toMatch(/^Copyright \$\{.*\} \\`a\\` \\\\$/s);
    expect(evalTemplate(spec?.value ?? "", {})).toBe(`Copyright ${year} \`a\` \\`);
    // With no binding in it, a backtick and a backslash are what they look like.
    expect(blockText(block("cwicly/paragraph", { content: "plain `a` \\" }), ctx)).toEqual({
      kind: "text",
      value: "plain `a` \\",
    });
  });

  test("a connected property is a read of the component's state", async () => {
    const { ctx } = await realCtx("fineline", { kind: "component", ref: "0a275b695a" });
    ctx.props = new Map(ctx.components.get("0a275b695a")?.props.map((p) => [p.id, p.key]));
    const heading = findBlock(
      subjectBlocks(await loadSite("fineline"), { kind: "component", ref: "0a275b695a" }),
      (b) => b.name === "cwicly/heading",
    ) as WpBlock;
    expect(blockText(heading, ctx)).toEqual({ kind: "text", value: "${state.heading ?? ''}" });
    const rich = findBlock(
      subjectBlocks(await loadSite("fineline"), { kind: "component", ref: "0a275b695a" }),
      (b) => b.name === "cwicly/paragraph",
    ) as WpBlock;
    expect(blockText(rich, ctx)).toEqual({ kind: "html", value: "${state.paragraph ?? ''}" });
  });

  test("a dynamic source with no token (a filter's selection) has no text, and nothing is invented from its preview", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 5046 }, { mode: "static" });
    expect(
      blockText(block("cwicly/paragraph", { dynamic: "filterselection", content: "Preview" }), ctx),
    ).toEqual({ kind: "text", value: "" });
  });

  test("a value that has no static form is empty and reported by the token", async () => {
    const { ctx } = await realCtx("ap", { kind: "post", id: 5046 }, { mode: "static" });
    expect(
      blockText(
        block("cwicly/button", { dynamic: "userquery", dynamicWordPressType: "display_name" }),
        ctx,
      ),
    ).toEqual({ kind: "text", value: "" });
    expect(ctx.report.entries().some((e) => e.code === "token.unresolved")).toBe(true);
  });

  test("a before text with markup characters is escaped as text, not read as markup", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 }, { mode: "static" });
    const spec = blockText(
      block("cwicly/heading", {
        dynamic: "wordpress",
        dynamicWordPressType: "title",
        dynamicStaticBefore: "A <b> & ",
        dynamicStaticAfter: " ${x}",
      }),
      ctx,
    );
    expect(spec?.kind).toBe("text");
    expect(spec?.value).toBe("A <b> & Home-current ${x}".replace("${x}", "$\u200b{x}"));
  });

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: the text from the attributes prints what the saved markup prints, on every heading, paragraph and button`, async () => {
      let compared = 0;
      const loaded = await loadSite(site);
      for (const { sub, ctx, state } of await preparedFor(site)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (
            !b.name ||
            !/^cwicly\/(heading|paragraph|button)$/.test(b.name) ||
            b.innerBlocks.length > 0
          )
            return;
          const spec = blockText(b, ctx);
          const saved = resolveTokens(b.innerHTML, ctx, b, { where: "html" });
          compared++;
          const mine =
            spec === undefined
              ? ""
              : shown(
                  spec.kind === "text"
                    ? escapeText(evalTemplate(spec.value, state))
                    : evalTemplate(spec.value, state),
                );
          expect(mine).toBe(shown(evalTemplate(saved, state)));
        });
      }
      expect(compared).toBe(site === "fineline" ? 1561 : 307);
    });
  }
});

// ── Content as structure ─────────────────────────────────────────────────────────────────────────

describe("blockContent", () => {
  test("is the same text as the content of an element: structured, or raw where a gap would show", async () => {
    const before = await templateBlock(
      "fineline",
      "single-project",
      (b) => b.attrs.dynamicStaticBefore === "About This ",
    );
    const entry = (
      await realCtx(
        "fineline",
        { kind: "template", slug: "single-project" },
        { mode: "entry", entryType: "project" },
      )
    ).ctx;
    // The before text is plain text next to the value, so one string holds both.
    expect(blockContent(before, entry)).toEqual({
      textContent: "About This ${state.entry.data.title ?? ''}",
    });
    expect(
      blockContent(
        block("cwicly/paragraph", {
          dynamic: "wordpress",
          dynamicWordPressType: "title",
          dynamicStaticBefore: "#",
        }),
        entry,
      ),
    ).toEqual({
      textContent: "#${state.entry.data.title ?? ''}",
    });
    // Markup in the content is structure; a binding beside an element is a span of its own.
    const mixed = blockContent(
      block("cwicly/paragraph", {
        dynamic: "wordpress",
        dynamicWordPressType: "title",
        dynamicStaticBefore: "<i>#</i>",
      }),
      entry,
    );
    expect(mixed).toEqual({ textContent: "<i>#</i>${state.entry.data.title ?? ''}" });
    expect(blockContent(block("cwicly/paragraph", {}), entry)).toBeUndefined();
    expect(blockContent(block("cwicly/heading", { content: "Plain" }), entry)).toEqual({
      textContent: "Plain",
    });
    expect(
      blockContent(block("cwicly/heading", { content: 'A <a href="/x/">link</a> here' }), entry),
    ).toEqual({
      children: ["A ", { tagName: "a", attributes: { href: "/x/" }, textContent: "link" }, " here"],
    });
    // A binding next to an element whose boundary would show a gap keeps the text raw.
    const gap = blockContent(block("cwicly/heading", { content: "<b>x</b>{title}" }), entry);
    expect(gap).toEqual({ innerHTML: expect.stringContaining("<b>x</b>${String(") });
  });
});

// ── Images ───────────────────────────────────────────────────────────────────────────────────────

async function imageBlock(site: SiteName, sub: Subject, classID: string): Promise<WpBlock> {
  const loaded = await loadSite(site);
  const found = findBlock(subjectBlocks(loaded, sub), (b) => b.attrs.classID === classID);
  expect(found).toBeDefined();
  return found as WpBlock;
}

describe("blockImage", () => {
  test("a fixed image: the file the address names, with the attachment's size and alt text", async () => {
    const img = await imageBlock("fineline", { kind: "part", slug: "header" }, "image-cb08483");
    const { ctx, loaded } = await realCtx("fineline", { kind: "part", slug: "header" });
    expect(img.attrs.imageID).toBe(785);
    const media = loaded.media.mediaFor(785);
    expect(blockImage(img, ctx)).toEqual({
      src: loaded.media.mediaForUrl(img.attrs.imageURL as string)?.src as string,
      alt: media?.alt as string,
      width: media?.width as number,
      height: media?.height as number,
      id: 785,
      bound: false,
    });
    expect(media?.src).toBe(loaded.media.mediaForUrl(img.attrs.imageURL as string)?.src);
  });

  test("with only an address, the file that address names; the alt text is what the block says", async () => {
    const img = await imageBlock("fineline", { kind: "post", id: 195 }, "image-cc23dbb");
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 195 });
    expect(img.attrs.imageID).toBeUndefined();
    const media = loaded.media.mediaForUrl(img.attrs.imageURL as string);
    expect(media).toBeDefined();
    expect(blockImage(img, ctx)).toMatchObject({ src: media?.src, bound: false });
    // A stated alt wins over the attachment's.
    const alt = await imageBlock("fineline", { kind: "post", id: 5309 }, "image-cdeae93");
    expect(alt.attrs.imageAlt).toBeTruthy();
    const { ctx: c2 } = await realCtx("fineline", { kind: "post", id: 5309 });
    expect(blockImage(alt, c2)?.alt).toBe(alt.attrs.imageAlt as string);
  });

  test("a chosen size derives the file from the attachment id, and the one original is what the site keeps", async () => {
    const img = await imageBlock("fineline", { kind: "post", id: 5246 }, "image-c6f0a95");
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 5246 });
    expect(img.attrs.imageThumbnailSize).toBeTruthy();
    const media = loaded.media.mediaFor(5576);
    expect(blockImage(img, ctx)).toMatchObject({
      src: media?.src,
      width: media?.width,
      height: media?.height,
      id: 5576,
    });
  });

  test("an address no attachment accounts for is kept, not swapped for the file of an id that may be stale", async () => {
    const img = await imageBlock("fineline", { kind: "post", id: 1935 }, "image-c5f6058");
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 1935 });
    expect(loaded.media.mediaFor(4009)).toBeUndefined();
    expect(loaded.media.mediaForUrl(img.attrs.imageURL as string)).toBeUndefined();
    expect(blockImage(img, ctx)).toEqual({
      src: ctx.rewriteUrl(img.attrs.imageURL as string),
      alt: "",
      bound: false,
    });
    const ap = await imageBlock("ap", { kind: "part", slug: "header-light" }, "image-c260437");
    const apCtx = (await realCtx("ap", { kind: "part", slug: "header-light" })).ctx;
    expect(blockImage(ap, apCtx)?.src).toBe(apCtx.rewriteUrl(ap.attrs.imageURL as string));
  });

  test("an id and an address that name two files: the address is shown without a size, the id with one, and it is reported", async () => {
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 5246 });
    const ids = [...loaded.model.attachments.keys()].filter(
      (k) => loaded.media.mediaFor(k) !== undefined,
    );
    const a = ids[0] as number;
    const b = ids.find(
      (k) => loaded.media.mediaFor(k)?.src !== loaded.media.mediaFor(a)?.src,
    ) as number;
    const mediaA = loaded.media.mediaFor(a);
    const mediaB = loaded.media.mediaFor(b);
    expect(mediaA?.src).not.toBe(mediaB?.src);
    const urlA = loaded.model.attachments.get(a)?.url as string;
    const plain = blockImage(block("cwicly/image", { imageID: b, imageURL: urlA }), ctx);
    expect(plain?.src).toBe(mediaA?.src);
    const sized = blockImage(
      block("cwicly/image", { imageID: b, imageURL: urlA, imageThumbnailSize: "medium" }),
      ctx,
    );
    expect(sized?.src).toBe(mediaB?.src);
    const stale = ctx.report.entries().filter((e) => e.code === "dynamic.stale-image");
    // Once per subject and attachment, however many blocks name the pair.
    expect(stale).toHaveLength(1);
    expect(stale[0]?.severity).toBe("info");
  });

  test("an id that has no file and no address is reported and gives nothing", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 1935 });
    expect(blockImage(block("cwicly/image", { imageID: 4009 }), ctx)).toBeUndefined();
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["dynamic.missing-image"]);
    expect(blockImage(block("cwicly/image", {}), ctx)).toBeUndefined();
  });

  test("the featured image of an entry is a binding that prints an empty src, as the plugin does, when the entry has none", async () => {
    const img = await imageBlock("fineline", { kind: "template", slug: "index" }, "image-c110644");
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "index" },
      { mode: "entry", entryType: "project" },
    );
    const spec = blockImage(img, ctx);
    expect(spec).toEqual({
      src: "${(state.entry.data.featuredImage?.src ?? '') || ''}",
      alt: "${state.entry.data.featuredImage?.alt ?? ''}",
      width: "${(state.entry.data.featuredImage?.width ?? '') || false}",
      height: "${(state.entry.data.featuredImage?.height ?? '') || false}",
      bound: true,
    });
    const have = {
      entry: {
        data: { featuredImage: { src: "/media/a.jpg", alt: "An A", width: 800, height: 600 } },
      },
    };
    expect(evalTemplate(spec?.src ?? "", have)).toBe("/media/a.jpg");
    expect(evalTemplate(String(spec?.width ?? ""), have)).toBe("800");
    expect(evalTemplate(spec?.src ?? "", { entry: { data: {} } })).toBe("");
  });

  test("on a static page it is the featured image's file at the size the block asks for", async () => {
    const img = await imageBlock("fineline", { kind: "template", slug: "index" }, "image-c110644");
    const { ctx, loaded } = await realCtx("fineline", { kind: "post", id: 1078 });
    const post = loaded.model.posts.get(1078) as WpPost;
    const feat = postData(ctx, post).featuredImage as {
      src: string;
      alt: string;
      width: number;
      height: number;
    };
    // the block says `medium_large`: WordPress prints that size's own dimensions, not the original's
    const thumbnail = Number(loaded.model.postMeta.get(1078)?._thumbnail_id?.[0]);
    const size = loaded.model.attachments
      .get(thumbnail)!
      .sizes.find((s) => s.name === "medium_large")!;
    expect(size.width).toBeLessThan(feat.width);
    expect(blockImage(img, ctx)).toEqual({
      src: feat.src,
      alt: feat.alt,
      width: size.width,
      height: size.height,
      bound: false,
    });
    // a size the attachment does not have, or none, is the original's
    const other = (name: string | undefined): WpBlock => ({
      ...img,
      attrs: { ...img.attrs, imageThumbnailSize: name },
    });
    for (const name of ["no_such_size", "full", undefined]) {
      expect(blockImage(other(name), ctx)).toMatchObject({
        width: feat.width,
        height: feat.height,
      });
    }
  });

  test("a fallback image fills the place of a missing featured image, and its attachment id wins over its address", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "single" },
      { mode: "entry", entryType: "post" },
    );
    const id = 5576;
    const src = loaded.media.mediaFor(id)?.src as string;
    const spec = blockImage(
      block("cwicly/image", {
        imageType: "dynamic",
        dynamic: "wordpress",
        dynamicWordpressType: "featuredimage",
        dynamicStaticFallbackID: id,
        dynamicStaticFallbackURL: "https://example.com/other.jpg",
      }),
      ctx,
    );
    expect(spec?.src).toBe(`\${(state.entry.data.featuredImage?.src ?? '') || '${src}'}`);
    expect(evalTemplate(spec?.src ?? "", { entry: { data: {} } })).toBe(src);
  });

  test("the alt text of a dynamic image: the stated one, else the image's own, else the one of the attachment the block used to show", async () => {
    const single = await imageBlock(
      "fineline",
      { kind: "template", slug: "single" },
      "image-cc23dbb",
    );
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "single" },
      { mode: "entry", entryType: "post" },
    );
    const spec = blockImage(single, ctx);
    const old = loaded.media.mediaFor(2163)?.alt as string;
    expect(old).toBeTruthy();
    expect(spec?.alt).toBe(`\${(state.entry.data.featuredImage?.alt ?? '') || ${jsLiteral(old)}}`);
    expect(
      evalTemplate(spec?.alt ?? "", { entry: { data: { featuredImage: { alt: "Own alt" } } } }),
    ).toBe("Own alt");
    expect(evalTemplate(spec?.alt ?? "", { entry: { data: { featuredImage: { alt: "" } } } })).toBe(
      old,
    );
    const stated = blockImage({ ...single, attrs: { ...single.attrs, imageAlt: "Stated" } }, ctx);
    expect(stated?.alt).toBe("Stated");
  });

  test("an ACF image field reads the field's image, with the field's own fallback", async () => {
    const img = await imageBlock(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      "image-c0d46f1",
    );
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry", termExpr: "state.term" },
    );
    const spec = blockImage(img, ctx);
    const field = loaded.acf.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === img.attrs.dynamicACFField);
    expect(field?.type).toBe("image");
    expect(spec?.src).toContain(`state.term.data.${field?.name}?.src`);
    expect(spec?.bound).toBe(true);
  });

  test("a component's image property is a read of its state, with the alt text and loading behaviour of the block", async () => {
    const img = await imageBlock(
      "fineline",
      { kind: "component", ref: "244868a12d" },
      "image-c879c93",
    );
    const { ctx } = await realCtx("fineline", { kind: "component", ref: "244868a12d" });
    ctx.props = new Map(ctx.components.get("244868a12d")?.props.map((p) => [p.id, p.key]));
    const key = ctx.props.get("eDHhK") as string;
    expect(blockImage(img, ctx)).toEqual({
      src: `\${state.${key}?.src || false}`,
      alt: `\${state.${key}?.alt ?? ''}`,
      width: `\${state.${key}?.width || false}`,
      height: `\${state.${key}?.height || false}`,
      sizes: `\${state.${key}?.width ? 'auto, (max-width: ' + state.${key}?.width + 'px) 100vw, ' + state.${key}?.width + 'px' : false}`,
      bound: true,
    });
    // what the expression prints: the plugin's sizes for the instance's own width, nothing without one
    const sizes = blockImage(img, ctx)?.sizes ?? "";
    expect(evalTemplate(sizes, { [key]: { width: 1725 } })).toBe(
      "auto, (max-width: 1725px) 100vw, 1725px",
    );
    expect(evalTemplate(sizes, { [key]: {} })).toBe("false");
    ctx.props = new Map();
    expect(blockImage(img, ctx)).toBeUndefined();
    expect(ctx.report.entries().some((e) => e.code === "dynamic.unsupported")).toBe(true);
  });

  test("lazy loading follows the block, and a component can decide it", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 5246 });
    const base = { imageURL: "https://example.com/x.jpg" };
    expect(blockImage(block("cwicly/image", { ...base, lazyLoad: true }), ctx)?.loading).toBe(
      "lazy",
    );
    expect(blockImage(block("cwicly/image", { ...base, lazyLoad: false }), ctx)?.loading).toBe(
      "eager",
    );
    expect(blockImage(block("cwicly/image", base), ctx)?.loading).toBeUndefined();
    ctx.props = new Map([["abc", "eager"]]);
    expect(
      blockImage(block("cwicly/image", { ...base, lazyLoadComp: "!ref=abc!" }), ctx)?.loading,
    ).toBe("${state.eager ? 'lazy' : 'eager'}");
  });

  test("the picture of the current author is not read (the live page prints the block's fallback): the fallback image is used, and the rest is reported", async () => {
    const img = await imageBlock("ap", { kind: "template", slug: "single-post" }, "image-c8732a8");
    const { ctx, loaded } = await realCtx(
      "ap",
      { kind: "template", slug: "single-post" },
      { mode: "entry", entryType: "post" },
    );
    const spec = blockImage(img, ctx);
    expect(spec?.bound).toBe(false);
    expect(spec?.src).toBe(
      loaded.media.mediaForUrl(img.attrs.dynamicStaticFallbackURL as string)?.src,
    );
    expect(
      ctx.report
        .entries()
        .some((e) => e.code === "dynamic.unsupported" && e.message.includes("currentauthor")),
    ).toBe(true);
    const bare = blockImage(
      block("cwicly/image", {
        imageType: "dynamic",
        dynamic: "wordpress",
        dynamicWordpressType: "authorpicture",
      }),
      ctx,
    );
    expect(bare).toBeUndefined();
  });

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: the image from the attributes is the image the saved markup holds, on every image block`, async () => {
      const loaded = await loadSite(site);
      const t = toolsFor(site, loaded);
      const norm = (u: string | undefined): string | undefined =>
        u ? (loaded.media.mediaForUrl(u)?.src ?? t.rewriteUrl(u)) : u;
      let compared = 0;
      const differing: string[] = [];
      for (const { sub, ctx, state } of await preparedFor(site)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (b.name !== "cwicly/image") return;
          const spec = blockImage(b, ctx);
          let img: N | undefined;
          walkN(parseFragment(resolveTokens(b.innerHTML, ctx, b)) as unknown as N, (n) => {
            if (!img && n.nodeName === "img") img = n;
          });
          const saved = attrsOf(img as N);
          compared++;
          const mine = spec?.src === undefined ? undefined : evalTemplate(spec.src, state);
          const theirs =
            saved.src === undefined || saved.src === ""
              ? undefined
              : evalTemplate(saved.src, state);
          const clean = (v: string | undefined): string | undefined =>
            v === "" || v === "false" ? undefined : v;
          const same = norm(clean(mine)) === norm(clean(theirs));
          if (!same) differing.push(`${sub.kind} ${String(b.attrs.classID)}`);
          // The alt text agrees unless the saved markup carries only the stale one (see the next test).
          if (spec && saved.alt !== undefined && saved.alt !== "") {
            const alt = evalTemplate(spec.alt, state);
            if (alt !== evalTemplate(saved.alt, state))
              differing.push(`${sub.kind} ${String(b.attrs.classID)} alt`);
          }
        });
      }
      expect(compared).toBe(site === "fineline" ? 425 : 57);
      // The one block whose alt differs: a featured image whose block still holds the id of the image it showed
      // before it was made dynamic. PHP prints the featured image's own alt text first; the saved markup read
      // by this tool's token table has no way to inject it.
      expect(differing).toEqual(site === "fineline" ? ["template image-cc23dbb alt"] : []);
    });
  }
});

/** A JavaScript string literal the way `jsString` writes it, for the tests' expectations. */
function jsLiteral(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

// ── Backgrounds ──────────────────────────────────────────────────────────────────────────────────

describe("blockBackground", () => {
  test("the featured image of an entry is the custom property Cwicly's stylesheet reads", async () => {
    const section = await templateBlock(
      "fineline",
      "single-service",
      (b) => b.attrs.backgroundDynamic === "wordpress",
    );
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "single-service" },
      { mode: "entry", entryType: "service" },
    );
    const spec = blockBackground(section, ctx);
    expect(spec?.property).toBe("--background-image");
    expect(spec?.bound).toBe(true);
    expect(
      evalTemplate(spec?.value ?? "", {
        entry: { data: { featuredImage: { src: "/media/a.jpg" } } },
      }),
    ).toBe("url(/media/a.jpg)");
    expect(evalTemplate(spec?.value ?? "", { entry: { data: {} } })).toBe("none");
  });

  test("with a fallback image, an entry with no image shows the fallback", async () => {
    const div = await templateBlock(
      "ap",
      "search",
      (b) => b.attrs.backgroundDynamic === "wordpress",
    );
    const { ctx, loaded } = await realCtx(
      "ap",
      { kind: "template", slug: "search" },
      { mode: "entry", entryType: "post" },
    );
    const fallback = loaded.media.mediaForUrl(
      div.attrs.backgroundDynamicStaticFallbackURL as string,
    )?.src as string;
    expect(fallback).toBeDefined();
    const spec = blockBackground(div, ctx);
    expect(evalTemplate(spec?.value ?? "", { entry: { data: {} } })).toBe(`url(${fallback})`);
    expect(
      evalTemplate(spec?.value ?? "", {
        entry: { data: { featuredImage: { src: "/media/own.jpg" } } },
      }),
    ).toBe("url(/media/own.jpg)");
  });

  test("on a static page it is the file, or the fallback, or none", async () => {
    const div = await templateBlock(
      "ap",
      "single-post",
      (b) => b.attrs.backgroundDynamic === "wordpress",
    );
    const { ctx, loaded } = await realCtx("ap", { kind: "post", id: 773 }, { mode: "static" });
    const feat = (
      postData(ctx, loaded.model.posts.get(773) as WpPost).featuredImage as { src: string }
    ).src;
    expect(blockBackground(div, ctx)).toEqual({
      property: "--background-image",
      value: `url(${feat})`,
      bound: false,
    });
    const none = {
      ...div,
      attrs: {
        ...div.attrs,
        backgroundDynamicStaticFallbackURL: undefined,
        backgroundDynamicStaticFallbackID: undefined,
      },
    };
    const noImage = (await realCtx("ap", { kind: "post", id: 819 }, { mode: "static" })).ctx;
    expect(blockBackground(none as WpBlock, noImage)).toEqual({
      property: "--background-image",
      value: "none",
      bound: false,
    });
    // The fallback names a file no attachment of the export accounts for, so its address is kept.
    expect(blockBackground(div, noImage)?.value).toBe(
      `url(${noImage.rewriteUrl(div.attrs.backgroundDynamicStaticFallbackURL as string)})`,
    );
  });

  test("an ACF image field, and the cases that are not a dynamic image at all", async () => {
    const { ctx, loaded } = await realCtx(
      "fineline",
      { kind: "template", slug: "taxonomy-location" },
      { mode: "entry", termExpr: "state.term" },
    );
    const field = loaded.acf.groups.flatMap((g) => g.fields).find((f) => f.type === "image");
    const attrs = {
      backgroundType: { lg: "image" },
      backgroundImageType: "dynamic",
      backgroundDynamic: "acf",
      backgroundDynamicACFGroup: "g",
      backgroundDynamicACFField: field?.key,
      backgroundDynamicACFFieldLocation: "currenttaxonomytermarchive",
    };
    const spec = blockBackground(block("cwicly/div", attrs), ctx);
    expect(spec?.value).toContain(`state.term.data.${field?.name}?.src`);
    expect(
      evalTemplate(spec?.value ?? "", {
        term: { data: { [field?.name as string]: { src: "/media/t.jpg" } } },
      }),
    ).toBe("url(/media/t.jpg)");
    // A static background, a missing type, or a background that is not an image at the main breakpoint is not dynamic.
    expect(
      blockBackground(block("cwicly/div", { ...attrs, backgroundImageType: "static" }), ctx),
    ).toBeUndefined();
    expect(
      blockBackground(block("cwicly/div", { ...attrs, backgroundImageType: undefined }), ctx),
    ).toBeUndefined();
    expect(
      blockBackground(block("cwicly/div", { ...attrs, backgroundType: { lg: "color" } }), ctx),
    ).toBeUndefined();
    expect(
      blockBackground(block("cwicly/div", { ...attrs, backgroundDynamic: undefined }), ctx),
    ).toBeUndefined();
  });

  test("an avatar has no file on the converted site: the fallback, else nothing, and it is reported", async () => {
    const avatar = await templateBlock(
      "ap",
      "single-post",
      (b) => b.attrs.backgroundDynamicWordpressType === "featuredimage",
    );
    void avatar;
    const { ctx } = await realCtx("ap", { kind: "part", slug: "comments" });
    const user = block("cwicly/div", {
      backgroundType: { lg: "image" },
      backgroundImageType: "dynamic",
      backgroundDynamic: "wordpress",
      backgroundDynamicWordpressType: "userpicture",
    });
    expect(blockBackground(user, ctx)).toBeUndefined();
    expect(
      ctx.report
        .entries()
        .some((e) => e.code === "dynamic.unsupported" && e.message.includes("userpicture")),
    ).toBe(true);
    const comment = block("cwicly/div", {
      backgroundType: { lg: "image" },
      backgroundImageType: "dynamic",
      backgroundDynamic: "commentquery",
      backgroundDynamicWordpressType: "avatar",
    });
    expect(blockBackground(comment, ctx)).toBeUndefined();
  });

  for (const site of ["fineline", "ap"] as const) {
    test(`${site}: the background from the attributes is the one the saved inline style holds`, async () => {
      const loaded = await loadSite(site);
      let compared = 0;
      for (const { sub, ctx, state } of await preparedFor(site)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (!b.attrs.backgroundDynamic) return;
          const spec = blockBackground(b, ctx);
          const saved = /--background-image:\s*([^;"]*)/.exec(resolveTokens(b.innerHTML, ctx, b));
          if (b.attrs.backgroundImageType !== "dynamic") {
            expect(spec).toBeUndefined();
            expect(saved).toBeNull();
            return;
          }
          compared++;
          const mine = spec === undefined ? "none" : evalTemplate(spec.value, state);
          const theirs = saved?.[1] === undefined ? "none" : evalTemplate(saved[1], state);
          const clean = (v: string): string => (v === "url()" ? "none" : v);
          expect(clean(mine)).toBe(clean(theirs));
        });
      }
      expect(compared).toBe(site === "fineline" ? 1 : 6);
    });
  }
});

// ── Galleries ────────────────────────────────────────────────────────────────────────────────────

describe("blockGallery", () => {
  test("a fixed gallery's images are the ones of its saved markup, in order, and the editor's own list agrees", async () => {
    const loaded = await loadSite("fineline");
    const gallery = findBlock(
      subjectBlocks(loaded, { kind: "post", id: 1078 }),
      (b) => b.name === "cwicly/gallery",
    ) as WpBlock;
    const { ctx } = await realCtx("fineline", { kind: "post", id: 1078 });
    const ids = galleryIds(gallery);
    expect(ids.length).toBeGreaterThan(3);
    expect((gallery.attrs.galleries as { images: number[] }[])[0]?.images).toEqual(ids);
    const spec = blockGallery(gallery, ctx);
    expect(spec?.lightbox).toBe(true);
    expect(spec?.list).toBeUndefined();
    expect(spec?.images.map((i) => i.id)).toEqual(ids);
    expect(spec?.images.map((i) => i.src)).toEqual(
      ids.map((id) => loaded.media.mediaFor(id)?.src as string),
    );
    expect(spec?.images[0]).toMatchObject({
      alt: loaded.media.mediaFor(ids[0] as number)?.alt,
      width: loaded.media.mediaFor(ids[0] as number)?.width,
    });
  });

  test("a gallery with no link wrapper does not open a lightbox, and an id with no file is skipped and reported", async () => {
    const { ctx } = await realCtx("fineline", { kind: "post", id: 1078 });
    const html =
      '<div><figure><img src="{image=815}"/></figure><figure><img src="{image=4009}"/></figure></div>';
    const spec = blockGallery(block("cwicly/gallery", {}, html), ctx);
    expect(spec?.lightbox).toBe(false);
    expect(spec?.images.map((i) => i.id)).toEqual([815]);
    expect(ctx.report.entries().map((e) => e.code)).toEqual(["dynamic.missing-image"]);
  });

  test("an ACF gallery is a list of the entry's, or the images of the post on a static page", async () => {
    const gallery = await templateBlock(
      "fineline",
      "single-project",
      (b) => b.name === "cwicly/gallery",
    );
    expect(gallery.attrs.galleryDynamic).toBe("dynamic");
    const entry = (
      await realCtx(
        "fineline",
        { kind: "template", slug: "single-project" },
        { mode: "entry", entryType: "project" },
      )
    ).ctx;
    const loaded = await loadSite("fineline");
    const field = loaded.acf.groups
      .flatMap((g) => g.fields)
      .find((f) => f.key === gallery.attrs.galleryDynamicACFField);
    expect(field?.type).toBe("gallery");
    const bound = blockGallery(gallery, entry);
    expect(bound).toEqual({
      images: [],
      list: `(state.entry.data.${field?.name} ?? [])`,
      lightbox: true,
    });
    const post = [...loaded.model.posts.values()].find(
      (p) => p.type === "project" && Array.isArray(postData(entry, p)[field?.name as string]),
    ) as WpPost;
    expect(post).toBeDefined();
    const stat = (await realCtx("fineline", { kind: "post", id: post.id }, { mode: "static" })).ctx;
    const fixed = blockGallery(gallery, stat);
    const want = postData(stat, post)[field?.name as string] as { src: string }[];
    expect(fixed?.images.map((i) => i.src)).toEqual(want.map((i) => i.src));
    expect(fixed?.list).toBeUndefined();
  });

  test("an unknown field or a source that is not ACF is reported and gives nothing", async () => {
    const { ctx } = await realCtx(
      "fineline",
      { kind: "template", slug: "single-project" },
      { mode: "entry", entryType: "project" },
    );
    expect(
      blockGallery(
        block("cwicly/gallery", {
          galleryDynamic: "dynamic",
          galleryDynamicType: "acf",
          galleryDynamicACFField: "field_nope",
        }),
        ctx,
      ),
    ).toBeUndefined();
    expect(
      blockGallery(
        block("cwicly/gallery", { galleryDynamic: "dynamic", galleryDynamicType: "woo" }),
        ctx,
      ),
    ).toBeUndefined();
    expect(ctx.report.entries().map((e) => e.code)).toEqual([
      "dynamic.unknown-field",
      "dynamic.unsupported",
    ]);
  });

  test("the figures of a gallery as markup: one per image, linked when it opens a lightbox, escaped", () => {
    const html = galleryMarkup({
      images: [
        { src: "/media/a.jpg", alt: 'A "q" & <b>', width: 10, height: 20 },
        { src: "/media/b.jpg", alt: "" },
      ],
      lightbox: true,
    });
    expect(html).toBe(
      '<figure class="cc-gallery-card"><a href="/media/a.jpg"><img src="/media/a.jpg" alt="A &quot;q&quot; &amp; &lt;b&gt;" width="10" height="20"></a></figure>' +
        '<figure class="cc-gallery-card"><a href="/media/b.jpg"><img src="/media/b.jpg" alt=""></a></figure>',
    );
    expect(galleryMarkup({ images: [{ src: "/m/a.jpg", alt: "x" }], lightbox: false })).toBe(
      '<figure class="cc-gallery-card"><img src="/m/a.jpg" alt="x"></figure>',
    );
  });

  test("a gallery that belongs to the entry is one expression, and an entry with no images prints an empty container", async () => {
    const entry = (
      await realCtx(
        "fineline",
        { kind: "template", slug: "single-project" },
        { mode: "entry", entryType: "project" },
      )
    ).ctx;
    const gallery = await templateBlock(
      "fineline",
      "single-project",
      (b) => b.name === "cwicly/gallery",
    );
    const spec = blockGallery(gallery, entry) as NonNullable<ReturnType<typeof blockGallery>>;
    const markup = galleryMarkup(spec);
    const name = (spec.list as string)
      .replace(/^\(state\.entry\.data\./, "")
      .replace(/ \?\? \[\]\)$/, "");
    expect(evalTemplate(markup, { entry: { data: {} } })).toBe("");
    const out = evalTemplate(markup, {
      entry: {
        data: {
          [name]: [
            { src: "/media/a.jpg", alt: "A & B", width: 5, height: 6 },
            { src: "/media/b.jpg", alt: "" },
          ],
        },
      },
    });
    expect(out).toBe(
      '<figure class="cc-gallery-card"><a href="/media/a.jpg"><img src="/media/a.jpg" alt="A &amp; B" width="5" height="6"></a></figure>' +
        '<figure class="cc-gallery-card"><a href="/media/b.jpg"><img src="/media/b.jpg" alt=""></a></figure>',
    );
  });

  test("every gallery of both sites: its images are the ones of its saved markup", async () => {
    let fixed = 0;
    let dynamic = 0;
    for (const site of ["fineline", "ap"] as const) {
      const loaded = await loadSite(site);
      for (const { sub, ctx } of await preparedFor(site)) {
        walkBlocks(subjectBlocks(loaded, sub), (b) => {
          if (b.name !== "cwicly/gallery") return;
          const spec = blockGallery(b, ctx);
          if (b.attrs.galleryDynamic === "dynamic") {
            dynamic++;
            expect(spec).toBeDefined();
            return;
          }
          fixed++;
          const tags = [...b.innerHTML.matchAll(/<img[^>]*\ssrc="\{image=(\d+)\}"/g)].map((m) =>
            Number(m[1]),
          );
          const available = tags.filter((id) => ctx.mediaFor(id) !== undefined);
          expect(spec?.images.map((i) => i.id)).toEqual(available);
          expect(spec?.lightbox).toBe(b.attrs.linkWrapperType === "lightbox");
        });
      }
    }
    expect({ fixed, dynamic }).toEqual({ fixed: 63, dynamic: 1 });
  });
});

// ── The live pages ───────────────────────────────────────────────────────────────────────────────

const LIVE: Record<SiteName, { file: string; post: number; template: string }[]> = {
  fineline: [
    { file: "about-us", post: 1716, template: "page" },
    { file: "blog", post: 0, template: "index" },
    { file: "choosing-the-best-log-home-stain", post: 3371, template: "single" },
    { file: "home", post: 5246, template: "page" },
    { file: "privacy-policy", post: 3483, template: "page" },
    { file: "residential", post: 195, template: "page" },
  ],
  ap: [
    { file: "essays", post: 0, template: "index" },
    {
      file: "essays__keeshons-story-a-knock-heard-round-the-hood-part-3",
      post: 773,
      template: "single-post",
    },
    { file: "essays__the-cultural-captivity-of-the-gospel", post: 8819, template: "single-post" },
    { file: "essays__the-way-we-live-is-the-way-we-educate", post: 7260, template: "single-post" },
  ],
};

const textOf = (n: N): string => {
  let t = "";
  walkN(n, (x) => {
    if (x.nodeName === "#text") t += x.value ?? "";
  });
  return t.replace(/\s+/g, " ").trim();
};

/** Compare what `blockText` and `blockImage` say with what the live page printed, for the blocks the page shows. */
async function liveOracle(
  site: SiteName,
): Promise<{ texts: number; images: number; textDiffs: string[]; imageDiffs: string[] }> {
  const loaded = await loadSite(site);
  const t = toolsFor(site, loaded);
  const out = { texts: 0, images: 0, textDiffs: [] as string[], imageDiffs: [] as string[] };
  for (const page of LIVE[site]) {
    const post = page.post ? loaded.model.posts.get(page.post) : undefined;
    if (page.post && !post) continue;
    const doc = parse(
      readFileSync(`tests/fixtures/${site}/html/${page.file}.html`, "utf8"),
    ) as unknown as N;
    const byClass = new Map<string, N[]>();
    walkN(doc, (n) => {
      const c = attrsOf(n).class;
      if (c) for (const k of c.split(/\s+/)) byClass.set(k, [...(byClass.get(k) ?? []), n]);
    });
    const subjects: Subject[] = [
      ...(post ? [{ kind: "post", id: post.id } as Subject] : []),
      { kind: "template", slug: page.template },
      ...(["header", "footer", "header-light", "mobile-menu", "top-menu", "comments"] as const)
        .filter((slug) =>
          [...loaded.model.posts.values()].some(
            (p) => p.type === "wp_template_part" && p.slug === slug,
          ),
        )
        .map((slug) => ({ kind: "part", slug }) as Subject),
    ];
    const counts = new Map<string, number>();
    for (const sub of subjects) {
      walkBlocks(subjectBlocks(loaded, sub), (b) => {
        const c = b.attrs.classID;
        if (typeof c === "string") counts.set(c, (counts.get(c) ?? 0) + 1);
      });
    }
    for (const sub of subjects) {
      const { ctx } = await realCtx(site, sub, {
        mode: "static",
        ...(post ? { subject: { kind: "post", id: String(post.id), post } } : {}),
      });
      walkBlocks(subjectBlocks(loaded, sub), (b) => {
        const classID = b.attrs.classID;
        if (!b.name || typeof classID !== "string") return;
        const lives = byClass.get(classID) ?? [];
        if (lives.length !== 1 || counts.get(classID) !== 1) return;
        const live = lives[0] as N;
        if (/^cwicly\/(heading|paragraph|button)$/.test(b.name) && b.innerBlocks.length === 0) {
          const spec = blockText(b, ctx);
          if (!spec) return;
          const saved = shown(
            evalTemplate(resolveTokens(b.innerHTML, ctx, b, { where: "html" }), {}),
          );
          const liveText = textOf(live);
          // Two blocks that share a class id on different pages are told apart by the road that reads the saved
          // markup: only a block that road agrees with the page about is the block the page shows.
          if (saved !== liveText) return;
          out.texts++;
          const mine = shown(
            spec.kind === "text"
              ? escapeText(evalTemplate(spec.value, {}))
              : evalTemplate(spec.value, {}),
          );
          if (mine !== liveText)
            out.textDiffs.push(`${page.file} ${classID}: ${mine} != ${liveText}`);
        }
        if (b.name === "cwicly/image") {
          let img: N | undefined;
          walkN(live, (x) => {
            if (!img && x.nodeName === "img") img = x;
          });
          if (!img) return;
          const spec = blockImage(b, ctx);
          out.images++;
          const A = attrsOf(img);
          const norm = (u?: string): string | undefined =>
            u ? (loaded.media.mediaForUrl(u)?.src ?? t.rewriteUrl(u)) : u;
          const diffs: string[] = [];
          if (norm(spec?.src) !== norm(A.src)) diffs.push("src");
          if (spec && A.alt !== undefined && A.alt !== spec.alt) diffs.push("alt");
          if (
            spec?.width &&
            spec.height &&
            A.width &&
            A.height &&
            Math.abs(
              Number(spec.width) / Number(spec.height) / (Number(A.width) / Number(A.height)) - 1,
            ) > 0.02
          )
            diffs.push("shape");
          if (diffs.length > 0) out.imageDiffs.push(`${classID} ${diffs.join(",")}`);
        }
      });
    }
  }
  return out;
}

describe("the live pages", () => {
  test("fineline: every heading, paragraph and button the page shows has the text blockText makes of it, curly quotes and all", async () => {
    const r = await liveOracle("fineline");
    expect(r.texts).toBeGreaterThanOrEqual(200);
    expect(r.textDiffs).toEqual([]);
  });

  test("fineline: every image has the file and the alt text blockImage says, in the shape the live page printed", async () => {
    const r = await liveOracle("fineline");
    expect(r.images).toBeGreaterThanOrEqual(20);
    expect(r.imageDiffs).toEqual([]);
  });

  test("anabaptistperspectives: the same, apart from the author's own picture, which lives in a user's profile", async () => {
    const r = await liveOracle("ap");
    expect(r.texts).toBeGreaterThanOrEqual(20);
    expect(r.textDiffs).toEqual([]);
    expect(r.images).toBeGreaterThanOrEqual(10);
    expect([...new Set(r.imageDiffs)]).toEqual(["image-c8732a8 src"]);
  });
});

// ── A hostile value, and a post that has no page ─────────────────────────────────────────────────

describe("a value that holds a template cannot run in the build", () => {
  const hostile = "${globalThis.PWNED = 1}";

  test("an image's address, alt text and fallback, and a background's address, are final-form strings", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    Reflect.deleteProperty(globalThis, "PWNED");
    const img = blockImage(
      block("cwicly/image", { imageURL: `https://example.com/${hostile}.jpg`, imageAlt: hostile }),
      ctx,
    );
    expect(img).toBeDefined();
    const strings = [img?.src, img?.alt].map((v) => evalTemplate(v ?? "", {}));
    expect(Reflect.has(globalThis, "PWNED")).toBe(false);
    expect(strings.join("\n")).toContain("$\u200b{globalThis.PWNED = 1}");
    expect(img?.bound).toBe(false);
    const fallback = blockImage(
      block("cwicly/image", {
        imageType: "dynamic",
        dynamic: "wordpress",
        dynamicWordpressType: "authorpicture",
        dynamicStaticFallbackURL: `https://example.com/${hostile}.png`,
      }),
      ctx,
    );
    expect(evalTemplate(fallback?.src ?? "", {})).toContain("$\u200b{globalThis.PWNED = 1}");
    const bg = blockBackground(
      block("cwicly/div", {
        backgroundDynamic: "wordpress",
        backgroundDynamicWordpressType: "authorpicture",
        backgroundImageType: "dynamic",
        backgroundType: { "--": "image" },
        backgroundDynamicStaticFallbackURL: `https://example.com/${hostile}.png`,
      }),
      {
        ...ctx,
        cwicly: {
          ...ctx.cwicly,
          breakpoints: [{ key: "--", width: 0, isMain: true, direction: "none" }],
        },
      },
    );
    expect(evalTemplate(bg?.value ?? "", {})).toContain("$\u200b{globalThis.PWNED = 1}");
    expect(Reflect.has(globalThis, "PWNED")).toBe(false);
  });

  test("a literal ${ in a block's text is split and reported, in the text and in the content of its element", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    const para = block("cwicly/paragraph", { content: "Costs ${5} today" });
    expect(blockText(para, ctx)).toEqual({ kind: "text", value: "Costs $\u200b{5} today" });
    expect(ctx.report.entries().filter((e) => e.code === "token.literal-template")).toHaveLength(1);
    const second = (await realCtx("fineline", { kind: "part", slug: "footer" })).ctx;
    // The content of an element is markup, where the character reference spells it and nothing is lost.
    expect(blockContent(para, second)).toEqual({ innerHTML: "Costs &#36;{5} today" });
  });

  test("text that spells a binding's placeholder is not one", async () => {
    const { ctx } = await realCtx("fineline", { kind: "part", slug: "header" });
    // The base64url of `${globalThis.PWNED = 1}` between the two private-use characters that bracket a placeholder.
    const forged = `\uE000t${Buffer.from("globalThis.PWNED = 1").toString("base64url")}\uE001`;
    Reflect.deleteProperty(globalThis, "PWNED");
    const spec = blockText(block("cwicly/paragraph", { content: `${forged} {sitetitle}` }), ctx);
    const value = spec?.value ?? "";
    expect(value).not.toContain("${");
    expect(evalTemplate(value, {})).not.toContain("PWNED");
    expect(Reflect.has(globalThis, "PWNED")).toBe(false);
    expect(ctx.report.entries().some((e) => e.code === "token.private-use")).toBe(true);
  });
});

describe("an ACF reference to a post the converted site has no page for", () => {
  test("the field is filled, with an empty address, so a condition on it keeps the block", async () => {
    const loaded = await loadSite("ap");
    const info = loaded.acf.groups
      .flatMap((g) => g.fields)
      .find((f) => f.name === "captivate_episode");
    expect(info?.type).toBe("post_object");
    const episodes = [...loaded.model.posts.values()].filter(
      (p) =>
        p.type === "episode" &&
        p.status === "publish" &&
        loaded.model.posts.has(Number(loaded.model.postMeta.get(p.id)?.captivate_episode?.[0])),
    );
    // 91 of the 98 episodes hold one; the fixtures lack three of the podcast posts they name.
    expect(episodes.length).toBeGreaterThanOrEqual(88);
    const { ctx } = await realCtx("ap", { kind: "post", id: episodes[0]?.id ?? 0 });
    // The routes module has no page for the podcast posts these fields hold.
    const target = Number(loaded.model.postMeta.get(episodes[0]?.id ?? 0)?.captivate_episode?.[0]);
    expect(ctx.urlFor("post", target)).toBeUndefined();
    for (const episode of episodes) {
      const held = postData(ctx, episode).captivate_episode as
        | { id: number; url: string }[]
        | { id: number; url: string };
      expect(held).toBeDefined();
      expect([held].flat()[0]?.url).toBe("");
    }
    expect(ctx.report.entries().some((e) => e.code === "dynamic.unrouted-reference")).toBe(true);
  });
});

// END OF PART 5
