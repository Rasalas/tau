import { describe, expect, it } from "vitest";
import { buildVisualizationDocument, VISUALIZATION_CSP } from "./inline-visualization.js";

describe("isolated visualization wrapper", () => {
  it("runs fragments in an opaque sandbox with no network, file, form or child-frame permissions", () => {
    expect(VISUALIZATION_CSP).toContain("sandbox allow-scripts;");
    expect(VISUALIZATION_CSP).not.toContain("allow-same-origin");
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(VISUALIZATION_CSP).toContain(directive);
    expect(VISUALIZATION_CSP).not.toMatch(/https:|file:|tau-ext:|unsafe-eval/u);
  });
  it("provides local state and offline icons before the fragment executes", () => {
    const source = buildVisualizationDocument('<div id="mock">Example</div><script>window.openai.setWidgetState({tab:1})</script>', "dark");
    expect(source).toContain('data-theme="dark"');
    expect(source.indexOf("window.openai =")).toBeLessThan(source.indexOf('id="mock"'));
    expect(source).toContain("window.lucide");
    expect(source).not.toContain("sendFollowUpMessage");
    expect(source).not.toContain("window.Tweak");
  });
});
