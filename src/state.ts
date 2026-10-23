/**
 * Session pin: at most ONE pinned profile client per session, pinned BEFORE
 * the connection attempt and retained on failure until a human /chrome release.
 * All lifecycle ops (use/browser/release) serialize through one queue; stale
 * completions are invalidated by generation counter.
 */
import { ChromeMcpClient, type McpToolInfo, type PiContent } from "./client.ts";
import type { ProfileRecord } from "./store.ts";

export class SessionPin {
  pinnedName: string | null = null;
  pinnedKey: string | null = null;
  client: ChromeMcpClient | null = null;
  lastError: string | null = null;
  connecting = false;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();

  /** Serialize lifecycle ops; the returned fn runs inside the queue. */
  run<T>(op: (gen: number) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => op(this.generation));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private bump(): number {
    return ++this.generation;
  }

  currentGen(): number {
    return this.generation;
  }

  /**
   * Pin (before connecting — Astra caution) and connect.
   * Uses the injected clientFactory so tests can supply a fake transport.
   */
  use(
    record: ProfileRecord,
    clientFactory: (record: ProfileRecord) => ChromeMcpClient,
    signal?: AbortSignal,
  ): Promise<{
    client: ChromeMcpClient;
    tools: McpToolInfo[];
    reused: boolean;
  }> {
    return this.run(async (gen) => {
      const key = record.nameKey;
      if (this.pinnedKey && this.pinnedKey !== key) {
        throw new Error(
          `session is pinned to Chrome profile "${this.pinnedName}". A human must run /chrome release before another profile can be selected.`,
        );
      }
      // Pin FIRST, before any connection attempt; retained on failure.
      this.pinnedKey = key;
      this.pinnedName = record.name;
      if (this.client?.connected)
        return { client: this.client, tools: this.client.tools, reused: true };
      await this.client?.safeClose();
      this.client = null;
      this.connecting = true;
      const client = clientFactory(record);
      try {
        const tools = await client.connect(signal);
        if (gen !== this.generation) {
          // released while we were connecting — close and report stale
          await client.safeClose();
          throw new Error("released while connecting");
        }
        this.client = client;
        this.lastError = null;
        return { client, tools, reused: false };
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        await client.safeClose();
        throw err;
      } finally {
        this.connecting = false;
      }
    });
  }

  browser(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: PiContent[]; isError: boolean }> {
    return this.run(async (gen) => {
      if (!this.client?.connected) {
        throw new Error(
          this.pinnedKey
            ? `pinned profile "${this.pinnedName}" is not connected${this.lastError ? ` (last error: ${this.lastError})` : ""}; call chrome_use("${this.pinnedName}") to retry`
            : "no Chrome profile pinned; call chrome_use(name) first",
        );
      }
      const res = await this.client.callTool(tool, args, signal);
      if (gen !== this.generation)
        throw new Error(
          "released while this call was in flight; result discarded",
        );
      return res;
    });
  }

  /** Returns the released profile name, or null if none pinned. */
  release(): Promise<string | null> {
    return this.run(async () => {
      this.bump();
      const name = this.pinnedName;
      await this.client?.safeClose();
      this.client = null;
      this.pinnedName = null;
      this.pinnedKey = null;
      this.lastError = null;
      return name;
    });
  }

  /** For tool_call gating while pinned. */
  gateMessage(): string | null {
    if (!this.pinnedKey) return null;
    return `pinned to Chrome profile "${this.pinnedName}"; use chrome_browser (or /chrome release) instead`;
  }

  async shutdown(): Promise<void> {
    await this.release().catch(() => null);
  }
}

/**
 * While pinned, block other browser-automation routes — including generic MCP
 * dispatcher tools that name a browser_ tool in their input (Astra caution 4).
 * Unrelated tools pass through.
 */
export function blocksBrowserRoute(
  pin: { pinnedKey: string | null },
  toolName: string,
  input: unknown,
): string | null {
  if (!pin.pinnedKey) return null;
  if (toolName.startsWith("chrome_")) return null; // our own surface
  const name = toolName.toLowerCase();
  if (name === "agent_browser" || name.startsWith("agent_browser_"))
    return toolName;
  if (
    name === "computer" ||
    name.startsWith("computer_") ||
    name.startsWith("computeruse")
  )
    return toolName;
  if (/^mcp__/.test(name)) {
    const tail = name.split("__").pop() ?? "";
    if (tail.startsWith("browser_")) return toolName;
  }
  if (name.startsWith("browser_")) return toolName;
  // generic MCP dispatchers (mcp, mcp_call, mcpScript, …): inspect input for a browser_ tool selection
  if (/^mcp/.test(name)) {
    const seen = new Set<unknown>();
    const scan = (v: unknown): boolean => {
      if (v === null || typeof v !== "object") {
        return typeof v === "string" && /^browser_[a-z_]+$/i.test(v.trim());
      }
      if (seen.has(v)) return false;
      seen.add(v);
      if (Array.isArray(v)) return v.some(scan);
      return Object.values(v as Record<string, unknown>).some(scan);
    };
    if (scan(input)) return toolName;
  }
  return null;
}
