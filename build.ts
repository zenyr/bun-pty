/**
 * TypeScript build script for bun-pty
 * 
 * This script handles both building the Rust library and TypeScript code.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

// Building TypeScript code is handled by the bun CLI (see package.json scripts) 