# Contributing to snarkjs-gpu

Issues are welcome. This project is maintained on a best-effort basis, so please open an issue before sending a pull
request for a large change.

## Rules

1. **Keep the code simple and readable.** Match the naming and comment density of the code around it. Write the full
   form of an abbreviation the first time it appears in a document or comment (for example Multi-Scalar
   Multiplication, MSM).
2. **Test after every change, and show the tests can fail.** A new test should fail without your fix.
3. **Never change snarkjs.** The adapter wraps ffjavascript functions at run time and must keep working with the
   unmodified, prebuilt `snarkjs.min.js`. Every GPU call must fall back to the CPU answer on any failure.
4. **Report speed honestly.** Name the machine, the circuit size, warm or cold, and the baseline (snarkjs alone,
   rapidsnark, a native prover...). Speed-ups against snarkjs's own CPU code are not speed-ups against a native prover.
   Quote warm proofs: the first proof includes worker start-up and shader compilation.
5. **Correctness first.** A proof that does not verify, or an MSM or FFT result that differs from ffjavascript's by
   one byte, is a bug.
6. **Stay independent.** The GPU library (zk-gpu) has no Node, Circom or snarkjs dependency; keep it that way.

## Setup

You need Node.js, a Rust toolchain (rustup's, with the `wasm32-unknown-unknown` target), `wasm-pack`, Chrome with
WebGPU for the browser tests, and the Circom compiler.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
npm install
npm run build          # the Node addon
npm run build:package  # the WebAssembly build and the bundles in dist/

```

Test circuits, trusted setups and keys are generated on first use into `build/` and are not stored in git. A small
circuit takes seconds; a trusted setup for 2^18 constraints takes about an hour on the CPU, so keep `build/`.

## What to run when you change something

| You changed | Run |
|---|---|
| the adapter (`src/*.mjs`) | `npm test`; also `npm run test:browser` if it touches the browser path |
| `engine/`, `node/`, `web/` (Rust) | rebuild, then `npm test`, `npm run test:browser`, and `cargo clippy --release -- -D warnings` in each crate (`web/` with `--target wasm32-unknown-unknown`) |
| the script-tag bundle or `autoInstall` | `npm run build:web && npm run build:cdn && npm run test:cdn` |
| a new snarkjs or ffjavascript version | all of the above against that version, and record the result in the README's tested-versions list |

The browser tests drive headless Chrome with `puppeteer-core`; variables: `CHROME=<path>`, `CHROME_PROFILE=<dir>`,
`HEADED=1`, `AUTO=1`, `MODES=auto,late` (CDN test only). The browser tests fail on purpose if a GPU call fell back to
the CPU or a proof does not verify.

## Lessons that shaped the code

- **Number formats.** zkey points are in Montgomery form with R = 2^256 and scalars are plain; the library uses
  R = 2^260 internally, so bases are converted on the GPU. The number-theoretic transform is linear, so Montgomery data
  passes through unchanged.
- **`BigBuffer`.** ffjavascript keeps large arrays in a paged `BigBuffer`; the FFT can receive one. Copy it into a plain
  `Uint8Array` before handing it on.
- **Views.** `Buffer.slice` returns a view; native code must not keep views of memory that JavaScript may move or free.
- **One ffjavascript instance.** The adapter wraps functions on the cached curve object. It must be the instance
  snarkjs uses; the prebuilt browser file keeps its own private copy, reachable through `globalThis.curve_bn128`.
- **Bundling snarkjs for a browser** needs stubs for Node-only modules and `process.browser`.
- **Never panic in code reached from async WebAssembly,** or the JavaScript promise hangs for ever. Return errors, and
  keep the timeout and the circuit breaker (after the first GPU failure the GPU is not used again by that installation).
- **The macOS GPU watchdog** can kill the device during long GPU work; heavy stages are awaited one by one
  (`run_yielding`). The device is still lost occasionally; the fallback to the CPU must keep working.
- **Version coupling.** The adapter depends on ffjavascript's function names and call pattern (`G1/G2.multiExpAffine`,
  `Fr.fft/ifft`). Treat any ffjavascript upgrade as a possible break.

## Pull requests

- One topic per pull request, with tests.
- Say what changed and why, and paste the summary lines of the tests you ran.
- Any speed claim names its machine and baseline.

## Licence

By contributing you agree that your work is licensed like the project, `GPL-3.0-or-later`.
