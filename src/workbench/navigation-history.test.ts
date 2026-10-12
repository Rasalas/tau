import { describe, expect, it } from "vitest";
import { NavigationHistory } from "./navigation-history";

const at = (threadId: string, toolId?: string) => ({ threadId, ...(toolId ? { view: { id: "agents.subagent", params: { toolId } } } : {}) });

describe("NavigationHistory", () => {
  it("steps back and forward through threads and the views opened on them", () => {
    const history = new NavigationHistory();
    history.visit(at("a"));
    history.visit(at("a", "child"));
    history.visit(at("b"));
    expect(history.step(-1, at("b"))).toEqual(at("a", "child"));
    expect(history.step(-1, at("a", "child"))).toEqual(at("a"));
    expect(history.step(-1, at("a"))).toBeUndefined();
    expect(history.step(1, at("a"))).toEqual(at("a", "child"));
    expect(history.step(1, at("a", "child"))).toEqual(at("b"));
    expect(history.step(1, at("b"))).toBeUndefined();
  });

  it("records a visit once, and a new visit after going back drops what lay ahead", () => {
    const history = new NavigationHistory();
    history.visit(at("a"));
    history.visit(at("a"));
    history.visit(at("b"));
    history.step(-1, at("b"));
    history.visit(at("a"));
    history.visit(at("c"));
    expect(history.step(1, at("c"))).toBeUndefined();
    expect(history.step(-1, at("c"))).toEqual(at("a"));
    expect(history.step(-1, at("a"))).toBeUndefined();
  });

  it("goes back from a draft to the thread it was opened from", () => {
    const history = new NavigationHistory();
    history.visit(at("a"));
    history.visit(at("b"));
    expect(history.step(-1, undefined)).toEqual(at("b"));
  });

  it("steps past a thread that is gone", () => {
    const history = new NavigationHistory();
    history.visit(at("a"));
    history.visit(at("b"));
    history.visit(at("c"));
    const exists = (id: string) => id !== "b";
    expect(history.step(-1, at("c"), exists)).toEqual(at("a"));
    expect(history.step(-1, at("a"), exists)).toBeUndefined();
    expect(history.step(1, at("a"), exists)).toEqual(at("c"));
  });
});
