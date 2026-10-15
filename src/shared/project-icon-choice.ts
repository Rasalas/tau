/** A chosen project mark, stored with its rendered picture for every client. */
export type ProjectIconChoice =
  | { kind: "icon"; name: string; hue: number; image: string }
  | { kind: "emoji"; emoji: string; image: string }
  | { kind: "monogram"; text: string; hue: number; image: string }
  | { kind: "image"; image: string };

// Retain the existing storage names so pictures chosen on older clients survive.
const EXTENSION_ID = "tau.workspace";
type Project = { workspaceId?: string | undefined; path: string };
type Values = { value(extensionId: string, key: string): string | undefined };

export function projectIconKey(project: Project): string {
  return `project-icon:${project.workspaceId ?? project.path}`;
}

function parseChoice(raw: string | undefined): ProjectIconChoice | undefined {
  if (!raw) return undefined;
  try {
    const choice = JSON.parse(raw) as ProjectIconChoice;
    return typeof choice?.image === "string" && choice.image.startsWith("data:image/") ? choice : undefined;
  } catch {
    return undefined;
  }
}

/** A workspace-id choice, including a clear, takes precedence over its legacy path. */
export function readProjectIcon(preferences: Values, project: Project): ProjectIconChoice | undefined {
  const current = preferences.value(EXTENSION_ID, projectIconKey(project));
  return parseChoice(current !== undefined || !project.workspaceId
    ? current
    : preferences.value(EXTENSION_ID, projectIconKey({ path: project.path })));
}

