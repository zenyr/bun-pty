#!/bin/bash
set -e  # Exit on error

echo "Building rust-pty library..."
cd rust-pty

# Check if cargo is installed
if ! command -v cargo &> /dev/null; then
    echo "Error: Rust and Cargo are required but not installed."
    echo "Please install from https://rustup.rs/"
    exit 1
fi

# Clean and build in release mode
echo "Running cargo clean..."
cargo clean

echo "Running cargo build in release mode..."
cargo build --release

echo "Build completed successfully!"
echo "Library location: $(pwd)/target/release/librust_pty.${DYLIB_EXT:-dylib}"

# Move back to original directory
cd ..

echo "You can now run the test with: BUN_PTY_DEBUG=1 bun test-pty.js" 