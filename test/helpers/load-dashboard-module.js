const path = require("node:path");
const { build } = require("esbuild");

const repoRoot = path.join(__dirname, "..", "..");
const rawTextLoaderPlugin = {
  name: "raw-text-loader",
  setup(buildApi) {
    buildApi.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
      namespace: "raw-text",
    }));
    buildApi.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => {
      const fs = require("node:fs/promises");
      const contents = await fs.readFile(args.path, "utf8");
      return {
        contents: `export default ${JSON.stringify(contents)};`,
        loader: "js",
      };
    });
  },
};

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
    plugins: [rawTextLoaderPlugin],
  });

  const source = result.outputFiles[0]?.text ?? "";
  const base64 = Buffer.from(source, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${base64}`);
}

module.exports = { loadDashboardModule };
