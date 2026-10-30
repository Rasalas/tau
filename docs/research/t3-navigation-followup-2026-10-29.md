# Navigation, Snooze und Palettensuche, 29. Oktober 2026

Umsetzung nach Abschnitt 2 von `t3-parity-next-ux-2026-10-29.md`. AGENTS.md, CONTEXT.md und ADR 0002, 0003, 0016 sowie 0042 wurden gelesen. Keine Unteragenten, Commits, Pushes oder Eingriffe in die fremden Änderungen. Die bereits vorhandene chronologische Snooze-Sortierung in `meta.ts` und ihre Regression wurden beibehalten.

## Umgesetzt

### Maschinenweite Snooze-Optionen

Settings → Threads zeigt unter Rail die Karte `Snooze options`, auf Desktop, Web und Compact. Eine Liste mit 1 bis 8 Optionen bietet After mit Minuten, Stunden oder Tagen und At mit Tag und lokaler Uhrzeit. Dauerwerte werden mit Blur oder Enter gespeichert, Zeiteingaben ebenfalls. Ganze positive Dauerwerte bis 30 Tage, gültige Uhrzeiten und eindeutige stabile IDs werden auch auf dem Host geprüft. Entfernen der letzten und Hinzufügen einer neunten Option sind gesperrt. Reset, Vorschau und Read-only-Sperren sind vorhanden. Compact trennt Optionen in gestapelte Blöcke. Fehler beim Speichern nennen die Ursache und bieten Retry; Laden erscheint erst nach 300 ms.

`RailSettings.snoozePresets` liegt im vorhandenen Host-Zustand. Host-Push und Antwort tragen dieselben Optionen an alle verbundenen Clients. Alte Zustände ohne Liste erhalten die bisherigen fünf Optionen und IDs, einschließlich `next-week` für Montag. Der Menütext dafür lautet nun `Monday`. Der Decoder setzt beschädigte gespeicherte Listen auf die Defaults zurück; explizit ungültige Schreibbefehle werden abgelehnt. `snoozePresets(now, settings)` erzeugt Menü und Vorschau gemeinsam, sortiert nach Zielzeit, entfernt gleiche Zielzeiten und blendet Today erst unter 15 Minuten Abstand aus. Custom bleibt am Ende. Eine entfernte gemerkte Option markiert im Snooze-Picker nichts. Plan behält das bisherige Picker-Verhalten.

### Direkte Untermenüsuche

Nur `PaletteMenu.searchable: true` erlaubt das Lesen von Kindern. Die vorhandenen Menüs Set model, Change theme und New thread on sind freigeschaltet. Runtime-Zeilen nennen jetzt die Runtime, ihre Bereitschaft bleibt im Detail. Die Enumeration ruft ausschließlich `items`, keine `run`- oder `stage`-Funktion auf.

Die Suche startet auf der obersten Ebene nach 120 ms, ab zwei Zeichen, in All und Commands. Threads und Files fragen keine Menüs ab. Alle Menüs einer Abfrage erhalten dieselbe Query und dasselbe AbortSignal. Querywechsel, Schließen und Cleanup brechen dieses Signal ab. Pro Menü werden Antworten nach 1,5 Sekunden ignoriert, einschließlich Zeit für das Lazy-Modul. Ein Timeout bricht nicht das gemeinsame Signal der übrigen Menüs ab. Anbieter müssen laufende I/O-Aufrufe selbst kooperativ abbrechen.

Grenzen sind 32 freigegebene Root-Menüs, die ersten 200 Einträge je Antwort, drei Treffer je Menü und acht insgesamt. Es gibt keine rekursive Enumeration. Antworten werden in Ankunftsreihenfolge angehängt; damit verdrängt ein spät antwortendes Menü keine bereits angebotenen Treffer am Limit. Treffer stehen unter `In menus` direkt hinter Commands oder, wenn keine Commands passen, vor den übrigen Quellen. Die ID hält die Cursorposition auch beim Nachladen anderer Quellen. Kinder übernehmen Icon, Current und Zugriffssperre; die Unverfügbarkeit des Root-Befehls gilt zusätzlich. Ein Kind mit Untermenü öffnet seine Ebene mit dem vollständigen Eltern-Breadcrumb.

### Bereichsfokus und Sidebar-Ergänzungen

Ein gemeinsamer Ring ersetzt den F6-Listener in Toasts. Reihenfolge im Workbench ist Threads → Conversation → Message → Notifications → Stage. Nicht sichtbare, versteckte und inerte Bereiche sowie leere Notifications entfallen. App-Pages verwenden Threads → Page; Settings verwendet die sichtbaren Bereiche Threads, Settings sections und den offenen Abschnitt. Die bestehende Settings-Oberfläche macht die dahinterliegende Sidebar inert, daher fällt Threads dort derzeit weg. Dialoge, Menüs, Palette und Sheets blockieren den Ring. Compact bekommt ihn nicht.

Jeder Bereich merkt sein letztes Element. Defaults sind aktive Threadzeile, Transcript-Scroller, Composer-Textarea, neuester Toast und aktiver Stage-Tab. Der Transcript-Scroller hat jetzt `tabIndex=-1` und das Label Conversation. Eine höfliche Live-Region nennt den Bereich, Toastanzahl und aktiven Stage-Dateinamen. Escape in Notifications kehrt zum vorherigen Bereich zurück. Die Befehle `workbench.focus-next-area` und `workbench.focus-previous-area` gehören zu View und sind frei belegbar. Defaults sind F6/Shift+F6; Web hat zusätzlich mod+F6/mod+Shift+F6. Die bestehende Keybindings-Seite listet die mehreren Belegungen automatisch. Eine Palette-Ausführung wartet mit dem Fokuswechsel bis zum Schließen der Palette.

`sidebar-keyboard.ts` ergänzt die vorhandene virtualisierte Pfeilnavigation. Home/End scrollen zuerst zum Rand und fokussieren anschließend eine dort gemountete Zeile. Space öffnet, mod+Enter öffnet in Stage. F2 ruft `runtime.rename-thread` mit der fokussierten Thread-ID auf; Thread Rail öffnet dafür seinen vorhandenen Rename-Dialog. Die Conversation wird dafür nicht gewechselt. Shift+F10 und ContextMenu lösen das vorhandene Zeilenmenü am Element aus. ArrowLeft springt zur gemounteten Gruppenüberschrift; bestehende aufklappbare Shelf-Buttons reagieren auf links/rechts. Zeilenbuttons, Editierfelder, Overlays und Compact behalten ihre eigene Bedienung. Es wurde keine Löschtaste hinzugefügt.

## Noch vom Parent im Workspace-Scope anzuschließen

Abschnitt 2c ist damit noch nicht vollständig umgesetzt. `kits/workspace/navigation.tsx` wurde auf ausdrückliche Anweisung nicht geändert. Dort werden Pinned/Active und Projektgruppen weiterhin teilweise als nicht aufklappbare `div.thread-group-label` gerendert. Die Rendering- und Virtualisierungslogik muss sie zu echten Buttons mit `aria-expanded` und einem gespeicherten Collapse-Zustand machen und diese Buttons in den gemeinsamen Roving-Cursor aufnehmen. Die Shelf-Buttons und andere bereits vorhandene Tabstopps sind noch nicht auf einen einzigen Listen-Einstieg vereinheitlicht. Pfeile zwischen Gruppenüberschriften und Zeilen, sowie die Rückkehr zur korrekten Projektüberschrift, wenn diese gerade nicht gemountet ist, brauchen Zugriff auf das vollständige `navigationRows`-Modell und den Virtualizer. Das lässt sich im zugewiesenen Renderer-Scope nicht zuverlässig allein aus dem DOM lösen.

Der bestehende Renderer-Anschluss erkennt `button[data-rail-heading]` sowie `.thread-group-label[role="button"]` für links/rechts, erwartet die aktuelle Bedeutung von `data-rail-thread` und `data-rail-section` und verwendet weiterhin das vorhandene Kontextmenü. Er setzt keine eigenen Collapse-Zustände und verändert keine virtuellen Zeilenhöhen. Parent sollte diesen Anschluss beim Einbau einer durchgängigen Navigation in Workspace entsprechend zusammenführen, statt zwei unabhängige Cursor einzuführen.

Es fand keine Prüfung im echten Tau statt. Verhalten von Home/End unter langsamen virtuellen Renders, Web-Browser-F6 und eingebetteten Frames muss der Parent noch am kombinierten Stand prüfen. Tastaturereignisse in fremden iframe-Dokumenten oder nativen Browseransichten erreichen den Renderer-Ring nicht automatisch; dafür wurde keine neue Transportbrücke eingeführt.

## Neue Schnittstellen und API-Version

Die Extension-API wurde in `src/shared/extension-compat.ts` von 1.78.0 auf 1.79.0 erhöht. Thread Rail verlangt nun `^1.79.0`. Keine package-Datei wurde geändert. Die folgenden Ergänzungen benötigen diesen API-Minor:

- `SettingsCardId` erhält `snooze`.
- `PaletteMenu.searchable?: true` ist eine ausdrückliche Zusage für nebenwirkungsfreie Enumeration.
- `PaletteItem.unavailable?()` ergänzt die bestehende Zugriffssperre um einen konkreten Grund.
- `PaletteSourceContribution.status?(query, context): string | undefined` und `subscribeStatus?(listener): () => void` liefern eine optionale Statuszeile.
- `FocusAreaContribution` und `DesktopExtensionContext.registerFocusArea(area)` registrieren einen Bereich mit id, Reihenfolge, Label, Root, optionalem Defaultziel und optionaler Sichtbarkeit. Root und Defaultziel werden bei jedem Wechsel frisch gelesen. Deaktivierung entfernt die Registrierung. Stage-Panels gehören standardmäßig zum bestehenden Stage-Bereich und benötigen keinen weiteren Stopp.
- `registerThreadRenameHandler(handler)` erlaubt Thread Rail die gezielte Umbenennung einer fokussierten Zeile, ohne erst den Thread zu öffnen.
- `WhenPicker.missingRemembered` ist optional, Default `first`. Snooze setzt `none`.

`SnoozePreset` ist ein Kit-Protokolltyp mit `id` und entweder `{ kind: "after", amount, unit }` oder `{ kind: "at", day, time }`. `day` ist today, tomorrow oder 0 bis 6 wie `Date.getDay()`. Das ist keine zusätzliche Host-RPC-Route. Die vorhandene `settings`-Route erhält das optionale Feld snoozePresets; null setzt die Defaults zurück.

### Verwendung der optionalen Indexstatus-Zeile

Das Such-Backend und `kits/search/` wurden nicht verändert. Eine bestehende Palette-Quelle kann additiv registrieren:

```ts
status(query, context) {
  return currentMessageIndexStatusText();
},
subscribeStatus(listener) {
  return messageIndexStore.subscribe(listener);
},
```

Die Palette liest status nur ab drei Zeichen, nur in All und Threads und bei Threads nur von Quellen mit `scope: "threads"`. `undefined` oder ein leerer String blendet die Zeile aus. `subscribeStatus` weckt nur die Statusanzeige; es startet keine neue Suche. Bei Querywechsel oder Schließen wird abbestellt, und verspätete Benachrichtigungen werden verworfen. Die Zeile steht mit `role="status"` zwischen Ergebnisliste und Tastaturfuß und ist kein Cursorziel. Die Quelle liefert die exakten Texte aus Abschnitt 1 der UX-Vorgaben einschließlich Indexfortschritt, deaktiviertem Index und Fallback. Die Schnittstelle führt selbst keine Index-RPCs aus.

## Dateien

Thread Rail:

- `kits/thread-rail/protocol.ts`
- `kits/thread-rail/meta.ts`, `meta.test.ts`
- `kits/thread-rail/host.ts`, `host.test.ts`
- `kits/thread-rail/desktop.tsx`
- `kits/thread-rail/organizer.tsx`, `snooze-dialog.test.tsx`
- `kits/thread-rail/snooze-settings.tsx`, `snooze-settings.test.tsx`, beide neu
- `kits/thread-rail/styles.css`
- `kits/thread-rail/tau-extension.json`

Renderer und additive Core-Anschlüsse:

- `src/renderer/components/CommandPalette.tsx`, `CommandPalette.test.tsx`, `command-palette.css`
- `src/renderer/palette-menu-search.ts`, `palette-menu-search.test.ts`, beide neu
- `src/renderer/focus-areas.ts`, `focus-areas.test.ts`, beide neu
- `src/renderer/sidebar-keyboard.ts`, `sidebar-keyboard.test.ts`, beide neu
- `src/renderer/use-app-keybindings.ts`, `use-app-keybindings.test.ts`
- `src/renderer/components/ui/Toasts.tsx`, `Toasts.test.tsx`
- `src/renderer/components/ui/WhenPicker.tsx`
- `src/renderer/components/TranscriptViewport.tsx`
- `src/renderer/extension-system.tsx`, `extension-system.test.tsx`, `extension-api.ts`
- `src/renderer/settings/ThreadsPage.tsx`
- `src/renderer/settings/runtime-controls.tsx`, `runtime-controls.test.ts`
- `src/renderer/settings/palette-menus.tsx`, `palette-menus.test.tsx`
- `src/renderer/thread-rename.ts`
- `src/shared/extension-compat.ts`

## Checks und Regressionen

Ausgeführt wurde ausschließlich `git diff --check` im eigenen Scope, ohne Befund. Neue Regressionen decken Host-Persistenz und Restart, Defaultmigration, ungültige Snooze-Listen, Zeitgrenzen, Deduplizierung, Settings-Grenzen und Reset, Read only, entfernte gemerkte Optionen, Menü-Opt-in, Grenzen, Timeout und Cancellation, keine Aktionsausführung bei Suche, Breadcrumbs, Current und Read-only-Sperre, Cursorstabilität bei nachladenden Quellen, Statusabonnement, Fokusreihenfolge und Rückrichtung, Notifications-Escape, Sichtbarkeit, Settings und Dialoge, registrierte Bereiche und deren Lebenszyklus, Web-Belegungen sowie die ergänzten Sidebar-Tasten ab.

Wie beauftragt wurden keine Tests, Typechecks, Builds, Installationen oder Appstarts ausgeführt. Der Parent muss die betroffenen Tests über `npm test -- <files>` und die passenden `npm run typecheck:<scope>`-Skripte einmal kombiniert laufen lassen. Tests sind hinzugefügt und gelesen, nicht als bestanden gemeldet. Die bestehenden Einschränkungen bei Virtualisierung und iframe-Fokus sind oben ausdrücklich beschrieben.
