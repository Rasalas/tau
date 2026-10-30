# T3-Paritätsfortsetzung vom 29. Oktober 2026

Die angekündigten Folgefunktionen sind im gemeinsamen Worktree integriert.
UI-/UX-Entscheidungen und ein separates Bedienungsreview kamen vom ausdrücklich
angeforderten privaten Opus 5.5. Implementierungen liefen mit Sol XHigh/Priority,
technische Reviews mit Astra High/Priority. Es gibt keine Commits, Pushes,
veröffentlichten Gastlinks oder Änderungen an echten Pull Requests.

Die [vorherige Integration](t3-parity-implementation-2026-10-29.md) enthält die
bereits abgeschlossene erste Runde mit Runtime-, Git-, Mobile- und
Sicherheitskorrekturen. Grundlage bleiben die
[Upstream-Inventur](t3code-since-2026-10-11.md), der gepinnte T3-HEAD
`7a4f5b6188fed54ddc866723e39446a198b5835c` und die
[privaten UX-Vorgaben](t3-parity-next-ux-2026-10-29.md).

## Ergebnis

| Bereich | Integriertes Verhalten und Detailbericht |
| --- | --- |
| Suche | Vollständiger persistenter Pi-Index, versioniertes Paging anderer Runtimes, Tombstones, atomare Generationen, Einstellungen/Status und automatischer Wiederanlauf. Mehrworttreffer springen zur passenden Nachricht. [Index](t3-search-index-2026-10-29.md), [Paging](t3-runtime-search-paging-2026-10-29.md), [UI](t3-search-index-ui-2026-10-29.md), [Nachrichtensprung](t3-search-message-jump-2026-10-29.md). |
| Dateien | Passive Vorschauen für Office/OpenDocument, RTF, Archive, SQLite und EPUB; gespeicherte Notebookbilder einschließlich passivem SVG. Gemeinsamer Anschluss in Stage, Workspace-Files-Panel und Telefon-Sheet. [Vorschauen](t3-document-previews-2026-10-29.md). |
| Downloads | Explizite, begrenzte Downloads über die veröffentlichende Hostverbindung. Der vorhandene authentifizierte Ressourcenkanal vermeidet HTTP-/CORS-Probleme und funktioniert auch über unterstützte Socket-/Relay-Verbindungen. [Vertrag und Grenzen](t3-file-download-integration-2026-10-29.md). |
| Navigation | Konfigurierbare Snooze-Presets, direkte Untermenüsuche, F6-Bereichswechsel sowie ein Sidebar-Cursor durch echte Gruppen, Threads und virtualisierte Zeilen. [Grundlagen](t3-navigation-followup-2026-10-29.md), [Sidebar](t3-sidebar-navigation-integration-2026-10-29.md). |
| Webhooks | Begrenzte Wildcards, lokale Filterprobe und dauerhaft gespeicherte Sammelfenster mit Deduplizierung, Neustart-/Queue-Semantik und Signaturprüfung. [Bericht](t3-webhook-followup-2026-10-29.md). |
| Projekte | Projektlose Threads werden am bestehenden Ort zu Projekten. Thread-, Session-, Workspace- und Runtime-Identität bleiben erhalten; Git ist optional und standardmäßig aus. [Bericht](t3-project-promotion-2026-10-29.md). |
| Gastfreigaben | Separate gehashte Gastcredentials, ein Browser je Link, Ablauf/Widerruf, gefilterte Nachrichten/Tools und moderierte Vorschläge. Toolausgabe benötigt ausdrückliches Owner-Opt-in. [Gastlinks](t3-guest-sharing-2026-10-29.md), [Toolprojektion](t3-guest-tools-followup-2026-10-29.md), [ADR 0047](../adr/0047-guests-have-a-separate-http-audience.md). |
| Private CLI-Dateien | Owner-only-Eingabe, begrenzte private Dateileases, threadgebundene Freigabe und verlässliche Bereinigung. Keine Secretwerte in Toolantworten oder Zustandsereignissen. [Bericht](t3-private-secret-files-2026-10-29.md). |
| PR-Provider | Forgejo-Pflichtchecks mit konservativem Unknown-Fallback und Watch-Semantik; GitHub-Maintainer-Edits in beiden Ansichten mit Berechtigungs- und Versionsprüfung. [Bericht](t3-pr-provider-followup-2026-10-29.md). |
| Runtime und Terminal | Ein kontrollierter Claude-MCP-Wiederanlauf sowie quotierte Terminalpfade mit Leerzeichen und Unicode. [Bericht](t3-runtime-followup-2026-10-29.md). |

Die gemeinsame additive API und die Distributions-Mindestversion stehen auf
1.79.0. Neue Verträge sind in `docs/EXTENSIONS.md` dokumentiert.

## Reviews und Integration

Alle gemeldeten hochkonfidenten Befunde wurden behoben. Besonders relevant:

- Files aktiviert in-process, da der isolierte Extension-Worker verschachtelte
  Worker zu Recht verweigert. Einzelne Parser bleiben zeit-/speicherbegrenzt und
  lesen ausschließlich den ausdrücklich zugelassenen Workspace. Parallele
  Vorschauen werden eingereiht; Fehler sind erneut versuchbar.
- ODS berechnet wiederholten Text gegen das Ausgabebudget. SQLite entscheidet
  anhand des Originalschemas über virtuelle Tabellen, unabhängig von gekürzten
  Anzeigetexten. Views und virtuelle Tabellen werden nicht als Daten abgefragt.
- Notebookbilder dürfen lokale Bild-Blobs laden. Die Desktop-CSP wurde nur für
  `img-src blob:` ergänzt; Skripte aus Blobs bleiben gesperrt. Externe oder
  aktive SVG-Inhalte bleiben ausgeschlossen. Downloads lockern CSP/CORS nicht.
- Gespeicherte Secret-Leases überstehen Laufende, Stop, Runtime-Schließen und
  Reset bis zur gewählten Frist. Diese Ereignisse beenden offene Anfragen.
  Keine Fokusübernahme aus Terminal/Editor; korrekte, schließbare Endzustände.
- Gast-Deaktivierung wartet auf ausstehende Speicherungen. Widerruf wird vor
  Queue-Admission nach dem Wiederöffnen einer Runtime nochmals geprüft.
  Archivieren wartet auf dauerhaften Widerruf und private Dateibereinigung.
- Suchstatus trägt eine Host-Aktivierungs-ID. Vorübergehende Exportfehler
  erlauben spätere automatische Aktualisierungen. Unerreichbare persistierte
  Runtimequellen werden nicht als vollständig indiziert gemeldet.
- PR-Menüs bleiben beim Speichern eines Toggles offen. Forgejo-Pagination
  verwendet den vorhandenen Long-Command-Pfad. Fehlgeschlagene Promotion stellt
  auch einen aus einer vollen Projekthistorie verdrängten Eintrag wieder her.
- Webhook-Konfigurationswechsel lassen angenommene Anfragen ihre Prüfung
  beenden. Deaktivierung kann auch einen bereits begonnenen geordneten
  Listenerabbau abbrechen, ohne an einer wartenden Runtime hängenzubleiben.

## Verifikation

Der abschließende kombinierte Lauf bestand mit **1.003 Tests in 66 Dateien**.
Protokoll: `/tmp/tau-parity-final-combined-tests.log`. Ein weiterer Lauf mit
`TAU_TEST_SLOW_RENDERS=30` bestand mit **172 Tests in sechs Dateien**. Diese
Zahlen überlappen und werden nicht addiert. Die erste Runde ist separat im
vorherigen Integrationsbericht belegt.

Bestanden haben die Typprüfungen für Kits, Renderer, Electron, Mobile und beide
Extension-Scopes. Repository-Lint hat keine Fehler; bestehende Warnungen bleiben.
`git diff --check` ist sauber. Es wurde keine vollständige Testsuite ausgeführt.

`npm run build:budget` bestand einschließlich Desktop- und Browserprüfung nach
der unten erläuterten Größen-Neubaseline. Die letzte Desktop-Messung betrug
15.274 ms nach einer automatischen Wiederholung eines unter Last langsameren
Laufs. Die Browserprüfung betrug 12.935 ms. Zeitgrenzen wurden nicht erhöht.
Der isolierte Renderer-Bundle-Fixture bestand mit 132 ms First Paint und null
externen Requests. Das ist keine Messung des vollständigen Appstarts.
Der Fixture verwendet jetzt standardmäßig eigenes UserData unter `.tau-dev/`.

Praktisch in einer isolierten Tau-Instanz geprüft:

- Echter Pi-Lauf mit GPT-5.6 Luna, ausschließlich synthetischen Testdaten und
  `request_secret_file`. Ein Shellbefehl prüfte nur `test -r` und meldete READABLE.
  Die Lease blieb nach Laufende erhalten. Delete now beendete sie.
- Suche nach getrennten Wörtern `#CLI READABLE`, Wechsel zum passenden Thread,
  Nachrichtensprung und aktive CSS-Hervorhebung. F6 sowie Sidebar Home/End.
- Suchindex-/Snooze-Einstellungen, DOCX- und SQLite-Vorschau, hierarchische
  Archivliste und tatsächlich dekodiertes Notebook-SVG mit 160 px natürlicher
  Breite. Screenshots liegen unter `.tau-dev/parity-*.png`.
- Projektumwandlung ohne Git, Erfolg im Dialog, unveränderte Thread-ID sowie
  gleicher Projektname und gleiche ID nach Neustart. Für den Scratch-Fixture
  begrenzt `GIT_CEILING_DIRECTORIES` die Git-Suche auf `.tau-dev/`.
- Echter authentifizierter Socket-Download mit 277 bytegleichen Bytes und
  anschließender Capability-Freigabe. Die Datei liegt ausschließlich unter
  `.tau-dev/downloads/`. Download-UI und Clientfehler sind zusätzlich durch
  Komponenten-/Transporttests abgedeckt. Keine Datei wurde in das reale
  Downloads-Verzeichnis geschrieben.

Die eigene Desktop-Instanz und ihr Host wurden anschließend beendet. Neue
isolierte Starts verwenden den Test-Schlüsselbund. Reale Tau-Daten, reale
Schlüsselbundwerte und fremde App-/Gerätesitzungen wurden nicht verändert.

## Größen-Neubaseline

Die alten Größenlimits wurden zunächst überschritten. Eine separate
[Untersuchung](t3-release-budgets-2026-10-29.md) fand keine kleine, belastbare
Optimierung, die alle Lücken schließt. Es wurden weder Funktionsnamen noch
Sourcemap-Verträge geopfert und keine statischen Abhängigkeiten als scheinbar
lazy umetikettiert. Stattdessen dokumentiert `docs/PERFORMANCE.md` entsprechend
früheren Paritätsrunden einmalig den zusätzlichen Funktionsumfang:

| Gate | Gemessen | Vorheriges Limit | Neues Limit |
| --- | ---: | ---: | ---: |
| Desktop initiales JavaScript | 818.736 B | 810.000 B | 830.000 B |
| Desktop gesamtes JavaScript gzip | 574.164 B | 571.000 B | 580.000 B |
| Kit-Desktopcode | 3.519.994 B | 3.400.000 B | 3.600.000 B |
| Browser initiales JavaScript | 832.423 B | 827.000 B | 845.000 B |
| Browser gesamtes JavaScript gzip | 586.173 B | 583.000 B | 592.000 B |

Das ist eine ausdrückliche Größenfreigabe, keine behauptete Optimierung.
Zeit-, initiale gzip-, CSS-, gesamte Roh-JavaScript-, Speicher-, Transport- und
Framegrenzen bleiben unverändert.

## Grenzen

- Die praktische native Geräteprüfung bleibt durch das Device-Panel blockiert.
  Dessen Fehler war `No device 435F334A-EF13-41B1-84CD-1F8AD6A2E5AF on 'This machine' (hostId local). Call device_list for current ids.` Die vorgeschriebene
  einmalige Aktualisierung half nicht. Der eigene ungestartete Simulator wurde
  entfernt; keine fremde Sitzung oder verbotene CLI-Steuerung ersetzte ihn.
  Der zuvor ausgeführte native iOS-Simulator-Build bestand.
- Gastseiten brauchen eine bereits veröffentlichte, vom Gast erreichbare
  HTTPS-Adresse mit vertrauenswürdigem Zertifikat. Tau Connects reines
  WebSocketrelay veröffentlicht diese HTTP-Gastseite nicht. Geschlossene
  Runtimes liefern Gästen ihren zuletzt gespeicherten öffentlichen Snapshot.
- Downloads sind auf 10 MiB begrenzt. Native Apps haben noch keinen allgemeinen
  Speicherport für diese Formate und melden das ausdrücklich. Peer-Workspaces
  werden nicht über eine falsche lokale Ressourcenverbindung gelesen.
- Vorschauen sind passiv und begrenzt, keine Office-Renderer oder Ausführungs-
  umgebungen. SQLite zeigt einen Datei-Snapshot ohne nicht checkpointierte WAL-
  Änderungen. Unterstützte Formate und weitere Grenzen stehen in den Berichten.
- Der synthetische Suchbenchmark mit 500 Threads und 174 MiB Quellen benötigte
  22,539 s kalt, 355 ms warm und 97 ms nach Änderung einer Quelle. RSS-Werte von
  99–116 MiB sind Momentaufnahmen, keine Peaks. Es ist kein End-to-End-Benchmark
  einer realen Bibliothek. Der Status zeigt den kalten Aufbau deshalb an.
- Keine echte GitHub-/Forgejo-Mutation oder öffentliche Gastfreigabe wurde zum
  Test ausgelöst. Produktions-CI und eine spätere Geräteprüfung bleiben sinnvoll.

## Integration mit Main am 30. Oktober

Der Stand wurde auf `d5c3b30c0` integriert. Damit bleiben die neuen lokalen
MCP-Clients, Runtime-Wechsel, editorabhängigen Maschinenrouten und gemeinsamen
Textgenerierungsfunktionen aus Main erhalten.

- Webhooks verbinden native Tau-/GitHub-/Stripe-Signaturen, Payload-Opt-in und
  fortgesetzte Threads mit Filtern, dauerhaften Sammelfenstern und Maximaldauer.
  Providerabhängige Replay-Grenzen gelten auch für gesammelte Zustellungen.
- Titelanweisungen und Schutz vor veralteten Jobs verwenden die gemeinsame
  Runtime-/Modellwahl. Dateien behalten Vorschauen und Downloads neben den
  neuen lokalen beziehungsweise SSH-Editor-Routen.
- Der generische ACP-Provider exportiert vollständige, versionierte Nachrichten
  für die Suche, einschließlich mehrerer konfigurierter Agenten.
- `services.conversations` liest bei zurück zu Pi gewechselten Gesprächen den
  gespeicherten geerbten Verlauf und das aktuelle Pi-Segment ohne Runtime-Start.
  Search ersetzt alte Session-/Providerquellen erst nach vollständigem Commit.
  Aktuell externe Runtimes behalten ihre vorhandenen Suchquellen; deren
  vollständiger kanonischer Export bleibt eine eigene Schnittstellenerweiterung.
- Gastprojektionen behalten frühere Toolkarten nach Runtime-Wechseln. Bekannte
  Tau-MCP-Zugangsdaten und Gastcredentials werden auch bei einem abschließenden
  Base64url-Bindestrich aus freigegebenen Tooltexten entfernt.
- Die zusätzlichen öffentlichen Verträge tragen API 1.80.0. Gastfreigaben stehen
  in ADR 0047; Main verwendet ADR 0046 für externe MCP-Threadsteuerung.

Die kombinierte Prüfung umfasste 106 Testdateien und 1.663 Fälle. Fünf Fehler
in Fixtures und Integrationsannahmen wurden korrigiert; die betroffenen fünf
Dateien bestanden anschließend alle 104 Fälle. Alle acht Typprüfungsbereiche
und Lint bestanden. Das initiale Browser-JavaScript maß 258.021 gzip-Bytes;
die dokumentierte kombinierte Größengrenze liegt nun bei 259.000 Bytes.
Der frische vollständige Release-Build bestand anschließend alle Budgets und
enthielt keine kompilierten Testmodule. Der echte isolierte Host-/Runtime-/
Browser-Smoke bestand alle fünf Schritte; seine Signatur-Fixture verwendet
einen zufälligen 32-Byte-Schlüssel entsprechend der neuen Validierung in Main.
Alle eigenen Testprozesse und Listener wurden beendet.
