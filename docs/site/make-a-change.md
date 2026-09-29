# Make a change

Tau is built to be changed. There are two ways in: write a kit of your own, which leaves Tau's code alone, or change Tau itself and send the change back.

## Your own kit

A kit is a folder with a manifest and a module or two. Tau compiles it when it loads it; there is no build step. This one puts a **Review** button into the thread header that fills the composer with a review request.

1. Make a folder anywhere, say `~/tau-kits/review-button`, with a `tau-extension.json`:

   <!-- include: examples/review-button/tau-extension.json -->

   Set `engines.api` to the version you test on. Settings → Diagnostics → Inspector shows it under *Versions* as "Extension API".

2. Add the button as `desktop.tsx` beside it:

   <!-- include: examples/review-button/desktop.tsx -->

   `title-bar` is the end of the thread header. The [package reference](../EXTENSIONS.md#1-what-a-package-is) lists every other place a kit can draw, and the hooks it can use.

3. **Install it.** Type `/install ~/tau-kits/review-button` in the composer. Tau loads the folder where it lies, for every project. With `/install -l`, it loads for the project on screen only, and only in a project Pi trusts; run `/trust` in Pi's terminal UI there first.

4. **Approve it.** Settings → Extensions lists it under *Needs attention*. Click **Review**, then **Allow and turn on**. It starts at once.

5. **Edit and save.** The kit reloads by itself and a toast says *Reloaded Review button*. A save that doesn't compile changes nothing; the error shows as a toast and in Settings → Diagnostics → Inspector.

For types in your editor, see [Types for a package of your own](../EXTENSIONS.md#types-for-a-package-of-your-own). A kit with a host half, for commands, tools or files, starts from the [minimal example](../EXTENSIONS.md#2-a-minimal-example-exampleshello-package).

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
