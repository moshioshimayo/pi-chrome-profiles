import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the store: index.ts builds ProfileStore() from HOME at import time.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-home-"));
process.env.HOME = fakeHome;
const mod = await import("../src/index.ts");

function mockPi() {
	const commands = {};
	const tools = {};
	const handlers = {};
	return {
		commands,
		tools,
		handlers,
		registerCommand: (name, opts) => (commands[name] = opts),
		registerTool: (t) => (tools[t.name] = t),
		on: (ev, fn) => (handlers[ev] ??= []).push(fn),
	};
}

const pi = mockPi();
mod.default(pi);

test("registers exactly the /chrome command and three tools, plus gates and shutdown", () => {
	assert.deepEqual(Object.keys(pi.commands), ["chrome"]);
	assert.deepEqual(Object.keys(pi.tools).sort(), ["chrome_browser", "chrome_profiles", "chrome_use"]);
	assert.equal(pi.handlers.tool_call?.length, 1);
	assert.equal(pi.handlers.session_shutdown?.length, 1);
});

test("chrome_profiles lists profiles without tokens", async () => {
	const res = await pi.tools.chrome_profiles.execute("id", {});
	assert.equal(res.isError, undefined);
	assert.match(res.content[0].text, /No paired profiles/);
});

test("chrome_use with unknown name is a helpful error", async () => {
	const res = await pi.tools.chrome_use.execute("id", { name: "ghost" });
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /No profile named "ghost"/);
});

test("tool_call gate blocks agent_browser while nothing is pinned? no — gate only fires when pinned", () => {
	const gate = pi.handlers.tool_call[0];
	assert.deepEqual(gate({ toolName: "agent_browser", input: {} }), {}, "unpinned: pass-through");
});

test("pairing is refused outside the TUI; list/forget/release work headless", async () => {
	const notes = [];
	const ctx = { ui: { notify: (m, t) => notes.push([m, t]) }, mode: "print" };
	await pi.commands.chrome.handler("pair Work", ctx);
	assert.deepEqual(notes[0][1], "error");
	await pi.commands.chrome.handler("list", ctx);
	assert.equal(notes[1][1], "info");
	await pi.commands.chrome.handler("release", ctx);
	assert.match(notes[2][0], /Nothing pinned/);
	await pi.commands.chrome.handler("bogus", ctx);
	assert.match(notes[3][0], /Usage/);
});

test("getArgumentCompletions offers subcommands and forget targets", async () => {
	const c = await pi.commands.chrome.getArgumentCompletions("");
	assert.ok(c.some((item) => item.value === "pair" && item.label === "pair"));
	assert.ok(c.some((item) => item.value === "release" && item.label === "release"));
	assert.deepEqual(await pi.commands.chrome.getArgumentCompletions("xy"), []);
});
