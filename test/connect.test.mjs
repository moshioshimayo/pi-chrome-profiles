import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chromeProfiles from "../src/index.ts";
import { discoverChromeProfiles, EXTENSION_ID } from "../src/profiles.ts";

const oldHome = process.env.HOME;
const homes = [];
after(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function wizard() {
  const home = mkdtempSync(join(tmpdir(), "chrome-connect-wizard-")); homes.push(home);
  process.env.HOME = home;
  const root = join(home, "Chrome");
  for (const dir of ["Profile 1", "Profile 2"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "Preferences"), "{}");
  }
  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 1": { name: "Work" }, "Profile 2": { name: "Personal" } } } }));
  mkdirSync(join(root, "Profile 1", "Extensions", EXTENSION_ID), { recursive: true });
  const commands = new Map(), tools = new Map(), hooks = new Map();
  const opened = [], connections = [], messages = [], confirmations = [], statuses = [], menus = [];
  const state = { pick: "Work", consent: true, cancelPicker: false, cancelToken: false, fail: false, tokens: 0 };
  chromeProfiles({ registerCommand: (name, command) => commands.set(name, command), registerTool: (tool) => tools.set(tool.name, tool), on: (name, callback) => hooks.set(name, callback) }, {
    discover: () => discoverChromeProfiles(root),
    openSetup: async (profile, page) => { opened.push({ profile, page }); },
    createClient: (record) => {
      const client = { record, connected: false, closed: 0, tools: [{ name: "browser_tabs", inputSchema: { type: "object" } }],
        async connect() { connections.push(record); if (state.fail) throw new Error("fixture connection refused"); this.connected = true; },
        async safeClose() { this.connected = false; this.closed++; },
      };
      connections.clients.push(client);
      return client;
    },
  });
  connections.clients = [];
  const ctx = { mode: "tui", hasUI: true, ui: {
    select: async (title, options) => {
      menus.push({ title, options });
      if (state.cancelPicker) return undefined;
      return title.startsWith("Install Playwright") ? "Installed — continue" : options.find((label) => label.startsWith(state.pick));
    },
    input: async () => assert.fail("the normal connection flow must not ask for a profile path or name"),
    confirm: async (title, text) => { confirmations.push({ title, text }); return state.consent; },
    notify: (message) => messages.push(message),
    setStatus: (key, value) => statuses.push({ key, value }),
    custom: async (factory) => new Promise((resolve) => {
      state.tokens++;
      const component = factory({ requestRender() {} }, {}, {}, resolve);
      if (state.cancelToken) { component.handleInput("\x1b"); return; }
      component.handleInput("\x1b[200~PLAYWRIGHT_MCP_EXTENSION_TOKEN=fixture-only-token\x1b[201~");
      assert.ok(!component.render(90).join("\n").includes("fixture-only-token"));
      component.handleInput("\r");
    }),
  } };
  return { run: (args = "") => commands.get("chrome").handler(args, ctx), tools, state, opened, connections, messages, confirmations, statuses, menus, root };
}

test("/chrome defaults to named-profile picker; first setup opens the right token page and reconnect needs no manual fields", async () => {
  const h = wizard();
  await h.run();
  assert.ok(h.menus[0].options.includes("Work · first-time setup"));
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].page, "token");
  assert.equal(h.opened[0].profile.profileDirName, "Profile 1");
  assert.equal(h.connections[0].userDataDir, h.root);
  assert.equal(h.connections[0].token, "fixture-only-token");
  assert.equal(h.state.tokens, 1);
  assert.match(h.confirmations[0].text, /sites you're signed into/);
  assert.ok(h.messages.some((message) => message.startsWith("Connected to Work")));
  assert.equal(h.statuses.at(-1).value, "Chrome: Work");
  await h.run("connect");
  await h.run("connect Work");
  assert.equal(h.state.tokens, 1, "saved profile never repeats token setup");
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.opened.length, 1);
  assert.equal(h.connections.length, 1, "same live client is reused");
  assert.ok(!h.messages.join("\n").includes("fixture-only-token"));
  await h.run("release");
});

test("missing extension has an in-profile install step, not filesystem instructions", async () => {
  const h = wizard(); h.state.pick = "Personal";
  await h.run("connect");
  assert.deepEqual(h.opened.map((item) => [item.profile.profileDirName, item.page]), [["Profile 2", "install"], ["Profile 2", "token"]]);
  assert.equal(h.connections[0].profileDirName, "Profile 2");
  assert.equal(h.state.tokens, 1);
  assert.ok(h.messages.some((message) => message.includes("Approve installation in Chrome yourself")));
  await h.run("release");
});

test("cancelled consent or token saves nothing and never connects a browser", async () => {
  const h = wizard(); h.state.consent = false;
  await h.run("connect");
  assert.equal(h.opened.length, 0);
  assert.equal(h.state.tokens, 0);
  h.state.consent = true; h.state.cancelToken = true;
  await h.run("connect");
  assert.equal(h.connections.length, 0);
  const listed = await h.tools.get("chrome_profiles").execute();
  assert.ok(listed.content[0].text.includes("No paired profiles"));
});

test("human picker can switch profiles in one flow; the agent still cannot switch the resulting pin", async () => {
  const h = wizard();
  await h.run("connect");
  h.state.pick = "Personal";
  await h.run("connect");
  assert.equal(h.connections.clients[0].closed, 1);
  assert.equal(h.connections.at(-1).profileDirName, "Profile 2");
  const denied = await h.tools.get("chrome_use").execute("test", { name: "Work" });
  assert.equal(denied.isError, true);
  assert.equal(h.connections.length, 2);
  await h.run("release");
});

test("connection failure keeps pairing for an explicit one-choice retry, with no automatic fallback", async () => {
  const h = wizard(); h.state.fail = true;
  await h.run("connect");
  assert.equal(h.connections.length, 1);
  assert.ok(h.messages.some((message) => message.includes("Your pairing is saved")));
  assert.ok(!h.messages.some((message) => message.startsWith("Connected to")));
  h.state.fail = false;
  await h.run("connect Work");
  assert.equal(h.state.tokens, 1);
  assert.equal(h.connections.length, 2);
  assert.ok(h.connections.every((record) => record.profileDirName === "Profile 1"));
  await h.run("release");
});
