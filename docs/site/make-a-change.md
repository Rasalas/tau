# Make a change

Tau is built to be changed. There are two ways in: write a kit of your own, which leaves Tau's code alone, or change Tau itself and send the change back.

## Your own kit

A kit is a folder with a manifest and a module or two. Tau compiles it when it loads it; there is no build step.

1. **Start one.** In a terminal:

   ```bash
   tau kit new ~/tau-kits/my-kit
   ```

   It writes a manifest for the extension API your Tau runs, a button in the thread header and a command in the palette (`desktop.tsx`), a command that runs on the host (`host.ts`), a stylesheet, a README, and the types your editor needs (`tsconfig.json` and `.tau-types/`). There is nothing to install.

2. **Install it.** Type `/install ~/tau-kits/my-kit` in the composer. Tau loads the folder where it lies, for every project. With `/install -l`, it loads for the project on screen only, and only in a project Pi trusts; for one it doesn't trust yet, the toast and Settings → Packages offer **Trust this project**.

3. **Approve it.** The toast's **Review** opens it in Settings → Extensions. Click **Allow and turn on**. It starts at once.

4. **Edit and save.** The kit reloads by itself and a toast says *Reloaded My kit*. A save that doesn't compile keeps the version that ran: the toast names the file, line and column, and Settings → Packages → *Develop a package* shows every error of the last build.

A kit can be smaller than that. This one is two files: a manifest,

<!-- include: examples/review-button/tau-extension.json -->

and a **Review** button in the thread header that fills the composer with a review request:

<!-- include: examples/review-button/desktop.tsx -->

[The tutorial](../kit-tutorial.md) takes one kit through these steps and a real edit. `title-bar` is the end of the thread header. The [package reference](../EXTENSIONS.md#1-what-a-package-is) lists every other place a kit can draw and the hooks it can use; [Your first package](../EXTENSIONS.md#your-first-package) covers what a kit usually needs next: the thread's branch, a host half that isn't running, and bad input.

## Change Tau itself

You need Node.js 22 and Git.

1. **Get the code.**

   ```bash
   git clone https://github.com/Rasalas/tau.git
   cd tau
   npm install
   ```

2. **Run a Tau of your own.** This starts Tau from your checkout with its own data under `.tau-dev/`, so your real threads and settings stay out of it:

   ```bash
   npm run dev:instance -- --build --fresh
   ```

   `npm run dev:web` shows the interface in a browser with sample data, which is quicker for layout work.

3. **Find the place.** The core in `src/` stays small: threads, the transcript, the composer and where things sit. Features live in kits under `kits/<name>/`, the same way your own kit does. If a kit needs something no kit can do today, the core gets a small, documented seam first. [Core and kits](../CORE.md) has the map.

4. **Check it.**

   ```bash
   npm run lint && npm run typecheck && npm test
   ```

   Tests live next to the code. For a change you can see, try it in your dev instance too.

5. **Open a pull request.** Keep commits small, in English, as [Conventional Commits](https://www.conventionalcommits.org/). Say what changed, why, and how you checked it; add a screenshot for anything visible. For anything bigger than a bug fix, open an issue first so we can agree on where it belongs. [Contributing](../../CONTRIBUTING.md) has the rest.

## From inside the installed app

Tau's own source can be changed from inside Tau too. A clean installation carries the editable source and build tools for its version. Run `/source` to create and open a versioned copy under Tau's user data, edit it like any other project, then run `/reload`. The installed Electron shell builds that managed copy and relaunches into its main process, renderer and bundled kits; the signed application itself stays untouched. Later reloads keep using the managed copy even while another project is open. Safe mode, or `TAU_IGNORE_WORKBENCH_SOURCE=1`, bypasses it for recovery. If threads are still running, Tau offers to wait or stop them first. An unpackaged checkout keeps building its own source directly.
