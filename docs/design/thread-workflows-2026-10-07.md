# Thread-Abläufe: PR-Watch, Goals, Automations, Secret-Eingabe, Tabs wieder öffnen

Entwurf vom 7. Oktober 2026. Prototyp: [thread-workflows-2026-10-07.html](thread-workflows-2026-10-07.html), eine Datei, im Browser zu öffnen. Grundlage sind die [Recherche vom 7. Oktober](../research/t3code-last-week-2026-10-07.md), der lokale T3-Checkout und Taus aktueller Stand bei `99baa12e`. Der Entwurf wurde zunächst als eigenständiger Prototyp geprüft und anschließend in Tau umgesetzt.

Englische Texte in Anführungszeichen sind vorgeschlagene UI-Texte. Mit **[Backend]** markierte Punkte beschreiben die beim Entwurf benötigten Erweiterungen. Die Umsetzung ergänzt diese Schnittstellen mit API 1.52.0.

## Ein Zustandsmodell statt vier Funktionen

Drei der Abläufe haben denselben Kern. Etwas außer dem Nutzer startet einen Turn: ein PR-Ereignis, die nächste Runde eines Goals oder ein Zeitplan. Tau behandelt das als **Wake**. Jede Wake-Quelle zeigt ihren Zustand in Wörtern derselben Familie und eine Stop-Aktion an derselben Stelle. Jeder Wake erzeugt im Transkript dieselbe Trennzeile.

| Baustein | Gilt für | Form |
| --- | --- | --- |
| Wake-Zeile im Transkript | PR-Ereignis, Goal-Fortsetzung, Automation-Start | zentrierte Zeile mit Haarlinien, Icon der Quelle, Text, Uhrzeit: „Woken by PR #42 · check `smoke` failed“, „Goal continued · turn 3“ |
| Statuszeile im Transkript | Start, Pause, Ende einer Quelle | kleine zentrierte Zeile in `--muted`, wie eine Compaction-Zeile |
| Stelle über dem Composer | PR-Watch, Goal | PR-Watch als Segment der vorhandenen PR-Leiste, Goal als Pille in der Pillenreihe (`control-pill`) |
| Warteschlange | Wakes während eines laufenden Turns | Wakes landen in der vorhandenen Queue und unterbrechen nie; Hinweis „Wakes wait for the current turn; they never interrupt it.“ |
| Wartet auf dich | Secret, blockiertes Goal, verpasster oder unklarer Lauf | Bernstein (`--warn`) wie eine Frage, in Rail, Pille und Automations-Badge |

Farben bleiben bei der bestehenden Semantik: Blau (`--info`) nur für laufende Arbeit (K70), Bernstein für „wartet auf dich“, Grün (`--done`, `--ready`) für bestätigt erledigt, `--fail` für fehlgeschlagen. Unklare Ergebnisse sind nie grün.

**Stop hält den Thread an; Pause und Ende betreffen eine Quelle.** Stop beendet den laufenden Turn, beendet die PR-Watches des Threads und pausiert sein Goal. Danach weckt nichts den Thread automatisch, bis der Nutzer ihn wieder anstößt. Wakes in der Queue werden verworfen; Nachrichten, die der Nutzer selbst eingereiht hat, bleiben, wie heute. Upstream verhält sich seit [T3 #16002](https://github.com/pingdotgg/t3code/pull/16002) vom 5. Oktober genauso: Stop beendet auch delegierte Aufgaben und PR-Watches. Eine einzige Statuszeile sagt, was Stop angehalten hat: „Stopped · goal paused · stopped watching PR #42. Nothing wakes this thread until you start it again.“ Ein Watch lässt sich danach bewusst neu starten, mit dem Auge in der Leiste. Pause im Goal-Popover verhindert nur die nächste Runde und lässt den laufenden Turn fertig werden. „End goal“, „Stop watching“ und der Automation-Schalter beenden je eine Quelle.

Native Hintergrundarbeit des Providers (Codex-Hintergrundjobs, native Sub-Agents) hält Stop nur an, wenn das Backend das Abbrechen bestätigt. Sonst sagt die Statuszeile ausdrücklich: „Work the runtime started in the background may still be running.“ Tau verspricht hier nicht mehr, als das Backend meldet. Tau-eigene Kinder (Agents Kit) behandelt der bestehende Abbruchweg; diese Spezifikation ändert ihn nicht. Das Runtime-Backend bleibt Eigentümer des Threads (ADR 0005). Goals sind eine optionale Fähigkeit des Backends, kein neuer Eigentümer.

## Belegte T3-Muster und Taus Anpassung

Quellen sind der lokale Checkout `7c0874a9` vom 6. Oktober (Branch `t3code/address-pr-closing-feedback`, sauber, nur gelesen) und die Upstream-PRs über `gh` (nur lesend). „Beobachtet“ heißt im Code oder in der PR-Beschreibung gelesen. Screenshots wurden nicht heruntergeladen.

### PR-Watch ([#15057](https://github.com/pingdotgg/t3code/pull/15057))

**Beobachtet:** Den Watch startet der Agent über das Tool `watch_pull_request`. In der Web-UI gibt es dafür nur den Menüeintrag „Watch for changes“ im „…“-Menü einer Zeile im Pull-Requests-Panel (`apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx:246-249`). Läuft der Watch, zeigt die Zeile ein Augen-Icon mit dem Tooltip „Watching: the agent wakes when checks finish, someone comments, or the branch conflicts“ (`:139`). In der Detailkarte steht dafür ein Segment mit dem Label „Stop watching #N“ (`ThreadDetailsPrRow.tsx:354-385`). Ein beendeter Watch hat keinen sichtbaren Zustand. Die Wake-Zahl, die der Vertrag führt (`wakes`), zeigt die UI nicht an. Der Server prüft einmal pro Minute. Der Watch endet bei Merge oder Close, nach zehn reinen Kommentar-Wakes in Folge und nach 15 Minuten ohne lesbaren Host. Im letzten Fall wird der Agent mit dem Grund geweckt.

**Tau:** Der Watch sitzt in der vorhandenen Leiste `review.pull-request-strip` (`kits/review/pull-request-strip.tsx`) und bekommt keine eigene Karte. Neu ist ein Segment zwischen den Checks und „Hide for this thread“:

| Zustand | Segment | Popover-Aktion |
| --- | --- | --- |
| aus, PR offen | nur Auge, Tooltip mit den vier Auslösern | (Klick startet direkt) |
| watching | Auge + „Watching“ + Wake-Zahl | „Stop watching“ |
| GitHub < 15 min nicht lesbar | Warnsymbol + „Can't read GitHub“ in `--warn` | „Stop watching“ |
| beendet | Auge durchgestrichen + „Watch ended“, gedämpft | „Watch again“, nur bei offenem PR |
| read-only-Gerät | Auge deaktiviert, Grund im Tooltip | keine |

Das Popover nennt seit wann, wann zuletzt gelesen, die vier Auslöser, die Wake-Zahl und alle Endbedingungen samt Zähler („now 2“ von 10). Es endet mit „Merging stays with you.“ **[Backend]**: Watch-Zustand pro Thread und PR im Review Kit, persistiert mit Fortschritt und deduplizierten Ereignissen. Wakes laufen über die Queue (`src/main/queued-messages.ts`), nie über Steering (T3 #15892). Stop und Settle beenden den Watch; `mod+z` stellt ihn mit dem Settle wieder her, Stop nicht. Dazu Agent-Tools `watch_pull_request` und `unwatch_pull_request`.

### Native Goals ([#15592](https://github.com/pingdotgg/t3code/pull/15592))

**Beobachtet:** Ein Goal entsteht nur über `/goal <objective>`. Web zeigt eine Banner-Zeile im Composer mit dem Statustitel (`packages/client-runtime/src/state/threadExecution.ts:381-436`): „Pursuing goal“, „Goal set“, „Goal paused“, „Goal blocked“, „Goal hit a usage limit“, „Goal reached its token budget“, „Goal complete“. „Resume“ und „Clear“ erscheinen nur, wenn der Thread ruht. Einen Pause-Button gibt es nicht: Pause kommt von Stop (Codex) oder von `/goal pause`. Mobile zeigt nur eine Status-Pille ohne Aktionen. Bei Claude im SDK-Modus erscheinen Evaluator-Timeout und „impossible“ als abgeschlossen.

**Tau:** Das Goal wird eine Pille in der Reihe über dem Composer, aus derselben Familie wie die Task-Pille (`src/renderer/components/TaskProgress.tsx`). Ein Klick oder ein ruhender Zeiger öffnet das Popover mit Objective, Tokens und Turns.

| Zustand | Pille | Aktionen im Popover |
| --- | --- | --- |
| active | Ziel-Icon blau, „Goal“, Tokens | „End goal“, „Pause“ |
| paused | Pause-Icon, „Goal paused“ | „End goal“, „Resume“ (gefüllt) |
| blocked | Bernstein, „Goal blocked“ | „End goal“, „Resume“ |
| budget | Bernstein, „Budget reached“ | „End goal“ |
| complete (vom Runtime bestätigt) | Grün, „Goal met“ | „Done“ |
| unconfirmed (Lauf endete ohne Urteil) | Bernstein, „Goal not confirmed“ | „Dismiss“, „Resume“ |

„Goal not confirmed“ ersetzt T3s falsches „complete“. Der Text dazu: „Claude Code stopped without a verdict. Tau doesn't know whether the goal is met; check the result before relying on it.“ Solange ein Goal aktiv ist, bleibt Stop im Composer sichtbar, auch zwischen zwei Turns, wenn gerade nichts läuft, die nächste Runde aber schon ansteht. Sein Tooltip nennt, was er anhält, zum Beispiel „Stop the turn, pause the goal, stop watching PR #42“. Zwischen zwei Turns heißt es „Stop: pause the goal before its next turn“. Pausieren geht damit immer mit einem Klick oder mit Escape, ohne Popover. „Pause“ im Popover lässt den laufenden Turn dagegen fertig werden. `/goal pause|resume|end` und `/goal` ohne Argument (öffnet das Popover) bleiben als Tastaturweg. **[Backend]**: optionale Fähigkeit `goals` am Runtime-Backend mit Status, Objective, Verbrauch, Pause, Resume und Clear. Codex leitet sie aus `thread/goal/*` ab. Claude meldet `unconfirmed`, wenn kein Urteil vorliegt. Der Codex-Toolfilter (`kits/codex/tools.ts:16`, `goals` in `NEVER`) muss diese Fähigkeit pro Thread freigeben.

### Bedienbares Scheduling ([#15085](https://github.com/pingdotgg/t3code/pull/15085), [#15088](https://github.com/pingdotgg/t3code/pull/15088))

**Beobachtet:** In den Einstellungen gibt es die Seite „Scheduled tasks“ (`ScheduledTasksSettings.tsx`, 1360 Zeilen). Jede Zeile zeigt Schalter und „…“-Menü (Edit, Deliveries oder Run now, Delete) sowie den Status `<schedule> · <state>`. Der Status zeigt den rohen `lastRunStatus` ohne Übersetzung. Der Editor ist lang; der Dreifach-Umschalter „At a time / Every interval / On webhook“ tauscht die untere Hälfte aus. Dazu kommt ein Abschnitt „Automations“ in den Thread-Details. Für Fehler gibt es nur Toasts. Einen eigenen Zustand für verpasste oder unklare Starts zeigt die UI nicht.

**Tau:** Das bestehende Kit (`docs/scheduling.md`) kennt schon `held`, `failed`, `uncertain` und eine `resolve`-Entscheidung. Die UI macht diese Zustände sichtbar, ohne sie in einem allgemeinen Retry zusammenzufassen. Automations wird eine **App-Seite** wie Usage und Reviews, mit einem Eintrag im Rail-Fuß und einem Bernstein-Badge, wenn etwas auf dich wartet. Die Zeilen sind gruppiert: „Needs you“, „Running“, „Scheduled“, „Off“.

| Kit-Status | Statuszeile (Beispiel) | Sichtbare Aktionen | Im „…“-Menü |
| --- | --- | --- | --- |
| ready, an | „Next: Tomorrow 07:00 UTC · Last run today 07:00 · finished“ | Schalter | Run now, Open last thread, Edit, Delete |
| ready, aus | „Off“ | Schalter | Run now, Edit, Delete |
| held | „Missed 02:30 UTC: this Mac was asleep. Not run.“ | „Run now“, „Skip“ | Delete (Edit erst nach Entscheidung) |
| failed | „Couldn't start: the runtime codex@work isn't available on this host“ | „Try again“, „Skip“ | Delete |
| uncertain | „Tau restarted while starting the 06:00 UTC run. Unclear whether a thread started.“ | „Find its thread“, „Resolve…“ | Delete |
| running / starting | „Running since 08:12 UTC“ | „Open thread“ | alles deaktiviert: „Running automations can't be changed“ |

„Resolve…“ öffnet einen Dialog mit der Frage „Did “Morning CI digest” start?“, dem möglichen Treffer und zwei Optionen. „Skip this run“ ist vorausgewählt. „Run it again now“ verlangt das Häkchen „I checked the threads: running again may create a second …“; das entspricht `acknowledgeDuplicateRisk`. Der Dialog sagt: „Either way the automation turns off.“ Das entspricht dem Kit-Vertrag. Ist Scheduling global aus, steht oben ein Banner, und „Run now“ ist mit Grund deaktiviert.

Der Editor hat sechs Felder: Name, Prompt, Project, Runtime (nur Icons, Name im Tooltip), When („Every day“ / „Once“), Uhrzeit in UTC mit lokaler Entsprechung. Dazu kommt das Häkchen „Start on schedule“. Projekt und Runtime übernimmt er aus dem zuletzt aktiven Thread. Paired devices sehen die Seite nur lesend, mit Grund; das entspricht dem Kit-Vertrag. **[Backend]**: keines für die erste Version. Die Seite nutzt `list`, `create`, `update`, `enable`, `disable`, `delete`, `set-enabled`, `run`, `resolve` und das `state`-Event. „Find its thread“ braucht nur die vorhandene Rail-Suche. Webhooks kommen später, mit der Secret-Referenz als Signaturschlüssel.

### Private Secret-Eingabe ([#15907](https://github.com/pingdotgg/t3code/pull/15907))

**Beobachtet:** `apps/web/src/components/chat/SecretRequestCard.tsx` zeigt eine Karte im Transkript mit Label, Grund und maskiertem Textfeld. Das Feld nutzt `-webkit-text-security`, ist also kein Passwortfeld und löst keinen Speichern-Dialog aus. Der Platzhalter lautet „Paste the secret“. Dazu kommen „Save securely“, der Hinweis „Stored securely, never shown to the agent“ (`packages/client-runtime/src/secretRequest.ts:9`) und ein leiser Button „Decline“. Ist die Anfrage beantwortet, bleibt eine Zeile: „Saved securely and kept private“, „Declined“ oder „Request ended“. Die Regel „einmal verwendbar, 24 Stunden gültig“ zeigt die UI nicht an.

**Tau:** Die Karte dockt über dem Composer an, so wie Fragen und Freigaben in `ExtensionPrompt` (`.extension-prompt`, design 1c). Sie liegt nicht als Karte im Transkript. Dort erwartet man in Tau Antworten an den Agenten. Kopf der Karte: „Secret“ in Bernstein und der Verbraucher („for the webhook signature of “CI failure triage””). Darunter Label, Grund, Feld, „Save privately“ als einzige gefüllte Aktion und „Decline“. Die Fußzeile sagt, wofür der Wert dient: „Used only to verify this webhook. Never included in the conversation.“ Eine Zeichenzahl („32 characters“) bestätigt das Einfügen, ohne den Wert zu zeigen. Ist der Composer leer, geht der Fokus beim Erscheinen ins Feld; enthält er Text, bleibt der Fokus dort. Escape im Feld führt zum Composer zurück und lehnt nicht ab. Stop beendet die Anfrage mit „Request ended“. Read-only-Geräte sehen ein deaktiviertes Feld und den Grund.

**Verbraucherschnittstelle [Backend].** Eine Referenz löst nur ein **typisierter, host-eigener Verbraucher** auf, den ein Kit registriert, etwa `webhook-signature` des Scheduling Kits. Der Verbraucher benutzt den Wert im Host-Prozess. Er gibt ihn nie an einen Prozess, den der Agent steuert: keine Umgebungsvariable, kein Argument, keine Datei für Shell, Skript oder Tool. Sobald ein Wert einen agentengesteuerten Prozess erreicht, kann Tau nicht verhindern, dass er über stdout oder Logs ins Modell gelangt. Deshalb gibt es keinen allgemeinen Verbraucher „an ein Skript übergeben“. `request_secret` nennt den Verbrauchertyp und sein Ziel (Automation, Webhook). Die Karte zeigt beides, und eine Referenz gilt nur für genau dieses Ziel. Zwei Dinge sind zu trennen. Die **Einrichtungsreferenz**, die der Agent erhält, ist projektgebunden, kann einmal an den Verbraucher gebunden werden und verfällt ungenutzt nach 24 Stunden; das bleibt intern und steht nicht in der Karte. Der **gebundene Wert**, hier der HMAC-Schlüssel des Webhooks, gehört danach dem Verbraucher. Er prüft damit jede Delivery, bis der Nutzer ihn ändert oder die Automation löscht. Nach dem ersten Check oder nach 24 Stunden wird er nicht gelöscht. Der Wert darf nicht in Eventlog, Session-Datei, Crash-Report oder Modellkontext landen. Server-Targets brauchen diesen Weg nicht: Das Servers Kit fragt Passwörter schon über seinen eigenen Askpass-Dialog ab (`kits/servers/askpass.test.ts`, `kits/servers/prompt-dialog.tsx`).

### Geschlossene Stage-Tabs wieder öffnen ([#15207](https://github.com/pingdotgg/t3code/pull/15207))

**Beobachtet:** Der lokale Checkout enthält die Funktion noch nicht; sie ist auf main gemergt. Laut PR öffnet Cmd/Ctrl+Shift+T die letzten 20 Tabs wieder, auch über Threadwechsel hinweg. Ein Browser-Tab bekommt eine neue Session. Sichtbar ist das nur über den Shortcut.

**Tau:** Die Stage gehört zum Thread. Deshalb führt jede Stage eine eigene Historie mit höchstens 20 Einträgen, gespeichert mit den Tabs (plain JSON, `src/workbench/stage.ts`). Zugänglich ist sie über das Menü „All tabs“: Abschnitt „Recently closed“ mit Kürzel am ersten Eintrag. Ist die Stage leer, gibt es „Reopen <tab>“. Ein Terminal öffnet als neue Shell im selben Ordner; der Toast sagt das. Eine Preview öffnet die URL ohne Verlauf. Ein schon offener Tab wird nur aktiviert. Prozesse werden nie gespeichert.

**Konflikt:** `mod+shift+t` ist heute `runtime.transcript-detail` (`docs/keybindings.md`). Empfehlung: Reopen bekommt `mod+shift+t`, weil Browser, Editoren und T3 das so halten. Transkript-Detail wechselt auf das freie `mod+alt+t`.

## Platzierung im Überblick

| Ablauf | Desktop | Web, schmal (≤ 980 px) | Telefon (≤ 560 px) |
| --- | --- | --- | --- |
| PR-Watch | Segment in der PR-Leiste, Popover nach oben | gleich | Leiste ohne Repo und Branch, Popover als Bottom Sheet |
| Goal | Pille über dem Composer | gleich | Pille 36 px, Popover als Bottom Sheet, Buttons 44 px |
| Wake- und Statuszeilen | Transkript | gleich | gleich |
| Secret | angedockt über dem Composer | gleich | Feld volle Breite, 44 px, Save über die volle Breite |
| Automations | App-Seite aus dem Rail-Fuß | eigene Seite, Rail als Overlay | eigener Screen, Editor und Dialoge als Bottom Sheet |
| Tabs wieder öffnen | Kürzel und „All tabs“-Menü | Stage als Overlay über dem Gespräch | Menü „All tabs“; Kürzel nur mit Hardware-Tastatur |

### Gemeinsame Breitenregel (verbindlich)

Alles im Gesprächsbereich steht in **einem Inhaltsrahmen**: Transkript, PR-Leiste, Queue, Pillenreihe mit Goal, angedockte Karten (Frage, Freigabe, Secret) und Composer. Der Rahmen ist höchstens `780px` breit und mittig. Links und rechts hält er denselben Abstand zur Spalte: `32px`, im schmalen Fenster (≤ 560 px Spaltenbreite) `12px`. Auf dem Desktop haben alle diese Elemente dieselben Außenkanten. Schmal und auf dem Telefon füllen sie die verfügbare Breite mit denselben Abständen. Kein Element rechnet seine Breite selbst aus.

Umsetzung: Zwei Custom Properties am Gesprächsbereich (`--content-max`, `--content-inset`) und ein Rahmen-Element, das jede Region benutzt. Transkript und Dock liegen in einem gemeinsamen Scroller, das Dock klebt unten (`position: sticky`), so wie heute schon das Transkript unter dem Dock weiterläuft (`ComposerReserve.tsx`). So verschiebt eine Scrollbar nicht die eine Region gegen die andere.

Heute steht dieselbe Breite in Tau an mehreren Stellen. `max-width: 780px` haben `.transcript-inner`, `.composer-surface`, `.composer-frame`, `.extension-prompt` und `.prompt-arrival-note` (`src/renderer/styles.css`), jeweils als eigene Regel. PR-Leiste: `.review-pr-strip` mit `width: min(780px, calc(100% - 64px))` und einer eigenen Media-Query auf die Fensterbreite (`kits/review/styles.css`). Die Media-Query auf die Fensterbreite passt nicht zur Spalte, sobald Stage oder Rail Platz nehmen. Bei der Umsetzung der ersten Scheibe sollen Leiste, Watch-Segment, Goal-Pille und Secret-Karte den gemeinsamen Rahmen benutzen und keine eigene Breite mehr führen. Der Produktcode ist in diesem Entwurf unverändert.

Gemessen im Prototyp (linke und rechte Kante in px, mit offener Goal-Pille und mit offener Secret-Karte): Desktop 312–822, Breite 760 372–1068, Telefon 390 537–903. Transkript, Leiste, Pillenreihe, Karte und Composer liegen jeweils exakt übereinander.

## Häufige Abläufe: Schritte und sichtbare Aktionen

Gezählt sind Klicks oder Tasten ab dem Thread. T3-Werte stammen aus dem gelesenen Code.

| Aufgabe | T3 | Tau-Entwurf | Gleichzeitig sichtbare Aktionen in Tau |
| --- | --- | --- | --- |
| PR beobachten | Panel öffnen, „…“, „Watch for changes“: 2–3 | Auge in der Leiste: 1, oder der Agent selbst: 0 | Leiste: Öffnen, Auge, Ausblenden |
| Watch beenden | Segment in der Detailkarte: 1 | „Watching“, „Stop watching“: 2 (mit Erklärung) · Stop des Threads: 1 | Popover: 1 |
| Watch-Grenzen erkennen | nicht sichtbar | Popover: 1 | — |
| Goal setzen | `/goal …` Enter: 1 | `/goal …` Enter: 1; `/` schlägt `/goal` vor | Composer + Goal-Pille |
| Thread anhalten (Turn, Goal, Watch) | Stop (seit #16002 inkl. Watches) | Stop, auch zwischen Goal-Turns: 1 · Escape: 1 | Composer: Stop |
| Goal pausieren, Turn fertig laufen lassen | `/goal pause` | Pille, Pause: 2 · `/goal pause`: 1 | Popover: 2 |
| Goal fortsetzen | Banner „Resume“: 1, nur im Ruhezustand | Pille, Resume: 2 · `/goal resume`: 1 | Popover: 2 |
| Automation anlegen | Einstellungen, Seite, „New task“, ca. 8 Felder, „Create task“ | Rail-Fuß, „New automation“, 4 Pflichteingaben (Name, Prompt, Zeit, Art), „Create“ | Dialog: Cancel, Create |
| Verpassten Lauf klären | nicht vorhanden | „Run now“ oder „Skip“: 1 | Zeile: 2 + Menü |
| Unklaren Lauf klären | nicht vorhanden | „Find its thread“, „Resolve…“, Wahl, ggf. Häkchen, Bestätigen: 3–4 | Dialog: 2 |
| Secret liefern | Feld anklicken, einfügen, Save: 3 | Einfügen, Enter: 2 (Fokus ist schon da) | Karte: Save, Decline |
| Tab wieder öffnen | Kürzel: 1 | Kürzel: 1 · Menü „All tabs“, Eintrag: 2 | Menü |

## Tastatur und Barrierefreiheit

- Neue Befehle in der Palette: „Watch pull request“ / „Stop watching“, „Pause goal“ / „Resume goal“ / „End goal“ (nur wenn passend), „Automations“, „New automation“, „Reopen closed tab“. Neue Standardkürzel gibt es nur für Reopen.
- Beim Öffnen fokussiert ein Popover die häufige, sichere Aktion: „Pause“ bei aktivem Goal, „Resume“ bei pausiertem oder blockiertem Goal, „Dismiss“ bei unbestätigtem, „Done“ bei erreichtem Goal, „Watch again“ bei beendetem Watch. Bietet ein Popover als einzige Aktion ein Ende an („Stop watching“), bekommt das Popover selbst den Fokus, damit Enter nichts versehentlich beendet. Menüs fokussieren ihren ersten Eintrag.
- Pillen und Leistensegmente sind Buttons mit `aria-haspopup="dialog"` und `aria-expanded`. Escape schließt das Popover und gibt den Fokus an den Auslöser zurück (Regel aus `docs/keybindings.md`). Escape mit offenem Popover stoppt nie einen Turn.
- Wake- und Statuszeilen sind `role="note"` im vorhandenen Live-Bereich des Transkripts. Vorgelesen wird „Watching PR #42“, „Goal paused“ und „Wake queued until the current turn ends“.
- Das Secret-Feld hat `autocomplete="off"`, `spellcheck="false"` und `autocapitalize="off"` und ist über `aria-describedby` mit Grund und Datenschutzhinweis verbunden. Diktat ist im Feld aus **[Backend]**: Die Diktat-Komponente darf es nicht als Ziel annehmen. Die Zeichenzahl wird höflich angesagt.
- Stage-Tabs: Pfeiltasten wechseln den Tab, Entf schließt. Das Menü „All tabs“ ist ein `role="menu"`.
- Alle Farben sind Tokens aus `src/renderer/tokens.css` und erfüllen dort schon AA. Zustände tragen immer auch Icon und Text. Die Bewegung folgt `prefers-reduced-motion`.

## Fehler, Abbruch und Wiederaufnahme

- **Stop:** hält Turn, Watches und Goal an (siehe oben). Ob native Hintergrundarbeit des Providers mit endet, zeigt die Statuszeile nur als sicher an, wenn das Backend es bestätigt.
- **Neustart von Tau:** Watches werden mit Fortschritt wiederhergestellt. Ein Ereignis, das schon geweckt hat, weckt nicht erneut **[Backend]**. Goals behalten ihren Zustand vom Backend; ein laufendes Goal erscheint nach dem Neustart als „Goal paused“, bis der Nutzer es fortsetzt. Automations, die gerade starteten, werden `uncertain` (Kit-Vertrag). Ein offenes Secret wird „Request ended“.
- **Host oder GitHub nicht erreichbar:** „Can't read GitHub“ in Bernstein. Nach 15 Minuten endet der Watch, und der Agent wird mit dem Grund geweckt. Die UI zeigt nie „Watching“, wenn nichts gelesen wird.
- **Wake während eines Turns:** Er kommt in die Queue, sichtbar über dem Composer. Turns werden nie unterbrochen.
- **Lese-Geräte:** Jede schreibende Aktion ist mit „This paired device is read-only. Change it on the host's own window.“ deaktiviert.
- **Speichern des Secrets schlägt fehl:** „Couldn't save the secret. Nothing was sent to the agent. Try again.“ Das Feld wird geleert.

## Erste Umsetzungsscheibe

**PR-Watch im Review Kit, mit der gemeinsamen Wake-Zeile.** Die Recherche stellt das an erste Stelle. Diese Scheibe legt außerdem das Wake-Muster an, das Goals und Automations später übernehmen.

1. Host: Watch-Zustand pro Thread und PR, persistiert. Fingerprint-Abfrage einmal pro Minute über die vorhandene Forge-Schnittstelle; vorher Prozesse und API-Aufrufe zählen (Recherche, Abschnitt „PR-Beobachtung“). Wakes über die Queue, dedupliziert. Endbedingungen: merged/closed, Stop, Settle, 10 Kommentar-Wakes in Folge, 15 Minuten unlesbar.
2. Agent-Tools `watch_pull_request` und `unwatch_pull_request`; `list_thread_pull_requests` meldet `watching`.
3. Renderer: Watch-Segment und Popover in `pull-request-strip.tsx`, Wake-Zeile und Statuszeile im Transkript, Befehle in der Palette.
4. Abnahme in der isolierten Instanz (`.agents/skills/test-tau-app/SKILL.md`): starten, fehlgeschlagenen Check aufwecken lassen, Wake während eines laufenden Turns landet in der Queue, Stop beendet Turn und Watch und verwirft eingereihte Wakes, Settle beendet den Watch, Neustart weckt nicht doppelt.

**Daneben, als kleiner eigener PR:** Reopen in `src/workbench/stage.ts` mit Historie, Menüabschnitt und Neubelegung des Kürzels.

**Danach:** Automations-Seite (kein Backend nötig), dann Goals (Backend-Fähigkeit), dann Secret-Dienst zusammen mit Webhook-Auslösern.

## Offene Entscheidungen

1. **Kürzel:** Reopen auf `mod+shift+t` und Transkript-Detail auf `mod+alt+t`? Empfehlung: ja.
2. **Name der Seite:** „Automations“ (später auch Webhooks) oder „Schedules“? Empfehlung: „Automations“. Die Threads heißen weiter „Scheduled: …“.
3. **Bearbeiten schaltet aus:** Der Kit-Vertrag deaktiviert einen Job bei `update`. Soll die Seite nach dem Speichern selbst wieder einschalten, wenn der Job vorher an war? Empfehlung: ja, als zweiter Befehl derselben Speicheraktion, und das Häkchen „Start on schedule“ zeigt das an.
4. **Goal nach Neustart:** Als „paused“ anzeigen (Empfehlung) oder sofort weiterlaufen lassen, falls das Backend es kann?
5. **Historie der Stage:** pro Thread (Empfehlung, passt zu „each thread has its own stage“) oder fensterweit wie bei T3?
6. **Erster Secret-Verbraucher:** Der Prototyp zeigt die Webhook-Signatur, einen typisierten Verbraucher im Host. Damit hängt der Secret-Dienst an Webhook-Auslösern. Gibt es vorher einen anderen typisierten Verbraucher, der früher kommen soll? Ein Verbraucher, der Werte an Skripte weiterreicht, ist ausgeschlossen (siehe Verbraucherschnittstelle).
7. **Glossar:** „Wake“, „Watch“, „Goal“, „Automation“ und „Secret reference“ in `CONTEXT.md` aufnehmen, sobald die erste Scheibe gebaut ist.

## Prototyp

Die Leiste über dem Rahmen gehört nicht zu Tau. Sie wählt Szenario, Thema, Breite (Desktop, 760, 390) und Gerät („Host window“ oder „Paired, read-only“). Gestrichelte Buttons simulieren Ereignisse von GitHub, Runtime oder Host. Interaktiv sind: Watch starten, Wakes, Queue während eines Turns, Stop beendet Turn und Watch und pausiert das Goal, Watch beenden oder Ende durch Merge, Limit oder Unerreichbarkeit; Goal per `/goal` setzen, Pause, Resume, End, Stop pausiert, bestätigt, unbestätigt, blockiert, Budget; Automations anlegen, schalten, löschen, held/failed/uncertain klären, Scheduling global aus; Secret speichern, ablehnen, Fehler, Abbruch durch Stop; Tabs schließen und wieder öffnen über Alt+Shift+T (⌘⇧T gehört im Browser dem Browser), das Menü oder den leeren Zustand. Der Prototyp speichert nichts. Ein eingegebenes Secret steht nur bis zum Speichern oder Ablehnen im Feld.

## Umgesetzter Stand

PR-Watches, native Goals, Automations mit signierten Webhooks und privater
Schlüsseleingabe sowie die Historie geschlossener Stage-Tabs sind implementiert.
Transcript, Composer und ergänzende Leisten verwenden denselben Breitenrahmen.
Die Bedienung und die Host-Schnittstellen sind in [features.md](../features.md),
[pr-watch.md](../pr-watch.md), [scheduling.md](../scheduling.md) und
[EXTENSIONS.md](../EXTENSIONS.md) beschrieben.

Goals folgen den tatsächlichen Fähigkeiten: Codex kann pausieren; Claude Code
kann das Ziel beenden, aber nicht pausieren. Pi bietet keine nativen Goals.
PR-Watches unterstützen GitHub mit vollständiger Abdeckung bis zu 100 Checks
und 100 Review-Threads. Webhook-Schlüssel benötigen einen unterstützten
OS-Speicher; externe Sender erreichen den lokalen Endpunkt über eine separat
konfigurierte Weiterleitung.
