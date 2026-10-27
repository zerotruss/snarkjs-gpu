// Node entry point: loads the native addon (node/zk_gpu_node.node, built by `npm run build`).
import { createRequire } from "node:module";
import { installGpu as install } from "./core.mjs";

export function loadAddon() {
  try {
    return createRequire(import.meta.url)("../node/zk_gpu_node.node");
  } catch (error) {
    throw new Error(`cannot load the GPU addon (run: npm run build): ${error.message}`);
  }
}

/** Same as the core `installGpu`, with the native addon as the default `addon`. */
export function installGpu(curve, options = {}) {
  return install(curve, { addon: loadAddon(), ...options });
}
