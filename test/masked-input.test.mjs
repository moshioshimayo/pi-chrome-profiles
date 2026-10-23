import assert from "node:assert/strict";
import { test } from "node:test";
import { maskedInput } from "../src/masked-input.ts";

function harness() {
	let done = null;
	const renders = [];
	const comp = maskedInput({ requestRender: () => renders.push(comp.render(60)) }, (v) => (done = v), {
		title: "Token",
		hint: "paste",
	});
	return { comp, getDone: () => done, renders };
}

test("masked input returns trimmed value on Enter and never renders it", () => {
	const { comp, getDone, renders } = harness();
	for (const ch of "secret-token-9") comp.handleInput(ch);
	comp.handleInput("\r");
	assert.equal(getDone(), "secret-token-9");
	for (const frame of renders) {
		assert.ok(!frame.join("").includes("secret-token-9"), "typed value never rendered");
		assert.ok(frame.join("").includes("•"));
	}
});

test("escape cancels with null; backspace edits; control sequences ignored", () => {
	const { comp, getDone } = harness();
	comp.handleInput("ab");
	comp.handleInput("\x7f");
	comp.handleInput("c");
	comp.handleInput("\x1b[A"); // arrow up — multi-char, ignored
	comp.handleInput("\t"); // tab ignored
	comp.handleInput("\x1b"); // standalone esc cancels
	assert.equal(getDone(), null);
});

test("empty input on Enter yields null, not empty string", () => {
	const { comp, getDone } = harness();
	comp.handleInput("\r");
	assert.equal(getDone(), null);
});
