import type { PromptLink } from "../shared/prompt-links";
import type { UiProject } from "../shared/contracts";
import type { WorkbenchActions } from "./extension-system";

interface PromptLinkPorts {
  actions: Pick<WorkbenchActions, "activeThread" | "composerDraft" | "setComposerDraft" | "newSession" | "focusComposer" | "notify" | "setModel">;
  projects(): readonly UiProject[];
  models(): Promise<readonly { provider: string; id: string }[]>;
  cancelled?(): boolean;
  scope?(): string | undefined;
  confirm(): Promise<boolean>;
  wait(): Promise<void>;
}

export async function placePromptLink(link: PromptLink, ports: PromptLinkPorts): Promise<void> {
  const { actions } = ports;
  if (link.truncated) actions.notify("The linked prompt was shortened to 8,000 characters. Review it before sending.", "warning");
  for (let attempt = 0; attempt < 80 && !ports.projects().length; attempt += 1) await ports.wait();
  if (ports.cancelled?.()) return;
  const projects = ports.projects();
  const matches = link.project ? projects.filter((p) => p.workspaceId === link.project || p.path === link.project || p.name === link.project) : [];
  const named = matches.length === 1 ? matches[0] : undefined;
  if (link.project && !named) actions.notify("The linked project is not available. This draft uses your current project.", "warning");
  const active = actions.activeThread();
  const project = named ?? projects.find((p) => (p.workspaceId && p.workspaceId === active?.workspaceId) || p.path === active?.cwd) ?? projects[0];
  if (!project) { actions.notify("Add a project before opening this prompt link.", "warning"); return; }
  const workspace = project.workspaceId ?? project.path;
  const inProject = () => {
    const current = actions.activeThread();
    return current?.draftPending && (current.workspaceId === workspace || current.cwd === workspace || current.cwd === project.path);
  };
  if (!inProject()) actions.newSession({ workspace });
  for (let attempt = 0; attempt < 80 && !inProject(); attempt += 1) await ports.wait();
  if (ports.cancelled?.()) return;
  if (!inProject()) { actions.notify("The linked prompt could not open a draft. Try the link again.", "warning"); return; }
  const scope = ports.scope?.();
  const stillHere = () => !ports.cancelled?.() && inProject() && (!ports.scope || ports.scope() === scope);
  const models = link.model || link.provider ? await ports.models().catch(() => []) : [];
  if (!stillHere()) return;
  // Recheck after the dialog: typing while it was open must not be lost.
  for (;;) {
    const previous = actions.composerDraft();
    if (!previous || previous === link.prompt) break;
    if (!await ports.confirm()) return;
    if (!stillHere()) return;
    if (actions.composerDraft() === previous) break;
  }
  if (!actions.setComposerDraft) return;
  actions.setComposerDraft(link.prompt);
  actions.focusComposer();
  if (link.model || link.provider) {
    const modelMatches = models.filter((m) => m.id === link.model && (!link.provider || m.provider === link.provider));
    const model = modelMatches.length === 1 ? modelMatches[0] : undefined;
    if (!model || !stillHere() || await Promise.resolve(actions.setModel?.(model.provider, model.id)).catch(() => false) === false) {
      actions.notify("The linked model is not available. This draft keeps its default model.", "warning");
    }
  }
}
