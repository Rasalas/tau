// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../../../src/workbench/client-storage";
import { webClientEnvironment } from "../../../src/web/WebWorkbench";
import type { NativeService } from "../discovery";
import { HostBook, type SavedHost, type SecureStore } from "../hosts";
import type { NativeSocketEvent, SocketBridge } from "../native-socket";
import { Shell, type AppContext } from "../Shell";
import { AddHostScreen } from "./AddHostScreen";
import { HostsScreen, hostMeta } from "./HostsScreen";
import { PairingScreen } from "./PairingScreen";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const FP = "AB".repeat(32);
const host = (extra: Partial<SavedHost> = {}): SavedHost => ({
  id: "h-1", name: "Studio Mac", endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }], access: "full",
  addedAt: "2026-09-01T00:00:00.000Z", lastUsedAt: "2026-09-24T11:55:00.000Z", lastEndpoint: { url: "https://192.168.1.2:7788/", kind: "lan" }, ...extra,
});

/** Everything a person can read or hear on a screen: its text and its labels. */
function spoken(root: HTMLElement): string {
  const labels = [...root.querySelectorAll("[aria-label], [title], [placeholder]")]
    .flatMap((element) => ["aria-label", "title", "placeholder"].map((name) => element.getAttribute(name) ?? ""));
  return [root.textContent ?? "", ...labels].join("\n");
}

describe("HostsScreen", () => {
  it("starts empty with the way in, and the floating Add machine button", () => {
    const scanned: string[] = [];
    render(<HostsScreen rows={[]} nearby={{ state: "searching", hosts: [] }} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onScan={() => scanned.push("scan")} onAsk={() => {}} now={NOW} />);
    expect(screen.getByRole("heading", { name: "Machines" })).toBeTruthy();
    expect(screen.getByText("No machines yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Scan a QR code/u }));
    expect(scanned).toEqual(["scan"]);
    expect(screen.getByRole("button", { name: "Add machine" }).className).toBe("shell-fab");
    expect(screen.getByRole("status").textContent).toMatch(/Looking for machines running Tau/u);
  });

  it("names no host, token or file path on any of its states", () => {
    const states = [{ state: "searching" as const, hosts: [] }, { state: "denied" as const }, { state: "failed" as const }, { state: "unavailable" as const }];
    for (const nearby of states) {
      const view = render(<HostsScreen rows={[{ host: host(), signedOut: false, nearby: false }, { host: host({ id: "h-2", name: "Old Mac" }), signedOut: true, nearby: false }]} nearby={nearby} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onDemo={() => {}} onScan={() => {}} onAsk={() => {}} onRetry={() => {}} now={NOW} />);
      fireEvent.click(screen.getByRole("button", { name: "Remove Studio Mac" }));
      expect(spoken(view.container)).not.toMatch(/\bhosts?\b|token|pairing code|~\/|\.tau/iu);
      view.unmount();
    }
    const empty = render(<HostsScreen rows={[]} nearby={{ state: "searching", hosts: [] }} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onScan={() => {}} onAsk={() => {}} now={NOW} />);
    expect(spoken(empty.container)).not.toMatch(/\bhosts?\b|token|pairing code|~\/|\.tau/iu);
  });

  it("says a failed look at the network in one sentence, never in the system's words, and can try again", () => {
    const retried: string[] = [];
    render(<HostsScreen rows={[]} nearby={{ state: "failed" }} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onScan={() => {}} onAsk={() => {}} onRetry={() => retried.push("retry")} now={NOW} />);
    expect(screen.getByRole("status").textContent).toBe("Tau could not look for machines on this network just now. Try again, or scan a QR code instead.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retried).toEqual(["retry"]);
  });

  it("says how a host was reached and when, and that its access ended", () => {
    expect(hostMeta({ host: host(), signedOut: false, nearby: false }, NOW)).toBe("Local network · 192.168.1.2 · used 5 min ago");
    expect(hostMeta({ host: host({ access: "read-only" }), signedOut: false, nearby: true }, NOW)).toBe("On this network · read only · used 5 min ago");
    expect(hostMeta({ host: host(), signedOut: true, nearby: false }, NOW)).toMatch(/Access ended/u);
  });

  it("removes a host only after saying what stays on the host", async () => {
    const removed: string[] = [];
    render(<HostsScreen rows={[{ host: host(), signedOut: false, nearby: false }]} nearby={{ state: "denied" }} onOpen={() => {}} onRemove={(entry) => removed.push(entry.id)} onAdd={() => {}} onScan={() => {}} onAsk={() => {}} now={NOW} />);
    expect(screen.getByText(/may not look for machines/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Studio Mac" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove Studio Mac?" });
    expect(dialog.textContent).toMatch(/still lists this phone until you unpair it there/u);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep" }));
    expect(removed).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Studio Mac" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    expect(removed).toEqual(["h-1"]);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("focuses Keep, traps Tab, and returns focus after Escape", () => {
    render(<HostsScreen rows={[{ host: host(), signedOut: false, nearby: false }]} nearby={{ state: "denied" }} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onScan={() => {}} onAsk={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Remove Studio Mac" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog");
    const keep = within(dialog).getByRole("button", { name: "Keep" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(keep, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(keep, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a failed removal open for retry and prevents duplicate removal", async () => {
    let fail!: (error: Error) => void;
    const remove = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; })).mockResolvedValue(undefined);
    render(<HostsScreen rows={[{ host: host(), signedOut: false, nearby: false }]} nearby={{ state: "denied" }} onOpen={() => {}} onRemove={remove} onAdd={() => {}} onScan={() => {}} onAsk={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Remove Studio Mac" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Removing…" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog").getAttribute("aria-busy")).toBe("true");
    await act(async () => fail(new Error("secure storage unavailable")));
    expect(screen.getByRole("alert").textContent).toContain("could not be removed");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(remove).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(trigger);
  });

  it("focuses Add machine after removal takes away the triggering row", async () => {
    function Harness() {
      const [rows, setRows] = useState([{ host: host(), signedOut: false, nearby: false }]);
      return <HostsScreen rows={rows} nearby={{ state: "denied" }} onOpen={() => {}} onRemove={() => setRows([])} onAdd={() => {}} onScan={() => {}} onAsk={() => {}} />;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Remove Studio Mac" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add machine" }));
  });

  it("offers remote starts only as an unchecked phone control, and can disable after system denial", () => {
    const choices: boolean[] = [];
    const props = { nearby: { state: "searching" as const, hosts: [] }, onOpen: () => {}, onRemove: () => {}, onAdd: () => {}, onScan: () => {}, onAsk: () => {}, onRemoteActivity: (_host: SavedHost, enabled: boolean) => choices.push(enabled) };
    const view = render(<HostsScreen {...props} rows={[{ host: host(), signedOut: false, nearby: false, remoteActivity: { available: true, enabled: false } }]} />);
    const checkbox = screen.getByRole("checkbox", { name: "Remote Live Activities for Studio Mac" }) as HTMLInputElement;
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(checkbox); expect(choices).toEqual([true]);
    view.rerender(<HostsScreen {...props} rows={[{ host: host(), signedOut: false, nearby: false, remoteActivity: { available: false, enabled: true } }]} />);
    fireEvent.click(screen.getByRole("checkbox")); expect(choices).toEqual([true, false]);
    view.rerender(<HostsScreen {...props} rows={[{ host: host(), signedOut: false, nearby: false }]} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("lists hosts on the network that are not paired yet, to ask", () => {
    const asked: string[] = [];
    const nearby = { hostId: "h-2", name: "Laptop", fingerprint: FP, port: 7788, addresses: ["10.0.0.3"], endpoints: [{ url: "https://10.0.0.3:7788/" }] };
    render(<HostsScreen rows={[{ host: host(), signedOut: false, nearby: false }]} nearby={{ state: "searching", hosts: [nearby, { ...nearby, hostId: "h-1" }] }} onOpen={() => {}} onRemove={() => {}} onAdd={() => {}} onScan={() => {}} onAsk={(found) => asked.push(found.hostId)} now={NOW} />);
    const list = screen.getByRole("list", { name: "Machines on this network" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(list).getByRole("button", { name: "Ask Laptop to connect" }));
    expect(asked).toEqual(["h-2"]);
  });
});

describe("AddHostScreen", () => {
  it("names no host, token or file path, and the problems tell what to do on the machine", () => {
    const view = render(<AddHostScreen onBack={() => {}} onScan={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole("heading", { name: "Add machine" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com/" } });
    expect(spoken(view.container)).not.toMatch(/\bhosts?\b|token|pairing code|~\/|\.tau/iu);
    expect(screen.getByText(/not a pairing link\. Copy the whole link from Settings → Connections on your machine/u)).toBeTruthy();
  });

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

describe("PairingScreen", () => {
  it("shows the digits to compare and names no host", () => {
    const view = render(<PairingScreen hostName="Studio Mac" verification="123456" address="Tailscale" onCancel={() => {}} />);
    expect(screen.getByRole("heading", { name: "Waiting for Studio Mac" })).toBeTruthy();
    expect(screen.getByLabelText("Code to compare").textContent).toBe("123 456");
    expect(spoken(view.container)).not.toMatch(/\bhosts?\b|token|pairing code/iu);
    view.rerender(<PairingScreen hostName="Studio Mac" onCancel={() => {}} />);
    expect(screen.getByText("Trying every way to reach it, best first.")).toBeTruthy();
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
    desktopKits: async () => [],
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
  it("shows a failed secure-store removal in the dialog and retries it", async () => {
    const ctx = context();
    await ctx.book.save(host(), "test-key");
    const remove = vi.spyOn(ctx.book, "remove").mockRejectedValueOnce(new Error("secure store unavailable"));
    render(<Shell context={ctx} initial={{ view: "hosts", explicit: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Studio Mac" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be removed");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(remove).toHaveBeenCalledTimes(2);
    expect(await ctx.book.list()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add machine" }));
  });

  it("keeps a pasted link and says why when the host does not answer", async () => {
    render(<Shell context={context()} initial={{ view: "add" }} />);
    const link = `https://192.168.1.2:7788/#pair=abc&fp=${FP}&host=h-1&name=Studio`;
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: link } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Your machine did not answer\./u)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(link);
  });

  it("says a scan cannot happen without a camera and offers the link instead", async () => {
    render(<Shell context={context()} initial={{ view: "hosts", explicit: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Scan a QR code/u }));
    expect(await screen.findByText(/no camera to scan with/u)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add machine" })).toBeTruthy();
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
    expect(await screen.findByText(/is for a machine this phone is not paired with/u)).toBeTruthy();
  });

  it("hides the system's words when looking for machines fails, and looks again on Try again", async () => {
    let looks = 0;
    let report: (services: NativeService[], error?: string) => void = () => {};
    const browse = (listener: typeof report) => { looks++; report = listener; return () => {}; };
    render(<Shell context={context({ browse })} initial={{ view: "hosts", explicit: true }} />);
    await screen.findByRole("heading", { name: "Machines" });
    await waitFor(() => expect(looks).toBe(1));
    act(() => report([], "The operation couldn’t be completed. (NWError error 0.)"));
    expect(await screen.findByText(/could not look for machines on this network just now/u)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/NWError|operation couldn/u);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(looks).toBe(2));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
