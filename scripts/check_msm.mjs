// Checks the GPU addon against snarkjs on real data (the "A" bases of a proving key and the
// witness as scalars) and times both: GPU start-up, first call, and warm calls.
//
//   node scripts/check_msm.mjs chain 16368
import { getCurveFromName } from "ffjavascript";
import * as binFileUtils from "@iden3/binfileutils";
import { prepare } from "./prepare.mjs";
import { loadAddon } from "../src/index.mjs";

const [kind, param] = process.argv.slice(2);
const built = await prepare(kind, Number(param));
const curve = await getCurveFromName("bn128");

async function section(path, type, id) {
  const { fd, sections } = await binFileUtils.readBinFile(path, type, 2, 1 << 25, 1 << 23);
  const buffer = await binFileUtils.readSection(fd, sections, id);
  await fd.close();
  return buffer;
}
const bases = await section(built.zkey, "zkey", 5);   // points, Montgomery form (R = 2^256)
const scalars = await section(built.wtns, "wtns", 2); // plain 32-byte little-endian scalars
const n = scalars.byteLength / 32;

async function timed(label, fn) {
  const t = performance.now();
  const value = await fn();
  const ms = performance.now() - t;
  console.log(`  ${label.padEnd(28)} ${ms.toFixed(1).padStart(8)} ms`);
  return { value, ms };
}

console.log(`${built.name}: ${n} points`);
const cpu = [];
for (let i = 1; i <= 3; i++) cpu.push(await timed(`snarkjs CPU, run ${i}`, () => curve.G1.multiExpAffine(bases, scalars)));
const expected = curve.G1.toObject(curve.G1.toAffine(cpu[0].value));

const addon = loadAddon();
await timed("GPU start-up", async () => addon.gpuName());
console.log(`  GPU: ${addon.gpuName()}`);
const gpu = [];
for (let i = 1; i <= 5; i++) gpu.push(await timed(`zk-gpu, call ${i}${i === 1 ? " (cold)" : ""}`, () => addon.msmG1(bases, scalars)));

const number = (b) => b.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
const out = gpu[0].value;
const same = out.length === 0 ? expected[2] === 0n : number(out.subarray(0, 32)) === expected[0] && number(out.subarray(32, 64)) === expected[1];
const warmCpu = Math.min(...cpu.slice(1).map((r) => r.ms));
const warmGpu = Math.min(...gpu.slice(1).map((r) => r.ms));
console.log(same ? "MATCH: both give the same point" : "MISMATCH");
console.log(`warm speed-up over snarkjs: ${(warmCpu / warmGpu).toFixed(1)}x`);
process.exit(same ? 0 : 1);
