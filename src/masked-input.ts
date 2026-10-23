/** Native Pi input handling (including paste/key protocols), rendered only as bullets. */
import { Input } from "@earendil-works/pi-tui";

export interface MaskedInputDeps {
  requestRender(): void;
}

export function maskedInput(
  deps: MaskedInputDeps,
  done: (value: string | null) => void,
  opts: { title: string; hint: string },
) {
  const input = new Input();
  let finished = false;
  const finish = (value: string | null) => {
    if (finished) return;
    finished = true;
    done(value);
  };
  input.onSubmit = (value) => finish(value.trim() || null);
  input.onEscape = () => finish(null);

  return {
    invalidate() {},
    render(width: number): string[] {
      const w = Math.max(20, Math.min(width - 4, 72));
      const masked = "•".repeat(Math.min(input.getValue().length, w - 6)) + "█";
      const lines = [
        opts.title,
        opts.hint,
        "",
        masked,
        "Enter=done  Esc=cancel",
      ];
      const pad = (line: string) => `│ ${line.slice(0, w - 4).padEnd(w - 4)} │`;
      return [
        `┌${"─".repeat(w - 2)}┐`,
        ...lines.map(pad),
        `└${"─".repeat(w - 2)}┘`,
      ];
    },
    handleInput(data: string): void {
      if (finished) return;
      input.handleInput(data);
      deps.requestRender();
    },
  };
}
