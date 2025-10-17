# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.4] - 2025-10-17

### Changed
- **BREAKING**: Restructured to use platform-specific optional dependencies (`@zenyr/bun-pty-{linux,darwin,win32}-{x64,arm64}`)
- Reduced installation size from ~3-4MB to ~600KB per platform

### Added
- ARM64 support for Linux and macOS
- `BUN_PTY_LIB` environment variable for custom library path
- Enhanced error messages with platform detection and search paths

### Fixed
- Native libraries now properly included in npm packages
- Improved cross-compilation support in CI/CD

## [0.3.3] - 2025-10-17

**Note:** First release of the [@zenyr/bun-pty](https://github.com/zenyr/bun-pty) fork. This version and onwards contain improvements over the upstream [bun-pty](https://github.com/sursaone/bun-pty) v0.3.2.

### Added
- Comprehensive vi integration tests for editor functionality
- Exit code verification tests for `false` and `cat` commands
- GitHub installation guide with `trustedDependencies` setup
- Postinstall script for GitHub-based installations
- Source files now included in package for building from GitHub

### Fixed
- **Exit code handling**: Child process exit codes are now properly captured (was returning 0 for all exits)
- **FFI bindings**: Corrected `bun_pty_write` FFI signature and removed unnecessary null terminators
- **Argument quoting**: Fixed bash argument handling - commands with spaces and special characters are now properly quoted

### Changed
- Improved library path resolution for node_modules installations
- Automatic architecture-specific library file copying (ARM64 support)
- Enhanced GitHub Actions workflow with security improvements (pinned action versions)

### Security
- Fixed workflow vulnerabilities by pinning all GitHub Actions to specific commit SHAs
- Updated to use latest action versions with security patches

### Upstream Contributions
- Submitted PR [#10](https://github.com/sursaone/bun-pty/pull/10): Fix exit code handling
- Submitted PR [#11](https://github.com/sursaone/bun-pty/pull/11): Fix bash argument handling and FFI bindings

## [0.3.2] - 2025-06-20 (Upstream)

**Note:** Last version from upstream [bun-pty](https://github.com/sursaone/bun-pty) by [@sursaone](https://github.com/sursaone).

### Changed
- Updated package version

### Fixed
- Removed erroneous console log ([#4](https://github.com/sursaone/bun-pty/pull/4))
- Updated examples to work with installed bun-pty ([#3](https://github.com/sursaone/bun-pty/pull/3))

## [0.2.1] - 2025-05-15

### Fixed
- Fixed encoding issues with binary data from Docker and other applications
- Updated Rust code to properly handle non-UTF8 terminal control sequences
- Improved error handling in PTY read/write operations

## [0.2.0] - 2025-05-14

### Added
- Improved TypeScript support with complete type definitions
- Added TypeScript usage examples
- Enhanced documentation with TypeScript usage instructions

### Changed
- Optimized package size by excluding unnecessary files
- Improved build process for more reliable type generation

## [0.1.0] - 2025-05-13

### Added
- Initial release
- Cross-platform PTY support for macOS, Linux, and Windows
- Basic API for terminal process management
- Core PTY functionality: spawn, read, write, resize, and kill
- Process ID retrieval support
- TypeScript type definitions
- Integration tests 