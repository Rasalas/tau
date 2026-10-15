// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, SubmissionResult } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry, type DesktopExtensionContext, type WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";
import { PreferencesStore } from "../preferences";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
  activeTools: [], allTools: [], extensionCount: 0, supportsImageInput: false,
};

afterEach(cleanup);

function renderComposer(options: { streaming?: boolean; extend?: (context: DesktopExtensionContext) => void; preferences?: PreferencesStore; actions?: WorkbenchActions; onAbort?: () => void } = {}) {
  const registry = new ExtensionRegistry();
  if (options.extend) registry.activate({ id: "test.keys", name: "Keys", activate: options.extend });
  const onSubmit = vi.fn(async (): Promise<SubmissionResult> => ({ accepted: true }));
  const shot = { ...snapshot, isStreaming: options.streaming === true };
  render(
    <TestProviders preferences={options.preferences}>
      <WorkbenchShellContext.Provider value={{ registry, snapshot: shot, ...(options.actions ? { actions: options.actions } : {}) }}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={shot}
          draftStorageKey="session:session"
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={onSubmit}
          onAbort={options.onAbort ?? (() => {})}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
        />
      </WorkbenchShellContext.Provider>
    </TestProviders>,
  );
  return { onSubmit, textarea: screen.getByRole("textbox") as HTMLTextAreaElement };
}

describe("composer keys an extension and the preferences decide", () => {
  it.each([
    { isComposing: true },
    { keyCode: 229 },
  ])("leaves IME Enter to the input method (%j)", async (composition) => {
    const inlineKey = vi.fn(() => false);
    const { onSubmit, textarea } = renderComposer({
      extend: (context) => context.registerComposerInline({ id: "probe", keyDown: inlineKey }),
    });
    fireEvent.change(textarea, { target: { value: "日本語" } });
    expect(fireEvent.keyDown(textarea, { key: "Enter", ...composition })).toBe(true);
    expect(fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, ...composition })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(inlineKey).not.toHaveBeenCalled();
    expect(textarea.value).toBe("日本語");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("日本語", []);
  });

  it("offers a key to an inline contribution first and lets it replace the text", () => {
    const seen: string[] = [];
    const { textarea } = renderComposer({
      extend: (context) => context.registerComposerInline({
        id: "history",
        keyDown: (event, inline) => {
          seen.push(`${event.key}:${event.text}:${inline.scope}`);
          if (event.key !== "ArrowUp" || event.text) return false;
          inline.setText("an earlier prompt");
          return true;
        },
      }),
    });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("an earlier prompt");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(seen).toEqual(["ArrowUp::session:session", "ArrowUp:an earlier prompt:session:session"]);
  });

  it("sends with ⌘↵ and leaves ↵ to the newline when the preference says so", async () => {
    const preferences = new PreferencesStore();
    preferences.setSendShortcut("mod-enter");
    const { onSubmit, textarea } = renderComposer({ preferences });
    expect(screen.getByRole("button", { name: "Send" }).dataset.tooltip).toContain("Send ⌘↵ — ↵ newline");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it("steers with ↵ while a turn runs, and ⌘↵ opens the send menu on Queue", async () => {
    const { onSubmit, textarea } = renderComposer({ streaming: true });
    expect(textarea.placeholder).toBe("Steer, or queue a follow-up…");
    expect(screen.getByRole("button", { name: "Steer this turn" }).dataset.tooltip).toBe("Steer this turn ↵ — ⌘↵ queue or plan, ⌥↑ dequeues");
    fireEvent.change(textarea, { target: { value: "turn left" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2 as never]).toBe("steer");

    fireEvent.change(textarea, { target: { value: "and then the docs" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    const queue = await screen.findByRole("menuitem", { name: /Queue after this turn/u });
    await waitFor(() => expect(document.activeElement).toBe(queue));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(queue, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[2 as never]).toBe("followUp");
  });

  it("picks from the send menu with the arrows or a digit, and opens Plan for a time", async () => {
    const { onSubmit, textarea } = renderComposer({ streaming: true });
    fireEvent.change(textarea, { target: { value: "check the build tomorrow" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue or plan" }));
    const plan = await screen.findByRole("menuitem", { name: /Plan…/u });
    await waitFor(() => expect(document.activeElement).toBe(plan));
    fireEvent.keyDown(plan, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Steer this turn/u })));
    fireEvent.keyDown(document.activeElement!, { key: "3" });
    const sheet = await screen.findByRole("dialog", { name: "Plan message" });
    expect(within(sheet).getByText("check the build tomorrow")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("listbox", { name: "When" })));
    expect(within(sheet).getByRole("option", { name: /Tomorrow morning/u })).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("option", { name: /Tomorrow morning/u }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Plan" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    expect(onSubmit.mock.calls[0]?.[2 as never]).toEqual({ deliverAt: tomorrow.getTime() });
  });

  it("hands composer controls the workbench actions", () => {
    const actions = { notify: vi.fn() } as unknown as WorkbenchActions;
    renderComposer({
      actions,
      extend: (context) => context.registerComposerControl({
        id: "probe",
        shortcuts: ["probe.open"],
        Component: ({ actions: given }) => <button type="button" onClick={() => given?.notify("hi")}>probe</button>,
      }),
    });
    expect(screen.queryByRole("button", { name: "probe" })).toBeNull();
    const menu = screen.getByRole("button", { name: "More composer controls" });
    expect(menu.dataset.composerShortcut?.split(" ")).toContain("probe.open");
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole("button", { name: "probe" }));
    expect(actions.notify).toHaveBeenCalledWith("hi");
  });
});

describe("the composer's buttons while a turn runs", () => {
  it("keeps Plan and Stop before send, resting until there is a draft, and it steers", async () => {
    const onAbort = vi.fn();
    const { onSubmit, textarea } = renderComposer({ streaming: true, onAbort });
    expect((screen.getByRole("button", { name: "Steer this turn" }) as HTMLButtonElement).disabled).toBe(true);
    // Plan, then Stop, sit before send, never in its place.
    const buttons = [...document.querySelectorAll(".composer-toolbar > button")].map((button) => button.getAttribute("aria-label"));
    expect(buttons.slice(-3)).toEqual(["Queue or plan", "Stop the run", "Steer this turn"]);
    fireEvent.change(textarea, { target: { value: "and then the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer this turn" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2 as never]).toBe("steer");
    fireEvent.click(screen.getByRole("button", { name: "Stop the run" }));
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("queues from the button when a prompt hook makes queueing the default", async () => {
    const { onSubmit, textarea } = renderComposer({
      streaming: true,
      extend: (context) => context.registerPromptHook({ id: "queue", streamingDelivery: () => "followUp" }),
    });
    fireEvent.change(textarea, { target: { value: "turn left" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue after this turn" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[2 as never]).toBe("followUp");
    expect(screen.getByRole("button", { name: "Stop the run" })).toBeTruthy();
  });

  describe("on a touch screen", () => {
    const coarse = (query: string) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} });
    afterEach(() => {
      vi.unstubAllGlobals();
      document.body.removeAttribute("data-keyboard");
    });

    it("sends on ↵ from a hardware keyboard and breaks the line on ⇧↵", async () => {
      vi.stubGlobal("matchMedia", vi.fn(coarse));
      const { onSubmit, textarea } = renderComposer();
      expect(textarea.placeholder).toBe("Ask anything, or hand it work…");
      fireEvent.change(textarea, { target: { value: "hello" } });
      expect(fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(false);
      await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    });

    it("leaves ↵ to the newline while the on-screen keyboard is up", () => {
      vi.stubGlobal("matchMedia", vi.fn(coarse));
      const { onSubmit, textarea } = renderComposer();
      document.body.setAttribute("data-keyboard", "");
      fireEvent.change(textarea, { target: { value: "hello" } });
      expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
