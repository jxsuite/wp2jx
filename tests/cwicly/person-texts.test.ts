/**
 * A person's biography in a list of people binds the text the converter writes beside it on the person
 * (`bioText`) only where the rows of the list carry it, whatever wrote them: the people a query names,
 * the people an ACF user field of a static page holds now, and the people of an entry the collections
 * module writes. A page layout's list may read the page's own entry, which carries no text: it keeps the
 * expression. The query and the biography paragraph are AP's own (the single-episode template).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { loadSite, makeCtx, type Subject } from "../helpers/ctx.ts";
import { convertBlocks, withOverrides } from "../../src/convert.ts";
import { createReport } from "../../src/report.ts";
import { setUserProfiles } from "../../src/wp/profiles.ts";
import { collectedState } from "../../src/cwicly/blocks/data.ts";
import { basicReferencesExpr } from "../../src/cwicly/tokens.ts";
import type { ConvertCtx, WpBlock } from "../../src/types.ts";

setDefaultTimeout(120_000);

function block(
  name: string,
  attrs: Record<string, unknown>,
  inner: WpBlock[],
  html: string,
): WpBlock {
  return {
    name,
    attrs,
    innerBlocks: inner,
    innerHTML: html,
    innerContent: inner.length === 0 ? [html] : [html, ...inner.map(() => null)],
  };
}

/** AP's list of an episode's guests: a users query over the ACF user field, printing each biography. */
const guests = (): WpBlock => {
  const bio = block(
    "cwicly/paragraph",
    {
      uniqueID: "4904550b",
      classID: "paragraph-c48a20d",
      id: "paragraph-c490455",
      dynamic: "acf",
      dynamicACFGroup: "group_62d867cf8558a",
      dynamicACFField: "field_62d867cf871e7",
      dynamicACFFieldLocation: "userquery",
    },
    [],
    '<p id="paragraph-c490455{idadd}" class="paragraph-c48a20d"><ccdyn></ccdyn></p>',
  );
  const template = block(
    "cwicly/query-template",
    { uniqueID: "qt", classID: "qt", id: "qt" },
    [bio],
    '<div id="qt{idadd}" class="qt" cc-query-template=""><ccdyn></ccdyn></div>',
  );
  return block(
    "cwicly/query",
    {
      uniqueID: "q",
      classID: "q",
      id: "q",
      queryId: 7,
      queryInherit: false,
      queryType: "users",
      queryInclude: {
        source: "dynamic",
        type: "acf",
        group: "g",
        field: "field_62d867cf7c18b",
        fallback: "",
      },
    },
    [template],
    '<div id="q{idadd}" class="q" data-query_id="7"><ccdyn></ccdyn></div>',
  );
};

/** The guests of episode 11212, each given a biography with a character reference in it. */
async function convert(
  subject: Subject,
  over: Partial<ConvertCtx>,
): Promise<{ out: string; state: Record<string, unknown> }> {
  const site = await loadSite("ap");
  const ids = [201, 226];
  const profiles = new Map(
    ids.map((id) => [
      id,
      {
        id,
        slug: site.model.users.get(id)?.slug ?? `u${id}`,
        displayName: `U${id}`,
        meta: { bio: `Bio of ${id} &amp; co` },
        roles: [],
      },
    ]),
  );
  const real = await makeCtx("ap", subject, over);
  setUserProfiles(real.model, profiles as never);
  const ctx = {
    ...real,
    report: createReport(),
    defineState: undefined,
    hoist: () => undefined,
    hoisted: [],
  } as unknown as ConvertCtx;
  ctx.convert = (blocks, more) => convertBlocks(blocks, more ? withOverrides(ctx, more) : ctx);
  const out = JSON.stringify(convertBlocks([guests()], ctx));
  return { out, state: Object.fromEntries(collectedState(ctx)) };
}

describe("a person's biography in a list of people", () => {
  test("a static page's people from its user field carry the text the binding reads", async () => {
    const { out, state } = await convert(
      { kind: "post", id: 11212 },
      { mode: "static", target: "page" },
    );
    expect(out).toContain("${$map.item?.bioText ?? ''}");
    const rows = Object.entries(state).find(([k]) => k.startsWith("users_q"))?.[1] as
      | Record<string, unknown>[]
      | undefined;
    expect(rows?.length).toBeGreaterThan(0);
    for (const row of rows ?? []) {
      expect(row.bio).toBe(`<p>Bio of ${String(row.id)} &amp; co</p>\n`);
      expect(row.bioText).toBe(`<p>Bio of ${String(row.id)} & co</p>\n`);
    }
  });

  test("a page layout, whose list may read the page's own entry, keeps the expression", async () => {
    const { out } = await convert(
      { kind: "template", slug: "single-episode" },
      { mode: "entry", entryExpr: "state.entry", entryType: "page", target: "page" },
    );
    expect(out).not.toContain("bioText");
    // The list is a computed one here, its row `$i0`: the expression reads the references of the field.
    expect(out).toContain(JSON.stringify(basicReferencesExpr("$i0?.bio ?? ''")).slice(1, -1));
  });
});
