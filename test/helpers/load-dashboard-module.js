const path = require("node:path");
const fs = require("node:fs");
const { build } = require("esbuild");

const repoRoot = path.join(__dirname, "..", "..");

async function loadDashboardModule(relativePath) {
  const entryPoint = path.join(repoRoot, relativePath);
  const requireShim = `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(entryPoint)});`;
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "node",
    sourcemap: "inline",
    write: false,
    banner: { js: requireShim },
    plugins: [
      {
        name: "raw-query-loader",
        setup(build) {
          build.onResolve({ filter: /\?raw$/ }, (args) => ({
            path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
            namespace: "raw-file",
          }));
          build.onLoad({ filter: /.*/, namespace: "raw-file" }, async (args) => ({
            contents: `export default ${JSON.stringify(await fs.promises.readFile(args.path, "utf8"))};`,
            loader: "js",
          }));
        },
      },
    ],
  });

  const source = result.outputFiles[0]?.text ?? "";
  const base64 = Buffer.from(source, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${base64}`);
}

module.exports = { loadDashboardModule };
