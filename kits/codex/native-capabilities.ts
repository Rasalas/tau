import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

/** Report only configured native tools whose installed launcher and helper can run. */
export async function codexNativeCapabilities(home: string): Promise<readonly string[]> {
  try {
    const config = await readFile(join(home, "config.toml"), "utf8");
    let plugin = false;
    let enabled = false;
    let features = false;
    let pluginsDisabled = false;
    let top = true;
    for (const raw of config.split(/\r?\n/u)) {
      const line = raw.replace(/\s+#.*$/u, "").trim();
      if (line.startsWith("[")) {
        top = false;
        plugin = /^\[\s*plugins\s*\.\s*["']computer-use@openai-bundled["']\s*\]$/u.test(line);
        features = /^\[\s*features\s*\]$/u.test(line);
      }
      else if (top && /^profile\s*=/u.test(line)) return [];
      else if (plugin && /^enabled\s*=/u.test(line)) enabled = /^enabled\s*=\s*true$/u.test(line);
      else if (features && /^plugins\s*=\s*false$/u.test(line)) pluginsDisabled = true;
    }
    if (!enabled || pluginsDisabled) return [];
    await access(join(home, "computer-use", "Codex Computer Use.app", "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient"), constants.X_OK);
    const cache = join(home, "plugins", "cache", "openai-bundled", "computer-use");
    for (const version of await readdir(cache)) {
      const root = join(cache, version);
      try {
        const manifest = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
        const server = manifest.mcpServers?.["computer-use"];
        if (server?.command !== "./bin/computer-use-client-launcher" || !Array.isArray(server.args) || !server.args.includes("mcp")) continue;
        await access(join(root, "bin", "computer-use-client-launcher"), constants.X_OK);
        return ["computer-use"];
      } catch { /* An incomplete plugin installation supplies no native tools. */ }
    }
  } catch { /* Missing or unreadable configuration supplies no evidence. */ }
  return [];
}
