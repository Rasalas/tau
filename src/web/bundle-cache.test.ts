import { describe, expect, it, vi } from "vitest";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import { withBundleStore, type BundleStore } from "./bundle-cache";

function memoryStore(): BundleStore & { map: Map<string, Pick<DesktopExtensionBundle, "code" | "styles">> } {
  const map = new Map<string, Pick<DesktopExtensionBundle, "code" | "styles">>();
  return {
    map,
    digests: async () => [...map.keys()],
    get: async (digest) => map.get(digest),
    put: async (digest, bundle) => { map.set(digest, { code: bundle.code, ...(bundle.styles === undefined ? {} : { styles: bundle.styles }) }); },
    keep: async (digests) => { for (const key of [...map.keys()]) if (!digests.includes(key)) map.delete(key); },
  };
}

const bundle = (id: string, code: string, hash: string): DesktopExtensionBundle => ({ id, path: `/${id}`, scope: "bundled", code, styles: `.${id}{}`, permissions: [], hash });

/** A host that leaves out the code of what the client holds, as the host's method does. */
function host(bundles: DesktopExtensionBundle[]) {
  const load = vi.fn(async (_cwd: string, _shared: Record<string, string[]>, only?: readonly string[], held?: readonly string[]): Promise<DesktopExtensionLoadResult> => ({
    errors: [], skipped: [],
    bundles: bundles.filter((item) => !only || only.includes(item.id)).map((item) => held?.includes(item.hash!) ? Object.assign({}, item, { code: "", styles: undefined, cached: true }) : item),
  }));
  return { client: { loadDesktopExtensions: load } as unknown as HostClient, load };
}

describe("the packages a client keeps", () => {
  it("names what it holds, fills in what the host left out and keeps only the current set", async () => {
    const store = memoryStore();
    const first = host([bundle("a.kit", "A1", "a1"), bundle("b.kit", "B1", "b1")]);
    await withBundleStore(first.client, store).loadDesktopExtensions("/w", {});
    await vi.waitFor(() => expect([...store.map.keys()].sort()).toEqual(["a1", "b1"]));

    // The next start: B changed, A did not.
    const next = host([bundle("a.kit", "A1", "a1"), bundle("b.kit", "B2", "b2")]);
    const result = await withBundleStore(next.client, store).loadDesktopExtensions("/w", {});
    expect(next.load.mock.calls[0]?.[3]).toEqual(["a1", "b1"]);
    expect(result.bundles.map((item) => [item.id, item.code, item.styles])).toEqual([["a.kit", "A1", ".a.kit{}"], ["b.kit", "B2", ".b.kit{}"]]);
    await vi.waitFor(() => expect([...store.map.keys()].sort()).toEqual(["a1", "b2"]));
  });

  it("asks again, whole, for a bundle the store lost", async () => {
    const store = memoryStore();
    const { client, load } = host([bundle("a.kit", "A1", "a1")]);
    const lying: BundleStore = { ...store, digests: async () => ["a1"] };
    const result = await withBundleStore(client, lying).loadDesktopExtensions("/w", {});
    expect(result.bundles.map((item) => item.code)).toEqual(["A1"]);
    expect(load.mock.calls[1]?.slice(2)).toEqual([["a.kit"], []]);
  });

  it("is the plain client without a store", () => {
    const { client } = host([]);
    expect(withBundleStore(client, undefined)).toBe(client);
  });
});
