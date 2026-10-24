import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProfileStore, splitProfilePath, validateProfilePath } from "../src/store.ts";

function tmpStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-store-"));
	return { store: new ProfileStore(dir), dir };
}

test("store dir is 0700 and file is 0600 after add", () => {
	const { store, dir } = tmpStore();
	store.add({ name: "Work", userDataDir: "/tmp/ud", profileDirName: "Profile 1", token: "secret-token-123456" });
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.join(dir, "profiles.json")).mode & 0o777, 0o600);
});

test("add rejects duplicate names case-insensitively before writing", () => {
	const { store, dir } = tmpStore();
	store.add({ name: "Work", userDataDir: "/a", profileDirName: "P", token: "t" });
	assert.throws(() => store.add({ name: "work", userDataDir: "/b", profileDirName: "Q", token: "u" }), /already exists/);
	const records = JSON.parse(fs.readFileSync(path.join(dir, "profiles.json"), "utf8")).profiles;
	assert.equal(records.length, 1);
	assert.equal(records[0].userDataDir, "/a", "original untouched");
});

test("atomic write leaves no temp files behind", () => {
	const { store, dir } = tmpStore();
	store.add({ name: "A", userDataDir: "/a", profileDirName: "P", token: "t" });
	store.add({ name: "B", userDataDir: "/b", profileDirName: "Q", token: "u" });
	const files = fs.readdirSync(dir).filter((f) => f.includes(".tmp") || f.startsWith(".profiles"));
	assert.deepEqual(files, []);
});

test("list masks tokens; get returns raw for connecting", () => {
	const { store } = tmpStore();
	store.add({ name: "Work", userDataDir: "/a", profileDirName: "P", token: "supersecret-token-42" });
	const listed = store.list();
	assert.ok(!JSON.stringify(listed).includes("supersecret-token-42"));
	assert.match(listed[0].token, /\(\d+ chars\)/);
	assert.equal(store.get("WORK").token, "supersecret-token-42");
});

test("the official Copy button assignment works as-is, including previously saved copies", () => {
	const { store, dir } = tmpStore();
	try {
		const token = "fixture-connection-value";
		store.add({ name: "Work", userDataDir: "/a", profileDirName: "P", token: `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token}` });
		const file = path.join(dir, "profiles.json");
		const saved = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(saved.profiles[0].token, token, "new pairing persists only the connection value");
		saved.profiles[0].token = `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token}`;
		fs.writeFileSync(file, JSON.stringify(saved));
		assert.equal(store.get("work").token, token, "legacy copied assignments reconnect without asking for a new token");
		assert.ok(!JSON.stringify(store.list()).includes(token));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("invalid multi-line token paste is rejected without saving or echoing it", () => {
	const { store, dir } = tmpStore();
	try {
		assert.throws(() => store.add({ name: "Bad", userDataDir: "/a", profileDirName: "P", token: "value-with\na-second-line" }), /Paste the Playwright token/);
		assert.deepEqual(store.list(), []);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("remove deletes only the named record", () => {
	const { store } = tmpStore();
	store.add({ name: "A", userDataDir: "/a", profileDirName: "P", token: "t" });
	store.add({ name: "B", userDataDir: "/b", profileDirName: "Q", token: "u" });
	const removed = store.remove("a");
	assert.equal(removed.name, "A");
	assert.deepEqual(store.list().map((p) => p.name), ["B"]);
	assert.equal(store.remove("missing"), undefined);
});

test("splitProfilePath splits full profile paths", () => {
	const split = splitProfilePath("/Users/x/Library/Application Support/Google/Chrome/Profile 3");
	assert.deepEqual(split, { userDataDir: "/Users/x/Library/Application Support/Google/Chrome", profileDirName: "Profile 3" });
	assert.ok("error" in splitProfilePath("/Users/x/Chrome/Profile 3/"));
	assert.ok("error" in splitProfilePath("   "));
	const root = splitProfilePath("/");
	assert.ok("error" in root);
});

test("validateProfilePath checks marker existence only", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccp-prof-"));
	const prof = path.join(dir, "Profile 9");
	fs.mkdirSync(prof);
	assert.ok(validateProfilePath(dir, "Profile 9"), "missing Preferences marker reported");
	fs.writeFileSync(path.join(prof, "Preferences"), "");
	assert.equal(validateProfilePath(dir, "Profile 9"), null);
});
