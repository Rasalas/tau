/** Protected command-scope config, available before repository discovery. */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // Windows environment names are case-insensitive. Emit each config key once.
    env[/^GIT_CONFIG_/iu.test(key) ? key.toUpperCase() : key] = value;
  }
  const rawCount = env.GIT_CONFIG_COUNT || "0";
  const count = Number(rawCount);
  if (!/^\d+$/u.test(rawCount) || !Number.isSafeInteger(count) || count < 0) throw new Error("Invalid GIT_CONFIG_COUNT.");
  env[`GIT_CONFIG_KEY_${count}`] = "safe.bareRepository";
  env[`GIT_CONFIG_VALUE_${count}`] = "explicit";
  env.GIT_CONFIG_COUNT = String(count + 1);
  return env;
}
