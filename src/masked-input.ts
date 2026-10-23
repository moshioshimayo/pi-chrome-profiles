/**
 * Masked single-line token input as a focused custom TUI component.
 * Enter=done(string), Escape=cancel(null). Value never renders — only bullets.
 * Key handling is byte-level (CR/ESC/DEL + printable ASCII) so this module has
 * no runtime dependency on pi-tui; it only implements the Component shape.
 */

export interface MaskedInputDeps {
  requestRender(): void;
}

export function maskedInput(
  deps: MaskedInputDeps,
  done: (value: string | null) => void,
  opts: { title: string; hint: string },
) {
  let value = "";
  let finished = false;
  const finish = (v: string | null) => {
    if (finished) return;
    finished = true;
    done(v);
  };
  return {
    render(width: number): string[] {
      const w = Math.max(20, Math.min(width - 4, 72));
      const masked = "•".repeat(Math.min(value.length, w - 6)) + "█";
      const lines = [
        opts.title,
        opts.hint,
        "",
        masked,
        "Enter=done  Esc=cancel",
      ];
      const pad = (l: string) => `│ ${l.slice(0, w - 4).padEnd(w - 4)} │`;
      return [
        `┌${"─".repeat(w - 2)}┐`,
        ...lines.map(pad),
        `└${"─".repeat(w - 2)}┘`,
      ];
    },
    handleInput(data: string): void {
      if (data === "\r" || data === "\n") {
        finish(value.trim() || null);
        return;
      }
      if (data === "\x1b") {
        finish(null);
        return;
      }
      if (data === "\x7f" || data === "\b") {
        value = value.slice(0, -1);
        deps.requestRender();
        return;
      }
      // printable ASCII only; ignore control/escape sequences and arrows
      if (
        data.length === 1 &&
        data.charCodeAt(0) >= 0x20 &&
        data.charCodeAt(0) <= 0x7e
      ) {
        value += data;
        deps.requestRender();
      }
    },
  };
}
