# pi-chrome-profiles

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that lets the agent drive **one named real Chrome profile at a time** through the official [Playwright MCP Chrome extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) relay. No fresh anonymous browsers, no profile guessing, no CDP server, no browser discovery daemon.

## How it works

- You pair a profile once: friendly name + full Profile Path + that profile's extension token (masked input, explicit consent). Stored at `~/.pi/agent/chrome-profiles/profiles.json` (dir `0700`, file `0600`, atomic writes, tokens masked in every listing).
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

`/chrome list` · `/chrome pair <name>` (TUI only: masked token + consent) · `/chrome forget <name>` (deletes token) · `/chrome release` (closes Pi's connection; Chrome stays open)

## Install (when John approves)

```sh
cd pi-chrome-profiles
npm ci --legacy-peer-deps
pi install "$(pwd)"   # registers the package; only do this when you want to install it
# In Pi: /reload, then /chrome pair Chrome A
```

Pairing needs the official Playwright Extension installed in **that** Chrome profile (Chrome Web Store). Open `chrome://version` in that profile and copy its full **Profile Path**. Run `/chrome pair Chrome A` in Pi, enter the path, then paste that profile's extension token (extension menu → "Set this environment variable…") into the masked input. Review the persistent-access consent. Pair other profiles as Chrome B/C. Then tell the agent to use Chrome A; it selects `chrome_use("Chrome A")` and routes actions through `chrome_browser`. Names with spaces work. These are enrolled profiles, not automatic live-browser discovery. The selected profile may be opened if closed; a rejected token never falls back to another browser.

## Development

```sh
npm test        # focused node --test checks (no network or real Chrome)
npm run verify  # tests + actual Pi RPC package discovery; no model call or existing-profile access
```

## Verification status

- Focused checks cover — spawn identity/argv/env allowlist, pin-before-connect/retain-on-failure/deny-other-until-release, serialization and stale-client invalidation, abort, handshake-before-connected, denied ops, redaction (raw/URL-encoded/JSON), store modes/atomicity/uniqueness, browser-route gate incl. generic MCP dispatch, masked input.
- Maintained Pi loader check uses the real RPC interface to discover `/chrome` through the package manifest in an isolated HOME, without invoking a model or connecting a browser. The earlier direct-file smoke also executed `chrome_profiles` through real Pi.
- **Real pairing through the official extension: UNVERIFIED.** Bounded disposable attempt (unpacked official CRX — manifest key preserves the official id — loaded into headless Chrome-for-Testing with a seeded token, driven via the real `ChromeMcpClient`): MCP initialize + `listTools` (25 tools) succeeded, but the extension never received the relay's connect page. Exact unmet prerequisite: **the relay delivers its `connect.html?...&token=…` URL by launching Chrome against the profile's process singleton; in disposable headless Chrome-for-Testing that handoff did not open a tab in the running instance, and the server logs no ws endpoint to open it manually.** In real headed use (vendor-supported flow) the relay's own Chrome launch opens the connect page in the user's running profile. Verifying end-to-end requires either a headed disposable Chrome (a visible window on John's screen) or John pairing one real profile interactively.
