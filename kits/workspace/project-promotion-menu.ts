import { READ_ONLY_REASON, type MenuSection, type UiSession } from "tau";

export const PROMOTE_PROJECT = "workspace.turn-into-project";

/** The same product action on row, title and compact menus. */
export function projectPromotionMenu(sections: MenuSection[], session: UiSession, readOnly: boolean): MenuSection[] {
  const clean = sections.map((section) => ({ ...section, items: section.items.filter((item) => item.id !== `command:${PROMOTE_PROJECT}` && item.id !== PROMOTE_PROJECT) }));
  if (!session.projectless) return clean;
  const item = { id: PROMOTE_PROJECT, label: "Turn into project…", ...(readOnly ? { disabled: true, description: READ_ONLY_REASON } : {}) };
  const at = clean.findIndex((section) => section.items.some((entry) => entry.id === "project-settings"));
  if (at < 0) return [...clean, { items: [item] }];
  const section = clean[at]!;
  section.items.splice(section.items.findIndex((entry) => entry.id === "project-settings"), 0, item);
  return clean;
}
