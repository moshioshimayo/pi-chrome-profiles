#!/usr/bin/env python3
"""Exercise the real Pi terminal wizard; all Chrome/profile/control data are disposable fixtures."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
TOKEN = "fixture-only-ui-token"
with tempfile.TemporaryDirectory(prefix="pi-chrome-wizard-ui-") as directory:
    home = Path(directory)
    profile = home / "Chrome" / "Profile 1"
    profile.mkdir(parents=True)
    (profile / "Preferences").write_text("{}")
    (home / "Chrome" / "Local State").write_text(json.dumps({"profile": {"info_cache": {"Profile 1": {"name": "Work"}}}}))
    receipt = home / "receipt.json"
    fixture = home / "wizard-fixture.ts"
    fixture.write_text(f'''import fs from "node:fs";
import chromeProfiles from {json.dumps(str(ROOT / "src/index.ts"))};
import {{ discoverChromeProfiles }} from {json.dumps(str(ROOT / "src/profiles.ts"))};
const result = {{ opened: [], connected: [] }};
const save = () => fs.writeFileSync({json.dumps(str(receipt))}, JSON.stringify(result));
export default function(pi) {{
  chromeProfiles(pi, {{
    discover: () => discoverChromeProfiles({json.dumps(str(home / "Chrome"))}).map(p => ({{...p, extensionInstalled: true}})),
    openSetup: async (profile, page) => {{ result.opened.push({{profile: profile.profileDirName, page}}); save(); }},
    createClient: (record) => ({{ connected: false, tools: [],
      async connect() {{ if (record.token !== {json.dumps(TOKEN)}) throw new Error("copied assignment was not normalized"); this.connected = true; result.connected.push(record.profileDirName); save(); }},
      async safeClose() {{ this.connected = false; }}
    }})
  }});
  pi.on("session_start", (_event, ctx) => ctx.ui.notify("WIZARD_UI_READY", "info"));
}}
''')
    env = {key: value for key, value in os.environ.items() if not re.match(r"^HERDR_|^PI_(CODING_AGENT_DIR|SENTINEL|SESSION|WORK)", key)}
    env.update(HOME=str(home), TERM="xterm-256color", NO_COLOR="1")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 120, 0, 0))
    process = subprocess.Popen(["pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--extension", str(fixture)], cwd=home, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()
    cursor = 0
    stage = "startup"

    def wait_for(text):
        global cursor
        deadline = time.monotonic() + 30
        expected = text.encode()
        while time.monotonic() < deadline:
            found = output.find(expected, cursor)
            if found >= 0:
                cursor = found + len(expected)
                return
            if process.poll() is not None:
                raise AssertionError(f"Pi exited during {stage}")
            readable, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
            if not readable:
                continue
            data = os.read(master, 65536)
            output.extend(data)
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b[?u" in data:
                os.write(master, b"\x1b[?0u")
        raise AssertionError(f"Timed out at {stage}: " + output[-1600:].decode(errors="replace").replace(TOKEN, "[redacted fixture]"))

    try:
        wait_for("WIZARD_UI_READY")
        stage = "named profile picker"
        os.write(master, b"/chrome connect\r")
        wait_for("Work")
        os.write(master, b"\r")
        stage = "explicit consent"
        wait_for("Let Pi automate")
        os.write(master, b"\r")
        stage = "masked one-time token input"
        wait_for("one-time setup")
        os.write(master, b"\x1b[200~PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + TOKEN.encode() + b"\x1b[201~\r")
        stage = "connection result"
        wait_for("Connected to Work")
        result = json.loads(receipt.read_text())
        assert result["opened"] == [{"profile": "Profile 1", "page": "token"}], result
        assert result["connected"] == ["Profile 1"], result
        assert TOKEN.encode() not in output, "token must never echo in terminal output"
        assert b"Full Chrome Profile Path" not in output, "normal flow must not ask for a filesystem path"
        print("PASS native Pi TUI: named profile picker -> consent -> masked paste -> connected fixture; no path/name typing, no model call, no actual Chrome/profile access. Browser authentication remains unverified.")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        os.close(master)
