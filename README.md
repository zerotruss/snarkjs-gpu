# snarkjs-gpu

**A faster snarkjs in the browser.** Makes [snarkjs](https://github.com/iden3/snarkjs) run its heavy Groth16 steps on the GPU
(through WebGPU and [zk-gpu](https://github.com/zerotruss/zk-gpu)), without changing snarkjs.

**Version 0.1.0 is for the browser only.** A native Node addon exists in this repository and is tested, but it is
not shipped in the npm package yet (it would need a separate build for each operating system).

> **Independent project.** It is not made, endorsed or supported by iden3 or the snarkjs authors; "snarkjs" is
> used only to say what it works with.

## When this helps, and when it does not (read first)

All speed-ups below are **against snarkjs's own CPU code**. Measured on one Apple M1:

| Your situation | Use this? |
|---|---|
| Proving in a **browser** with snarkjs, circuit of about 2^16 constraints or more, desktop Chrome/Edge | **Yes**: 2.6-3.6x faster whole proof |
| Same, but circuit under about 2^14 constraints | No gain (the CPU is as fast; the per-call GPU cost dominates) |
| **Server, desktop app or Node back end** where you can run a native binary | **No: use [rapidsnark](https://github.com/iden3/rapidsnark).** On the same M1 it proves the same circuits 2-3.5x faster than snarkjs plus this adapter (0.9 s vs 2.6 s on a 133K-constraint Merkle circuit) |
| A machine with an NVIDIA GPU | Use a CUDA stack (ICICLE, sppark); not compared here |
| Browser without WebGPU | Harmless: the proof is made on the CPU at snarkjs's normal speed |

Not measured: other GPUs and browsers, circuits above 2^18 constraints, any other in-browser prover, PLONK. It is a separate
project: zk-gpu itself has no Node, Circom or snarkjs dependency.

What goes to the GPU: the multi-scalar multiplications (MSMs) in G1 and G2 and the six number-theoretic
transforms (FFTs). What stays on the CPU: witness loading, building the A/B/C polynomials, the coset
shifts, and proof assembly.

## Install and use

### From a page that loads snarkjs from a CDN (no build step)

Add two lines before the usual snarkjs script tag. The WebAssembly file is found next to the script automatically.

```html
<script src="https://cdn.jsdelivr.net/npm/snarkjs-gpu@0.1.0/dist/snarkjs-gpu.iife.js"></script>
<script>GpuZk.autoInstall();</script>
<script src="https://cdn.jsdelivr.net/npm/snarkjs@0.7.6/build/snarkjs.min.js"></script>
<!-- ...then snarkjs.groth16.prove(...) exactly as before -->
```

The added script receives your witness (the private inputs), so **pin the version** (as above) and add Subresource
Integrity: compute the hash of the exact file you use with
`curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A` and put it in `integrity="sha384-..."` with `crossorigin="anonymous"`.

### From an app with a bundler

```sh
npm install snarkjs-gpu snarkjs
```

```js
import { getCurveFromName } from "ffjavascript";
import * as snarkjs from "snarkjs";
import { installGpu } from "snarkjs-gpu";

const gpu = await installGpu(await getCurveFromName("bn128"));   // snarkjs itself is unchanged
const { proof, publicSignals } = await snarkjs.groth16.prove("circuit.zkey", "witness.wtns");
console.log(gpu.stats);                           // how many calls ran on the GPU / the CPU
```

`installGpu` looks for `zk_gpu_web_bg.wasm` next to the module. If your bundler moves files, pass `{ wasmUrl }` (the file is
also available as `snarkjs-gpu/wasm`). Bundler setups were not tested; the script-tag page and a bundle made with esbuild
were.

### What it does

`installGpu` wraps the ffjavascript functions snarkjs calls. The multi-scalar multiplications (MSMs) in G1 and G2 and the six
number-theoretic transforms (FFTs) go to the GPU. Witness loading, building the A/B/C polynomials, the coset shifts and proof
assembly stay on the CPU. Small inputs run on the CPU as before. If the GPU fails or does not answer within `timeoutMs`,
that call and all later ones use snarkjs's own CPU code, so a proof is never lost to the GPU (`onFallback` tells you why).
In a browser without WebGPU nothing changes: the proof is made on the CPU at snarkjs's normal speed.

Why the script-tag version works: ffjavascript, inside the prebuilt snarkjs file, keeps its curve in `globalThis.curve_bn128`;
`autoInstall` watches that property and wraps every curve stored there. The alternative, with one extra line, is
`await GpuZk.installGpu(await snarkjs.curves.getCurveFromName("bn128"))`. Both were tested against the **unmodified prebuilt
`snarkjs.min.js`** in headless Chrome (`npm run test:cdn`): the script before snarkjs, after it, and the explicit call all gave
2.5-2.8x on Merkle depth 64, with the same GPU call counts. An app that **bundles** snarkjs works too (`AUTO=1 node browser/run.mjs merkle 64`).

### Tested versions

| Part | Tested | Notes |
|---|---|---|
| snarkjs | 0.7.6 | declared as an optional peer dependency `0.7.x`; other versions untested |
| ffjavascript (inside snarkjs) | 0.3.1 | the adapter relies on its function names and call pattern; a different release may break it |
| Browser | Chrome 155 on macOS (Apple M1) | Edge/Chrome with WebGPU should work; Firefox and Safari untested |
| Proof system | Groth16 on BN254 | PLONK untested |

Limits: snarkjs' `singleThread` option builds a curve that is not stored globally, so the hook cannot see it. If proving runs
inside a Web Worker, the script must be loaded in that worker (not tested).

## Layout

| Folder | What it is |
|---|---|
| `engine/` | Rust: the operations on snarkjs's byte formats (shared by Node and browser) |
| `node/` | Rust: Node addon (napi) over the engine (built from source; not in the npm package yet) |
| `web/` | Rust: WebAssembly build (wasm-bindgen) over the engine, runs on WebGPU |
| `src/` | JavaScript: `core.mjs` (the adapter), `node.mjs`, `browser.mjs` (entry points) |
| `test/`, `browser/` | adapter tests (Node) and the headless-Chrome end-to-end test |
| `circuits/`, `scripts/` | Circom circuits, setup and profiling scripts |

## Set up and test

Needs `circom` 2.x, Node 18+, Rust 1.92+ (with the `wasm32-unknown-unknown` target and `wasm-pack` for the browser) and Chrome for
the browser tests. The GPU library is fetched from crates.io (`zk-gpu`), so no other checkout is needed.

```sh
npm install
npm run build          # the Node addon -> node/zk_gpu_node.node (development only)
npm run build:package  # the WebAssembly (web/pkg) and the bundles + wasm in dist/ (what the npm package ships)
npm test               # 14 tests: byte-exact agreement with snarkjs, real proofs verify, fallbacks
npm run test:browser   # a real proof in headless Chrome on WebGPU, CPU vs GPU (CHROME=... to choose a Chrome)
npm run test:cdn       # the same with the prebuilt snarkjs.min.js from a <script> tag (5 page variants)
                       # (the Node tests and the browser tests need a real GPU; GitHub's runners have none)

node scripts/prepare.mjs merkle 64       # compile + set up + witness for a circuit (into build/)
node scripts/profile.mjs merkle 64       # where a real snarkjs proof spends its time
node scripts/profile.mjs merkle 64 --gpu # the same with the GPU (SNARKJS_GPU_USE=g1,g2,fft; SNARKJS_GPU_SHARE='{"g2":0.25}')
```

Circuits: `chain` is N squarings (exactly N constraints, to get any size); `merkle` is a Poseidon
Merkle-membership proof of a given depth (about 520 constraints per level). The trusted setup is generated
locally and is **insecure: for testing only**. It is slow at large sizes (about an hour for 2^18, because
snarkjs computes it on the CPU); a public Hermez `.ptau` file can be placed in `build/ptau/pot<k>.ptau`.

## Results (Apple M1, whole Groth16 proof, snarkjs 0.7.6 unchanged = "CPU")

Warm: the second proof in the same process / page. All proofs verify.

**Node**

| Circuit | Size | CPU | GPU | Speed-up |
|---|---|---|---|---|
| Merkle, depth 64 | 2^16 | 2.2 s | 0.88 s | 2.5x |
| Merkle, depth 256 | 2^18 | 7.7 s | 2.6 s | 3.0x |
| `chain`, 65,520 constraints | 2^16 | 5.0 s | 1.3 s | 4.0x |
| `chain`, 262,128 constraints | 2^18 | 19.4 s | 4.0 s | 4.8x |

**Browser (headless Chrome, WebGPU; snarkjs uses its web workers for the CPU)**

| Circuit | Size | CPU | GPU | Speed-up |
|---|---|---|---|---|
| Merkle, depth 64 | 2^16 | 2.1-2.4 s | 0.83-0.85 s | 2.6-2.7x |
| Merkle, depth 256 | 2^18 | 8.3-8.8 s | 2.4-2.5 s | 3.3-3.6x |

The Merkle rows are the realistic ones: its witness is real Poseidon output (99% of the scalars are over
200 bits, so it is *dense*, not sparse). `chain` is an upper bound.

Where the GPU proof spends its time (Merkle depth 256): G2 MSM about 1.0 s, the four G1 MSMs about 0.9 s,
the six FFTs about 0.15 s, the rest (about 0.4 s) on the CPU. G2 is now the largest piece and the GPU
kernel for it is about 5x slower than for G1 (register pressure is the likely reason; not investigated).

**First proof on a machine.** Compiled shaders are cached by the OS (Metal) or the browser profile; the
first run with a cold cache costs several seconds more (6.7 s vs 2.7 s for Merkle 256 in a fresh Chrome
profile) and later runs do not. A normal user pays it once.

**CPU/GPU sharing** (`cpuShare`, off by default). Giving the CPU a quarter of the G2 MSM and a tenth of the
G1 MSMs saved about 10% on Merkle 256 on this M1, but a larger G1 share made the biggest MSM slower (the
two compete for memory bandwidth). It is machine-dependent, so it is opt-in.

## Known limits

- **macOS GPU watchdog.** macOS can terminate GPU work that keeps the device busy ("Impacting Interactivity"); the browser then
  reports the device as lost. The MSM waits for each heavy slice to finish (`run_yielding`), which helped a lot, but it still
  happens occasionally on the M1 used for testing (1 run in 40 in one batch, more often in others). The adapter then falls back
  to the CPU: the proof still verifies, just without the speed-up.
- Measured on one machine (an M1). The browser test is on macOS Chrome only.
- Single `.zkey` section sizes above 1 GB (ffjavascript's paged buffers) are not handled on the GPU path.

## Contributing, security and licence

Issues are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and open an issue before a large pull request. For security
problems read [SECURITY.md](SECURITY.md) first.

Licensed under the [GNU General Public License, version 3 or later](LICENSE) (`GPL-3.0-or-later`), the same family as
snarkjs and ffjavascript, which this adapter wraps at run time. The GPU library it uses, zk-gpu, is licensed
`MIT OR Apache-2.0`.
