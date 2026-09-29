import { describe, expect, it } from "vitest";
import { diagnosticLine, formatBuildDiagnostics } from "./build-diagnostics.js";

describe("build diagnostics", () => {
  it("names the file, line and column before the message", () => {
    expect(diagnosticLine({ file: "desktop.tsx", line: 1, column: 8, text: "Expected \";\" but found \"y\"" }))
      .toBe("desktop.tsx:1:8: Expected \";\" but found \"y\"");
    expect(diagnosticLine({ text: "No entry" })).toBe("No entry");
  });

  it("points a caret at the column under the source line, and counts what it leaves out", () => {
    const one = { file: "d.tsx", line: 1, column: 8, text: "boom", lineText: "const x y = 1;" };
    expect(formatBuildDiagnostics([one])).toBe("d.tsx:1:8: boom\n  const x y = 1;\n          ^");
    expect(formatBuildDiagnostics(Array.from({ length: 7 }, () => ({ text: "x" }))).split("\n").at(-1)).toBe("…and 2 more.");
  });
});
