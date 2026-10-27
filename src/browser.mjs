// Browser entry point: loads the WebAssembly build (web/pkg, built by `npm run build:web`) that
// runs on the browser's WebGPU.
//
//   import { installGpu } from "snarkjs-gpu";   // resolves to this file in a browser bundle
//   const gpu = await installGpu(curve);
import init, { GpuZk } from "../web/pkg/zk_gpu_web.js";
import { installGpu as install } from "./core.mjs";

// Where this file was loaded from. In the npm package the WebAssembly file sits next to it, so a page
// does not need to say where it is. (In the script-tag bundle this is the <script> element's address.)
const SCRIPT_URL = import.meta.url;

function defaultWasmUrl() {
  if (!SCRIPT_URL) throw new Error("snarkjs-gpu cannot tell where it was loaded from: pass { wasmUrl }");
  return new URL("zk_gpu_web_bg.wasm", SCRIPT_URL).href;
}

/** Opens the GPU and returns the addon-shaped object the core adapter uses. */
export async function loadWebGpu(wasmUrl) {
  if (!globalThis.navigator?.gpu) throw new Error("this browser has no WebGPU");
  await init({ module_or_path: wasmUrl ?? defaultWasmUrl() });
  const zk = await GpuZk.create();
  // One GPU plan is shared by all calls of a size, so calls must not overlap: run them in turn.
  let tail = Promise.resolve();
  const inTurn = (work) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  return {
    gpuName: () => zk.adapter(),
    msmG1: (bases, scalars) => inTurn(() => zk.msmG1(bases, scalars)),
    msmG2: (bases, scalars) => inTurn(() => zk.msmG2(bases, scalars)),
    ntt: (data, inverse) => inTurn(() => zk.ntt(data, inverse)),
  };
}

/** Same as the core `installGpu` (but async: it opens the GPU first). */
export async function installGpu(curve, { wasmUrl, ...options } = {}) {
  return install(curve, { addon: options.addon ?? (await loadWebGpu(wasmUrl)), ...options });
}

/**
 * For a page that loads snarkjs from a CDN with a plain <script> tag, and so has no hook into the curve
 * snarkjs builds. Call this BEFORE snarkjs runs (before or right after its script tag): ffjavascript keeps its
 * curve in `globalThis.curve_bn128`, and every curve stored there from now on is wrapped as soon as it
 * appears, so `snarkjs.groth16.prove` uses the GPU with no other change. The GPU is opened at once by
 * default (`eager`), so its small download overlaps the proving-key download.
 * Returns `{ stats, uninstall }`; on a browser without WebGPU every call falls back to the CPU.
 */
export function autoInstall({ wasmUrl, eager = true, ...options } = {}) {
  let ready;
  const open = () => (ready ??= loadWebGpu(wasmUrl));
  const lazy = {
    gpuName: async () => (await open()).gpuName(),
    msmG1: async (bases, scalars) => (await open()).msmG1(bases, scalars),
    msmG2: async (bases, scalars) => (await open()).msmG2(bases, scalars),
    ntt: async (data, inverse) => (await open()).ntt(data, inverse),
  };
  let curve = globalThis.curve_bn128 ?? null;
  let handle = null;
  const attach = (c) => {
    handle?.uninstall();
    handle = c ? install(c, { ...options, addon: lazy }) : null;
  };
  Object.defineProperty(globalThis, "curve_bn128", {
    configurable: true,
    get: () => curve,
    set(c) { curve = c; attach(c); },
  });
  if (curve) attach(curve);
  if (eager) open().catch(() => {}); // a failure is reported when the first call falls back
  return {
    get stats() { return handle?.stats; },
    uninstall() {
      handle?.uninstall();
      handle = null;
      Object.defineProperty(globalThis, "curve_bn128", { configurable: true, writable: true, value: curve });
    },
  };
}
