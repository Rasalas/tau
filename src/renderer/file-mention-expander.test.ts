import { describe, expect, it, vi } from "vitest";
import { AT_FILE_REGEX, expandFileMentions } from "./file-mention-expander.js";
import type { DocumentSourceContribution } from "./extension-system.js";

describe("AT_FILE_REGEX", () => {
  it("matches @file at start of line or preceded by whitespace", () => {
    const text = "@src/index.ts and @README.md but not user@example.com";
    const matches = [...text.matchAll(AT_FILE_REGEX)].map((m) => m[1]);
    expect(matches).toEqual(["src/index.ts", "README.md"]);
  });
});

describe("expandFileMentions", () => {
  it("returns text unchanged if no @ exists", async () => {
    const result = await expandFileMentions("hello world");
    expect(result.text).toBe("hello world");
    expect(result.attachments).toEqual([]);
  });

  it("returns text unchanged if documentSource is undefined", async () => {
    const result = await expandFileMentions("check @src/index.ts", undefined);
    expect(result.text).toBe("check @src/index.ts");
    expect(result.attachments).toEqual([]);
  });

  it("expands text file mentions into <file> blocks", async () => {
    const fakeDocSource: Partial<DocumentSourceContribution> = {
      loadFile: vi.fn(async (path: string) => {
        if (path === "src/index.ts") {
          return {
            path: "src/index.ts",
            name: "index.ts",
            size: 42,
            kind: "text" as const,
            text: "export const tau = 1;",
          };
        }
        throw new Error("File not found");
      }),
    };

    const result = await expandFileMentions("look at @src/index.ts please", fakeDocSource as DocumentSourceContribution);
    expect(result.text).toContain("look at @src/index.ts please");
    expect(result.text).toContain('<file name="src/index.ts">\nexport const tau = 1;\n</file>');
  });

  it("deduplicates identical file mentions", async () => {
    const fakeDocSource: Partial<DocumentSourceContribution> = {
      loadFile: vi.fn(async (path: string) => ({
        path,
        name: path,
        size: 10,
        kind: "text" as const,
        text: "content",
      })),
    };

    const result = await expandFileMentions("@file.txt and again @file.txt", fakeDocSource as DocumentSourceContribution);
    expect(result.text.match(/<file name="file.txt">/g)?.length).toBe(1);
  });

  it("ignores files that fail to load", async () => {
    const fakeDocSource: Partial<DocumentSourceContribution> = {
      loadFile: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    };

    const result = await expandFileMentions("look at @missing.ts", fakeDocSource as DocumentSourceContribution);
    expect(result.text).toBe("look at @missing.ts");
  });

  it("converts image file mentions into attachments", async () => {
    const fakeDocSource: Partial<DocumentSourceContribution> = {
      loadFile: vi.fn(async (path: string) => ({
        path,
        name: "logo.png",
        size: 100,
        kind: "image" as const,
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
      })),
    };

    const result = await expandFileMentions("see @assets/logo.png", fakeDocSource as DocumentSourceContribution);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      kind: "image",
      name: "logo.png",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUg==",
      size: 100,
    });
  });
});
