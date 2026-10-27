// Writes a circuit's witness as raw 32-byte little-endian scalars (what the A/B/C MSMs use).
//   node scripts/dump_scalars.mjs merkle 256 build/merkle_256.scalars
import * as binFileUtils from "@iden3/binfileutils";
import { writeFileSync } from "node:fs";
import { prepare } from "./prepare.mjs";

const [kind, param, out] = process.argv.slice(2);
const built = await prepare(kind, Number(param));
const { fd, sections } = await binFileUtils.readBinFile(built.wtns, "wtns", 2, 1 << 25, 1 << 23);
const bytes = await binFileUtils.readSection(fd, sections, 2);
await fd.close();
writeFileSync(out, bytes);
console.log(`${bytes.byteLength / 32} scalars -> ${out}`);
process.exit(0);
