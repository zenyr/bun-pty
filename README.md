# @zenyr/bun-pty

[![NPM Version](https://img.shields.io/npm/v/@zenyr/bun-pty.svg)](https://www.npmjs.com/package/@zenyr/bun-pty)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun Compatible](https://img.shields.io/badge/Bun-%E2%89%A51.0.0-black)](https://bun.sh)

A cross-platform pseudo-terminal (PTY) implementation for Bun, powered by Rust's portable-pty library and Bun's FFI capabilities.

> **Note:** This is a fork of [bun-pty](https://github.com/sursaone/bun-pty) (v0.3.2) with significant improvements and architectural changes.

## 🔀 Fork Improvements (v0.3.3+)

This fork adds the following improvements over the original bun-pty:

### Performance & Distribution
- **Platform-specific packages**: Split native libraries into optional dependencies (~600KB vs ~3-4MB)
- **ARM64 support**: Added native support for ARM64 on both Linux and macOS

### Bug Fixes
- **Exit code handling**: Fixed issue where child process exit codes were not properly captured
- **FFI bindings**: Corrected `bun_pty_write` FFI bindings and removed unnecessary null terminators
- **Argument quoting**: Fixed bash argument handling for commands with spaces and special characters

### Developer Experience
- **Enhanced error messages**: Better library resolution errors with platform detection
- **Custom library path**: Support for `BUN_PTY_LIB` environment variable
- **Comprehensive tests**: Added exit code verification and vi integration tests
- **Security**: Pinned GitHub Actions versions and fixed workflow vulnerabilities

### CI/CD & Publishing
- **Cross-platform builds**: Automated builds for all platforms (Linux/macOS/Windows, x64/ARM64)
- **Multi-package publishing**: Automated publishing of platform-specific packages to npm

### 🔄 Upstream Contributions

The following improvements have been submitted as pull requests to the upstream repository:

- [#10 - Fix: Report actual process exit code instead of hardcoded 0](https://github.com/sursaone/bun-pty/pull/10) - Fixes exit code handling bug
- [#11 - Fix bash -c argument handling and FFI bindings](https://github.com/sursaone/bun-pty/pull/11) - Fixes argument quoting and FFI binding issues

These fixes are already included in this fork (v0.3.3+) and are pending review in the upstream repository.

## 🚀 Features

- **Cross-platform** - Works on macOS, Linux, and Windows
- **Simple API** - Clean Promise-based API similar to node-pty
- **Type-safe** - Complete TypeScript definitions included
- **Efficient** - Rust backend with proper error handling and multithreading
- **Zero dependencies** - No external JavaScript dependencies required
- **Modern** - Built specifically for Bun using its FFI capabilities

## 📦 Installation

### From npm (recommended)

```bash
bun add @zenyr/bun-pty
```

The package automatically installs the correct native library for your platform. Platform-specific packages are installed as optional dependencies:

- `@zenyr/bun-pty-linux-x64` - Linux x86_64
- `@zenyr/bun-pty-linux-arm64` - Linux ARM64
- `@zenyr/bun-pty-darwin-x64` - macOS x86_64 (Intel)
- `@zenyr/bun-pty-darwin-arm64` - macOS ARM64 (Apple Silicon)
- `@zenyr/bun-pty-win32-x64` - Windows x86_64

> **Note:** Only the platform-specific package matching your system will be downloaded, keeping installation size minimal (~600KB instead of ~3-4MB).

### From GitHub (for development or specific branches)

Installing from GitHub requires building from source (Rust toolchain needed):

```bash
bun add github:zenyr/bun-pty --trust
```

**Important:** GitHub installations include source code and require the Rust toolchain (cargo) to build. Bun requires explicit permission to run build scripts. Use the `--trust` flag or add to `trustedDependencies`:

```json
{
  "dependencies": {
    "@zenyr/bun-pty": "github:zenyr/bun-pty"
  },
  "trustedDependencies": [
    "@zenyr/bun-pty"
  ]
}
```

> **Tip:** For production use, prefer the npm package which includes prebuilt binaries and doesn't require Rust.

## ⚙️ Requirements

- **Bun** 1.0.0 or higher
- **Rust toolchain** (cargo) is required only when installing from GitHub or building from source
- **TypeScript** (included as devDependency)

## 📋 Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS    | ✅     | Fully supported |
| Linux    | ✅     | Fully supported |
| Windows  | ✅     | Fully supported |

## 🚦 Usage

### Basic Example

```typescript
import { spawn } from "@zenyr/bun-pty";

// Create a new terminal
const terminal = spawn("bash", [], {
  name: "xterm-256color",
  cols: 80,
  rows: 24
});

// Handle data from the terminal
terminal.onData((data) => {
  console.log("Received:", data);
});

// Handle terminal exit
terminal.onExit(({ exitCode, signal }) => {
  console.log(`Process exited with code ${exitCode} and signal ${signal}`);
});

// Write to the terminal
terminal.write("echo Hello from Bun PTY\n");

// Resize the terminal
terminal.resize(100, 40);

// Kill the process when done
setTimeout(() => {
  terminal.kill();
}, 5000);
```

### TypeScript Usage

The library includes complete TypeScript definitions. Here's how to use it with full type safety:

```typescript
import { spawn } from "@zenyr/bun-pty";
import type { IPty, IExitEvent, IPtyForkOptions } from "@zenyr/bun-pty";

// Create typed options
const options: IPtyForkOptions = {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: process.cwd()
};

// Create a terminal with proper typing
const terminal: IPty = spawn("bash", [], options);

// Typed event handlers
const dataHandler = terminal.onData((data: string) => {
  process.stdout.write(data);
});

const exitHandler = terminal.onExit((event: IExitEvent) => {
  console.log(`Process exited with code: ${event.exitCode}`);
});

// Clean up when done
dataHandler.dispose();
exitHandler.dispose();
```

### Interactive Shell Example

```typescript
import { spawn } from "@zenyr/bun-pty";
import { createInterface } from "node:readline";

// Create a PTY running bash
const pty = spawn("bash", [], {
  name: "xterm-256color",
  cwd: process.cwd()
});

// Forward PTY output to stdout
pty.onData((data) => {
  process.stdout.write(data);
});

// Send user input to the PTY
process.stdin.on("data", (data) => {
  pty.write(data.toString());
});

// Handle PTY exit
pty.onExit(() => {
  console.log("Terminal session ended");
  process.exit(0);
});

// Handle SIGINT (Ctrl+C)
process.on("SIGINT", () => {
  pty.kill();
});
```

## 📖 API Reference

### `spawn(file: string, args: string[], options: IPtyForkOptions): IPty`

Creates and spawns a new pseudoterminal.

- `file`: The executable to launch
- `args`: Arguments to pass to the executable
- `options`: Configuration options
  - `name`: Terminal name (e.g., "xterm-256color")
  - `cols`: Number of columns (default: 80)
  - `rows`: Number of rows (default: 24)
  - `cwd`: Working directory (default: process.cwd())
  - `env`: Environment variables

Returns an `IPty` instance.

### `IPty` Interface

```typescript
interface IPty {
  // Properties
  readonly pid: number;        // Process ID
  readonly cols: number;       // Current columns
  readonly rows: number;       // Current rows
  readonly process: string;    // Process name
  
  // Events
  onData: (listener: (data: string) => void) => IDisposable;
  onExit: (listener: (event: IExitEvent) => void) => IDisposable;
  
  // Methods
  write(data: string): void;   // Write data to terminal
  resize(cols: number, rows: number): void;  // Resize terminal
  kill(signal?: string): void;  // Kill the process
}
```

### Event Types

```typescript
interface IExitEvent {
  exitCode: number;
  signal?: number | string;
}

interface IDisposable {
  dispose(): void;
}
```

## 🔧 Building from Source

If you want to build the package from source:

```bash
# Clone the repository
git clone https://github.com/zenyr/bun-pty.git
cd bun-pty

# Install dependencies
bun install

# Build Rust library and TypeScript
bun run build

# Run tests
bun test
```

## ❓ Troubleshooting

### Prebuilt Binaries

The npm package uses platform-specific optional dependencies to provide prebuilt binaries. Each platform package contains only the native library for that specific OS and architecture.

If you encounter issues with the prebuilt binaries:

1. **Check if the platform package was installed:**
   ```bash
   ls node_modules/@zenyr/bun-pty-*/
   ```

2. **Force reinstall the platform package:**
   ```bash
   bun add @zenyr/bun-pty --force
   ```

3. **Build from source (development only):**
   ```bash
   cd node_modules/@zenyr/bun-pty
   bun run build
   ```

### Custom Library Path

You can specify a custom path to the native library using the `BUN_PTY_LIB` environment variable:

```bash
export BUN_PTY_LIB=/path/to/librust_pty.dylib
bun run your-script.ts
```

### Common Issues

- **Error: librust_pty shared library not found**
  - Make sure the appropriate platform package is installed
  - Check that your OS and architecture match one of the supported platforms
  - Try reinstalling with `bun add @zenyr/bun-pty --force`

- **Error: Unable to load shared library**
  - Ensure you have the necessary system libraries installed
  - On Linux, you may need `libc6` and related dependencies

- **Process spawn fails**
  - Check if you have the required permissions and paths
  - Verify the executable exists and is in your PATH

## 📄 License

This project is licensed under the [MIT License](LICENSE).

## 🙏 Credits

- Forked from [bun-pty](https://github.com/sursaone/bun-pty) by [@sursaone](https://github.com/sursaone)
- Built specifically for [Bun](https://bun.sh/)
- Uses [portable-pty](https://github.com/wez/wezterm/tree/main/pty) from WezTerm for cross-platform PTY support
- Inspired by [node-pty](https://github.com/microsoft/node-pty) for the API design
