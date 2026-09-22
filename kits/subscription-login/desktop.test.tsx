// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerGateContext, UiModel } from "tau";
import { createKitHarness, createMemoryStorage, RendererServicesProvider, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import subscriptionLogin from "./desktop.js";

const opus: UiModel = { provider: "anthropic", id: "claude-opus", name: "Claude Opus", login: "subscription" };
const luna: UiModel = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", login: "subscription" };
const keyed: UiModel = { provider: "anthropic", id: "claude-opus", name: "Claude Opus" };

function activated() {
  const harness = createKitHarness();
  harness.registry.activate(subscriptionLogin);
  const [gate] = harness.registry.getComposerGates();
  const [badge] = harness.registry.getModelBadges();
  return { ...harness, gate, badge };
}

const ask = (model: UiModel): ComposerGateContext => ({ action: "model", model, runtime: "pi" });

beforeEach(() => setClientStorage(createMemoryStorage()));
afterEach(cleanup);

describe("Subscription Login Warning", () => {
  it("asks about an Anthropic subscription login, never about Luna or an API key", () => {
    const { gate } = activated();
    expect(gate.check(ask(opus))).toBe(true);
    expect(gate.check({ action: "prompt", model: opus, runtime: "pi" })).toBe(true);
    expect(gate.check(ask(luna))).toBe(false);
    expect(gate.check(ask(keyed))).toBe(false);
    expect(gate.check({ action: "prompt", runtime: "claude-code" })).toBe(false);
  });

  it("asks once per provider: using it anyway is remembered, picking another is not", () => {
    const { gate, preferences } = activated();
    const proceed = vi.fn();
    const cancel = vi.fn();
    const { unmount } = render(<RendererServicesProvider services={{ preferences }}>
      <gate.Component context={ask(opus)} proceed={proceed} cancel={cancel} />
    </RendererServicesProvider>);
    expect(screen.getByRole("dialog", { name: "Subscription login through Pi" }).textContent).toMatch(/without notice/u);
    fireEvent.click(screen.getByText("Pick another model"));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(gate.check(ask(opus))).toBe(true);
    fireEvent.click(screen.getByText("Use it anyway"));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(gate.check(ask(opus))).toBe(false);
    unmount();
  });

  it("badges the same models in the picker and explains the badge", () => {
    const { badge } = activated();
    expect(badge.applies(opus, "pi")).toBe(true);
    expect(badge.applies(luna, "pi")).toBe(false);
    expect(badge.tone).toBe("warning");
    expect(badge.note).toMatch(/asks once before the first use/u);
  });

  it("leaves no warning behind when switched off", () => {
    const { registry } = activated();
    expect(registry.getRegions("thread-title")).toHaveLength(1);
    registry.deactivate(subscriptionLogin.id);
    expect(registry.getComposerGates()).toEqual([]);
    expect(registry.getModelBadges()).toEqual([]);
    expect(registry.getRegions("thread-title")).toEqual([]);
  });
});
