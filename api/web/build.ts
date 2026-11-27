/**
 * Builds the web console into dist/web: main.js and main.css (served by the API
 * at /assets/*) plus index.html (served for every other non-API GET path).
 * Run with `bun run build:web`.
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const webDir = import.meta.dir;
const outDir = join(webDir, "..", "dist", "web");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(webDir, "main.tsx")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "linked",
  naming: { entry: "[name].[ext]", asset: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await copyFile(join(webDir, "index.html"), join(outDir, "index.html"));

for (const o of result.outputs) {
  console.log(`${o.path.slice(outDir.length + 1).padEnd(16)} ${(o.size / 1024).toFixed(1)} KiB`);
}
