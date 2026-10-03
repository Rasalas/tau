import { afterEach, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexNativeCapabilities } from "./native-capabilities.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

it("requires an enabled native plugin, its MCP launcher, and the executable helper", async () => {
  const home = await mkdtemp(join(tmpdir(), "tau-native-codex-"));
  homes.push(home);
  expect(await codexNativeCapabilities(home)).toEqual([]);
  const config = join(home, "config.toml");
  await writeFile(config, '[plugins."computer-use@openai-bundled"]\nenabled = true\n');
  expect(await codexNativeCapabilities(home)).toEqual([]);
  const plugin = join(home, "plugins", "cache", "openai-bundled", "computer-use", "1.0");
  const launcher = join(plugin, "bin", "computer-use-client-launcher");
  const helper = join(home, "computer-use", "Codex Computer Use.app", "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient");
  for (const file of [launcher, helper]) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o700);
  }
  await writeFile(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { "computer-use": { command: "./bin/computer-use-client-launcher", args: ["mcp"] } } }));
  expect(await codexNativeCapabilities(home)).toEqual(["computer-use"]);
  await writeFile(config, 'profile = "custom"\n[plugins."computer-use@openai-bundled"]\nenabled = true\n');
  expect(await codexNativeCapabilities(home)).toEqual([]);
  await writeFile(config, '[plugins."computer-use@openai-bundled"]\nenabled = true\n[features]\nplugins = false\n');
  expect(await codexNativeCapabilities(home)).toEqual([]);
  await writeFile(config, '[plugins."computer-use@openai-bundled"]\nenabled = true\n');
  await chmod(helper, 0o600);
  expect(await codexNativeCapabilities(home)).toEqual([]);
  await chmod(helper, 0o700);
  await writeFile(config, '[plugins."computer-use@openai-bundled"]\nenabled = false\n');
  expect(await codexNativeCapabilities(home)).toEqual([]);
});
