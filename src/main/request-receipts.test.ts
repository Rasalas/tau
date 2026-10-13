import { describe, expect, it, vi } from "vitest";
import { RequestReceipts } from "./request-receipts.js";

describe("request receipts", () => {
  it("answers a repeated id with the first result and runs it once", async () => {
    const receipts = new RequestReceipts<string>();
    const submit = vi.fn(async () => "first");
    expect(await Promise.all([receipts.run("t", "m1", submit), receipts.run("t", "m1", submit)])).toEqual(["first", "first"]);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("runs a retry again after the first attempt was refused", async () => {
    const receipts = new RequestReceipts<string>();
    await expect(receipts.run("t", "m1", async () => { throw new Error("busy"); })).rejects.toThrow("busy");
    await expect(receipts.run("t", "m1", async () => "second")).resolves.toBe("second");
  });

  it("keeps only the most recent receipts of a scope", async () => {
    const receipts = new RequestReceipts<number>();
    for (let index = 0; index < 300; index += 1) await receipts.run("t", `m${index}`, async () => index);
    const submit = vi.fn(async () => -1);
    expect(await receipts.run("t", "m0", submit)).toBe(-1);
    expect(await receipts.run("t", "m299", submit)).toBe(299);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
