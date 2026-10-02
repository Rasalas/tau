import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { HostConnect, createConnectMethods } from "./host-connect.js";
import { NO_JOB_CONTEXT } from "./host-jobs.js";
import { decodeConnectOffer } from "../shared/managed-connections.js";

const cleanup: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), "tau-host-connect-")); cleanup.push(path); return path; };
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { force: true, recursive: true }); });
const secret = () => randomBytes(32).toString("base64url");
const config = { id: randomUUID(), hostToken: secret(), clientToken: secret() };
const input = { relay: "https://relay.example", enrollmentToken: secret() };
const listener = () => ({ port: 7788, publicKey: "AA:".repeat(31) + "AA", fingerprint: "BB:".repeat(31) + "BB", close: vi.fn(async () => undefined) });
const stubTunnel = (_route: unknown, _port: number, publish: (phase: "connected") => void) => ({ start: () => publish("connected"), close: vi.fn() });

it("persists only route credentials with restricted permissions and emits pinned transient pairing offers", async () => {
  const userData = dir(); const local = listener();
  const service = new HostConnect({ userData, host: { id: "host", name: "Machine" }, listen: async () => local, createLink: () => ({ code: "transient-code" }), fetch: vi.fn(async () => new Response(JSON.stringify(config), { status: 201 })), tunnel: stubTunnel });
  expect(await service.configure(input)).toMatchObject({ phase: "connected", id: config.id });
  const persisted = readFileSync(join(userData, "connect.json"), "utf8");
  expect(persisted).not.toContain(input.enrollmentToken); expect(persisted).toContain(config.hostToken);
  if (process.platform !== "win32") expect(statSync(join(userData, "connect.json")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(service.status())).not.toContain(config.hostToken);
  expect(decodeConnectOffer(service.link())).toMatchObject({ relay: input.relay, id: config.id, token: config.clientToken });
  await service.close(); expect(local.close).toHaveBeenCalledTimes(1);
});

it("serializes disconnect behind a pending registration and removes its persisted and remote route", async () => {
  let finish!: (value: Response) => void;
  const registration = new Promise<Response>((resolve) => { finish = resolve; }); const requests: string[] = [];
  const userData = dir(); const local = listener();
  const service = new HostConnect({ userData, host: { id: "host", name: "Machine" }, listen: async () => local, createLink: () => ({ code: "x" }), fetch: vi.fn(async (_url, init) => { requests.push(init?.method ?? "GET"); return init?.method === "POST" ? registration : new Response(null, { status: 204 }); }), tunnel: stubTunnel });
  const configuring = service.configure(input); const removing = service.remove();
  finish(new Response(JSON.stringify(config), { status: 201 }));
  await configuring; expect(await removing).toMatchObject({ phase: "disabled" });
  expect(requests).toEqual(["POST", "DELETE"]); expect(existsSync(join(userData, "connect.json"))).toBe(false); expect(local.close).toHaveBeenCalledTimes(1);
  await service.close();
});

it("revokes an in-flight registration when the host shuts down and never opens its listener afterward", async () => {
  let finish!: (value: Response) => void;
  const registration = new Promise<Response>((resolve) => { finish = resolve; }); const listen = vi.fn(async () => listener());
  const requested = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST" ? registration : new Response(null, { status: 204 }));
  const userData = dir(); const service = new HostConnect({ userData, host: { id: "host", name: "Machine" }, listen, createLink: () => ({ code: "x" }), fetch: requested, tunnel: stubTunnel });
  const configuring = service.configure(input);
  await Promise.resolve();
  const rejected = expect(configuring).rejects.toThrow(/stopped/u);
  const closing = service.close(); finish(new Response(JSON.stringify(config), { status: 201 }));
  await rejected; await closing;
  expect(listen).not.toHaveBeenCalled(); expect(requested.mock.calls.at(-1)?.[1]?.method).toBe("DELETE"); expect(existsSync(join(userData, "connect.json"))).toBe(false);
});

it("reports the exact orphaned route if setup fails and relay revocation is unavailable", async () => {
  const userData = join(dir(), "not-a-directory"); writeFileSync(userData, "file");
  const service = new HostConnect({ userData, host: { id: "host", name: "Machine" }, listen: async () => listener(), createLink: () => ({ code: "x" }), fetch: vi.fn(async (_url, init) => init?.method === "POST" ? new Response(JSON.stringify(config), { status: 201 }) : new Response(null, { status: 503 })), tunnel: stubTunnel });
  await expect(service.configure(input)).rejects.toThrow(config.id); await service.close();
});

it("keeps registration and pairing management from a paired remote device", async () => {
  const methods = createConnectMethods(() => undefined);
  await expect(methods["connect-configure"]!([input], { ...NO_JOB_CONTEXT, principal: { kind: "workbench-client", pairedClient: "device", local: true } })).rejects.toThrow();
});
