# Nutzerzahlen bei OpenCode und T3 Code

Recherchiert am 9. Oktober 2026. Geprüft wurden offizielle Websites, Dokumentation und Quellcode. T3 Code war dabei auf Commit `ec80933ac8cd02fec5c97b342462ccc9567cdb1e`, OpenCode auf `388406238bd5ca15564a762840a2362c3a45bd9c`. Die Nutzerfrage nennt keine konkreten X-Posts. Eine einzelne veröffentlichte Zahl lässt sich deshalb nicht sicher einer Abfrage oder einer damaligen Implementierung zuordnen.

## T3 Code misst Produktnutzung

T3 Code schickt serverseitig Ereignisse an PostHog. Die interne Dokumentation empfiehlt ausdrücklich `client.turn.requested` für Auswertungen aktiver Nutzung. `client.connected` zählt auch Wiederverbindungen und kann daher Verbindungsprobleme als Wachstum erscheinen lassen. Ein bloßer Besuch der gehosteten App zählt nicht als Produktnutzung, weil die Ereignisse eine authentifizierte Verbindung brauchen. [Dokumentation und Zählregel](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/docs/internals/product-analytics.md#L3-L28).

Für `distinct_id` verwendet T3 Code den SHA-256-Hash der ersten verfügbaren Identität: Codex `tokens.account_id` aus `~/.codex/auth.json`, Claude `userID` aus `~/.claude.json`, sonst eine lokal gespeicherte zufällige Installations-ID. Dieselbe Provider-Identität kann dadurch mehrere Geräte oder Clients zusammenführen. Das ist eine pseudonyme Kennung, kein Beleg für vollständige Anonymität und keine garantierte Zählung verschiedener Menschen. Kontowechsel und der Wechsel vom Installations-Fallback zu einer Provider-ID können die Kennung ändern. [Auswahl der Identität](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/apps/server/src/telemetry/Identify.ts#L258-L307), [Hashfunktion](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/apps/server/src/telemetry/Identify.ts#L157-L162).

Die Erfassung ist in dieser Version standardmäßig eingeschaltet. `T3CODE_TELEMETRY_ENABLED=false` stoppt das Aufzeichnen und Senden der Produkt-Ereignisse. PostHog erhält die Kennung sowie Produktdaten; Personenprofile bleiben deaktiviert. Die öffentliche Dokumentation nennt Provider, Modell, Reasoning-Einstellung, Berechtigungsmodus, Ergebnis, Dauer und verfügbare Tokenzahlen des Hauptagents. Prompts, Antworten, Dateiinhalte und Zugangstoken gehören laut Dokumentation nicht dazu. [Default im Code](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/apps/server/src/telemetry/AnalyticsService.ts#L63-L77), [PostHog-Payload](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/apps/server/src/telemetry/AnalyticsService.ts#L174-L214), [Nutzer-Dokumentation](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/docs/user/telemetry.md).

Damit ist eine Auswertung eindeutiger Kennungen mit mindestens einem `client.turn.requested` innerhalb von sieben oder dreißig Tagen technisch möglich. Dass genau diese Abfrage hinter jedem X-Post steht, ist hier nicht nachgewiesen. Die interne Dokumentation warnt außerdem davor, Nutzergruppen nach Client-Typ zu addieren: dieselbe Identität kann in mehreren Gruppen vorkommen. [Interpretation](https://github.com/pingdotgg/t3code/blob/ec80933ac8cd02fec5c97b342462ccc9567cdb1e/docs/internals/product-analytics.md#L23-L28).

## OpenCode hat mehrere getrennte Datenquellen

Ein öffentliches Skript sammelt Downloadzahlen. Es summiert `download_count` aller GitHub-Release-Assets und die täglichen npm-Downloads des Pakets `opencode-ai`. Es schreibt die kumulierten Werte nach `STATS.md` und enthält einen Export an PostHog mit der festen Kennung `download`. Diese Kennung identifiziert ausdrücklich keinen einzelnen Nutzer. [GitHub-Zähler](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/script/stats.ts#L97-L120), [npm und Export](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/script/stats.ts#L195-L215), [feste Kennung](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/script/stats.ts#L3-L26), [öffentliche Downloadhistorie](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/STATS.md).

Das Skript zählt Abrufe, auch Updates und erneute Installationen. Es dedupliziert weder Menschen noch Installationen. Eine Downloadsumme eignet sich daher als Downloadkennzahl, nicht als Anzahl aktiver Nutzer. Diese Grenze folgt unmittelbar aus der Aggregation der Abrufzähler im Skript.

OpenCode veröffentlicht außerdem auf seiner offiziellen Datenseite tägliche Nutzerzahlen nach Modell. Die Methodik bezeichnet Nutzer- und Sessionzahlen als ungefähre Zählungen verschiedener Nutzer und OpenCode-Sessions. Sie nennt stündliche Aggregation und UTC-Tage beziehungsweise UTC-Wochen. Die dort erklärte Methodik dokumentiert jedoch keine vollständige Definition der Nutzerkennung oder die Abdeckung aller möglichen Provider. [OpenCode Data und Methodik](https://opencode.ai/data#methodology).

Die Homepage nennt zum Recherchezeitpunkt über 16 Millionen Entwickler pro Monat. Die Homepage selbst erklärt nicht, welche Datenquelle, Deduplizierung oder Aktivitätsdefinition dahintersteht. Das gefundene Downloadskript und die Datenseite beweisen nicht, wie diese Monatszahl oder ein bestimmter X-Post berechnet wurde. Eine Gleichsetzung mit Downloads wäre ebenso unbelegt wie die Behauptung, die Zahl sei eine sauber deduplizierte MAU-Zahl aller OpenCode-Nutzer. [Offizielle Homepage](https://opencode.ai/).

## Folgerung für eine eigene Messung

Downloads, aktive Installationen und aktive Konten brauchen unterschiedliche Namen. Für eine belastbare öffentliche Zahl müssen Zeitraum, Aktivitätsereignis, Identität und Erfassungsabdeckung feststehen. T3 Codes dokumentiertes Ereignis für eine angeforderte Agent-Antwort ist ein konkretes Vorbild für die Aktivitätsdefinition. Seine Identitätsgewinnung aus fremden Provider-Kontodateien muss dafür nicht übernommen werden.

## Empfehlung für Tau

### Was heute messbar ist

Im untersuchten Tau-Checkout gibt es keinen eigenen Produkt-Nutzungszähler. Das ist eine Feststellung aus der Suche nach Telemetrie-/Analytics-Aufrufen und dem Updatepfad, keine Aussage über sämtliche Dienste, die verwendete Agenten selbst kontaktieren.

- Desktop-Updates gehen direkt an GitHub. `feedFor` nutzt GitHub für Stable und einen GitHub-Release-URL für Nightly. Der Desktop prüft standardmäßig stündlich: [app-updates.ts](../../src/main/app-updates.ts).
- Hintergrund-Hosts prüfen ebenfalls auf Updates, standardmäßig alle sechs Stunden: [host-updater.ts](../../src/main/host-updater.ts). Ein solcher Check belegt keine menschliche Nutzung.
- Die öffentliche Distribution liegt in `Rasalas/tau-releases`: [electron-builder.yml](../../tooling/electron-builder.yml), [publish-release.mjs](../../scripts/packaging/publish-release.mjs).
- GitHub gibt pro Release-Datei `download_count` zurück. Das sind Dateiabrufe. Updates, Wiederholungen und mehrere Dateiformate können die Zahl erhöhen: [GitHub Release assets API](https://docs.github.com/en/rest/releases/assets).
- Der Releaseprozess ersetzt das Nightly-Release. Historische Downloadzahlen daher regelmäßig als Snapshot mit Release- und Asset-ID sichern; beim Ersetzen verschwindet der alte Zähler. Stabile Dateinamen und versionierte Dateien getrennt auswerten, Metadaten, Signaturen und Blockmaps ausschließen.
- Die aktuelle [Tau-Datenschutzerklärung](https://www.tbuck.de/privacy/tau/) sagt, dass die Desktop-App dem Betreiber nur verschlüsselte Push-Benachrichtigungen über den Relay schickt. Die Seite war über Web-Open nicht abrufbar und wurde über HTTPS mit curl gelesen. Eine neue Nutzungsübertragung braucht eine entsprechend geänderte Beschreibung.

### Welche Zahl wir veröffentlichen sollten

Als erste Produktkennzahl empfehlen sich **wöchentlich aktive Installationen mit freiwilliger Nutzungsstatistik**. Definition: unterschiedliche Client-Installationskennungen, von denen in den vergangenen sieben UTC-Tagen mindestens ein vom Menschen abgeschickter Agent-Prompt akzeptiert wurde. Für MAU gilt dieselbe Definition über 30 UTC-Tage. Zusätzlich getrennt erfassen, an welchen Tagen jemand die Workbench bewusst benutzt hat, etwa durch eine Interaktion in einem sichtbaren Fenster.

Ein Host, eine Runtime-Session, ein Subagent oder ein automatischer Wake ist kein zusätzlicher Nutzer. Tau kann mehrere Home Machines von einer Workbench aus steuern. Die Zählung gehört daher zum bedienten Client und nicht zu jedem Host: [ADR 0030](../adr/0030-the-workbench-controls-every-machine.md). Ein Mensch mit Desktop und Telefon erscheint zunächst als zwei Installationen. Ohne eine freiwillige geräteübergreifende Identität wissen wir nicht, dass sie derselben Person gehören.

Downloadzahlen getrennt veröffentlichen. Opt-in-Zahlen sind die beobachtete Teilmenge der Installationen; ohne begründetes Stichprobenmodell nicht auf sämtliche Nutzer hochrechnen. Ein erster empfangener Bericht ist ein erster beobachteter Client, nicht sicher eine neue Installation. Bestehende Nutzer, spätes Opt-in und Neuinstallation verzerren diese Zuordnung.

### Kleiner technischer Aufbau

Vorgeschlagener Aufbau, noch nicht implementiert:

1. Eine freiwillige Einstellung pro Gerät, zunächst aus. Erklärung: Tau übermittelt eine zufällige Kennung, Tag, App-Version, Plattform, Releasekanal und zwei Aktivitätsmerkmale. Die Entscheidung gilt nur für das Gerät, das sie getroffen hat.
2. Eine neue Zufalls-ID nur für diese Statistik im lokalen Client-Speicher. Keine Provider-Konto-ID, Host-ID, Geräte-Schlüssel oder Hardwarekennung wiederverwenden. Die Statistik-ID nicht mit synchronisierten Präferenzen kopieren. Eine stabile Zufalls-ID ist pseudonym, nicht anonym.
3. Pro Client und UTC-Tag ein zusammengefasster Datensatz mit `workbench_used` und `human_prompt_accepted`. Bei der ersten Aktivität senden, bei einem später akzeptierten Prompt höchstens eine Aktualisierung. Der Server vereinigt die Merkmale mit OR und dedupliziert über `installation_id + day`. So lassen sich DAU, WAU und MAU jeweils über unterschiedliche IDs im Zeitraum zählen; Tageszahlen niemals zur Wochenzahl addieren.
4. Für menschliche Prompts die Annahme im Workbench-Submissionpfad beobachten: [submission-controller.ts](../../src/renderer/submission-controller.ts). Im bestehenden Code kann `accepted: true` auch Slash-Befehle oder Preview betreffen; daher nur echte, bewusst ausgelöste Agent-Prompts markieren. Die passende Beobachtungsschnittstelle muss bei Umsetzung geprüft werden. Keine Texte, Dateipfade, Projekte, Thread-IDs, Antworten oder Modellzugangsdaten übertragen.
5. Ein separater kleiner HTTPS-Dienst mit Node und SQLite auf einem eigenen Server genügt für den Anfang. Nur ein streng validierter Schreib-Endpunkt, begrenzte Payloads und Rate Limits; Auswertungen nur nach Anmeldung. Kein dauerhaft geheimer API-Schlüssel in der ausgelieferten App, er wäre auslesbar. Öffentliche Meldungen bleiben manipulierbar, daher Ausreißer beobachten und solche Zahlen nicht als prüfsichere Personenstatistik darstellen.
6. Senden außerhalb des Start- und Promptpfads, mit kurzem Timeout und wenigen Wiederholungen. Fehler dürfen die Workbench nicht beeinflussen. UTC-Tage und ein begrenztes zulässiges Alter der Berichte serverseitig prüfen. In Phase 1 keine beliebige Offline-Historie nachladen; dadurch fehlen Offline-Nutzungen in der Statistik.
7. Dev-Builds, Demo, Tests und Smoke-Instanzen melden nichts. Mehrere Fenster und Wiederholungen müssen dieselbe Client-Tageszeile treffen. Ein Remote-Prompt zählt beim absendenden Client, nicht nochmals auf der Home Machine.
8. Identifizierbare Tageszeilen beispielsweise nach 90 Tagen löschen; ältere Zeitreihen nur als aggregierte Zahlen behalten. Abschalten stoppt Übertragungen und leert lokale ausstehende Berichte. Zusätzlich eine Löschfunktion für die bisherigen Datensätze dieser Kennung vorsehen, danach die lokale Kennung entfernen. Alte Backups müssen zur Löschfrist passen. Keine dauerhaften IP-Zugriffslogs für den Statistik-Endpunkt.

Die vorgeschlagene Implementierung lässt sich zunächst auf Desktop begrenzen. Mobile kann anschließend dieselbe Schnittstelle nutzen und wird mit eigener Client-ID separat ausgewiesen. Als öffentliches Beispiel eignet sich: "Diese Woche wurde Tau auf X Installationen aktiv genutzt, gemessen unter den Installationen mit freiwilliger Nutzungsstatistik." Das X ist ein Platzhalter, keine gemessene Zahl.

Die Empfehlung ist eine Produkt- und Architekturentscheidung. Es wurde kein Telemetriecode ergänzt und kein Dienst eingerichtet.

