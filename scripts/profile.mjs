// Shows where the time goes in a real snarkjs Groth16 proof.
//
//   node scripts/profile.mjs chain 16384
//   node scripts/profile.mjs merkle 20
//   node scripts/profile.mjs chain 16368 --gpu    # same, with the G1 MSMs on the GPU
//
// It wraps the field-transform (FFT) and multi-scalar-multiplication (MSM) calls that snarkjs makes
// through ffjavascript, times each one, then verifies the proof.
import * as snarkjs from "snarkjs";
import { getCurveFromName } from "ffjavascript";
import { readFileSync } from "node:fs";
import { prepare } from "./prepare.mjs";
import { installGpu } from "../src/index.mjs";

const args = process.argv.slice(2);
const useGpu = args.includes("--gpu");
const [kind, param] = args.filter((a) => !a.startsWith("--"));
const built = await prepare(kind, Number(param));
const curve = await getCurveFromName("bn128");
const gpu = useGpu ? installGpu(curve, { minPoints: Number(process.env.SNARKJS_GPU_MIN_POINTS ?? 1024), use: (process.env.SNARKJS_GPU_USE ?? "g1,g2,fft").split(","), cpuShare: JSON.parse(process.env.SNARKJS_GPU_SHARE ?? "{}"), onFallback: console.warn }) : null;

// name -> list of { ms, n }
const calls = new Map();
function timed(owner, method, label, sizeOf) {
  const original = owner[method].bind(owner);
  owner[method] = async (...args) => {
    const t0 = performance.now();
    const out = await original(...args);
    const list = calls.get(label) ?? [];
    list.push({ ms: performance.now() - t0, n: sizeOf(args) });
    calls.set(label, list);
    return out;
  };
}
timed(curve.Fr, "fft", "FFT", (a) => a[0].byteLength / curve.Fr.n8);
timed(curve.Fr, "ifft", "inverse FFT", (a) => a[0].byteLength / curve.Fr.n8);
timed(curve.Fr, "batchApplyKey", "coset shift", (a) => a[0].byteLength / curve.Fr.n8);
timed(curve.G1, "multiExpAffine", "MSM in G1", (a) => a[1].byteLength / curve.Fr.n8);
timed(curve.G2, "multiExpAffine", "MSM in G2", (a) => a[1].byteLength / curve.Fr.n8);

const vkey = JSON.parse(readFileSync(built.vkey));
for (const label of ["first proof (includes worker start-up)", "second proof"]) {
  calls.clear();
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(built.zkey, built.wtns);
  const total = performance.now() - t0;
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(`\n${label}: ${built.name}, ${built.constraints} constraints, domain 2^${built.k}, verify=${ok}`);
  console.log(`total prove time ${total.toFixed(0)} ms${gpu ? `  (on GPU: ${gpu.stats.g1.gpu} G1 MSMs, ${gpu.stats.g2.gpu} G2, ${gpu.stats.fft.gpu} FFTs; on CPU: ${gpu.stats.g1.cpu + gpu.stats.g2.cpu + gpu.stats.fft.cpu})` : ""}`);
  let accounted = 0;
  for (const [name, list] of calls) {
    const sum = list.reduce((s, c) => s + c.ms, 0);
    accounted += sum;
    const sizes = [...new Set(list.map((c) => c.n))].join(",");
    console.log(`  ${name.padEnd(12)} x${list.length}  ${sum.toFixed(0).padStart(7)} ms  ${((100 * sum) / total).toFixed(0).padStart(3)}%   size ${sizes}${list.length <= 6 ? `   calls: ${list.map((c) => c.ms.toFixed(0)).join(", ")} ms` : ""}`);
  }
  console.log(`  everything else   ${(total - accounted).toFixed(0).padStart(7)} ms  ${((100 * (total - accounted)) / total).toFixed(0).padStart(3)}%`);
}
process.exit(0); // ffjavascript keeps its worker threads alive
