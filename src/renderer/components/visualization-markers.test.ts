import { describe, expect, it } from "vitest";
import { parseVisualizationReference, splitVisualizationMarkers } from "./visualization-markers";
import { visualizationRelativePath } from "./InlineVisualization";

const marker = 'visualize{"path":"/work/visuals/chart.html","mode":"wide"}';
describe("visualization references", () => {
  it("splits installed skill references while preserving surrounding prose", () => {
    expect(splitVisualizationMarkers(`Before\n${marker}\nAfter`)).toEqual([
      { type: "markdown", source: "Before\n" },
      { type: "visualization", reference: { path: "/work/visuals/chart.html", mode: "wide" } },
      { type: "markdown", source: "\nAfter" },
    ]);
  });
  it("leaves fenced, inline, escaped and indented literal examples alone", () => {
    for (const example of [`\`\`\`text\n${marker}\n\`\`\``, `\`${marker}\``, `\\${marker}`, `    ${marker}`, `- ${marker}`, `> ${marker}`]) {
      expect(splitVisualizationMarkers(example)).toEqual([{ type: "markdown", source: example }]);
    }
  });
  it("preserves malformed or unknown contracts", () => {
    expect(parseVisualizationReference('visualize{"path":7}')).toBeUndefined();
    expect(parseVisualizationReference('visualize{"path":"a.html","mode":"fullscreen"}')).toBeUndefined();
    expect(splitVisualizationMarkers(`Text ${marker}`)).toEqual([{ type: "markdown", source: `Text ${marker}` }]);
  });
  it("holds a streaming incomplete reference but preserves final literal text", () => {
    const partial = 'visualize{"path":"/work/a';
    expect(splitVisualizationMarkers(partial, true)).toEqual([{ type: "pending" }]);
    expect(splitVisualizationMarkers(partial)).toEqual([{ type: "markdown", source: partial }]);
    expect(splitVisualizationMarkers(`\`\`\`\n${partial}`, true)).toEqual([{ type: "markdown", source: `\`\`\`\n${partial}` }]);
  });
  it("resolves only in-workspace executor paths without host path traversal", () => {
    expect(visualizationRelativePath("/work/visuals/a.html", "/work")).toBe("visuals/a.html");
    expect(visualizationRelativePath("visuals/a.html")).toBe("visuals/a.html");
    for (const value of ["/work-other/a.html", "/etc/passwd", "/work/../secret.html", "../secret.html", "a\\b.html"]) expect(() => visualizationRelativePath(value, "/work")).toThrow();
  });
});
