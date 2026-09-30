// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../../src/workbench/client-storage";
import { webClientEnvironment } from "../../../src/web/WebWorkbench";
import { HostBook, type SavedHost, type SecureStore } from "../hosts";
import type { NativeSocketEvent, SocketBridge } from "../native-socket";
import { Shell, type AppContext } from "../Shell";
import { AddHostScreen } from "./AddHostScreen";
import { HostsScreen, hostMeta } from "./HostsScreen";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const FP = "AB".repeat(32);
const host = (extra: Partial<SavedHost> = {}): SavedHost => ({
  id: "h-1", name: "Studio Mac", endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }], access: "full",
  addedAt: "2026-09-01T00:00:00.000Z", lastUsedAt: "2026-09-24T11:55:00.000Z", lastEndpoint: { url: "https://192.168.1.2:7788/", kind: "lan" }, ...extra,
});

describe("HostsScreen", () => {
  it("starts empty with the way in, and the floating Add host button", () => {
    const scanned: string[] = [];
    render(<HostsScreen rows={[]} nearby={{ state: "searching", hosts: [] }} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onScan={() => scanned.push("scan")} onAsk={() => {}} now={NOW} />);
    expect(screen.getByText("No hosts yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Scan a pairing code/u }));
    expect(scanned).toEqual(["scan"]);
    expect(screen.getByRole("button", { name: "Add host" }).className).toBe("shell-fab");
    expect(screen.getByRole("status").textContent).toMatch(/Looking for Tau hosts/u);
  });

  it("says how a host was reached and when, and that its access ended", () => {
    expect(hostMeta({ host: host(), signedOut: false, nearby: false }, NOW)).toBe("Local network · 192.168.1.2 · used 5 min ago");
    expect(hostMeta({ host: host({ access: "read-only" }), signedOut: false, nearby: true }, NOW)).toBe("On this network · read only · used 5 min ago");
    expect(hostMeta({ host: host(), signedOut: true, nearby: false }, NOW)).toMatch(/Access ended/u);
  });

  it("removes a host only after saying what stays on the host", () => {
    const removed: string[] = [];
    render(<HostsScreen rows={[{ host: host(), signedOut: false, nearby: false }]} nearby={{ state: "denied" }} onOpen={() => {}} onRemove={(entry) => removed.push(entry.id)} onAdd={() => {}} onScan={() => {}} onAsk={() => {}} now={NOW} />);
    expect(screen.getByText(/may not look for hosts/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Studio Mac" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove Studio Mac?" });
    expect(dialog.textContent).toMatch(/still lists this phone until you revoke it/u);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep" }));
    expect(removed).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Studio Mac" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    expect(removed).toEqual(["h-1"]);
  });

  it("lists hosts on the network that are not paired yet, to ask", () => {
    const asked: string[] = [];
    const nearby = { hostId: "h-2", name: "Laptop", fingerprint: FP, port: 7788, addresses: ["10.0.0.3"], endpoints: [{ url: "https://10.0.0.3:7788/" }] };
    render(<HostsScreen rows={[{ host: host(), signedOut: false, nearby: false }]} nearby={{ state: "searching", hosts: [nearby, { ...nearby, hostId: "h-1" }] }} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onScan={() => {}} onAsk={(found) => asked.push(found.hostId)} now={NOW} />);
    const list = screen.getByRole("list", { name: "Hosts on this network" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(list).getByRole("button", { name: "Ask Laptop to connect" }));
    expect(asked).toEqual(["h-2"]);
  });
});

describe("AddHostScreen", () => {
  it("says what is wrong with a pasted text and connects only with a pairing link", () => {
    const submitted: string[] = [];
    render(<AddHostScreen onBack={() => {}} onScan={() => {}} onSubmit={(payload) => submitted.push(payload.code)} />);
    const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com/" } });
    expect(screen.getByText(/not a pairing link/u)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `https://192.168.1.2:7788/#pair=abc&fp=${FP}&host=h-1` } });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(submitted).toEqual(["abc"]);
  });
});

/** A bridge whose every socket fails to connect, as a host out of reach does. */
function unreachableBridge(): SocketBridge {
  const listeners = new Map<string, (event: NativeSocketEvent) => void>();
  return {
    open: async ({ id }) => { queueMicrotask(() => listeners.get(id)?.({ id, type: "close", code: 1006 })); },
    send: async () => {},
    close: async () => {},
    subscribe: (id, listener) => { listeners.set(id, listener); return () => listeners.delete(id); },
  };
}

function context(extra: Partial<AppContext> = {}): AppContext {
  const data = new Map<string, string>();
  const store: SecureStore = { get: async (key) => data.get(key), set: async (key, value) => { data.set(key, value); }, remove: async (key) => { data.delete(key); } };
  return {
    storage: createMemoryStorage(),
    book: new HostBook(store),
    bridge: unreachableBridge(),
    device: { name: "iPhone", model: "iPhone", platform: "ios", virtual: false },
    environment: webClientEnvironment("compact"),
    scan: async () => ({ error: "no-camera" }),
    browse: () => () => {},
    navigate: () => {},
    subscribeToLinks: () => () => {},
    ...extra,
  };
}

describe("Shell", () => {
  it("keeps a pasted link and says why when the host does not answer", async () => {
    render(<Shell context={context()} initial={{ view: "add" }} />);
    const link = `https://192.168.1.2:7788/#pair=abc&fp=${FP}&host=h-1&name=Studio`;
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: link } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/did not answer on any of its addresses/u)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(link);
  });

  it("says a scan cannot happen without a camera and offers the link instead", async () => {
    render(<Shell context={context()} initial={{ view: "hosts", explicit: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Scan a pairing code/u }));
    expect(await screen.findByText(/no camera to scan with/u)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add host" })).toBeTruthy();
  });

  it("asks the owner again for a saved host whose access ended", async () => {
    const ctx = context();
    await ctx.book.save(host(), "token");
    await ctx.book.forgetToken("h-1");
    render(<Shell context={ctx} initial={{ view: "hosts", explicit: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Studio Mac" }));
    // Nothing answers here, so the attempt ends back on the list with the reason.
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/did not answer/u));
  });

  it("refuses a link to a host this phone never paired with", async () => {
    render(<Shell context={context()} initial={{ view: "workbench", hostId: "stranger" }} />);
    expect(await screen.findByText(/has not paired with/u)).toBeTruthy();
  });
});
