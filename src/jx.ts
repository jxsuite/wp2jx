/**
 * The `jx` command line as this tool uses it: `jx schema`, `jx validate` and `jx build` run in a
 * project directory, and what they print read back as report entries.
 *
 * The binary is the one this repository installed (`node_modules/.bin/jx`), or a path the caller
 * gives. Its shebang asks for `node`; a machine without one runs the same file under Bun. A command
 * that exits non-zero is a result here, never a throw: the exit code, both streams and the time it
 * took are in the {@link JxRun}, and the parsers turn what the commands print into {@link JxIssue}s.
 * Only a binary that cannot be started at all throws, because that is the caller's setup, not a
 * finding about the project.
 *
 * What the commands print, as read from `@jxsuite/compiler` (`src/cli.ts`, `src/site/validate-command.ts`):
 *
 * - `jx validate`: `Project is valid (N files checked in <dir>)`, or `Project is INVALID (<dir>):`
 *   followed by one block per file, `<file>:` and then `  - <JSON pointer>: <message>` per schema
 *   complaint. Lint findings are `<file>: error|warning: <message>. [<rule>, <standard>]`. A document
 *   that cannot be read at all aborts the whole run with `Validation failed: <message>`. The schema
 *   compiler also prints `unknown format "…" ignored in schema` on every run: that is noise.
 * - `jx build`: progress on stdout (`Done: N routes → M files`), warnings and errors on stderr. A failed
 *   build ends with `Build completed with N error(s):` and one `  - <message>` per error, an aborted one
 *   with `Build failed: <message>`.
 *
 * `installDependencies` runs `bun install` in the project: a Jx project names the packages its build
 * needs (`@jxsuite/parser` for Markdown collections) in its own `package.json`, and a project outside
 * this repository has no `node_modules` until that is done (the build then warns `prototype-resolver:
 * failed to resolve … Cannot find module '@jxsuite/parser/…'` for every content page and ships them empty).
 *
 * Report codes: `jx.install-failed`, `jx.validate-error` (error: a schema complaint, with `where` the file and `data.pointer`),
 * `jx.validate-lint` (the lint rule's own severity), `jx.validate-failed` (error: the run could not
 * finish), `jx.validate-truncated` (info: a file's complaints were cut), `jx.schema-failed`,
 * `jx.build-error` (error: one per build error, `data.route` when the message names one),
 * `jx.build-warning` (warn), `jx.build-failed` (error: the build aborted or timed out),
 * `jx.timeout` (error).
 */
import { spawn } from "bun";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Report, Severity } from "./types.ts";

/** `node_modules/.bin/jx` of this repository. */
export const DEFAULT_JX_BIN = resolve(dirname(import.meta.dir), "node_modules/.bin/jx");

/** Told every line a command prints, as it prints it: the line without its line break, and the stream it came on. */
export type JxLineListener = (line: string, stream: "stdout" | "stderr") => void;

export interface JxOptions {
  /** The binary to run. Default {@link DEFAULT_JX_BIN}. */
  bin?: string | undefined;
  /** Kill the command after this long. Default 5 minutes (a build: {@link MIN_BUILD_TIMEOUT_MS}). */
  timeoutMs?: number | undefined;
  /** Further environment variables. */
  env?: Record<string, string | undefined> | undefined;
  /**
   * Hear the command's lines while it runs, which is how a build that takes half an hour shows it
   * is not stuck. A listener that throws is ignored. The {@link JxRun} still holds the whole text.
   */
  onLine?: JxLineListener | undefined;
}

export interface JxRun {
  /** The exit code; 124 when the command was killed for taking too long. */
  code: number;
  stdout: string;
  stderr: string;
  /** Wall-clock milliseconds. */
  ms: number;
  timedOut: boolean;
  /** The limit the command ran under. */
  timeoutMs: number;
}

/** One thing a jx command said about the project. */
export interface JxIssue {
  severity: Severity;
  /** The report code: `jx.validate-error`, `jx.build-error`… */
  code: string;
  /** The file the issue is in, project-relative as jx prints it. */
  file?: string;
  /** The JSON pointer inside it (`/children/3/tagName`), for a schema complaint. */
  pointer?: string;
  /** The lint rule (`accessibility/img-alt-missing`) or the build route. */
  rule?: string;
  route?: string;
  message: string;
  /**
   * How many times jx printed this very line, when more than once. A lint line names no element (no
   * pointer), so nine `the <a> has no accessible name` lines for one page are nine elements, not one
   * finding printed repeatedly; absent means once.
   */
  count?: number;
}

const DEFAULT_TIMEOUT = 5 * 60_000;

/**
 * The least a build is given. Jx optimises every image the pages use with Sharp, once for each width
 * and format, one image after the other: the pilot's 755 images (421 MB) took longer than the 5
 * minutes a build was first given by an order of magnitude.
 */
export const MIN_BUILD_TIMEOUT_MS = 30 * 60_000;

/** What a media file adds to the time a build is given (see {@link buildTimeoutFor}). */
export const BUILD_MS_PER_MEDIA_FILE = 8_000;

/** The CLI's shebang is `env node`; where node is absent (or the target is a script), run it under Bun. */
export function launcher(
  bin: string,
  which: (command: string) => string | null = Bun.which,
): string[] {
  const script = /\.(?:[cm]?js|ts)$/.test(bin);
  return script || which("node") === null ? [process.execPath, bin] : [bin];
}

/**
 * Run `jx <args>` in `dir`. Never throws for a failing command; throws when the binary does not exist
 * or cannot be spawned.
 */
export async function runJx(
  dir: string,
  args: readonly string[],
  opts: JxOptions = {},
): Promise<JxRun> {
  const bin = opts.bin ?? DEFAULT_JX_BIN;
  if (!existsSync(bin)) {
    throw new Error(
      `the jx binary ${bin} does not exist: run \`bun install\` in the wp2jx repository or pass the path to one`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const started = performance.now();
  const proc = spawn({
    cmd: [...launcher(bin), ...args],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: timeoutMs,
  });
  const [stdout, stderr, code] = await Promise.all([
    readLines(proc.stdout, "stdout", opts.onLine),
    readLines(proc.stderr, "stderr", opts.onLine),
    proc.exited,
  ]);
  const timedOut = proc.signalCode !== null && proc.signalCode !== undefined;
  return {
    code: timedOut ? 124 : code,
    stdout,
    stderr,
    ms: Math.round(performance.now() - started),
    timedOut,
    timeoutMs,
  };
}

/** A stream's whole text, with each line handed to `onLine` the moment it is complete. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  name: "stdout" | "stderr",
  onLine: JxLineListener | undefined,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let pending = "";
  const hear = (line: string): void => {
    try {
      onLine?.(line.replace(/\r$/, ""), name);
    } catch {
      // A listener that throws must not cost the run its output.
    }
  };
  for await (const chunk of stream) {
    const piece = decoder.decode(chunk, { stream: true });
    text += piece;
    if (onLine === undefined) continue;
    pending += piece;
    for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
      hear(pending.slice(0, at));
      pending = pending.slice(at + 1);
    }
  }
  const rest = decoder.decode();
  text += rest;
  pending += rest;
  if (onLine !== undefined && pending !== "") hear(pending);
  return text;
}

// ── Reading the output ───────────────────────────────────────────────────────────────────────────

/** The schema compiler's per-run noise: not a finding about the project. */
const NOISE = /^unknown format ".*" ignored in schema/;

const LINT = /^(\S.*?): (error|warning|warn|info): (.*)$/;
const RULE = /^(.*?)\s*\[([^\],]+)(?:,[^\]]*)?\]$/;
const SCHEMA_ITEM = /^ {2}- (\/.*?): (must\b.*|should\b.*)$/;
const LOOSE_ITEM = /^ {2}- (\/\S*): (.*)$/;

/**
 * A lint finding's report severity. `jx validate` exits 0 on a lint error unless `--strict`, so a
 * migration that did not ask for strictness does not call it an error (the markup is the source
 * site's, and the site owner decides): it is a warning, and a lint warning is information.
 */
const lintSeverity = (word: string, strict: boolean): Severity =>
  word === "error" ? (strict ? "error" : "warn") : "info";

/**
 * What `jx validate` printed, as issues. Unknown lines are not issues: a run that failed without any
 * parseable line is the caller's `jx.validate-failed`, built from the exit code.
 */
export function parseValidateOutput(text: string, opts: { strict?: boolean } = {}): JxIssue[] {
  const issues: JxIssue[] = [];
  const seen = new Map<string, JxIssue>();
  const add = (issue: JxIssue): void => {
    const key = JSON.stringify([
      issue.code,
      issue.file,
      issue.pointer,
      issue.rule,
      issue.severity,
      issue.message,
    ]);
    const known = seen.get(key);
    if (known !== undefined) {
      // A schema complaint carries a pointer, so a repeat is the validator listing a `oneOf`'s
      // branches again. A lint line carries none: a repeat is another element, and is counted.
      if (issue.code === "jx.validate-lint") known.count = (known.count ?? 1) + 1;
      return;
    }
    seen.set(key, issue);
    issues.push(issue);
  };
  let file: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") continue;
    if (line.startsWith("Project is ")) {
      file = undefined;
      continue;
    }
    if (line.startsWith("Validation failed: ")) {
      add({
        severity: "error",
        code: "jx.validate-failed",
        message: line.slice("Validation failed: ".length),
      });
      continue;
    }
    const item = SCHEMA_ITEM.exec(line) ?? LOOSE_ITEM.exec(line);
    if (item !== null) {
      add({
        severity: "error",
        code: "jx.validate-error",
        ...(file === undefined ? {} : { file }),
        pointer: item[1]!,
        message: item[2]!,
      });
      continue;
    }
    if (/^ {2}- /.test(line)) {
      add({
        severity: "error",
        code: "jx.validate-error",
        ...(file === undefined ? {} : { file }),
        message: line.replace(/^ {2}- /, ""),
      });
      continue;
    }
    const lint = LINT.exec(line);
    if (lint !== null) {
      const ruled = RULE.exec(lint[3]!);
      add({
        severity: lintSeverity(lint[2]!, opts.strict === true),
        code: "jx.validate-lint",
        file: lint[1]!,
        ...(ruled === null ? {} : { rule: ruled[2]!.trim() }),
        message: (ruled === null ? lint[3]! : ruled[1]!).trim(),
      });
      continue;
    }
    const header = /^(\S.*):$/.exec(line);
    if (header !== null) file = header[1]!;
  }
  return issues;
}

/** Lines `jx build` prints that are progress, not findings. */
const BUILD_PROGRESS =
  /^(?:Building site from |Done: |Loading |Discovering |Compiling|Bundling |Writing |Build complete|Copying |\s+(?:Found|Compiled|Compiling|\d+ route|note:)|sitemap\.xml skipped)/;

export interface BuildSummary {
  routes?: number;
  files?: number;
}

/** What `jx build` printed, as issues, and the totals it ended with. */
export function parseBuildOutput(
  stdout: string,
  stderr: string,
): { issues: JxIssue[]; summary: BuildSummary } {
  const issues: JxIssue[] = [];
  const summary: BuildSummary = {};
  const done = /Done: (\d+) routes? → (\d+) files?/.exec(stdout);
  if (done !== null) {
    summary.routes = Number(done[1]);
    summary.files = Number(done[2]);
  }
  const lines = stderr.split(/\r?\n/).map((l) => l.trimEnd());
  // The errors a failed build lists at its end (it printed most of them live, earlier).
  const listed: string[] = [];
  const at = lines.findIndex((line) => /^Build completed with \d+ error/.test(line));
  if (at !== -1) {
    for (const line of lines.slice(at + 1)) {
      const item = /^ {2}- (.*)$/.exec(line);
      if (item !== null) listed.push(item[1]!);
      else break;
    }
  }
  const isListed = new Set(listed);
  const seen = new Set<string>();
  const error = (message: string): void => {
    if (seen.has(message)) return;
    seen.add(message);
    const route = /^Error compiling (\S+?): /.exec(message)?.[1];
    issues.push({
      severity: "error",
      code: "jx.build-error",
      ...(route === undefined ? {} : { route }),
      message,
    });
  };
  const body = at === -1 ? lines : lines.slice(0, at);
  for (const line of body) {
    if (line === "") continue;
    const failed = /^Build failed: (.*)$/.exec(line);
    if (failed !== null) {
      issues.push({ severity: "error", code: "jx.build-failed", message: failed[1]! });
      continue;
    }
    if (BUILD_PROGRESS.test(line) || line.startsWith("Error compiling ") || isListed.has(line)) {
      continue;
    }
    issues.push({
      severity: "warn",
      code: "jx.build-warning",
      message: line.replace(/^Warning: /, ""),
    });
  }
  for (const message of listed) error(message);
  // An error printed live and never listed (the build aborted before its summary) is still an error.
  for (const line of body) {
    if (line.startsWith("Error compiling ") && !isListed.has(line)) error(line);
  }
  return { issues, summary };
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

export interface JxResult {
  /** The command's own verdict: exit code 0 and no error-severity issue. */
  ok: boolean;
  issues: JxIssue[];
  run: JxRun;
}

const timeoutIssue = (what: string, run: JxRun): JxIssue[] =>
  run.timedOut
    ? [
        {
          severity: "error",
          code: "jx.timeout",
          message: `jx ${what} was stopped after ${Math.round(run.ms / 1000)} s, the limit it was given (${Math.round(run.timeoutMs / 1000)} s)${what === "build" ? ": a site with a lot of media needs a longer build timeout (the images already encoded are reused by the next build)" : ""}`,
        },
      ]
    : [];

/** `jx schema`: writes `project.schema.json` and `document.schema.json` next to `project.json`. */
export async function generateSchema(dir: string, opts: JxOptions = {}): Promise<JxResult> {
  const run = await runJx(dir, ["schema"], opts);
  const issues: JxIssue[] = timeoutIssue("schema", run);
  if (run.code !== 0 && issues.length === 0) {
    const text = `${run.stderr}\n${run.stdout}`
      .split("\n")
      .filter((l) => l.trim() !== "" && !NOISE.test(l))
      .slice(-3)
      .join(" ")
      .trim();
    issues.push({
      severity: "error",
      code: "jx.schema-failed",
      message: text === "" ? `jx schema exited with ${run.code}` : text,
    });
  }
  return { ok: run.code === 0, issues, run };
}

export interface ValidateOptions extends JxOptions {
  /** Fail on a lint error too (`jx validate --strict`). */
  strict?: boolean | undefined;
  /** Leave `project.schema.json` and `document.schema.json` in the project when this run had to create them. Default false. */
  keepSchema?: boolean | undefined;
}

/**
 * `jx validate` over the whole project (`project.json` and every file under `pages/`, `components/`
 * and `layouts/`, and the collections). `validate` needs the project's schema, which `jx schema`
 * writes; when the project has none it is generated first and, unless `keepSchema`, removed again, so
 * validating leaves the project exactly as it was.
 */
export async function validateProject(
  dir: string,
  opts: ValidateOptions = {},
): Promise<JxResult & { generated: boolean }> {
  const issues: JxIssue[] = [];
  const have = existsSync(join(dir, "project.schema.json"));
  let generated = false;
  if (!have) {
    const schema = await generateSchema(dir, opts);
    generated = true;
    if (!schema.ok) {
      cleanup(dir, opts, generated);
      return { ok: false, issues: schema.issues, run: schema.run, generated };
    }
  }
  try {
    const run = await runJx(dir, ["validate", ...(opts.strict === true ? ["--strict"] : [])], opts);
    issues.push(
      ...parseValidateOutput(`${run.stdout}\n${run.stderr}`, { strict: opts.strict === true }),
      ...timeoutIssue("validate", run),
    );
    if (run.code !== 0 && !issues.some((i) => i.severity === "error")) {
      issues.push({
        severity: "error",
        code: "jx.validate-failed",
        message: `jx validate exited with ${run.code} and printed no finding`,
      });
    }
    return {
      ok: run.code === 0 && !issues.some((i) => i.severity === "error"),
      issues,
      run,
      generated,
    };
  } finally {
    cleanup(dir, opts, generated);
  }
}

function cleanup(dir: string, opts: ValidateOptions, generated: boolean): void {
  if (!generated || opts.keepSchema === true) return;
  for (const name of ["project.schema.json", "document.schema.json"]) {
    rmSync(join(dir, name), { force: true });
  }
}

export interface BuildOptions extends JxOptions {
  /** Pass `--verbose`. */
  verbose?: boolean | undefined;
  /** Pass `--no-clean`. */
  noClean?: boolean | undefined;
}

/**
 * How long a build of a site with this much media may take before it is stopped: the least a build
 * is given, or {@link BUILD_MS_PER_MEDIA_FILE} for each file the pages use, whichever is more.
 */
export function buildTimeoutFor(media: { files: number }): number {
  return Math.max(
    MIN_BUILD_TIMEOUT_MS,
    Math.ceil(Math.max(0, media.files) * BUILD_MS_PER_MEDIA_FILE),
  );
}

/**
 * Turns the lines of a `jx build` into progress messages. It prints `Optimizing <file>...` for every
 * image it has to encode, which is hundreds of lines on a media-heavy site, so those are counted and
 * one message in `every` is passed on; every other line is passed on as it is.
 */
export function buildProgress(say: (message: string) => void, every = 25): JxLineListener {
  let images = 0;
  return (line) => {
    const optimizing = /^\s*Optimizing (.+)\.\.\.$/.exec(line);
    if (optimizing !== null) {
      images += 1;
      if (images === 1 || images % every === 0) {
        say(`optimising images: ${images} so far (now ${optimizing[1]})`);
      }
      return;
    }
    const text = line.trim();
    if (text !== "") say(text);
  };
}

/** `jx build`: the static site into the project's `dist/`. */
export async function buildProject(
  dir: string,
  opts: BuildOptions = {},
): Promise<JxResult & { summary: BuildSummary }> {
  const run = await runJx(
    dir,
    [
      "build",
      ...(opts.verbose === true ? ["--verbose"] : []),
      ...(opts.noClean === true ? ["--no-clean"] : []),
    ],
    { ...opts, timeoutMs: opts.timeoutMs ?? MIN_BUILD_TIMEOUT_MS },
  );
  const parsed = parseBuildOutput(run.stdout, run.stderr);
  const issues = [...parsed.issues, ...timeoutIssue("build", run)];
  if (run.code !== 0 && !issues.some((i) => i.severity === "error")) {
    issues.push({
      severity: "error",
      code: "jx.build-failed",
      message: `jx build exited with ${run.code} and printed no error`,
    });
  }
  return {
    ok: run.code === 0 && !issues.some((i) => i.severity === "error"),
    issues,
    run,
    summary: parsed.summary,
  };
}

// ── Installing ───────────────────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  /** The command: default Bun's own (`bun install`). */
  cmd?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  onLine?: JxLineListener | undefined;
}

/** `bun install` in the project, so the packages its `package.json` names are in its `node_modules`. */
export async function installDependencies(
  dir: string,
  opts: InstallOptions = {},
): Promise<JxResult> {
  const cmd = opts.cmd ?? [process.execPath, "install"];
  const started = performance.now();
  const proc = spawn({
    cmd: [...cmd],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
  });
  const [stdout, stderr, code] = await Promise.all([
    readLines(proc.stdout, "stdout", opts.onLine),
    readLines(proc.stderr, "stderr", opts.onLine),
    proc.exited,
  ]);
  const timedOut = proc.signalCode !== null && proc.signalCode !== undefined;
  const run: JxRun = {
    code: timedOut ? 124 : code,
    stdout,
    stderr,
    ms: Math.round(performance.now() - started),
    timedOut,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
  };
  const issues = timeoutIssue("install", run);
  if (run.code !== 0 && issues.length === 0) {
    const said = `${stderr}\n${stdout}`
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .slice(-3)
      .join(" ");
    issues.push({
      severity: "error",
      code: "jx.install-failed",
      message: said === "" ? `the install exited with ${run.code}` : said,
    });
  }
  return { ok: run.code === 0, issues, run };
}

// ── Into the report ──────────────────────────────────────────────────────────────────────────────

export interface IssueReportOptions {
  /** Most issues kept per file; the rest are one `jx.validate-truncated` line. Default 40. */
  perFile?: number | undefined;
}

/**
 * Put issues in a report, located at their file (or route). A schema error cascades (one wrong
 * `tagName` makes the validator list every alternative of a `oneOf`), so a file with more than
 * `perFile` of them is cut and the cut is said.
 */
export function addIssues(
  report: Report,
  issues: readonly JxIssue[],
  opts: IssueReportOptions = {},
): void {
  const limit = Math.max(1, opts.perFile ?? 40);
  const counts = new Map<string, number>();
  const dropped = new Map<string, number>();
  for (const issue of issues) {
    const where = issue.file ?? issue.route ?? "project";
    const key = `${issue.code}\0${where}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > limit) {
      dropped.set(key, (dropped.get(key) ?? 0) + 1);
      continue;
    }
    const times = issue.count !== undefined && issue.count > 1 ? issue.count : undefined;
    report.add({
      severity: issue.severity,
      code: issue.code,
      message: times === undefined ? issue.message : `${issue.message} (×${times})`,
      where,
      data: {
        ...(times === undefined ? {} : { count: times }),
        ...(issue.pointer === undefined ? {} : { pointer: issue.pointer }),
        ...(issue.rule === undefined ? {} : { rule: issue.rule }),
        ...(issue.route === undefined ? {} : { route: issue.route }),
      },
    });
  }
  for (const [key, count] of dropped) {
    const [code, where] = key.split("\0") as [string, string];
    report.add({
      severity: "info",
      code: "jx.validate-truncated",
      message: `${count} more ${code} entr${count === 1 ? "y" : "ies"} for ${where} were left out of the report (a wrong value makes the validator list every alternative of the schema it failed)`,
      where,
      data: { code, omitted: count },
    });
  }
}
