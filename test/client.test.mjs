import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeMcpClient, buildSpawnSpec, HANDSHAKE_TOOL } from "../src/client.ts";

const TOKEN = "pwe_tok-ABCdef123456789+/==";

const userDataDir = mkdtempSync(join(tmpdir(), "chrome-client-"));
mkdirSync(join(userDataDir, "Profile 1"));
writeFileSync(join(userDataDir, "Profile 1", "Preferences"), "{}");
after(() => rmSync(userDataDir, { recursive: true, force: true }));
const rec = { id: "1", name: "Work", nameKey: "work", userDataDir, profileDirName: "Profile 1", token: TOKEN, pairedAt: "now" };

/** Fake MCP client recording the protocol call sequence. */
function fakeMcp({ listTools, callToolResult, callToolError, handshakeIsError } = {}) {
	const calls = [];
	const toolsList = [{ name: "browser_tabs", description: "Manage tabs" }, { name: "browser_navigate", description: "Navigate", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } }, { name: "browser_close", description: "Close" }];
	return {
		calls,
		async connect() {
			calls.push(["connect"]);
		},
		async listTools(_opts) {
			calls.push(["listTools"]);
			if (listTools === "fail") throw new Error("listTools boom");
			return { tools: toolsList };
		},
		async callTool(params, _schema, opts) {
			calls.push(["callTool", params.name, params.arguments, Boolean(opts?.signal)]);
			if (opts?.signal?.aborted) {
				const e = new Error("aborted");
				e.name = "AbortError";
				throw e;
			}
			if (callToolError) throw new Error(callToolError);
			if (params.name === HANDSHAKE_TOOL && handshakeIsError) return { content: [{ type: "text", text: "handshake refused" }], isError: true };
			return callToolResult ?? { content: [{ type: "text", text: `did ${params.name}` }], isError: false };
		},
	};
}

function fakeTransport() {
	return { closed: 0, async close() { this.closed++; } };
}

function makeClient(mcpOpts, transport) {
	const c = new ChromeMcpClient(rec);
	c.makeClient = () => mcpOpts;
	if (mcpOpts instanceof Error) throw mcpOpts;
	c.makeTransport = () => transport;
	return c;
}

test("buildSpawnSpec: exact argv, node + pinned cli, extension flags, no token in argv", async () => {
	const { serverCliPath } = await import("../src/client.ts");
	const spec = buildSpawnSpec(rec);
	assert.equal(spec.command, process.execPath);
	assert.deepEqual(spec.args, [serverCliPath(), "--extension", "--browser", "chrome", "--user-data-dir", userDataDir, "--profile-dir-name", "Profile 1"]);
	assert.ok(!JSON.stringify(spec.args).includes(TOKEN), "token never in argv");
});

test("a removed profile never launches an anonymous replacement browser", async () => {
  const client = new ChromeMcpClient({ ...rec, profileDirName: "Profile 999" });
  client.makeTransport = () => assert.fail("missing profile must be rejected before spawn");
  await assert.rejects(() => client.connect(), /profile is unavailable.*No browser was opened/);
});

test("buildSpawnSpec: env is allowlist + token only; ambient DEBUG/PLAYWRIGHT_* excluded", () => {
	const saved = { DEBUG: process.env.DEBUG, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, PLAYWRIGHT_MCP_EXTENSION_TOKEN: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN };
	process.env.DEBUG = "*";
	process.env.PLAYWRIGHT_BROWSERS_PATH = "/somewhere";
	process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = "ambient-should-not-leak";
	try {
		const spec = buildSpawnSpec(rec);
		const allowed = new Set(["PATH", "HOME", "TMPDIR", "LANG", "PLAYWRIGHT_MCP_EXTENSION_TOKEN"]);
		for (const k of Object.keys(spec.env)) assert.ok(allowed.has(k), `unexpected env key ${k}`);
		assert.equal(spec.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, TOKEN, "selected token wins");
		assert.equal(spec.env.DEBUG, undefined);
		assert.equal(spec.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
	} finally {
		for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
	}
});

test("connect forces handshake browser op before connected", async () => {
	const mcp = fakeMcp();
	const t = fakeTransport();
	const c = makeClient(mcp, t);
	const tools = await c.connect();
	assert.equal(c.connected, true);
	assert.deepEqual(mcp.calls.map((x) => x[0]), ["connect", "listTools", "callTool"]);
	assert.equal(mcp.calls[2][1], HANDSHAKE_TOOL, "handshake is the harmless browser op");
	assert.deepEqual(mcp.calls[2][2], { action: "list" });
	assert.equal(tools.length, 3);
	assert.deepEqual(tools[1].inputSchema.required, ["url"], "upstream argument schema remains available");
});

test("initialize/listTools alone is NOT connected: handshake failure rejects", async () => {
	const mcp = fakeMcp({ handshakeIsError: true });
	const t = fakeTransport();
	const c = makeClient(mcp, t);
	await assert.rejects(() => c.connect(), /handshake failed/);
	assert.equal(c.connected, false);
	assert.equal(t.closed, 1, "transport closed on failure");
});

test("connect failure closes transport and keeps error redacted", async () => {
	const mcp = fakeMcp({ listTools: "fail" });
	const t = fakeTransport();
	const c = makeClient(mcp, t);
	// poison listTools to include the token in the error
	mcp.listTools = async () => {
		throw new Error(`listTools boom with ${TOKEN}`);
	};
	await assert.rejects(() => c.connect(), (err) => {
		assert.ok(!err.message.includes(TOKEN), "token redacted from error");
		assert.ok(err.message.includes("«chrome-token-redacted»"));
		return true;
	});
	assert.equal(c.connected, false);
	assert.equal(t.closed, 1);
});

test("callTool forwards name+args, maps text/image, redacts results", async () => {
	const mcp = fakeMcp({
		callToolResult: {
			content: [
				{ type: "text", text: `navigated; url=chrome-extension://x/connect.html?token=${encodeURIComponent(TOKEN)}` },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			],
			isError: false,
		},
	});
	const t = fakeTransport();
	const c = makeClient(mcp, t);
	await c.connect();
	const res = await c.callTool("browser_navigate", { url: "https://example.com" });
	assert.equal(res.isError, false);
	assert.ok(!JSON.stringify(res.content).includes(TOKEN));
	assert.ok(!JSON.stringify(res.content).includes(encodeURIComponent(TOKEN)));
	assert.equal(res.content[1].type, "image");
	assert.deepEqual(mcp.calls[3], ["callTool", "browser_navigate", { url: "https://example.com" }, false]);
});

test("callTool denies browser install/close/launch operations", async () => {
	const mcp = fakeMcp();
	const t = fakeTransport();
	const c = makeClient(mcp, t);
	await c.connect();
	for (const name of ["browser_install", "browser_installDependencies", "browser_close", "browser_launchPersistent"]) {
		await assert.rejects(() => c.callTool(name, {}), /blocked/);
	}
	assert.equal(ChromeMcpClient.deniedTool("browser_navigate"), false);
});

test("callTool respects an aborted signal", async () => {
	const mcp = fakeMcp();
	const t = fakeTransport();
	const c = makeClient(mcp, t);
	await c.connect();
	const ctl = new AbortController();
	ctl.abort();
	await assert.rejects(() => c.callTool("browser_navigate", {}, ctl.signal), /aborted/);
});

test("later browser-operation failures redact raw and encoded pairing tokens", async () => {
	const mcp = fakeMcp();
	const c = makeClient(mcp, fakeTransport());
	await c.connect();
	mcp.callTool = async () => { throw new Error(`operation failed ${TOKEN} url?token=${encodeURIComponent(TOKEN)}`); };
	await assert.rejects(() => c.callTool("browser_navigate", {}), (error) => {
		assert.ok(!error.message.includes(TOKEN));
		assert.ok(!error.message.includes(encodeURIComponent(TOKEN)));
		assert.ok(error.message.includes("chrome-token-redacted"));
		return true;
	});
	await c.safeClose();
});

test("pre-aborted connection starts nothing; tool-discovery receives native SDK abort options", async () => {
	const mcp = fakeMcp();
	const c = makeClient(mcp, fakeTransport());
	const cancelled = new AbortController(); cancelled.abort();
	await assert.rejects(() => c.connect(cancelled.signal), /abort/i);
	assert.equal(mcp.calls.length, 0);
	const active = new AbortController();
	const original = mcp.listTools;
	mcp.listTools = (params, options) => {
		assert.equal(params, undefined);
		assert.equal(options.signal, active.signal);
		return original();
	};
	await c.connect(active.signal);
	await c.safeClose();
});

test("safeClose closes our transport only; idempotent", async () => {
	const mcp = fakeMcp();
	const t = fakeTransport();
	const c = makeClient(mcp, t);
	await c.connect();
	await c.safeClose();
	await c.safeClose();
	assert.equal(t.closed, 1);
	assert.equal(c.connected, false);
});
