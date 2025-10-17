// terminal.ts  —  JS/TS front-end for Bun runtime

import { dlopen, FFIType, ptr } from "bun:ffi";
import { Buffer } from "node:buffer";
import { EventEmitter } from "./interfaces";
import type { IPty, IPtyForkOptions, IExitEvent } from "./interfaces";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_FILE = "sh";
export const DEFAULT_NAME = "xterm";

// terminal.ts  – loader fragment only

const resolveLibPath = (): string => {
	const env = process.env.BUN_PTY_LIB;
	if (env && existsSync(env)) return env;

	const platform = process.platform;
	const arch = process.arch;

	// Try to load from platform-specific optional dependency package first
	const platformPackageName = `@zenyr/bun-pty-${platform}-${arch}`;
	try {
		// In Bun's ESM environment, we need to construct the path directly
		// The platform package should be in node_modules
		const base = Bun.fileURLToPath(import.meta.url);
		const projectRoot = base.replace(/\/(dist|src)\/.*$/, "");
		
		// Try multiple node_modules locations
		const nodeModulesPaths = [
			join(projectRoot, "node_modules", platformPackageName),
			join(process.cwd(), "node_modules", platformPackageName),
		];

		// Add parent directories for nested installations
		let currentDir = projectRoot;
		for (let i = 0; i < 5; i++) {
			const parentDir = join(currentDir, "..");
			nodeModulesPaths.push(join(parentDir, "node_modules", platformPackageName));
			currentDir = parentDir;
		}

		for (const pkgPath of nodeModulesPaths) {
			// Try to read the package's index.mjs to get the library path
			const indexMjs = join(pkgPath, "index.mjs");
			if (existsSync(indexMjs)) {
				// Read and parse the simple export statement
				// Expected format: export default join(__dirname, 'librust_pty_arm64.dylib');
				try {
					const content = readFileSync(indexMjs, "utf-8");
					// Match the filename in the export statement
					const match = content.match(/['"]([^'"]+\.(?:dylib|so|dll))['"]/);
					if (match) {
						const libPath = join(pkgPath, match[1]);
						if (existsSync(libPath)) return libPath;
					}
				} catch {
					// Failed to parse, try direct construction
				}

				// Fallback: construct expected library filename directly
				const getLibraryFilename = (): string => {
					if (platform === "darwin") {
						return arch === "arm64" ? "librust_pty_arm64.dylib" : "librust_pty.dylib";
					}
					if (platform === "win32") {
						return "rust_pty.dll";
					}
					// Linux
					return arch === "arm64" ? "librust_pty_arm64.so" : "librust_pty.so";
				};

				const libPath = join(pkgPath, getLibraryFilename());
				if (existsSync(libPath)) return libPath;
			}
		}
	} catch {
		// Platform package not found, fall back to bundled library
	}

	// Fallback: look for bundled library in development scenarios
	// In development, check the rust-pty build output directory
	const base = Bun.fileURLToPath(import.meta.url);
	const here = base.replace(/\/(dist|src)\/.*$/, ""); // up to bun-pty/

	// Build the library name based on platform/arch (same logic as platform packages)
	const getLibraryFilename = (): string => {
		if (platform === "darwin") {
			return arch === "arm64" ? "librust_pty_arm64.dylib" : "librust_pty.dylib";
		}
		if (platform === "win32") {
			return "rust_pty.dll";
		}
		// Linux
		return arch === "arm64" ? "librust_pty_arm64.so" : "librust_pty.so";
	};

	const filename = getLibraryFilename();
	const fallbackPaths = [
		join(here, "rust-pty", "target", "release", filename),  // development: project root
		join(process.cwd(), "rust-pty", "target", "release", filename),  // alt: cwd
	];

	for (const path of fallbackPaths) {
		if (existsSync(path)) return path;
	}

	throw new Error(
		`librust_pty shared library not found.\nPlatform: ${platform}-${arch}\nTried:\n  - Optional package: ${platformPackageName}\n  - BUN_PTY_LIB=${env ?? "<unset>"}\n  - ${fallbackPaths.join("\n  - ")}\n\nInstall the platform-specific package or set BUN_PTY_LIB environment variable.`
	);
};

const libPath = resolveLibPath();

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
let lib: any;

// try to load the lib, if it fails log the error
try {
	lib = dlopen(libPath, {
		bun_pty_spawn: {
			args: [FFIType.cstring, FFIType.cstring, FFIType.i32, FFIType.i32],
			returns: FFIType.i32,
		},
		bun_pty_write: {
			args: [FFIType.i32, FFIType.pointer, FFIType.i32],
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
		bun_pty_kill: { args: [FFIType.i32], returns: FFIType.i32 },
		bun_pty_get_pid: { args: [FFIType.i32], returns: FFIType.i32 },
		bun_pty_get_exit_code: { args: [FFIType.i32], returns: FFIType.i32 },
		bun_pty_close: { args: [FFIType.i32], returns: FFIType.void },
	});
} catch (error) {
	console.error("Failed to load lib", error);
}

export class Terminal implements IPty {
	private handle = -1;
	private _pid = -1;
	private _cols = DEFAULT_COLS;
	private _rows = DEFAULT_ROWS;
	private readonly _name = DEFAULT_NAME;

	private _readLoop = false;
	private _closing = false;

	private readonly _onData = new EventEmitter<string>();
	private readonly _onExit = new EventEmitter<IExitEvent>();

	constructor(
		file = DEFAULT_FILE,
		args: string[] = [],
		opts: IPtyForkOptions = { name: DEFAULT_NAME },
	) {
		this._cols = opts.cols ?? DEFAULT_COLS;
		this._rows = opts.rows ?? DEFAULT_ROWS;
		const cwd = opts.cwd ?? process.cwd();

		// Properly quote arguments that contain spaces or special characters
		const quoteArg = (arg: string): string => {
			// If argument contains spaces, quotes, or special shell characters, quote it
			if (/[\s'"$`\\!*?#&;|<>(){}[\]]/.test(arg)) {
				// Escape single quotes by replacing ' with '\''
				return `'${arg.replace(/'/g, "'\\''")}'`;
			}
			return arg;
		};

		const cmdline = [file, ...args.map(quoteArg)].join(" ");

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

	get pid() {
		return this._pid;
	}
	get cols() {
		return this._cols;
	}
	get rows() {
		return this._rows;
	}
	get process() {
		return "shell";
	}

	get onData() {
		return this._onData.event;
	}
	get onExit() {
		return this._onExit.event;
	}

	/* ------------- IO methods ------------- */

	write(data: string) {
		if (this._closing) return;
		const buf = Buffer.from(data, "utf8");
		lib.symbols.bun_pty_write(this.handle, ptr(buf), buf.length);
	}

	resize(cols: number, rows: number) {
		if (this._closing) return;
		this._cols = cols;
		this._rows = rows;
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
			} else if (n === -2) {
				// CHILD_EXITED
				const exitCode = lib.symbols.bun_pty_get_exit_code(this.handle);
				this._onExit.fire({ exitCode });
				break;
			} else if (n < 0) {
				// error
				break;
			} else {
				// 0 bytes: wait
				await new Promise((r) => setTimeout(r, 8));
			}
		}
	}
}
