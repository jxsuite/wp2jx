import { describe, expect, test } from "bun:test";
import {
  contextContains,
  flattenElementStyle,
  flattenProjectStyle,
  OrderedStyle,
  resolveNested,
} from "../../src/emit/style-order.ts";

const MEDIA = { "--md": "(max-width: 992px)", "--sm": "(max-width: 576px)" };

describe("resolveNested", () => {
  test("compounds, descends and distributes over lists, as Jx resolves a nested key", () => {
    expect(resolveNested(".a", ":hover")).toBe(".a:hover");
    expect(resolveNested(".a", ".b")).toBe(".a.b");
    expect(resolveNested(".a", "svg")).toBe(".a svg");
    expect(resolveNested(".a, .b", "& p, &:hover")).toBe(".a p, .a:hover, .b p, .b:hover");
    expect(resolveNested("&", ".wrap &")).toBe(".wrap &");
  });
});

describe("flattenProjectStyle", () => {
  test("top-level declarations, then every selector block, then every at-rule block, as the site builder emits them", () => {
    const flat = flattenProjectStyle({
      "--color-1": "#fff",
      "@--md": { h1: { fontSize: "2rem" } },
      h1: { fontSize: "3rem", ":hover": { color: "red" } },
      "@keyframes spin": { from: { opacity: "0" } },
      color: "black",
    });
    expect(flat.rules.map((r) => [r.selector, r.context.join(" ")])).toEqual([
      [null, ""],
      ["h1", ""],
      ["h1:hover", ""],
      ["h1", "@--md"],
    ]);
    expect(flat.rules[0]!.declarations).toEqual([
      ["--color-1", "#fff"],
      ["color", "black"],
    ]);
    expect(flat.extras.map(([k]) => k)).toEqual(["@keyframes spin"]);
  });
});

describe("flattenElementStyle", () => {
  test("own declarations first, then nested keys depth first, against &", () => {
    const flat = flattenElementStyle({
      color: "red",
      ":hover": { color: "blue", "@--md": { color: "green" } },
      svg: { fill: "currentColor" },
      "@--sm": { color: "black" },
      "@font-face": [{ fontFamily: "A" }],
    });
    expect(flat.rules.map((r) => [r.selector, r.context.join(" ")])).toEqual([
      ["&", ""],
      ["&:hover", ""],
      ["&:hover", "@--md"],
      ["& svg", ""],
      ["&", "@--sm"],
    ]);
    expect(flat.extras.map(([k]) => k)).toEqual(["@font-face"]);
  });
});

describe("contextContains", () => {
  test("a wider max-width holds wherever a narrower one does, the base holds everywhere, min-width 0 is no condition", () => {
    expect(contextContains([], ["@--sm"], MEDIA)).toBe(true);
    expect(contextContains(["@--md"], ["@--sm"], MEDIA)).toBe(true);
    expect(contextContains(["@--sm"], ["@--md"], MEDIA)).toBe(false);
    expect(contextContains(["@(max-width: 992px)"], ["@--md"], MEDIA)).toBe(true);
    expect(contextContains(["@(min-width: 0px)"], [], MEDIA)).toBe(true);
    expect(contextContains(["@supports (display: grid)"], [], MEDIA)).toBe(false);
  });
});

describe("OrderedStyle", () => {
  test("declarations join their block when nothing later competes with them", () => {
    const style = new OrderedStyle("element", MEDIA);
    style.place("&", [], { property: "color", value: "red", rank: 1 });
    style.place("&:hover", [], { property: "color", value: "blue", rank: 2 });
    style.place("&", [], { property: "padding", value: "1px", rank: 3 });
    expect(style.toStyle()).toEqual({ color: "red", padding: "1px", "&:hover": { color: "blue" } });
    expect(style.aliased).toBe(0);
  });

  test("a later base declaration that an earlier breakpoint block would beat goes after it, under &:where(*)", () => {
    const style = new OrderedStyle("element", MEDIA);
    style.place("&", ["@--sm"], { property: "padding", value: "1rem", rank: 1 });
    style.place("&", [], { property: "paddingTop", value: "60px", rank: 2 });
    expect(style.toStyle()).toEqual({
      "@--sm": { padding: "1rem" },
      "&:where(*)": { paddingTop: "60px" },
    });
    expect(style.aliased).toBe(1);
  });

  test("rules that differ in one attribute's value never meet, so they need no alias", () => {
    const style = new OrderedStyle("element", MEDIA);
    style.place("[dir=left] &::before", [], { property: "transform", value: "x", rank: 1 });
    style.place("[dir=right] &::before", [], { property: "transform", value: "y", rank: 2 });
    style.place("[dir=left] &::before", [], {
      property: "transformOrigin",
      value: "left",
      rank: 3,
    });
    expect(style.aliased).toBe(0);
    expect(style.toStyle()).toEqual({
      "[dir=left] &::before": { transform: "x", transformOrigin: "left" },
      "[dir=right] &::before": { transform: "y" },
    });
  });

  test("project level: a selector rule after an at-rule's goes in an always-true at-rule block when they compete", () => {
    const style = new OrderedStyle("project", MEDIA);
    style.place("h1", ["@--md"], { property: "fontSize", value: "2rem", rank: 1 });
    style.place("h1", [], { property: "fontSize", value: "3rem", rank: 2 });
    style.place("p", [], { property: "margin", value: "0", rank: 3 });
    expect(style.toStyle()).toEqual({
      p: { margin: "0" },
      "@--md": { h1: { fontSize: "2rem" } },
      "@(min-width: 0px)": { h1: { fontSize: "3rem" } },
    });
  });

  test("an earlier !important is not displaced by a later plain value of the same block", () => {
    const style = new OrderedStyle("element", MEDIA);
    style.place("&", [], { property: "color", value: "red !important", rank: 1 });
    style.place("&", [], { property: "color", value: "blue", rank: 2 });
    expect(style.toStyle()).toEqual({ color: "red !important" });
  });
});
