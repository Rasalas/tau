// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiModel } from "../../shared/contracts";
import { ModelPicker } from "./ModelPicker";
import { TestProviders } from "../test-support/test-providers";

const models: UiModel[] = [
  { provider: "anthropic", id: "opus", name: "Opus", login: "subscription" },
  { provider: "anthropic", id: "haiku", name: "Haiku" },
];

afterEach(cleanup);

describe("ModelPicker subscription marks", () => {
  it("tags models behind a subscription login and explains the tag once per list", () => {
    render(<TestProviders><ModelPicker models={models} onSelect={() => {}} onClose={() => {}} /></TestProviders>);
    expect(screen.getAllByText("subscription login")).toHaveLength(1);
    expect(screen.getByText(/asks once before the first use/u)).toBeTruthy();
  });
});
