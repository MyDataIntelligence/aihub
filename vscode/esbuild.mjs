import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

// The panel uses codicons; ship the font and css from resources/ so the webview needs no network.
mkdirSync("resources", { recursive: true });
for (const f of ["codicon.css", "codicon.ttf"]) copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `resources/${f}`);

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
});
