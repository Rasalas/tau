import { describe, expect, it } from "vitest";
import {
  messageIdToRawIndexProjection,
  mergeProjectedRawIndexes,
  projectRawIndexesByMessageId,
} from "./transcript-indexes.js";

describe("transcript raw-index projection", () => {
  it("projects raw indexes by stable message identity", () => {
    const messages = [{ id: "a" }, { id: "b" }];
    const projection = messageIdToRawIndexProjection(messages, [40, 41]);
    expect(projectRawIndexesByMessageId([{ id: "b" }, { id: "a" }], projection)).toEqual([41, 40]);
  });

  it("merges newer indexes while rejecting incomplete projections", () => {
    expect(mergeProjectedRawIndexes(
      [{ id: "a" }, { id: "b" }], [10, 11],
      [{ id: "a" }, { id: "c" }], [12, 13],
      [{ id: "c" }, { id: "a" }, { id: "b" }],
    )).toEqual([13, 12, 11]);
    expect(projectRawIndexesByMessageId([{ id: "missing" }], new Map([["a", 1]]))).toBeUndefined();
  });
});
