import { describe, expect, test } from "bun:test";
import {
  colorVariableCollisions,
  isColorVariableText,
  renameColorVariables,
} from "../../src/emit/color-vars.ts";

describe("renameColorVariables", () => {
  test("a colour, a shade, a variant, the HSL twin and the background lose Cwicly's cc-", () => {
    expect(
      renameColorVariables(
        ".a{color:var(--cc-color-1);background:var(--cc-color-1-500);border-color:var(--cc-color-1-lt-10)}",
      ),
    ).toBe(
      ".a{color:var(--color-1);background:var(--color-1-500);border-color:var(--color-1-lt-10)}",
    );
    expect(renameColorVariables('{"--cc-color-2":"#fff","--cc-color-2-hsl":"0 0% 100%"}')).toBe(
      '{"--color-2":"#fff","--color-2-hsl":"0 0% 100%"}',
    );
    expect(renameColorVariables(":root{--cc-color-background:#ffffff}")).toBe(
      ":root{--color-background:#ffffff}",
    );
  });

  test("other properties, class names and longer identifiers are left as written", () => {
    for (const text of [
      "var(--cc-nav-link-color)",
      "var(--cc-gradient-1)",
      "has-cc-color-1-background-color",
      "var(--x--cc-color-1)",
      "var(--color-ruaij)",
    ]) {
      expect(renameColorVariables(text)).toBe(text);
    }
  });
});

describe("isColorVariableText", () => {
  test("the project's text files, not its media or fonts", () => {
    expect(
      ["project.json", "public/css/cwicly-global.css", "pages/a.md"].every(isColorVariableText),
    ).toBe(true);
    expect(["public/media/a.jpg", "public/fonts/a.woff2"].some(isColorVariableText)).toBe(false);
  });
});

describe("colorVariableCollisions", () => {
  test("a renamed variable the palette already declares under its own name, once and sorted", () => {
    expect(
      colorVariableCollisions([
        "--cc-color-2",
        "--color-2",
        "--cc-color-1",
        "--color-1",
        "--cc-color-1",
        "--cc-color-3",
        "--color-ruaij",
      ]),
    ).toEqual([
      ["--color-1", "--cc-color-1"],
      ["--color-2", "--cc-color-2"],
    ]);
    expect(colorVariableCollisions(["--cc-color-1", "--color-ruaij"])).toEqual([]);
  });
});
