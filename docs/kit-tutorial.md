# Tutorial: your first kit

This walks through one small kit from an empty folder to a button you use.
**PR Title** shows a pull request title made from the thread's branch in the
thread header: `feat/copy-pr-title` becomes *feat: copy pr title*. It takes
about ten minutes. You need an installed Tau that is running, and a Git
project open in it. [Writing a package](EXTENSIONS.md) is the reference for
everything below.

## 1. Create the kit

In a terminal, next to your projects rather than inside one:

```bash
tau kit new pr-title --install -l
```

This writes `pr-title/` with a manifest (`tau-extension.json`), a desktop
half (`desktop.tsx`), a host half (`host.ts`), a stylesheet, a README and the
types your editor needs (`tsconfig.json`, `.tau-types/`). There is nothing to
`npm install`. The kit's id is `local.pr-title` and Settings shows it as
*PR Title*; `--id` and `--name` choose others.

`--install -l` asks the running Tau to install the folder for the project on
screen. Leave out `-l` to install it for every project, or leave out
`--install` and type `/install /path/to/pr-title` in Tau's composer later.

A project install writes `.tau/packages.json` into the project. For a folder
outside the project, Tau keeps that file out of Git on this machine, so the
project shows no change.

## 2. Trust the project

Tau loads a project's packages only in a project Pi trusts. For a project Pi
doesn't trust yet, the install toast says *PR Title: skipped, project not
trusted*. Click **Trust this project** in the toast, or in Settings →
Packages. A global install skips this step.

## 3. Approve it

No package runs before you allow what it asks for. Open Settings →
Extensions → **PR Title**, where it waits under *Needs attention*, and click
**Allow and turn on**. It starts at once, with a *PR Title* button at the
right end of the thread header. The button asks the host half for a greeting.

## 4. Make it yours

Replace `desktop.tsx` with this and save:

```tsx
import { GitBranch } from "lucide-react";
import { useSyncExternalStore } from "react";
import { THREAD_BRANCH_SERVICE, type DesktopExtension, type RegionProps, type ThreadBranchService } from "tau";

const ID = "local.pr-title";

/** `feat/copy-pr-title` → "feat: copy pr title". */
export function titleFrom(branch: string): string {
  const [kind, ...rest] = branch.split("/");
  const words = (rest.join("/") || kind).replace(/[-_]+/g, " ");
  return rest.length > 0 ? `${kind}: ${words}` : words;
}

function createButton(branches: ThreadBranchService) {
  return function PrTitleButton({ actions }: RegionProps) {
    // Workspace Kit's branch of the thread on screen; it follows a checkout made anywhere.
    const branch = useSyncExternalStore(branches.subscribe, branches.current)?.branch;
    if (!branch) return null;
    const title = titleFrom(branch);
    return (
      <button type="button" className="pr-title-button" title="A pull request title from the branch" onClick={() => actions.toast?.({ type: "info", title: "PR title", description: title })}>
        <GitBranch size={12} /> {title}
      </button>
    );
  };
}

const extension: DesktopExtension = {
  id: ID,
  name: "PR Title",
  activate(context) {
    // Nothing is drawn while Workspace Kit is off: useService never calls back then.
    return context.useService<ThreadBranchService>(THREAD_BRANCH_SERVICE, (branches) =>
      context.registerRegion({ id: `${ID}.button`, placement: "title-bar", Component: createButton(branches) }));
  },
};

export default extension;
```

Tau rebuilds the kit on every save. Within a second the button shows the
title for the branch you're on. Run `git checkout -b feat/copy-pr-title` in a
terminal and the button follows. The branch comes from
[`THREAD_BRANCH_SERVICE`](EXTENSIONS.md#a-threads-branch-and-pull-requests-tauworkspacebranch-and-taureviewpull-requests),
so the kit never runs `git` itself.

The new `desktop.tsx` no longer calls the host half. Delete `host.ts` and the
`"host"` line in the manifest, or keep them for a command of your own.

To check the types from a terminal: `npx -p typescript tsc -p .`.

## 5. When a save breaks it

Break a line in `desktop.tsx` and save. The running version stays, and a toast
names the file, line and column of the error. Settings → Packages →
*Develop a package* shows the last build of each half with every error. Fix
the line and save again.

To build the installed packages again without saving a file, use
**Rebuild extension packages** in the command palette (⌘K), or *Rebuild* on
the *Develop a package* view. `/reload` is not needed: it rebuilds Tau itself
from its source.

## 6. Ask for more

A host half that starts programs needs the `process` permission, and one that
reaches the network needs `network`. Add it to `"permissions"` in the
manifest and save. The toast says *PR Title is waiting for approval*, and
**Review** takes you back to step 3. Until you allow it, controls that call the
host half turn off, with the reason in their tooltip
([`useHostAvailability`](EXTENSIONS.md#when-the-host-half-does-not-run-usehostavailability)).

After you update Tau, run `tau kit types` in the kit's folder to copy in the
new types.
