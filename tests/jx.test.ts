/**
 * The jx command-line wrappers: what `jx validate` and `jx build` print, read back as issues, and the
 * commands themselves run against the installed binary on real (tiny) projects.
 *
 * The output samples are copied from real runs of the installed `@jxsuite/compiler` (the bad page
 * below was validated and built with `jx validate` / `jx build`), so a change in the CLI's wording
 * turns these red instead of silently producing an empty report.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addIssues,
  buildProgress,
  buildProject,
  buildTimeoutFor,
  DEFAULT_JX_BIN,
  generateSchema,
  installDependencies,
  launcher,
  MIN_BUILD_TIMEOUT_MS,
  parseBuildOutput,
  parseValidateOutput,
  runJx,
  validateProject,
  type JxIssue,
  type JxLineListener,
} from "../src/jx.ts";
import { createReport } from "../src/report.ts";
import { cleanupJxProjects, TMP_ROOT, writeJxProject } from "./helpers/jx-build.ts";

const scratch: string[] = [];
afterAll(() => {
  cleanupJxProjects();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway directory under `.dev/tmp` for a fake jx binary. */
function fakeDir(): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, "fakejx-"));
  scratch.push(dir);
  return dir;
}

function fakeBin(script: string): string {
  const path = join(fakeDir(), "jx.js");
  writeFileSync(path, script);
  return path;
}

const NOISE = [
  'unknown format "uri-reference" ignored in schema at path "#/properties/build/properties/headers/properties/security/properties/csp/oneOf/2/properties/reportUri"',
  'unknown format "date-time" ignored in schema at path "#/properties/securityTxt/properties/expires"',
].join("\n");

/** `jx validate` on a project with an unknown key in project.json and a page with a number for text. */
const INVALID = `${NOISE}
Project is INVALID (/work/project):
project.json:
  - /: must NOT have unevaluated properties
pages/index.json:
  - /children/0/textContent: must be string
  - /children/0/textContent: must be object
  - /children/0/textContent: must match exactly one schema in oneOf
  - /children/0: must have required property '$switch'
  - /children/1/children/0/tagName: must be string
  - /children/1/children/0/tagName: must be string
`;

describe("parseValidateOutput", () => {
  test("reads each schema complaint with its file and JSON pointer, and skips the compiler's noise", () => {
    const issues = parseValidateOutput(INVALID);
    expect(issues[0]).toEqual({
      severity: "error",
      code: "jx.validate-error",
      file: "project.json",
      pointer: "/",
      message: "must NOT have unevaluated properties",
    });
    expect(issues.map((i) => `${i.file} ${i.pointer} ${i.message}`)).toContain(
      "pages/index.json /children/0/textContent must be string",
    );
    expect(issues.some((i) => i.message.includes("ignored in schema"))).toBe(false);
    expect(issues.every((i) => i.code === "jx.validate-error" && i.severity === "error")).toBe(
      true,
    );
  });

  test("an identical complaint is listed once (the validator repeats a oneOf's branches)", () => {
    const issues = parseValidateOutput(INVALID);
    const tag = issues.filter((i) => i.pointer === "/children/1/children/0/tagName");
    expect(tag).toHaveLength(1);
    expect(issues).toHaveLength(7 - 1);
  });

  test("identical lint lines are separate elements, so they are counted, not collapsed (lint lines carry no pointer)", () => {
    // Lines as `jx validate` printed them for the anabaptistperspectives project: nine `<a>` with no
    // name in one page are nine elements, and a different file or rule stays its own finding.
    const link =
      "pages/about.json: error: the <a> has no accessible name. [accessibility/interactive-unnamed, WCAG 4.1.2]";
    const text = [
      "Project is valid (49 files checked in /p)",
      ...Array.from({ length: 9 }, () => link),
      "pages/other.json: error: the <a> has no accessible name. [accessibility/interactive-unnamed, WCAG 4.1.2]",
      "pages/about.json: warning: #nav has no :popover-open rule. [popover/no-open-rule]",
      "pages/about.json: warning: #nav has no :popover-open rule. [popover/no-open-rule]",
    ].join("\n");
    const issues = parseValidateOutput(text);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatchObject({ file: "pages/about.json", count: 9 });
    expect(issues[1]!.count).toBeUndefined();
    expect(issues[2]).toMatchObject({ rule: "popover/no-open-rule", count: 2 });
    // The report says so too: the count is in the data and in the message a person reads.
    const report = createReport();
    addIssues(report, issues);
    expect(report.entries()[0]).toMatchObject({
      message: "the <a> has no accessible name. (×9)",
      data: { count: 9, rule: "accessibility/interactive-unnamed" },
    });
    expect(report.entries()[1]!.data).not.toHaveProperty("count");
  });

  test("two identical lint findings in a real project are counted once each, not once", async () => {
    const r = await validateProject(
      writeJxProject({
        "pages/index.json": {
          title: "x",
          children: [
            { tagName: "img", attributes: { src: "/a.png" } },
            { tagName: "img", attributes: { src: "/b.png" } },
          ],
        },
      }),
    );
    const lint = r.issues.filter((i) => i.code === "jx.validate-lint");
    expect(lint).toHaveLength(1);
    expect(lint[0]).toMatchObject({ rule: "accessibility/img-alt-missing", count: 2 });
  });

  test("a pointer that holds a colon and a space (a media query key) is not cut at it", () => {
    const issues = parseValidateOutput(
      "Project is INVALID (/p):\npages/index.json:\n  - /style/@(min-width: 782px)/color: must be string\n",
    );
    expect(issues).toEqual([
      {
        severity: "error",
        code: "jx.validate-error",
        file: "pages/index.json",
        pointer: "/style/@(min-width: 782px)/color",
        message: "must be string",
      },
    ]);
  });

  test("a lint finding keeps its file, rule and message; an error is a warning unless strict", () => {
    const text =
      "Project is valid (5 files checked in /p)\npages/index.json: error: the <img> has no alt text. [accessibility/img-alt-missing, WCAG 1.1.1]\ncomponents/x.json: warning: #nav has no :popover-open rule. [popover/no-open-rule]\n";
    const lax = parseValidateOutput(text);
    expect(lax).toEqual([
      {
        severity: "warn",
        code: "jx.validate-lint",
        file: "pages/index.json",
        rule: "accessibility/img-alt-missing",
        message: "the <img> has no alt text.",
      },
      {
        severity: "info",
        code: "jx.validate-lint",
        file: "components/x.json",
        rule: "popover/no-open-rule",
        message: "#nav has no :popover-open rule.",
      },
    ]);
    expect(parseValidateOutput(text, { strict: true })[0]!.severity).toBe("error");
  });

  test("a document jx cannot read aborts the run with one line, which is an error without a file", () => {
    expect(
      parseValidateOutput(
        "Validation failed: Expected property name or '}' in JSON at position 2 (line 1 column 3)\n",
      ),
    ).toEqual([
      {
        severity: "error",
        code: "jx.validate-failed",
        message: "Expected property name or '}' in JSON at position 2 (line 1 column 3)",
      },
    ]);
  });

  test("a valid project prints nothing worth reporting", () => {
    expect(parseValidateOutput(`${NOISE}\nProject is valid (5 files checked in /p)\n`)).toEqual([]);
  });

  test("a complaint with no pointer still names its file", () => {
    const issues = parseValidateOutput(
      "Project is INVALID (/p):\ncomponents/a.json:\n  - something odd\n",
    );
    expect(issues).toEqual([
      {
        severity: "error",
        code: "jx.validate-error",
        file: "components/a.json",
        message: "something odd",
      },
    ]);
  });
});

describe("parseBuildOutput", () => {
  const FAILED_STDERR = `Building site from /p...
Error compiling /: Failed to parse Jx document at /p/pages/index.json: Expected property name or '}' in JSON at position 2 (line 1 column 3)
sitemap.xml skipped — set \`url\` in project.json to enable sitemap generation.

Build completed with 1 error(s):
  - Error compiling /: Failed to parse Jx document at /p/pages/index.json: Expected property name or '}' in JSON at position 2 (line 1 column 3)
`;

  test("a failed build is one error per listed error, with the route it names", () => {
    const { issues, summary } = parseBuildOutput("Building site from /p...\n", FAILED_STDERR);
    expect(issues).toEqual([
      {
        severity: "error",
        code: "jx.build-error",
        route: "/",
        message:
          "Error compiling /: Failed to parse Jx document at /p/pages/index.json: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
      },
    ]);
    expect(summary).toEqual({});
  });

  test("a good build reports its totals and its warnings, and nothing of its progress", () => {
    const { issues, summary } = parseBuildOutput(
      "Building site from /p...\nLoading project.json...\nDone: 568 routes → 1313 files\n",
      'The redirect "/search" collides with a compiled page at the same route — remove one or the other.\nReferenced asset not found: /media/a.jpg\nsitemap.xml skipped — set `url` in project.json to enable sitemap generation.\n',
    );
    expect(summary).toEqual({ routes: 568, files: 1313 });
    expect(issues.map((i) => [i.severity, i.code, i.message])).toEqual([
      [
        "warn",
        "jx.build-warning",
        'The redirect "/search" collides with a compiled page at the same route — remove one or the other.',
      ],
      ["warn", "jx.build-warning", "Referenced asset not found: /media/a.jpg"],
    ]);
  });

  test("a build that aborts before its summary is `jx.build-failed`; a live error that is never listed still counts", () => {
    expect(parseBuildOutput("", "Build failed: no project.json in /p\n").issues).toEqual([
      { severity: "error", code: "jx.build-failed", message: "no project.json in /p" },
    ]);
    const live = parseBuildOutput("", "Error compiling /a/: boom\n").issues;
    expect(live).toEqual([
      {
        severity: "error",
        code: "jx.build-error",
        route: "/a/",
        message: "Error compiling /a/: boom",
      },
    ]);
  });

  test("an error jx prints live and lists again at the end is one error, not an error and a warning", () => {
    const message =
      '/de/about/ and /about/ are both the "de" version of "about". A translation set names one URL per language.';
    const { issues } = parseBuildOutput(
      "",
      `Building site from /p...\n${message}\n\nBuild completed with 1 error(s):\n  - ${message}\n`,
    );
    expect(issues).toEqual([{ severity: "error", code: "jx.build-error", message }]);
  });

  test("the `Warning:` prefix jx adds is dropped", () => {
    expect(
      parseBuildOutput("", "Warning: dynamic route /x/:id has no $paths — skipping\n").issues[0]!
        .message,
    ).toBe("dynamic route /x/:id has no $paths — skipping");
  });
});

describe("launcher", () => {
  test("the binary runs as itself where node exists, and under Bun where it does not (a Bun-only machine)", () => {
    const bin = "/p/node_modules/.bin/jx";
    expect(launcher(bin, () => "/usr/bin/node")).toEqual([bin]);
    expect(launcher(bin, () => null)).toEqual([process.execPath, bin]);
  });

  test("a script is always run by Bun, whether or not node exists", () => {
    for (const script of ["/p/jx.js", "/p/jx.mjs", "/p/jx.cjs", "/p/jx.ts"]) {
      expect(launcher(script, () => "/usr/bin/node")).toEqual([process.execPath, script]);
    }
  });

  test("by default it asks the machine's own PATH", () => {
    const expected = Bun.which("node") === null ? [process.execPath, "/p/jx"] : ["/p/jx"];
    expect(launcher("/p/jx")).toEqual(expected);
  });
});

describe("runJx", () => {
  test("runs the installed binary in a directory and returns its streams, code and time", async () => {
    expect(existsSync(DEFAULT_JX_BIN)).toBe(true);
    const dir = writeJxProject({ "pages/index.json": { title: "x", children: [] } });
    const run = await runJx(dir, ["schema"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Wrote project.schema.json");
    expect(run.ms).toBeGreaterThan(0);
    expect(run.timedOut).toBe(false);
  });

  test("a command that fails is a result, not a throw", async () => {
    const dir = fakeDir();
    const run = await runJx(dir, ["build"]);
    expect(run.code).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain("project.json");
  });

  test("a binary that does not exist throws, naming it", async () => {
    await expect(runJx(fakeDir(), ["build"], { bin: "/nonexistent/jx" })).rejects.toThrow(
      "/nonexistent/jx",
    );
  });

  test("a command that takes too long is stopped: code 124, timedOut, and the issue says so", async () => {
    const bin = fakeBin("await new Promise((r) => setTimeout(r, 10000));");
    const run = await runJx(fakeDir(), ["build"], { bin, timeoutMs: 300 });
    expect(run.timedOut).toBe(true);
    expect(run.code).toBe(124);
    const built = await buildProject(fakeDir(), { bin, timeoutMs: 300 });
    expect(built.ok).toBe(false);
    expect(built.issues.map((i) => i.code)).toContain("jx.timeout");
    // The message names the limit the build was given, and a build says what to do about it.
    const timeout = built.issues.find((i) => i.code === "jx.timeout")!;
    expect(timeout.message).toContain("the limit it was given (0 s)");
    expect(timeout.message).toContain("longer build timeout");
    const validated = await validateProject(fakeDir(), { bin, timeoutMs: 300 });
    expect(validated.issues.find((i) => i.code === "jx.timeout")!.message).not.toContain(
      "build timeout",
    );
  });

  test("the limit a command ran under is in its result: five minutes, and a build is never given less than half an hour", async () => {
    const bin = fakeBin("console.log('Done: 1 routes → 1 files');");
    const dir = fakeDir();
    expect((await runJx(dir, ["x"], { bin })).timeoutMs).toBe(5 * 60_000);
    expect((await validateProject(dir, { bin })).run.timeoutMs).toBe(5 * 60_000);
    expect((await buildProject(dir, { bin })).run.timeoutMs).toBe(MIN_BUILD_TIMEOUT_MS);
    expect(MIN_BUILD_TIMEOUT_MS).toBe(30 * 60_000);
    expect((await buildProject(dir, { bin, timeoutMs: 90 * 60_000 })).run.timeoutMs).toBe(
      90 * 60_000,
    );
    // A shorter one asked for is the caller's to ask for.
    expect((await buildProject(dir, { bin, timeoutMs: 1_000 })).run.timeoutMs).toBe(1_000);
  });

  test("the arguments reach the binary and the environment is the caller's plus NO_COLOR", async () => {
    const bin = fakeBin(
      "console.log(JSON.stringify({ args: process.argv.slice(2), color: process.env.NO_COLOR, extra: process.env.WP2JX_X }));",
    );
    const run = await runJx(fakeDir(), ["a", "--b"], { bin, env: { WP2JX_X: "1" } });
    expect(JSON.parse(run.stdout)).toEqual({ args: ["a", "--b"], color: "1", extra: "1" });
  });
});

describe("runJx streams what the command prints", () => {
  const heard = (): { lines: [string, string][]; listener: JxLineListener } => {
    const lines: [string, string][] = [];
    return { lines, listener: (line, stream) => void lines.push([stream, line]) };
  };

  test("a line is heard while the command is still running, not when it has finished", async () => {
    const bin = fakeBin(
      'console.log("first"); await new Promise((r) => setTimeout(r, 1500)); console.log("second");',
    );
    let first: (() => void) | undefined;
    const sawFirst = new Promise<void>((resolve) => (first = resolve));
    const lines: string[] = [];
    let finished = false;
    const run = runJx(fakeDir(), ["x"], {
      bin,
      onLine: (line) => {
        lines.push(line);
        if (line === "first") first?.();
      },
    }).finally(() => (finished = true));
    await sawFirst;
    expect(finished).toBe(false);
    const result = await run;
    expect(lines).toEqual(["first", "second"]);
    expect(result.stdout).toBe("first\nsecond\n");
  });

  test("each stream is named, a Windows line break is not part of the line, and the last line needs no line break", async () => {
    const bin = fakeBin(
      'process.stdout.write("a\\r\\nb\\nlast"); process.stderr.write("warned\\nand more");',
    );
    const { lines, listener } = heard();
    const run = await runJx(fakeDir(), ["x"], { bin, onLine: listener });
    expect(lines.filter(([stream]) => stream === "stdout").map(([, line]) => line)).toEqual([
      "a",
      "b",
      "last",
    ]);
    expect(lines.filter(([stream]) => stream === "stderr").map(([, line]) => line)).toEqual([
      "warned",
      "and more",
    ]);
    // The text is whole and unchanged.
    expect(run.stdout).toBe("a\r\nb\nlast");
    expect(run.stderr).toBe("warned\nand more");
  });

  test("a line split across two reads is one line, and a multi-byte character split across them is whole", async () => {
    const bin = fakeBin(
      [
        'const out = Buffer.from("caf\\u00e9 au lait\\nsecond\\n");',
        "process.stdout.write(out.subarray(0, 4));",
        "await new Promise((r) => setTimeout(r, 300));",
        "process.stdout.write(out.subarray(4));",
      ].join("\n"),
    );
    const { lines, listener } = heard();
    await runJx(fakeDir(), ["x"], { bin, onLine: listener });
    expect(lines).toEqual([
      ["stdout", "café au lait"],
      ["stdout", "second"],
    ]);
  });

  test("a listener that throws costs the run nothing", async () => {
    const bin = fakeBin('console.log("one"); console.log("two"); process.exit(3);');
    let calls = 0;
    const run = await runJx(fakeDir(), ["x"], {
      bin,
      onLine: () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    expect(calls).toBe(2);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("one\ntwo\n");
  });

  test("a build's and an install's lines are heard through the same option", async () => {
    const bin = fakeBin('console.log("Compiling / ...");');
    const build = heard();
    await buildProject(fakeDir(), { bin, onLine: build.listener });
    expect(build.lines).toEqual([["stdout", "Compiling / ..."]]);
    const install = heard();
    await installDependencies(fakeDir(), {
      cmd: [process.execPath, bin],
      onLine: install.listener,
    });
    expect(install.lines).toEqual([["stdout", "Compiling / ..."]]);
  });
});

describe("buildTimeoutFor", () => {
  test("never less than half an hour, however little media there is", () => {
    expect(buildTimeoutFor({ files: 0 })).toBe(MIN_BUILD_TIMEOUT_MS);
    expect(buildTimeoutFor({ files: 12 })).toBe(MIN_BUILD_TIMEOUT_MS);
    expect(buildTimeoutFor({ files: -5 })).toBe(MIN_BUILD_TIMEOUT_MS);
  });

  test("grows with the number of media files once they would not fit in it, and never shrinks as they grow", () => {
    expect(buildTimeoutFor({ files: 755 })).toBeGreaterThan(MIN_BUILD_TIMEOUT_MS);
    let last = 0;
    for (const files of [0, 100, 300, 500, 755, 1500, 5000]) {
      const timeout = buildTimeoutFor({ files });
      expect(timeout).toBeGreaterThanOrEqual(last);
      last = timeout;
    }
    expect(buildTimeoutFor({ files: 5000 })).toBeGreaterThan(buildTimeoutFor({ files: 1500 }));
  });
});

describe("buildProgress", () => {
  test("counts the images jx encodes and says so once in a while, with the one it is on", () => {
    const said: string[] = [];
    const hear = buildProgress((message) => void said.push(message), 10);
    for (let i = 1; i <= 25; i++) hear(`    Optimizing photo-${i}.jpg...`, "stdout");
    expect(said).toEqual([
      "optimising images: 1 so far (now photo-1.jpg)",
      "optimising images: 10 so far (now photo-10.jpg)",
      "optimising images: 20 so far (now photo-20.jpg)",
    ]);
  });

  test("every other line is passed on as it is, and a blank one is not", () => {
    const said: string[] = [];
    const hear = buildProgress((message) => void said.push(message));
    hear("Loading project.json...", "stdout");
    hear("", "stdout");
    hear("   ", "stderr");
    hear("  Compiling /about/ ...", "stdout");
    expect(said).toEqual(["Loading project.json...", "Compiling /about/ ..."]);
  });
});

describe("generateSchema", () => {
  test("writes the two schemas", async () => {
    const dir = writeJxProject({ "pages/index.json": { title: "x", children: [] } });
    const r = await generateSchema(dir);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, "project.schema.json"))).toBe(true);
    expect(existsSync(join(dir, "document.schema.json"))).toBe(true);
  });

  test("a failing `jx schema` is one `jx.schema-failed` issue with what jx said", async () => {
    const bin = fakeBin(
      'console.error("Schema generation failed: no extensions"); process.exit(1);',
    );
    const r = await generateSchema(fakeDir(), { bin });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      {
        severity: "error",
        code: "jx.schema-failed",
        message: "Schema generation failed: no extensions",
      },
    ]);
  });
});

describe("validateProject", () => {
  test("a valid project is ok, has no issues, and is left as it was (no schema files)", async () => {
    const dir = writeJxProject({
      "pages/index.json": { title: "x", children: [{ tagName: "p", textContent: "hi" }] },
    });
    const r = await validateProject(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.generated).toBe(true);
    expect(existsSync(join(dir, "project.schema.json"))).toBe(false);
    expect(existsSync(join(dir, "document.schema.json"))).toBe(false);
  });

  test("keepSchema leaves the schemas it had to generate; a project that already has them keeps them", async () => {
    const dir = writeJxProject({
      "pages/index.json": { title: "x", children: [{ tagName: "p", textContent: "hi" }] },
    });
    const kept = await validateProject(dir, { keepSchema: true });
    expect(kept.generated).toBe(true);
    expect(existsSync(join(dir, "project.schema.json"))).toBe(true);
    const again = await validateProject(dir);
    expect(again.generated).toBe(false);
    expect(existsSync(join(dir, "project.schema.json"))).toBe(true);
  });

  test("a wrong page is `jx.validate-error` with its file and pointer, and the project is not ok", async () => {
    const dir = writeJxProject({
      "pages/index.json": { title: "x", children: [{ tagName: "p", textContent: 5 }] },
    });
    const r = await validateProject(dir);
    expect(r.ok).toBe(false);
    const hit = r.issues.find((i) => i.pointer === "/children/0/textContent");
    expect(hit).toMatchObject({
      code: "jx.validate-error",
      severity: "error",
      file: "pages/index.json",
      message: "must be string",
    });
    expect(existsSync(join(dir, "project.schema.json"))).toBe(false);
  });

  test("a project.json key the schema does not know is an error at `/`", async () => {
    const dir = writeJxProject({
      "project.json": { name: "x", bogus: 1 },
      "pages/index.json": { title: "x", children: [] },
    });
    const r = await validateProject(dir);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ file: "project.json", pointer: "/" });
  });

  test("a document jx cannot parse stops the run: one `jx.validate-failed`", async () => {
    const dir = writeJxProject({ "pages/index.json": "{ not json" });
    const r = await validateProject(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["jx.validate-failed"]);
    expect(r.issues[0]!.message).toContain("JSON");
  });

  test("a lint error does not fail a plain validate (jx exits 0) but fails `strict`", async () => {
    const files = {
      "pages/index.json": {
        title: "x",
        children: [{ tagName: "img", attributes: { src: "/a.png" } }],
      },
    };
    const lax = await validateProject(writeJxProject(files));
    expect(lax.ok).toBe(true);
    expect(lax.issues).toMatchObject([
      { code: "jx.validate-lint", severity: "warn", rule: "accessibility/img-alt-missing" },
    ]);
    const strict = await validateProject(writeJxProject(files), { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.issues[0]).toMatchObject({ code: "jx.validate-lint", severity: "error" });
  });

  test("`strict` is a flag jx gets, so its own exit code agrees with the issues", async () => {
    const dir = writeJxProject({ "pages/index.json": { title: "x", children: [] } });
    writeFileSync(join(dir, "project.schema.json"), "{}");
    const bin = fakeBin("console.log(JSON.stringify(process.argv.slice(2)));");
    expect((await validateProject(dir, { bin })).run.stdout.trim()).toBe('["validate"]');
    expect((await validateProject(dir, { bin, strict: true })).run.stdout.trim()).toBe(
      '["validate","--strict"]',
    );
  });

  test("a jx that fails without a word is still an error", async () => {
    const dir = writeJxProject({ "pages/index.json": { title: "x", children: [] } });
    writeFileSync(join(dir, "project.schema.json"), "{}");
    const bin = fakeBin("process.exit(3);");
    const r = await validateProject(dir, { bin });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      {
        severity: "error",
        code: "jx.validate-failed",
        message: "jx validate exited with 3 and printed no finding",
      },
    ]);
  });

  test("when the schema cannot be generated the validation is not attempted", async () => {
    const bin = fakeBin('console.error("Schema generation failed: boom"); process.exit(1);');
    const dir = fakeDir();
    const r = await validateProject(dir, { bin });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["jx.schema-failed"]);
  });
});

describe("buildProject", () => {
  test("a good project builds: ok, the routes and files it wrote, and a dist/", async () => {
    const dir = writeJxProject({
      "pages/index.json": { title: "x", children: [{ tagName: "p", textContent: "hi" }] },
      "pages/about.json": { title: "y", children: [] },
    });
    const r = await buildProject(dir);
    expect(r.ok).toBe(true);
    expect(r.summary.routes).toBe(2);
    expect(r.summary.files).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(dir, "dist/index.html"))).toBe(true);
  });

  test("a page jx cannot parse is `jx.build-error` at its route, and the build is not ok", async () => {
    const dir = writeJxProject({ "pages/index.json": "{ bad" });
    const r = await buildProject(dir);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: "jx.build-error", route: "/", severity: "error" });
    expect(r.issues[0]!.message).toContain("pages/index.json");
  });

  test("a redirect that collides with a page is a warning, not a failure", async () => {
    const dir = writeJxProject({
      "project.json": { name: "x", url: "https://example.com", redirects: { "/about": "/" } },
      "pages/index.json": { title: "x", children: [] },
      "pages/about.json": { title: "y", children: [] },
    });
    const r = await buildProject(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toMatchObject([{ severity: "warn", code: "jx.build-warning" }]);
    expect(r.issues[0]!.message).toContain('"/about"');
  });

  test("a jx that exits non-zero and says nothing is `jx.build-failed`", async () => {
    const bin = fakeBin("process.exit(2);");
    const r = await buildProject(fakeDir(), { bin });
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      {
        severity: "error",
        code: "jx.build-failed",
        message: "jx build exited with 2 and printed no error",
      },
    ]);
  });

  test("--verbose and --no-clean reach jx", async () => {
    const bin = fakeBin("console.log(JSON.stringify(process.argv.slice(2)));");
    const r = await buildProject(fakeDir(), { bin, verbose: true, noClean: true });
    expect(JSON.parse(r.run.stdout)).toEqual(["build", "--verbose", "--no-clean"]);
  });
});

describe("addIssues", () => {
  test("puts each issue in the report at its file, with the pointer and rule as data", () => {
    const report = createReport();
    addIssues(report, [
      {
        severity: "error",
        code: "jx.validate-error",
        file: "pages/a.json",
        pointer: "/children/0",
        message: "must be string",
      },
      {
        severity: "warn",
        code: "jx.validate-lint",
        file: "pages/b.json",
        rule: "accessibility/x",
        message: "m",
      },
      { severity: "error", code: "jx.build-error", route: "/x/", message: "boom" },
      { severity: "error", code: "jx.validate-failed", message: "no file" },
    ]);
    expect(report.entries()).toEqual([
      {
        severity: "error",
        code: "jx.validate-error",
        message: "must be string",
        where: "pages/a.json",
        data: { pointer: "/children/0" },
      },
      {
        severity: "warn",
        code: "jx.validate-lint",
        message: "m",
        where: "pages/b.json",
        data: { rule: "accessibility/x" },
      },
      {
        severity: "error",
        code: "jx.build-error",
        message: "boom",
        where: "/x/",
        data: { route: "/x/" },
      },
      {
        severity: "error",
        code: "jx.validate-failed",
        message: "no file",
        where: "project",
        data: {},
      },
    ]);
  });

  test("a file with more complaints than the limit is cut, and the cut is said once", () => {
    const issues: JxIssue[] = Array.from({ length: 7 }, (_, i) => ({
      severity: "error" as const,
      code: "jx.validate-error",
      file: "pages/a.json",
      pointer: `/children/${i}`,
      message: "must be string",
    }));
    issues.push({
      severity: "error",
      code: "jx.validate-error",
      file: "pages/b.json",
      pointer: "/",
      message: "m",
    });
    const report = createReport();
    addIssues(report, issues, { perFile: 3 });
    const entries = report.entries();
    expect(
      entries.filter((e) => e.where === "pages/a.json" && e.code === "jx.validate-error"),
    ).toHaveLength(3);
    expect(entries.filter((e) => e.where === "pages/b.json")).toHaveLength(1);
    const cut = entries.filter((e) => e.code === "jx.validate-truncated");
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({
      severity: "info",
      where: "pages/a.json",
      data: { code: "jx.validate-error", omitted: 4 },
    });
  });
});

describe("installDependencies", () => {
  test("`bun install` in a project with nothing to install succeeds, and runs in that directory", async () => {
    const dir = writeJxProject({ "package.json": { name: "t", private: true } });
    const r = await installDependencies(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.run.code).toBe(0);
  });

  test("the command runs in the project directory, with no colour", async () => {
    const bin = fakeBin(
      "console.log(JSON.stringify({ cwd: process.cwd(), color: process.env.NO_COLOR, args: process.argv.slice(2) }));",
    );
    const dir = fakeDir();
    const r = await installDependencies(dir, { cmd: [process.execPath, bin, "x"] });
    const out = JSON.parse(r.run.stdout) as { cwd: string; color: string; args: string[] };
    expect(realpathSync(out.cwd)).toBe(realpathSync(dir));
    expect(out.color).toBe("1");
    expect(out.args).toEqual(["x"]);
  });

  test("a failed install is `jx.install-failed` with the last of what it said", async () => {
    const bin = fakeBin(
      [
        'console.error("fetching");',
        'console.error("resolving");',
        "console.error('error: package \"nope\" not found');",
        'console.error("error: install failed");',
        "process.exit(1);",
      ].join("\n"),
    );
    const r = await installDependencies(fakeDir(), { cmd: [process.execPath, bin] });
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ severity: "error", code: "jx.install-failed" });
    expect(r.issues[0]!.message).toContain("install failed");
    expect(r.issues[0]!.message).not.toContain("fetching");
  });

  test("an install that says nothing and fails is still named, with its exit code", async () => {
    const bin = fakeBin("process.exit(7);");
    const r = await installDependencies(fakeDir(), { cmd: [process.execPath, bin] });
    expect(r.issues).toEqual([
      { severity: "error", code: "jx.install-failed", message: "the install exited with 7" },
    ]);
  });

  test("an install that takes too long is stopped and says so", async () => {
    const bin = fakeBin("await new Promise((r) => setTimeout(r, 10000));");
    const r = await installDependencies(fakeDir(), {
      cmd: [process.execPath, bin],
      timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    expect(r.run.timedOut).toBe(true);
    expect(r.run.code).toBe(124);
    expect(r.issues.map((i) => i.code)).toEqual(["jx.timeout"]);
  });
});
