// Exercise package discovery through the real Pi RPC interface, without a model call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "chrome-package-loader-"));
// Reproduce global install + a second checkout/worktree, without discovering this machine's real config.
const installed = join(home, "installed");
const checkout = join(home, "checkout");
for (const target of [installed, checkout]) {
  mkdirSync(target, { recursive: true });
  for (const relative of ["package.json", "index.ts", "src", ".pi/extensions"]) {
    const source = join(root, relative);
    if (existsSync(source)) cpSync(source, join(target, relative), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [installed] }));
const env = { ...process.env, HOME: home };
for (const key of Object.keys(env)) {
  if (/^HERDR_|^PI_(?:CODING_AGENT_DIR|SENTINEL|SESSION|WORK)/.test(key)) delete env[key];
}
// Normal discovery stays enabled: opening another checkout must not auto-load a second copy.
const child = spawn("pi", ["--mode", "rpc", "--no-skills", "--no-prompt-templates", "--no-themes"], {
  cwd: checkout, env, stdio: ["pipe", "pipe", "pipe"],
});
const lines = createInterface({ input: child.stdout });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
let timer;
try {
  await new Promise((resolveResult, reject) => {
    timer = setTimeout(() => reject(new Error(`Pi package discovery timed out. ${stderr}`)), 45000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Pi exited before package discovery (${code}): ${stderr}`)));
    lines.on("line", (line) => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response.id !== "chrome-package-smoke") return;
      try {
        assert.equal(response.success, true, JSON.stringify(response));
        const commands = response.data.commands.filter((entry) => entry.name === "chrome");
        assert.equal(commands.length, 1, "installed package must register exactly one /chrome inside a second checkout");
        resolveResult();
      } catch (error) { reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ type: "get_commands", id: "chrome-package-smoke" })}\n`);
  });
  console.log("loader-smoke: OK — global package plus second checkout loads exactly once; isolated HOME, normal discovery, no model or browser connection");
} finally {
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  const exited = new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(killTimer); done(); });
    child.kill("SIGTERM");
  });
  await exited;
  rmSync(home, { recursive: true, force: true });
}
