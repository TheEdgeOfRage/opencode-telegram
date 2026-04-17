import { createWriteStream, mkdirSync, type WriteStream } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_DIR = join(homedir(), ".local", "share", "pi-telegram", "log");

let stream: WriteStream;

function getStream(): WriteStream {
  if (!stream) {
    mkdirSync(LOG_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    stream = createWriteStream(join(LOG_DIR, `${timestamp}.log`), {
      flags: "a",
    });
  }
  return stream;
}

function write(level: string, msg: string): void {
  const ts = new Date().toISOString();
  getStream().write(`${ts} ${level} ${msg}\n`);
}

export function info(msg: string): void {
  write("INFO", msg);
}

export function error(msg: string, err?: unknown): void {
  const suffix =
    err !== undefined
      ? ` ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      : "";
  write("ERROR", msg + suffix);
}
