# Building the Rust core

The Rust code is in `rust/`. It compiles to a single `.wasm` file plus a JS loader that goes into `wasm/`. The JS app loads it automatically when present and falls back to pure JS if it isn't.

**You only need to do this once** (and again whenever there's a Rust change).

---

## One-time setup (~10 minutes)

You're on Windows 11. Run these in PowerShell **as your normal user**, not Administrator.

### 1. Install Rust via rustup

```powershell
winget install Rustlang.Rustup
```

If `winget` isn't available, download the installer from https://rustup.rs and run `rustup-init.exe`. Accept all defaults (default host triple, default toolchain).

After install, **close and reopen PowerShell** so the `PATH` picks up Rust.

Verify:

```powershell
rustc --version
cargo --version
```

You should see something like `rustc 1.82.0` and `cargo 1.82.0`. Anything ≥ 1.77 works.

### 2. Add the wasm32 target

```powershell
rustup target add wasm32-unknown-unknown
```

### 3. Install wasm-pack

```powershell
cargo install wasm-pack
```

This compiles wasm-pack from source. Takes 2-4 minutes. Grab a coffee.

Verify:

```powershell
wasm-pack --version
```

---

## Build the WASM (every time the Rust changes)

```powershell
cd "C:\Users\ravic\Downloads\files (1)\signal-player\rust"
wasm-pack build --target web --release --out-dir ..\wasm
```

That produces three files in `signal-player\wasm\`:

```
wasm/
├── signal_core.js          # JS glue, ~10 KB
├── signal_core_bg.wasm     # The actual WASM, ~150-200 KB
└── signal_core.d.ts        # TypeScript types (not used, fine to leave)
```

That's it. The JS app picks the WASM up on next load.

### Confirming it worked

1. Reload https://rocko5498.github.io/signal-player/ (or your local server)
2. Open DevTools → Console
3. You should see: `[signal_core] signal_core v0.1.0 (signal_core)` followed by `[signal] Rust core active`

If you see `[signal] Rust core unavailable, JS-only mode`, the WASM didn't load. Check the Network tab for a 404 on `signal_core_bg.wasm` — most likely it didn't get copied to the deployed site.

---

## Pushing the WASM with the rest of the code

```powershell
cd "C:\Users\ravic\Downloads\files (1)\signal-player"
git add wasm
git commit -m "build: rebuild Rust core"
git push
```

The `.wasm` file is binary; git stores it without diffing. ~200 KB per push of the wasm directory.

---

## Troubleshooting

### "wasm-pack: command not found" after install
Close and reopen PowerShell. `cargo install` puts binaries in `%USERPROFILE%\.cargo\bin` which needs a fresh shell to pick up.

### "error: linker `rust-lld` not found"
Run `rustup component add llvm-tools-preview` and retry.

### Build succeeds but `[signal] Rust core unavailable` in browser
Check that `wasm/signal_core_bg.wasm` exists. Open the URL `https://rocko5498.github.io/signal-player/wasm/signal_core_bg.wasm` directly in your browser — it should download a binary file, not 404. If 404, git probably ignored binary files; check there's no `.gitignore` filtering `*.wasm`.

### "the package requires Rust 1.77 or newer"
Run `rustup update`. Rust 1.82+ is current.

### `wasm-opt` not found warning
Harmless. wasm-pack uses it for size optimisation. If you want it:
```powershell
winget install binaryen
```
…and rebuild.

### Build takes forever on first run
First build downloads + compiles all dependencies (~3 minutes). Subsequent builds are ~10 seconds incremental.

---

## What's in the Rust core

```
rust/
├── Cargo.toml         # dependencies + build profile
└── src/
    ├── lib.rs         # wasm-bindgen exports
    ├── metadata.rs    # FLAC/WAV/AIFF/DSF/DFF/MP4 header parser
    ├── fft.rs         # in-place radix-2 FFT
    ├── analysis.rs    # DR meter, hi-res detector, THD+N
    └── dsd.rs         # DSF demuxer + lowpass filter + decimation
```

Run the test suite (~15 seconds, native compile):

```powershell
cd rust
cargo test
```

All 9 tests should pass.

---

## What changes between releases

When I send you a new version of the repo:

- If only `js/` changed → no rebuild needed, just `git push`
- If anything under `rust/src/` changed → run `wasm-pack build` again, then `git push`
- If `Cargo.toml` changed → run `wasm-pack build` again; it'll re-download deps the first time

I'll tell you in the commit message which one applies.
