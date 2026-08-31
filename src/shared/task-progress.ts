import type { UiTask, UiTaskProgress, UiTaskProgressEntry } from "./contracts.js";

interface TodoMessage {
  role?: string;
  toolName?: string;
  details?: unknown;
  tauEntryId?: string;
  timestamp?: number;
  content?: unknown;
}

interface TodoDetails {
  action?: string;
  params?: { id?: unknown };
  tasks?: unknown;
  nextId?: unknown;
  error?: unknown;
}

function task(value: unknown): UiTask | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "number" || typeof item.subject !== "string") return undefined;
  if (!["pending", "in_progress", "completed"].includes(String(item.status))) return undefined;
  return {
    id: item.id,
    subject: item.subject,
    status: item.status as UiTask["status"],
    ...(typeof item.activeForm === "string" ? { activeForm: item.activeForm } : {}),
    ...(Array.isArray(item.blockedBy) ? { blockedBy: item.blockedBy.filter((id): id is number => typeof id === "number") } : {}),
  };
}

function todoDetails(message: TodoMessage): { details: TodoDetails; tasks: UiTask[] } | undefined {
  if (message.role !== "toolResult" || message.toolName !== "todo" || !message.details || typeof message.details !== "object") return undefined;
  const details = message.details as TodoDetails;
  if (details.error || !Array.isArray(details.tasks)) return undefined;
  return { details, tasks: details.tasks.map(task).filter((item): item is UiTask => Boolean(item)) };
}

function progress(tasks: UiTask[]): UiTaskProgress | undefined {
  if (tasks.length === 0) return undefined;
  return {
    tasks,
    completed: tasks.filter((item) => item.status === "completed").length,
    total: tasks.length,
  };
}

interface TaskScan {
  current?: UiTaskProgress;
  history: UiTaskProgressEntry[];
}

function hasVisibleText(message: TodoMessage): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return Array.isArray(message.content) && message.content.some((block) =>
    Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
      && (block as { text: string }).text.trim()),
  );
}

function scan(messages: readonly unknown[]): TaskScan {
  let latestTasks: UiTask[] = [];
  let anchorMessageId: string | undefined;
  let lastVisibleMessageId: string | undefined;
  let turnKey = "root";
  const touched = new Set<number>();
  const history: UiTaskProgressEntry[] = [];

  const finishTurn = () => {
    const snapshot = progress(latestTasks.filter((item) => touched.has(item.id)));
    if (snapshot) {
      const previous = history.at(-1);
      const continuesPrevious = previous?.progress.tasks.some((item) => touched.has(item.id));
      if (previous && continuesPrevious) {
        const ids = new Set([...previous.progress.tasks.map((item) => item.id), ...touched]);
        previous.progress = progress(latestTasks.filter((item) => ids.has(item.id))) ?? previous.progress;
      } else {
        history.push({ id: `tasks-${turnKey}`, anchorMessageId, progress: snapshot });
      }
    }
    touched.clear();
  };

  messages.forEach((raw, index) => {
    const message = raw as TodoMessage | undefined;
    if (!message) return;
    if (message.role === "user") {
      finishTurn();
      lastVisibleMessageId = message.tauEntryId ?? `user-${message.timestamp ?? index}-${index}`;
      anchorMessageId = undefined;
      turnKey = lastVisibleMessageId;
      return;
    }
    if (message.role === "assistant" && hasVisibleText(message) && message.tauEntryId) lastVisibleMessageId = message.tauEntryId;
    const snapshot = todoDetails(message);
    if (!snapshot) return;
    latestTasks = snapshot.tasks;
    const { details } = snapshot;
    if (typeof details.params?.id === "number") touched.add(details.params.id);
    if (details.action === "create" && typeof details.nextId === "number") touched.add(details.nextId - 1);
    if (touched.size > 0 && !anchorMessageId) anchorMessageId = lastVisibleMessageId;
    if (details.action === "clear") touched.clear();
  });

  const current = progress(latestTasks.filter((item) =>
    item.status === "pending" || item.status === "in_progress" || touched.has(item.id),
  ));
  finishTurn();
  return { current, history };
}

/** Current rpiv-todo overlay state, scoped to active and current-turn tasks. */
export function taskProgressFromMessages(messages: readonly unknown[]): UiTaskProgress | undefined {
  return scan(messages).current;
}

/** Immutable per-turn task cards anchored into the persisted transcript. */
export function taskProgressHistoryFromMessages(messages: readonly unknown[]): UiTaskProgressEntry[] {
  return scan(messages).history;
}

/** Keep remote history outside the bounded message window, but prefer locally reconstructed recent anchors. */
export function mergeTaskProgressHistory(
  remote: readonly UiTaskProgressEntry[] | undefined,
  recent: readonly UiTaskProgressEntry[],
): UiTaskProgressEntry[] {
  const recentIds = new Set(recent.map((entry) => entry.id));
  return [...(remote ?? []).filter((entry) => !recentIds.has(entry.id)), ...recent];
}
