// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChangeCount, usePresence } from "./strip-motion.js";

afterEach(() => { vi.useRealTimers(); });

const states = (rows: { key: string; state: string; order: number }[]) => rows.map(({ key, state, order }) => `${key}:${state}${state === "arriving" ? order : ""}`);

it("counts changes after the first known value, so the first draw does not animate", () => {
  const { result, rerender } = renderHook(({ value }) => useChangeCount(value), { initialProps: { value: undefined as string | undefined } });
  rerender({ value: "pending" });
  expect(result.current).toBe(0);
  rerender({ value: "pending" });
  expect(result.current).toBe(0);
  rerender({ value: "failed" });
  expect(result.current).toBe(1);
});

it("draws the first rows as they are, lets later ones arrive in order, and keeps a gone one folding away at its place", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHook(({ items, scope }) => usePresence(items, (item) => item, scope, 180), { initialProps: { items: ["a", "b"], scope: "t1" } });
  expect(states(result.current)).toEqual(["a:settled", "b:settled"]);
  rerender({ items: ["a", "b", "c", "d"], scope: "t1" });
  expect(states(result.current)).toEqual(["a:settled", "b:settled", "c:arriving0", "d:arriving1"]);
  rerender({ items: ["b", "c", "d"], scope: "t1" });
  expect(states(result.current)).toEqual(["a:leaving", "b:settled", "c:arriving0", "d:arriving1"]);
  act(() => { vi.advanceTimersByTime(180); });
  expect(states(result.current)).toEqual(["b:settled", "c:arriving0", "d:arriving1"]);
});

it("starts over on another thread: its rows are simply there and nothing of the last one folds away", () => {
  const { result, rerender } = renderHook(({ items, scope }) => usePresence(items, (item) => item, scope, 180), { initialProps: { items: ["a"], scope: "t1" } });
  rerender({ items: ["x", "y"], scope: "t2" });
  expect(states(result.current)).toEqual(["x:settled", "y:settled"]);
});

it("takes a row back that returns while folding away, without arriving again", () => {
  const { result, rerender } = renderHook(({ items }) => usePresence(items, (item) => item, "t1", 180), { initialProps: { items: ["a", "b"] } });
  rerender({ items: ["a"] });
  rerender({ items: ["a", "b"] });
  expect(states(result.current)).toEqual(["a:settled", "b:settled"]);
});
