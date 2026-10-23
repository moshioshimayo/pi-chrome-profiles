import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chromeProfiles from "../src/index.ts";

const home = mkdtempSync(join(tmpdir(), "chrome-pairing-command-"));
const oldHome = process.env.HOME;
process.env.HOME = home;
after(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

test("native pairing callback accepts pasted token and multiword names; completions and forget use Pi's command contract", async () => {
  const profile = join(home, "Chrome", "Profile 1");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(home, "Chrome", "Local State"), "{}");
  writeFileSync(join(profile, "Preferences"), "{}");
  const commands = new Map();
  const tools = new Map();
  chromeProfiles({ registerCommand: (name, command) => commands.set(name, command), registerTool: (tool) => tools.set(tool.name, tool), on() {} });
  const command = commands.get("chrome");
  const token = "test-only-pasted-profile-token";
  let consent = true;
  let finished = false;
  const messages = [];
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      input: async () => profile,
      notify: (message) => messages.push(message),
      confirm: async () => consent,
      custom: async (factory) => new Promise((resolve) => {
        const component = factory({ requestRender() {} }, {}, {}, (value) => { finished = true; resolve(value); });
        component.handleInput(`\x1b[200~${token}\x1b[201~`);
        assert.ok(!component.render(80).join("\n").includes(token), "paste never appears on screen");
        component.invalidate();
        component.handleInput("\r");
      }),
    },
  };
  await command.handler("pair Chrome A", ctx);
  assert.equal(finished, true);
  assert.ok(messages.some((message) => message.includes('Paired "Chrome A"')), messages.join("\n"));
  const listed = await tools.get("chrome_profiles").execute();
  assert.ok(listed.content[0].text.includes("Chrome A"));
  assert.ok(!listed.content[0].text.includes(token));
  const completions = await command.getArgumentCompletions("forget Chrome");
  assert.deepEqual(completions, [{ value: "forget Chrome A", label: "forget Chrome A" }]);
  consent = false;
  await command.handler("forget Chrome A", ctx);
  assert.ok((await tools.get("chrome_profiles").execute()).content[0].text.includes("Chrome A"), "declined forget retains pairing");
  consent = true;
  await command.handler("forget Chrome A", ctx);
  assert.ok((await tools.get("chrome_profiles").execute()).content[0].text.includes("No paired profiles"));
  assert.ok(existsSync(join(profile, "Preferences")), "forget does not delete Chrome data");
  assert.ok(!messages.join("\n").includes(token));
});
