// @vitest-environment jsdom
import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchActions } from "./extension-system";
import { CommandPalette } from "./components/CommandPalette";
import { Menu } from "./components/Menu";
import { ModelPicker } from "./components/ModelPicker";
import { ProjectPicker } from "./components/ProjectPicker";
import { Dialog, Popover } from "./components/ui/Dialog";
import { runningTurn as running } from "./test-support/kit-harness";
import { TestProviders } from "./test-support/test-providers";

afterEach(cleanup);

/**
 * The chat column, with an overlay the button opens. A browser commits a state change made in a
 * key handler before the next listener runs (a microtask between listeners); a synthetic
 * `dispatchEvent` does not, so `flushSync` stands in for that.
 */
function Chat({ overlay }: { overlay(close: () => void): ReactNode }) {
  const [shown, setShown] = useState(false);
  return <>
    <nav aria-label="Threads"><button type="button">A thread</button></nav>
    <main data-keybinding-context="chat">
      <textarea aria-label="Composer" />
      <button type="button" onClick={() => setShown(true)}>Open</button>
      {shown ? overlay(() => flushSync(() => setShown(false))) : null}
    </main>
  </>;
}

const composer = () => screen.getByRole("textbox", { name: "Composer" });
const escape = (target: Element | null = document.activeElement) => fireEvent.keyDown(target ?? document.body, { key: "Escape" });

function open(overlay: (close: () => void) => ReactNode) {
  render(<TestProviders><Chat overlay={overlay} /></TestProviders>);
  composer().focus();
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
}

describe("Escape during a running turn", () => {
  it("stops the turn from the composer, and not from outside the chat", () => {
    const { abort } = running();
    render(<Chat overlay={() => null} />);
    screen.getByRole("button", { name: "A thread" }).focus();
    escape();
    expect(abort).not.toHaveBeenCalled();
    composer().focus();
    escape();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("closes the project picker and stops nothing", () => {
    const { abort } = running();
    open((close) => <ProjectPicker open projects={[{ path: "/p", name: "p", lastOpenedAt: 1 }]} onBrowse={() => {}} onClose={close} onRemove={() => {}} onSelect={() => {}} />);
    escape(screen.getByRole("textbox", { name: "Search projects" }));
    expect(screen.queryByRole("dialog", { name: "Search projects" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    escape(composer());
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("closes the command palette, which closes itself on its own keydown, and stops nothing", () => {
    const { abort, registry } = running();
    open((close) => <CommandPalette open commands={[]} extensionCount={0} actions={{} as WorkbenchActions} registry={registry} onClose={close} />);
    const palette = screen.getByRole("dialog");
    escape(palette.querySelector("input"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(abort).not.toHaveBeenCalled();
  });

  it("closes the model picker and stops nothing", () => {
    const { abort } = running();
    open((close) => <ModelPicker models={[{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }]} onSelect={() => {}} onClose={close} anchor={{ current: null }} />);
    escape(screen.getByRole("combobox", { name: "Search models" }));
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();
  });

  it("closes a menu whose trigger kept focus in the composer, and stops nothing", () => {
    const { abort } = running();
    open((close) => <Menu items={[{ id: "a", label: "Alpha" }]} label="Reasoning" onSelect={() => {}} onClose={close} />);
    composer().focus();
    escape(composer());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(abort).not.toHaveBeenCalled();
  });

  it("closes a popover (the turn-changes detail is one) and stops nothing", () => {
    const { abort } = running();
    function Anchored({ close }: { close(): void }) {
      const anchor = useRef<HTMLButtonElement>(null);
      return <><button ref={anchor} type="button">Turn changes</button><Popover anchor={anchor} label="Turn changes" onClose={close}><button type="button">a.txt</button></Popover></>;
    }
    open((close) => <Anchored close={close} />);
    escape(composer());
    expect(screen.queryByRole("dialog", { name: "Turn changes" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();
  });

  it("closes an overlay that handles Escape on its own field without consuming it", () => {
    const { abort } = running();
    // The shape of Workspace Kit's project switcher: a dialog whose input closes it on keydown.
    open((close) => <section role="dialog" aria-label="Switch project">
      <input aria-label="Search" autoFocus onKeyDown={(event) => { if (event.key === "Escape") close(); }} />
    </section>);
    escape(screen.getByRole("textbox", { name: "Search" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(abort).not.toHaveBeenCalled();
  });

  it("closes only the topmost overlay: a menu over a dialog", () => {
    const { abort } = running();
    function Nested({ close }: { close(): void }) {
      const [menu, setMenu] = useState(true);
      return <Dialog label="Settings" onClose={close}>
        <span className="menu-anchor">{menu ? <Menu items={[{ id: "a", label: "Alpha" }]} label="Sort" onSelect={() => {}} onClose={() => setMenu(false)} /> : null}</span>
      </Dialog>;
    }
    open((close) => <Nested close={close} />);
    escape();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    escape();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(abort).not.toHaveBeenCalled();
  });
});
