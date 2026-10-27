// Builds everything needed to prove one circuit: compile, trusted setup (local and INSECURE,
// for testing only), proving key, verification key and a witness.
//
//   node scripts/prepare.mjs chain 16384      # a chain of 16384 squarings
//   node scripts/prepare.mjs merkle 20        # a Merkle proof of depth 20
//
// Output goes to build/<name>/ and is reused if it already exists.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snarkjs = join(root, "node_modules/.bin/snarkjs");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd.split("/").pop()} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
}

export async function prepare(kind, param) {
  const name = `${kind}_${param}`;
  const dir = join(root, "build", name);
  mkdirSync(dir, { recursive: true });
  const main = join(dir, `${name}.circom`);
  const component = kind === "chain" ? `Chain(${param})` : `Merkle(${param})`;
  writeFileSync(main, `pragma circom 2.0.0;\ninclude "../../circuits/${kind}.circom";\ncomponent main = ${component};\n`);

  const r1cs = join(dir, `${name}.r1cs`);
  const wasm = join(dir, `${name}_js/${name}.wasm`);
  if (!existsSync(r1cs)) run("circom", [main, "--r1cs", "--wasm", "-o", dir]);

  // The setup needs 2^k >= number of constraints (+ public inputs, rounded up).
  const header = execFileSync(snarkjs, ["r1cs", "info", r1cs], { cwd: root }).toString();
  const constraints = Number(/# of Constraints: (\d+)/.exec(header)[1]);
  const k = Math.max(8, Math.ceil(Math.log2(constraints + 8)));
  console.log(`${name}: ${constraints} constraints -> domain 2^${k}`);

  const ptauDir = join(root, "build/ptau");
  mkdirSync(ptauDir, { recursive: true });
  const ptau = join(ptauDir, `pot${k}.ptau`);
  if (!existsSync(ptau)) {
    const raw = join(ptauDir, `pot${k}_0.ptau`);
    const one = join(ptauDir, `pot${k}_1.ptau`);
    run(snarkjs, ["powersoftau", "new", "bn128", String(k), raw]);
    run(snarkjs, ["powersoftau", "contribute", raw, one, "--name=test", "-e=zk-gpu test entropy"]);
    run(snarkjs, ["powersoftau", "prepare", "phase2", one, ptau]);
  }

  const zkey = join(dir, `${name}.zkey`);
  if (!existsSync(zkey)) {
    const z0 = join(dir, `${name}_0.zkey`);
    run(snarkjs, ["groth16", "setup", r1cs, ptau, z0]);
    run(snarkjs, ["zkey", "contribute", z0, zkey, "--name=test", "-e=zk-gpu test entropy"]);
    run(snarkjs, ["zkey", "export", "verificationkey", zkey, join(dir, "vkey.json")]);
  }

  // Inputs and witness.
  const input = kind === "chain" ? { x: "3" } : merkleInput(param);
  writeFileSync(join(dir, "input.json"), JSON.stringify(input));
  const wtns = join(dir, "witness.wtns");
  if (!existsSync(wtns)) {
    run(snarkjs, ["wtns", "calculate", wasm, join(dir, "input.json"), wtns]);
  }
  return { name, dir, zkey, wtns, vkey: join(dir, "vkey.json"), constraints, k };
}

// A Merkle path with arbitrary sibling values (the circuit computes the root, so any path is valid).
function merkleInput(depth) {
  const pathElements = [], pathIndices = [];
  for (let i = 0; i < depth; i++) {
    pathElements.push(String(1000 + i));
    pathIndices.push(String(i % 2));
  }
  return { leaf: "12345", pathElements, pathIndices };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [kind, param] = process.argv.slice(2);
  if (!["chain", "merkle"].includes(kind) || !param) {
    console.error("usage: node scripts/prepare.mjs chain|merkle <size>");
    process.exit(2);
  }
  console.log(JSON.stringify(await prepare(kind, Number(param)), null, 2));
}
