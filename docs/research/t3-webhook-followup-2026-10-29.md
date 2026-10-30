# Webhook-Wildcards und persistente Ereignisfenster, 29. Oktober 2026

## Quellen und Umfang

Gelesen wurden `AGENTS.md`, `CONTEXT.md`, ADR 0006, 0009, 0010, 0014,
0020 und 0022 sowie die Berichte
[Inventur](t3code-since-2026-10-11.md),
[bisherige Integration](t3-parity-implementation-2026-10-29.md) und
[bisherige Filter](t3-webhook-filters-2026-10-29.md).
Die UI folgt Abschnitt 3 des
[Opus-Berichts](t3-parity-next-ux-2026-10-29.md), der vor den UI-Änderungen vorlag.
Es wurden keine eigenen UX-Entscheidungen für neue Abläufe getroffen.

Upstream wurde ausschließlich lesend unter
`/tmp/tau-t3code-upstream-20261029` untersucht. Der bestätigte HEAD ist
`7a4f5b6188fed54ddc866723e39446a198b5835c`.

- [defb7e6e, Array-Wildcards](https://github.com/pingdotgg/t3code/commit/defb7e6e6b87d03259745367214db13060fb322b),
  insbesondere `apps/server/src/scheduledTasks/webhookFilter.ts`.
- [2ebe280e, Replay-Dedupe und Coalescing](https://github.com/pingdotgg/t3code/commit/2ebe280e5602f23fc2742297da3d3b6f2b1b8fca),
  insbesondere `apps/server/src/scheduledTasks/webhookDedupe.ts`.
  Relevant sind persistente Annahme, feste Fenster, das Einfrieren abgelaufener
  Fenster und Kapazitätsprüfung vor der Bestätigung.
- [0c85b0d, Payload-Filter](https://github.com/pingdotgg/t3code/commit/0c85b0d9977fe9376bf9a4b063a4dd8ab8c97ae6)
  ist die Quelle der bestehenden Signatur-vor-Filter- und Altclient-Regeln.

Die Implementierung bleibt im Scheduling-Kit. Keine Core- oder
Dependency-Anschlüsse und keine Änderungen an `secrets.ts`, `secret-card.tsx`
oder `feed.ts`. In `protocol.ts` wurden nur Schedule-, Job- und
Webhook-Typen ergänzt. Secret-Verträge bleiben beim Parent.

## Filtersemantik

Ein Namens- oder Indexsegment darf mit `[]` enden, etwa
`groups[].labels[].name`. Höchstens zwei solche Segmente pro Pfad sind erlaubt.
Bestehende numerische Indizes bleiben gültig. Es gibt keine Ausdrücke,
rekursiven Wildcards oder implizite Typumwandlung.

`equals` verlangt mindestens einen erreichten Wert mit demselben JSON-Typ und
Wert. `exists` verlangt mindestens einen erreichten eigenen JSON-Wert.
`null`, `false`, `0`, leere Strings, Objekte und Arrays zählen als Werte.
`labels[]` existiert bei `[null]`, aber nicht bei `[]`. Bei
`labels[].name` muss mindestens ein Element tatsächlich das eigene Feld `name`
haben. Eine nicht leere Liste ohne dieses Feld reicht nicht.
Nicht-Arrays an `[]` liefern keine Kandidaten. Array-Metadaten,
String-Indizes und geerbte Felder bleiben ausgeschlossen.

Die vorhandenen Grenzen bleiben: 16 UND-Regeln, 256 Zeichen und 16 Segmente pro
Pfad, 1.024 Zeichen pro Stringvergleich. Ein gemeinsames Budget von 32.768
Traversierungsschritten pro Filterauswertung begrenzt die Arbeit. Erschöpft
eine Regel das Budget, passt die gesamte Filtermenge nicht. Frühe erfolgreiche
Treffer müssen die restliche Liste nicht mehr durchlaufen.

## Annahme und Persistenz

```json
{
  "kind": "webhook",
  "filters": [{ "path": "labels[].name", "op": "equals", "value": "bug" }],
  "coalescing": { "keyPath": "issue.number", "waitSeconds": 120 }
}
```

Der Key-Pfad verwendet denselben Parser, ohne `[]`. Skalare Schlüssel behalten
ihren Typ. `7` und `"7"` sind getrennt; `null`, `false`, `0` und `""` sind
brauchbare Schlüssel. Fehlende Schlüssel, Container, nichtendliche Zahlen oder nicht parsebares JSON
bekommen jeweils ein eigenes sofort fälliges Fenster. Ohne Filter bleibt damit
der bisherige Raw-Body-Vertrag erhalten.

Die erste Lieferung legt `at` und `dueAt` fest. Bis ausschließlich `dueAt`
können weitere passende Lieferungen denselben Key, Key-Pfad und dieselbe
Wartezeit teilen. Sie ersetzen nur die letzte Raw-Payload und erhöhen den
Zähler. Sie verlängern das Fenster nicht. Ein abgelaufenes Fenster bleibt
unverändert, auch wenn ein anderer Run oder die Queue seinen Start verzögert.

Annahme und Delivery-ID werden gemeinsam atomar in `jobs.json` gespeichert,
bevor HTTP 202 zurückkommt. Die bestehende HMAC-Prüfung über Zeitstempel, ID und
Raw-Body bleibt vor Payload-Auswertung. Signaturzeitfenster, Dedupe vor Filtern
und erneute Prüfung von Aktivierung, Secret-Referenz und Filtern beim Verlassen
der Queue bleiben erhalten. Nicht passende Lieferungen ergeben HTTP 204 und
belegen keine Kapazität. Ressourcen- und Zustandskonflikte ergeben HTTP 409,
ohne die abgewiesene ID zu übernehmen. Ein Persistenzfehler deaktiviert den
Empfang; dabei kann die Verbindung vor der Fehlerantwort schließen. Ein
Retry bleibt durch die gespeicherten IDs und Fenster abgesichert.

Pro Fenster speichert die Maschine nur die letzte Payload, Base64-kodiert,
und einen SHA-256-Digest des typisierten Schlüssels. Base64 ist keine
Verschlüsselung. Der vorhandene private State-Store enthält diese Daten bis
zum Start oder ausdrücklichen Verwerfen. Öffentliche Job-Antworten und Events
enthalten ausschließlich ID, Beginn, Fälligkeit und Anzahl. Payloads und
Key-Digests gehen nicht in Prompts, Transcript-Einträge, Events, Befehlsantworten
oder Logs. Der Prompt bleibt der gespeicherte Automation-Prompt. Die letzte
Payload dient der erneuten Filterprüfung, es gibt keine neue Payload-Vorlage
und keinen neuen Payload-Zugriff für die Runtime.

Grenzen:

- Wartezeit 10 bis 3.600 ganze Sekunden, UI-Standard 120.
- Höchstens 64 KiB Raw-Body pro kombinierter Lieferung. Der bestehende
  HTTP-Empfang ohne Zusammenfassen bleibt bei 1 MiB.
- Höchstens 16 wartende Runs pro Job und 10.000 Lieferungen pro Fenster.
- Weiterhin 100 akzeptierte Delivery-IDs pro Job im Fünf-Minuten-Fenster.
  Wiederholte IDs belegen keinen weiteren Platz.
- Der 2-MiB-Gesamtstore zählt alle wartenden Payloads mit und reserviert
  12 KiB pro Job für Delivery-Historie und Run-Intent. Ein zusätzliches Limit
  zählt den tatsächlichen serialisierten Zustand. Die State-Writes verwenden
  kompaktes JSON, damit der gespeicherte Umfang diesem Budget entspricht. Auch eine Vergrößerung der
  letzten Payload kann deshalb abgewiesen werden, ohne die alte zu ersetzen.
- Die bestehende Mutationsqueue bleibt bei 100 Operationen. Ein fälliges Fenster
  bleibt bei voller Queue gespeichert und wird später erneut zugelassen.

## Updates, Restart und Recovery

Ein fehlendes `coalescing` bei einem Webhook-Update bewahrt den gespeicherten
Wert für ältere Clients. `coalescing: null` schaltet das Zusammenfassen
nachfolgender Lieferungen ausdrücklich aus. Fehlende `filters` bewahren weiter
die Regeln, `filters: []` löscht sie ausdrücklich.

Offene Fenster behalten Key-Pfad und Wartezeit. Änderungen dieser Optionen
wirken auf neue Fenster. Bestehende Fenster laufen auch nach `coalescing: null`
zu Ende. Bei offenen Fenstern sind Änderungen an Filtern, Prompt, Projekt,
Runtime, Zugriff und Ausführungsgrenzen abgewiesen. Der Name darf sich ändern.
Ein kompatibles Update erhält die Aktivierung, damit es akzeptierte Fenster
nicht unbeabsichtigt ausschaltet. Das Editor-Häkchen zum Ausschalten sendet
gegebenenfalls ausdrücklich `disable`.

`disable`, Löschen und globales Ausschalten verwerfen offene Fenster bewusst.
Die Delivery-Historie bleibt beim Ausschalten bestehen. Ein erneuter POST mit
einer schon angenommenen ID stellt verworfene Arbeit nicht wieder her.
Ein Wechsel des Signaturschlüssels verlangt zunächst ausdrückliches Ausschalten,
wenn Fenster offen sind.

Vor dem Threadstart ersetzt eine einzige atomare Speicherung das fällige
Fenster durch den bestehenden `starting`-Intent. Dieser hält Fenster-ID und
Lieferungsanzahl. Ein Neustart vor diesem Übergang setzt das gespeicherte
Fenster fort, auch wenn es während der Unterbrechung fällig wurde. Ein Neustart
nach diesem Übergang hält den Job als `uncertain`; es gibt keinen automatischen
zweiten Start. Weitere akzeptierte Fenster bleiben gespeichert.

Shutdown stoppt Timer und Annahme, wartet auf einen laufenden State-Write und
verhindert Mutationen aus der restlichen Queue. Ein bereits laufender
Runtime-Start darf nach Shutdown noch zurückkehren. Er schreibt dann keinen
neuen Zustand mehr; der gespeicherte Intent bleibt für die bestehende manuelle
Unsicherheitsentscheidung erhalten. Ein unbegrenzt wartender Runtime-Start
blockiert das Herunterfahren nicht.

Fehler beim Start oder Abschluss lösen keine automatische Wiederholung aus.
Ein ausdrückliches Retry wiederholt den aufgezeichneten Intent zuerst und
bewahrt spätere Fenster. Bei `uncertain` bleibt die bestehende Bestätigung des
Duplikatrisikos erforderlich, und die Automation wird ausgeschaltet.
Andere Fenster bleiben dann bis zum erneuten Opt-in erhalten, auch über einen
weiteren Neustart. `Skip` überspringt den betroffenen Intent; bei einem vor
Intent-Erstellung gehaltenen Fenster verwirft es genau dieses Fenster.
Die globale Opt-in-Schranke, Prüfung des vorherigen laufenden Threads und
Maximaldauer-Prüfungen nach Schlaf oder rückwärts verstellter Uhr bleiben aktiv.

Ungültige gespeicherte Optionen, übergroße oder inkonsistente Fenster und eine
Fenster-ID zugleich im Intent und in der Warteliste verhindern die Aktivierung.
Der Store wird dabei nicht zurückgesetzt. Ältere gespeicherte Jobs ohne neue
Felder brauchen keine Migration. Alte Programmversionen verstehen die neuen
Felder nicht und lehnen den Store mit ihrem bestehenden strikten Decoder ab;
Downgrade ist keine verlustfreie Bearbeitungsmöglichkeit.

## UI und Regressionen

Die UI verwendet die im Opus-Bericht festgelegten Texte und Anordnung:
Wildcard-Hilfe und Inline-Pfadfehler, einen eingeklappten lokalen Sample-Test,
`Bursts` unter den Regeln, Key und Wartezeit, Zusammenfassung, Lieferungszähler
und Countdown. Der Sample-Text bleibt im lokalen React-State und wird nicht
an die Maschine gesendet. Er ist auf 65.536 Zeichen begrenzt. Der Countdown
ist keine ARIA-Live-Region. Der Host weist zusätzliche manuelle Starts bei
wartenden Fenstern mit einem konkreten Fehler ab. Das bestehende Menü und
seine Fehleranzeige bleiben dafür erhalten.

Regressionen wurden geschrieben, nicht ausgeführt:

- `webhook-filters.test.ts`: typisierte Treffer, Existenz mit fehlenden
  Suffixfeldern, zwei Wildcards, Indizes, ungültige Syntax und Schrittbudget.
- `webhook-pending.test.ts`: striktes Decoderverhalten, Key-/Zeit-/ID-Konsistenz,
  Body- und Zählergrenzen, eingefrorene Fenster, Gesamtbudget und Redaktion.
- `webhooks.test.ts`: signierte HTTP-POSTs, feste Fenster und letzte Payload,
  Restart und Dedupe, getrennte Keys, fehlende Keys, Busy-Queue, Updates und
  Altclients, explizites Ausschalten/Löschen, Startfehler/Retry, Rate-Limit,
  Shutdown während Dispatch, unsicherer Intent, spätere erhaltene Fenster,
  veraltete Filter nach Queue-Wartezeit, ungültiger Store sowie ein
  fehlgeschlagener atomarer State-Write ohne Bestätigung oder Payload-Log.
- `page.test.tsx`: lokaler Sample-Test ohne Host-Übertragung, Inline-Fehler,
  Speichern und Ausschalten von Bursts, Wartestatus ohne Live-Region und
  ausdrückliches Ausschalten aus dem Editor.
- `job-summary.test.ts`: Zusammenfassung, Countdown und abgeschlossene
  Lieferungsanzahl.

Auftragsgemäß keine Tests, Typechecks, Builds, Installationen oder Appstarts.
Keine Commits, Pushes oder externen Mutationen. Die beschriebenen Regressionen
sind noch keine bestandenen Prüfungen. Der Parent muss die Kit-Typprüfung und
betroffenen Scheduling-Tests einmal gesammelt ausführen. Eine visuelle
App-Prüfung steht ebenfalls aus.

## Geänderte Dateien dieser Fortsetzung

`kits/scheduling/host.ts`, `store.ts`, `protocol.ts`, `validation.ts`,
`webhook-filters.ts`, `webhook-filters.test.ts`, `webhooks.test.ts`,
`editor.tsx`, `webhook-filter-editor.tsx`, `page.tsx`, `page.test.tsx`,
`job-summary.ts`, `styles.css`.

Neu: `kits/scheduling/webhook-path.ts`, `webhook-coalescing.ts`,
`webhook-pending.ts`, `webhook-pending.test.ts`, `webhook-bursts-editor.tsx`,
`job-summary.test.ts` sowie dieser Bericht.

Die schon vorhandenen Änderungen an `host.test.ts` und `webhooks.ts` wurden
nicht bearbeitet. Andere Änderungen im gemeinsamen Worktree wurden erhalten.
