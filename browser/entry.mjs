// Runs in the browser: proves a Groth16 circuit with snarkjs on the CPU and again with the GPU,
// verifies both, and reports timings. Driven by browser/run.mjs (puppeteer).
import * as snarkjs from "snarkjs";
import { getCurveFromName } from "ffjavascript";
import { autoInstall, installGpu } from "../src/browser.mjs";

const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

window.runProof = async function runProof({ dir, name, use, minPoints, minFftPoints, auto }) {
  const [zkey, wtns, vkey] = await Promise.all([
    fetchBytes(`/data/${dir}/${name}.zkey`),
    fetchBytes(`/data/${dir}/witness.wtns`),
    fetch(`/data/${dir}/vkey.json`).then((r) => r.json()),
  ]);
  const prove = async () => {
    const t = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove({ type: "mem", data: zkey }, { type: "mem", data: wtns });
    const ms = performance.now() - t;
    return { ms, ok: await snarkjs.groth16.verify(vkey, publicSignals, proof) };
  };

  const result = { webgpu: Boolean(navigator.gpu) };
  const options = { wasmUrl: "/pkg/zk_gpu_web_bg.wasm", minPoints, minFftPoints, use, onFallback: (why) => result.fallbacks.push(why) };
  result.fallbacks = [];

  if (auto) {
    // An app that bundles snarkjs: no explicit hook into the curve, just autoInstall() before the first proof.
    const gpu = autoInstall(options);
    result.gpu = [await prove(), await prove()];
    result.stats = gpu.stats;
    gpu.uninstall();
    return result;
  }

  const curve = await getCurveFromName("bn128");
  result.cpu = [await prove(), await prove()];

  const t0 = performance.now();
  const gpu = await installGpu(curve, options);
  result.gpuStartMs = performance.now() - t0;
  result.gpu = [await prove(), await prove()];
  result.stats = gpu.stats;
  gpu.uninstall();
  return result;
};
window.ready = true;
