/**
 * TypeScript build script for bun-pty
 * 
 * This script handles both building the Rust library and TypeScript code.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

// Configuration
const RUST_DIR = "./rust-pty";
const OUTPUT_DIR = "./dist";

// Ensure output directory exists
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Build Rust library
console.log("Building Rust library...");
const rustBuild = spawnSync("cargo", ["build", "--release"], { 
  cwd: RUST_DIR,
  stdio: "inherit",
  shell: true
});

if (rustBuild.status !== 0) {
  console.error("Failed to build Rust library");
  process.exit(1);
}

console.log("Rust library built successfully!");

// Copy and rename the library file based on architecture
const platform = process.platform;
const arch = process.arch;

const sourceLib = platform === "darwin" 
  ? "librust_pty.dylib"
  : platform === "win32"
  ? "rust_pty.dll"
  : "librust_pty.so";

const targetLib = platform === "darwin"
  ? arch === "arm64"
    ? "librust_pty_arm64.dylib"
    : "librust_pty.dylib"
  : platform === "win32"
  ? "rust_pty.dll"
  : arch === "arm64"
  ? "librust_pty_arm64.so"
  : "librust_pty.so";

const sourcePath = join(RUST_DIR, "target", "release", sourceLib);
const targetPath = join(RUST_DIR, "target", "release", targetLib);

if (existsSync(sourcePath) && sourcePath !== targetPath) {
  try {
    copyFileSync(sourcePath, targetPath);
    console.log(`Copied ${sourceLib} to ${targetLib}`);
  } catch (error) {
    console.error(`Failed to copy library file: ${error}`);
  }
}

// Building TypeScript code is handled by the bun CLI (see package.json scripts)
