# Nachrichtensuche und Indexsteuerung, 29. Oktober 2026

Umsetzung von Abschnitt 1 der verbindlichen
[t3-parity-next-ux-2026-10-29.md](t3-parity-next-ux-2026-10-29.md), auf dem
[persistenten Index](t3-search-index-2026-10-29.md) und der bereits gelieferten
[Paletten-Status-API](t3-navigation-followup-2026-10-29.md).
AGENTS.md, CONTEXT.md und die relevanten ADRs 0002, 0003, 0005, 0006, 0009,
0010, 0014, 0018, 0020 und 0037 wurden gelesen. Kein Unteragent, Commit, Push,
Testlauf, Typecheck, Build, Installationsschritt oder Appstart. Vorhandene fremde
Änderungen bleiben erhalten.

## Angeschlossen

Settings → Threads hat eine neue Karte Search auf Desktop, Web und Compact.
Sie verwendet SettingRow, SettingsState und Switch, mit den englischen
Produkttexten aus Opus. Index message text ist standardmäßig an. Message index
zeigt Fortschritt, Threadzahl, die Größe der veröffentlichten Indexdateien in
dezimalen MB und Fehlerursachen. Rebuild index wird bei einem Fehler zu Retry.
Ein ausgeschalteter Index wird ohne Bestätigung gelöscht. Full-access-Geräte
dürfen schreiben, Read-only-Geräte sehen deaktivierte Schreibaktionen mit dem
vorhandenen Grund. Ein Ladezustand erscheint erst nach 300 ms. Fehler beim
Schreiben bieten eine erneute Ausführung genau der fehlgeschlagenen Aktion.

Die Palette zeigt den Status in All und Threads ab drei Zeichen, zwischen
Ergebnissen und Tastaturfuß. MessageIndexFeed koalesziert Fortschrittsmeldungen
für die höfliche Live-Region auf höchstens eine Meldung pro fünf Sekunden.
Settings liest dieselben Host-Snapshots ohne diese Verzögerung. Auf älteren
Maschinen fällt die Quelle auf den bisherigen threads-Befehl zurück und meldet
den Index als unavailable.

Nachrichtentreffer haben You/Agent, markierte Suchwörter, einen eigenen
gesprochenen Namen und den Suchbegriff für die In-Thread-Suche. Enter öffnet den
Thread und dessen Suche; die vorhandene Stage-Aktion bleibt erhalten.
Archiv-Metadaten kommen über den bestehenden tau.thread-rail/settlement-Service.
Archivierte Titel stehen hinter den aktuellen Nachrichtentreffern. Archivierte
Nachrichtentreffer werden bereits vor dem Host-Limit nach hinten sortiert.
Alle Verknüpfungen laufen weiterhin durch paletteThreads und Thread-IDs.
Archiv-Metadaten fügen keine Kandidaten hinzu und können den Kindfilter nicht
umgehen. Änderungen der Threadliste starten die offene Palette neu, damit
gelöschte IDs nicht bis zur nächsten Tasteneingabe stehen bleiben.

Compact verwendet dieselbe search.thread-content-Contribution, mit ihrem
AbortSignal, ihren fortgesetzten Ergebnissen und ihrem Status. Das Suchfeld
lautet Title, project, branch or message. Titel-/Projekt-/Branchenzeilen und
maschinenübergreifende Navigation bleiben im vorhandenen Browser; die
Nachrichtentreffer werden dedupliziert darunter ergänzt.

## Laufender Vertrag

Alle Befehle gehören tau.search. Status, Suche und Cancellation sind read;
configure und rebuild sind normale Schreibaktionen, keine owner-only-Aktionen.

| Befehl | Eingabe | Antwort |
| --- | --- | --- |
| index-status | {} | MessageIndexStatus |
| index-configure | { enabled: boolean } | MessageIndexStatus nach Persistenz und gegebenenfalls Löschung |
| index-rebuild | {} | MessageIndexStatus; Aufbau läuft im Hintergrund |
| thread-search | ThreadSearchInput mit channel und optional continuation | ThreadSearchPage |
| thread-search-cancel | { channel } | void |
| threads | bisherige ThreadSearchInput | weiterhin ThreadMatch[] |

index-status wird außerdem als Host-Ereignis gepusht. MessageIndexStatus enthält
enabled, state, done, total, threads, bytes, error? und revision. state ist
ready, indexing, disabled, error oder unavailable. revision ordnet Snapshots
innerhalb einer Host-Aktivierung. Bei alten oder ungültigen Antworten behauptet
der Renderer keine vollständige Suche.

ThreadSearchPage enthält matches, status, complete und optional continuation.
complete heißt, dass diese Sucharbeit abgeschlossen ist. Ob sie nur den
Anfang/Ende-Fallback durchsucht hat, sagt weiterhin status. Ein continuation-Token
gehört zur Query, den Kandidaten, dem aktiven Thread, dem Archivfilter und dem
Limit auf genau diesem Kanal. Änderungen starten einen neuen Job. Die Quelle
verwendet pro Query einen eigenen Kanal, damit ein verspätetes Cancel keinen
neueren Job stoppen kann. Nach 30 Sekunden ohne Nachfrage werden Jobs bei der
nächsten Anfrage entfernt; die Registry ist auf ungefähr 32 Kanäle begrenzt.

Eine Abfrage gibt nach höchstens einem 80-ms-Wartefenster auf den Suchjob den
bisherigen Stand zurück. Die Quelle fragt ausstehende Jobs nach jeweils 150 ms
weiter ab. Treffer werden während des Scans angeboten. Die Palette liest eine
Quelle bei subscribeStatus erneut, ohne ihr Query-Signal abzubrechen. Ein
Sequenzzähler verwirft überholte Quellenantworten. Derselbe Anschluss versorgt
Compact. Eine noch laufende Fortsetzung behält einen Hinweis auf mögliche
fehlende Ergebnisse, auch wenn der Hintergrundaufbau gerade fertig wurde.
Die Vorbereitungszeit des Host-Aufrufs und Event-Loop-Verzögerungen kommen zum
80-ms-Wartefenster hinzu; es ist keine garantierte Gesamtlatenz.

Ein Wechsel zwischen Vollindex und Fallback verwirft bereits fertig gehaltene
Treffer ebenfalls. Ein abgeschlossener Rebuild aktualisiert eine noch offene
Query. Statusantworten dürfen weder neuere Host-Ereignisse noch deaktivierte
Zustände durch eine verspätete Leseantwort überschreiben.

## Generationen und Lebenszyklus

message-index.json speichert enabled und die veröffentlichte Generation im
State-Verzeichnis des Search-Kits. Die Textdateien liegen unter
message-index/<uuid>/messages-v1/. Neue Generationen entstehen getrennt von der
veröffentlichten. Der Zeiger wird erst nach allen Pi-Dateien, Runtime-Exporten
und der Größenberechnung atomar umbenannt. Fehlerhafte oder abgebrochene Exporte
veröffentlichen keine Ersatzgeneration. Erfolgreiche Legacy-Exporte melden
unavailable, weil ihre Präfixe keine vollständige Runtime-Suche sind.

Während Rebuild lesen Suchjobs die bisherige Generation. Alte Leser behalten
sie bis zum Ende ihrer serialisierten Arbeit; erst danach wird das alte
Verzeichnis entfernt. Normale Aktualisierungen kopieren die vorherigen Dateien
und extrahieren nur geänderte Pi-Dateien erneut. Ein expliziter Rebuild beginnt
ohne diese Kopie. Turn-Ende, Reset, Closed und die vorhandenen Lifecycle-Hooks
fordern Aktualisierungen an. Ereignisse während eines Aufbaus merken einen
weiteren Durchlauf vor. Eine Suche stößt nötigenfalls ebenfalls einen Update an,
höchstens alle fünf Sekunden. Der aktive Thread wird bei jeder Sucharbeit frisch
über transcript gelesen und bleibt gegenüber gespeicherten Treffern maßgeblich.

Ausschalten persistiert off, bricht die nächste Veröffentlichung ab, verwirft
Suchjobs, wartet auf laufende Indexleser und entfernt Generationen sowie den
früheren Index direkt unter messages-v1. Runtime-Aufrufe ohne native
AbortSignal-Unterstützung werden bei Cancellation aufgegeben; eine verspätete
Antwort kann keine Textstücke mehr schreiben. Eine gerade laufende Pi-Extraktion
endet noch für diese eine Datei, bevor ihr privates Verzeichnis gelöscht wird.
Die Deaktivierung der Erweiterung stoppt Beobachter und Jobs, wartet die Arbeit
ab und entfernt unveröffentlichte beziehungsweise ältere Generationen.

Der deaktivierte/unverfügbare Pfad schreibt keine Nachrichten auf Platte.
recent-text.ts dekodiert Pi weiterhin gestreamt, hält aber nur Anfang und Ende
im bisherigen Textbudget. Lücken bleiben getrennt und erfinden keine
Phrasenübereinstimmung. Runtime-Fallbacktexte bleiben im begrenzten RAM-Index.
Die aktive Runtime umgeht dessen Synchronisierungsfrist.

## Dateien und Parent-Anschlüsse

Neue Module und Regressionen liegen in kits/search/index-control*, index-feed*,
thread-search-feed*, settings* und recent-text*. Angepasst wurden host.ts,
desktop.tsx, protocol.ts, palette-sources.ts, die zugehörigen Host-/Desktoptests
und die API-Minor-Anforderung im Search-Manifest.

persistent-index.ts erhielt nur am Klassenende die Methoden indexPi,
searchCommittedPi, usage und reset. Die ersten beiden sind der schmale Anschluss
für einen prüfbaren Aufbau und das Lesen einer veröffentlichten Generation. Der
putRuntime-/Streaming-Abschnitt blieb unangetastet. runtime-threads.ts und dessen
Tests, src/main/thread-texts.ts, das Core-Runtime-Protokoll, Files und Workspace
wurden von dieser Arbeit nicht geändert. Deren vorhandene Änderungen gehören
weiterhin den anderen Implementierungen.

Die additiven Renderer-Anschlüsse sind bereits implementiert:

- SettingsCardId search und die Karte in ThreadsPage.
- PaletteItem.detailContent/ariaLabel und PaletteSearchContext.index.archivedThreadIds.
- Queryübergabe durch findInThread, requestFind/answerFind und TranscriptSearch.
- Wiederlesen einer Quelle bei subscribeStatus sowie bei geändertem Threadindex.
- use-message-search im Compact-Browser und dessen kleiner Rendering-Anschluss.

Der Parent muss die Queryübergabe im echten App-Lebenszyklus noch prüfen. Das
vorhandene switchSession-Versprechen und der aktive Transcript-Ref bestimmen,
wann der Find-Request das neue Transkript erreicht. Außerdem trägt ThreadMatch
weiterhin keine stabile Nachrichten-ID. Eine Mehrwortsuche nach getrennten
Tokens kann einen Treffer liefern, während die bestehende In-Thread-Suche den
zusammenhängenden Begriff sucht. Dafür fehlt ein gemeinsamer Trefferanker oder
ein gezielter Suchmodus. Diese Arbeit erweitert weder das Runtime-Protokoll noch
die Indexdatensätze dafür. Ein Sprung zum exakten Treffer ist deshalb bei solchen
Mehrworttreffern noch nicht garantiert. Diesen Vertrag muss der Parent mit dem
zuständigen Core-/Index-Scope vervollständigen.

Beim Neustart prüft die Runtime-Synchronisierung die gespeicherten Exporte über
die neue öffentliche Paging-Schnittstelle erneut. In dieser Zeit ist der
Aufbaustatus sichtbar. Die live angezeigten Threadzahlen während des Aufbaus
zählen zunächst Pi; Runtime-Threads und ihre Bytes sind nach dem Export im
veröffentlichten Gesamtwert enthalten. Eine Runtime bietet noch keinen eigenen
Fortschrittscallback an.

## Regressionen und Prüfung

Die neuen Tests prüfen Generationswechsel mit weiter lesbarer Vorgeneration,
Abbruch und Löschung während eines Rebuilds, persistiertes off nach Neustart,
rasches off/on, Fehler und Retry, Bytes/Threadzahl, die englischen Statuswörter,
fünf Sekunden zwischen Fortschrittsmeldungen, ältere Leseantworten, partielle
Suchantworten und Cancellation, das Verwerfen fertiger Treffer nach off,
Read-only-Settings, Archiv-Kindfilter, Snippet-Markierung, Queryübergabe,
Anfang/Ende-Fallback und die gemeinsame Quelle auf Compact. Die bestehende
Runtime-Hostfixture wurde an den gelieferten Paging-Vertrag angepasst; der Test
für Legacy-Präfixe fordert diesen Modus jetzt ausdrücklich an.

Ausgeführt wurde ausschließlich git diff --check im eigenen Scope, ohne Befund.
Kein Test ist hier als bestanden zu verstehen. Der Parent integriert und prüft
einmal kombiniert, mindestens:

```sh
npm test -- kits/search/index-control.test.ts kits/search/index-feed.test.ts kits/search/thread-search-feed.test.ts kits/search/settings.test.tsx kits/search/recent-text.test.ts kits/search/host.test.ts kits/search/desktop.test.tsx kits/search/persistent-index.test.ts kits/search/runtime-threads.test.ts src/renderer/components/CommandPalette.test.tsx src/renderer/components/TranscriptViewport.find.test.tsx src/renderer/touch/use-message-search.test.tsx
npm run typecheck:kits
node scripts/check.mjs typecheck -p tsconfig.json --noEmit
```

Die zugehörigen bisherigen Stream-/Relevanztests und die Checks des
Runtime-Paging-Scope sollte der Parent in denselben kombinierten Lauf aufnehmen.
Eine echte UI-Prüfung erfolgt ausschließlich im isolierten Tau-Testprofil.
