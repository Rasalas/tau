export const RECORDING_MAX_BYTES = 500 * 1024 * 1024;
export const RECORDING_DRAIN_BYTES = 16 * 1024 * 1024;

interface RecordingSink {
  file: { write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> };
  bytes: number;
}

/** Every producer, including final encoder output, shares the same file budget. */
export async function writeRecordingChunks(recording: RecordingSink, chunks: readonly string[]): Promise<void> {
  for (const chunk of chunks) {
    const bytes = Buffer.from(chunk, "base64");
    if (recording.bytes + bytes.length > RECORDING_MAX_BYTES) throw new Error("Recording exceeds the 500 MB size limit.");
    let offset = 0;
    while (offset < bytes.length) {
      // oxlint-disable-next-line no-await-in-loop -- advance the same file and buffer in order
      const { bytesWritten } = await recording.file.write(bytes, offset, bytes.length - offset);
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) throw new Error("The recording file could not be written.");
      offset += bytesWritten;
      recording.bytes += bytesWritten;
    }
  }
}
