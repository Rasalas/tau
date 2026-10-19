# Customize Tau

Every part of Tau that an extension draws has a name, and you can change any
of them: hide it, put it elsewhere, or draw your own in its place. Your changes
belong to the machine and show on every device connected to it: the desktop,
a browser and the phone. Because they name parts rather than the page's
markup, they keep working after Tau updates.

## Find a part

- **Pick it.** Run "Hide or move a part…" from the command palette (or
  Settings → Customize → Pick a part) and click what you want to change. Tau
  opens Settings → Customize at that part. Escape stops picking.
- **Find it.** Settings → Customize lists every part by extension, with its
  name, for example `region:usage.juicebars` or `page:usage/Summary`.

## Hide a part

Turn its switch off in Settings → Customize. Turn it on again to bring it
back. "Back to Tau as shipped" at the end of the page undoes everything.

## Replace a part with your own

Click **Replace** beside a part. Tau adds a script that draws in that part's
place. A script is HTML and JavaScript, and it starts out with an example:

```html
<div id="out">…</div>
<script>
  tau.data("tau.usage/limits", (limits) => {
    const shown = (limits?.accounts ?? []).flatMap((account) =>
      account.windows.map((window) => `${account.label} ${window.label} ${Math.round(window.usedPercent)}%`));
    document.getElementById("out").textContent = shown.join(" · ");
  });
  document.getElementById("out").onclick = () => tau.openPage("usage", { section: "limits" });
</script>
```

To draw your own bar in place of Usage's juicebars in the sidebar, replace
`page:usage/Summary`. On a phone the bars are `region:usage.juicebars`.

A script runs in a sandbox: it cannot read Tau's page, your files or your
keys, and it reaches the network only for what it embeds. What it can do:

| Call | What it does |
|---|---|
| `tau.data(id, callback)` | Calls `callback` with data an extension shares, now and on every change. Returns a function that stops it. Usage shares `tau.usage/limits`. |
| `tau.openPage(id, params?)` | Opens a page of the app, such as `usage`. |
| `tau.runCommand(id)` | Runs a command of the palette, only from a click in the script. |

The script follows Tau's light and dark colours through variables such as
`--foreground`, `--muted-foreground`, `--accent` and `--border`.

## Add a part of your own

Click **Add script** under Scripts and set its target to a placement instead
of a part name, such as `title-bar` or `thread-list-title`. The script then
draws there beside what extensions put there. Extensions offer places of their
own too: `tau.usage/limits-end` puts a script under Usage's plan limits,
`tau.usage/page-end` at the end of the Usage page.

Parts that only a phone or tablet draws, such as `region:usage.juicebars`, are
listed on the desktop too, marked "on other devices", so you can change them
from there.

## Your own styles

Click **Add style** under Styles. A style is CSS, applied after every
extension's own. A part is `[data-tau-part="<name>"]`, and it draws no box of
its own, so style what it holds:

```css
[data-tau-part="region:usage.juicebars"] > * { opacity: 0.6; }
```

A style may change anything in Tau, not only parts. Unlike a part's name,
other class names can change with an update.

## A source of your own in Usage

A package of your own appears on the Usage page by offering itself as a source:
its host half calls `context.offer("tau.usage/limits-source")` and answers
`usage-limits`, or `context.offer("tau.usage/threads-source")` and answers
`usage`. "Joining another kit's list" in [Writing a package](EXTENSIONS.md)
describes both.

## Turning it all off

Customizations come from the Customize extension. Turning it off in
Settings → Extensions shows Tau as shipped and keeps your customizations for
when you turn it on again. Safe mode starts without them too.
