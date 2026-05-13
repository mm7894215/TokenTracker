const cp = require("node:child_process");

function hasProxyEnv(env = process.env) {
  return Boolean(
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy,
  );
}

function parseMacProxyOutput(output) {
  const values = {};
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  if (values.HTTPSEnable !== "1" || !values.HTTPSProxy || !values.HTTPSPort) return null;
  return `http://${values.HTTPSProxy}:${values.HTTPSPort}`;
}

function resolveSystemProxyEnv({ env = process.env, platform = process.platform, commandRunner = cp.spawnSync } = {}) {
  const out = {};
  if (hasProxyEnv(env)) {
    out.NODE_USE_ENV_PROXY = env.NODE_USE_ENV_PROXY || "1";
    return out;
  }

  if (platform !== "darwin") return null;
  const result = commandRunner("scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result?.error || result?.status !== 0) return null;
  const proxyUrl = parseMacProxyOutput(result.stdout);
  if (!proxyUrl) return null;

  return {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
  };
}

function shouldRelaunchForProxy(argv, env = process.env) {
  if (env.TOKENTRACKER_PROXY_ENV_APPLIED === "1") return false;
  const command = Array.isArray(argv) ? argv[0] : null;
  return !command || command === "serve";
}

function relaunchWithProxyEnvIfNeeded({
  argv,
  originalArgv,
  env = process.env,
  platform = process.platform,
  commandRunner = cp.spawnSync,
  nodePath = process.execPath,
} = {}) {
  if (!shouldRelaunchForProxy(argv, env)) return null;
  const proxyEnv = resolveSystemProxyEnv({ env, platform, commandRunner });
  if (!proxyEnv || proxyEnv.NODE_USE_ENV_PROXY === env.NODE_USE_ENV_PROXY) return null;

  const childEnv = {
    ...env,
    ...proxyEnv,
    TOKENTRACKER_PROXY_ENV_APPLIED: "1",
  };
  return commandRunner(nodePath, originalArgv, {
    stdio: "inherit",
    env: childEnv,
  });
}

function pickProxyUrl(env = process.env) {
  return (
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    null
  );
}

// Node's built-in NODE_USE_ENV_PROXY support only landed in v22.21 / v24.5.
// For older runtimes (including the v22.14 we historically embedded in the
// macOS app, and the v22.16 a community user hit on Discussion #68) the env
// var is silently ignored and fetch() bypasses the proxy. Setting an undici
// ProxyAgent dispatcher at startup gives us proxy support on every Node ≥ 18
// regardless of the env-proxy flag.
function applyUndiciProxyIfNeeded({
  env = process.env,
  setGlobalDispatcher,
  ProxyAgent,
} = {}) {
  const proxyUrl = pickProxyUrl(env);
  if (!proxyUrl) return null;

  let setter = setGlobalDispatcher;
  let Agent = ProxyAgent;
  if (!setter || !Agent) {
    try {
      // eslint-disable-next-line global-require
      const undici = require("undici");
      setter = setter || undici.setGlobalDispatcher;
      Agent = Agent || undici.ProxyAgent;
    } catch (_e) {
      return null;
    }
  }
  if (typeof setter !== "function" || typeof Agent !== "function") return null;

  try {
    setter(new Agent(proxyUrl));
    return proxyUrl;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  hasProxyEnv,
  parseMacProxyOutput,
  pickProxyUrl,
  resolveSystemProxyEnv,
  relaunchWithProxyEnvIfNeeded,
  applyUndiciProxyIfNeeded,
};
