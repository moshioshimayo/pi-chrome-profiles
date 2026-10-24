/** Chrome display-name discovery and user-initiated setup-page opening. No cookie/token reads. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { validateProfilePath } from "./store.ts";

export const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
export const SETUP_URLS = {
  install: `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`,
  token: `chrome-extension://${EXTENSION_ID}/status.html`,
};
export interface DetectedProfile {
  name: string;
  userDataDir: string;
  profileDirName: string;
  extensionInstalled: boolean;
}

export function chromeUserDataDir(): string {
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
    );
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "google-chrome",
  );
}

export function discoverChromeProfiles(
  root = chromeUserDataDir(),
): DetectedProfile[] {
  let directories: fs.Dirent[];
  try {
    directories = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  // Only profile display names are projected out; no emails, encrypted keys, preferences, cookies or tokens leave discovery.
  let names: Record<string, { name?: unknown }> = {};
  try {
    names =
      JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8"))
        .profile?.info_cache ?? {};
  } catch {
    /* folder names remain usable */
  }
  return directories
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^(Default|Profile \d+)$/.test(entry.name) &&
        !validateProfilePath(root, entry.name),
    )
    .map((entry) => {
      const displayName = names[entry.name]?.name;
      const name =
        typeof displayName === "string"
          ? displayName
              .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
              .trim()
              .slice(0, 80)
          : "";
      return {
        name: name || (entry.name === "Default" ? "Personal" : entry.name),
        userDataDir: root,
        profileDirName: entry.name,
        extensionInstalled: fs.existsSync(
          path.join(root, entry.name, "Extensions", EXTENSION_ID),
        ),
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.profileDirName.localeCompare(b.profileDirName),
    );
}

function chromeExecutable(): string {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(
            os.homedir(),
            "Applications",
            "Google Chrome.app",
            "Contents",
            "MacOS",
            "Google Chrome",
          ),
        ]
      : process.platform === "win32"
        ? [
            process.env.PROGRAMFILES,
            process.env["PROGRAMFILES(X86)"],
            process.env.LOCALAPPDATA,
          ]
            .filter(Boolean)
            .map((root) =>
              path.join(root!, "Google", "Chrome", "Application", "chrome.exe"),
            )
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/chrome",
          ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable)
    throw new Error(
      "Google Chrome was not found. Install Chrome, or use /chrome pair --manual as the advanced fallback.",
    );
  return executable;
}

export function setupLaunchSpec(
  profile: Pick<DetectedProfile, "userDataDir" | "profileDirName">,
  page: keyof typeof SETUP_URLS,
  executable = chromeExecutable(),
) {
  const invalid = validateProfilePath(
    profile.userDataDir,
    profile.profileDirName,
  );
  if (invalid)
    throw new Error(`That Chrome profile is no longer available: ${invalid}`);
  return {
    command: executable,
    args: [
      `--user-data-dir=${profile.userDataDir}`,
      `--profile-directory=${profile.profileDirName}`,
      SETUP_URLS[page],
    ],
  };
}

/** Called only after a human chooses a profile and approves guided setup. No agent-side auto opening. */
export async function openChromeSetup(
  profile: DetectedProfile,
  page: keyof typeof SETUP_URLS,
): Promise<void> {
  const spec = setupLaunchSpec(profile, page);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      shell: false,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.once("error", () =>
      reject(
        new Error(
          "Could not open Chrome's setup page. Nothing was paired; try /chrome connect again.",
        ),
      ),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
