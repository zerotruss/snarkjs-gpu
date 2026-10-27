// Builds the Rust addon and copies it to node/zk_gpu_node.node (the name Node loads).
//   node scripts/build-addon.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("cargo", ["build", "--release", "--package", "zk-gpu-node"], { cwd: root, stdio: "inherit" });
const built = { darwin: "libzk_gpu_node.dylib", win32: "zk_gpu_node.dll" }[process.platform] ?? "libzk_gpu_node.so";
copyFileSync(join(root, "target/release", built), join(root, "node/zk_gpu_node.node"));
console.log("built node/zk_gpu_node.node");
