import { expect, it, vi } from "vitest";
import { RECORDING_MAX_BYTES, writeRecordingChunks } from "./recording-data.js";

it("writes ordered chunks and retries partial file writes", async () => {
  const written: Buffer[] = [];
  const file = { write: vi.fn(async (buffer: Uint8Array, offset: number, length: number) => {
    const bytesWritten = Math.min(2, length);
    written.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
    return { bytesWritten };
  }) };
  const sink = { file, bytes: 0 };
  await writeRecordingChunks(sink, [Buffer.from("first").toString("base64"), Buffer.from("last").toString("base64")]);
  expect(Buffer.concat(written).toString()).toBe("firstlast");
  expect(sink.bytes).toBe(9);
});

it("rejects a chunk before writing past the shared cumulative cap", async () => {
  const file = { write: vi.fn(async (_buffer: Uint8Array, _offset: number, length: number) => ({ bytesWritten: length })) };
  const sink = { file, bytes: RECORDING_MAX_BYTES - 3 };
  await writeRecordingChunks(sink, [Buffer.from("ok").toString("base64")]);
  await expect(writeRecordingChunks(sink, [Buffer.from("no").toString("base64")])).rejects.toThrow("500 MB");
  expect(file.write).toHaveBeenCalledTimes(1);
  expect(sink.bytes).toBe(RECORDING_MAX_BYTES - 1);
});

it("rejects a stalled writer without counting unwritten bytes", async () => {
  const sink = { file: { write: async () => ({ bytesWritten: 0 }) }, bytes: 0 };
  await expect(writeRecordingChunks(sink, [Buffer.from("data").toString("base64")])).rejects.toThrow("could not be written");
  expect(sink.bytes).toBe(0);
});
