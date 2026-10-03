# Tau und T3 Code: Was sich zu übernehmen lohnt

Stand 3. Oktober 2026, Tau `08c103ed`. Wochenfenster 27. September bis 3. Oktober. Keine Anwendungscodeänderungen und keine neuen Laufzeit- oder Vergleichstests.

## Ergebnis

Tau fehlt keine große Gruppe der bis September untersuchten Funktionen mehr. Gerätehub, gemeinsame Starts über mehrere Runtimes mit Anhängen, Codex-Kontowechsel und Tiers, Reset-Credits, GitHub-Freigabe über Hosts, mobile Aktivitäten, SSH-Bootstrap und WSL sind implementiert. Implementiert heißt nicht überall auf echten Geräten und mit echten Konten abgesichert. Die wichtigste verbleibende Arbeit ist, diese Abläufe zuverlässig zusammenzubringen und auszuliefern.

T3s Orchestrator V2 ist ein Anlass, einzelne Lücken zu prüfen, kein Grund für einen Tau-Neubau. Tau hat persistente Queues, Wiederaufnahme nach Neustart und Limits, Delegation über Runtimes, Forks und Kontextübergaben bereits. Der nachfolgende [V2-Abgleich](t3-v2-coverage-audit-2026-10-03.md) zeigt jedoch Haltbarkeitsgrenzen: wartende Kind-Startaufträge und ausstehende Eltern-Fertigmeldungen liegen teilweise nur im Speicher, Queue-Zustellung hat eigene Crashfenster. Diese statischen Befunde benötigen gezielte Repros; die vorhandene Feature-Kategorie beweist keine vollständige Crashsicherheit.

## Anspruch als Auswahlkriterium

Die [README](../../README.md) beschreibt eine Workbench für Coding-Agents mit Terminal, Dateien und Reviews neben dem Gespräch. [ADR 0002](../adr/0002-core-owns-placement-extensions-own-features.md) beschreibt das Modell als "Neovim for coding agents": Core gibt gemeinsame Interaktion und Lebenszyklus vor, optionale Arbeitsschritte liegen in Kits. [ADR 0013](../adr/0013-agents-spawn-threads.md) macht delegierte Arbeit zu sichtbaren, steuerbaren Threads. [ADR 0005](../adr/0005-thread-runtime-backends.md) bindet einen Thread dauerhaft an seinen Runtime-Backend-Eigentümer.

Meine daraus abgeleitete Produktregel: Übernehmen, was Menschen Agent-Arbeit besser übergeben, beobachten, prüfen, steuern und sicher abschließen lässt. Nicht übernehmen, was nur die Feature-Liste verlängert oder funktionierende Eigentumsregeln versteckt.

## Was diese Woche bei T3 passiert ist

Die [datierte Primärquellenrecherche](t3code-2026-10-03.md) dokumentiert 126 main-Commits bis `d1034d62` am 3. Oktober 05:52 UTC. Sie nennt Stable [v0.0.45](https://github.com/pingdotgg/t3code/releases/tag/v0.0.45) vom 2. Oktober und das erste V2-[Nightly](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610) vom 3. Oktober. Dieses erste Nightly ist nicht als aktuellstes Nightly zu verstehen.

| Änderung | Veröffentlichungsstand laut datierter Recherche | Tau bei aktuellem HEAD |
|---|---|---|
| Projektlose Threads und Projekt aus Namen | Stable, [#13612](https://github.com/pingdotgg/t3code/pull/13612), [#14527](https://github.com/pingdotgg/t3code/pull/14527) | Implementiert, [Workspace-Host](../../kits/workspace/host.ts). |
| Gezielter Agent-Neustart mit neuer Discovery | Stable, [#14542](https://github.com/pingdotgg/t3code/pull/14542) | Für lokale Pi-, Claude- und Codex-Sessions implementiert. Attached-Sessions und Maschinen-Proxys nicht gleichwertig unterstützt. [Session-Steuerung](../../src/main/agent-session-control.ts). |
| Working-Bereich und Updates über Maschinen | Stable, [#13926](https://github.com/pingdotgg/t3code/pull/13926), [#14678](https://github.com/pingdotgg/t3code/pull/14678) | Bereits implementiert. Working ist optional und standardmäßig aus. [Rail](../../kits/thread-rail/meta.ts), [Umsetzungsnachweis](t3code-2026-10-03.md#umsetzung-in-tau). |
| Claude-Turn-Zuordnung und GitHub-Abfragen | Stable, [#14497](https://github.com/pingdotgg/t3code/pull/14497), [#14673](https://github.com/pingdotgg/t3code/pull/14673) | Claude-Fehler behoben, identische parallele GitHub-Leseabfragen zusammengefasst. Kein pauschaler Upstream-Performancegewinn für Tau. [Umsetzung](t3code-2026-10-03.md#umsetzung-in-tau). |
| Orchestrator V2 | Erstes Nightly, [#2829](https://github.com/pingdotgg/t3code/pull/2829) | Einzelne Funktionen vorhanden; generelle ACP-Registry, OpenCode-2-Pfad, offizieller Cursor-SDK-Pfad und allgemeines Scheduling nicht belegt. |
| Browser-Fokus und Downloads, Reconnect-Fixes | Stable bzw. main, [#15008](https://github.com/pingdotgg/t3code/pull/15008), [#14573](https://github.com/pingdotgg/t3code/pull/14573), [#14897](https://github.com/pingdotgg/t3code/pull/14897) | Regressionstest-Kandidaten, keine dadurch bestätigten Tau-Bugs. |

V2 ergänzt laut Recherche Pi, OpenCode 2, ACP-Registry, Cursor SDK, providerübergreifende Delegation, Fork-Rückführung, persistente Queue, Recovery, Scheduling und paginierte Historie. Ein Providerwechsel überträgt dort ausgewählte Nachrichten, keine vollständige native Session. Die Migration trennt V1- und V2-Datenbanken. Diese Detailangaben stammen aus der vorhandenen Recherche, der vollständige Release-Text ließ sich in dieser Sitzung nicht erneut abrufen.

Die erneute Web-Prüfung konnte die Stable-/Nightly-Release-Seiten als Treffer finden und den Inhalt des Fokus-PRs abrufen. Andere Abrufe lieferten ältere oder unpassende Treffer. Diese wurden nicht als Wochenbelege verwendet. Eine vollständige aktuelle Commitliste und alle Release-Daten wurden hier nicht unabhängig erneut bestätigt. Änderungen nach dem Cutoff sind daher kein vollständig geprüfter Teil dieser Bewertung.

## Echte Restlücken

| Lücke | Empfehlung und Grund |
|---|---|
| Cursor über ACP statt offiziellen SDK-Pfad | Gezielt untersuchen. [Cursor](../../kits/cursor/thread-backend.ts) nutzt `agent acp`, nicht `@cursor/sdk`. Native Wiederaufnahme, Background-Arbeit, Authentifizierung und Kosten vergleichen. Ein neuer SDK-Pfad ist nicht automatisch besser und darf bestehende CLI-/Abo-Abläufe nicht ungeprüft verdrängen. |
| OpenCode 2 | Kompatibilität prüfen, nicht als unterstützt verkaufen. [OpenCode](../../kits/opencode/host.ts) nutzt den bisherigen `opencode serve`-Pfad. Die Mindestversionsregel belegt keine Kompatibilität mit einer neuen Hauptversion. |
| Beliebige Agents aus einer ACP-Registry | Generisches optionales Kit erwägen, wenn konkrete gewünschte Agents fehlen. ACP selbst ist bereits vorhanden, unter anderem bei Cursor und Antigravity. Eine Registry-Auswahl mit frei installierbaren Agents ist nicht belegt. |
| Allgemeine geplante Aufgaben | Optionales Scheduling-Kit nur für echte wiederkehrende Arbeit. Wiederaufnahme nach Limit-Reset ist bereits vorhanden und kein allgemeines Scheduling. Ein sinnvoller erster Fall wäre ein täglicher CI-/PR-Bericht als normaler Thread, mit Ausfallregel, sichtbarem Ergebnis und ohne automatische Merge-/Deploy-Freigabe. |
| Session-Neustart auf Maschinen-Proxys und Attached-Pi | In das vorhandene Eigentumsmodell integrieren. Attached-Pi muss seinen Eigentümer ansprechen; kein zweiter Schreiber. Der derzeitige Neustart verlangt den aktiven Thread auf seiner Home Machine und lehnt Attached-Sessions ab. |
| Verwalteter öffentlicher Remote-Dienst | Tau Connect ist technisch implementiert, der eigene öffentliche Dienst wurde wegen Kosten zurückgestellt. SSH, Tailscale und eigene Relays sind vorhanden. Ein Login-und-fertig-Angebot bleibt eine Betreiberentscheidung, keine fehlende Transportbibliothek. [Umsetzungsstand](t3-parity-implementation-2026-09-30.md#folge-mr-und-verbleibende-voraussetzungen). |
| Auslieferung und echte Geräteprüfung | Hohe Priorität. Mobile Aktivitäten, Push, Hintergrundbetrieb, echte Konto-/Credit-Aktionen und Windows/Linux-Abdeckung haben dokumentierte Prüfgrenzen. Der frühere Umsetzungsstand nennt das fehlende Widget-Signing-Profil; dessen aktuellen Secret-Status habe ich nicht geprüft. [Gerätecheckliste](../mobile-device-checklist.md), [Umsetzungsnachweis](t3-parity-implementation-2026-09-30.md). |

## Was kein Defizit ist

- Die [Queue](../../src/main/queued-messages.ts) liegt auf dem Host und wird gespeichert. [Core](../CORE.md) dokumentiert gehaltene Queues nach Restart/Stop/Limit sowie opt-in Fortsetzung unterbrochener Turns.
- [Agents Kit](../../kits/agents/host.ts) startet gewöhnliche Threads mit wählbarer Runtime aus [Agent-Definitionen](../agent-definitions.md), auch remote. Es beobachtet sie, weckt Eltern und führt Worktree-Änderungen zurück. Unterschiedliche Provider können bereits zusammenarbeiten.
- [Handoff Kit](../../kits/handoff/handoff.ts) fasst sichtbares Gespräch und Ergebnisse für Übergabe und Rückführung zusammen. Das ist keine verlustfreie Übertragung von Tools, Gedanken oder Anhängen.
- Ein Runtimewechsel innerhalb desselben Threads widerspricht ADR 0005. Explizites "Continue in" mit neuem Thread ist die passendere bestehende Antwort. Pi-Modellwechsel und kompatibler Codex-Kontowechsel sind davon getrennte Operationen.
- Browser-Fokus ist nicht dieselbe Architektur wie bei T3. [Tau Preview](../../kits/preview/view.ts) bedient eine eigene View über CDP mit Focus-Emulation. Das spricht gegen das direkte Kopieren des Webview-Fokusfixes, ersetzt aber keinen Regressionstest.

## Wo Tau den besseren Schwerpunkt hat

Das sind belegte Tau-Stärken und meine Bewertung für unseren Anspruch. Sie sind kein Beweis, dass T3 jede dieser Fähigkeiten fehlt.

1. **Erweiterbarkeit als Produktmodell.** Eigene Kits können Runtime, Werkzeuge und Workbench erweitern, ohne optionales Verhalten im Core festzuschreiben. Pi-Konfiguration und Erweiterungen des Nutzers bleiben verwendbar. [Core](../CORE.md), [ADR 0002](../adr/0002-core-owns-placement-extensions-own-features.md).
2. **Delegierte Arbeit bleibt prüfbar.** Ein Kind ist ein echter Thread mit eigener Historie, Steuerung und getrennt anwendbaren Änderungen. [ADR 0013](../adr/0013-agents-spawn-threads.md).
3. **Arbeit abschließen auch ohne GitHub.** Lokale Reviews und mehrere Forge-Anbindungen passen zu unterschiedlichen Projekten, statt einen GitHub-PR vorauszusetzen. [Runtimes](../runtimes.md#pull-and-merge-requests), [Core](../CORE.md).
4. **Bestehende Serverprojekte sicher bearbeiten.** Server-Drift lesen, Änderungen lokal bearbeiten, Upload ausdrücklich bestätigen und Deployments zurückrollen ist ein eigener konkreter Arbeitsablauf. [Servers](../servers.md). Die dokumentierten Sicherheitsgrenzen bleiben wichtig.
5. **Explizite Eigentümer statt scheinbar nahtloser Migration.** Thread, Runtime und Home Machine bleiben nachvollziehbar. Ein Übergabeverlust wird nicht als fortgesetzte identische Session versteckt. [CONTEXT](../../CONTEXT.md), [ADR 0005](../adr/0005-thread-runtime-backends.md).

Keine gemessene Überlegenheit bei Geschwindigkeit, Stabilität oder allgemeiner Bedienqualität. Für mobile Einrichtung hat T3 mit einem betriebenen Connect-Dienst einen praktischen Vorteil gegenüber unserer derzeitigen Auslieferung.

## Was ich als Nächstes tun würde

1. Vorhandene Abläufe absichern: Queue während Host-Neustart, Eltern/Kind-Recovery, Limits mit wartenden Folgeprompts, Reconnect nach Sleep/Netzwechsel, Preview-Automation beim Tippen und Downloads ohne blockierende Dialoge. Besonders angenommene wartende Kind-Starts, noch nicht zugestellte Fertigmeldungen und Queue-Annahme vor dem nächsten Persistenzschritt prüfen. Fehlerklassen von T3 als Testfälle nutzen, nicht ungeprüft deren Patches übernehmen.
2. Die reale Release-Lücke schließen: signierte mobile Builds und echte Geräteprüfung; Windows/WSL/Linux in den dokumentierten Einsatzfällen. Öffentlichen Connect-Betrieb nur entscheiden, wenn die Zielnutzer ihn brauchen.
3. Cursor SDK und OpenCode 2 getrennt auf konkrete Vorteile prüfen. Erst danach Adapterarbeit beauftragen.
4. Scheduling klein und optional bauen, sobald ein wiederkehrender eigener Arbeitsablauf benannt ist.

Nicht übernehmen würde ich einen kompletten V2-Neubau, Runtime-Migration im selben Thread, neue zentrale Infrastruktur allein aus Parity-Gründen oder weiteres Geräte-3D-Polish vor realer Geräteprüfung.

## Rechercheausführung

Der angeforderte Hintergrundabgleich startete nicht: Lauf `746c4a0c-b0b8-4cd7-9bb0-46d837cc9922`, Fehler "Background children require a supported standalone Pi host or the installed npm package ... neither is available". Keine Child-Artefakte oder Änderungen. Checkout `feat/t3code-parity-assessment`, HEAD `08c103ed`, bei Fehlereintritt sauber. Kein Wechsel auf einen anderen Agentenweg. Die Bewertung verwendet den hier gelesenen Repository-Stand und die beschriebenen Web-Quellen.
