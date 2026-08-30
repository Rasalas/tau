---
status: accepted
---

# Core owns threads, extensions own navigation

Tau core owns thread and session semantics, the normalized thread index, active transcript state, caching, streaming, and host operations such as new, resume, fork, branch, rename, and abort. These behaviors follow Pi's session model so the desktop client does not invent incompatible lifecycle rules.

Extensions own how threads are presented and organized. Workspace Kit renders the default sidebar, search, project grouping, activity labels, and settled shelf from the core thread store. Another extension may replace that sidebar without loading or duplicating Pi sessions.

We rejected putting complete thread state inside Workspace Kit because title generation, command navigation, remote transport, caching, and other extensions also need the same canonical data. We also rejected fixing the sidebar in core because it would make navigation difficult to replace. Safe mode therefore keeps the active thread and composer but has no visual thread navigator.
