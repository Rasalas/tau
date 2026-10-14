# Browser Connect adapter

This crate implements the pinned inner TLS/WebSocket connection. The browser
relay socket carries its encrypted records. See
[the assessment](../docs/research/browser-connect-tls-2026-09-30.md) and
[operator/client instructions](../docs/connect.md).

`pkg/` is committed so ordinary web builds need only Node. Rebuild it after
changing Rust source or Cargo dependencies; the web build rejects stale files.

Use Rust 1.98.1 with the browser target and [WASI SDK 27.0](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-27)
for its Clang and archiver. Download the SDK archive for your platform, verify its
SHA-256 against the release, and extract it. CI pins the archive digests in
[the workflow](../.github/workflows/browser-connect.yml). Set `WASI_SDK_PATH` to
the extracted directory. Install Rust tools into a task-specific `RUSTUP_HOME`
and `CARGO_HOME` when sharing a workstation:

```sh
export RUSTUP_HOME=/tmp/browser-connect-build/rustup
export CARGO_HOME=/tmp/browser-connect-build/cargo
mkdir -p "$RUSTUP_HOME" "$CARGO_HOME"
export PATH="$CARGO_HOME/bin:$PATH"
export WASI_SDK_PATH=/path/to/wasi-sdk-27.0-arm64-macos
export RUSTUP_TOOLCHAIN=1.98.1
rustup toolchain install 1.98.1 --profile minimal --target wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked --jobs 2
npm run build:browser-connect
```

The CLI version must match Cargo.lock. `TAU_CONNECT_WASM_BINDGEN` may point at a
separately installed official release; `TAU_CONNECT_CARGO` and
`TAU_CONNECT_RUSTC` can select private tools. `ring` compiles C code, so the
build always uses the SDK's Clang and `llvm-ar`. System Clang versions produce
different WASM bytes.

The build requires exactly Rust 1.98.1, WASI SDK 27.0 and the matching binding
CLI. It remaps checkout, registry and sysroot paths before compilation, including
panic locations retained in stripped WASM. License inputs are sorted before writing;
the manifest contains only versions and content hashes. No `wasm-opt` pass runs.
CI rebuilds on Ubuntu 24.04 and macOS and compares every generated file against
`pkg/` with `git diff --exit-code -- browser-connect/pkg`.

To check path independence locally, build in two separate checkouts with their
own target directories and different `CARGO_HOME` paths, then compare `pkg/`
with `diff -r`. Use the same pinned tools for both builds.

WASM entropy comes from ring/getrandom's browser WebCrypto integration.

Run the relevant checks from the repository root:

```sh
npm test -- src/web/connect vite/browser-connect.test.ts --maxWorkers=2
node --test connect-relay/service-check.mjs
```

`pkg/THIRD-PARTY-LICENSES.txt` retains the resolved upstream license texts,
including ring's vendored crypto notices. The web build ships it separately
as `THIRD-PARTY-BROWSER-CONNECT-LICENSES.txt`. The adapter is lazy and belongs
only to `dist-web`; it is not part of Electron or native-mobile bundles.
