/**
 * Secure credential store for paired Chrome profiles.
 *
 * Layout: one directory (0700) owned by this extension containing a single
 * profiles.json (0600) written atomically via rename from a 0600 temp file
 * in the same directory. Tokens never leave this file except into the MCP
 * child process environment.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ProfileRecord {
  id: string; // opaque stable id; duplicate display names can never overwrite another record
  name: string; // display name, case preserved
  nameKey: string; // name.toLowerCase(), uniqueness key
  userDataDir: string; // Chrome user data directory, e.g. ~/Library/Application Support/Google/Chrome
  profileDirName: string; // e.g. "Profile 1" or "Default"
  token: string; // Playwright extension token for this profile
  pairedAt: string; // ISO timestamp
}

interface StoreFile {
  version: 1;
  profiles: ProfileRecord[];
}

const EMPTY: StoreFile = { version: 1, profiles: [] };

export function defaultStoreDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "chrome-profiles");
}

/** Existence-only validation of a Chrome profile marker. Never reads contents. */
export function validateProfilePath(
  userDataDir: string,
  profileDirName: string,
): string | null {
  const marker = path.join(userDataDir, profileDirName, "Preferences");
  if (!fs.existsSync(marker))
    return `no Chrome profile marker at ${profileDirName} (missing ${path.join(profileDirName, "Preferences")})`;
  return null;
}

/**
 * Split a full Profile Path into { userDataDir, profileDirName }.
 * e.g. "/Users/x/Library/Application Support/Google/Chrome/Profile 3"
 * Rejects trailing separators and empty segments.
 */
export function splitProfilePath(
  fullPath: string,
): { userDataDir: string; profileDirName: string } | { error: string } {
  const norm = fullPath.trim();
  if (!norm || norm.endsWith("/"))
    return {
      error:
        "path must be the full profile directory path without trailing slash",
    };
  const userDataDir = path.dirname(norm);
  const profileDirName = path.basename(norm);
  if (
    !userDataDir ||
    !profileDirName ||
    profileDirName === "/" ||
    profileDirName === "."
  ) {
    return { error: "path must be the full profile directory path" };
  }
  return { userDataDir, profileDirName };
}

function connectionToken(value: string): string {
  // The official Copy button copies an environment assignment. Accept it as-is.
  const token = value
    .trim()
    .replace(/^(?:export\s+)?PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*/, "")
    .replace(/^(['"])(.*)\1$/, "$2");
  if (!token || token.length > 512 || /\s/.test(token))
    throw new Error(
      "Paste the Playwright token or its copied PLAYWRIGHT_MCP_EXTENSION_TOKEN=… line.",
    );
  return token;
}

export class ProfileStore {
  private file: string;

  constructor(dir: string = defaultStoreDir()) {
    this.dir = dir;
    this.file = path.join(dir, "profiles.json");
  }
  private dir: string;

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // tighten if it already existed with looser bits
    const st = fs.statSync(this.dir);
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(this.dir, 0o700);
  }

  load(): ProfileRecord[] {
    if (!fs.existsSync(this.file)) return [];
    const st = fs.statSync(this.file);
    if ((st.mode & 0o777) !== 0o600) fs.chmodSync(this.file, 0o600);
    const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoreFile;
    return data.profiles ?? [];
  }

  /** Atomic write: temp file (0600) in the same dir, then rename over. */
  private persist(records: ProfileRecord[]): void {
    this.ensureDir();
    const tmp = path.join(
      this.dir,
      `.profiles-${process.pid}-${Date.now()}.tmp`,
    );
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { version: 1, profiles: records } satisfies StoreFile,
        null,
        "\t",
      ) + "\n",
      { mode: 0o600 },
    );
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  list(): ProfileRecord[] {
    return this.load().map(
      ({ token, ...rest }) =>
        ({ ...rest, token: mask(token) }) as ProfileRecord,
    );
  }

  get(nameKey: string): ProfileRecord | undefined {
    const record = this.load().find((p) => p.nameKey === nameKey.toLowerCase());
    return record
      ? { ...record, token: connectionToken(record.token) }
      : undefined;
  }

  /** Throws on duplicate name (case-insensitive) before anything is written. */
  add(input: {
    name: string;
    userDataDir: string;
    profileDirName: string;
    token: string;
  }): ProfileRecord {
    const nameKey = input.name.trim().toLowerCase();
    if (!nameKey) throw new Error("profile name must not be empty");
    const records = this.load();
    if (records.some((p) => p.nameKey === nameKey)) {
      throw new Error(
        `a profile named "${input.name.trim()}" already exists; /chrome forget it first or pick another name`,
      );
    }
    const record: ProfileRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      nameKey,
      userDataDir: input.userDataDir,
      profileDirName: input.profileDirName,
      token: connectionToken(input.token),
      pairedAt: new Date().toISOString(),
    };
    this.persist([...records, record]);
    return { ...record, token: mask(record.token) };
  }

  remove(nameKey: string): ProfileRecord | undefined {
    const key = nameKey.toLowerCase();
    const records = this.load();
    const idx = records.findIndex((p) => p.nameKey === key);
    if (idx === -1) return undefined;
    const [removed] = records.splice(idx, 1);
    this.persist(records);
    return { ...removed, token: mask(removed.token) };
  }
}

const mask = (t: string) =>
  `${t.slice(0, 2)}…${t.slice(-2)} (${t.length} chars)`;
