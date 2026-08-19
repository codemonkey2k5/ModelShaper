import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "engine");
const dest = join(root, "src-tauri", "resources", "engine");

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}
mkdirSync(dest, { recursive: true });

// Ship only what the installer and worker need (not tests / venvs).
for (const name of ["modelcraft_engine", "pyproject.toml", "README.md", "scripts", "tools"]) {
  const from = join(src, name);
  if (!existsSync(from)) continue;
  cpSync(from, join(dest, name), { recursive: true });
}

writeFileSync(
  join(dest, "VERSION"),
  "0.1.0\n",
  "utf8",
);

console.log("Copied engine package to src-tauri/resources/engine");
