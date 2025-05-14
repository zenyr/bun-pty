import { dlopen, FFIType } from "bun:ffi";
import { Buffer } from "node:buffer";
import { EventEmitter } from "./interfaces";
import type { IExitEvent, IPty, IPtyForkOptions } from "./interfaces";

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_FILE = 'sh';
export const DEFAULT_NAME = 'xterm';

// Path to the compiled Rust shared library (adjust for platform)
const baseDir = Bun.fileURLToPath(new URL("..", import.meta.url));
const libPath =
	process.platform === "darwin"
		? `${baseDir}/rust-pty/target/release/librust_pty.dylib`
		: process.platform === "linux"
		? `${baseDir}/rust-pty/target/release/librust_pty.so`
		: `${baseDir}/rust-pty/target/release/rust_pty.dll`;

console.log("[DEBUG] Loading FFI library from:", libPath);
console.log("[DEBUG] Library exists:", Bun.file(libPath).exists);

const lib = dlopen(libPath, {
	bun_pty_spawn: {
		args: [FFIType.cstring, FFIType.cstring, FFIType.i32, FFIType.i32],
		returns: FFIType.i32,
	},
	bun_pty_write: {
		args: [FFIType.i32, FFIType.cstring],
		returns: FFIType.i32,
	},
	bun_pty_read: {
		args: [FFIType.i32, FFIType.pointer, FFIType.i32],
		returns: FFIType.i32,
	},
	bun_pty_resize: {
		args: [FFIType.i32, FFIType.i32, FFIType.i32],
		returns: FFIType.i32,
	},
	bun_pty_kill: {
		args: [FFIType.i32],
		returns: FFIType.i32,
	},
	bun_pty_get_pid: {
		args: [FFIType.i32],
		returns: FFIType.i32,
	},
	bun_pty_close: {
		args: [FFIType.i32],
		returns: FFIType.i32,
	},
});

console.log("[DEBUG] FFI library loaded:", Object.keys(lib.symbols));

/**
 * Implementation of the IPty interface using Bun FFI with a Rust backend.
 * Provides a cross-platform PTY interface for interacting with terminal processes.
 */
export class Terminal implements IPty {
	protected _pid = -1;
	protected _cols = DEFAULT_COLS;
	protected _rows = DEFAULT_ROWS;
	protected _file: string;
	protected _name = DEFAULT_NAME;
	protected _args: string[] = [];
	protected _cwd?: string;
	protected _env?: Record<string, string>;
	
	protected _exitCode: number | null = null;
	protected _exitSignal: string | null = null;
	protected _isClosing = false;
	protected _readLoopActive = false;

	// Event handlers
	protected readonly _onData = new EventEmitter<string>();
	protected readonly _onExit = new EventEmitter<IExitEvent>();
	
	// FFI handle for the PTY
	private handle: number;

	/**
	 * Creates a new terminal instance.
	 * 
	 * @param file - Command to run (defaults to 'sh')
	 * @param args - Arguments for the command
	 * @param options - Options for the terminal
	 */
	constructor(
		file: string,
		args: string[] = [],
		opt?: IPtyForkOptions
	) {
		this._file = file;
		this._args = args;
		
		if (opt) {
			this._name = opt.name || DEFAULT_NAME;
			this._cols = opt.cols || DEFAULT_COLS;
			this._rows = opt.rows || DEFAULT_ROWS;
			this._cwd = opt.cwd || process.cwd();
			// Safely handle env to avoid type errors
			this._env = opt.env ? {...opt.env} : {};
            this._env.TERM = this._name;
            this._env.PWD = this._cwd;
		}

		// Build command and spawn the process
		const fullCommand = [this._file, ...this._args].join(' ');
		const workingDir = this._cwd || process.cwd();

		console.log("[DEBUG] Spawning process:", fullCommand);
		console.log("[DEBUG] Working directory:", workingDir);
		console.log("[DEBUG] Columns:", this._cols);
		console.log("[DEBUG] Rows:", this._rows);

		// Spawn the process via FFI
		try {
			this.handle = lib.symbols.bun_pty_spawn(
				Buffer.from(`${fullCommand}\0`, "utf8"),
				Buffer.from(`${workingDir}\0`, "utf8"),
				this._cols,
				this._rows
			);
			
			console.log("[DEBUG] PTY spawn result handle:", this.handle);
		} catch (error) {
			console.error("[DEBUG] FFI call error:", error);
			throw new Error(`Failed to create PTY: ${error}`);
		}

		if (this.handle < 0) {
			throw new Error(`Failed to create PTY (handle=${this.handle})`);
		}

		// Get PID and start the read loop
		this._pid = lib.symbols.bun_pty_get_pid(this.handle);
		console.log("[DEBUG] Process ID:", this._pid);
		
		this._startReadLoop();
	}

	/**
	 * The process ID of the terminal process.
	 */
	public get pid(): number {
		return this._pid;
	}

	/**
	 * The column size of the terminal.
	 */
	public get cols(): number {
		return this._cols;
	}

	/**
	 * The row size of the terminal.
	 */
	public get rows(): number {
		return this._rows;
	}

	/**
	 * The current process running in the terminal.
	 */
	public get process(): string {
		return this._file;
	}

	/**
	 * Event fired when data is available from the terminal.
	 */
	public get onData() {
		return this._onData.event;
	}

	/**
	 * Event fired when the terminal exits.
	 */
	public get onExit() {
		return this._onExit.event;
	}

	/**
	 * Emits the exit event with the given exit code and signal.
	 */
	protected _emitExit(exitCode: number, signal?: string) {
		if (this._exitCode !== null) {
			// Already exited
			return;
		}

		this._exitCode = exitCode;
		this._exitSignal = signal || null;

		// Emit the exit event
		this._onExit.fire({
			exitCode,
			signal,
		});
	}

	/**
	 * Starts the read loop to receive data from the PTY.
	 */
	private async _startReadLoop() {
		if (this._readLoopActive) return;
		
		this._readLoopActive = true;
		console.log("[DEBUG] Starting read loop for handle:", this.handle);
		
		while (this._readLoopActive && !this._isClosing) {
			const buf = Buffer.alloc(4096);
			const n = lib.symbols.bun_pty_read(this.handle, buf, buf.length);
			
			if (n > 0) {
				const data = buf.toString("utf8", 0, n);
				console.log(`[DEBUG] Read ${n} bytes:`, data.slice(0, 50) + (data.length > 50 ? '...' : ''));
				this._onData.fire(data);
			} else if (n === -2) {
				// Process has exited
				console.log("[DEBUG] Process has exited (read returned -2)");
				this._readLoopActive = false;
				this._emitExit(0);
				break;
			} else if (n < 0) {
				// Error
				console.log("[DEBUG] Read error:", n);
				this._readLoopActive = false;
				this._emitExit(1);
				break;
			} else {
				// No data, wait a bit
				await new Promise((r) => setTimeout(r, 10));
			}
		}
	}

	/**
	 * Write data to the terminal.
	 */
	public write(data: string): void {
		if (this._isClosing) return;
		
		console.log("[DEBUG] Writing data:", data.slice(0, 50) + (data.length > 50 ? '...' : ''));
		const result = lib.symbols.bun_pty_write(this.handle, Buffer.from(data, "utf8"));
		console.log("[DEBUG] Write result:", result);
	}

	/**
	 * Resize the terminal.
	 */
	public resize(columns: number, rows: number): void {
		if (this._isClosing) return;

		this._cols = columns;
		this._rows = rows;
		
		console.log("[DEBUG] Resizing terminal to:", columns, "x", rows);
		const result = lib.symbols.bun_pty_resize(this.handle, columns, rows);
		console.log("[DEBUG] Resize result:", result);
	}

	/**
	 * Kill the terminal process.
	 */
	public kill(signal?: string): void {
		if (this._isClosing) return;
		
		this._isClosing = true;
		const sig = signal || 'SIGTERM';
		
		console.log("[DEBUG] Killing process with signal:", sig);
		const result = lib.symbols.bun_pty_kill(this.handle);
		console.log("[DEBUG] Kill result:", result);

		// Close and clean up PTY resources
		if (lib.symbols.bun_pty_close) {
			console.log("[DEBUG] Closing PTY handle:", this.handle);
			const closeResult = lib.symbols.bun_pty_close(this.handle);
			console.log("[DEBUG] Close result:", closeResult);
		}
		
		// Trigger exit event if not already emitted
		this._emitExit(0, sig);
	}
}
