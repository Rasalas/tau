import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Menu, tooltipProps, type ComposerControlProps, type PlatformEnvironments } from "tau";
import { cannotStartReason, shownMachine, statusText } from "./machines.js";
import { MachineIcon, useEnvironments } from "./rail.js";

/**
 * "Run on" for a new thread's draft (T3's environment selector): which
 * machine the thread starts on. Another machine takes the draft's text with
 * it and opens this window there; a started thread stays where it runs.
 */
export function createRunOnControl(environments: PlatformEnvironments) {
  return function RunOnControl({ actions, snapshot }: ComposerControlProps) {
    const list = useEnvironments(environments);
    const [open, setOpen] = useState(false);
    const [moving, setMoving] = useState(false);
    const current = list ? shownMachine(list) : undefined;
    // A draft, or a thread nothing was sent in yet, may still move; a started one stays where it runs.
    const unstarted = (actions?.activeThread()?.draftPending ?? false) || (snapshot !== undefined && snapshot.messages.length === 0 && !snapshot.isStreaming);
    if (!list || !current || !actions || !unstarted || (list.environments.length < 2 && current.local)) return null;
    const now = Date.now();
    const move = (id: string) => {
      const machine = list.environments.find((environment) => environment.id === id);
      if (!machine || machine.id === current.id) return;
      const draft = actions.composerDraft();
      setMoving(true);
      // The text goes along; left here it would be a second copy. The page reloads before `open` answers.
      actions.setComposerDraft?.("");
      void environments.open(machine.id, { newThread: { draft, ...(machine.projects[0]?.workspaceId ? { workspaceId: machine.projects[0].workspaceId } : {}) } })
        .catch((error: unknown) => {
          setMoving(false);
          actions.setComposerDraft?.(draft);
          actions.notify(error instanceof Error ? error.message : String(error));
        });
    };
    return (
      <span className="menu-anchor composer-runtime-menu-anchor">
        <button
          className="runtime-chip machine-chip"
          aria-label={`Run on ${current.name}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={moving}
          {...tooltipProps(`Run on ${current.name}: the machine this thread starts on`)}
          onClick={() => setOpen((value) => !value)}
        >
          <MachineIcon environment={current} />
          <span>{moving ? "Moving…" : current.name}</span>
          <ChevronDown size={12} className="chev" />
        </button>
        {open ? (
          <Menu
            placement="above"
            heading="Run on"
            items={list.environments.map((machine) => ({
              id: machine.id,
              label: machine.name,
              icon: <MachineIcon environment={machine} />,
              selected: machine.id === current.id,
              ...(machine.local ? { badge: "This computer" } : {}),
              description: machine.id === current.id ? "Shown in this window" : cannotStartReason(machine, now) ?? statusText(machine, now),
              disabled: machine.id !== current.id && cannotStartReason(machine, now) !== undefined,
            }))}
            onSelect={(id) => { setOpen(false); move(id); }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </span>
    );
  };
}
