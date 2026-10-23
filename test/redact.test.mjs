import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRedactor, redactDeep } from "../src/redact.ts";

const TOKEN = "pwe_abcdef0123456789GHI+/xyz";

test("redactor masks raw token", () => {
	const r = makeRedactor(TOKEN);
	assert.ok(!r(`error at ${TOKEN} end`).includes(TOKEN));
	assert.ok(r(`error at ${TOKEN} end`).includes("«chrome-token-redacted»"));
});

test("redactor masks URL-encoded token in connect URLs", () => {
	const r = makeRedactor(TOKEN);
	const url = `chrome-extension://abc/connect.html?mcpRelayUrl=ws%3A%2F%2Flocalhost%3A5337%2F&token=${encodeURIComponent(TOKEN)}&protocolVersion=1`;
	const out = r(url);
	assert.ok(!out.includes(encodeURIComponent(TOKEN)), "encoded form masked");
	assert.ok(!out.includes(TOKEN), "raw form masked");
});

test("redactor masks JSON-escaped token", () => {
	const r = makeRedactor(TOKEN);
	const json = JSON.stringify({ token: TOKEN });
	assert.ok(!r(json).includes(TOKEN));
});

test("redactor leaves unrelated text intact and is identity without token", () => {
	const r0 = makeRedactor(undefined);
	assert.equal(r0("plain"), "plain");
	const r = makeRedactor(TOKEN);
	assert.equal(r("no secrets here"), "no secrets here");
});

test("redactDeep walks structures", () => {
	const r = makeRedactor(TOKEN);
	const out = redactDeep({ a: [TOKEN, { b: `x${TOKEN}` }], c: 5 }, r);
	assert.equal(JSON.stringify(out).includes(TOKEN), false);
});
