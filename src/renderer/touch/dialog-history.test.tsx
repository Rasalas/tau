// @vitest-environment jsdom
import { StrictMode, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TestThreadStore } from "../test-support/test-providers";
import { PanelSheet } from "./PanelSheet";
import { Dialog, Popover } from "../components/ui/Dialog";
import { Sheet } from "./Sheet";
import { TouchLayer } from "./TouchLayer";
import { phoneReaderFromState, routeFromState } from "../../workbench/phone-history";
import type { PhoneRoute } from "../../workbench/phone-route";

type LayerKind = "dialog" | "popover" | "panel";
function Fixture({ kind = "dialog" }: { kind?: LayerKind }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [host] = useState(() => document.createElement("div"));
  const [route, setRoute] = useState<PhoneRoute>({ kind: "threads" });
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  const [nested, setNested] = useState(false);
  return <>
    <TouchLayer syncUrl openThread={async () => true} phone={{ route, onRoute: setRoute }} />
    <output>{route.kind}</output>
    <button onClick={() => setRoute({ kind: "chat" })}>Open chat</button>
    <button onClick={() => setFirst(true)}>Open project choice</button>
    <button onClick={() => { setFirst(true); setNested(true); }}>Open both</button>
    <button onClick={() => setRoute({ kind: "settings" })}>Go to settings</button>
    {first ? <Sheet title="Choose project" presentation="page" onClose={() => { setFirst(false); setSecond(false); }}>
      {nested ? <Dialog label="Nested confirmation" onClose={() => setNested(false)}><p>Nested body</p></Dialog> : null}
      <button ref={anchor} onClick={() => setSecond(true)}>Open confirmation</button>
      <button onClick={() => { setFirst(false); setSecond(true); }}>Replace with confirmation</button>
      <button onClick={() => setFirst(false)}>Choose project</button>
    </Sheet> : null}
    {second ? kind === "popover" ? <Popover anchor={anchor} label="Confirmation" onClose={() => setSecond(false)}><button onClick={() => setSecond(false)}>Done</button></Popover>
      : kind === "panel" ? <PanelSheet label="Confirmation" host={host} onClose={() => setSecond(false)} />
      : <Dialog label="Confirmation" onClose={() => setSecond(false)}><button onClick={() => setSecond(false)}>Done</button></Dialog> : null}
  </>;
}
async function start(kind: LayerKind = "dialog") {
  window.history.replaceState(null, "", "/?profile=compact");
  render(<StrictMode><TestThreadStore threads={[]}><Fixture kind={kind} /></TestThreadStore></StrictMode>);
  await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
  fireEvent.click(screen.getByText("Open chat"));
  await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("chat"));
  fireEvent.click(screen.getByText("Open project choice"));
  await waitFor(() => expect(phoneReaderFromState(window.history.state)).toBeTruthy());
}
afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); window.history.replaceState(null, "", "/"); });

describe("compact dialog history", () => {
  it.each(["dialog", "popover", "panel"] as const)("Back closes a nested %s before its hosting dialog and chat", async (kind) => {
    await start(kind);
    fireEvent.click(screen.getByText("Open confirmation"));
    await waitFor(() => expect(phoneReaderFromState(window.history.state)?.depth).toBe(2));
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirmation" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Choose project" })).toBeTruthy();
    expect(routeFromState(window.history.state)?.kind).toBe("chat");
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)?.kind).toBe("chat");
    act(() => window.history.back());
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
  });
  it("simultaneously mounted parent and child each receive a back step", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByText("Open both"));
    await waitFor(() => expect(phoneReaderFromState(window.history.state)?.depth).toBe(2));
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nested confirmation" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Choose project" })).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)?.kind).toBe("chat");
  });
  it("closing a nested dialog with its own button consumes only its entry", async () => {
    await start();
    fireEvent.click(screen.getByText("Open confirmation"));
    await waitFor(() => expect(phoneReaderFromState(window.history.state)?.depth).toBe(2));
    fireEvent.click(screen.getByText("Done"));
    await waitFor(() => expect(phoneReaderFromState(window.history.state)?.depth).toBeUndefined());
    expect(phoneReaderFromState(window.history.state)).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)?.kind).toBe("chat");
  });
  it("replacing one dialog with another retains a single back step", async () => {
    await start();
    fireEvent.click(screen.getByText("Replace with confirmation"));
    await screen.findByRole("dialog", { name: "Confirmation" });
    await act(async () => { await Promise.resolve(); });
    expect(phoneReaderFromState(window.history.state)?.depth).toBeUndefined();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)?.kind).toBe("chat");
    act(() => window.history.back());
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
  });
  it("selection consumes the dialog entry, so the next Back leaves the chat", async () => {
    await start();
    fireEvent.click(screen.getByText("Choose project", { selector: "button" }));
    await waitFor(() => expect(phoneReaderFromState(window.history.state)).toBeUndefined());
    act(() => window.history.back());
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
  });
  it("changing routes consumes all nested entries and closes their dialogs", async () => {
    await start();
    fireEvent.click(screen.getByText("Open confirmation"));
    await waitFor(() => expect(phoneReaderFromState(window.history.state)?.depth).toBe(2));
    fireEvent.click(screen.getByText("Go to settings"));
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("settings"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => window.history.back());
    await waitFor(() => expect(routeFromState(window.history.state)?.kind).toBe("threads"));
  });
});
