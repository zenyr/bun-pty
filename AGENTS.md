# @zenyr/bun-pty Agent Context

## Core
Bun PTY. Rust FFI. 5 platform packages (optionalDeps). `src/terminal.ts` = loader. `rust-pty/` = native lib.

## Critical: Library Resolution (v0.4.3+)
```ts
// ✅ Primary
await import("@zenyr/bun-pty-darwin-arm64") // .default = libPath
// Fallback: fs search, BUN_PTY_LIB env
```
Platform pkgs: `npm/*/index.mjs` exports `join(__dirname, 'lib*.{dylib,so,dll}')`

## Build
- TS: `bun build` + `tsc --emitDeclarationOnly`
- Rust: CI cross-compile 5 targets
- Publish: **GH release → auto npm** (`.github/workflows/publish.yml`)

## Version
Update ALL: `package.json` + `npm/*/package.json` (5 files). npm = immutable.

## Config
- `tsconfig.json`: ES2022, `moduleResolution: bundler` (top-level await)
- No `any`/`@ts-ignore`. Arrow fns. Strict.

## History
v0.4.2: fs-based (incomplete). v0.4.3: dynamic import (correct). Issue: `require.resolve()` breaks in Bun ESM.

## Release
1. Bump versions (all 6 files)
2. Update CHANGELOG
3. Commit/push
4. GH release (triggers npm publish)
