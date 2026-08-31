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

function taskSnapshot(tasks: UiTask[]): UiTaskProgress {
  return {
    tasks,
    completed: tasks.filter((item) => item.status === "completed").length,
    total: tasks.length,
  };
}

function progress(tasks: UiTask[]): UiTaskProgress | undefined {
  return tasks.length > 0 ? taskSnapshot(tasks) : undefined;
}

function sameTask(left: UiTask, right: UiTask): boolean {
  return left.id === right.id
    && left.subject === right.subject
    && left.status === right.status
    && left.activeForm === right.activeForm
    && (left.blockedBy ?? []).join(",") === (right.blockedBy ?? []).join(",");
}

function changedTaskIds(previous: readonly UiTask[], next: readonly UiTask[]): Set<number> {
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(next.map((item) => [item.id, item]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return new Set([...ids].filter((id) => {
    const left = before.get(id);
    const right = after.get(id);
    return !left || !right || !sameTask(left, right);
  }));
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
  let hasTaskSnapshot = false;
  let anchorMessageId: string | undefined;
  let lastVisibleMessageId: string | undefined;
  let turnKey = "root";
  let segment = 0;
  const touched = new Set<number>();
  const history: UiTaskProgressEntry[] = [];

  const finishSegment = () => {
    const changedTasks = latestTasks.filter((item) => touched.has(item.id));
    const snapshot = progress(changedTasks) ?? (touched.size > 0 ? taskSnapshot(latestTasks) : undefined);
    if (snapshot) {
      segment += 1;
      history.push({
        id: `tasks-${turnKey}${segment === 1 ? "" : `-${segment}`}`,
        anchorMessageId,
        progress: snapshot,
      });
    }
    touched.clear();
    anchorMessageId = undefined;
  };

  messages.forEach((raw, index) => {
    const message = raw as TodoMessage | undefined;
    if (!message) return;
    if (message.role === "user") {
      finishSegment();
      lastVisibleMessageId = message.tauEntryId ?? `user-${message.timestamp ?? index}-${index}`;
      turnKey = lastVisibleMessageId;
      segment = 0;
      return;
    }
    if (message.role === "assistant" && hasVisibleText(message) && message.tauEntryId) {
      finishSegment();
      lastVisibleMessageId = message.tauEntryId;
    }
    const snapshot = todoDetails(message);
    if (!snapshot) return;

    const { details, tasks } = snapshot;
    const isMutation = ["create", "update", "delete", "clear"].includes(details.action ?? "");
    if (isMutation) {
      const changed = hasTaskSnapshot ? changedTaskIds(latestTasks, tasks) : new Set<number>();
      if (!hasTaskSnapshot && typeof details.params?.id === "number") changed.add(details.params.id);
      if (!hasTaskSnapshot && details.action === "create" && typeof details.nextId === "number") changed.add(details.nextId - 1);
      changed.forEach((id) => touched.add(id));
      if (changed.size > 0 && !anchorMessageId) anchorMessageId = lastVisibleMessageId;
    }
    latestTasks = tasks;
    hasTaskSnapshot = true;
  });

  const current = progress(latestTasks.filter((item) =>
    item.status === "pending" || item.status === "in_progress" || touched.has(item.id),
  ));
  finishSegment();
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
