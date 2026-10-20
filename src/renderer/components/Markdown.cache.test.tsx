// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const parsed = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock("./markdown-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdown-pipeline")>();
  return { ...actual, renderMarkdown: (...args: Parameters<typeof actual.renderMarkdown>) => {
    parsed.sources.push(args[0]);
    return actual.renderMarkdown(...args);
  } };
});

import { Markdown } from "./Markdown";

afterEach(cleanup);

describe("Markdown parse cache", () => {
  it("parses a settled message once when the virtual transcript mounts it again", () => {
    const text = "A **settled** answer with `src/cache.ts` and a [link](https://example.com).";
    const first = render(<Markdown>{text}</Markdown>);
    const html = first.container.innerHTML;
    first.unmount();
    const again = render(<Markdown>{text}</Markdown>);
    expect(again.container.innerHTML).toBe(html);
    expect(parsed.sources.filter((source) => source === text)).toHaveLength(1);
  });

  it("parses text again with a caller's own components", () => {
    const text = "Answer with *custom* emphasis.";
    const components = { em: ({ children }: { children?: ReactNode }) => <b>{children}</b> };
    render(<Markdown>{text}</Markdown>).unmount();
    const custom = render(<Markdown components={components}>{text}</Markdown>);
    expect(custom.container.querySelector("b")?.textContent).toBe("custom");
    expect(parsed.sources.filter((source) => source === text)).toHaveLength(2);
  });
});
