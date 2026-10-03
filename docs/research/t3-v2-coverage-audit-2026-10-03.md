# Orchestrator V2: Abdeckung und offene Lebenszyklusfragen in Tau

Stand 3. Oktober 2026. Statischer Audit im isolierten Tau-Worktree bei `e343150a`, abgeleitet von `feat/t3code-parity-assessment` bei `08c103ed`. `git merge-base HEAD 08c103ed` ergibt `08c103ed`. Keine Runtime-Migration, kein Orchestrator-Umbau, keine App-, Test- oder Konfigurationsänderung. Dieses Dokument ist die einzige neue Datei. Keine Child-Delegation und keine gestartete App.

## Ergebnis mit Prüfgrenze

Die bisherige Bewertung „persistente Queues und Eltern/Kind-Recovery vorhanden“ ist zu grob. Tau speichert normale Prompt-Queues und die Abstammung gestarteter Kinder. Das ist nicht dasselbe wie dauerhaft gespeicherte Spawn-Aufträge, wiederholbare Command-Receipts oder eine nach einem Crash zuverlässig nachgelieferte Kind-Fertigmeldung.

Drei lokale Befunde verdienen zuerst Arbeit:

1. Agents Kit hält wartende Spawn-Prompts, Retry-Schlüssel und ausstehende Eltern-Weckmeldungen nur im Speicher. Die persistierte Abstammung ersetzt diese Aufträge nicht.
2. Die normale Prompt-Queue hat keine in derselben Transaktion gespeicherte Provider-Annahmebestätigung. Parallel mutierte Queues und ein Crash zwischen Annahme und Queue-Löschung sind eigene Prüfungen, nicht durch „Queue persistiert“ erledigt.
3. Claude kennt native Hintergrundtasks und schützt den gezielten Session-Neustart davor. `state().idle`, `waitForIdle()` und `abort()` orientieren sich aber an Vordergrundturns. Der komplette Lebenszyklus nativer Hintergrundarbeit bleibt nur teilweise abgedeckt.

Das sind konkrete Tau-Codebefunde und daraus abgeleitete Testaufträge. Kein in dieser Sitzung reproduzierter Laufzeitfehler.

Der vollständige Diff und die Diskussion von [T3-PR #2829](https://github.com/pingdotgg/t3code/pull/2829) waren über `web_explore` nicht lesbar. Auch die vollständigen ersten V2-Release-Notizen ließen sich nicht abrufen. Der Audit kann deshalb keine vollständige Liste der PR-Änderungen, keine geschlossenen Bugnummern und keinen Nachweis aller V2-Fixes liefern. Er ist ein systematischer Abgleich der erreichbaren V2-Architekturvorgaben und der zuvor dokumentierten Funktionsliste mit aktuellem Tau-Code. Eine Vollprüfung des riesigen PRs bleibt offen.

Theos konkrete Begründung für den Cursor-Wechsel ist nicht unabhängig bestätigt. Ich habe keine lesbare, ihm zuordenbare Primärquelle für „alte Integration war buggy“ gefunden. Deshalb steht hier kein angeblich wörtliches Theo-Zitat und kein pauschales Urteil über ACP.

## Quellen, Versionen und Belegarten

Alle neuen Web-Abfragen liefen über `web_explore`. Kein `curl`, keine `gh`-API, kein direkter Netzabruf als Ersatz. Die Web-Recherche lieferte teilweise Suchausschnitte statt vollständiger Seiten und meldete nicht verfügbare Suchbackends. Das ist eine Abruflücke, kein erfolgreicher Volltextaudit. Es gab keinen Wechsel des Ausführungswegs.

| Kürzel | Quelle | Was tatsächlich vorliegt |
|---|---|---|
| U1 | [T3-PR #2829](https://github.com/pingdotgg/t3code/pull/2829) | Ziel des Audits, aber kein lesbarer Body, Diff oder Kommentarverlauf in dieser Sitzung. |
| U2 | [Erstes V2-Nightly 0.0.46-nightly.20261003.2610](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610) | Treffer identifiziert `8ed276c246b6` und den Beginn „T3 Code Orchestrator V2“. Kein vollständiger Release-Text. |
| U3 | [T3 main, Architektur](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) | Lesbarer Primärquellen-Volltext. Vorgaben zu EventSink, Outbox, Recovery, Finalisierung, Checkpoints und Settlement. Dokumentation, kein selbst geprüfter Implementierungsdiff. |
| U4 | [T3 main, AGENTS.md](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md) | Lesbarer Primärquellen-Volltext. V2-Datenbank `statev2.sqlite`, Command/Event/Effect-Modell und drainbare Worker. |
| U5 | [T3 main, Installation](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md) | Lesbarer Primärquellen-Volltext. Cursor-CLI-Login, Providerinstanzen und Versionswarnungen. Kein Beleg des konkreten V2-SDK-Treibers. |
| U6 | [OpenCode-V2-Diskussion #6961](https://github.com/pingdotgg/t3code/discussions/6961) | Ausschnitt eines Beitrags über getrennten Provider `opencode2` mit `opencode2 acp` und lokalem Test. Ein Beitragsbericht, keine offizielle vollständige Protokollspezifikation. |
| C1 | [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) | Offizieller Treffer bestätigt das SDK als programmierbaren Cursor-Agent. Vollständige Auth-, Billing- und Resume-Sektionen nicht lesbar. Der ältere Pfad `/docs/api/sdk/typescript` ist nicht als gültige Quelle vorauszusetzen. |
| C2 | [Cursor ACP](https://cursor.com/docs/cli/acp) | Offizieller Ausschnitt bestätigt `agent acp`, stdio und JSON-RPC. Kein Nachweis, dass ACP generell instabil oder verworfen wäre. |
| C3 | [Cursor SDK Changelog](https://cursor.com/docs/sdk/changelog) | Offizieller Treffer gefunden, aber kein vollständiger datierter Versionsaudit. |
| O1 | [OpenCode-Dokumentation](https://opencode.ai/docs) | Offizieller Einstieg erreichbar als Ausschnitt. Kein vollständiger OpenCode-2-Vertrag oder Session-Migrationsvertrag. |
| L1 | [Vorherige Parity-Bewertung](t3code-parity-assessment-2026-10-03.md) | Tau-Stand `08c103ed`, Auswahl und dokumentierte frühere Abrufgrenzen. |
| L2 | [T3-Wochenrecherche](t3code-2026-10-03.md) | Frühere Recherche mit main-Cutoff `d1034d62`, Stable/Nightly-Zuordnung und Umsetzung in Tau. Hier gelesen, nicht vollständig extern erneut bestätigt. |
| L3 | [Umsetzung vom 30. September](t3-parity-implementation-2026-09-30.md) | Frühere Implementierungs- und Testnachweise. Keine neuen Testergebnisse dieses Audits. |

L2 ordnet [Stable v0.0.45](https://github.com/pingdotgg/t3code/releases/tag/v0.0.45) dem 2. Oktober zu und V2 dem ersten Nightly vom 3. Oktober, nach Merge von #2829 am 2. Oktober. Diese Datierung bleibt ein übernommener Altbeleg. U3 bis U5 sind bewegliches `main`, kein Commit-Permalink. Dort dokumentierte Details dürfen nicht rückwirkend als Inhalt von #2829 oder Stable v0.0.45 gelten. Auch spätere Nightlies sind nicht automatisch mit U2 identisch.

Ein PR-„Closes“ ist eine Verknüpfung beziehungsweise Maintainer-Behauptung. Es belegt weder den ursprünglichen Fehlermechanismus noch die Regressionstest-Abdeckung oder das Verhalten aller Provider. Ohne Diff und Tests wird hier kein geschlossenes Issue zum verifizierten Fix.

## Bewertungsregeln

- **Abgedeckt** bedeutet passende Mechanik im aktuellen Tau-Code. Es bedeutet nicht in dieser Sitzung auf echten Providern getestet.
- **Teilweise** bedeutet vorhandene Mechanik mit engerem Umfang oder einer benannten Haltbarkeitsgrenze.
- **Fehlend** bedeutet kein entsprechender Pfad in den gezielt geprüften Modulen. Keine Behauptung über jede externe Pi-Erweiterung.
- **Bewusst anders** bedeutet eine dokumentierte Eigentums- oder Produktentscheidung, keine Parity-Lücke.
- **Unbekannt** bedeutet fehlender Upstream-Vertrag oder fehlende Prüfung. Nicht als „fehlt“ zählen.

Die V2-Funktionsliste zu Scheduling, Registry, Fork-Rückführung und Providerwechsel stammt überwiegend aus L2. Die präzisen Command-/Effect- und Finalisierungsvorgaben stammen aus U3 auf main. Die folgende Matrix trennt beides.

## Systematische Abdeckungsmatrix

| Fähigkeit oder Bugklasse | V2-Beleg und Grenze | Tau heute | Einstufung und nächster Nachweis |
|---|---|---|---|
| Persistenter Ausführungsauftrag vor externen Effekten | U3 verlangt Eventlog, Projektionen, Command-Receipt und Outbox in einer DB-Transaktion; ACK heißt gespeicherte Absicht, nicht fertige Ausführung. | [TurnsInFlight](../../src/main/turns-in-flight.ts) und [QueuedMessages](../../src/main/queued-messages.ts) speichern getrennte JSON-Dateien; Provider und Session haben eigene Persistenz. | **Teilweise.** Keine gleichwertige atomare Gesamtzusage aus diesen Modulen. Annahme-, Schreibfehler- und Crash-Grenzen prüfen, nicht Event Sourcing als Selbstzweck kopieren. |
| Wiederholung eines angenommenen Commands nach Reconnect/Restart | U3 nennt dauerhafte Receipts zur Idempotenz. Nicht jeder externe Effekt wird dadurch exactly-once. | Agents `once()` hält `Map<string, Promise<unknown>>`, begrenzt durch `MAX_REMEMBERED_REQUESTS`, nur für diesen Hostprozess. | **Teilweise.** Spawn/Send/Cancel sind im laufenden Prozess retry-sicher, nicht dauerhaft über Restart. [Agents host.ts](../../kits/agents/host.ts), Zeilen 330ff. |
| Nicht fremde Providerarbeit doppelt ausführen | U3 verbietet simples Replay von Effekten eines verlorenen Providerprozesses. L2 nennt zusätzlich #13295, kein hier geprüfter V2-Diff. | In-flight-Marker prüfen lebenden Writer-PID; Session-Locks schützen Eigentümer. | **Teilweise.** [TurnsInFlight](../../src/main/turns-in-flight.ts), [Turn-Reconciliation](../../src/main/turn-reconciliation.ts), [Session-Locks](../../src/main/session-locks.ts). Kein Nachweis einer gemeinsam transaktionalen Mehrhost-Auftragsverwaltung. |
| Abgebrochene Turns nach Restart kennzeichnen oder fortsetzen | L2 nennt Recovery; U3 unterscheidet verlorene Effekte. | Reconciliation repariert den Turn, setzt Unterbrechungsmarkierung oder sendet nach Opt-in einen Fortsetzungsprompt über `resume`. | **Abgedeckt**, mit bewusst konservativem Default. Fortsetzung ist ein neuer Modellaufruf, nicht Wiederaufnahme derselben CPU-Ausführung. Marker wird vor Open/Prompt vergessen; zweiter Crash ist gesonderte Prüfgrenze. |
| Normale Prompt-Queue über Fenster- und Host-Neustart | L2 nennt persistente Queue. | Queue mit Anhängen, Skills, Reihenfolge, Hold, Take, Move, Freeze; restaurierte Queues warten standardmäßig auf den Nutzer. | **Abgedeckt** für gespeicherte wartende Prompts. Nicht daraus atomare Zustellung folgern. [queued-messages.ts](../../src/main/queued-messages.ts), [Tests](../../src/main/queued-messages.test.ts). |
| Queue-Zustellung bei Crash während Providerannahme | U3s Receipt/Outbox-Modell adressiert die Grenze zwischen Absicht und Ausführung. | `pump()` nimmt den Kopf aus der RAM-Liste, `deliver()` läuft, danach persistiert Tau die Restliste. | **Teilweise.** Annahme ohne anschließenden Queue-Write kann Wiederzustellung verursachen; andere Queue-Writes können während `deliver()` die kopflose Liste persistieren. Ende-zu-Ende-Korrelation prüfen. Keine reproduzierte Verlust- oder Doppelturnbehauptung. |
| Kind-Start hinter Kapazitätslimit | L2 nennt Delegation/Queues, genauer V2-Spawnspeicher unbekannt. | Budget und Pending-Handles vorhanden. Noch nicht gestartete Prompts, Definitionen und gewünschte Workspace-Modi liegen in Maps. Der Link-Save lässt lokale Einträge ohne `threadId` weg. | **Teilweise.** Wartender Spawn überlebt den Host-Restart in diesem Pfad nicht als vollständiger Auftrag. [host.ts](../../kits/agents/host.ts), `save`, `prompts`, `definitions`, `wanted`, `spawn`. |
| Eltern/Kind-Abstammung nach Restart | L2 nennt Recovery. | Parent-Link im Session-/Threadindex, zusätzlicher Kit-Linkindex und Wiederherstellung über Sweep. | **Abgedeckt** für bereits gestartete Threads, nicht für alle ausstehenden Aufträge. [ADR 0013](../adr/0013-agents-spawn-threads.md), [session-lineage.ts](../../src/main/session-lineage.ts). |
| Fertiges Kind weckt Eltern genau einmal, auch nach Crash | V2-Detail mangels PR-Diff **unbekannt**; U3 legt dauerhafte Absicht nahe, aber beweist diese konkrete Garantie nicht. | `expecting`, `unreported`, `waking` und Retry-Timer sind RAM-Zustand; `childEnded` löscht ausstehende Turn-Erwartung. Persistierter Link enthält keine Wake-Quittung. | **Teilweise.** Laufendes Hostverfahren vorhanden; kein dauerhafter Completion-Inbox-Vertrag. Parent busy, Parent released und Crash vor/nach Send prüfen. [host.ts](../../kits/agents/host.ts), Zeilen 823ff und 1190ff. |
| Providerübergreifende Delegation mit sichtbarem Kind | L2 nennt V2-Delegation zwischen Providern. | Agent-Definition wählt Backend; `sessions.start` startet gewöhnlichen Thread, MCP stellt Tools anderen Runtimes bereit; remote Kinder separat unterstützt. | **Abgedeckt**, aber Runtimewahl erfolgt über Definition, nicht allein über `provider/model`. [Agents host](../../kits/agents/host.ts), [Definitionen](../../docs/agent-definitions.md), [ADR 0013](../adr/0013-agents-spawn-threads.md). |
| Provider-native Hintergrundjobs separat vom Elternturn | L2 nennt Hintergrundarbeit; genaue V2-Providerabdeckung nicht abrufbar. U3 unterscheidet Run und Finalisierung. | Claude zählt `background_tasks_changed`/`task_started`/`task_notification`, verweigert Restart bei Tasks. Sie sind keine Tau-Kindthreads. | **Teilweise.** Kein allgemeiner persistenter Jobkatalog über alle Backends. [Claude backend](../../kits/claude-code/thread-backend.ts), Zeilen 219, 528ff, 552ff. |
| Hintergrundresultat darf nicht aktuellen `/compact`-/Userturn beenden | L2 beschreibt #14497 separat vor V2 und bereits integrierten Tau-Fix. | SDK prüft UUIDs und Ursprung vor `onMessage`; fremde Ergebnisse gelangen nicht zum Turn-Abschluss. | **Abgedeckt** für diesen Claude-Pfad. [sdk-session.ts](../../kits/claude-code/sdk-session.ts), `consume`, `resultSends`. Nicht als neuer #2829-Fix ausgeben. |
| Idle, Eviction und Stop trotz nativer Hintergrundarbeit korrekt | Genaue V2-Zusage unbekannt; relevante Fehlerklasse unabhängig davon. | Claude `state().idle` und `waitForIdle()` prüfen nur `turns`; `abort()` kehrt bei leerer Turnliste zurück; Taskset schützt nur den gezielten Restart. | **Teilweise.** Verbraucher des Idle-Zustands und Runtime-Eviction prüfen. Ein Taskset allein schützt nicht vor `dispose()`. [Claude backend](../../kits/claude-code/thread-backend.ts), Zeilen 290ff und 762ff. |
| Freigaben und Fragen auf Desktop, remote und anderen Runtimes | V2 integriert normalisierte Provider, genaue neue Freigabefunktionen unbekannt. | `ask`-Route, MCP-Accessgate, Claude SDK, Codex-Appserver, ACP und OpenCode-Permission-/Question-Antworten vorhanden. | **Abgedeckt** als Live-Interaktion. [ADR 0005](../adr/0005-thread-runtime-backends.md), [ACP session](../../kits/_acp/session.ts), [OpenCode client](../../kits/opencode/client.ts). |
| Veraltete oder verlorene Approval nach Restart | U3 sagt verlorene Prozess-Effekte vor neuer Arbeit ausmustern; konkrete Approval-Regel im PR nicht geprüft. | ACP validiert Session-ID; Fragen werden über Callback beantwortet. Keine hier nachgewiesene dauerhafte Approval-Inbox oder Wiederanbindung verlorener Providerrequest-IDs. | **Unbekannt** für vollständige Recovery. Fail-closed-Abbruch, Doppelantwort von zwei Clients und verspätete Antwort auf neue Session getrennt prüfen. |
| Providerende getrennt von Checkpoint/Diff/PR-Nacharbeit | U3 fordert separate Run-Finalisierung; spätes Ergebnis darf Dauer/Running nicht verlängern oder neuerem Run zugeordnet werden. | Backend markiert `turn-settled`; Workspace-Observer erzeugen Checkpoints und führen eigene Recovery. | **Teilweise.** [backend-events.ts](../../src/main/backend-events.ts), [Workspace lifecycle](../../kits/workspace/host-lifecycle.ts). Reihenfolge und Präsentation bei langsamer Finalisierung nicht ausgeführt. |
| Checkpoint ohne Commit auf Nutzerbranch, schmutzige Dateien erfassen | U3 nutzt versteckte Git-Refs; L2 nennt V2-Checkpoints. | Vorher/Nachher-Bäume, eigene Ref-Namensräume, Lazy-Diffs, Lease, GC und Fork-Vererbung vorhanden. | **Abgedeckt** vor allem für lokale Pi-Threads. [CONTEXT](../../CONTEXT.md), [Workspace lifecycle](../../kits/workspace/host-lifecycle.ts), [workspace-kit-checkpoints.ts](../../kits/workspace/workspace-kit-checkpoints.ts). |
| Gespräch und Dateien gemeinsam zurückrollen | U3 fordert Ablehnung vor Dateiveränderung, wenn Providergespräch nicht zurückrollbar ist. | Restore prüft lokale Pi-Eigentümerschaft und vollständigen Anchor, erstellt Backupthread und Recoveryjournal vor Dateirestore. Nicht-Pi-Restore wird abgelehnt. | **Abgedeckt** sicher für Pi, **teilweise** als providerübergreifende Produktfunktion. Keine erzwungene Dateirücksetzung mit veraltetem Providergedächtnis. [host-lifecycle.ts](../../kits/workspace/host-lifecycle.ts), `sourceThread`, `restore`, `recoverRestoreTransactions`. |
| Fork-Kontext und Rückführung | L2 nennt Fork/merge-back, keine genaue Provider-Capabilityliste. | Pi-Fork, vererbte Checkpointrefs; Handoff verdichtet sichtbare Nachrichten und Änderungen. Code-Apply der Kinder ist eigener, bestätigter Vorgang. | **Teilweise.** Nicht verlustfrei für Tools, Gedanken und Anhänge und nicht nativ für alle Runtimes. [handoff.ts](../../kits/handoff/handoff.ts), [ADR 0017](../adr/0017-worktrees-for-threads-and-agents.md). |
| Kontinuität bei Providerwechsel | L2 nennt ausgewählte Nachrichten statt vollständiger nativer Session. | Backend und Home Machine bleiben Eigentümer. „Continue in“ ist Übergabe in einen neuen Thread; kompatibler Codex-Kontowechsel bleibt dasselbe Backend. | **Bewusst anders.** [ADR 0005](../adr/0005-thread-runtime-backends.md), [CONTEXT](../../CONTEXT.md). Keine Runtime-Migration im selben Thread empfehlen. |
| Beliebige Agents aus ACP-Registry | L2 nennt Registry. | Gemeinsamer ACP-Client und konkrete Cursor-, Grok-, Antigravity-Kits vorhanden. Kein geprüfter allgemeiner Registry-Installer/-Picker. | **Fehlend** als Produktfunktion. Optionales Kit nur bei konkretem Agentbedarf; ACP selbst fehlt nicht. [kits/_acp](../../kits/_acp/), [Cursor session](../../kits/cursor/session.ts). |
| Offizieller Cursor-SDK-Pfad | L2 nennt SDK, U5 beschreibt weiterhin CLI-Installation. | Cursor ist ACP, kein `@cursor/sdk`-Treiber. Native Session-ID und CLI-Login werden genutzt. | **Fehlend** als SDK-Pfad; funktionierender ACP-Pfad ist vorhanden. Der SDK-Wechsel ist keine bewiesene Stabilitätsverbesserung. |
| OpenCode 2 | L2 nennt OpenCode 2; U6 berichtet getrennten `opencode2 acp`-Provider. | OpenCode nutzt `opencode serve`, HTTP, SSE, `/session`, `/prompt_async`, `/permission/.../reply` und `/question/.../reply`. | **Fehlend** als eigener ACP-2-Pfad; Kompatibilität des alten HTTP-Clients mit Version 2 **unbekannt**. [client.ts](../../kits/opencode/client.ts), [server.ts](../../kits/opencode/server.ts). |
| Geplante, wiederkehrende Arbeit | L2 nennt Scheduling, ohne hier lesbaren genauen Zeitplanvertrag. | Limit-Fortsetzung und Snooze sind vorhanden, keine hier belegte allgemeine geplante Aufgabe. | **Fehlend** als allgemeines Produkt. Bei Bedarf optionales Kit mit Zeitzone, Misfire-Regel, Überschneidungen, Rechten und sichtbarer Historie. Keine automatische Merge-/Deployfreigabe. |
| Lange Historie seitenweise übertragen | L2 nennt Pagination; U3 verlangt threadbezogene Subscriptions. | `TranscriptPager`, Hostcursor, ältere Seiten und Tool-Output-Lazyreads; auch ohne live Runtime. | **Abgedeckt** auf Transport/UI-Ebene. [host-transcript.ts](../../src/main/host-transcript.ts), [transcript-pager.ts](../../src/shared/transcript-pager.ts). |
| Historie auch auf dem Host bounded laden | Kein detaillierter V2-Algorithmus abgerufen. | Persistierter Pi-Reader liest Branch und projiziert alle Nachrichten vor dem Paging; externe Backend-Records halten ebenfalls komplette sichtbare Nachrichten. | **Teilweise.** Kleine Wire-Seiten sind kein Beleg für konstante Host-RAM-/CPU-Kosten. [persisted-transcript.ts](../../src/main/persisted-transcript.ts), [OpenCode backend](../../kits/opencode/thread-backend.ts). |
| Streaming bündeln ohne Endmarker zu verlieren | L2 nennt gebündelte Updates, genaue V2-Batchingregeln unbekannt. | Tooloutput wird im Transport zusammengeführt; Backend-Assistentendeltas werden einzeln an `emit` gereicht; Agent-Panel bündelt Zustandsbursts bei 30 ms. | **Teilweise** im geprüften Code, Performance-Parity **unbekannt**. [pi-host.ts](../../src/main/pi-host.ts), `pushToolOutput`, [backend-events.ts](../../src/main/backend-events.ts), [Agents host](../../kits/agents/host.ts). Endmarker/Flush bei Abort und Reconnect messen. |
| Serverseitiges Settlement ohne offenen Client | U3 beschreibt PR-/Inaktivitäts-Service, neue Runs und explizite Overrides als Guards. | Thread-Rail-Host sweep läuft auch ohne Fenster, terminale PRs müssen alle bekannt sein. | **Abgedeckt** als Funktion; Race mit neuem Turn/PR-Sync nicht hier getestet. [Thread-Rail](../../kits/thread-rail/host.ts), [CORE](../CORE.md). |
| Persistierte Schemas und unabhängig aktualisierte Clients | U3/U4 betonen Replay-Decodierbarkeit und getrennte V2-DB; L2 sagt keine spätere V1/V2-Synchronisierung und V2-Mobilebedarf. | Versionierter Hostvertrag und Kit-Stores, unterschiedliche Runtime-Sessions; kein V1/V2-Orchestrator-DB-Wechsel. | **Bewusst anders** beim Datenmodell; **unbekannt** für jede Downgrade-/Schemafolge. [ADR 0010](../adr/0010-host-protocol.md), [CORE](../CORE.md). Nicht Taus Persistenz wegen T3s Migration ersetzen. |

## Cursor: Was Theos Begründung tragen müsste

### Was belegt ist

Tau nutzt den offiziellen ACP-CLI-Einstieg. [session.ts](../../kits/cursor/session.ts) startet `acp`, authentifiziert mit `cursor_login`, meldet keine Client-Dateischreib- oder Terminalfähigkeit an und fragt `cursor/list_available_models` ab. [thread-backend.ts](../../kits/cursor/thread-backend.ts) setzt Modell, Effort und Modus vor dem Prompt, beantwortet Freigaben, Formulare, `cursor/ask_question` und Planerstellung. Diese Implementierung ist kein Screen-Scraping einer Cursor-TUI.

Der offizielle ACP-Ausschnitt C2 bestätigt den Einstieg. U5 verlangt Cursor CLI und `agent login`. C1 bestätigt, dass es ein offizielles TypeScript-SDK gibt. Diese drei Tatsachen belegen weder einen Defekt der alten T3-Integration noch die Auth-/Billing-Gleichheit beider Wege.

### Lokale Kompatibilitätsrisiken, unabhängig von Theo

1. **Resume wird zu weit als fehlende Session interpretiert.** `restoreSession()` fällt nach praktisch jedem Resume-/Load-Fehler außer „exited“/„closed“ auf eine neue Session zurück. Ein temporärer Auth-, Netzwerk-, Schema- oder Serverfehler kann damit eine dauerhafte Session-ID ersetzen. Die Warnung sagt, Cursor habe das Gespräch nicht mehr, obwohl das nicht bewiesen ist. Hoher Prüfbedarf, kein hier ausgeführter Repro. Nur explizit „Session fehlt“ sollte eine solche Klassifizierung begründen.
2. **Native Methoden hängen an Cursor-Erweiterungen.** Modellliste, Effort, Fragen und Tasks sind nicht nur ACP-Basisprotokoll. Ein SDK-Treiber müsste diese Semantik erhalten, statt lediglich Textantworten zu liefern.
3. **Task-Karte ist keine Jobverwaltung.** Die Handler für `cursor/task` und `cursor/generate_image` liefern unmittelbar ein Ergebnis wie `completed` beziehungsweise `generated` und zeichnen eine Karte. Ohne den Cursor-Methodenvertrag lässt sich nicht sagen, ob das nur eine legitime Anzeigequittung oder eine weitergehende falsche Zusage ist. Nicht als Bug zählen, bevor Request-/Response-Vertrag gelesen wurde.
4. **Berechtigungen und Nutzerkonfiguration gehören zum Vergleich.** Ein SDK-Pfad muss CLI-Regeln, MCP, Skills, Instanz-Homes, ask/read-only/full und Cancel/Resume mindestens ausdrücklich zuordnen. Ein anderer Transport rechtfertigt keinen stillen Rechtegewinn.

### Auth, Billing und Sessions: offene Entscheidungstabelle

| Frage | In diesem Audit gesicherter Stand | Was vor einer Adapterentscheidung fehlt |
|---|---|---|
| Bestehender Browser-/CLI-Login wiederverwendbar? | Tau ACP verwendet den CLI-Login. T3-main-Installationsdoku ebenfalls. | Offizieller SDK-Vertrag zur Übernahme desselben Logins, inklusive lokal/cloud und Teamkonto. Nicht aus fremden SDK-Beispielen ableiten. |
| `CURSOR_API_KEY` notwendig oder optional? | Keine lesbare offizielle SDK-Authsektion. | Lokaler SDK- und Cloud-API-Authweg getrennt bestätigen. Ein API-Key-Beispiel ist keine allgemeine Pflicht. |
| Abrechnung auf bestehendem Cursor-Plan? | Tau dokumentiert Cursor-Planmodelle, [CORE](../CORE.md); reale Rechnung hier nicht geprüft. | SDK-Usage, enthaltenes Kontingent, On-demand/Cloudkosten und Teamlimits aus offizieller Preis-/SDK-Doku. **Unbekannt**, kein bestätigtes „SDK kostet extra“ oder „Abo unverändert“. |
| Alte ACP-/CLI-Session im SDK fortsetzen? | Tau speichert `acpSessionId` und lädt/resumiert über vom Agent angebotene Fähigkeiten. | Offizieller ID-/Speichervertrag und Probe derselben nativen Session, nicht nur sichtbaren Chat kopieren. Gleiches Harness heißt nicht identische Sessionformate. |
| Lokal oder Cursor-Cloud? | Offizielles SDK existiert; vollständiger Runtimevertrag nicht abgerufen. | Workspace-, Git-, Datenübertragungs- und Job-ID-Regeln je Betriebsart. Cloud-Background-Agent nicht als lokaler Tau-Kindthread ausgeben. |
| Native Hintergrundjobs überleben Client-/Hostneustart? | Kein geprüfter SDK-/T3-Cursor-Vertrag. | Jobstatus lesen, stoppen, erneut anbinden und Completion korrelieren, getrennt vom Userturn. |

Drittanbieterberichte aus Suchtreffern widersprachen sich bei SDK-Auth, lokal/cloud und Sessionunterstützung. Sie wurden nicht zur Bestätigung genutzt. Besonders unzulässig wäre es, die Bedingungen der Cursor Background Agents API automatisch auf einen lokalen SDK-Agent zu übertragen.

**Urteil:** Theos Motiv ist plausibel, aber nicht verifiziert. Tau hat selbst prüfenswerte Resume-Grenzen. Meine Empfehlung ist ein begrenzter ACP-versus-SDK-Kompatibilitätstest mit dem bestehenden Konto und einer alten Session, keine Runtime-Migration. Ein belastbares „alte Cursor-Integration war buggy“ braucht den alten T3-Treiber, ein konkretes Issue mit Version/Repro, den V2-Ersatz und einen nachvollziehbaren Test oder eine eindeutig zuordenbare Theo-Aussage.

## OpenCode 2: keine Kompatibilität aus Namen ableiten

U6 berichtet einen separaten ACP-Pfad `opencode2 acp`, während Version 1 unverändert bleibt. Das ist ein konkreter Unterschied zum Tau-Client, aber noch keine vollständige Liste der Protokolländerungen. Der Ausschnitt beweist insbesondere nicht, dass alle V1-HTTP-Endpunkte entfernt wurden oder jede bisherige Session unbrauchbar ist.

Tau bindet sich an HTTP-Health/Provider/Session-Methoden, `prompt_async`, SSE `/event`, Session-ID-/Message-Part-Felder, Permission- und Question-Replies sowie XDG-Homes. [client.ts](../../kits/opencode/client.ts), [thread-backend.ts](../../kits/opencode/thread-backend.ts), [server-settings.ts](../../kits/opencode/server-settings.ts), [host.ts](../../kits/opencode/host.ts).

Vor „OpenCode 2 unterstützt“ sind getrennt zu prüfen:

- CLI-Name und Subcommand, unterstützte Version, Auth und Konfigurationsort.
- ACP-Handschlag, neue/load/resume Session, Modell-/Planwahl und MCP-Transport.
- Eventabschluss, Abbruch, native Kinder und Freigaben samt IDs.
- Alte HTTP-/SSE-Pfade, falls weiter angeboten, einschließlich Reihenfolge und Feldänderungen.
- Migration oder gemeinsamer Speicher von V1-Sessions, Import in Tau und außerhalb Tau gelesene Usage.

Ein SDK-Importpfad mit `/v2` ist kein Nachweis einer kompatiblen OpenCode-Hauptversion 2. Die Mindestversionsregel eines bestehenden Kits bestätigt keine neue Hauptversion. Getrennte Registrierung oder explizite Versionspolitik wäre zu prüfen; der alte Treiber soll nicht ungeprüft verdrängt werden. Der vollständige offizielle OpenCode-2-Protokoll- und Migrationsvertrag bleibt Abruflücke.

## Priorisierte Arbeit ohne Orchestrator-Neubau

Prioritäten sind meine Bewertung nach Datenverlust-, Doppelarbeit- und Kostenrisiko, nicht eine Upstream-Rangliste.

| Priorität | Auftrag | Konkrete Abnahme |
|---|---|---|
| P0 | Dauerhaften Zustand für angenommene, noch nicht gestartete Kinder klären. | Spawn über Budget, Restart vor freiem Slot: derselbe Handle und vollständiger Prompt bleiben vorhanden oder der Auftrag wird sichtbar endgültig abgelehnt. Nie still verschwinden. Definition und Workspaceentscheidung konsistent erhalten. |
| P0 | Queue-Annahme und Crashfenster untersuchen. | Crash vor/nach `deliver` und vor/nach Queue-Write; währenddessen Add/Move/Take eines weiteren Prompts. Kein stiller Verlust. Wiederholung einer angenommenen Nachricht durch stabile Turn-/Command-ID erkennen oder explizit als unsicher markieren. Schreibfehler dürfen nicht als dauerhafte Annahme gelten. |
| P0 | Fertigmeldungen von Kindern dauerhaft quittieren. | Parent busy/released, Hostcrash vor Kind-Ende, nach Ende vor Send und nach Send vor Quittung. Nach Restart richtige Completion einmal sichtbar; kein neuer, doppelter kostenpflichtiger Elternturn. Hier fehlt ein dauerhafter Vertrag, nicht die Kindabstammung. |
| P1 | Native Claude-Hintergrundarbeit als eigene Lebenszyklusdimension behandeln. | Userturn endet, Task läuft weiter; Runtimebudget überschritten, Stop, Restart, Hostrestart, verspätetes Taskresultat. Klare Anzeige und definierte Erhaltung/Abbruchregel. Ein Kind-Ende darf den aktuellen Userturn nicht beenden. |
| P1 | Cursor-Resume fehlertypisiert prüfen. | Gleiche native ID nach temporärem Auth-/Netz-/Protokollfehler behalten. Nur belegtes „Session fehlt“ darf eine neue Konversation beginnen. Warntext muss den tatsächlichen Fehler nennen. |
| P1 | Freigabe-Recovery und Finalisierung nach Turnende absichern. | Stale Approval nach neuer Session ablehnen; zwei Clients antworten nicht zweimal. Langsamer Checkpoint/PR-Read hält Providerdauer nicht offen und schreibt keine Metadaten auf einen neueren Run. |
| P1 | Cursor-SDK und OpenCode 2 als getrennte Kompatibilitätsprüfung. | Auth, Billing, alter Sessionbestand, Rechte, MCP/Skills, Cancel und Hintergrundjobs pro Pfad belegen. SDK erst empfehlen, wenn Vorteil konkret und nicht durch Kontinuitätsverlust erkauft ist. |
| P2 | Pagination-/Streamingkosten messen. | Lange persistierte Historie bei kaltem Host und mehreren Clients; RAM, Ladezeit, Wirebytes und Deltaanzahl. Flush/Endmarker bei Abort und Reconnect nicht verlieren. Kleine Seiten allein reichen nicht. |
| P2 | Registry und Scheduling nur bei benanntem Bedarf. | Optionales Kit, sichtbare Rechte und Versionsstatus; Zeitpläne mit Missed-run-/Overlapregel. Kein Core-Neubau und kein automatischer Runtimewechsel. |

Geeignete vorhandene Testeinstiege sind [Queue-Tests](../../src/main/queued-messages.test.ts), [Turn-Reconciliation-Tests](../../src/main/turn-reconciliation.test.ts), [Agents-Host-Tests](../../kits/agents/host.test.ts), [Cursor-Backend-Tests](../../kits/cursor/thread-backend.test.ts), [Claude-Backend-Tests](../../kits/claude-code/thread-backend.test.ts), [Workspace-Checkpoint-Tests](../../kits/workspace/turn-checkpoints.test.ts) und [persistierte Transcript-Tests](../../src/main/persisted-transcript.test.ts). Deren Existenz ist kein Beleg, dass die hier genannten Crashmatrizen schon abgedeckt sind. In dieser Sitzung wurde kein Test ausgeführt.

## Was nicht zu übernehmen ist

Ein Eventlog mit Outbox ist eine mögliche Lösung für Haltbarkeit, kein Produktziel. Für Tau reicht eine kleinere Lösung, wenn sie die genannten Annahme-, Wiederholungs- und Recoverygrenzen ehrlich erfüllt. Ich würde weder T3s V1/V2-Datenbankmigration noch Runtimewechsel im selben Thread übernehmen. Das zweite widerspricht [ADR 0005](../adr/0005-thread-runtime-backends.md). Sichtbare gewöhnliche Kinder und getrennt bestätigte Codeintegration bleiben [ADR 0013](../adr/0013-agents-spawn-threads.md) und [ADR 0017](../adr/0017-worktrees-for-threads-and-agents.md).

## Restunsicherheit und Reproduzierbarkeit

- Kein vollständiger #2829-Diff, keine überprüfte Closes-Liste, keine Theo-Kommentare. Keine Aussage, alle V2-Fähigkeiten oder Bugklassen erschöpfend gefunden zu haben.
- U3/U4 dokumentieren current main ohne festgehaltenen Upstream-Commit. EventSink-/Outbox-/Finalisierungsdetails sind Primärquellen-Dokumentation, keine in dieser Sitzung inspizierten T3-Codepfade oder ausgeführten Tests.
- Stable-/Nightly-Zuordnung, Migration und die breite V2-Funktionsliste beruhen teilweise auf L2. Das erste Nightly ist nicht automatisch der aktuelle Veröffentlichungsstand.
- Cursor-SDK-Auth, Billing, CLI-Sessionkompatibilität und OpenCode-2-Migration konnten nicht bestätigt werden. Keine Entscheidung darf diese Unbekannten als positive Unterstützung auslegen.
- Tau-Befunde sind statisch am genannten HEAD. Runtime-/Provider-Ende-zu-Ende-Idempotenz, echte Accounts und Crashrepros sind nicht geprüft. Frühere Gesamttests aus L2/L3 ersetzen diese spezifischen Prüfungen nicht.
- Lokale Dateien wurden mit `read`, Suchläufe mit `rg` und Versionsgrenzen mit Git geprüft. Die einzigen Schreibarbeiten betreffen dieses Dokument. Keine neuen Issues, PRs oder Anwendungsmigrationen wurden angelegt.
