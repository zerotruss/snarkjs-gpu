// Proves a circuit in headless Chrome with snarkjs on the CPU and with the GPU (WebGPU), checks that
// both proofs verify, and prints the timings.
//
//   npm run build:web && node browser/run.mjs chain 16368
//   CHROME=/path/to/chrome node browser/run.mjs merkle 64
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { prepare } from "../scripts/prepare.mjs";
import { startServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [kind = "chain", param = "16368"] = process.argv.slice(2);
const chrome = process.env.CHROME ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!chrome) throw new Error("Chrome not found: set CHROME=/path/to/chrome");
if (!existsSync(join(root, "web/pkg/zk_gpu_web_bg.wasm"))) throw new Error("build the WebAssembly first: npm run build:web");

const built = await prepare(kind, Number(param));
await (await import("./build.mjs")).default();

const html = () => '<!doctype html><meta charset="utf-8"><title>zk-gpu</title><script type="module" src="/dist/entry.js"></script>';
const server = await startServer([["/dist/", join(here, "dist")], ["/pkg/", join(root, "web/pkg")], ["/data/", join(root, "build")]], html);
const origin = server.origin;

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: process.env.HEADED ? false : true,
  protocolTimeout: 600_000,
  // A kept profile lets Chrome reuse its compiled-shader cache between runs, as a real user's does.
  userDataDir: process.env.CHROME_PROFILE,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-first-run", "--disable-gpu-sandbox"],
});
let failed = true;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`console ${m.type()}:`, m.text()); });
  await page.goto(origin);
  await page.waitForFunction("window.ready === true", { timeout: 60_000 });
  const r = await page.evaluate((args) => window.runProof(args), {
    dir: built.name, name: built.name, auto: Boolean(process.env.AUTO), use: (process.env.SNARKJS_GPU_USE ?? "g1,g2,fft").split(","), minPoints: 1024, minFftPoints: 4096,
  });
  const ms = (list) => list.map((p) => `${p.ms.toFixed(0)} ms`).join(", ");
  console.log(`${built.name}: ${built.constraints} constraints, domain 2^${built.k}, WebGPU available: ${r.webgpu}`);
  if (r.cpu) console.log(`  CPU (snarkjs, web workers): ${ms(r.cpu)}   verified: ${r.cpu.every((p) => p.ok)}`);
  if (r.gpuStartMs !== undefined) console.log(`  GPU start-up:               ${r.gpuStartMs.toFixed(0)} ms`);
  console.log(`  GPU (WebGPU):               ${ms(r.gpu)}   verified: ${r.gpu.every((p) => p.ok)}`);
  console.log(`  GPU calls: ${JSON.stringify(r.stats)}`);
  for (const why of r.fallbacks) console.log(`  FALLBACK: ${why}`);
  if (r.cpu) console.log(`  warm speed-up: ${(r.cpu[1].ms / r.gpu[1].ms).toFixed(1)}x`);
  failed = !((r.cpu ?? []).every((p) => p.ok) && r.gpu.every((p) => p.ok) && r.stats.g1.gpu > 0 && r.fallbacks.length === 0);
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? "FAILED" : "PASSED");
process.exit(failed ? 1 : 0);
