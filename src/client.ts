/**
 * MCP client bound to ONE paired Chrome profile via the official
 * @playwright/mcp extension relay. Thin wrapper: spawns the pinned server
 * (shell:false argv), allowlists env, redacts every byte that comes back,
 * and proves the browser is actually reachable before reporting connected.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeRedactor, redactDeep, type Redactor } from "./redact.ts";
import { validateProfilePath, type ProfileRecord } from "./store.ts";

export const SERVER_VERSION = "0.0.83"; // pinned in package.json; kept in sync deliberately
export const HANDSHAKE_TOOL = "browser_tabs"; // {action:"list"} — harmless read proving CDP relay + browser are live
export const CONNECT_TIMEOUT_MS = 60_000;
export const CALL_TIMEOUT_MS = 180_000;
const STDERR_TAIL_LINES = 20;

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Resolve the pinned playwright-mcp cli inside our own node_modules (cli.js is not in the exports map). */
export function serverCliPath(): string {
  const req = createRequire(import.meta.url);
  return path.join(
    path.dirname(req.resolve("@playwright/mcp/package.json")),
    "cli.js",
  );
}

/** Exact child identity: node + cli.js + extension flags for this one profile. */
export function buildSpawnSpec(
  record: Pick<ProfileRecord, "userDataDir" | "profileDirName" | "token">,
  opts?: { executablePath?: string; headless?: boolean },
): SpawnSpec {
  const args = [
    serverCliPath(),
    "--extension",
    "--browser",
    "chrome",
    ...(opts?.executablePath ? ["--executable-path", opts.executablePath] : []),
    ...(opts?.headless ? ["--headless"] : []),
    "--user-data-dir",
    record.userDataDir,
    "--profile-dir-name",
    record.profileDirName,
  ];
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = record.token;
  return { command: process.execPath, args, env };
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export class ChromeMcpClient {
  readonly record: ProfileRecord;
  readonly redactor: Redactor;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private stderrChunks: string[] = [];
  tools: McpToolInfo[] = [];
  connected = false;

  /** Injection points for tests: fake transport / fake MCP client. */
  makeTransport: (spec: SpawnSpec) => StdioClientTransport = (spec) =>
    new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      stderr: "pipe",
    });
  makeClient: () => Client = () =>
    new Client({ name: "pi-chrome-profiles", version: "0.1.0" });

  constructor(record: ProfileRecord) {
    this.record = record;
    this.redactor = makeRedactor(record.token);
  }

  /** Spawn + initialize + listTools + force a harmless browser op. Only then is connected=true. */
  async connect(signal?: AbortSignal): Promise<McpToolInfo[]> {
    if (this.client) throw new Error("client already connected");
    signal?.throwIfAborted();
    const invalid = validateProfilePath(
      this.record.userDataDir,
      this.record.profileDirName,
    );
    if (invalid)
      throw new Error(
        `Chrome profile is unavailable: ${invalid}. No browser was opened.`,
      );
    const spec = buildSpawnSpec(this.record);
    this.transport = this.makeTransport(spec) as StdioClientTransport;
    this.client = this.makeClient();
    try {
      this.watchStderr();
      await this.withTimeout(
        this.client.connect(this.transport),
        "MCP initialize timed out",
        signal,
      );
      const { tools } = await this.withTimeout(
        this.client.listTools(undefined, { signal }),
        "listTools timed out",
        signal,
      );
      this.tools = tools.map((t) => ({
        name: t.name,
        description: t.description ? this.redactor(t.description) : undefined,
        inputSchema: redactDeep(t.inputSchema, this.redactor) as Record<
          string,
          unknown
        >,
      }));
      // Astra caution: initialize/listTools is NOT a browser connection. Force one
      // harmless read through the relay before reporting connected.
      const probe = await this.callTool(
        HANDSHAKE_TOOL,
        { action: "list" },
        signal,
      );
      if (probe.isError)
        throw new Error(`handshake failed: ${textOf(probe.content)}`);
      this.connected = true;
      return this.tools;
    } catch (err) {
      const msg = this.redactor(
        err instanceof Error ? `${err.message}` : String(err),
      );
      await this.safeClose();
      throw new Error(
        `${msg}\n${this.stderrHint()}\nHints: the official Playwright extension must be installed in Chrome profile "${this.record.profileDirName}" (user data ${this.record.userDataDir}) and its token must match. Chrome may have opened a connect page in that profile — Chrome stays untouched otherwise.`,
      );
    }
  }

  /** Every connect-phase await is bounded (unbounded SDK waits hang silently). */
  private withTimeout<T>(
    p: Promise<T>,
    what: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const t = setTimeout(
        () => reject(new Error(`${what} after ${CONNECT_TIMEOUT_MS / 1000}s`)),
        CONNECT_TIMEOUT_MS,
      );
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          clearTimeout(t);
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  private watchStderr(): void {
    const stderr = this.transport?.stderr;
    if (!stderr) return;
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      const line = this.redactor(chunk).trim();
      if (line) {
        this.stderrChunks.push(line);
        if (this.stderrChunks.length > STDERR_TAIL_LINES)
          this.stderrChunks.shift();
      }
    });
  }

  private stderrHint(): string {
    if (!this.stderrChunks.length) return "";
    return `server stderr (redacted): ${this.stderrChunks.join(" | ").slice(-800)}`;
  }

  /** Deny-list: operations that could launch/fresh-install/kill a browser are not ours to run. */
  static deniedTool(name: string): boolean {
    return /^browser_(install|close|launch)/i.test(name);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: PiContent[]; isError: boolean }> {
    if (!this.client) throw new Error("not connected");
    if (ChromeMcpClient.deniedTool(name))
      throw new Error(
        `tool ${name} is blocked (it could launch or close a browser)`,
      );
    try {
      const res = await this.client.callTool(
        { name, arguments: args },
        undefined,
        {
          signal,
          timeout: CALL_TIMEOUT_MS,
        },
      );
      const content: PiContent[] = [];
      for (const item of (res.content ?? []) as Array<
        Record<string, unknown>
      >) {
        if (item.type === "text" && typeof item.text === "string") {
          content.push({ type: "text", text: this.redactor(item.text) });
        } else if (item.type === "image" && typeof item.data === "string") {
          content.push({
            type: "image",
            data: item.data,
            mimeType:
              typeof item.mimeType === "string" ? item.mimeType : "image/png",
          });
        }
      }
      return { content, isError: Boolean(res.isError) };
    } catch (error) {
      throw new Error(
        this.redactor(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Closes OUR transport (SIGTERM to our own server child). Never touches Chrome or user tabs. */
  async safeClose(): Promise<void> {
    this.connected = false;
    const t = this.transport;
    this.transport = undefined;
    this.client = undefined;
    if (!t) return;
    try {
      await t.close();
    } catch {
      // transport already gone; nothing to clean
    }
  }
}

export function textOf(content: PiContent[]): string {
  return content
    .map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`))
    .join("\n")
    .slice(0, 4000);
}
