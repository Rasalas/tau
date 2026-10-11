# T3 Code, 7. bis 11. Oktober 2026

Recherche am 11. Oktober im lokalen T3-Checkout (`origin/main`, Squash-Commits und PR-Beschreibungen). Das Fenster beginnt beim HEAD der [Vorwoche](t3code-last-week-2026-10-07.md), `453e596d` vom 7. Oktober, und endet bei `bed92398` vom 11. Oktober 19:13 UTC. Es umfasst 416 Commits. Ein neues Stable gibt es nicht. Seit v0.0.45 erscheinen nur Nightlies `0.0.46-nightly.*`, zuletzt `20261011.2980`.

Tau-Stand: main `1a936c52`. Alles wurde aus Code und Tests gelesen und nicht in der laufenden App geprüft. Als „Bug“ markierte Punkte sind belegte Fehlerklassen und nicht reproduziert.

## Stand der Empfehlungen vom 7. Oktober

| Vorschlag | Stand |
| --- | --- |
| PR-Watch mit Agent-Wake | umgesetzt (#50, #53, #71, #78, #79, #86) |
| Native Goals | umgesetzt (#50) |
| Scheduling bedienbar, Webhooks | umgesetzt (#50: Seite, Editor, Webhooks, `kits/scheduling/webhooks.ts`) |
| Private Secret-Eingabe | umgesetzt (`kits/scheduling/secrets.ts`, `request_secret`) |
| Geschlossene Stage-Tabs wieder öffnen | umgesetzt (`reopenClosedTab`, `src/workbench/stage.ts:310`, ⌘⇧T) |
| Interaktive HTML-Ergebnisse | offen, siehe Paket „Sandbox-Frame“ |

## Was T3 in diesen vier Tagen gebaut hat

- **Guided Reviews** (#18124, #18143, Mobile #18267): Eine Tour durch einen PR mit 2 bis 8 Stopps. Jeder Stopp hat Absicht, „Look closely“-Hinweis, Diff-Ausschnitte, verankerte Notizen und Fragen. Ein serverseitiger Modelllauf schreibt sie read-only in einem Wegwerf-Worktree. Ein Normalizer schneidet die Ausschnitte auf die geänderten Hunks zu und hängt vergessene Dateien als Skim-Stopp an. Agenten stoßen Guides per MCP an (`write_pull_request_guides`) und lesen sie (`read_pull_request_guide`, mit `stale`).
- **MCP Apps inline** (#16236 und vier Folge-Fixes): `ui://`-Ressourcen von MCP-Servern laufen als Sandbox-Iframe im Thread, mit opaker Origin, injizierter CSP, Brücke über `postMessage` und gespeichertem HTML. Das gilt nur für Codex.
- **Native Pull-Requests auf Mobile** (#18126).
- **Provider pro Projekt ein/aus** (#17879), mit Erzwingung beim Start, Senden und Delegieren.
- **Lineage:** einzelne Claude-Subagents stoppen (#17826), Stop beim Hovern statt Timer (#16791), Effort in der Hover-Karte (#17496), Claude-Workflow-Phasen (#12598), Hinweis auf wartende Subagent-Fragen beim Eltern-Thread (#16634), letzter Gedanke in der Live-Zeile (#16284).
- **Suchen:** im ganzen Thread inklusive Plänen (#10439), in Diffs (#14623), Threads nach PR-Nummer (#14658).
- **Source Control:** Host-Pakete mit Client-Definition und Fähigkeiten (#17746, #17774, #17667), GitCafe, Azure DevOps, Forgejo, Bot- und Resolved-Filter für Kommentare (#17645), Bestätigung direkt im Panel (#17710).
- **Usage:** Antigravity-Quota (#17530), Provider-Filter (#16970), Seite in unter einer Sekunde (#17147).
- **Desktop:** Tabs per Drag sortieren (#17730), T3 als Standardbrowser (#17587), Passkeys (#16952), `t3`-Befehl aus den Settings (#16683), OTLP-Export (#12538), JetBrains über SSH (#17271), `.icns` als Projekt-Icon (#17149).
- **Etwa zwölf Pi-Fixes.** T3 startet Pi als RPC-Kindprozess, Tau bettet das SDK ein. Die meisten Fixes treffen Tau deshalb strukturell nicht (Details unten).

## Befunde in Tau

### Sicherheit

1. **MCP-Token in der argv der Claude-CLI** (T3 #17408, #17898). `tauMcpOptions` gibt den Tau-Endpunkt mit `Authorization`-Header in `Options.mcpServers` (`kits/claude-code/runtime-adapter.ts:241-246`). Das SDK reicht das als `--mcp-config <JSON>` auf der Kommandozeile weiter. Jeder lokale Nutzer liest das Token mit `ps`, bis der Thread endet. Codex macht es richtig, über `bearer_token_env_var` (`kits/codex/mcp.ts`). Abhilfe wie bei T3: `query.setMcpServers()` über den Control-Channel nach `query()` in `ClaudeSdkSession.start()` (`kits/claude-code/sdk-session.ts`). Die Variante mit Umgebungsvariable hat T3 selbst verworfen, weil jedes Agent-Kommando sie erbt. **S–M.**
2. **Access-Gate lässt fremde Tools durch** (verwandt mit T3 #17852). `MUTATING_TOOLS` kennt fünf Namen plus `computer_use_*` (`kits/access/gate.ts:8`). Alles andere gilt als lesend, auch Tools aus Projekt-Extensions und `mcp__*`. „read-only“ blockiert sie nicht, „ask“ fragt nicht. Pi 1.0.0 liefert `ToolDefinition.annotations.readOnlyHint` ausdrücklich für Permission-Extensions. Tau liest es nirgends. Vorschlag: Bekannte Tau-Tools bleiben wie bisher. Unbekannte Tools mit `readOnlyHint` aus erwarteter Quelle laufen durch, alle übrigen fragen beziehungsweise werden geblockt. **M.**

### Bugs, die Tau wahrscheinlich hat

| Fund | Beleg | Größe |
| --- | --- | --- |
| Check-Zeile zeigt „passed“, obwohl ein früher gestarteter Lauf noch läuft (T3 #17344) | `parseGitHubChecks` behält pro `workflow\0name` den Eintrag mit dem neuesten `startedAt` (`kits/review/pull-request-json.ts:130-132`). Der PR-Watch ist nicht betroffen (`pr-watch-github.ts` wertet die rohen Contexts aus). | S |
| Erster Thread eines neuen Projekts landet im Worktree (T3 #17371) | `defaultWorkspaceMode` folgt der globalen Vorgabe, auch für ein frisches Repo mit nur „Initial commit“ (`kits/workspace/store.ts:258-262`, `project-starts.ts:57`) | S |
| Squash-Cleanup prüft keinen Head-SHA (T3 #14847) | Nur `requestMerged` zählt (`kits/workspace/worktree-storage.ts:356`). Ein nachträglich gepushter Commit oder ein wiederverwendeter Branchname mit altem gemergten PR verhindert das Entfernen nicht. | S |
| Eltern-Thread hört nichts, wenn ein Kind mit gehaltener Queue gestoppt wird (T3 #17028) | Der Zähler `expecting` sinkt nur bei Turn-Ende (`kits/agents/host.ts:1447`). Eine gehaltene zweite Nachricht startet nie, also kommt keine Fertigmeldung. Ein Test fehlt. | S–M |
| Nachricht während `navigateThreadTree` mit Zusammenfassung (T3 #17079) | `navigateThreadTree` prüft nur `streaming`, `prompt()` wartet nicht auf die Lifecycle-Queue (`src/main/pi-host.ts:1450-1460`) | S |
| Draft zeigt Skills des aktiven Threads statt des Draft-Projekts (T3 #17190) | `composerCommandsFor("pi", …)` ignoriert `cwd` (`src/main/pi-host.ts:1500`). Vor dem Fix in der App prüfen. | S–M |
| Favoriten: der letzte Schreiber gewinnt zwischen Clients (T3 #16816) | `toggleFavouriteModel` sendet die ganze Liste, das Echo überschreibt (`src/renderer/preferences.ts:262, 477`). `disabledExtensions` löst das schon mit `followHostList`. | S |
| Codex: Tier „Ultrafast“ kann im Picker fehlen (T3 #18200) | `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` ist beim Spawn nicht gesetzt (`kits/codex/host.ts:387`). Mit ChatGPT-Login in der App prüfen. | S |
| Markdown-Anker `#…` öffnen ein neues Fenster (T3 #16950) | Überschriften haben keine `id` (`markdown-pipeline.ts:162`), `FileLink` setzt `target="_blank"` (`Markdown.tsx:311`) | S |
| Lange Prompt-Nachricht schiebt die Buttons aus dem Bild (T3 #17962) | `.extension-prompt-message` ohne `max-height` (`src/renderer/styles.css:1669`) | S |
| Compact-Angebot ignoriert den echten Cache-TTL (T3 #17945) | Claude fest 1 h (`kits/claude-code/thread-backend.ts:95`), die Regel fest 70 min (`kits/resume-compaction/rule.ts:5-14`). API-Key-, Bedrock- und Pi-Threads (5 min) bekommen das Angebot zu spät. | S |

### Schon vorhanden oder strukturell nicht betroffen

PR aus einem dirty Worktree (#15625), verknüpfte PRs ohne Checkout (#17167), Settle, sobald ein Client den Merge sieht (#16761), Turn-Dateien ohne Pull und Rebase (#17161), Worktree vor dem Thread anlegen (#17654), sichtbare Cleanup-Blocker (#17563, #15834), Projektpicker mit Suche (#17664), maximierte Stage pro Thread (#17327), Prompt wartet 1,5 s nach dem Tippen (#17637), Vorschau vor der ersten Nachricht (#17352), Pi-Usage (#17848), ablaufende Extension-Dialoge (#17840), Exit-Codes (#17834), Editor-Prefill (#17206), Restart-Hinweis (#17723), Resume auf dem gewählten Modell (#17867), Subagent-Karten nach Turn-Ende (#16878, #16486), gestoppte Subagents nicht „Running“ (#17223), ausgeloggte Claude-CLI (#15459), Kontextmeter bei synthetischen Frames (#16394), Gateway-429 (#17778). Tau liest Modelle und Kontextfenster aus der CLI, die Manifest-Fixes #16903 und #16908 entfallen deshalb. Pi-RPC-spezifisch und ohne Entsprechung: #17214, #17764, #17761, #17853, #17835.

## Was wir übernehmen sollten, als zusammenhängende Pakete

Der Wunsch war, Dinge „schöner miteinander zu verbinden“. Die Einzelfunde lassen sich in sechs Pakete fassen. Reihenfolge nach Risiko und Nutzen:

| # | Paket | Inhalt | Größe |
| --- | --- | --- | --- |
| 1 | **Sicherheit** | MCP-Token aus der argv (#17408/#17898), Access-Gate liest `annotations`. Im selben Schritt zu überlegen: seltene Kit-Tools als `exposure: "deferred"` mit `tool_search` (#17220). Beides ist eine „Tool-Metadaten-Politik“, der eine Fall betrifft Sicherheit, der andere Tokenkosten. Vorher die Kosten messen. | M |
| 2 | **Kleine Fixes** | die elf S-Bugs aus der Tabelle oben, jeweils mit Test | S je Fix, zusammen M |
| 3 | **Thread-Verzeichnis für Agenten und Nutzer** | Agent settlet den eigenen Thread am Turn-Ende (#17145), Snooze-Zustand in den Thread-Tools (#16782), Thread-Links über die ID mit Live-Titel im Transcript (#17017, Schema `tau://thread` gibt es schon für Push), Suche nach PR-Nummer und Branch in der Palette (#14658), Hinweis „Subagent wartet auf Antwort“ über dem Eltern-Composer (#16634). Als ein Ticket planen, sonst entstehen drei Linkformate. | M |
| 4 | **Agent-Zeile in der Lineage** | Stop pro Zeile, beim Hovern statt des Timers, auf Touch immer sichtbar (#17826, #16791). Für Claude über `stopTask` mit `taskId`, für tau.agents-Kinder über `tau_cancel_thread`. Hover-Karte mit Modell, Effort und Tempo (#17496, #16925), letzter Gedanke in der Live-Zeile (#16284). | S–M |
| 5 | **PR lesen** | Bot- und Resolved-Filter (#17645), unveränderte Zeilen im PR-Diff aufklappen für alle Hosts (#17528; `DiffView.onExpandContext` gibt es, die PR-Ansichten übergeben es nur nicht), Suche in Diffs (#14623), danach **Guided Reviews** als Beta. Tau-Variante: ein sichtbarer read-only Sub-Agent `pr-guide` im Wegwerf-Worktree liefert über `submit_pull_request_guide` strukturiert ab. Der Normalizer wird portiert, dazu ein Guide-Tab auf Desktop und Telefon sowie `write_`/`read_pull_request_guide` als Kit-MCP-Tools wie `link_pull_request`. Der Guide braucht die Kontextleisten und die Zeilenauswahl ohnehin. Eigene ADR. | M, dann L |
| 6 | **Sandbox-Frame** | Eine Core-Komponente mit Token-Route (Muster `src/main/shared-files.ts`), opaker Origin, CSP- und Sandbox-Header, Theme- und Cookie-Bootstrap (#17026, #17027) und geklemmter Höhe (#17040). Sie trägt dann MCP Apps im Codex-Kit (#16236), die HTML-Artefakte aus der Vorwoche und optional Skripte in der HTML-Vorschau des Files-Kits. `srcdoc` reicht nicht, weil es die Renderer-CSP erbt. | L |

Kleinere Punkte, die zu bestehenden Flächen passen:

- **Stage und Settings:** Tabs per Drag sortieren (#17730), mit einer gemeinsamen Drag-Logik für Sortieren und Split. In den Settings Cmd+F (#17859) und `tau`-Befehl installieren (#16683, passt zur Regel „Installieren ohne Konsole“). **S je Punkt.**
- **Kontextmenüs:** Terminal (alles auswählen, zum Neuesten springen, kopieren; #17091) und Preview (Bild oder Link kopieren; #17555) über denselben nativen Aufruf. **S–M.**
- **Usage:** Provider-Filter als Mehrfachauswahl, der auch für Limits gilt und gespeichert wird (#16970), Dimmen nur der Zeilen, die noch laden (#17147). **S–M.** Antigravity-Quota (#17530) erst nach einer Entscheidung, weil T3 den Refresh-Token liest und einen undokumentierten Google-Endpunkt nutzt. Tau liest bisher bewusst keine Credentials.
- **Thread-Suche über die ganze History** (#10439) mit Zitat-Chips in gesendeten Nachrichten (#15703): später, **M.**
- **Mehrere Skills pro Nachricht** (#17194) zusammen mit dem Skill-Katalog des Drafts: später, **M.**

Nicht übernehmen: Rich-Text-Composer (#14677, rund 3800 Zeilen Tiptap), Standardbrowser, Passkeys, OTLP, `.icns`, Muse Code, systemd-Scopes für Agenten (#17662, erst bei echten Linux-Hosts mit Speicherdruck), Provider pro Projekt (#17879; vorher klären, ob „Runtime pro Projekt“ gemeint ist, ein Teilschritt nur im Picker wäre M).

## Grenzen

Die T3-Quellen wurden aus Diffs und PR-Beschreibungen gelesen, ohne T3-Tests oder Messungen zu wiederholen. Pi-1.0.0-Typen stammen aus einem anderen Tau-Worktree, weil dieser Checkout kein `node_modules` hat. Offen bleibt #13894 (Fork-PR ohne Upstream): Ob `gh pr view` ihn findet, zeigt nur ein echter Versuch.
