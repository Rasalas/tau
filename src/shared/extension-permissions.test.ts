import { describe, expect, it } from "vitest";
import { capabilityQuestions } from "./extension-permissions.js";

const worker = { isolation: "worker", desktop: false } as const;

describe("capabilityQuestions", () => {
  it("asks one plain question per requested permission, in a fixed order", () => {
    expect(capabilityQuestions("Copy Branch", { ...worker, permissions: ["network", "process", "workspace:write"] })).toEqual([
      "May Copy Branch change the files in your projects?",
      "May Copy Branch start programs on this machine?",
      "May Copy Branch reach the internet?",
    ]);
  });

  it("asks nothing for a package that requests nothing and draws nothing in the window", () => {
    expect(capabilityQuestions("Quiet", { ...worker, permissions: [] })).toEqual([]);
  });

  it("names a window half honestly", () => {
    expect(capabilityQuestions("Button", { ...worker, desktop: true, permissions: [] })).toEqual(["May Button do anything in Tau's window that you can?"]);
  });

  it("asks the one honest question for a package in Tau's process, since no permission holds there", () => {
    expect(capabilityQuestions("Deep", { isolation: "in-process", desktop: false, permissions: ["network", "process"] })).toEqual([
      "May Deep run inside Tau's own process, where nothing limits what it reads, writes, reaches or starts?",
    ]);
  });

  it("asks only about what is new after an earlier yes", () => {
    const previous = { permissions: ["process"], isolation: "worker" } as const;
    expect(capabilityQuestions("Copy Branch", { ...worker, desktop: true, permissions: ["process", "network"], previous })).toEqual(["May Copy Branch reach the internet?"]);
    expect(capabilityQuestions("Copy Branch", { isolation: "in-process", desktop: true, permissions: ["process"], previous })).toHaveLength(1);
    expect(capabilityQuestions("Copy Branch", { ...worker, permissions: ["process"], previous })).toEqual([]);
  });
});
