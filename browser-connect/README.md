# Browser Connect adapter

This crate implements the pinned inner TLS/WebSocket connection. The browser
relay socket carries its encrypted records. See
[the assessment](../docs/research/browser-connect-tls-2026-09-30.md) and
[operator/client instructions](../docs/connect.md).

`pkg/` is committed so ordinary web builds need only Node. Rebuild it after
changing Rust source or Cargo dependencies; the web build rejects stale files.

Use Rust 1.98.1 with the browser target and, on macOS, LLVM tools. Install tools
into a task-specific `RUSTUP_HOME` and `CARGO_HOME` when sharing a workstation:

```sh
rustup target add wasm32-unknown-unknown
rustup component add llvm-tools rustfmt
cargo install wasm-bindgen-cli --version 0.2.129 --locked --jobs 1
npm run build:browser-connect
```

The CLI version must match Cargo.lock. `TAU_CONNECT_WASM_BINDGEN` may point at a
separately installed official release; `TAU_CONNECT_CARGO` and
`TAU_CONNECT_RUSTC` can select private tools. On macOS the build script uses
`llvm-ar` from the toolchain rather than Apple's incompatible archiver.
WASM entropy comes from ring/getrandom's browser WebCrypto integration.

Run the relevant checks from the repository root:

```sh
npx vitest run src/web/connect src/web/TokenGate.test.tsx src/main/host-web-server.test.ts --maxWorkers=1
node --test connect-relay/service-check.mjs
```

`pkg/THIRD-PARTY-LICENSES.txt` retains the resolved upstream license texts,
including ring's vendored crypto notices. The web build ships it separately
as `THIRD-PARTY-BROWSER-CONNECT-LICENSES.txt`. The adapter is lazy and belongs
only to `dist-web`; it is not part of Electron or native-mobile bundles.
