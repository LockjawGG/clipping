import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Would this command actually start?
 *
 * `existsSync` alone is the wrong question for a *command*. Every binary here
 * defaults to a bare name — `piper`, `whisper`, `ffmpeg` — because that is how
 * a package manager installs them, and a bare name only resolves against PATH.
 * Checking the string as a filesystem path meant the default configuration
 * could never pass its own availability check: Piper installed correctly, on
 * PATH, still reported "binary not found, set PIPER_BINARY".
 *
 * A value that looks like a path is checked as one, since that is what the user
 * meant by writing it that way. Anything else is looked up the way a shell
 * would, including Windows' PATHEXT so `piper` finds `piper.exe`.
 */
export function executableExists(command: string): boolean {
  if (!command) return false;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }

  // "" first, so a name that already carries its extension is tried as given.
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      if (existsSync(join(dir, command + ext))) return true;
    }
  }
  return false;
}
