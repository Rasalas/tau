# UX-Vorgaben für die offenen T3-Funktionen, 29. Oktober 2026

Diese Vorgaben gelten für die acht Funktionen, die nach dem [Abgleich vom 29. Oktober](t3-parity-implementation-2026-10-29.md) offen sind. Grundlage sind die [Inventur](t3code-since-2026-10-11.md), die Upstream-Commits am Pin `7a4f5b618` in `/tmp/tau-t3code-upstream-20261029` und die Tau-Module, die bei jedem Abschnitt genannt werden. Produktcode wurde nicht geändert. Jeder Abschnitt trennt die UX-Entscheidungen von den Architekturfragen, die vor einer Umsetzung entschieden werden müssen. Produkttexte sind englisch und können wörtlich übernommen werden.

## Gemeinsame Regeln

- Nur vorhandene Bausteine: `SettingsCard`/`SettingRow`/`SettingsState`, `Dialog` mit `footer`, `Menu`-Sektionen, Palette-Ebenen (`PaletteMenu`), Stage-Tabs, Toasts mit Aktion, `Badge`, `tooltipProps`. Keine neuen Seitentypen, kein neues Layout.
- Wortwahl nach `CONTEXT.md`: **machine**, nicht host; **extension**, nicht kit. Read-only-Geräte sehen jede Schreibaktion deaktiviert und bekommen als Grund `Read only: this needs a device with Full access.`
- Zustände: Laden bis 300 ms ohne Anzeige, danach `SettingsState kind="loading"` oder eine Zeile `Loading…`. Fehler nennen die Ursache und bieten `Retry` an. Ein leerer Zustand erklärt, wie er sich füllt.
- Profile: `desktop` und `web` bekommen alles. `compact` bekommt Lesen und Entscheiden, also Vorschauen, Freigaben, Senden und Verwerfen. Einrichtungsformulare bleiben auf breiten Profilen, wenn das unten nicht anders festgelegt ist.
- Destruktive Aktionen folgen #456: Endgültiges wird bestätigt, Rücknehmbares bekommt einen Toast mit `Undo`.

## 1. Persistente vollständige Threadsuche

Module: `kits/search/desktop.tsx` (`search.thread-content`), `threads.ts` (`THREAD_TEXT_LIMIT` 400.000), `palette-sources.ts`, `src/renderer/touch/TouchThreadBrowser.tsx`.

**Einstieg.** Unverändert die Palette (All und `#` Threads) und auf `compact` die Thread-Suche. Der Index ändert die Trefferquote, nicht die Bedienung. Das Ranking bleibt: exakter Titel vor Wort- und Teiltreffern, danach Nachrichtentreffer nach `quality`, dann nach Aktualität.

**Treffer.** Label ist der Threadtitel. Das Detail ist `You: …snippet…` oder `Agent: …snippet…`, der Treffer im Snippet ist als `<mark>` hervorgehoben. Enter öffnet den Thread mit offener In-Thread-Suche auf dem Begriff (vorhandenes `registerThreadFind`) und springt zur getroffenen Nachricht; ⌘⏎ öffnet ihn in der Stage. Archivierte Threads werden gefunden, stehen unter den übrigen und tragen das Detail `Archived`. Delegierte Kinder bleiben ausgeschlossen. Ein gelöschter Thread verschwindet sofort aus den Treffern.

**Indexstatus in der Palette.** Eine Zeile `role="status"` zwischen Ergebnisliste und Tastaturfuß. Sie erscheint nur in All/Threads, ab drei Zeichen und nur, wenn der Index nicht bereit ist:
- Aufbau: `Indexing messages · 120 of 412 threads. Some results may be missing.`
- Ausgeschaltet: `Searching recent message text only. Turn on the message index in Settings → Threads.`
- Fehler oder ältere Maschine ohne Index: `Message index unavailable. Searching recent message text only.`

Ist der Index bereit, steht dort nichts. Der Fallback ist die heutige Suche mit Anfang und Ende großer Pi-Dateien.

**Settings → Threads, neue Karte `Search`.**
- `Index message text`, Switch, Standard an. Beschreibung: `Finds words anywhere in a thread's messages, including long and closed threads. The index stays on this machine and holds your messages and the agent's replies, not tool output or files.`
- `Message index`, Statuszeile mit Button `Rebuild index`. Mögliche Texte: `Up to date · 412 threads · 38 MB`, `Indexing · 120 of 412 threads`, `Couldn't build the index: <reason>` (dann `Retry` statt Rebuild). Hinweis unter Rebuild: `Search keeps using the current index until the new one is ready.`
- Ausschalten fragt nicht nach. Die Beschreibung sagt dafür `Turning this off deletes the index from this machine.`

**Compact.** Das Suchfeld bekommt den Platzhalter `Title, project, branch or message`. Ab drei Zeichen stehen Nachrichtentreffer unter den Titeltreffern, darunter dieselbe Statuszeile.

**A11y.** Der gesprochene Name der Zeile ist `<title>, You said: <snippet>`. Die Statuszeile ist `aria-live="polite"` und meldet höchstens alle 5 s einen neuen Fortschritt.

**Architektur, nicht UX.** Speicher (`node:sqlite`-FTS oder eine eigene Struktur) und sein Ort unter dem State-Ordner. Textextraktion je Runtime: Pi aus der Session-Datei, die übrigen über `THREAD_TEXT_SOURCES`. Inkrementelle Aktualisierung beim Anhängen und Löschen bei Delete. Neues Protokollfeld für den Status, z. B. `index-status` mit `state | done | total | bytes`. Die Palette braucht dafür eine API-Ergänzung: `PaletteSourceContribution.status?()` oder eine eigene Status-Contribution, denn heute kann eine Quelle keine Zeile außerhalb ihrer Treffer zeigen.

## 2. Eigene Snooze-Zeiten, Suche in Untermenüs, F6 und Sidebar-Tastatur

### 2a. Eigene Snooze-Zeiten

Module: `kits/thread-rail/meta.ts` (`snoozePresets`), `organizer.tsx` (`snoozeSubmenu`, gemerkte Wahl über `readWhenPick`), `desktop.tsx` (Karte `rail`).

**Ort.** Settings → Threads, neue Karte `Snooze options` unter `Rail`. Die Optionen liegen wie die Rail-Regeln im Host-Zustand der Maschine und gelten auf jedem Gerät, das diese Maschine zeigt, auch auf dem Telefon.

**Felder.** 1 bis 8 Optionen. Jede Zeile hat:
- `Kind`: Select `After` oder `At`.
- Bei `After`: Zahlenfeld plus Einheit `minutes | hours | days`, höchstens 30 Tage, gespeichert beim Verlassen des Feldes oder mit Enter.
- Bei `At`: Tag als Select `Today | Tomorrow | Monday … Sunday` und Uhrzeit (`<input type="time">`, Anzeige im Locale). Ein Wochentag meint das nächste Vorkommen nach heute.
- Am Ende ein Icon-Button `Remove` mit `aria-label="Remove snooze option 3"`. Bei der letzten Option ist er deaktiviert, Tooltip `Keep at least one option.`

Unter der Liste stehen `Add option` (bei 8 deaktiviert, Tooltip `Up to 8 options.`) und `Reset to defaults`. Darunter folgt eine Live-Vorschau: `Right now the menu shows: In 1 hour (15:05) · In 3 hours (17:05) · This evening (18:00) · Tomorrow (9:00) · Monday (9:00)`.

**Standardwerte** sind die heutigen fünf Optionen: 1 h, 3 h, heute 18:00, morgen 9:00, Montag 9:00.

**Labels** entstehen automatisch, ein Freitext ist nicht vorgesehen:
- Dauer: `In 30 minutes`, `In 2 hours`, `In 3 days`.
- Heute: ab 17 Uhr `This evening`, sonst `Later today`.
- Morgen: `Tomorrow`. Wochentag: `Monday`.

Der Hinweis rechts im Menü bleibt die Uhrzeit beziehungsweise `Mon 9:00`.

**Regeln im Menü.** Sortiert nach Zielzeit, wie der Fix vom 29. Oktober. Eine Heute-Option fällt weg, wenn sie weniger als 15 Minuten entfernt ist. Bisher galt dafür eine Stunde; diese Grenze blendet bei eigenen Zeiten zu viel aus. Doppelte Zielzeiten erscheinen einmal. `Custom…` steht immer am Ende. Jede Option bekommt eine stabile ID `snooze:<id>`. Fehlt die gemerkte Option, wird nichts markiert.

**Read only.** Die Felder sind deaktiviert, die Vorschau bleibt sichtbar. **Compact** stellt die Karte gestapelt dar, eine Option pro Block.

**Architektur.** `RailSettings.snoozePresets` im Host-Zustand und dessen Validierung. `snoozePresets(now, settings)` wird eine reine Funktion. Neue `SettingsCardId` `"snooze"` (API-Minor). Telefon und Widgets lesen dieselbe Liste.

### 2b. Untermenübefehle direkt suchen

Module: `src/renderer/components/CommandPalette.tsx`, `PaletteMenu` in `extension-system.tsx`, `lazyLevel` in `src/renderer/settings/runtime-controls.tsx`.

**Verhalten.**
- Auf der obersten Ebene, ab zwei Zeichen und nicht im Scope `#` oder `/`, fragt die Palette alle durchsuchbaren Untermenüs mit derselben Query und demselben `signal`. Die Abfrage startet 120 ms nach der letzten Taste, jedes Menü hat 1,5 s Zeit. Fehler und Timeouts erzeugen keine Zeile.
- Treffer stehen in einer eigenen Sektion `In menus` direkt unter den Befehlen: höchstens 3 pro Menü, 8 insgesamt.
- Das Label ist `<Menütitel>: <Eintrag>`, z. B. `Set model: Claude Sonnet 5.5`, `Change theme: Dracula`, `New thread on: Codex`. Icon, `Current` und Read-only-Sperre übernimmt die Zeile vom Kindeintrag.
- Passt die Query nur auf den Menünamen (`set mod`), erscheint die Untermenü-Zeile, keine Kinder. So filtert die Upstream-Implementierung auch.
- Enter führt das Kind direkt aus. Hat das Kind selbst ein Untermenü, öffnet sich dessen Ebene mit der ganzen Breadcrumb `Set model › Anthropic`.
- Nachladende Zeilen erscheinen ohne Spinner. Der Cursor bleibt auf der ID, die er markiert hatte, und springt nie.

**A11y.** Gesprochen wird `Claude Sonnet 5.5, in Set model, Current`. Die Sektionsüberschrift ist wie bisher keine Stopp-Zeile.

**Architektur.** Ein Opt-in-Feld `PaletteMenu.searchable?: true` (API-Minor), denn `items(query)` einer Erweiterung kann teuer sein oder den Host fragen. Die eigenen Menüs der App (Modell, Runtime, Theme) schalten es ein. Das Laden des Lazy-Moduls zählt zum Zeitbudget.

### 2c. F6-Bereiche und Sidebar-Tastatur

Module: `src/renderer/components/ui/Toasts.tsx` (eigener F6-Listener), `ThreadRow.tsx`, `kits/thread-rail/organizer.tsx`, `kits/workspace/navigation.tsx`, Keybindings-Kit.

**Ring.** `Threads` (Sidebar) → `Conversation` (Transcript) → `Message` (Composer) → `Notifications` (Toast-Stack, nur mit mindestens einem Toast) → `Stage` (nur sichtbar) → zurück zum Anfang. Shift+F6 läuft rückwärts.

Die Notifications stehen direkt hinter dem Composer. Damit bleibt das heutige Toast-Ziel vom Composer aus mit einem Druck erreichbar, und der eigene F6-Listener in `Toasts.tsx` entfällt. Escape in den Notifications bringt den Fokus in den vorherigen Bereich zurück.

- Auf App-Pages lautet der Ring `Threads` → `Page`. In Settings kommen Abschnittsliste und offener Abschnitt als zwei Stopps dazu.
- Verborgene Bereiche werden übersprungen: eingeklappte Sidebar, geschlossene Stage, zur Spine gefaltete Conversation.
- Offene Dialoge, Menüs, Palette und Sheets halten den Fokus; F6 tut dort nichts.
- Jeder Bereich merkt sich sein zuletzt fokussiertes Element. Ohne Erinnerung gilt ein Standard: Sidebar → aktive Threadzeile, Conversation → Transcript-Scroller (`tabIndex=-1`, `aria-label="Conversation"`), Message → Textarea, Notifications → neuester Toast, Stage → aktiver Tab.
- Eine Live-Region (polite) nennt den Bereich: `Threads`, `Conversation`, `Message`, `Notifications, 2`, `Stage, src/app.ts`.
- Befehle `Focus next area` und `Focus previous area` in der Gruppe `View`, frei belegbar. Im Web fängt der Browser F6 oft selbst ab, deshalb zusätzlich ⌘F6/Ctrl+F6. Der Shortcut-Hinweis im Keybindings-Kit nennt beide.

**Sidebar.**
- Tab betritt die Liste einmal, mit Roving-Tabindex.
- ↑/↓ bewegen den Fokus, ohne zu öffnen. Home/End springen zur ersten oder letzten Zeile.
- Enter und Space öffnen. ⌘Enter öffnet in der Stage, wie in der Palette.
- → klappt eine Sektion oder Projektgruppe auf. ← klappt sie zu; auf einer Threadzeile springt ← zur Überschrift ihrer Gruppe.
- Tab springt von der Zeile zu ihren Buttons.
- F2 benennt um (`runtime.rename-thread`). Shift+F10 und die Kontextmenütaste öffnen das vorhandene Zeilenmenü am Element.
- Keine Löschtaste in der Liste; Löschen bleibt im Menü.
- Sektionsköpfe (`Pinned`, `Working`, `Snoozed`, `Settled`, Projektgruppen) sind Buttons mit `aria-expanded`. Kein `role="tree"`, weil Zeilen eigene Buttons enthalten. Der Fokusring ist der vorhandene `:focus-visible`-Stil.
- `compact` bekommt keinen F6-Ring. Dort gilt die Touch-Navigation.

**Architektur.** Ein kleiner Fokusbereichs-Registrar im Renderer: Bereiche registrieren sich mit ID, Reihenfolge, Sichtbarkeit und Standardziel. Bereiche aus Erweiterungen (Stage-Panels) brauchen eine API dafür oder laufen als Teil von `Stage`. Die Toast-Tests müssen auf den Ring umgestellt werden.

## 3. Webhook-Array-Wildcards und Coalescing

Module: `kits/scheduling/webhook-filters.ts`, `webhook-filter-editor.tsx`, `editor.tsx`, `job-summary.ts`, `protocol.ts` (`deliveries` dedupliziert bereits signierte Delivery-IDs; Dedupe braucht keine neue UI).

**Wildcards.** Ein Pfadsegment darf mit `[]` enden, höchstens zweimal pro Pfad: `pull_request.labels[].name`. Bedeutung:
- `Equals`: mindestens ein Element hat diesen Wert.
- `Exists`: die Liste ist nicht leer.

Numerische Indizes (`labels.0.name`) bleiben gültig. Neuer Hilfetext im Editor: `Optional. Every rule must match. Paths start in the JSON payload, such as action or pull_request.labels[].name. [] checks every item of a list: Equals matches when any item does, Exists when the list has items. Equality checks the value and its type.` Ein Pfadfehler steht inline am Feld: `Use names, numbers or [] separated by dots, such as issue.labels[].name.`

**Probe-Payload.** Ein eingeklapptes `Check against a sample payload` unter den Regeln. Es enthält eine Textarea `Sample JSON (not saved)` und je Regel `Matches` oder `Doesn't match`, am Ende `This delivery would start a run.` beziehungsweise `This delivery would be ignored.` Ungültiges JSON zeigt `Not valid JSON.` Gerechnet wird lokal mit `matchesWebhookFilters`; nichts geht an die Maschine.

**Coalescing.** Neuer Block `Bursts` unter den Filtern:
- Select `Start a run for every delivery` (Standard) oder `Combine deliveries with the same key`.
- Beim Kombinieren das Feld `Key path`, gleiche Pfadsyntax ohne `[]`, Platzhalter `pull_request.number`, und `Wait` in Sekunden, 10–3600, Standard 120.
- Hilfe: `The first delivery opens the wait. When it ends, one run starts with the latest payload. Later deliveries don't extend it. A delivery without the key path starts its own run.`
- Ausschalten oder Löschen der Automation verwirft ein offenes Warten. Eine Änderung an Key oder Wartezeit gilt ab dem nächsten Fenster.

**Anzeige.** Zusammenfassung: `Signed webhook · 2 payload filters · combines bursts (2 min)`. Während des Wartens die Statuszeile `Combining 3 deliveries · starts in 1:42`, ohne Sekundenticker in Screenreadern. Danach `Last run Oct 29, 14:02 UTC · finished · combined 4 deliveries`.

**Architektur.** Persistente Fenster über Neustarts hinweg. Neuer Jobzustand oder Feld für das Warten. Gespeichert wird die letzte Payload, nicht alle. Ein Rate-Limit pro Job. Pfadsyntax und Decoder bleiben gemeinsam für Host und Editor.

## 4. Passive Dateivorschauen

Module: `kits/files/file-kind.ts` (`FileViewKind`, `renderedMode`), `editor-tab.tsx` (`Binary file … nothing to show here.`), `notebook.ts`/`notebook-preview.tsx`, `open-in.tsx`, `src/renderer/components/AttachmentLightbox.tsx`.

**Gemeinsam.**
- Neue Ansichtsart `document` für `docx odt rtf`, `sheet` für `xlsx ods`, `slides` für `pptx odp`, `archive` für `zip jar tar tgz tar.gz`, `database` für `sqlite sqlite3 db`, `book` für `epub`. `.db` nur nach Prüfung des SQLite-Headers, sonst wie bisher binär.
- Es gibt keinen Source-Umschalter. Der Tab-Kopf zeigt `Open in…` (vorhanden) und den Hinweis `Preview only. Nothing in this file runs.`
- Bilder, Makros, Formeln, Links und eingebettete Objekte sind inaktiv. Bilder in Dokumenten stehen als `[Image]`. Grenze 20 MB je Datei.
- Laden: `Reading…` nach 300 ms.
- Zu groß: `This file is larger than 20 MB. Open it in another app.`
- Defekt oder verschlüsselt: `Couldn't read this file as <a Word document | a spreadsheet | …>. It may be damaged or password-protected.`, jeweils mit `Open in…`.
- Gekürzt: `Showing the first 1,000 rows of 25,300.` als `files-notice`, wie bei Notebooks.

**Je Art.**
- Document: Überschriften, Absätze, Listen und Tabellen über das inerte Markdown-Rendering, höchstens 200.000 Zeichen.
- Sheet: Blätter als Segmented Control (auf compact als Select). Die ersten 1.000 Zeilen × 50 Spalten, zwischengespeicherte Werte, Formel als `title` der Zelle. Kopf `Sheet 2 of 5 · 1,000 of 25,300 rows`.
- Slides: Liste `Slide 3` mit Titel und Text. Sprechernotizen eingeklappt unter `Notes`.
- Archive: Tabelle `Name · Size · Modified`, Ordner einklappbar, höchstens 10.000 Einträge. Verschlüsselte Einträge tragen ein Schloss mit `aria-label="Encrypted"`. Es wird nichts entpackt; verschachtelte Archive bleiben Einträge. Kopf `214 files · 38.2 MB unpacked`.
- Database: links die Tabellen und Views (auf compact ein Select), rechts die Tabs `Rows` und `Schema`. Die ersten 200 Zeilen, BLOBs als `BLOB · 4 KB`. Keine SQL-Eingabe. Kopf `users · 12 columns · about 48,000 rows`.
- Book: Titel, Autor und Inhaltsverzeichnis, ein Kapitel nach dem anderen mit `Previous chapter` und `Next chapter`. Bilder sind ausgelassen.

**Notebook-Bildoutputs.** `image/png`, `image/jpeg`, `image/gif`, `image/webp` und `image/svg+xml` erscheinen als `<img>` aus einer Blob-URL; SVG führt in `<img>` weder Skript aus noch lädt es Externes. Grenzen: 5 MB je Bild, 30 Bilder je Notebook. Darüber steht `Image output omitted: larger than 5 MB.` Alt-Text: `Output image 1 of cell 3`. Ein Klick öffnet den vorhandenen Lightbox-Viewer. Der Kopfhinweis wird zu `… Saved outputs only. Code is never executed. Links are inactive.` HTML und JavaScript bleiben ausgelassen.

**Profile.** Alle Arten auf allen Profilen. Read-only-Geräte gemäß ADR 0037 innerhalb zugelassener Workspaces. Bei einem entfernten Home Machine parst die Maschine, übertragen wird nur das Ergebnis.

**Architektur.** Parsen im Host (Worker) statt im Renderer, weil das JS-Budget praktisch voll ist; die Parser-Abhängigkeiten müssen einzeln geprüft werden. Strukturiertes Ergebnisformat pro Art. SQLite nur lesend und `immutable`, oder über eine Kopie, damit eine laufende App mit WAL nicht gestört wird. Die Notebook-Lesegrenze steigt von 1 MiB auf 10 MiB, die Textgrenze bleibt.

## 5. Projektlose Threads in Projekte umwandeln

Module: `kits/workspace/host.ts` (`create-scratch`, `isScratchWorkspace`, Anzeige `No project`), `project-starts.ts`, `repo-writes.ts` (`git init` mit erstem Commit), `kits/thread-rail/organizer.tsx`, `src/renderer/components/ThreadTitleMenu.tsx`.

**Einstieg.** `Turn into project…` im Zeilen- und Titelmenü und in der Palette, nur bei projektlosen Threads. Steht direkt über `Project settings…`.

**Dialog `Turn into a project`.**
- Text: `The thread's folder becomes a project where it is. Nothing moves, and the agent keeps working in the same place.`
- `Name`, Standard ist der Threadtitel, höchstens 60 Zeichen, Pflichtfeld.
- Checkbox `Start a Git repository`, Standard aus, Hinweis `Adds branches, diffs and reviews. Commits the current files once.`
- Teilen sich weitere Threads den Ordner: `2 other threads in this folder move with it.`
- Buttons `Cancel` und `Turn into project` (busy: `Creating…`).

Der Dialog geht auch bei laufendem Thread, weil sich der Pfad nicht ändert. Eine Undo-Aktion gibt es nicht; der Dialog ist die Bestätigung.

**Danach.** Der Thread wechselt in der Rail aus `No project` in die neue Projektgruppe, Fokus und Auswahl bleiben. Toast `"<name>" is now a project.` mit Aktion `Project settings`.

**Fehler.**
- Gleicher Name: `A project named "<name>" already exists.`
- Ordner fehlt: `This thread's folder no longer exists.`
- Maschine offline: `<machine> is offline. Try again when it's back.`
- Read only: deaktiviert mit dem Standardgrund.

**Bewusst nicht in Runde 1:** Verschieben in einen anderen Ordner. Der Projektordner liegt sichtbar unter Tau-Daten; `Project settings` zeigt den Pfad mit `Show in Finder`.

**Architektur.** Bleibt der Ordner, bleibt die `workspaceId` (Host-ID plus kanonischer Pfad) gleich; Sessions müssen nicht umziehen. Aus `isScratchWorkspace` muss ein persistenter Status werden, z. B. ein Promotions-Marker, damit der Ordner nicht mehr als Scratch gilt und das Aufräumen von Scratch-Ordnern ihn nicht löscht. Automationen, die auf den Scratch-Workspace zeigen, folgen ihm. Neuer Host-Befehl `promote-scratch` mit Write-Zugang.

## 6. Eingeschränkte, widerrufbare Gastfreigabe

Module: `src/renderer/settings/ConnectionsPage.tsx` (Pairing-Links, `CreateLinkDialog`, `LINK_LIFETIMES`, Tau Connect, Netzwerkadressen), `QueueShelf.tsx`, ADR 0023/0024/0037.

**Grundsatz.** Ein Gast ist kein Gerät. Er bekommt keine Pairing-Anfrage, keinen Schlüssel und keinen Eintrag unter Authorized clients. Ein Link gilt für einen Thread und einen Browser.

**Einschalten.** Settings → Connections, neue Karte `Guest links (beta)`, Switch `Allow guest links`, Standard aus. Beschreibung: `A guest follows one thread in a browser and can suggest messages. Nothing they send runs until you send it.` Darunter steht die Tabelle der aktiven Links: `Thread · Guest · Expires · Stop`. Leer: `No thread is shared.` Ausschalten pausiert alle Links; noch nicht abgelaufene Links gehen beim Wiedereinschalten wieder.

**Teilen.** `Share with a guest…` im Titelmenü, im Zeilenmenü und in der Palette. Den Link erstellen darf nur das Fenster dieser Maschine, wie bei Pairing-Links. Andere Geräte sehen den Eintrag deaktiviert: `Create guest links in this machine's own Tau window.`

Dialog:
- `Expires after`: 1 hour, 8 hours (Standard), 24 hours.
- `Guest can`: `Watch` oder `Watch and suggest messages` (Standard).
- Checkbox `Show tool output`, Standard aus.
- Warnung: `The guest sees this thread's messages and the agent's replies as they stream, and anything the agent read or printed in them. Share only what you'd show.`
- Button `Create link`.

Danach erscheinen Link, `Copy link` und ein QR-Code wie bei `CreatedLink`, dazu `Works in one browser. Opening it claims it.` Ein neuer Link für denselben Thread ersetzt den alten; der Dialog sagt das: `This replaces the current guest link.`

**Während der Freigabe.** Im Thread-Header ein Badge `Shared`, mit verbundenem Gast `Shared · guest watching`. Das Badge öffnet ein Menü mit `Copy link`, `Stop sharing` und der Restlaufzeit. `Stop sharing` beendet sofort und ohne Rückfrage, Toast `Guest link stopped.` ohne Undo.

Gastnachrichten erscheinen im vorhandenen Queue-Shelf als Karte `Guest suggests` mit Text, Bildern, `Send` und `Dismiss`. `Send` ist erst nach Fokus oder Hover aktiv, nie per Enter aus dem Composer. Die Rail-Zeile zeigt das Badge `Suggestion`. Senden und Verwerfen dürfen Geräte mit Full access, auch das Telefon. Read only sieht die Karte, kann aber nicht handeln. Stop, Archivieren, Löschen, ein neuer Link oder das Ausschalten beenden die Freigabe und löschen wartende Anhänge.

**Gastseite** (eigene schlanke Web-Route):
- Kopf: Threadtitel und `Shared by <machine name>`.
- Inhalt: Nachrichten und Antworten im Stream. Tools nur mit Namen und Status, Output nur bei `Show tool output`. Kein Reasoning, keine Diffs, keine Dateien, keine Stage, keine Pfade außerhalb von Nachrichten.
- Composer `Suggest a message` mit bis zu 4 Bildern und 10 MB, danach `Waiting for <owner> to send or dismiss.` Ergebnis: `Sent` oder `Dismissed`.
- Endzustände: `This guest link has ended.`, `This link is already open in another browser.`, `The machine is offline. This page reconnects on its own.`
- Die Seite nutzt die Web-Workbench-Styles und läuft auf compact.

**Architektur, blockierend.**
1. Ein neues Publikum neben Client-Tokens braucht einen ADR. Gast-Credentials dürfen keine Socket-, RPC-, MCP- oder Datei-Route erreichen, und Widerruf heißt: der Link-Eintrag ist weg, alle Tokens sind ungültig.
2. Erreichbarkeit: Die Maschine spricht TLS mit eigenem Zertifikat. Ein fremder Browser sieht im LAN eine Zertifikatswarnung. Der Gast braucht also eine Adresse über Tau Connect oder Tailscale. Wenn keine solche Adresse besteht, sagt der Dialog: `Guests need an address their browser trusts. Set up Tau Connect or Tailscale under Connections.`
3. Die Gastsicht ist eine serverseitig gefilterte Projektion des Transcripts, kein Client-Filter.
4. Gastnachrichten laufen über die Queue und nicht über Wake-Regeln.

## 7. Secret-Dateiausgabe für CLI-Aufrufe

Module: `kits/scheduling/secrets.ts` (`request_secret`, bisher nur `webhook-signature`), `secret-card.tsx`, Begriff *Private secret request* in `CONTEXT.md`.

**Agentenseite (Tooltext, englisch).** `delivery: "file"` mit `lifetime` 15 Minuten bis 24 Stunden, Standard 1 Stunde. Ergebnis `{ status: "saved", file, expiresAt }`. Beschreibung: `For a shell CLI. Read the file inside your command, e.g. TOKEN="$(cat <file>)" tool login. Never print it.`

**Karte im Thread** (gleiche Form wie heute):
- Kopf `Secret` und `for a command in this thread`.
- Label und Begründung des Agenten.
- Passwortfeld, Platzhalter `Paste the secret`.
- Select `Keep for`: 15 minutes, 1 hour, 8 hours, 24 hours. Vorgewählt ist die Anfrage des Agenten; die Person darf kürzen, nicht verlängern.
- Datenschutzhinweis: `Kept out of the chat. Saved to a private file that this thread's commands can read until it expires. A command can still print it, so check what the agent runs.` Der Hinweis verspricht bewusst nicht `never shown to the agent`.
- Buttons `Decline` und `Save for commands`.

**Nach dem Speichern** wird die Karte zur Zeile `Saved for commands · deletes in 58 min` mit `Delete now`. Laufzeitende, `Delete now`, Archivieren und Löschen des Threads löschen die Datei. Nach `Delete now` steht dort `Deleted. Commands that read it will fail.` Ein abgelaufener oder gelöschter Verweis gibt dem Agenten `not_a_file_request` oder `expired` zurück, mit der Anweisung, neu zu fragen.

**Wer darf eingeben.** Wie heute nur das Fenster der Maschine (`Save this in this machine's own Tau window.`). Telefon und Read-only-Geräte sehen die Karte mit diesem Hinweis.

**Architektur.**
- Die allgemeine Secret-Anfrage gehört aus dem Scheduling-Kit in eine eigene Erweiterung oder in einen Host-Dienst; der Begriff in `CONTEXT.md` muss um "file for a command" erweitert werden.
- Ort: ein Ordner `0700` unter dem State-Ordner, Datei `0600`, nie im Workspace oder in Git, und je Thread getrennt.
- Kritisch: Die Sandboxes von Claude Code, Codex und Pi müssen diesen Pfad lesen dürfen. Für jede Runtime muss eine Leseerlaubnis genau für diese Datei nachgewiesen sein.
- Das Löschen muss Neustarts überleben: Ablaufzeiten persistieren und beim Start aufräumen.
- Ob Full-Access-Geräte eingeben dürfen, ist eine eigene Sicherheitsentscheidung. Heute gilt Owner-only, wie bei der Verbindungsverwaltung in ADR 0023/0024.

## 8. Verpflichtende Forgejo-Checks und GitHub-Maintainer-Edits

### 8a. Required checks bei Forgejo

Module: `kits/review/provider-forgejo.ts` (`parseForgejoChecks` aus Commit-Status, keine Pflichtinformation), `pull-request-logic.ts` (`checksRollup`, `ROLLUP_TITLES`, `checksSummary`), `pr-watch-host.ts`.

**Anzeige.** Meldet der Server Branch-Protection-Kontexte (inklusive Globs), wird die Checkliste in `Required` und `Other` gruppiert. Jede Pflichtzeile trägt `Badge` `Required`. Ein erwarteter, aber noch nicht gemeldeter Pflicht-Check erscheint als ausstehende Zeile `Waiting for "<context>" to report`.

Rollup und Zusammenfassung zählen nur Pflicht-Checks: `2 of 3 required checks passed`. Ein fehlgeschlagener optionaler Check bleibt in `Other` rot sichtbar, mit dem Zusatz `Not required`. `skipped` blockiert nicht.

**PR-Watch.** Ein Watch gilt als `done`, wenn alle Pflicht-Checks fertig sind. Er weckt bei einem Pflichtfehler wie heute bei jedem Fehler. Ein optionaler Fehler weckt einmal, mit dem Hinweis `optional`.

**Fallback.** Ohne lesbare Branch-Protection bleibt das heutige Verhalten, mit der Fußnote `Required checks unknown: Tau can't read this branch's protection rules.`

**Architektur.** Lesen der Branch-Protection über `tea api` braucht Repo-Rechte. Globs müssen begrenzt gematcht werden; upstream hing dabei die Event-Loop. Das Feld `required?: boolean` an `PullRequestCheck` passt auch für GitHub und GitLab, bleibt aber in Runde 1 auf Forgejo/Gitea begrenzt. Für `checksRollup` mit und ohne Pflichtinformation braucht es neue Tests.

### 8b. GitHub-Maintainer-Edits

Module: `kits/review/pull-request-header-actions.tsx` (Aktionsmenü), `publish-form.tsx`, `protocol.ts` (`headRepository`).

**Sichtbar nur**, wenn alle Bedingungen gelten: GitHub, PR offen, Kopf aus einem Fork (`headRepository` ≠ Basis), die angemeldete Person darf die Einstellung ändern, und `maintainerCanModify` ist bekannt.

**Bedienung.** Im Aktionsmenü steht ein Umschalteintrag `Allow edits from maintainers` mit Häkchen. Beschreibung: `Maintainers can push to this branch. If your fork has workflows, this can also give them access to its secrets.` Ein Klick schließt das Menü nicht, setzt den Wert sofort und zeigt `Saving…` im Eintrag. Bei einem Fehler springt der Wert zurück, Toast `Couldn't save maintainer access.` mit der Ursache. Read only: deaktiviert mit Standardgrund. Auf compact steht der Eintrag als Switch-Zeile im Aktions-Sheet.

**Beim Veröffentlichen aus einem Fork** gibt es im Publish-Formular eine Checkbox mit demselben Text, Standard an wie bei GitHub.

**Architektur.** `maintainerCanModify` und das Recht `viewerCanUpdate` im PR-Read, Mutation `updatePullRequest`. `Menu` braucht einen Checkbox-Eintrag (`menuitemcheckbox`) statt der heutigen Radio-Semantik von `selected`. Ein Optimistic-Wert darf nur bis zum ersten Read nach dem Speichern gelten, damit ein älterer, noch laufender Read ihn nicht zurücksetzt.

## Echte Blocker

1. **Gastfreigabe:** Ein neues Authentifizierungspublikum braucht einen ADR. Außerdem fehlt eine browservertrauenswürdige Adresse; ohne Tau Connect oder Tailscale funktioniert die Funktion für fremde Browser nicht.
2. **Secret-Dateien:** Für Claude Code, Codex und Pi ist nicht belegt, dass die Runtime-Sandboxes eine Datei außerhalb des Workspace lesen dürfen. Ohne diesen Nachweis ist die Funktion nutzlos oder zwingt zu einem breiteren Sandbox-Pfad.
3. **Dateivorschauen:** Parser-Abhängigkeiten und Bundlegröße. Die Parser gehören auf den Host, sonst sprengen sie das JS-Budget; jede Bibliothek braucht eine eigene Prüfung.
4. **Threadsuche:** Speicher-Engine und Extraktion je Runtime sind offen, und die Palette braucht eine Status-API.

Nicht blockierend, aber vorher zu klären: Für F6 die Registrierung von Erweiterungsbereichen. Für Snooze, Untermenüsuche und Maintainer-Edits jeweils eine kleine API-Ergänzung (`SettingsCardId "snooze"`, `PaletteMenu.searchable`, Checkbox-Menüeintrag). Für die Projekt-Promotion ein persistenter Marker statt der Pfadprüfung `isScratchWorkspace`.

Empfohlene Reihenfolge nach Aufwand und Risiko: 2a, 2b, 8b, 3, 2c, 5, 4 (Notebook-Bilder zuerst), 8a, 1, 7, 6.
