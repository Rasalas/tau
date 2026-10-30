import { afterEach, describe, expect, it, vi } from "vitest";
import { searchPaletteMenus, type MenuHit } from "./palette-menu-search";
import type { PaletteCommand } from "./palette-results";
import type { PaletteItem, PaletteMenu, PaletteSearchContext } from "./extension-system";
const command = (id: string, submenu: PaletteMenu): PaletteCommand => ({ id, label: submenu.title, group: "Test", extensionId: "test", extensionName: "Test", access: "read", run: vi.fn(), submenu });
const context = (signal = new AbortController().signal) => ({ signal, actions: {}, index: { projects: [], threads: [] } }) as unknown as PaletteSearchContext;
afterEach(() => vi.useRealTimers());

describe("opt-in menu search", () => {
  it("reads opted-in menus with the query, limits hits and never runs actions", async () => {
    const run = vi.fn();
    const items = vi.fn((_query: string, _context: PaletteSearchContext) => Array.from({ length: 12 }, (_, index) => ({ id: String(index), label: `Dark ${index}`, run, current: index === 0, access: "read" as const })));
    const hidden = vi.fn(() => []);
    const publish = vi.fn<(hits: readonly MenuHit[]) => void>();
    const dispose = searchPaletteMenus([command("theme", { title: "Change theme", searchable: true, items }), command("hidden", { title: "Private", items: hidden })], "dark", context(), publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(items.mock.calls[0]?.[0]).toBe("dark");
    expect(publish.mock.lastCall?.[0]).toHaveLength(3);
    expect(publish.mock.lastCall?.[0][0]?.item).toMatchObject({ label: "Change theme: Dark 0", current: true });
    expect(hidden).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); dispose();
  });
  it("does not enumerate children when only their menu name matches", async () => {
    const items = vi.fn(() => []);
    searchPaletteMenus([command("model", { title: "Set model", searchable: true, items })], "set mod", context(), vi.fn());
    await Promise.resolve();
    expect(items).not.toHaveBeenCalled();
  });
  it("drops reads after the deadline and aborts their shared signal on cancellation", async () => {
    vi.useFakeTimers();
    let finish!: (rows: { id: string; label: string }[]) => void;
    let signal!: AbortSignal;
    const menu: PaletteMenu = { title: "Model", searchable: true, items: (_query, ctx) => { signal = ctx.signal; return new Promise<readonly PaletteItem[]>((resolve) => { finish = resolve; }); } };
    const publish = vi.fn();
    const dispose = searchPaletteMenus([command("model", menu)], "sonnet", context(), publish);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1500);
    expect(signal.aborted).toBe(false);
    finish([{ id: "a", label: "Sonnet" }]); await Promise.resolve();
    expect(publish).not.toHaveBeenCalled(); dispose(); expect(signal.aborted).toBe(true);
  });
  it("caps total rows and aborts every outstanding menu when the query changes", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const roots = Array.from({ length: 5 }, (_, n) => command(String(n), { title: `Menu ${n}`, searchable: true, items: (_q, ctx) => {
      signals.push(ctx.signal); return Array.from({ length: 4 }, (_unused, i) => ({ id: String(i), label: `Dark ${i}` }));
    } }));
    const publish = vi.fn();
    const dispose = searchPaletteMenus(roots, "dark", context(controller.signal), publish);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(5));
    expect(publish.mock.lastCall?.[0]).toHaveLength(8);
    expect(new Set(signals).size).toBe(1);
    controller.abort(); expect(signals.every((signal) => signal.aborted)).toBe(true); dispose();
  });
});
