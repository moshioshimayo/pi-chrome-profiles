/**
 * pi-chrome-profiles — Pi extension entry.
 *
 * One named real Chrome profile at a time, driven through the official
 * Playwright MCP Chrome extension relay. See README.md.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ChromeMcpClient, textOf, type McpToolInfo } from "./client.ts";
import { maskedInput } from "./masked-input.ts";
import {
  ProfileStore,
  splitProfilePath,
  validateProfilePath,
  type ProfileRecord,
} from "./store.ts";
import { SessionPin, blocksBrowserRoute } from "./state.ts";

/** Minimal structural type for ctx.ui used by pairing (matches ExtensionUIContext). */
interface UiCtx {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => unknown,
    options?: { overlay?: boolean },
  ): Promise<T>;
}

export default function chromeProfiles(pi: ExtensionAPI) {
  const store = new ProfileStore();
  const pin = new SessionPin();
  const clientFactory = (record: ProfileRecord) => new ChromeMcpClient(record);

  const consentLines = (
    name: string,
    userDataDir: string,
    profileDirName: string,
  ): string[] => [
    `Pair Chrome profile "${name}"?`,
    ``,
    `• User data dir: ${userDataDir}`,
    `• Profile directory: ${profileDirName}`,
    ``,
    `This grants Pi PERSISTENT control of that Chrome profile: every site`,
    `login, cookie and saved session in it becomes reachable by automation`,
    `until you run /chrome forget. No per-use confirmation will be asked.`,
    `The official Playwright connector may open this exact profile`,
    `(a connect page or a Chrome window) when it connects; it will never`,
    `open a different profile or create a fresh anonymous one.`,
    ``,
    `Cancel now leaves everything unchanged.`,
  ];

  async function cmdPair(
    nameArg: string | undefined,
    ctx: { ui: UiCtx; mode?: string },
  ): Promise<void> {
    const name = (
      nameArg ??
      (await ctx.ui.input("Profile name", "e.g. Work")) ??
      ""
    ).trim();
    if (!name) return void ctx.ui.notify("Pairing cancelled.", "info");
    const full = (
      (await ctx.ui.input(
        "Full Profile Path",
        "/Users/you/Library/Application Support/Google/Chrome/Profile 1",
      )) ?? ""
    ).trim();
    if (!full) return void ctx.ui.notify("Pairing cancelled.", "info");
    const split = splitProfilePath(full);
    if ("error" in split) return void ctx.ui.notify(split.error, "error");
    const markerErr = validateProfilePath(
      split.userDataDir,
      split.profileDirName,
    );
    if (markerErr)
      return void ctx.ui.notify(
        `Not a Chrome profile: ${markerErr}. Cancelled; nothing changed.`,
        "error",
      );
    const token = await ctx.ui.custom(
      (tui, theme, kb, done) =>
        maskedInput(tui, theme, kb, done, {
          title: "Playwright extension token",
          hint: "From the extension menu in THAT Chrome profile. Paste, then Enter.",
        }),
      { overlay: true },
    );
    if (!token) return void ctx.ui.notify("Pairing cancelled.", "info");
    const ok = await ctx.ui.confirm(
      "Grant persistent access?",
      consentLines(name, split.userDataDir, split.profileDirName).join("\n"),
    );
    if (!ok)
      return void ctx.ui.notify("Pairing cancelled; nothing changed.", "info");
    try {
      const rec = store.add({
        name,
        userDataDir: split.userDataDir,
        profileDirName: split.profileDirName,
        token,
      });
      ctx.ui.notify(
        `Paired "${rec.name}" (${rec.profileDirName}). Token stored mode 0600. Use chrome_use("${rec.name}") to connect.`,
        "info",
      );
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  function listText(): string {
    const rows = store.list();
    const pinned = pin.pinnedKey
      ? `Pinned: ${pin.pinnedName} (${pin.client?.connected ? "connected" : pin.connecting ? "connecting…" : pin.lastError ? "connect failed — retry with chrome_use" : "not connected"})`
      : "Pinned: none";
    if (!rows.length)
      return `No paired profiles. Run /chrome pair <name> in the TUI.\n${pinned}`;
    return [
      pinned,
      "",
      ...rows.map(
        (r) =>
          `${r.name}  →  ${r.userDataDir}/${r.profileDirName}  (paired ${r.pairedAt.slice(0, 10)})`,
      ),
    ].join("\n");
  }

  pi.registerCommand("chrome", {
    description:
      "Named Chrome profiles: list | pair <name> | forget <name> | release",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (!sub || sub === "list") {
          ctx.ui.notify(listText(), "info");
        } else if (sub === "pair") {
          if (ctx.mode !== "tui")
            return void ctx.ui.notify(
              "Pairing needs the interactive TUI (masked token input + consent).",
              "error",
            );
          await cmdPair(rest[0], ctx);
        } else if (sub === "forget") {
          const name = rest.join(" ");
          if (!name)
            return void ctx.ui.notify("Usage: /chrome forget <name>", "error");
          const rec = store.get(name);
          if (!rec)
            return void ctx.ui.notify(
              `No profile named "${name}". /chrome list`,
              "error",
            );
          if (pin.pinnedKey === rec.nameKey) await pin.release();
          store.remove(name);
          ctx.ui.notify(`Forgot "${rec.name}" (token deleted).`, "info");
        } else if (sub === "release") {
          const name = await pin.release();
          ctx.ui.notify(
            name
              ? `Released ${name} (Chrome stays open; only Pi's connection closed).`
              : "Nothing pinned.",
            "info",
          );
        } else {
          ctx.ui.notify(
            "Usage: /chrome [list|pair <name>|forget <name>|release]",
            "error",
          );
        }
      } catch (err) {
        ctx.ui.notify(
          err instanceof Error ? err.message : String(err),
          "error",
        );
      }
    },
    getArgumentCompletions: async (query) => {
      const subs = ["list", "pair", "forget", "release"];
      const parts = query.split(/\s+/);
      if (parts.length <= 1) return subs.filter((s) => s.startsWith(query));
      if (parts[0] === "forget")
        return store
          .list()
          .map((p) => `forget ${p.name}`)
          .filter((s) => s.startsWith(query));
      return [];
    },
  });

  pi.registerTool({
    name: "chrome_profiles",
    label: "Chrome Profiles",
    description:
      "List paired named Chrome profiles and the current pin/connection state. Never returns tokens.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: listText() }],
      details: {},
    }),
  });

  pi.registerTool({
    name: "chrome_use",
    label: "Chrome Use",
    description:
      "Pin this session to one named Chrome profile and connect it through the official Playwright extension relay. A different profile is rejected until a human runs /chrome release. While pinned, other browser tools are blocked; use chrome_browser for all browser actions.",
    parameters: Type.Object({
      name: Type.String({ description: "Profile name from chrome_profiles" }),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const record = store.get(params.name);
      if (!record) {
        return {
          content: [
            {
              type: "text",
              text: `No profile named "${params.name}". Known:\n${
                store
                  .list()
                  .map((r) => `- ${r.name}`)
                  .join("\n") || "  (none — pair via /chrome pair <name>)"
              }`,
            },
          ],
          details: {},
          isError: true,
        };
      }
      try {
        const { tools, reused } = await pin.use(record, clientFactory, signal);
        const names = tools.map((t) => t.name);
        return {
          content: [
            {
              type: "text",
              text: `${reused ? "Already pinned+connected to" : "Connected to"} Chrome profile "${record.name}" (${record.profileDirName}). The live browser answered a browser_tabs handshake.\nUse chrome_browser with one of ${tools.length} tools:\n${names.map((n) => `- ${n}`).join("\n")}`,
            },
          ],
          details: { name: record.name, reused },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Connect failed for "${record.name}" (pin retained; /chrome release to drop it, or retry chrome_use):\n${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "chrome_browser",
    label: "Chrome Browser",
    description:
      "Run one @playwright/mcp browser tool on the pinned Chrome profile. Omit tool to list available tools. Never accepts or returns credentials.",
    parameters: Type.Object({
      tool: Type.Optional(
        Type.String({ description: "MCP tool name, e.g. browser_navigate" }),
      ),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Tool arguments",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      if (!params.tool) {
        if (!pin.client?.connected)
          return {
            content: [
              {
                type: "text",
                text: "Not connected. Call chrome_use(name) first.",
              },
            ],
            details: {},
            isError: true,
          };
        const inv: string = pin.client.tools
          .map(
            (t: McpToolInfo) =>
              `- ${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 120)}`,
          )
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Pinned to "${pin.pinnedName}". Tools:\n${inv}`,
            },
          ],
          details: {},
        };
      }
      try {
        const res = await pin.browser(
          params.tool,
          params.arguments ?? {},
          signal,
        );
        return { content: res.content, details: {}, isError: res.isError };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.on("tool_call", (event) => {
    if (event.toolName.startsWith("chrome_")) return {};
    const blocked = blocksBrowserRoute(pin, event.toolName, event.input ?? {});
    if (blocked) return { block: true, reason: pin.gateMessage() ?? "blocked" };
    return {};
  });

  pi.on("session_shutdown", async () => {
    await pin.shutdown();
  });
}
