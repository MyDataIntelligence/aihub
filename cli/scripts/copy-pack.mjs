// Copies the repository's skills/ and commands/ into cli/pack/ so they ship in the npm tarball.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const pack = join(cli, "pack");
rmSync(pack, { recursive: true, force: true });
mkdirSync(pack, { recursive: true });
for (const name of ["skills", "commands"]) {
  const src = join(cli, "..", name);
  if (!existsSync(src)) throw new Error(`${src} not found: build from a checkout of the aihub repository`);
  cpSync(src, join(pack, name), { recursive: true });
}