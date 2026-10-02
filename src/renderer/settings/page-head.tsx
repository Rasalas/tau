import { useEffect, useState, type Ref } from "react";
import { ChevronDown, Folder, Laptop, Server } from "lucide-react";
import type { SettingsMachine, SettingsProject } from "../../workbench/config-layers-store";
import { Menu, type MenuSection } from "../components/Menu";
import { useSettingsLevels } from "./settings-layout";
import type { ScopeProject } from "./settings-scope";

/** What the scope menu offers: the projects of this machine and the other machines. */
export interface SettingsScopeChoices {
  projects: readonly ScopeProject[];
  current?: SettingsProject | undefined;
  machines?: ReadonlyArray<SettingsMachine & { status: string }>;
}

/**
 * Where a change on this page is written: this machine, another machine's own
 * settings, or a project that overrides this machine. Projects are offered
 * only while a row on the page can hold one.
 */
function ScopeSwitch({ projects, machines = [] }: SettingsScopeChoices) {
  const { store, snapshot } = useSettingsLevels();
  const [open, setOpen] = useState(false);
  const editingProject = snapshot.editing === "project" ? snapshot.project : undefined;
  const editingMachine = snapshot.machine;
  const offered = snapshot.projectSettings ? projects : [];
  // The machine's state moves on (read only, offline); what is edited follows it, and a removed one is let go.
  const fresh = editingMachine ? machines.find((machine) => machine.id === editingMachine.id) : undefined;
  useEffect(() => {
    if (!editingMachine) return;
    if (fresh) store.editMachine(fresh);
    else store.edit("host");
  }, [store, editingMachine, fresh?.name, fresh?.blocked]);
  const here = !editingProject && !editingMachine;
  const label = editingMachine?.name ?? editingProject?.label ?? "This machine";
  if (offered.length === 0 && machines.length === 0 && here) return null;
  const Mark = editingMachine ? Server : editingProject ? Folder : Laptop;
  return (
    <div className="settings-scope">
      <span>Applies to</span>
      <button
        type="button"
        className={here ? "" : "narrowed"}
        aria-label={`Settings apply to ${here ? "this machine" : label}. Change where they apply`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Mark size={13} />
        <span>{label}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <Menu
          align="left"
          sections={[
            { items: [{ id: "host", label: "This machine", description: snapshot.projectSettings ? "Every project without its own value" : undefined, selected: here, icon: <Laptop size={13} /> }] },
            { heading: "Other machines", items: machines.map((machine) => ({
              id: `machine:${machine.id}`,
              label: machine.name,
              icon: <Server size={13} />,
              selected: editingMachine?.id === machine.id,
              disabled: machine.status !== "connected",
              description: machine.status !== "connected" ? "Not reachable" : machine.blocked ? "Read only" : undefined,
            })) },
            { heading: "Override for a project", items: offered.map((project) => ({
              id: `project:${project.workspaceId}`,
              label: project.label,
              description: project.detail,
              icon: <Folder size={13} />,
              selected: editingProject?.workspaceId === project.workspaceId,
            })) },
          ].filter((section) => section.items.length > 0) as MenuSection[]}
          onSelect={(id) => {
            const machine = machines.find((entry) => `machine:${entry.id}` === id);
            if (machine) store.editMachine(machine);
            else if (id === "host") store.edit("host");
            else store.edit("project", offered.find((project) => `project:${project.workspaceId}` === id));
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export interface SettingsCrumb {
  label: string;
  open(): void;
}

/**
 * The head of a Settings page (design 1j): its title, one sentence on what it
 * governs, where a change applies, and its action at the right. A nested page
 * has the pages above it as a breadcrumb over the title. Without `title` the
 * page names itself (a phone's bar does, an extension's page draws its own).
 */
export function SettingsPageHead({ title, description, crumbs = [], scope, actionSlot }: {
  title?: string | undefined;
  description?: string | undefined;
  crumbs?: readonly SettingsCrumb[];
  /** Offer the level a change is written to. */
  scope?: SettingsScopeChoices | undefined;
  actionSlot: Ref<HTMLDivElement>;
}) {
  return (
    <header className="settings-page-head">
      {crumbs.length ? (
        <nav aria-label="Settings breadcrumb">
          <ol>
            {crumbs.map((crumb, index) => (
              <li key={index}><button type="button" onClick={crumb.open}>{crumb.label}</button></li>
            ))}
          </ol>
        </nav>
      ) : null}
      {title || description || scope ? (
        <div>
          {title ? <h1>{title}</h1> : null}
          {description ? <p>{description}</p> : null}
          {scope ? <ScopeSwitch {...scope} /> : null}
        </div>
      ) : null}
      <div className="settings-page-action" ref={actionSlot} />
    </header>
  );
}
