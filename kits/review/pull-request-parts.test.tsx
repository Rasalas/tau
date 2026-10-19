// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CheckIcon } from "./pull-request-parts.js";

afterEach(cleanup);

const drawn = (status: Parameters<typeof CheckIcon>[0]["status"]) => render(<CheckIcon status={status} />).container.querySelector("svg")!.getAttribute("class") ?? "";

describe("CheckIcon", () => {
  it("draws a skipped check with a slash, apart from a neutral one", () => {
    expect(drawn("skipped")).toContain("lucide-circle-slash");
    expect(drawn("neutral")).toContain("lucide-circle-dashed");
  });
});
