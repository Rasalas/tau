import { useState } from "react";
import { Bot, ChevronDown, Ellipsis, ListChecks, PencilRuler } from "lucide-react";
import {
  ComposerMenuItem,
  ComposerMenuSection,
  Markdown,
  Menu,
  errorMessage,
  hostIsReadOnly,
  tooltipProps,
  useThreadStore,
  useWorkbenchShell,
  type ComposerControlProps,
  type DesktopExtension,
  type HostExtensionClient,
  type MessageBlockProps,
  type RegionProps,
  type ThreadStore,
  type UiSession,
  type WorkbenchActions,
} from "tau";
import {
  DEFAULT_MODE,
  PLAN_HOST_EXTENSION_ID,
  PLAN_MODE,
  PLAN_TAG,
  implementationPrompt,
  pendingPlan,
  planBody,
  planTitle,
} from "./protocol.js";

const PROFILES = ["desktop", "web", "compact"] as const;
/** A plan longer than this opens folded. */
const FOLD_CHARS = 900;
const FOLD_LINES = 20;
const PREVIEW_LINES = 10;

/** Build or Plan as a section of the composer's "…" menu; drawn only where the thread's runtime offers `plan`. */
function PlanModeControl({ snapshot, actions }: ComposerControlProps) {
  if (!snapshot?.modes?.includes(PLAN_MODE) || !actions?.setMode) return null;
  const planning = snapshot.mode === PLAN_MODE;
  return (
    <ComposerMenuSection heading="Mode">
      <ComposerMenuItem icon={<Bot size={13} />} label="Build" detail="Works on the task" selected={!planning} onSelect={() => { if (planning) void actions.setMode?.(DEFAULT_MODE); }} />
      <ComposerMenuItem icon={<PencilRuler size={13} />} label="Plan" detail="Plans first, changes nothing" selected={planning} onSelect={() => { if (!planning) void actions.setMode?.(PLAN_MODE); }} />
    </ComposerMenuSection>
  );
}

/** While a thread plans, the footer says so beside the model; a click goes back to building. */
function PlanningChip({ snapshot, actions }: ComposerControlProps) {
  if (snapshot?.mode !== PLAN_MODE || !actions?.setMode) return null;
  const label = "Plan mode — click to return to build mode";
  return (
    <button
      type="button"
      className="runtime-chip plan-mode-chip active"
      aria-pressed
      aria-label={label}
      {...tooltipProps(label)}
      onClick={() => { void actions.setMode?.(DEFAULT_MODE); }}
    >
      <PencilRuler size={13} />
      Plan
    </button>
  );
}

/** The first `lines` lines with text of the plan, and whether more follows. */
function planPreview(body: string, lines: number): string {
  const kept: string[] = [];
  let visible = 0;
  for (const line of body.split("\n")) {
    if (line.trim() && visible >= lines) return `${kept.join("\n").trimEnd()}\n\n…`;
    kept.push(line);
    if (line.trim()) visible += 1;
  }
  return kept.join("\n");
}

function downloadPlan(title: string | undefined, plan: string): void {
  const name = `${(title ?? "plan").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "plan"}.md`;
  const url = URL.createObjectURL(new Blob([`${plan.trimEnd()}\n`], { type: "text/markdown;charset=utf-8" }));
  const anchor = Object.assign(document.createElement("a"), { href: url, download: name });
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A `proposed_plan` block of a reply: the plan as a card, folded when it is long. */
function PlanCard({ body, complete }: MessageBlockProps) {
  const { actions } = useWorkbenchShell();
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const title = planTitle(body);
  const content = planBody(body);
  const foldable = complete && (body.length > FOLD_CHARS || body.split("\n").length > FOLD_LINES);
  const folded = foldable && !expanded;
  return (
    <section className="plan-card" aria-label={title ? `Proposed plan: ${title}` : "Proposed plan"}>
      <header>
        <span className="plan-card-badge">Plan</span>
        <h3>{title ?? "Proposed plan"}</h3>
        {complete ? (
          <span className="menu-anchor">
            <button type="button" className="plan-card-menu" aria-label="Plan actions" {...tooltipProps("Plan actions")} onClick={() => setMenuOpen((open) => !open)}>
              <Ellipsis size={15} />
            </button>
            {menuOpen ? (
              <Menu
                align="right"
                label="Plan actions"
                items={[
                  { id: "copy", label: "Copy to clipboard" },
                  { id: "download", label: "Download as Markdown" },
                ]}
                onSelect={(id) => {
                  if (id === "copy") void actions?.copyText(body).then(() => actions.notify("Plan copied."), (error: unknown) => actions.notify(errorMessage(error)));
                  else downloadPlan(title, body);
                }}
                onClose={() => setMenuOpen(false)}
              />
            ) : null}
          </span>
        ) : null}
      </header>
      <div className={`plan-card-body${folded ? " folded" : ""}`}>
        <Markdown streaming={!complete}>{folded ? planPreview(content, PREVIEW_LINES) : content}</Markdown>
      </div>
      {foldable ? (
        <button type="button" className="plan-card-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Collapse plan" : "Expand plan"}
        </button>
      ) : null}
    </section>
  );
}

/** Resolves with the thread once the index lists it; the host publishes the index after `start`. */
function indexed(store: ThreadStore, sessionId: string): Promise<UiSession | undefined> {
  const find = () => store.getSnapshot().threads.find((thread) => thread.id === sessionId);
  const found = find();
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { off(); resolve(undefined); }, 10_000);
    const off = store.subscribe(() => {
      const thread = find();
      if (!thread) return;
      window.clearTimeout(timer);
      off();
      resolve(thread);
    });
  });
}

/** Switches the thread back to building and sends it the plan. */
export async function implementPlan(actions: WorkbenchActions, plan: string): Promise<void> {
  if (!actions.setMode || !actions.submitPrompt) throw new Error("This workbench cannot send the plan.");
  if (!await actions.setMode(DEFAULT_MODE)) return;
  await actions.submitPrompt(implementationPrompt(plan));
}

async function implementInNewThread(host: HostExtensionClient, store: ThreadStore, actions: WorkbenchActions, plan: string): Promise<void> {
  const active = actions.activeThread();
  if (!active?.cwd) throw new Error("There is no project to start the thread in.");
  const title = planTitle(plan);
  const result = await host.invoke("implement-in-new-thread", {
    cwd: active.cwd,
    prompt: implementationPrompt(plan),
    title: title ? `Implement ${title}` : "Implement plan",
    ...(active.backendKind ? { backend: active.backendKind } : {}),
    ...(active.model ? { model: active.model } : {}),
  }) as { sessionId?: string } | undefined;
  const thread = result?.sessionId ? await indexed(store, result.sessionId) : undefined;
  if (thread) await actions.switchSession(thread.path);
}

/**
 * "Plan ready" above the composer while a plan-mode thread waits on its plan.
 * Typing refines it; Implement leaves plan mode and sends it. A kit cannot
 * turn the send button into Implement, so the banner carries it.
 */
function createFollowUp(host: HostExtensionClient) {
  return function PlanFollowUp({ snapshot, actions }: RegionProps) {
    const onThread = snapshot?.sessionId !== undefined && actions.activeThread()?.sessionId === snapshot.sessionId;
    const pending = onThread && snapshot?.mode === PLAN_MODE && !snapshot.isStreaming ? pendingPlan(snapshot.messages) : undefined;
    // Implementing sends a prompt; a Read-only device may not (ADR 0024).
    return pending && !hostIsReadOnly() ? <PlanReady host={host} actions={actions} plan={pending.plan} /> : null;
  };
}

function PlanReady({ host, actions, plan }: { host: HostExtensionClient; actions: WorkbenchActions; plan: string }) {
  const store = useThreadStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    work().catch((error: unknown) => actions.notify(errorMessage(error))).finally(() => setBusy(false));
  };
  const title = planTitle(plan);
  return (
    <div className="plan-follow-up" role="region" aria-label="Plan ready">
      <ListChecks size={14} className="plan-follow-up-icon" />
      <strong>Plan ready</strong>
      {title ? <span className="plan-follow-up-title" {...tooltipProps(title, { when: "truncated" })}>{title}</span> : null}
      <span className="plan-follow-up-hint">Type to refine</span>
      <span className="plan-follow-up-actions menu-anchor">
        <button type="button" className="plan-implement" disabled={busy} onClick={() => run(() => implementPlan(actions, plan))}>
          {busy ? "Sending…" : "Implement"}
        </button>
        <button type="button" className="plan-implement-more" disabled={busy} aria-label="Implementation actions" onClick={() => setMenuOpen((open) => !open)}>
          <ChevronDown size={13} />
        </button>
        {menuOpen ? (
          <Menu
            placement="above"
            align="right"
            label="Implementation actions"
            items={[{ id: "new-thread", label: "Implement in a new thread" }]}
            onSelect={() => run(() => implementInNewThread(host, store, actions, plan))}
            onClose={() => setMenuOpen(false)}
          />
        ) : null}
      </span>
    </div>
  );
}

export const planKitExtension: DesktopExtension = {
  id: PLAN_HOST_EXTENSION_ID,
  name: "Plan Kit",
  activate(plugin) {
    plugin.registerComposerControl({ id: "plan.mode", placement: "menu", order: 40, profiles: [...PROFILES], Component: PlanModeControl });
    plugin.registerComposerControl({ id: "plan.planning", order: 40, profiles: [...PROFILES], Component: PlanningChip });
    plugin.registerMessageBlock({ id: "plan.card", tag: PLAN_TAG, profiles: [...PROFILES], Component: PlanCard });
    plugin.registerRegion({ id: "plan.follow-up", placement: "composer-above", profiles: [...PROFILES], Component: createFollowUp(plugin.host) });
    plugin.registerCommand({
      id: "plan.toggle",
      label: "Toggle plan mode",
      group: "Composer",
      access: "write",
      run: async (actions) => {
        const active = actions.activeThread();
        if (!active?.modes?.includes(PLAN_MODE) || !actions.setMode) {
          actions.notify("This thread's runtime has no plan mode.");
          return;
        }
        await actions.setMode(active.mode === PLAN_MODE ? DEFAULT_MODE : PLAN_MODE);
      },
    });
  },
};

export default planKitExtension;
