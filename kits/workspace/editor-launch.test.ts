import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { launchEditor } from "./editors.js";

afterEach(() => { vi.unstubAllEnvs(); spawn.mockReset(); });
it.each(["code", "xdg-open", "explorer.exe"])("launches %s without Electron's host mode", async (command) => {
  vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
  vi.stubEnv("NODE_EXTRA_CA_CERTS", "/extra.pem");
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  spawn.mockImplementation(() => { queueMicrotask(() => child.emit("spawn")); return child; });
  await launchEditor(command, ["/project"], "/project");
  const options = spawn.mock.calls[0][2];
  expect(options.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
  expect(options.env.NODE_EXTRA_CA_CERTS).toBe("/extra.pem");
  expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
  expect(child.unref).toHaveBeenCalled();
});
