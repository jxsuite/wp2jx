/**
 * The `wp2jx` command line: what it accepts and refuses, what it prints where, its exit codes, the
 * census, and that no password reaches anything it prints. Runs `main` in process with captured
 * streams over the committed fixture databases; one test starts the real executable.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildInventory,
  HELP,
  main,
  parseConvertArgs,
  redactInventory,
  renderInventory,
  renderSummary,
  type CliIo,
  type Inventory,
} from "../src/cli.ts";
import { MANIFEST_PATH } from "../src/emit/project.ts";
import { fixtureCssDir } from "./helpers/fixture-css.ts";
import { fixtureDb } from "./helpers/fixture-db.ts";
import { TMP_ROOT } from "./helpers/jx-build.ts";

setDefaultTimeout(280_000);

const ROOT = join(import.meta.dir, "..");
const scratch: string[] = [];
function tmp(name: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, `${name}-`));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  io: CliIo;
  out: () => string;
  err: () => string;
}

function capture(env: Record<string, string | undefined> = {}, cwd = ROOT): Captured {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      env,
      cwd,
    },
    out: () => out,
    err: () => err,
  };
}

async function run(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; out: string; err: string }> {
  const c = capture(env);
  const code = await main(args, c.io);
  return { code, out: c.out(), err: c.err() };
}

const FL = async () => (await fixtureDb("fineline")).url;
const AP = async () => (await fixtureDb("ap")).url;
const FL_CSS = fixtureCssDir("fineline");

// ── Usage ────────────────────────────────────────────────────────────────────────────────────────

describe("the command line", () => {
  test("no command prints the help and exits 2; --help and help print it and exit 0", async () => {
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.out).toBe(HELP);
    for (const flag of ["--help", "-h", "help"]) {
      const r = await run([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toBe(HELP);
    }
    expect((await run(["convert", "--help"])).out).toBe(HELP);
    expect((await run(["inventory", "-h"])).out).toBe(HELP);
  });

  test("the help names every option the command accepts", () => {
    for (const flag of [
      "--db",
      "--out",
      "--prefix",
      "--site-url",
      "--css-from",
      "--plugin-from",
      "--uploads",
      "--component-prefix",
      "--post-types",
      "--dry-run",
      "--no-media",
      "--validate",
      "--build",
      "--allow-errors",
      "--help",
    ]) {
      expect(HELP).toContain(flag);
    }
    expect(HELP).toContain("--no-plugin-css");
    expect(HELP).toContain("--no-core-css");
    expect(HELP).toContain("wp2jx inventory");
    expect(HELP).toContain("WP2JX_DB");
  });

  test("--version", async () => {
    const r = await run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^wp2jx \d/);
  });

  test("an unknown command is a usage error that names it", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command "frobnicate"');
    expect(r.out).toBe("");
  });
});

describe("convert: what it refuses (exit 2), before it opens anything", () => {
  const dbArg = ["--db", "sqlite:/nonexistent.sqlite"];

  test.each([
    [[], "--db <url> is required"],
    [[...dbArg, "--css-from", FL_CSS], "--out <dir> is required"],
    [[...dbArg, "--out", "x", "--no-plugin-css", "--plugin-from", FL_CSS], "opposite things"],
    [[...dbArg, "--out", "x", "--no-core-css", "--wp-from", FL_CSS], "opposite things"],
    [[...dbArg, "--out", "x", "--css-from", "/no/such/dir"], "no such directory"],
    [
      [...dbArg, "--out", "x", "--css-from", "/no/such", "--css-from", "https://live.test"],
      "no such directory",
    ],
    [
      [...dbArg, "--out", "x", "--css-from", "https://a.test", "--css-from", "https://b.test"],
      "two addresses",
    ],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--css-from", FL_CSS], "two folders"],
    [[...dbArg, "--dry-run", "--css-from", FL_CSS, "--install"], "need --out"],
    [[...dbArg, "--dry-run", "--css-from", FL_CSS, "--validate"], "need --out"],
    [[...dbArg, "--dry-run", "--css-from", FL_CSS, "--build"], "need --out"],
    [
      [...dbArg, "--out", "x", "--css-from", FL_CSS, "--strict"],
      "--strict is a way of running --validate",
    ],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--inline-gaps", "sideways"], "--inline-gaps"],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--concurrency", "0"], "--concurrency"],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--concurrency", "abc"], "--concurrency"],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--plugin-from", "/no/such"], "--plugin-from"],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--uploads", "/no/such"], "--uploads"],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--wp-from", "/no/such"], "--wp-from"],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "stray"], 'unexpected argument "stray"'],
    [[...dbArg, "--out", "x", "--css-from", FL_CSS, "--bogus"], "bogus"],
    [[...dbArg, "--out"], "--out"],
  ])("%j", async (args, message) => {
    const r = await run(["convert", ...args]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
    expect(r.out).toBe("");
    expect(existsSync(join(ROOT, "x"))).toBe(false);
  });

  test("inventory refuses a missing database and a stray argument the same way", async () => {
    expect((await run(["inventory"])).code).toBe(2);
    expect((await run(["inventory", "--db", "sqlite:/x", "extra"])).err).toContain(
      'unexpected argument "extra"',
    );
  });
});

describe("parseConvertArgs", () => {
  test("every flag lands in the migration's options, paths resolved against the working directory", async () => {
    const dir = tmp("args");
    mkdirSync(join(dir, "css"));
    mkdirSync(join(dir, "plugin"));
    mkdirSync(join(dir, "uploads"));
    mkdirSync(join(dir, "wp"));
    const c = capture({}, dir);
    const parsed = parseConvertArgs(
      [
        "--db",
        "mysql://u:p4ssw0rd@h:3306/wp",
        "--out",
        "site",
        "--prefix",
        "wp_",
        "--site-url",
        "https://staging.test",
        "--css-from",
        "css",
        "--css-from",
        "https://live.test",
        "--css-cache",
        "cache",
        "--plugin-from",
        "plugin",
        "--wp-from",
        "wp",
        "--uploads",
        "https://cdn.test/up",
        "--component-prefix",
        "ap",
        "--post-types",
        "post, episode,post,, ",
        "--dry-run",
        "--no-media",
        "--presets",
        "--prune-css",
        "--inline-gaps",
        "innerHTML",
        "--concurrency",
        "12",
        "--install",
        "--validate",
        "--build",
        "--strict",
        "--jx",
        "bin/jx",
        "--allow-errors",
        "--force",
        "--quiet",
      ],
      c.io,
    );
    if (parsed === "help") throw new Error("not help");
    expect(parsed.options).toEqual({
      db: "mysql://u:p4ssw0rd@h:3306/wp",
      out: join(dir, "site"),
      prefix: "wp_",
      siteUrl: "https://staging.test",
      cssFrom: { dir: join(dir, "css"), url: "https://live.test", cacheDir: join(dir, "cache") },
      pluginFrom: join(dir, "plugin"),
      wpFrom: join(dir, "wp"),
      uploads: "https://cdn.test/up",
      componentPrefix: "ap",
      postTypes: ["post", "episode"],
      dryRun: true,
      media: false,
      presets: true,
      pruneCompat: true,
      inlineGaps: "innerHTML",
      concurrency: 12,
      verify: {
        install: true,
        validate: true,
        build: true,
        strict: true,
        jx: { bin: join(dir, "bin/jx") },
      },
    });
    expect(parsed.allowErrors).toBe(true);
    expect(parsed.force).toBe(true);
    expect(parsed.quiet).toBe(true);
    expect(parsed.secrets).toContain("p4ssw0rd");
  });

  test("--image-formats gives the images of project.json: a list of formats, or jx for Jx's own settings", () => {
    const base = ["--db", "sqlite:/x.sqlite", "--out", "o", "--css-from", FL_CSS];
    const parse = (...extra: string[]) => {
      const parsed = parseConvertArgs([...base, ...extra], capture({}, "/work").io);
      if (parsed === "help") throw new Error("not help");
      return parsed.options;
    };
    expect(parse("--image-formats", "webp,avif").images).toEqual({ formats: ["webp", "avif"] });
    expect(parse("--image-formats", " avif , webp,avif ").images).toEqual({
      formats: ["avif", "webp"],
    });
    expect(parse("--image-formats", "jx").images).toEqual({});
    expect(parse()).not.toHaveProperty("images");
    expect(HELP).toContain("--image-formats");
    for (const bad of ["", ",", "web p", "jx,avif"]) {
      expect(() => parse("--image-formats", bad)).toThrow("--image-formats");
    }
  });

  test("--css-cache-absent-ttl is hours of belief in a remembered 404, 0 for none, and needs the cache it applies to", () => {
    const base = ["--db", "sqlite:/x.sqlite", "--out", "o", "--css-from", "https://live.test"];
    const parse = (...extra: string[]) => {
      const parsed = parseConvertArgs([...base, ...extra], capture({}, "/work").io);
      if (parsed === "help") throw new Error("not help");
      return parsed.options;
    };
    expect(parse("--css-cache", "c", "--css-cache-absent-ttl", "2").cssFrom).toEqual({
      url: "https://live.test",
      cacheDir: "/work/c",
      absentTtlMs: 2 * 3_600_000,
    });
    expect(parse("--css-cache", "c", "--css-cache-absent-ttl", "0").cssFrom).toMatchObject({
      absentTtlMs: 0,
    });
    expect(parse("--css-cache", "c", "--css-cache-absent-ttl", "0.5").cssFrom).toMatchObject({
      absentTtlMs: 1_800_000,
    });
    expect(parse("--css-cache", "c").cssFrom).not.toHaveProperty("absentTtlMs");
    for (const bad of ["-1", "abc", "", "Infinity"]) {
      expect(() => parse("--css-cache", "c", "--css-cache-absent-ttl", bad)).toThrow(
        "--css-cache-absent-ttl",
      );
    }
    expect(() => parse("--css-cache-absent-ttl", "1")).toThrow("needs --css-cache");
    expect(HELP).toContain("--css-cache-absent-ttl");
  });

  test("the defaults are none: nothing is on unless asked for", () => {
    const parsed = parseConvertArgs(
      ["--db", "sqlite:/x.sqlite", "--out", "o", "--css-from", FL_CSS],
      capture({}, "/work").io,
    );
    if (parsed === "help") throw new Error("not help");
    expect(parsed.options).toEqual({
      db: "sqlite:/x.sqlite",
      out: "/work/o",
      cssFrom: { dir: FL_CSS },
    });
    expect(parsed.allowErrors).toBe(false);
    expect(parsed.quiet).toBe(false);
  });

  test("a source nobody named is the live site's: the options leave it out for the migration to fill in", () => {
    const at = (args: string[]) => {
      const parsed = parseConvertArgs(
        ["--db", "sqlite:/x.sqlite", "--out", "o", ...args],
        capture({}, "/work").io,
      );
      if (parsed === "help") throw new Error("not help");
      return parsed.options;
    };
    expect(at([])).toEqual({ db: "sqlite:/x.sqlite", out: "/work/o" });
    // A cache with no folder or address is the cache of the live site's stylesheets.
    expect(at(["--css-cache", "cache"]).cssFrom).toEqual({ cacheDir: "/work/cache" });
    expect(at(["--no-plugin-css"]).pluginFrom).toBe(false);
    expect(at(["--no-core-css"]).wpFrom).toBe(false);
    expect(at(["--plugin-from", "https://s.test"]).pluginFrom).toBe("https://s.test");
  });

  test("the database comes from WP2JX_DB when --db is not given, and --db wins when both are", () => {
    const fromEnv = parseConvertArgs(
      ["--out", "o", "--css-from", FL_CSS],
      capture({ WP2JX_DB: "mysql://u:envpass99@h/wp" }).io,
    );
    if (fromEnv === "help") throw new Error("not help");
    expect(fromEnv.options.db).toBe("mysql://u:envpass99@h/wp");
    const both = parseConvertArgs(
      ["--db", "sqlite:/a", "--out", "o", "--css-from", FL_CSS],
      capture({ WP2JX_DB: "mysql://u:envpass99@h/wp" }).io,
    );
    if (both === "help") throw new Error("not help");
    expect(both.options.db).toBe("sqlite:/a");
    expect(() =>
      parseConvertArgs(["--out", "o", "--css-from", FL_CSS], capture({ WP2JX_DB: "  " }).io),
    ).toThrow("--db <url> is required");
  });
});

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────────

describe("secrets", () => {
  test("a database that cannot be reached fails with exit 3, and the password is in neither stream", async () => {
    const url = "mysql://root:Tr0ub4dor&3@127.0.0.1:1/wp";
    const r = await run(["convert", "--db", url, "--css-from", FL_CSS, "--dry-run", "--quiet"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("wp2jx: ");
    expect(r.err).not.toContain("Tr0ub4dor");
    expect(r.err).toContain("***");
    expect(r.out).not.toContain("Tr0ub4dor");
    const inv = await run(["inventory", "--db", url]);
    expect(inv.code).toBe(3);
    expect(inv.err + inv.out).not.toContain("Tr0ub4dor");
  });

  test("the same through WP2JX_DB, and the progress line names the address with the password masked", async () => {
    const env = { WP2JX_DB: "mysql://root:Tr0ub4dor&3@127.0.0.1:1/wp" };
    const r = await run(["convert", "--css-from", FL_CSS, "--dry-run"], env);
    expect(r.code).toBe(3);
    expect(r.err).toContain("wp2jx: reading mysql://root:***@127.0.0.1:1/wp");
    expect(r.err + r.out).not.toContain("Tr0ub4dor");
  });

  test("the `--db=<url>` form is masked too, in the error and in the progress line", async () => {
    const r = await run([
      "convert",
      "--db=mysql://root:Tr0ub4dor&3@127.0.0.1:1/wp",
      "--css-from",
      FL_CSS,
      "--dry-run",
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("wp2jx: reading mysql://root:***@127.0.0.1:1/wp");
    expect(r.err + r.out).not.toContain("Tr0ub4dor");
  });

  test("a usage error that quotes the password's neighbourhood does not quote the password", async () => {
    const r = await run([
      "convert",
      "--db",
      "mysql://root:Tr0ub4dor&3@h/wp",
      "--css-from",
      "/no/such/dir/Tr0ub4dor&3",
      "--dry-run",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no such directory");
    expect(r.err).toContain("/no/such/dir/***");
    expect(r.err).not.toContain("Tr0ub4dor");
  });
});

// ── The directory it writes into ─────────────────────────────────────────────────────────────────

describe("the output directory", () => {
  test("a directory that holds somebody's files, and no manifest of ours, is refused; --force writes anyway", async () => {
    const dir = tmp("foreign");
    writeFileSync(join(dir, "precious.txt"), "mine");
    const args = [
      "convert",
      "--db",
      await FL(),
      "--css-from",
      FL_CSS,
      "--no-plugin-css",
      "--no-core-css",
      "--out",
      dir,
      "--no-media",
      "--post-types",
      "post",
      "--quiet",
      "--allow-errors",
    ];
    const refused = await run(args);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("not empty");
    expect(refused.err).toContain(MANIFEST_PATH);
    expect(existsSync(join(dir, "project.json"))).toBe(false);
    const forced = await run([...args, "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(dir, "precious.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(dir, "project.json"))).toBe(true);
    // Now it has a manifest, so it is ours to update without --force.
    expect((await run(args)).code).toBe(0);
  });

  test("a path that is a file is refused", async () => {
    const dir = tmp("file");
    const file = join(dir, "f");
    writeFileSync(file, "x");
    const r = await run([
      "convert",
      "--db",
      await FL(),
      "--css-from",
      FL_CSS,
      "--no-plugin-css",
      "--no-core-css",
      "--out",
      file,
      "--quiet",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not a directory");
  });
});

// ── A real run ───────────────────────────────────────────────────────────────────────────────────

/**
 * The fineline fixture with one redirect rule added that sends a visitor round in circles
 * (`/round-and-round` to itself): the report then holds an error, whatever else the fixture's own
 * rules do, so the exit code can be held to it.
 */
async function fixtureWithAnError(): Promise<string> {
  const source = await fixtureDb("fineline");
  const copy = join(tmp("db"), "fineline-error.sqlite");
  copyFileSync(source.path, copy);
  const db = new Database(copy);
  try {
    const table = `${source.prefix}rank_math_redirections`;
    const id = (db.query(`select max(id) + 1 as id from ${table}`).get() as { id: number }).id;
    db.run(`insert into ${table} values (${Array.from({ length: 9 }, () => "?").join(",")})`, [
      id,
      'a:1:{i:0;a:3:{s:6:"ignore";s:0:"";s:7:"pattern";s:15:"round-and-round";s:10:"comparison";s:5:"exact";}}',
      "/round-and-round",
      301,
      0,
      "active",
      "2024-01-01 00:00:00",
      "2024-01-01 00:00:00",
      "2024-01-01 00:00:00",
    ]);
  } finally {
    db.close();
  }
  return `sqlite:${copy}`;
}

describe("convert, end to end over the fineline fixture", () => {
  const dir = tmp("convert");
  let withError!: string;
  beforeAll(async () => {
    withError = await fixtureWithAnError();
  });
  const base = async () => [
    "convert",
    "--db",
    withError,
    "--prefix",
    (await fixtureDb("fineline")).prefix,
    "--css-from",
    FL_CSS,
    "--no-plugin-css",
    "--no-core-css",
    "--out",
    dir,
    "--no-media",
    "--post-types",
    "post",
    "--component-prefix",
    "fp",
  ];

  test("progress goes to stderr, the summary to stdout, and the report's errors make the exit code 1", async () => {
    const r = await run(await base());
    expect(r.code).toBe(1);
    expect(r.err).toContain("wp2jx: reading ");
    expect(r.err).toMatch(/\[ *\d+\.\d s\] load: /);
    expect(r.err).toMatch(/\] pages: /);
    expect(r.err).toMatch(/\] write: /);
    expect(r.err).toContain("the report has");
    expect(r.err).toContain("--allow-errors");
    expect(r.out).toContain("Migrated https://finelinepainting.pro");
    expect(r.out).toMatch(/\d+ pages?, \d+ entr(?:y|ies) in \d+ collections?/);
    expect(r.out).toMatch(/files: \d+ written, 0 unchanged, 0 removed/);
    expect(r.out).toContain("media: left out");
    expect(r.out).toContain(join(dir, "migration-report.md"));
    expect(r.out).toContain("decisions for the site owner:");
    // Progress is not in the summary and the summary is not in the progress.
    expect(r.out).not.toContain("load:");
    expect(r.err).not.toContain("Migrated ");
    expect(existsSync(join(dir, "project.json"))).toBe(true);
    expect(existsSync(join(dir, "migration-report.json"))).toBe(true);
    // The one error is the rule added above; the fixture's own rules, among them a trailing-slash
    // only one, are no longer errors.
    const entries = JSON.parse(readFileSync(join(dir, "migration-report.json"), "utf8"))
      .entries as {
      severity: string;
      code: string;
    }[];
    expect(entries.filter((e) => e.severity === "error").map((e) => e.code)).toEqual([
      "redirect.loop",
    ]);
  });

  test("the same run with --allow-errors exits 0 and finds everything unchanged", async () => {
    const r = await run([...(await base()), "--allow-errors", "--quiet"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toMatch(/files: 0 written, \d+ unchanged, 0 removed/);
  });

  test("--quiet silences the progress and nothing else", async () => {
    const r = await run([...(await base()), "--quiet"]);
    expect(r.err).not.toContain("load:");
    expect(r.err).not.toContain("wp2jx: reading");
    expect(r.out).toContain("Migrated ");
  });

  test("a dry run with no output writes nothing, says it is a dry run, and needs no --out", async () => {
    const before = existsSync(join(ROOT, "dry-run-marker"));
    const r = await run([
      "convert",
      "--db",
      await FL(),
      "--css-from",
      FL_CSS,
      "--no-plugin-css",
      "--no-core-css",
      "--dry-run",
      "--post-types",
      "post",
      "--quiet",
      "--allow-errors",
    ]);
    expect(before).toBe(false);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Migrated https://finelinepainting.pro (dry run)");
    expect(r.out).toContain("none fetched (dry run)");
    expect(r.out).not.toContain("migration-report.md)");
  });

  test("--validate and --build run jx in the output: the summary says so, and a project that passes exits as the report says", async () => {
    const r = await run([
      ...(await base()),
      "--validate",
      "--build",
      "--allow-errors",
      "--quiet",
      "--force",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/jx validate: ok \(\d+\.\d s\)/);
    expect(r.out).toMatch(/jx build: ok \(\d+\.\d s, \d+ routes, \d+ files\)/);
    expect(existsSync(join(dir, "dist/index.html"))).toBe(true);
    expect(existsSync(join(dir, "project.schema.json"))).toBe(false);
  });

  test("--install runs in the output, and an install that fails is `bun install: FAILED`, exit 1, and says jx did not pass", async () => {
    const out = tmp("installfail");
    // A package.json is the person's: this one asks for a folder that is not there, which fails at once, offline.
    writeFileSync(
      join(out, "package.json"),
      JSON.stringify({ name: "t", private: true, dependencies: { missing: "file:./not-there" } }),
    );
    const r = await run([
      "convert",
      "--db",
      await FL(),
      "--css-from",
      FL_CSS,
      "--no-plugin-css",
      "--no-core-css",
      "--out",
      out,
      "--no-media",
      "--post-types",
      "post",
      "--install",
      "--force",
      "--quiet",
    ]);
    expect(r.out).toContain("bun install: FAILED");
    expect(r.code).toBe(1);
    expect(r.err).toContain("jx did not pass");
    expect(
      JSON.parse(readFileSync(join(out, "migration-report.json"), "utf8")).entries.some(
        (x: { code: string }) => x.code === "jx.install-failed",
      ),
    ).toBe(true);
  });

  test("jx failing makes the exit 1 even with a clean report, and says so", async () => {
    const fake = join(tmp("fakejx"), "jx.js");
    writeFileSync(fake, 'console.error("Validation failed: boom"); process.exit(1);');
    const clean = tmp("fakeout");
    const r = await run([
      "convert",
      "--db",
      await FL(),
      "--css-from",
      FL_CSS,
      "--no-plugin-css",
      "--no-core-css",
      "--out",
      clean,
      "--no-media",
      "--post-types",
      "post",
      "--validate",
      "--jx",
      fake,
      "--allow-errors",
      "--quiet",
    ]);
    // --allow-errors accepts what jx said too: its findings are entries of the report.
    expect(r.out).toContain("jx validate: FAILED");
    expect(r.code).toBe(0);
    const strict = await run([
      "convert",
      "--db",
      await FL(),
      "--css-from",
      FL_CSS,
      "--no-plugin-css",
      "--no-core-css",
      "--out",
      clean,
      "--no-media",
      "--post-types",
      "post",
      "--validate",
      "--jx",
      fake,
      "--quiet",
    ]);
    expect(strict.code).toBe(1);
    expect(strict.err).toContain("jx did not pass");
  });
});

// ── The census ───────────────────────────────────────────────────────────────────────────────────

describe("inventory", () => {
  let fl: Inventory;
  let ap: Inventory;

  test("fineline: what the site is made of", async () => {
    fl = await buildInventory({ db: await FL() });
    expect(fl.site).toMatchObject({
      url: "https://finelinepainting.pro",
      theme: "cwicly",
      language: "en-US",
      permalinkStructure: "/%postname%/",
      showOnFront: "page",
      prefix: "KjLnF_",
    });
    const types = Object.fromEntries(fl.postTypes.map((t) => [t.type, t]));
    expect(types.project!.statuses).toEqual({ draft: 7, private: 2, publish: 82 });
    expect(types.project!.total).toBe(91);
    expect(types.service!.statuses.publish).toBe(19);
    expect(types.page!.statuses).toEqual({ draft: 23, private: 2, publish: 11 });
    expect(types.post!.statuses.publish).toBe(11);
    expect(types.cc_block!.total).toBe(2);
    expect(types.wp_template!.total).toBe(13);
    // Plugin types that no conversion takes, and why; structural ones are taken.
    expect(types.grw_feed).toMatchObject({ converted: false });
    expect(types.grw_feed!.why).toContain("no address");
    expect(types.igmap!.converted).toBe(false);
    expect(types.project!.converted).toBe(true);
    expect(types.attachment).toMatchObject({ converted: true, total: 1233 });
    expect(fl.cwicly).toMatchObject({
      version: "1.4.7",
      components: 2,
      templates: 13,
      templateParts: 3,
      globalClasses: 34,
      colours: 22,
      breakpoints: "lg 1366 (main), md 992, sm 576",
    });
    expect(fl.media.attachments).toBe(1233);
    expect(fl.menus).toBeGreaterThanOrEqual(1);
    expect(fl.plugins).toContain("seo-by-rank-math/rank-math.php");
    expect(fl.acf.postTypes).toEqual(["project", "service"]);
    expect(fl.acf.taxonomies).toEqual(
      expect.arrayContaining(["location", "project_tag", "project_type", "service-type"]),
    );
    expect(fl.acf.groups.length).toBeGreaterThanOrEqual(3);
  });

  test("fineline: block names, tokens, shortcodes and forms are counted from the content a conversion would read", async () => {
    const heading = fl.blocks.find((b) => b.name === "cwicly/heading")!;
    expect(heading.count).toBe(966);
    expect(heading.posts).toBeGreaterThan(50);
    expect(fl.blocks[0]!.count).toBeGreaterThanOrEqual(fl.blocks.at(-1)!.count);
    expect(fl.blocks.find((b) => b.name === "cwicly/component")!.count).toBe(290);
    expect(fl.tokens.length).toBeGreaterThan(5);
    expect(fl.tokens.find((t) => t.name === "gcl")).toEqual({
      name: "gcl",
      count: 700,
      known: true,
    });
    // A CSS or JSON brace is not a token.
    expect(fl.tokens.filter((t) => !/^[A-Za-z][\w-]*$/.test(t.name))).toEqual([]);
    expect(fl.shortcodes.map((s) => s.name)).toEqual(
      expect.arrayContaining(["fluentform", "trustindex"]),
    );
    expect(fl.forms.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["block:fluentfom/guten-block", "shortcode:fluentform"]),
    );
    expect(fl.shortcodes.map((s) => s.name)).not.toContain("object");
    expect(fl.freeformPosts).toBeGreaterThan(0);
  });

  test("ap: the core-heavy site, with its own counts", async () => {
    ap = await buildInventory({ db: await AP() });
    expect(ap.site).toMatchObject({ url: "https://anabaptistperspectives.org", prefix: "wp_" });
    expect(ap.cwicly).toMatchObject({
      components: 6,
      templates: 20,
      templateParts: 7,
      reusableBlocks: 7,
    });
    const types = Object.fromEntries(ap.postTypes.map((t) => [t.type, t]));
    expect(types.episode).toBeDefined();
    expect(types.post!.statuses.publish).toBeGreaterThan(50);
    expect(ap.blocks.find((b) => b.name === "core/paragraph")!.count).toBeGreaterThan(1000);
    expect(ap.taxonomies.map((t) => t.taxonomy)).toEqual(
      expect.arrayContaining(["series", "season", "category", "post_tag"]),
    );
  });

  test("the text form lists the sections, widest columns aligned, and the JSON form parses back to the same census", async () => {
    const text = renderInventory(fl);
    for (const heading of [
      "Post types",
      "Taxonomies",
      "Blocks",
      "Cwicly tokens",
      "Shortcodes",
      "Forms",
      "ACF",
      "Cwicly",
      "Active plugins",
    ]) {
      expect(text).toContain(`\n${heading}`);
    }
    expect(text).toContain("finelinepainting.pro (https://finelinepainting.pro)");
    expect(text).toMatch(/project +91 +draft 7, private 2, publish 82/);
    expect(text).toMatch(/grw_feed +6 +publish 6 +\[left out: no address/);
    expect(text).toMatch(/gcl +700\n/);
    expect(text).toMatch(/cwicly\/heading +966 in \d+ posts/);
    const r = await run(["inventory", "--db", await FL(), "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(JSON.parse(JSON.stringify(fl)));
    const plain = await run(["inventory", "--db", await FL()]);
    expect(plain.code).toBe(0);
    expect(plain.out).toBe(text);
  });

  test("--post-types narrows what the census says a conversion would take", async () => {
    const r = await run(["inventory", "--db", await FL(), "--json", "--post-types", "post"]);
    const inv = JSON.parse(r.out) as Inventory;
    const types = Object.fromEntries(inv.postTypes.map((t) => [t.type, t]));
    expect(types.post!.converted).toBe(true);
    expect(types.service!.converted).toBe(false);
    expect(types.attachment!.converted).toBe(true);
    // Blocks are counted over what was loaded: no service content in it.
    expect(inv.blocks.find((b) => b.name === "cwicly/heading")!.count).toBeLessThan(966);
  });
});

// ── The summary ──────────────────────────────────────────────────────────────────────────────────

describe("renderSummary", () => {
  const result = {
    project: { url: "https://x.test" },
    counts: {
      pages: 1,
      entries: 1,
      collections: 1,
      components: 1,
      layouts: 1,
      redirects: 1,
      files: 9,
    },
    files: { written: ["a"], unchanged: [], removed: [], kept: ["k"] },
    media: { planned: 10, downloaded: 7, skipped: 2, failed: 1, bytes: 3_500_000 },
    summary: { total: 3, bySeverity: { error: 1, warn: 1, info: 1 }, byCode: {} },
    decisions: [{ id: "x", title: "A question", question: "?", count: 4, examples: [], codes: [] }],
    timings: { total: 1234 },
    report: [],
  } as never;
  const args = (extra: Record<string, unknown>) =>
    ({
      options: { out: "/o", ...extra },
      allowErrors: false,
      quiet: false,
      force: false,
      secrets: [],
      db: "x",
    }) as never;

  test("singular and plural, the stale file kept, the media counts, the report path and the decisions", () => {
    const text = renderSummary(result, args({}));
    expect(text).toContain("1 page, 1 entry in 1 collection, 1 component, 1 layout, 1 redirect");
    expect(text).toContain("files: 1 written, 0 unchanged, 0 removed, 1 stale kept (edited)");
    expect(text).toContain("media: 7 fetched (3.5 MB), 2 already there, 1 failed");
    expect(text).toContain("report: 1 error, 1 warning, 1 info (/o/migration-report.md)");
    expect(text).toContain("    - A question (4)");
    expect(text).toContain("time: 1.2 s");
    expect(renderSummary(result, args({ media: false }))).toContain(
      "media: left out (10 files referenced)",
    );
    expect(renderSummary(result, args({ dryRun: true }))).toContain(
      "Migrated https://x.test (dry run)",
    );
  });
});

// ── The executable ───────────────────────────────────────────────────────────────────────────────

describe("the executable", () => {
  test("src/cli.ts is runnable: a shebang, the executable bit, and the exit code of main", async () => {
    const path = join(ROOT, "src/cli.ts");
    expect(readFileSync(path, "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(statSync(path).mode & 0o111).not.toBe(0);
    const help = Bun.spawnSync([process.execPath, path, "--help"], { cwd: ROOT });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toBe(HELP);
    const bad = Bun.spawnSync([process.execPath, path, "nope"], { cwd: ROOT });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain('unknown command "nope"');
    const none = Bun.spawnSync([process.execPath, path], { cwd: ROOT });
    expect(none.exitCode).toBe(2);
  });

  test("package.json names it as the wp2jx binary", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin.wp2jx).toBe("src/cli.ts");
  });
});

// ── What the review of the command line found ────────────────────────────────────────────────────

describe("--route-type: the rewrite rule of a plugin's post type", () => {
  const parse = (...args: string[]) => {
    const parsed = parseConvertArgs(
      ["--db", "sqlite:/x.sqlite", "--out", "o", "--css-from", FL_CSS, ...args],
      capture({}, "/work").io,
    );
    if (parsed === "help") throw new Error("not help");
    return parsed.options;
  };

  test("the help names it, and says that posts are converted whatever --post-types lists", () => {
    expect(HELP).toContain("--route-type");
    expect(HELP).toMatch(
      /--post-types a,b\s+convert only these content types \(pages, posts, templates/,
    );
  });

  test("each option lands in the rule it spells, and a bare type is routed flat at its own name", () => {
    const options = parse(
      "--route-type",
      "grw_feed=slug:/reviews/,archive,hierarchical,no-front,private",
      "--route-type",
      "igmap",
      "--route-type",
      "wpcb_snippet_post=archive:snippets",
    );
    expect(options.routeTypes).toEqual({
      grw_feed: {
        rewriteSlug: "reviews",
        hasArchive: true,
        hierarchical: true,
        rewriteWithFront: false,
        public: false,
      },
      igmap: {},
      wpcb_snippet_post: { hasArchive: "snippets" },
    });
    expect(parse().routeTypes).toBeUndefined();
  });

  test("a type that is given its rule is added to --post-types, which would otherwise leave it unloaded", () => {
    expect(
      parse("--post-types", "post,episode", "--route-type", "captivate_podcast").postTypes,
    ).toEqual(["post", "episode", "captivate_podcast"]);
    // With no list every published type is loaded already.
    expect(parse("--route-type", "captivate_podcast").postTypes).toBeUndefined();
  });

  test.each([
    ["bad type=archive", "post type name"],
    ["=archive", "post type name"],
    ["a=archive,bogus", 'unknown option "bogus"'],
    ["a=slug", "slug: needs the rewrite base"],
    ["a=slug:", "slug: needs the rewrite base"],
  ])("--route-type %j is a usage error", async (value, message) => {
    const r = await run([
      "convert",
      "--db",
      "sqlite:/x",
      "--out",
      "x",
      "--css-from",
      FL_CSS,
      "--route-type",
      value,
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  test("the same type twice is a usage error", async () => {
    const r = await run([
      "convert",
      "--db",
      "sqlite:/x",
      "--out",
      "x",
      "--css-from",
      FL_CSS,
      "--route-type",
      "a",
      "--route-type",
      "a=archive",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("names a twice");
  });

  test("the census calls a type with a rule convertible, and one without it is left out as before", async () => {
    const without = JSON.parse(
      (await run(["inventory", "--db", await FL(), "--json"])).out,
    ) as Inventory;
    expect(without.postTypes.find((t) => t.type === "grw_feed")).toMatchObject({
      converted: false,
    });
    const withRule = JSON.parse(
      (await run(["inventory", "--db", await FL(), "--json", "--route-type", "grw_feed"])).out,
    ) as Inventory;
    expect(withRule.postTypes.find((t) => t.type === "grw_feed")).toMatchObject({
      converted: true,
    });
    // And it is loaded when the list would have left it out.
    const narrow = JSON.parse(
      (
        await run([
          "inventory",
          "--db",
          await FL(),
          "--json",
          "--post-types",
          "post",
          "--route-type",
          "grw_feed=slug:reviews",
        ])
      ).out,
    ) as Inventory;
    expect(narrow.postTypes.find((t) => t.type === "grw_feed")).toMatchObject({ converted: true });
  });

  test("convert migrates the type: its entries are written under the rewrite base", async () => {
    const dir = tmp("routetype");
    const r = await run([
      "convert",
      "--db",
      await FL(),
      "--prefix",
      (await fixtureDb("fineline")).prefix,
      "--css-from",
      FL_CSS,
      "--no-plugin-css",
      "--no-core-css",
      "--out",
      dir,
      "--no-media",
      "--post-types",
      "post",
      "--route-type",
      "grw_feed=slug:reviews",
      "--component-prefix",
      "fp",
      "--quiet",
      "--allow-errors",
    ]);
    expect(r.code).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as {
      content: Record<string, unknown>;
    };
    expect(Object.keys(project.content)).toContain("grw_feed");
    expect(existsSync(join(dir, "content/grw_feed"))).toBe(true);
  });
});

describe("the output directory, again", () => {
  const convertArgs = async (dir: string) => [
    "convert",
    "--db",
    await FL(),
    "--prefix",
    (await fixtureDb("fineline")).prefix,
    "--css-from",
    FL_CSS,
    "--no-plugin-css",
    "--no-core-css",
    "--out",
    dir,
    "--no-media",
    "--post-types",
    "post",
    "--component-prefix",
    "fp",
    "--quiet",
    "--allow-errors",
  ];

  test("a directory that holds only a .git is empty as far as the tool is concerned, and one with anything else is not", async () => {
    const onlyGit = tmp("onlygit");
    mkdirSync(join(onlyGit, ".git"));
    const ok = await run(await convertArgs(onlyGit));
    expect(ok.code).toBe(0);
    expect(existsSync(join(onlyGit, "project.json"))).toBe(true);
    expect(existsSync(join(onlyGit, ".git"))).toBe(true);

    const more = tmp("gitplus");
    mkdirSync(join(more, ".git"));
    writeFileSync(join(more, "README.md"), "mine");
    const refused = await run(await convertArgs(more));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("not empty");
    expect(existsSync(join(more, "project.json"))).toBe(false);
  });

  test("a write that fails halfway exits 3 naming the file, leaves a manifest, and the directory is the tool's to finish", async () => {
    const dir = tmp("halfway");
    // A file where the project needs a directory: the collections cannot be written under it.
    writeFileSync(join(dir, "content"), "in the way");
    const args = await convertArgs(dir);
    const failed = await run([...args, "--force"]);
    expect(failed.code).toBe(3);
    expect(failed.err).toMatch(/could not write content\/[^\n]*: /);
    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_PATH), "utf8")) as {
      generator: string;
      files: Record<string, string>;
    };
    expect(manifest.generator).toBe("wp2jx");
    expect(Object.keys(manifest.files).length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "project.json"))).toBe(false);
    // Nothing is left that the next run would refuse: remove what was in the way and run again.
    rmSync(join(dir, "content"));
    const again = await run(args);
    expect(again.code).toBe(0);
    expect(existsSync(join(dir, "project.json"))).toBe(true);
  });

  test("the project of another site is refused (exit 3) and --force replaces it", async () => {
    const dir = tmp("othersite");
    expect((await run(await convertArgs(dir))).code).toBe(0);
    const ap = [
      "convert",
      "--db",
      await AP(),
      "--prefix",
      (await fixtureDb("ap")).prefix,
      "--css-from",
      fixtureCssDir("ap"),
      "--no-plugin-css",
      "--no-core-css",
      "--out",
      dir,
      "--no-media",
      "--post-types",
      "post",
      "--component-prefix",
      "ap",
      "--quiet",
      "--allow-errors",
    ];
    const before = readFileSync(join(dir, "project.json"), "utf8");
    const refused = await run(ap);
    expect(refused.code).toBe(3);
    expect(refused.err).toContain("holds the project of https://finelinepainting.pro");
    expect(readFileSync(join(dir, "project.json"), "utf8")).toBe(before);
    const forced = await run([...ap, "--force"]);
    expect(forced.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).url).toBe(
      "https://anabaptistperspectives.org",
    );
  });
});

describe("a password that is an ordinary word, in what the command prints", () => {
  test("the summary masks the address it quotes and keeps its own words", () => {
    const result = {
      project: { url: "https://x.test/page" },
      counts: {
        pages: 1,
        entries: 2,
        collections: 1,
        components: 0,
        layouts: 1,
        redirects: 0,
        files: 4,
      },
      files: { written: [], unchanged: [], removed: [], kept: [] },
      media: { planned: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0 },
      summary: { total: 0, bySeverity: { error: 0, warn: 0, info: 0 }, byCode: {} },
      decisions: [],
      timings: { total: 10 },
      report: [],
    } as never;
    const text = renderSummary(result, {
      options: { out: "/o/page" },
      allowErrors: false,
      quiet: false,
      force: false,
      secrets: ["page", "post"],
      db: "x",
    } as never);
    expect(text).toContain("Migrated https://x.test/***");
    expect(text).toContain("1 page, 2 entries in 1 collection");
    expect(text).toContain("(/o/***/migration-report.md)");
  });

  test("the census masks the site's own words and keeps the post types it counts", async () => {
    const inv = await buildInventory({ db: await FL(), postTypes: ["post"] });
    const masked = redactInventory(inv, ["finelinepainting", "post"]);
    expect(masked.site.url).toBe("https://***.pro");
    expect(masked.site.name).not.toContain("finelinepainting");
    expect(masked.postTypes.map((t) => t.type)).toEqual(inv.postTypes.map((t) => t.type));
    expect(masked.postTypes.some((t) => t.type === "post")).toBe(true);
    expect(redactInventory(inv, [])).toBe(inv);
  });
});
