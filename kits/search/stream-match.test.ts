import { describe, expect, it } from "vitest";
import { piTextRecords, TEXT_CHUNK } from "./pi-text-stream.js";
import { RecordMatcher } from "./stream-match.js";
import { findInThread, queryTokens, sessionLineText } from "./threads.js";

async function search(line: string, query: string, chunkSize: number) {
  async function* chunks() { for (let at = 0; at < line.length; at += chunkSize) yield line.slice(at, at + chunkSize); }
  const matcher = new RecordMatcher(queryTokens(query));
  let largest = 0;
  for await (const record of piTextRecords(chunks())) {
    if (record.kind === "text") largest = Math.max(largest, record.text.length);
    matcher.add(record);
  }
  expect(largest).toBeLessThanOrEqual(TEXT_CHUNK);
  return matcher.result();
}
const line = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("streamed message matching", () => {
  it.each([1, 7, 100, 16_384, 65_536])("keeps relevance and source snippets at chunk size %s", async (size) => {
    const text = `oauth ${"x".repeat(34_000)} refreshAuthToken ${"y".repeat(34_000)} auth tokens`;
    const expected = findInThread([{ role: "assistant", text }], queryTokens("auth tokens"), "auth tokens");
    expect(await search(line(text), "auth tokens", size)).toMatchObject({ role: "assistant", quality: expected!.quality, snippet: expect.stringContaining("auth tokens") });
  });

  it.each([1, 3, 101, 16_384])("handles escaped Unicode, astral case, expanded lowercase and sigma at size %s", async (size) => {
    const text = `${" ".repeat(16_380)}İİ 𐐀 alpha\n\tquoted "\\" ΣΟΣ ${"x".repeat(20_000)} marker`;
    const raw = line(text).replaceAll("Σ", "\\u03a3").replaceAll("İ", "\\u0130");
    expect(await search(raw, "𐐨 ALPHA", size)).toMatchObject({ quality: 31, snippet: expect.stringContaining("𐐀 alpha") });
    expect(await search(raw, "σοσ", size)).toMatchObject({ snippet: expect.stringContaining("ΣΟΣ") });
    expect(await search(raw, "marker", size)).toMatchObject({ snippet: expect.stringContaining("marker") });
  });

  it("uses the same visible text as the ordinary Pi reader, independent of key order", async () => {
    const raw = JSON.stringify({ message: { content: [{ text: "first escaped\nline", type: "text" }, { thinking: "secret", type: "thinking" }, { text: "last", type: "text" }], role: "user" }, type: "message" });
    const parsed = sessionLineText(raw)!;
    for (const query of ["first last", "escaped", "secret", "absent"]) {
      const expected = findInThread([parsed], queryTokens(query), queryTokens(query).join(" "));
      const found = await search(raw, query, 3);
      expect(found?.quality).toBe(expected?.quality);
      expect(found?.role).toBe(expected?.role);
    }
  });

  it.each([
    '{"type":"message","message":{"role":"user","content":"invented"},"type":"other"}',
    '{"type":"message","message":{"role":"user","content":"invented"}} trailing',
    '{"type":"message","message":{"role":"user","content":"invented"},}',
    '{"type":"message","message":{"role":"user","content":"invented"},"number":01}',
  ])("discards the entire invalid line: %s", async (raw) => {
    expect(await search(raw, "invented", 7)).toBeUndefined();
  });
});
