import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverChromeProfiles, setupLaunchSpec, EXTENSION_ID, SETUP_URLS } from "../src/profiles.ts";

const root = mkdtempSync(join(tmpdir(), "chrome-profile-discovery-"));
after(() => rmSync(root, { recursive: true, force: true }));
for (const dir of ["Default", "Profile 2", "Profile 3", "System Profile"]) {
  mkdirSync(join(root, dir));
  writeFileSync(join(root, dir, "Preferences"), "not JSON; discovery must not parse this");
}
mkdirSync(join(root, "Profile 2", "Extensions", EXTENSION_ID), { recursive: true });
writeFileSync(join(root, "Local State"), JSON.stringify({
  os_crypt: { encrypted_key: "fixture-only-private-field" },
  profile: { info_cache: {
    Default: { name: "Personal", user_name: "private-email@example.invalid" },
    "Profile 2": { name: "Work" },
    "Profile 3": { name: "Work" },
  } },
}));

test("projects recognizable names and installation state, not private Chrome metadata", () => {
  const profiles = discoverChromeProfiles(root);
  assert.deepEqual(profiles.map((p) => [p.name, p.profileDirName, p.extensionInstalled]), [
    ["Personal", "Default", false], ["Work", "Profile 2", true], ["Work", "Profile 3", false],
  ]);
  assert.ok(!JSON.stringify(profiles).includes("private-email"));
  assert.ok(!JSON.stringify(profiles).includes("private-field"));
});

test("setup opens the chosen exact profile and only the official setup URLs", () => {
  const selected = discoverChromeProfiles(root).find((p) => p.profileDirName === "Profile 2");
  const spec = setupLaunchSpec(selected, "token", "/fixture/chrome");
  assert.equal(spec.command, "/fixture/chrome");
  assert.deepEqual(spec.args, [`--user-data-dir=${root}`, "--profile-directory=Profile 2", SETUP_URLS.token]);
  const installer = setupLaunchSpec(selected, "install", "/fixture/chrome");
  assert.ok(installer.args.at(-1).startsWith("https://chromewebstore.google.com/"));
  assert.equal(installer.args[1], "--profile-directory=Profile 2");
  assert.throws(() => setupLaunchSpec({ ...selected, profileDirName: "Profile 999" }, "token", "/fixture/chrome"), /no longer available/);
});

test("missing or corrupt metadata retains an advanced fallback instead of guessing a profile", () => {
  assert.deepEqual(discoverChromeProfiles(join(root, "not-installed")), []);
  writeFileSync(join(root, "Local State"), "broken metadata");
  assert.deepEqual(discoverChromeProfiles(root).map((p) => p.name), ["Personal", "Profile 2", "Profile 3"]);
});
