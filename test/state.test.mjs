import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionPin, blocksBrowserRoute } from "../src/state.ts";

const mk = (name, nameKey, token = "tok-xyz") => ({ id: "i", name, nameKey, userDataDir: "/U", profileDirName: "P", token, pairedAt: "t" });

/** Fake ChromeMcpClient used by SessionPin tests. */
class Fake {
	constructor(record, script = []) {
		this.record = record;
		this.script = [...script];
		this.connects = 0;
		this.closes = 0;
		this.calls = [];
		this.connected = false;
		this.tools = [{ name: "browser_tabs" }, { name: "browser_navigate" }];
		this._unhang = null;
	}
	async connect() {
		this.connects++;
		const step = this.script.shift();
		if (step === "fail") throw new Error(`connect failed (token ${this.record.token})`);
		this.connected = true;
		return this.tools;
	}
	async callTool(name, args, signal) {
		this.calls.push([name, args, Boolean(signal)]);
		const step = this.script.shift();
		if (step === "hang") await new Promise((r) => (this._unhang = r));
		if (signal?.aborted) {
			const e = new Error("aborted");
			e.name = "AbortError";
			throw e;
		}
		return { content: [{ type: "text", text: `did ${name}` }], isError: false };
	}
	async safeClose() {
		this.closes++;
		this.connected = false;
	}
}

const noPin = { pinnedKey: null };
const pinned = { pinnedKey: "work" };

test("use pins BEFORE connecting and hands the exact record to the client", async () => {
	const pin = new SessionPin();
	let seen = null;
	const { client } = await pin.use(mk("Work", "work", "tok-abc"), (r) => {
		seen = r;
		return new Fake(r);
	});
	assert.equal(seen.userDataDir, "/U");
	assert.equal(seen.profileDirName, "P");
	assert.equal(seen.token, "tok-abc");
	assert.equal(pin.pinnedKey, "work");
	assert.equal(client.connected, true);
});

test("failed connect retains the pin; a different profile is denied until human release", async () => {
	const pin = new SessionPin();
	const work = mk("Work", "work");
	await assert.rejects(() => pin.use(work, (r) => new Fake(r, ["fail"])), /connect failed/);
	assert.equal(pin.pinnedKey, "work", "pin retained on failure");
	assert.equal(pin.client, null);
	await assert.rejects(() => pin.use(mk("Other", "other"), (r) => new Fake(r)), /human must run \/chrome release/);
});

test("retry of the same pinned profile after failure connects", async () => {
	const pin = new SessionPin();
	await assert.rejects(() => pin.use(mk("Work", "work"), (r) => new Fake(r, ["fail"])));
	const { client } = await pin.use(mk("Work", "work"), (r) => new Fake(r));
	assert.equal(client.connected, true);
});

test("second use of the same profile reuses the same client", async () => {
	const pin = new SessionPin();
	const first = await pin.use(mk("Work", "work"), (r) => new Fake(r));
	const second = await pin.use(mk("Work", "work"), (r) => {
		throw new Error("factory must not be called on reuse");
	});
	assert.equal(second.reused, true);
	assert.equal(second.client, first.client);
});

test("browser requires a connected client; forwards tool+args", async () => {
	const pin = new SessionPin();
	await assert.rejects(() => pin.browser("browser_navigate", {}), /no Chrome profile pinned/);
	const { client } = await pin.use(mk("Work", "work"), (r) => new Fake(r));
	// simulate the pinned-but-failed state
	client.connected = false;
	pin.lastError = "handshake refused";
	await assert.rejects(() => pin.browser("browser_navigate", {}), /not connected|chrome_use/);
	client.connected = true;
	pin.lastError = null;
	const res = await pin.browser("browser_navigate", { url: "https://example.com" });
	assert.equal(res.isError, false);
	assert.deepEqual(client.calls, [["browser_navigate", { url: "https://example.com" }, false]]);
});

test("release serializes behind an in-flight call; stale client unusable after", async () => {
	const pin = new SessionPin();
	const { client } = await pin.use(mk("Work", "work"), (r) => new Fake(r));
	client.script = ["hang"];
	const order = [];
	const inflight = pin.browser("browser_navigate", {}).then((r) => {
		order.push("browser-done");
		return r;
	});
	const releasing = pin.release().then((n) => {
		order.push("release-done");
		return n;
	});
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(order, [], "in-flight call holds the queue; release waits");
	client._unhang();
	const res = await inflight;
	assert.equal(res.isError, false, "serialized call completes normally, not discarded");
	assert.equal(await releasing, "Work");
	assert.deepEqual(order, ["browser-done", "release-done"], "release ran strictly after");
	assert.equal(client.closes, 1, "owned client closed exactly once");
	await assert.rejects(() => pin.browser("browser_navigate", {}), /no Chrome profile pinned/, "stale completions can't reach the released client");
});

test("abort mid-call propagates AbortError", async () => {
	const pin = new SessionPin();
	const { client } = await pin.use(mk("Work", "work"), (r) => new Fake(r));
	const ctl = new AbortController();
	client.script = ["hang"];
	const inflight = pin.browser("browser_navigate", {}, ctl.signal);
	setTimeout(() => ctl.abort(), 10);
	setTimeout(() => client._unhang(), 30);
	await assert.rejects(() => inflight, /aborted/);
});

test("use is serialized: a queued release waits for the connecting use", async () => {
	const pin = new SessionPin();
	let gate = null;
	const factory = (r) => {
		const f = new Fake(r);
		const orig = f.connect.bind(f);
		f.connect = async () => {
			await new Promise((r2) => (gate = r2));
			return orig();
		};
		return f;
	};
	const using = pin.use(mk("Work", "work"), factory);
	const releasing = pin.release();
	await new Promise((r) => setTimeout(r, 20));
	gate?.();
	await using;
	assert.equal(await releasing, "Work", "release ran after use completed");
});

const BLOCKED = [
	"agent_browser",
	"agent_browser_navigate",
	"computer",
	"computer_use_click",
	"browser_navigate",
	"browser_snapshot",
	"mcp__playwright__browser_click",
	"mcp__chrome__browser_tabs",
];

test("gate blocks known browser routes while pinned (incl. generic MCP dispatchers)", () => {
	for (const name of BLOCKED) assert.equal(blocksBrowserRoute(pinned, name, {}), name);
	assert.equal(blocksBrowserRoute(pinned, "mcp", { tool: "browser_snapshot" }), "mcp");
	assert.equal(blocksBrowserRoute(pinned, "mcpScript", { input: { name: "browser_tabs", args: {} } }), "mcpScript");
	assert.equal(blocksBrowserRoute(pinned, "mcp_call", { tools: ["browser_click"] }), "mcp_call");
});

test("gate leaves unrelated tools and our own chrome_* surface alone", () => {
	for (const name of ["read", "bash", "edit", "write_file", "agent_browser", "browser_navigate", "mcp__playwright__browser_click"]) {
		assert.equal(blocksBrowserRoute(noPin, name, { tool: "browser_navigate" }), null, `unpinned never blocks (${name})`);
	}
	for (const [name, input] of [
		["read", {}],
		["bash", { command: "ls" }],
		["mcp", { tool: "github_create_issue" }],
		["mcp__github__create_issue", {}],
		["mcp", { tool: "search", query: "browser_navigate docs" }],
		["chrome_browser", { tool: "browser_navigate" }],
		["chrome_use", { name: "work" }],
	]) {
		assert.equal(blocksBrowserRoute(pinned, name, input), null, `${name} must pass`);
	}
});

test("release/shutdown are safe when nothing is pinned", async () => {
	const pin = new SessionPin();
	assert.equal(await pin.release(), null);
	await pin.shutdown();
});
