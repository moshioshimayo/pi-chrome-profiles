/**
 * pi-chrome-profiles — Pi extension entry.
 *
 * One named real Chrome profile at a time, driven through the official
 * Playwright MCP Chrome extension relay. See README.md.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import {
  discoverChromeProfiles,
  openChromeSetup,
  type DetectedProfile,
} from "./profiles.ts";
import { ChromeMcpClient, textOf, type McpToolInfo } from "./client.ts";
import { maskedInput } from "./masked-input.ts";
import {
  ProfileStore,
  splitProfilePath,
  validateProfilePath,
  type ProfileRecord,
} from "./store.ts";
import { SessionPin, blocksBrowserRoute } from "./state.ts";

export default function chromeProfiles(
  pi: ExtensionAPI,
  options: {
    discover?: typeof discoverChromeProfiles;
    openSetup?: typeof openChromeSetup;
    createClient?: (record: ProfileRecord) => ChromeMcpClient;
  } = {},
) {
  const store = new ProfileStore();
  const pin = new SessionPin();
  const clientFactory =
    options.createClient ??
    ((record: ProfileRecord) => new ChromeMcpClient(record));
  const discover = options.discover ?? discoverChromeProfiles;
  const openSetup = options.openSetup ?? openChromeSetup;

  const consentLines = (name: string): string[] => [
    `Let Pi automate "${name}", including sites you're signed into?`,
    ``,
    `You'll copy a Playwright token once. Pi saves it privately and can`,
    `reconnect without asking again until /chrome forget ${name}.`,
    `Only this Chrome profile is used; it may be opened if closed.`,
    `No tokens are imported automatically. Cancel saves nothing.`,
  ];

  async function pairProfile(
    profile: DetectedProfile,
    name: string,
    ctx: ExtensionCommandContext,
    guided: boolean,
  ): Promise<ProfileRecord | undefined> {
    const invalid = validateProfilePath(
      profile.userDataDir,
      profile.profileDirName,
    );
    if (invalid) {
      ctx.ui.notify(`That Chrome profile is unavailable: ${invalid}`, "error");
      return;
    }
    if (
      !(await ctx.ui.confirm(`Connect ${name}?`, consentLines(name).join("\n")))
    )
      return;
    if (guided) {
      if (!profile.extensionInstalled) {
        ctx.ui.notify(
          `Opening the official Playwright extension installer in ${name}. Approve installation in Chrome yourself.`,
          "info",
        );
        await openSetup(profile, "install");
        const next = await ctx.ui.select(
          `Install Playwright in ${name}, then return here`,
          ["Installed — continue", "Cancel"],
        );
        if (next !== "Installed — continue") return;
      }
      await openSetup(profile, "token");
    }
    const token = await ctx.ui.custom<string | null>(
      (tui, _theme, _kb, done) =>
        maskedInput(tui, done, {
          title: `Connect ${name} — one-time setup`,
          hint: guided
            ? "In Chrome: click Copy token. Paste here once; press Enter."
            : "Copy this profile's Playwright token. Paste here; press Enter.",
        }),
      { overlay: true },
    );
    if (!token) {
      ctx.ui.notify("Setup cancelled; nothing saved.", "info");
      return;
    }
    const paired = store.add({
      name,
      userDataDir: profile.userDataDir,
      profileDirName: profile.profileDirName,
      token,
    });
    ctx.ui.notify(
      `Paired "${paired.name}". You won't need to repeat setup.`,
      "info",
    );
    return store.get(paired.name);
  }

  async function connectProfile(
    record: ProfileRecord,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    ctx.ui.notify(`Connecting to ${record.name}…`, "info");
    try {
      // A human picker choice may switch profiles; agent-side chrome_use cannot.
      if (pin.pinnedKey && pin.pinnedKey !== record.nameKey)
        await pin.release();
      await pin.use(record, clientFactory);
      ctx.ui.setStatus?.("chrome-profile", `Chrome: ${record.name}`);
      ctx.ui.notify(
        `Connected to ${record.name}. Tell your agent what to do; browsing stays in this profile.`,
        "info",
      );
    } catch (error) {
      ctx.ui.setStatus?.(
        "chrome-profile",
        `Chrome: ${record.name} (not connected)`,
      );
      ctx.ui.notify(
        `Could not connect to ${record.name}: ${error instanceof Error ? error.message : String(error)}\nYour pairing is saved. Check Playwright in that Chrome profile, then /chrome connect ${record.name}.`,
        "error",
      );
    }
  }

  async function cmdConnect(
    name: string | undefined,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const saved = name ? store.get(name) : undefined;
    if (saved) {
      await connectProfile(saved, ctx);
      return;
    }
    const paired = store.list();
    const identity = (
      profile: Pick<ProfileRecord, "userDataDir" | "profileDirName">,
    ) => path.resolve(profile.userDataDir, profile.profileDirName);
    const known = new Set(paired.map(identity));
    const detected = discover().filter(
      (profile) => !known.has(identity(profile)),
    );
    const choices = [
      ...paired.map((profile) => ({
        label: `${profile.name} · saved`,
        savedName: profile.name,
      })),
      ...detected.map((profile) => ({
        label: `${profile.name}${detected.filter((other) => other.name === profile.name).length > 1 ? ` (${profile.profileDirName})` : ""} · first-time setup`,
        profile,
      })),
    ];
    const manual = "Advanced: enter a profile path";
    const selected = await ctx.ui.select(
      name
        ? `Choose the Chrome profile for ${name}`
        : "Connect Chrome — choose a profile",
      [...choices.map((choice) => choice.label), manual],
    );
    if (!selected) return;
    if (selected === manual) {
      await cmdPair(name, ctx);
      return;
    }
    const choice = choices.find((item) => item.label === selected);
    if (!choice) return;
    if ("savedName" in choice) {
      const record = store.get(choice.savedName);
      if (record) await connectProfile(record, ctx);
      return;
    }
    let friendlyName = name || choice.profile.name;
    for (let suffix = 2; store.get(friendlyName); suffix++)
      friendlyName = `${name || choice.profile.name} (${suffix})`;
    const record = await pairProfile(choice.profile, friendlyName, ctx, true);
    if (record) await connectProfile(record, ctx);
  }

  async function cmdPair(
    nameArg: string | undefined,
    ctx: ExtensionCommandContext,
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
    const record = await pairProfile(
      { name, ...split, extensionInstalled: false },
      name,
      ctx,
      false,
    );
    if (record)
      ctx.ui.notify(
        `Saved ${record.name}. Use /chrome connect ${record.name} to connect.`,
        "info",
      );
  }

  function listText(): string {
    const rows = store.list();
    const pinned = pin.pinnedKey
      ? `Pinned: ${pin.pinnedName} (${pin.client?.connected ? "connected" : pin.connecting ? "connecting…" : pin.lastError ? "connect failed — retry with chrome_use" : "not connected"})`
      : "Pinned: none";
    if (!rows.length)
      return `No paired profiles. Run /chrome connect to choose Chrome and get set up.\n${pinned}`;
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
      "Connect Chrome: pick a profile, guided setup once, then one-choice reconnect. Advanced: list | pair --manual <name> | forget <name> | release",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (sub === "list" || (!sub && ctx.mode !== "tui")) {
          ctx.ui.notify(listText(), "info");
        } else if (!sub || sub === "connect" || sub === "pair") {
          if (ctx.mode !== "tui")
            return void ctx.ui.notify(
              "Pairing needs the interactive TUI (masked token input + consent).",
              "error",
            );
          if (sub === "pair" && rest[0] === "--manual")
            await cmdPair(rest.slice(1).join(" ") || undefined, ctx);
          else await cmdConnect(rest.join(" ") || undefined, ctx);
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
          if (
            !(await ctx.ui.confirm(
              "Forget Chrome profile?",
              `Remove pairing for "${rec.name}"? Chrome and its data stay untouched.`,
            ))
          )
            return;
          if (pin.pinnedKey === rec.nameKey) await pin.release();
          store.remove(name);
          ctx.ui.notify(`Forgot "${rec.name}" (token deleted).`, "info");
        } else if (sub === "release") {
          const name = await pin.release();
          ctx.ui.setStatus?.("chrome-profile", undefined);
          ctx.ui.notify(
            name
              ? `Released ${name} (Chrome stays open; only Pi's connection closed).`
              : "Nothing pinned.",
            "info",
          );
        } else {
          ctx.ui.notify(
            "Usage: /chrome connect [name] | list | pair --manual [name] | forget <name> | release",
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
      const subs = ["connect", "list", "pair", "forget", "release"];
      const target = query.startsWith("forget ")
        ? "forget"
        : query.startsWith("connect ")
          ? "connect"
          : undefined;
      const values = target
        ? store.list().map((profile) => `${target} ${profile.name}`)
        : subs;
      return values
        .filter((value) => value.startsWith(query))
        .map((value) => ({ value, label: value }));
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
                  .join("\n") ||
                "  (none — use /chrome connect for guided setup)"
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
              `- ${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 120)}\n  arguments: ${JSON.stringify(t.inputSchema ?? { type: "object" })}`,
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
