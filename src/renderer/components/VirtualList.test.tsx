// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LARGE_MODEL_FIXTURE } from "../performance-fixtures";
import { VirtualList } from "./VirtualList";

describe("VirtualList", () => {
  it("mounts a bounded window for a 10,000-entry picker fixture", () => {
    const { container } = render(<VirtualList
      items={LARGE_MODEL_FIXTURE}
      itemHeight={40}
      className="fixture-list"
      renderItem={(model) => <button data-row key={model.id}>{model.name}</button>}
    />);
    expect(container.querySelectorAll("[data-row]").length).toBeLessThan(40);
    expect(container.querySelectorAll("[data-row]").length).toBeGreaterThan(0);
  });

  it("keeps item selection interactive inside the window", () => {
    let selected = "";
    const { container } = render(<VirtualList
      items={LARGE_MODEL_FIXTURE}
      itemHeight={40}
      renderItem={(model) => <button data-row key={model.id} onClick={() => { selected = model.id; }}>{model.name}</button>}
    />);
    const first = container.querySelector<HTMLButtonElement>("[data-row]");
    if (!first) throw new Error("fixture row was not rendered");
    fireEvent.click(first);
    expect(selected).toBe("model-0");
  });
});
