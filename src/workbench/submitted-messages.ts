import type { OptimisticUserMessage } from "./app-state";
import type { ClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";

const KEY = STORAGE_KEYS.submittedMessages;

/** Unconfirmed sends belong to the transcript, independently of the next draft. */
export function readSubmittedMessages(storage: ClientStorage): OptimisticUserMessage[] {
  try {
    const rows: unknown = JSON.parse(storage.get(KEY) ?? "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is OptimisticUserMessage => row && typeof row.scope === "string"
      && (row.scope.startsWith("session:") || row.scope.startsWith("new:"))
      && row.message?.role === "user" && typeof row.message.id === "string"
      && typeof row.message.text === "string" && Number.isFinite(row.message.timestamp)
      && typeof row.message.clientTurnId === "string" && typeof row.message.clientMessageId === "string"
      && (row.draft === undefined || row.draft?.kind === "draft" && typeof row.draft.draftId === "string"
        && typeof row.draft.projectPath === "string" && typeof row.draft.projectName === "string")
      && typeof row.input?.text === "string" && typeof row.requestId === "string")
      .map((row) => row.message.submission?.state === "sent" ? row : Object.assign(row, {
        message: { ...row.message, submission: { state: "failed" as const, error: row.message.submission?.error ?? "Delivery was not confirmed before restart." } },
      }));
  } catch { return []; }
}

export function writeSubmittedMessages(storage: ClientStorage, rows: readonly OptimisticUserMessage[]): void {
  const captured = rows.filter((row) => row.input && row.requestId);
  try {
    if (captured.length) storage.set(KEY, JSON.stringify(captured));
    else storage.remove(KEY);
  } catch { /* The in-memory transcript still owns the captured messages. */ }
}
