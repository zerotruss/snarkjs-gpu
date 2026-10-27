// Builds the WebAssembly (web/pkg) with wasm-pack. The compiler normally writes the full path of every source
// file into the output (for panic messages), which would put the builder's home folder and user name into the
// published file. These flags replace those prefixes with fixed names, so the result does not depend on who
// built it or where.
//   node scripts/build-web.mjs
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
// The compiler uses the last matching rule, so the most general prefix comes first.
const remap = [
  [homedir(), "/home"],
  [cargoHome, "/cargo"],
  [root, "/snarkjs-gpu"],
].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);

// CARGO_ENCODED_RUSTFLAGS separates flags with a control character, so paths with spaces are safe.
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: remap.join("\x1f") };
delete env.RUSTFLAGS;
execFileSync("wasm-pack", ["build", "--target", "web", "--release", "--out-dir", "pkg"], {
  cwd: join(root, "web"),
  env,
  stdio: "inherit",
});
