import type { CompletionRequest } from "tau/host-extension";
import type { CodexSessionInput, CodexSessionLike } from "./thread-backend.js";
import type { CodexPolicy } from "./app-server.js";

/** A disposable, unpersisted request through the selected Codex account. */
export async function completeCodex(
  openSession: (input: CodexSessionInput) => Promise<CodexSessionLike>,
  cwd: string,
  model: string,
  effort: string,
  request: CompletionRequest,
): Promise<string> {
  let threadId: string | undefined;
  const deltas = new Map<string, string>();
  const completed = new Map<string, string>();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const done = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  // Notifications may fail before startTurn resolves; attach a handler now.
  void done.catch(() => undefined);
  const session = await openSession({
    cwd, tools: [],
    onRequest: async () => { throw new Error("Model completions cannot use tools or ask for permissions."); },
    onExit: (error) => reject(error ?? new Error("Codex ended before completing the request.")),
    onNotification: (method, raw) => {
      if (!raw || typeof raw !== "object") return;
      const params = raw as { threadId?: string; itemId?: string; delta?: string; item?: { id?: string; type?: string; text?: string }; turn?: { status?: string; error?: { message?: string } } };
      if (!threadId || params.threadId !== threadId) return;
      if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
        const id = params.itemId ?? "answer";
        deltas.set(id, (deltas.get(id) ?? "") + params.delta);
      }
      if (method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") completed.set(params.item.id ?? "answer", params.item.text);
      if (method === "turn/completed") {
        if (params.turn?.status === "completed") resolve();
        else reject(new Error(params.turn?.error?.message || "Codex did not complete the request."));
      }
    },
  });
  const timer = setTimeout(() => reject(new Error("Codex model completion timed out.")), 25_000);
  const policy: CodexPolicy = { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
  try {
    void (async () => {
      const info = await session.startThread({ cwd, model, policy, ephemeral: true, baseInstructions: request.system });
      threadId = info.thread.id;
      await session.startTurn({ threadId, model, effort, policy, input: [{ type: "text", text: request.prompt, text_elements: [] }] });
    })().catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
    await done;
    return [...new Map([...deltas, ...completed]).values()].join("\n").trim();
  } finally { clearTimeout(timer); await session.close(); }
}
