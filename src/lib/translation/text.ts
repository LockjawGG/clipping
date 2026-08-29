import { spawn } from "node:child_process";

/**
 * Offline document translation (Argos Translate via scripts/translate.py).
 *
 * Whisper's own translate task only ever targets English, so any other target
 * language routes through here. Argos auto-pivots through English internally,
 * so any supported source reaches any supported target.
 */

export interface TextItem {
  id: string;
  text: string;
}

export interface TextTranslator {
  readonly name: string;
  /**
   * Translate every item's text from `from` to `to`, preserving ids and order.
   * `from === to` returns the input unchanged.
   */
  translate(items: TextItem[], from: string, to: string): Promise<TextItem[]>;
}

export interface ArgosOptions {
  /** Python interpreter (env.PYTHON_BIN). */
  python: string;
  /** Absolute path to scripts/translate.py. */
  scriptPath: string;
  signal?: AbortSignal;
}

export class ArgosTranslator implements TextTranslator {
  readonly name = "argos";
  private readonly opts: ArgosOptions;

  constructor(opts: ArgosOptions) {
    this.opts = opts;
  }

  async translate(items: TextItem[], from: string, to: string): Promise<TextItem[]> {
    if (items.length === 0 || from === to) return items;

    const stdin = items.map((i) => JSON.stringify({ id: i.id, text: i.text })).join("\n") + "\n";
    const out = await this.run(["--from", from, "--to", to], stdin);

    const byId = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as { id: string; text: string };
        byId.set(row.id, row.text);
      } catch {
        /* skip a malformed line rather than failing the whole batch */
      }
    }
    return items.map((i) => ({ id: i.id, text: byId.get(i.id) ?? i.text }));
  }

  private run(args: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.python, [this.opts.scriptPath, ...args], {
        signal: this.opts.signal,
        env: {
          ...process.env,
          // The CLI is cp1252 on Windows and dies on any non-Latin text without
          // this — same fix the whisper runner needs.
          PYTHONIOENCODING: "utf-8",
          PYTHONUNBUFFERED: "1",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr += c;
        if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
      });
      child.stdin.end(stdin);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) return resolve(stdout);
        const tail = stderr.split("\n").filter(Boolean).slice(-3).join("\n").trim();
        reject(new Error(`translate.py exited ${code}${tail ? `:\n${tail}` : ""}`));
      });
    });
  }
}
