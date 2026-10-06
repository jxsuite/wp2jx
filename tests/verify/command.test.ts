/**
 * The `wp2jx verify` command line: every flag it parses and refuses, the help, and the exit codes
 * (2 for a flag it cannot use, 3 for a run that could not finish) through the real `main`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELP, main, type CliIo } from "../../src/cli.ts";
import { parseVerifyArgs, VERIFY_HELP } from "../../src/verify/command.ts";
import { TMP_ROOT } from "../helpers/jx-build.ts";

function io(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: {}, cwd: "/" },
    out: () => out,
    err: () => err,
  };
}

describe("parseVerifyArgs", () => {
  test("every flag", () => {
    const options = parseVerifyArgs([
      "--out",
      "/p",
      "--live",
      "https://site.test",
      "--urls",
      "all",
      "--max",
      "12",
      "--only",
      "/blog",
      "--viewports",
      "1366, 390,1366",
      "--build",
      "--mask",
      ".a",
      "--mask",
      "#b",
      "--report-dir",
      "/r",
      "--live-cache",
      "/c",
      "--concurrency",
      "3",
      "--images",
      "5",
      "--tolerance",
      "0.2",
      "--jx",
      "/bin/jx",
      "--chrome",
      "/bin/chrome",
    ]);
    expect(options).toEqual({
      out: "/p",
      live: "https://site.test",
      urls: "all",
      max: 12,
      only: "/blog",
      viewports: [1366, 390],
      build: true,
      masks: [".a", "#b"],
      reportDir: "/r",
      liveCache: "/c",
      concurrency: 3,
      images: 5,
      tolerance: 0.2,
      jx: "/bin/jx",
      chrome: "/bin/chrome",
    });
  });

  test("only --out is required, and nothing else is set by default", () => {
    expect(parseVerifyArgs(["--out", "/p"])).toEqual({ out: "/p" });
  });

  test("help short-circuits", () => {
    expect(parseVerifyArgs(["--help"])).toBe("help");
    expect(parseVerifyArgs(["-h"])).toBe("help");
  });

  test.each([
    [[], "--out <project dir> is required"],
    [["--out", " "], "--out <project dir> is required"],
    [["--out", "/p", "extra"], 'unexpected argument "extra"'],
    [
      ["--out", "/p", "--live", "finelinepainting.pro"],
      "--live takes an address starting with http",
    ],
    [["--out", "/p", "--max", "0"], "--max takes a whole number"],
    [["--out", "/p", "--max", "x"], "--max takes a whole number"],
    [["--out", "/p", "--viewports", "100"], "--viewports takes a whole number from 200 to 5000"],
    [["--out", "/p", "--viewports", ","], "at least one width"],
    [["--out", "/p", "--concurrency", "99"], "--concurrency takes a whole number from 1 to 8"],
    [["--out", "/p", "--images", "-1"], "--images"],
    [["--out", "/p", "--tolerance", "2"], "--tolerance takes a number from 0 to 1"],
    [["--out", "/p", "--tolerance", "x"], "--tolerance takes a number from 0 to 1"],
    [["--out", "/p", "--nope"], "nope"],
  ])("refuses %j", (args, message) => {
    expect(() => parseVerifyArgs(args as string[])).toThrow(message);
  });
});

describe("main verify", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  test("--help prints the verify help and exits 0", async () => {
    const run = io();
    expect(await main(["verify", "--help"], run.io)).toBe(0);
    expect(run.out()).toBe(VERIFY_HELP);
    for (const flag of [
      "--out",
      "--live",
      "--urls",
      "--max",
      "--only",
      "--viewports",
      "--build",
      "--mask",
      "--report-dir",
      "--live-cache",
      "--concurrency",
    ]) {
      expect(VERIFY_HELP).toContain(flag);
    }
  });

  test("the main help lists the command", () => {
    expect(HELP).toContain("wp2jx verify");
  });

  test("a usage mistake is exit 2 with the message on stderr and nothing on stdout", async () => {
    const run = io();
    expect(await main(["verify", "--max", "x", "--out", "/p"], run.io)).toBe(2);
    expect(run.err()).toContain("wp2jx: --max takes a whole number");
    expect(run.out()).toBe("");
  });

  test("progress goes to stderr unless --quiet", async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "verify-quiet-"));
    roots.push(dir);
    writeFileSync(join(dir, "project.json"), JSON.stringify({ url: "https://site.test" }));
    const jx = join(dir, "jx-fails");
    writeFileSync(jx, "#!/bin/sh\nexit 1\n");
    chmodSync(jx, 0o755);
    const loud = io();
    expect(await main(["verify", "--out", dir, "--build", "--jx", jx], loud.io)).toBe(3);
    expect(loud.err()).toContain("building");
    expect(loud.err()).toContain("jx build failed");
    const quiet = io();
    expect(await main(["verify", "--out", dir, "--build", "--jx", jx, "--quiet"], quiet.io)).toBe(
      3,
    );
    expect(quiet.err()).not.toContain("building");
    expect(quiet.err()).toContain("jx build failed");
  });

  test("a run that cannot finish is exit 3 with the reason", async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TMP_ROOT, "verify-cmd-"));
    roots.push(dir);
    const none = io();
    expect(await main(["verify", "--out", dir, "--live", "https://site.test"], none.io)).toBe(3);
    expect(none.err()).toContain("no project.json");
    writeFileSync(join(dir, "project.json"), JSON.stringify({ url: "https://site.test" }));
    const nodist = io();
    expect(await main(["verify", "--out", dir], nodist.io)).toBe(3);
    expect(nodist.err()).toContain("does not exist");
  });
});
