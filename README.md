# pi-chrome-profiles

Run **`/chrome connect`**, pick a recognizable Chrome profile, and follow the first-time setup. No filesystem paths in the normal flow; saved profiles reconnect with one choice.

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that drives **one named real Chrome profile at a time** through the official [Playwright Chrome extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm). No fresh anonymous browsers, guessed ports, extra CDP server or discovery daemon.

## How it works

- Pick a detected profile once; Pi opens its setup page and guides you through one masked token paste and explicit consent. No path/name typing in the normal flow. Stored at `~/.pi/agent/chrome-profiles/profiles.json` (dir `0700`, file `0600`, atomic writes, tokens masked in every listing).
- The agent pins exactly one profile per session with `chrome_use(name)`. The pin is taken **before** the connection attempt and **retained on failure**; a different profile is rejected until a human runs `/chrome release`.
- Connection = `@playwright/mcp` `0.0.83` (pinned) spawned as `node cli.js --extension --browser chrome --user-data-dir <dir> --profile-dir-name <name>` (`shell:false`, token via env `PLAYWRIGHT_MCP_EXTENSION_TOKEN`, never in argv). The child env is an explicit allowlist (`PATH HOME TMPDIR LANG` + token) — no ambient `DEBUG`/`PLAYWRIGHT_*`.
- "Connected" means the live browser answered a harmless `browser_tabs {action:"list"}` handshake — MCP initialize/listTools alone is not treated as a browser connection.
- While pinned, other browser automation routes (`agent_browser*`, native computer-use, `browser_*`, `mcp__*__browser_*`, and generic MCP dispatchers naming a `browser_*` tool) are blocked with a pointer to `chrome_browser`; unrelated tools are untouched.
- Token-bearing stderr, connection/operation errors and tool-result text are scrubbed of the raw token, its URL-encoded form (relay connect URLs), and its JSON-escaped form.
- Closing the transport (release/session end/`forget`) SIGTERMs **our own** server child only — Chrome and unrelated tabs are not killed. `browser_install*`/`browser_close`/`browser_launch*` are denied.

## Tools

| Tool                                | Purpose                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `chrome_profiles`                   | List paired profiles + pin/connection state (never tokens)                          |
| `chrome_use(name)`                  | Pin + connect one profile (reused while connected; same-name retry after failure)   |
| `chrome_browser(tool?, arguments?)` | Run one `@playwright/mcp` tool on the pinned profile; omit `tool` for the inventory |

## Commands

| Command                        | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `/chrome` or `/chrome connect` | Profile picker; guided setup once or one-choice reconnect |
| `/chrome connect Work`         | Connect a saved profile directly                          |
| `/chrome pair`                 | Alias for guided connection                               |
| `/chrome pair --manual [name]` | Advanced setup for custom Chrome locations                |
| `/chrome list`                 | Saved profiles and connection state                       |
| `/chrome forget <name>`        | Confirm removal of that pairing only                      |
| `/chrome release`              | Close Pi's connection; Chrome stays open                  |

## Install (when John approves)

```sh
cd pi-chrome-profiles
npm ci --legacy-peer-deps
pi install "$(pwd)"   # registers the package; only do this when you want to install it
# In Pi: /reload, then /chrome connect
```

## Connect in Pi

1. Run `/chrome connect` and choose **Work**, **Personal**, or another detected Chrome display name.
2. For first-time setup, approve persistent access. If needed, Pi opens the official extension installer in **that exact profile**; approve installation in Chrome yourself.
3. Pi opens that profile's Playwright token page. Click the **Copy** button and paste its whole value into Pi's **masked prompt**, then Enter. Pi accepts the copied `PLAYWRIGHT_MCP_EXTENSION_TOKEN=…` line as-is—you do not need to edit it. Never paste it into chat. Pi saves the pairing and immediately attempts to connect.
4. Later, choose the saved profile from `/chrome connect` or use `/chrome connect Work`. No repeated path, token or consent prompts.

To choose your own name while first pairing, run `/chrome connect Chrome A` and select its Chrome profile. The human picker can switch profiles; the agent cannot change its pin by itself.

Discovery projects only profile display names from Chrome's `Local State` metadata. It does not read Preferences contents, cookies or extension tokens. These are detected **on-disk profiles**, not a claim that all browsers are running. The selected profile may be opened if closed; a missing profile or rejected token never falls back to another browser.

The official extension still requires one token copy; there is no silent credential import. Custom locations remain available through **Advanced: enter a profile path** in the picker or `/chrome pair --manual Chrome A`.

## Development

```sh
npm test        # focused node --test checks (no network or real Chrome)
npm run verify  # tests + actual Pi RPC package discovery; no model or existing-profile access
npm run verify:ui  # native Pi terminal wizard, disposable HOME and fake browser transport; no actual Chrome
```

## Verification status

- Focused checks cover — spawn identity/argv/env allowlist, pin-before-connect/retain-on-failure/deny-other-until-release, serialization and stale-client invalidation, abort, handshake-before-connected, denied ops, redaction (raw/URL-encoded/JSON), store modes/atomicity/uniqueness, browser-route gate incl. generic MCP dispatch, masked input.
- Maintained Pi loader check uses the real RPC interface to discover `/chrome` through the package manifest in an isolated HOME, without invoking a model or connecting a browser. The earlier direct-file smoke also executed `chrome_profiles` through real Pi.
- **Real pairing through the official extension: UNVERIFIED.** Bounded disposable attempt (unpacked official CRX — manifest key preserves the official id — loaded into headless Chrome-for-Testing with a seeded token, driven via the real `ChromeMcpClient`): MCP initialize + `listTools` (25 tools) succeeded, but the extension never received the relay's connect page. Exact unmet prerequisite: **the relay delivers its `connect.html?...&token=…` URL by launching Chrome against the profile's process singleton; in disposable headless Chrome-for-Testing that handoff did not open a tab in the running instance, and the server logs no ws endpoint to open it manually.** In real headed use (vendor-supported flow) the relay's own Chrome launch opens the connect page in the user's running profile. Verifying end-to-end requires either a headed disposable Chrome (a visible window on John's screen) or John pairing one real profile interactively.
