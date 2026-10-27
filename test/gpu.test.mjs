// Tests for the GPU adapter. Run with:  npm test   (needs the addon built: npm run build)
import test from "node:test";
import assert from "node:assert/strict";
import * as snarkjs from "snarkjs";
import { getCurveFromName } from "ffjavascript";
import * as binFileUtils from "@iden3/binfileutils";
import { readFileSync } from "node:fs";
import { prepare } from "../scripts/prepare.mjs";
import { installGpu, loadAddon } from "../src/index.mjs";

const addon = loadAddon();
const curve = await getCurveFromName("bn128");
const circuit = await prepare("chain", 1000);
const cpuMsm = curve.G1.multiExpAffine; // snarkjs's own functions, before any wrapping
const g2Cpu = curve.G2.multiExpAffine;
const fftCpu = { fft: curve.Fr.fft, ifft: curve.Fr.ifft };

async function section(path, type, id) {
  const { fd, sections } = await binFileUtils.readBinFile(path, type, 2, 1 << 25, 1 << 23);
  const buffer = await binFileUtils.readSection(fd, sections, id);
  await fd.close();
  return buffer;
}
const bases = await section(circuit.zkey, "zkey", 5); // 64-byte points, 1002 of them

function randomScalars(n, { zeros = false } = {}) {
  const out = new Uint8Array(n * 32);
  for (let i = 0; i < n && !zeros; i++) {
    let v = curve.Fr.toObject(curve.Fr.random());
    for (let b = 0; b < 32; b++, v >>= 8n) out[i * 32 + b] = Number(v & 0xffn);
  }
  return out;
}
const affine = (p) => curve.G1.toObject(curve.G1.toAffine(p));

test("the GPU gives snarkjs's answer for random scalars of many sizes", async () => {
  const gpu = installGpu(curve, { minPoints: 1, addon });
  try {
    for (const n of [1, 2, 3, 17, 255, 256, 257, 1002]) {
      const b = bases.slice(0, n * 64);
      const s = randomScalars(n);
      assert.deepEqual(affine(await curve.G1.multiExpAffine(b, s)), affine(await cpuMsm.call(curve.G1, b, s)), `n = ${n}`);
    }
    assert.equal(gpu.stats.g1.cpu, 0, "every call should have used the GPU");
  } finally {
    gpu.uninstall();
  }
});

test("all-zero scalars give the point at infinity", async () => {
  const gpu = installGpu(curve, { minPoints: 1, addon });
  try {
    const result = await curve.G1.multiExpAffine(bases, randomScalars(1002, { zeros: true }));
    assert.ok(curve.G1.isZero(result));
  } finally {
    gpu.uninstall();
  }
});

test("a point at infinity among the bases is ignored", async () => {
  const gpu = installGpu(curve, { minPoints: 1, addon });
  try {
    const b = bases.slice(0, 100 * 64);
    b.fill(0, 10 * 64, 11 * 64); // (0, 0) is how a zkey stores infinity
    const s = randomScalars(100);
    assert.deepEqual(affine(await curve.G1.multiExpAffine(b, s)), affine(await cpuMsm.call(curve.G1, b, s)));
  } finally {
    gpu.uninstall();
  }
});

test("a real Groth16 proof made with the GPU verifies, and tampering is caught", async () => {
  const gpu = installGpu(curve, { minPoints: 1, minFftPoints: 1, addon });
  try {
    const vkey = JSON.parse(readFileSync(circuit.vkey));
    const { proof, publicSignals } = await snarkjs.groth16.prove(circuit.zkey, circuit.wtns);
    assert.ok(gpu.stats.g1.gpu >= 4, `expected 4 G1 MSMs on the GPU, got ${gpu.stats.g1.gpu}`);
    assert.equal(gpu.stats.g2.gpu, 1, "the G2 MSM should have used the GPU");
    assert.equal(gpu.stats.fft.gpu, 6, "all six FFTs should have used the GPU");
    assert.equal(await snarkjs.groth16.verify(vkey, publicSignals, proof), true);
    assert.equal(await snarkjs.groth16.verify(vkey, ["12345"], proof), false, "wrong public input must fail");
  } finally {
    gpu.uninstall();
  }
});

const g2Bases = await section(circuit.zkey, "zkey", 7); // 128-byte points
const affineG2 = (p) => curve.G2.toObject(curve.G2.toAffine(p));

test("G2: the GPU gives snarkjs's answer for random scalars of many sizes", async () => {
  const gpu = installGpu(curve, { minPoints: 1, addon });
  try {
    for (const n of [1, 2, 3, 17, 255, 257, 1002]) {
      const b = g2Bases.slice(0, n * 128);
      const s = randomScalars(n);
      assert.deepEqual(affineG2(await curve.G2.multiExpAffine(b, s)), affineG2(await g2Cpu.call(curve.G2, b, s)), `n = ${n}`);
    }
    assert.equal(gpu.stats.g2.cpu, 0, "every call should have used the GPU");
  } finally {
    gpu.uninstall();
  }
});

test("G2: all-zero scalars give infinity and an infinity base is ignored", async () => {
  const gpu = installGpu(curve, { minPoints: 1, addon });
  try {
    assert.ok(curve.G2.isZero(await curve.G2.multiExpAffine(g2Bases, randomScalars(1002, { zeros: true }))));
    const b = g2Bases.slice(0, 100 * 128);
    b.fill(0, 10 * 128, 11 * 128);
    const s = randomScalars(100);
    assert.deepEqual(affineG2(await curve.G2.multiExpAffine(b, s)), affineG2(await g2Cpu.call(curve.G2, b, s)));
  } finally {
    gpu.uninstall();
  }
});

function randomField(n) {
  const out = new Uint8Array(n * 32);
  for (let i = 0; i < n; i++) out.set(curve.Fr.random(), i * 32); // Montgomery form, as snarkjs holds them
  return out;
}

test("FFT: the GPU gives exactly ffjavascript's bytes, forward and inverse", async () => {
  const gpu = installGpu(curve, { minFftPoints: 1, minPoints: 1e9, addon });
  try {
    for (const log of [10, 11, 12, 14, 16]) {
      const data = randomField(1 << log);
      for (const name of ["fft", "ifft"]) {
        const got = await curve.Fr[name](data, "", "");
        const want = await fftCpu[name].call(curve.Fr, data, "", "");
        assert.ok(Buffer.compare(got, want) === 0, `${name} 2^${log}`);
        assert.equal(got.constructor, Uint8Array, "must be a plain Uint8Array");
      }
      const back = await curve.Fr.ifft(await curve.Fr.fft(data, "", ""), "", "");
      assert.ok(Buffer.compare(back, data) === 0, `round trip 2^${log}`);
    }
    assert.equal(gpu.stats.fft.cpu, 0, "every call should have used the GPU");
  } finally {
    gpu.uninstall();
  }
});

test("FFT: a BigBuffer in gives the same plain Uint8Array out as the CPU", async () => {
  const gpu = installGpu(curve, { minFftPoints: 1, minPoints: 1e9, addon });
  try {
    const data = randomField(1 << 12);
    const big = new (await import("ffjavascript")).BigBuffer(data.byteLength);
    big.set(data, 0);
    for (const name of ["fft", "ifft"]) {
      const got = await curve.Fr[name](big, "", "");
      const want = await fftCpu[name].call(curve.Fr, big, "", "");
      assert.equal(got.constructor, want.constructor);
      assert.ok(Buffer.compare(got.slice(0, got.byteLength), want.slice(0, want.byteLength)) === 0, name);
    }
    assert.equal(gpu.stats.fft.gpu, 2);
  } finally {
    gpu.uninstall();
  }
});

test("FFT: sizes the GPU cannot do, and arrays, go to the CPU unchanged", async () => {
  const gpu = installGpu(curve, { minFftPoints: 1 << 12, minPoints: 1e9, addon });
  try {
    for (const n of [4, 256, 2048]) {
      const data = randomField(n);
      const got = await curve.Fr.fft(data, "", "");
      assert.ok(Buffer.compare(got, await fftCpu.fft.call(curve.Fr, data, "", "")) === 0);
    }
    assert.deepEqual([gpu.stats.fft.gpu, gpu.stats.fft.cpu], [0, 3]);
  } finally {
    gpu.uninstall();
  }
});

test("sharing an MSM between the GPU and the CPU gives the same answer", async () => {
  const gpu = installGpu(curve, { minPoints: 100, cpuShare: { g1: 0.3, g2: 0.45 }, addon });
  try {
    for (const n of [400, 1002]) {
      const s = randomScalars(n);
      const g1 = bases.slice(0, n * 64);
      assert.deepEqual(affine(await curve.G1.multiExpAffine(g1, s)), affine(await cpuMsm.call(curve.G1, g1, s)), `G1 n = ${n}`);
      const g2 = g2Bases.slice(0, n * 128);
      assert.deepEqual(affineG2(await curve.G2.multiExpAffine(g2, s)), affineG2(await g2Cpu.call(curve.G2, g2, s)), `G2 n = ${n}`);
    }
    assert.equal(gpu.stats.g1.gpu + gpu.stats.g2.gpu, 4, "the GPU should have taken part in every call");
  } finally {
    gpu.uninstall();
  }
});

test("small inputs stay on the CPU", async () => {
  const gpu = installGpu(curve, { minPoints: 5000, addon });
  try {
    await curve.G1.multiExpAffine(bases, randomScalars(1002));
    assert.deepEqual([gpu.stats.g1.gpu, gpu.stats.g1.cpu], [0, 1]);
  } finally {
    gpu.uninstall();
  }
});

test("if the GPU fails, the CPU answer is used and the failure is reported", async () => {
  const reasons = [];
  const broken = { msmG1: async () => { throw new Error("device lost"); }, msmG2: async () => { throw new Error("device lost"); } };
  const gpu = installGpu(curve, { minPoints: 1, addon: broken, onFallback: (r) => reasons.push(r) });
  try {
    const s = randomScalars(1002);
    assert.deepEqual(affine(await curve.G1.multiExpAffine(bases, s)), affine(await cpuMsm.call(curve.G1, bases, s)));
    assert.match(reasons[0], /device lost/);
    assert.equal(gpu.stats.g1.cpu, 1);
    // After a failure the GPU is not tried again (here a second call would add a second reason).
    await curve.G1.multiExpAffine(bases, s);
    assert.equal(reasons.length, 1);
    assert.equal(gpu.stats.g1.cpu, 2);
  } finally {
    gpu.uninstall();
  }
});

test("a GPU call that never answers is abandoned for the CPU", async () => {
  const reasons = [];
  const stuck = { msmG1: () => new Promise(() => {}), msmG2: () => new Promise(() => {}), ntt: () => new Promise(() => {}) };
  const gpu = installGpu(curve, { minPoints: 1, timeoutMs: 100, addon: stuck, onFallback: (r) => reasons.push(r) });
  try {
    const s = randomScalars(100);
    const b = bases.slice(0, 100 * 64);
    assert.deepEqual(affine(await curve.G1.multiExpAffine(b, s)), affine(await cpuMsm.call(curve.G1, b, s)));
    assert.match(reasons[0], /no answer after 100 ms/);
  } finally {
    gpu.uninstall();
  }
});

test("the addon rejects malformed input instead of crashing", () => {
  assert.throws(() => addon.msmG1(new Uint8Array(63), new Uint8Array(32)), /multiple of 64/);
  assert.throws(() => addon.msmG1(new Uint8Array(0), new Uint8Array(0)), /non-empty/);
  assert.throws(() => addon.msmG1(new Uint8Array(128), new Uint8Array(32)), /32 bytes for each/);
  assert.throws(() => addon.msmG2(new Uint8Array(64), new Uint8Array(32)), /multiple of 128/);
  assert.throws(() => addon.ntt(new Uint8Array(32 * 1000), false), /2\^10 to 2\^27/);
  assert.throws(() => addon.ntt(new Uint8Array(32 * 512), false), /2\^10 to 2\^27/);
});

