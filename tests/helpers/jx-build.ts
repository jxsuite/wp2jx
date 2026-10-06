/**
 * Build real Jx projects in tests. A project is a handful of files written into a fresh directory
 * under `.dev/tmp/` (inside the repository, so `@jxsuite/*` extensions resolve from its
 * `node_modules`) and built with the installed `jx` CLI; a tiny one takes about 0.2 s.
 *
 *   const site = await buildJxProject({ "pages/index.json": { children: [{ tagName: "p", textContent: "hi" }] } });
 *   site.html("/");            // dist/index.html
 *   site.read("sitemap.xml");  // any file under dist/
 *
 * Call `cleanupJxProjects()` in `afterAll`. A process-exit hook removes whatever a crashed run left
 * behind; set `WP2JX_KEEP_TMP=1` to keep the directories for inspection.
 */
import { spawn } from "bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
export const JX_BIN = join(ROOT, "node_modules/.bin/jx");
export const TMP_ROOT = join(ROOT, ".dev/tmp");

/** A file's content: text as is, bytes as is, anything else as pretty-printed JSON. */
export type ProjectFile = string | Uint8Array | object;

export interface BuildOptions {
  /** Prefix of the directory name, so a leftover directory says whose it was. */
  name?: string;
  /** Extra arguments after `build` (`["--verbose"]`). */
  args?: string[];
  /** Write the project but do not build it (for `validateJxProject`). */
  build?: boolean;
  /** Return a failed build instead of throwing; `code` and `stderr` say what happened. */
  allowFailure?: boolean;
  /** Kill the build after this long. Default 60 s. */
  timeoutMs?: number;
}

export interface JxRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BuiltProject extends JxRun {
  /** The project directory. */
  dir: string;
  /** `<dir>/dist`. */
  dist: string;
  /** A file under `dist/`, by path relative to it. Throws if it does not exist. */
  read(path: string): string;
  /** The page a route builds to: `"/"`, `"/about/"`, `"about"` and `"/about/index.html"` all work. */
  html(route?: string): string;
  /** Whether `dist/<path>` exists. */
  exists(path: string): boolean;
  /** Every file under `dist/`, relative paths with forward slashes. */
  list(): string[];
}

export interface ValidateResult extends JxRun {
  ok: boolean;
  /** One entry per schema complaint: `pages/index.json /children/1/tagName: must be string`. */
  problems: string[];
}

const created = new Set<string>();
let hooked = false;

/**
 * Where `jx build` keeps the images it encodes. Jx asks npm for its cache directory and files them
 * under `<cache>/jxsuite-images/<project directory name>`, so every throwaway project of every test
 * run left a directory in the developer's own ~/.npm (37,000 of them, 600 MB, were found there).
 * The builds of a test process share one cache of their own, removed with the projects.
 */
let imageCache: string | undefined;
function imageCacheDir(): string {
  if (imageCache === undefined) {
    mkdirSync(TMP_ROOT, { recursive: true });
    imageCache = mkdtempSync(join(TMP_ROOT, "npm-cache-"));
    created.add(imageCache);
    if (!hooked) {
      hooked = true;
      process.once("exit", cleanupJxProjects);
    }
  }
  return imageCache;
}

/** Remove every project directory this process created. */
export function cleanupJxProjects(): void {
  if (process.env.WP2JX_KEEP_TMP) return;
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.clear();
  imageCache = undefined;
}

const toBytes = (content: ProjectFile): string | Uint8Array =>
  typeof content === "string" || content instanceof Uint8Array
    ? content
    : JSON.stringify(content, null, 2);

/** Write a project's files into a new directory under `.dev/tmp/` and return its path. */
export function writeJxProject(
  files: Record<string, ProjectFile>,
  options: { name?: string } = {},
): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TMP_ROOT, `${options.name ?? "p"}-`));
  created.add(dir);
  if (!hooked) {
    hooked = true;
    process.once("exit", cleanupJxProjects);
  }
  const all: Record<string, ProjectFile> = {
    "project.json": { name: "wp2jx-test", url: "https://example.com" },
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    const target = resolve(dir, path);
    if (target !== dir && !target.startsWith(dir + sep))
      throw new Error(`path leaves the project: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, toBytes(content));
  }
  return dir;
}

/** The CLI's shebang is `env node`; where node is absent, run the same file under Bun. */
const launcher = (): string[] => (Bun.which("node") ? [JX_BIN] : [process.execPath, JX_BIN]);

/** Run `jx <args>` in `dir`. */
export async function runJx(dir: string, args: string[], timeoutMs = 60_000): Promise<JxRun> {
  const proc = spawn({
    cmd: [...launcher(), ...args],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", npm_config_cache: imageCacheDir() },
    timeout: timeoutMs,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else out.push(relative(root, path).split(sep).join("/"));
  }
  return out.sort();
}

/**
 * Write `files` as a project (a default `project.json` is added unless given) and run `jx build`
 * in it. A failed build throws with the CLI's own output unless `allowFailure` is set.
 */
export async function buildJxProject(
  files: Record<string, ProjectFile>,
  options: BuildOptions = {},
): Promise<BuiltProject> {
  const dir = writeJxProject(files, options.name === undefined ? {} : { name: options.name });
  const dist = join(dir, "dist");
  const run: JxRun =
    options.build === false
      ? { code: 0, stdout: "", stderr: "" }
      : await runJx(dir, ["build", ...(options.args ?? [])], options.timeoutMs);
  if (run.code !== 0 && !options.allowFailure) {
    throw new Error(`jx build failed (exit ${run.code}) in ${dir}\n${run.stdout}${run.stderr}`);
  }
  const inDist = (path: string): string => {
    const target = resolve(dist, path);
    if (!target.startsWith(dist + sep)) throw new Error(`path leaves dist/: ${path}`);
    return target;
  };
  return {
    ...run,
    dir,
    dist,
    read: (path) => readFileSync(inDist(path), "utf8"),
    exists: (path) => existsSync(inDist(path)),
    list: () => (existsSync(dist) ? listFiles(dist) : []),
    html(route = "/") {
      const clean = route.replace(/^\/+|\/+$/g, "");
      const file = clean.endsWith(".html") ? clean : join(clean, "index.html");
      return readFileSync(inDist(file), "utf8");
    },
  };
}

/**
 * The project files a page needs when its `state` points at content collections (a converted query
 * loop does): the `@jxsuite/parser` extension, a Markdown collection for every `contentType` the
 * state names, and one stub entry in each. The pages' own content is what a test judges, so the
 * entry is a stand-in. Spread `config` into `project.json` and `files` beside it.
 */
export function stubCollections(states: readonly Record<string, unknown>[]): {
  config: Record<string, unknown>;
  files: Record<string, string>;
} {
  const types = new Set<string>();
  for (const state of states) {
    for (const entry of Object.values(state)) {
      const type = (entry as { contentType?: unknown } | null)?.contentType;
      if (typeof type === "string") types.add(type);
    }
  }
  if (types.size === 0) return { config: {}, files: {} };
  return {
    config: {
      extensions: ["@jxsuite/parser"],
      content: Object.fromEntries(
        [...types].map((type) => [
          type,
          {
            source: `content/${type}`,
            format: "Markdown",
            schema: {
              type: "object",
              properties: { title: { type: "string" }, slug: { type: "string" } },
              required: ["title"],
            },
          },
        ]),
      ),
    },
    files: Object.fromEntries(
      [...types].map((type) => [
        `content/${type}/stub.md`,
        "---\ntitle: Stub\nslug: stub\n---\n\nBody.\n",
      ]),
    ),
  };
}

/** The "format ignored" lines the schema compiler prints on every run; they are not findings. */
const NOISE = /^unknown format ".*" ignored in schema/;

/**
 * Run `jx validate` on a project directory (generating its `project.schema.json` first when it has
 * none, which `validate` requires). `ok` is the CLI's exit status.
 */
export async function validateJxProject(dir: string, args: string[] = []): Promise<ValidateResult> {
  if (!existsSync(join(dir, "project.schema.json"))) await runJx(dir, ["schema"]);
  const run = await runJx(dir, ["validate", ...args]);
  const problems: string[] = [];
  let file = "";
  for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) {
    if (NOISE.test(line)) continue;
    const item = /^ {2}- (.*)$/.exec(line);
    if (item) problems.push(`${file} ${item[1]}`.trim());
    else if (/^\S.*:$/.test(line) && !line.startsWith("Project is")) file = line.slice(0, -1);
  }
  return { ...run, ok: run.code === 0, problems };
}
