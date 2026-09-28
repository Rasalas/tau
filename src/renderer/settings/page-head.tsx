import { useMemo, useState, type Ref } from "react";
import { ChevronDown, Folder, Monitor } from "lucide-react";
import type { UiProject } from "../../shared/contracts";
import type { SettingsProject } from "../../workbench/config-layers-store";
import { Menu } from "../components/Menu";
import { useSettingsLevels } from "./settings-layout";

function projectName(path?: string): string {
  return path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "project";
}

/** The level a change on this page is written to: this machine, or a project that overrides it. */
function ScopeSwitch({ projects, current }: { projects: readonly UiProject[]; current?: SettingsProject | undefined }) {
  const { store, snapshot } = useSettingsLevels();
  const [open, setOpen] = useState(false);
  const choices = useMemo(() => {
    const list: SettingsProject[] = current ? [current] : [];
    for (const project of projects) {
      const workspaceId = project.workspaceId ?? project.path;
      if (current && (project.workspaceId === current.workspaceId || project.path === current.workspaceId || project.path === current.path)) continue;
      if (!list.some((entry) => entry.workspaceId === workspaceId)) list.push({ workspaceId, label: project.name || projectName(project.path) });
    }
    return list;
  }, [current, projects]);
  const editingProject = snapshot.editing === "project" ? snapshot.project : undefined;
  return (
    <div className="settings-scope">
      <span>Applies to</span>
      <button
        type="button"
        className={editingProject ? "narrowed" : ""}
        aria-label={`Settings apply to ${editingProject ? editingProject.label : "this machine"}. Change where they apply`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {editingProject ? <Folder size={13} /> : <Monitor size={13} />}
        <span>{editingProject ? editingProject.label : "This machine"}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <Menu
          align="left"
          sections={[
            { items: [{ id: "host", label: "This machine", description: "Every project without its own value", selected: !editingProject, icon: <Monitor size={13} /> }] },
            {
              heading: "Override for a project",
              items: choices.map((project) => ({
                id: `project:${project.workspaceId}`,
                label: project.label,
                icon: <Folder size={13} />,
                selected: editingProject?.workspaceId === project.workspaceId,
              })),
            },
          ]}
          onSelect={(id) => {
            if (id === "host") store.edit("host");
            else store.edit("project", choices.find((project) => `project:${project.workspaceId}` === id));
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
  scope?: { projects: readonly UiProject[]; current?: SettingsProject | undefined } | undefined;
  actionSlot: Ref<HTMLDivElement>;
}) {
  return (
    <header className="settings-page-head">
      {crumbs.length ? (
        <nav aria-label="Settings breadcrumb">
          <ol>
            {crumbs.map((crumb) => (
              <li key={crumb.label}><button type="button" onClick={crumb.open}>{crumb.label}</button></li>
            ))}
          </ol>
        </nav>
      ) : null}
      {title || description || scope ? (
        <div>
          {title ? <h1>{title}</h1> : null}
          {description ? <p>{description}</p> : null}
          {scope ? <ScopeSwitch projects={scope.projects} current={scope.current} /> : null}
        </div>
      ) : null}
      <div className="settings-page-action" ref={actionSlot} />
    </header>
  );
}
