import type { WorkbenchActions } from "./extension-system";
import type { AppPageStore } from "../workbench/app-page-store";

/** What shows a thread, a file or a panel: each leaves the open page first. */
const LEAVING = ["switchSession", "newSession", "openDraft", "openFile", "openThread", "openStageTab", "openPanel", "focusComposer", "openWorkspace"] as const;

/** The actions with `openPage` and `closePage`; an action that shows the thread's side closes the page. */
export function withAppPages(actions: WorkbenchActions, pages: AppPageStore, closeSettings: () => void): WorkbenchActions {
  const next: WorkbenchActions = {
    ...actions,
    openPage: (id, params) => { closeSettings(); pages.open(id, params); },
    closePage: pages.close,
  };
  for (const name of LEAVING) {
    const action = actions[name] as ((...args: never[]) => unknown) | undefined;
    if (!action) continue;
    (next as unknown as Record<string, unknown>)[name] = (...args: never[]) => { pages.close(); return action(...args); };
  }
  return next;
}
