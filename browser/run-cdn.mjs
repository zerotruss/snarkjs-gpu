// The "CDN user" scenario: a plain page loads the PREBUILT snarkjs.min.js with a <script> tag (as it would from
// a CDN), optionally adds the GPU adapter, and proves a circuit. Five runs of the same page:
//   cpu       snarkjs alone
//   explicit  one extra call:  GpuZk.installGpu(await snarkjs.curves.getCurveFromName("bn128"))
//   auto      one extra script before snarkjs:  GpuZk.autoInstall()   (snarkjs code untouched)
//   late      the same script placed after the snarkjs script tag
//   nowebgpu  the auto page in a browser without WebGPU: the proof must still verify (on the CPU)
//
//   npm run build:web && npm run build:cdn && node browser/run-cdn.mjs merkle 64
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { prepare } from "../scripts/prepare.mjs";
import { startServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [kind = "merkle", param = "64"] = process.argv.slice(2);
const chrome = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!chrome) throw new Error("Chrome not found: set CHROME=/path/to/chrome");
for (const f of ["dist/snarkjs-gpu.iife.js", "web/pkg/zk_gpu_web_bg.wasm"]) {
  if (!existsSync(join(root, f))) throw new Error(`missing ${f}: run npm run build:web && npm run build:cdn`);
}
const modes = (process.env.MODES ?? "cpu,explicit,auto,late,nowebgpu").split(","); // MODES=auto,late runs only those, in that order
const built = await prepare(kind, Number(param));

// The page, as a CDN user would write it. `mode` picks how (or whether) the GPU is added.
const page = (query) => {
  const mode = query.get("mode") === "nowebgpu" ? "auto" : query.get("mode"); // nowebgpu = auto with WebGPU hidden (see below)
  const wasm = '"/pkg/zk_gpu_web_bg.wasm"';
  return `<!doctype html><meta charset="utf-8"><title>cdn</title>
${mode === "auto" ? `<script src="/dist/snarkjs-gpu.iife.js"></script>\n<script>window.auto = GpuZk.autoInstall();</script>` : ""}
<script src="/vendor/snarkjs.min.js"></script>
${mode === "late" ? `<script src="/dist/snarkjs-gpu.iife.js"></script>\n<script>window.auto = GpuZk.autoInstall();</script>` : ""}
${mode === "explicit" ? '<script src="/dist/snarkjs-gpu.iife.js"></script>' : ""}
<script>
window.run = async (dir) => {
  const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  const [zkey, wtns, vkey] = await Promise.all([get("/data/" + dir + "/" + dir + ".zkey"), get("/data/" + dir + "/witness.wtns"), fetch("/data/" + dir + "/vkey.json").then((r) => r.json())]);
  let gpu = window.auto;
  if (${JSON.stringify(mode)} === "explicit") {
    const curve = await snarkjs.curves.getCurveFromName("bn128");   // the curve snarkjs itself uses
    gpu = await GpuZk.installGpu(curve, { wasmUrl: ${wasm} });
  }
  const proofs = [];
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove({ type: "mem", data: zkey }, { type: "mem", data: wtns });
    const ms = performance.now() - t;
    proofs.push({ ms, ok: await snarkjs.groth16.verify(vkey, publicSignals, proof) });
  }
  return { proofs, stats: gpu?.stats ?? null };
};
</script>`;
};

const server = await startServer([
  ["/dist/", join(root, "dist")],
  ["/pkg/", join(root, "web/pkg")],
  ["/data/", join(root, "build")],
  ["/vendor/", join(root, "node_modules/snarkjs/build")],
], page);

const browser = await puppeteer.launch({
  executablePath: chrome, headless: true, protocolTimeout: 600_000, userDataDir: process.env.CHROME_PROFILE,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-first-run", "--disable-gpu-sandbox"],
});
let failed = false;
const results = {};
try {
  for (const mode of modes) {
    const p = await browser.newPage();
    if (mode === "nowebgpu") await p.evaluateOnNewDocument(() => Object.defineProperty(navigator, "gpu", { value: undefined })); // a browser without WebGPU
    p.on("pageerror", (e) => console.log(`[${mode}] page error:`, e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) console.log(`[${mode}] console error:`, m.text()); });
    await p.goto(`${server.origin}/?mode=${mode}`);
    results[mode] = await p.evaluate((dir) => window.run(dir), built.name);
    await p.close();
  }
} finally {
  await browser.close();
  server.close();
}
const fmt = (r) => r.proofs.map((x) => `${x.ms.toFixed(0)} ms`).join(", ");
console.log(`${built.name}: ${built.constraints} constraints, domain 2^${built.k}; prebuilt snarkjs.min.js from a <script> tag`);
for (const mode of modes) {
  const r = results[mode];
  const calls = r.stats ? `  GPU calls: G1 ${r.stats.g1.gpu}, G2 ${r.stats.g2.gpu}, FFT ${r.stats.fft.gpu}; CPU calls: ${r.stats.g1.cpu + r.stats.g2.cpu + r.stats.fft.cpu}` : "";
  console.log(`  ${mode.padEnd(9)} ${fmt(r)}   verified: ${r.proofs.every((x) => x.ok)}${calls}`);
  failed ||= !r.proofs.every((x) => x.ok);
}
for (const mode of modes.filter((m) => ["explicit", "auto", "late"].includes(m))) {
  const s = results[mode].stats;
  failed ||= !s || s.g1.gpu === 0 || s.g2.gpu === 0 || s.fft.gpu === 0 || s.g1.cpu + s.g2.cpu + s.fft.cpu > 4; // a few small calls stay on the CPU by design
  console.log(`  ${mode}: warm speed-up over snarkjs alone: ${results.cpu ? (results.cpu.proofs[1].ms / results[mode].proofs[1].ms).toFixed(1) + "x" : "n/a (no cpu run)"}`);
}
const none = results.nowebgpu?.stats;
if (results.nowebgpu) failed ||= !none || none.g1.gpu + none.g2.gpu + none.fft.gpu !== 0 || none.g1.cpu === 0; // no GPU used, but the proofs (checked above) still verify
console.log(`  nowebgpu: the GPU was never used and the proofs still verified: ${!failed || false}`);
console.log(failed ? "FAILED" : "PASSED");
process.exit(failed ? 1 : 0);

