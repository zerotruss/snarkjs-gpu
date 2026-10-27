// Bundles the browser test page. snarkjs is taken from its source (not its prebuilt browser file,
// which carries a private copy of ffjavascript) so that snarkjs and the GPU adapter share one
// ffjavascript curve object.
import { build } from "esbuild";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const nodeOnly = /^(fs|path|readline|constants|os|crypto|url|util|stream|events|assert|child_process|worker_threads|http|https|zlib|tty|net|module)$/;

export default async function bundle() {
  await build({
    entryPoints: [join(here, "entry.mjs")],
    outfile: join(here, "dist/entry.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    alias: { snarkjs: join(root, "node_modules/snarkjs/main.js") },
    define: { global: "globalThis", "process.browser": "true" },
    plugins: [{
      name: "node-only-stubs",
      setup(b) {
        b.onResolve({ filter: nodeOnly }, () => ({ path: join(here, "stub.mjs") }));
      },
    }],
    logLevel: "error",
  });
  console.log("bundled browser/dist/entry.js");
}

/** Standalone files for a page that loads snarkjs from a CDN: one script tag, no bundler. */
export async function bundleForCdn() {
  const common = { entryPoints: [join(root, "src/browser.mjs")], bundle: true, platform: "browser", logLevel: "error" };
  // A classic script has no import.meta: use the address of its own <script> element (valid while it runs).
  // (esbuild only accepts a name or a literal as a define value, so the address is read in a banner line.)
  await build({
    ...common,
    format: "iife",
    globalName: "GpuZk",
    define: { "import.meta.url": "__snarkjsGpuScript" },
    banner: { js: 'var __snarkjsGpuScript=(document.currentScript&&document.currentScript.src)||"";' },
    outfile: join(root, "dist/snarkjs-gpu.iife.js"),
    minify: true,
  });
  await build({ ...common, format: "esm", outfile: join(root, "dist/snarkjs-gpu.esm.js"), minify: true });
  copyFileSync(join(root, "web/pkg/zk_gpu_web_bg.wasm"), join(root, "dist/zk_gpu_web_bg.wasm"));
  console.log("bundled dist/snarkjs-gpu.{iife,esm}.js and copied dist/zk_gpu_web_bg.wasm");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundle();
  await bundleForCdn();
}
