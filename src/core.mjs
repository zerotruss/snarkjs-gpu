// Platform-independent part: makes snarkjs run its multi-scalar multiplications (MSMs, in G1 and G2) and its fast Fourier
// transforms (FFTs) on the GPU, without changing snarkjs: it wraps the ffjavascript functions
// snarkjs calls, and falls back to the original CPU code for small inputs or if the GPU fails.
//
//   import { getCurveFromName } from "ffjavascript";
//   import { installGpu } from "snarkjs-gpu";   // the Node or the browser entry point
//   const curve = await getCurveFromName("bn128");
//   const gpu = await installGpu(curve);   // from now on snarkjs.groth16.prove uses the GPU
//   ...
//   gpu.uninstall();
const SCALAR_BYTES = 32;

// The addon returns plain little-endian 32-byte numbers; an empty result is the point at infinity.
const number = (bytes) => bytes.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
const field = (bytes, i) => number(bytes.subarray(32 * i, 32 * i + 32));
// ffjavascript sometimes holds data in a paged BigBuffer; below one page that is a single Uint8Array.
const bytesOf = (buff) => {
  if (buff instanceof Uint8Array) return buff;
  const copy = typeof buff?.slice === "function" ? buff.slice(0, buff.byteLength) : undefined;
  return copy instanceof Uint8Array ? copy : undefined;
};
const g1Point = (G1, b) => (b.length === 0 ? G1.zero : G1.fromObject([field(b, 0), field(b, 1), 1n]));
const g2Point = (G2, b) => (b.length === 0 ? G2.zero : G2.fromObject([[field(b, 0), field(b, 1)], [field(b, 2), field(b, 3)], [1n, 0n]]));

/**
 * @param curve        the ffjavascript curve snarkjs uses (from getCurveFromName("bn128"))
 * @param minPoints    MSMs run on the GPU from this many points up; below that the CPU is faster
 * @param minFftPoints the same for FFTs
 * @param use          which operations to run on the GPU: any of "g1", "g2", "fft"
 * @param cpuShare     fraction of each MSM's points given to the CPU while the GPU does the rest
 *                     (both run at once and the two sums are added), e.g. { g1: 0.2, g2: 0.35 }
 * @param timeoutMs    a GPU call that takes longer than this is abandoned for the CPU (0 = no limit)
 * @param onFallback   called with (reason) when a call is handed back to the CPU
 *
 * After the first GPU failure the GPU is not used again by this installation: a lost or stuck
 * device would otherwise make every later call wait for its own failure.
 */
export function installGpu(curve, { minPoints = 1 << 10, minFftPoints = 1 << 12, use = ["g1", "g2", "fft"], cpuShare = {}, timeoutMs = 120_000, addon, onFallback = () => {} } = {}) {
  if (!addon) throw new Error("installGpu needs an addon (use the Node or browser entry point)");
  const stats = { g1: { gpu: 0, cpu: 0 }, g2: { gpu: 0, cpu: 0 }, fft: { gpu: 0, cpu: 0 } };
  const restore = [];
  let broken = false;
  const withTimeout = (promise) => {
    if (!timeoutMs) return promise;
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer after ${timeoutMs} ms`)), timeoutMs); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  };

  // Replaces owner[name]; `handle(args)` returns the GPU's answer, or undefined to use the CPU.
  const wrap = (key, owner, name, handle) => {
    const original = owner[name];
    restore.push(() => { owner[name] = original; });
    owner[name] = async function (...args) {
      if (!broken) {
        try {
          const answer = await withTimeout(handle(args));
          if (answer !== undefined) {
            stats[key].gpu++;
            return answer;
          }
        } catch (error) {
          broken = true;
          onFallback(`GPU failed, using the CPU from now on: ${error.message}`);
        }
      }
      stats[key].cpu++;
      return original.apply(this, args);
    };
  };

  const msm = (key, G, pointBytes, run, toPoint) => {
    const cpu = G.multiExpAffine;
    wrap(key, G, "multiExpAffine", async ([bases, scalars, ...rest]) => {
      const n = Math.floor(bases.byteLength / pointBytes);
      if (n < minPoints || scalars.byteLength !== n * SCALAR_BYTES) return undefined;
      const [b, s] = [bytesOf(bases), bytesOf(scalars)];
      if (!b || !s) return undefined;
      const cpuPoints = n >= 4 * minPoints ? Math.floor(n * (cpuShare[key] ?? 0)) : 0;
      if (cpuPoints === 0) return toPoint(G, await run(b, s));
      // The GPU takes the first points, the CPU (snarkjs's own code, in worker threads) the rest.
      const gpuPoints = n - cpuPoints;
      const [fromGpu, fromCpu] = await Promise.all([
        run(b.subarray(0, gpuPoints * pointBytes), s.subarray(0, gpuPoints * SCALAR_BYTES)).then((r) => toPoint(G, r)),
        cpu.call(G, b.slice(gpuPoints * pointBytes), s.slice(gpuPoints * SCALAR_BYTES), ...rest),
      ]);
      return G.add(fromGpu, fromCpu);
    });
  };
  if (use.includes("g1")) msm("g1", curve.G1, 64, (b, s) => addon.msmG1(b, s), g1Point);
  if (use.includes("g2")) msm("g2", curve.G2, 128, (b, s) => addon.msmG2(b, s), g2Point);

  // snarkjs calls Fr.fft(buffer, "", "", logger, name) on n field elements in Montgomery form, as a
  // Uint8Array or as ffjavascript's paged BigBuffer. The transform is linear, so the GPU can work
  // on those bytes as they are. Like the CPU code, the answer is always a Uint8Array.
  const fft = (name, inverse) => wrap("fft", curve.Fr, name, async ([buff, inType, outType]) => {
    const bytes = buff?.byteLength;
    const n = bytes / SCALAR_BYTES;
    if (inType || outType || !Number.isInteger(n) || n < minFftPoints || n & (n - 1) || n > 2 ** 25) return undefined;
    const input = bytesOf(buff);
    if (!input) return undefined;
    return new Uint8Array(await addon.ntt(input, inverse)); // a plain copy: no Buffer view semantics
  });
  if (use.includes("fft")) {
    fft("fft", false);
    fft("ifft", true);
  }

  return { stats, uninstall: () => restore.forEach((undo) => undo()) };
}
