---
status: accepted
---

# Core owns placement, extensions own features

Tau core will own workbench placement, extension lifecycle, shared interaction rules, and host communication. Desktop extensions will own optional product features and register them as contributions.

We rejected hard-coding the file tree, Git diff, project providers, settings, and tool-specific UI into the main workbench. That approach would produce a conventional application with plugin decoration rather than the intended "Neovim for coding agents" model. We also rejected letting every extension create arbitrary windows and layout because the resulting workbench would have no consistent navigation or lifecycle.

Core therefore provides stable slots such as the left sidebar and right dock. Extensions fill those slots with sidebar modules and panels, or contribute commands, prompt hooks, project sources, and tool renderers. The Workspace Kit is the first adapter at this seam. Deactivating it removes the complete thread and project sidebar, local-folder and Git-clone sources, Files, and Changes without edits to `App.tsx`.

Pi extensions and desktop extensions remain separate because they run in different environments and have different permissions. A future package may ship both kinds of contribution together without merging their interfaces.
