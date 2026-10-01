import { describe, expect, it, vi } from "vitest";
import { HostBook } from "./hosts";
import { PushKeys } from "./push-keys";
import { remoteActivities } from "./activity-start";
import type { SavedHost } from "./hosts";
const host: SavedHost = { id: "host", name: "Mac", publicKey: "AB".repeat(32), endpoints: [{ url: "https://192.168.1.2:8787", kind: "lan" }], access: "full", addedAt: "2026-09-30T12:00:00Z" };
async function setup(paired = true) {
  const memory = new Map<string, string>();
  const store = { get: async (key: string) => memory.get(key), set: async (key: string, value: string) => { memory.set(key, value); }, remove: async (key: string) => { memory.delete(key); } };
  const book = new HostBook(store); if (paired) await book.save(host, "tauc.phone.secret");
  const keys = new PushKeys(store);
  const native = { status: vi.fn(async () => ({ available: true, enabled: false })), configure: vi.fn(async (_value: unknown) => undefined), disable: vi.fn(async (_host: string) => undefined) };
  return { memory, book, keys, native, remote: remoteActivities(book, keys, native, false) };
}
describe("phone consent for remote Live Activities", () => {
  it("never enables starts just because a host connected", async () => {
    const { remote, native } = await setup();
    await remote.connect(host);
    expect(native.configure).not.toHaveBeenCalled();
  });
  it("passes consent and a pinned route only after the person enables the host", async () => {
    const { remote, native } = await setup();
    await remote.setEnabled(host, true);
    expect(native.configure).toHaveBeenCalledWith(expect.objectContaining({ hostId: "host", token: "tauc.phone.secret", enabled: true, candidates: [expect.objectContaining({ trust: "pin", publicKey: host.publicKey, url: "wss://192.168.1.2:8787/" })] }));
    native.status.mockResolvedValue({ available: true, enabled: true });
    await remote.connect(host);
    expect(native.configure.mock.calls[1]![0]).not.toHaveProperty("enabled");
  });
  it("requires a paired host and never manufactures opt-in after revocation", async () => {
    const { remote, native } = await setup(false);
    await expect(remote.setEnabled(host, true)).rejects.toThrow(/Pair/u);
    expect(native.disable).toHaveBeenCalledWith("host");
    expect(native.configure).not.toHaveBeenCalled();
  });
  it("disables native starts before forgetting the host's activity key", async () => {
    const { remote, keys, native } = await setup();
    const old = await keys.forHost(host.id);
    native.disable.mockImplementation(async () => { expect(await keys.key(old.keyId)).toBe(old.key); });
    await remote.setEnabled(host, false);
    expect(native.disable).toHaveBeenCalledWith("host");
    expect(await keys.key(old.keyId)).toBeUndefined();
  });
});

it("cannot re-enable a revoked host from an already pending key lookup", async () => {
  const { remote, native, keys } = await setup();
  let finish!: (value: { keyId: string; key: string }) => void;
  const lookup = vi.spyOn(keys, "forHost").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const enable = remote.setEnabled(host, true);
  await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
  const revoke = remote.revoke(host.id);
  finish({ keyId: "k".repeat(22), key: "k".repeat(43) });
  await Promise.all([enable, revoke]);
  expect(native.configure).not.toHaveBeenCalled();
  expect(native.disable).toHaveBeenCalledWith(host.id);
});
