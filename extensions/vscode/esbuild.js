const esbuild = require("esbuild");
const isProd = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

const cfg = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !isProd,
  minify: isProd,
  logLevel: "info",
};

(async () => {
  if (isWatch) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  } else {
    await esbuild.build(cfg);
  }
})().catch((e) => { console.error(e); process.exit(1); });
