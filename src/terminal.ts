// terminal.ts  —  JS/TS front-end (final fixed version)

import { dlopen, FFIType, ptr } from "bun:ffi";
import { Buffer } from "node:buffer";
import { EventEmitter } from "./interfaces";
import type { IPty, IPtyForkOptions, IExitEvent } from "./interfaces";
import { join } from "node:path";
import { existsSync } from "node:fs";

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_FILE = "sh";
export const DEFAULT_NAME = "xterm";

/* ---------- FFI bindings ---------- */

// Base directory is one level up from the current file
const base = Bun.fileURLToPath(new URL("..", import.meta.url));

// Check for architecture-specific libraries first, then fall back to generic ones
const findLibrary = (baseName: string, archNames: string[]): string => {
  const releaseDir = join(base, "rust-pty", "target", "release");
  
  // Check for architecture-specific files first
  for (const name of archNames) {
    const path = join(releaseDir, name);
    try {
      if (existsSync(path)) {
        return path;
      }
    } catch (e) {
      // Ignore errors and try next file
    }
  }
  
  // Fall back to generic name
  return join(releaseDir, baseName);
};

const libPath =
  process.platform === "darwin"
    ? findLibrary("librust_pty.dylib", ["librust_pty_arm64.dylib", "librust_pty_x86_64.dylib"])
    : process.platform === "linux"
    ? findLibrary("librust_pty.so", ["librust_pty_x86_64.so", "librust_pty_aarch64.so"])
    : findLibrary("rust_pty.dll", ["rust_pty.dll"]);

const lib = dlopen(libPath, {
  bun_pty_spawn:  { args: [FFIType.cstring, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bun_pty_write:  { args: [FFIType.i32, FFIType.pointer, FFIType.i32],               returns: FFIType.i32 }, // length-aware
  bun_pty_read:   { args: [FFIType.i32, FFIType.pointer, FFIType.i32],               returns: FFIType.i32 },
  bun_pty_resize: { args: [FFIType.i32, FFIType.i32, FFIType.i32],                   returns: FFIType.i32 },
  bun_pty_kill:   { args: [FFIType.i32],                                             returns: FFIType.i32 },
  bun_pty_get_pid:{ args: [FFIType.i32],                                             returns: FFIType.i32 },
  bun_pty_close:  { args: [FFIType.i32],                                             returns: FFIType.void },
});

/* ---------- Terminal class ---------- */

export class Terminal implements IPty {
  private handle = -1;
  private _pid   = -1;
  private _cols  = DEFAULT_COLS;
  private _rows  = DEFAULT_ROWS;
  private readonly _name = DEFAULT_NAME;

  private _readLoop = false;
  private _closing  = false;

  private readonly _onData = new EventEmitter<string>();
  private readonly _onExit = new EventEmitter<IExitEvent>();

  constructor(
    file = DEFAULT_FILE,
    args: string[] = [],
    opts: IPtyForkOptions = { name: DEFAULT_NAME },
  ) {
    this._cols = opts.cols ?? DEFAULT_COLS;
    this._rows = opts.rows ?? DEFAULT_ROWS;
    const cwd  = opts.cwd  ?? process.cwd();

    const cmdline = [file, ...args].join(" ");

    this.handle = lib.symbols.bun_pty_spawn(
      Buffer.from(`${cmdline}\0`, "utf8"),
      Buffer.from(`${cwd}\0`, "utf8"),
      this._cols,
      this._rows,
    );
    if (this.handle < 0) throw new Error("PTY spawn failed");

    this._pid = lib.symbols.bun_pty_get_pid(this.handle);
    this._startReadLoop();
  }

  /* ------------- accessors ------------- */

  get pid()  { return this._pid; }
  get cols() { return this._cols; }
  get rows() { return this._rows; }
  get process() { return "shell"; }

  get onData() { return this._onData.event; }
  get onExit() { return this._onExit.event; }

  /* ------------- IO methods ------------- */

  write(data: string) {
    if (this._closing) return;
    const buf = Buffer.from(data, "utf8");
    lib.symbols.bun_pty_write(this.handle, ptr(buf), buf.length);
  }

  resize(cols: number, rows: number) {
    if (this._closing) return;
    this._cols = cols; this._rows = rows;
    lib.symbols.bun_pty_resize(this.handle, cols, rows);
  }

  kill(signal = "SIGTERM") {
    if (this._closing) return;
    this._closing = true;
    lib.symbols.bun_pty_kill(this.handle);
    lib.symbols.bun_pty_close(this.handle);
    this._onExit.fire({ exitCode: 0, signal });
  }

  /* ------------- read-loop ------------- */

  private async _startReadLoop() {
    if (this._readLoop) return;
    this._readLoop = true;

    const buf = Buffer.allocUnsafe(4096);

    while (this._readLoop && !this._closing) {
      const n = lib.symbols.bun_pty_read(this.handle, ptr(buf), buf.length);
      if (n > 0) {
        this._onData.fire(buf.subarray(0, n).toString("utf8"));
      } else if (n === -2) {          // CHILD_EXITED
        this._onExit.fire({ exitCode: 0});
        break;
      } else if (n < 0) {             // error
        break;
      } else {                        // 0 bytes: wait
        await new Promise(r => setTimeout(r, 8));
      }
    }
  }
}