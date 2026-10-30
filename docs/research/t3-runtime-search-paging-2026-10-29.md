# Vollständige Runtime-Textexporte, 29. Oktober 2026

Die 64k-Grenze geschlossener Nicht-Pi-Threads ist im neuen Exportpfad entfernt.
Suchindex und Runtime tauschen begrenzte Seiten aus. Eine neue Indexdatei wird
erst nach der letzten Seite und allen Nachrichtenabschlüssen veröffentlicht.
Die bisherigen 64k-Delta-Antworten bleiben für alte Clients unverändert.

Gelesen wurden `AGENTS.md`, `CONTEXT.md`, die ADRs 0005, 0006, 0009, 0018,
0020 und 0037 sowie die verbindlichen Suchvorgaben aus
[t3-parity-next-ux-2026-10-29.md](t3-parity-next-ux-2026-10-29.md) und der Befund
in [t3-search-index-2026-10-29.md](t3-search-index-2026-10-29.md).
Die Suche liest weiterhin ausschließlich den freigegebenen Befehl
`thread-texts`, niemals einen privaten Runtime-Store. Keine neuen Berechtigungen,
Dateipfade in Requests oder Änderungen an der UI. API 1.79.0 wurde beibehalten.

## Geänderte Module

| Modul | Änderung |
| --- | --- |
| `src/main/thread-texts.ts` | Opt-in-Protokoll 2, Katalogdelta, gebundene Cursor, begrenzte Chunks und Nachrichtenabschlüsse; alter Delta-Pfad unverändert |
| `src/main/host-extension-api.ts` | Neue Exporttypen und gemeinsame Paging-Funktionen veröffentlicht |
| `kits/_shared/session-store-persistence.ts` | Protokoll 2 an den bestehenden Text-Worker delegiert, akzeptierte Schreibvorgänge vor dem Lesen abgewartet |
| `kits/_shared/session-store-persistence-worker.ts` | Aktueller SQLite-Katalog und einzelne Textseiten in Lesetransaktionen, Versionsprüfung anhand dauerhafter Revisionen |
| `kits/search/runtime-threads.ts` | Vollständige Exporte seitenweise persistiert, Änderungen und Tombstones verarbeitet, Abdeckung je Quelle ausgewiesen |
| `kits/search/persistent-index.ts` | Ausschließlich der bisherige `putRuntime`-Abschnitt und die neue Streaming-Methode `putRuntimeStream` ergänzt; sonstige Klassenabschnitte unberührt |

Die Hostdateien der einzelnen Runtimes sind unverändert. Claude Code, Codex,
Antigravity, Cursor, Grok und OpenCode delegieren bereits an denselben Store und
bekommen den neuen Export damit automatisch. Ihre bisherigen Rückgabetypen
bleiben kompatibel.

## Neue API

`ThreadTextsRequest` behält `known` und `limit`. Neue optionale Felder sind
`protocol: 2`, `knownVersions`, `page` und `maxChars`.
`ThreadTextsAnswer` behält `threads`, `removed` und `more`; für das neue
Protokoll kommen `protocol`, `catalog` und gegebenenfalls `page` dazu.

Exportiert werden zusätzlich:

- `ThreadTextCatalogEntry`: `threadId`, `updatedAt`, opake `version`.
- `ThreadTextPageRequest`: `threadId`, feste `version`, optionaler `cursor`.
- `ThreadTextChunk`: `messageId`, `role`, UTF-16-`offset`, `text`, `end`.
- `ThreadTextPage`: Identität und Version, `status`, `chunks`, `nextCursor`.
- `ThreadTextsPagedAnswer`: Antwort mit garantiertem Protokoll- und Katalogfeld.
- `threadTextsCatalog` und `threadTextPage`: gemeinsame Implementierung, die
  unverändert in den bestehenden SQLite-Worker eingebettet wird.

Kataloganfrage:

```ts
{ protocol: 2, known: { existing: 123 }, knownVersions: { existing: "revision" }, limit: 25 }
```

Der Katalog enthält ausschließlich Metadaten. `limit` begrenzt geänderte
Katalogeinträge, `more` zeigt weitere Einträge an. `removed` prüft alle bekannten
IDs unabhängig von Limit und Textbudget. Die zusätzlichen alten `known`-IDs
ermöglichen Tombstones direkt nach einem Neustart, bevor der Client die neuen
Revisionen wieder kennt.

Textanfrage:

```ts
{ protocol: 2, page: { threadId: "existing", version: "revision", cursor }, maxChars: 64_000 }
```

Eine Seite enthält höchstens 64.000 UTF-16-Einheiten und 256 Chunks; ein Chunk
enthält höchstens 16.384 Einheiten. Kleinere Budgets werden unterstützt,
mit einem Minimum von zwei Einheiten für ein Surrogatpaar. `nextCursor: null`
bestätigt den vollständigen Export, auch bei leeren Transkripten. `more` bezieht
sich ausschließlich auf den Katalog. Ein Seitenende beendet keine Nachricht.
Nur `end: true` schließt die Nachricht ab.

Cursor sind an Thread, Revision, Speicherordinal und Textoffset gebunden.
Ungültige Cursor, Offsets in einem Surrogatpaar und Offsets außerhalb des Texts
werden abgewiesen. Chunks trennen keine zusammengehörigen Surrogate; auch
Claude-Code-`textChunks` werden als zusammengehöriger sichtbarer Nachrichtentext
exportiert. Nur sichtbarer User- und Assistant-Text wird übernommen. Notices,
Toolausgaben und leere Texte liefern keine Chunks. `messageId` ist ein
Speicherordinal innerhalb der Revision, keine UI-Nachrichten-ID zum Anspringen.

`status` ist `ok`, `changed`, `missing` oder `invalid-cursor`. Ein Versionswechsel
liefert keine Textchunks der neuen Version unter einem alten Cursor. Der
Suchindex akzeptiert nur `ok` mit exakt der angeforderten Version.

## Versionen, Neustart und Veröffentlichung

Der gemeinsame SQLite-Store benutzt seine bereits vorhandene UUID-Revision je
Schreibvorgang. Sie bleibt nach einem Neustart gleich und ändert sich auch bei
gleichem oder rückläufigem `updatedAt`. Ein konkurrierender Writer kann daher
keine zweite Textversion unbemerkt an eine begonnene Seitenfolge anhängen.
Jede Seite prüft Revision und Daten in derselben Lesetransaktion. Löschungen
liefern `missing`; der nächste Katalog liefert den Tombstone. Für vollständig
im Speicher vorliegende Records, einschließlich des bestehenden Read-only-
JSON-Fallbacks, leitet `threadTextsDelta` die Version durch SHA-256 aus dem
Record und seinen Nachrichten ab.

`putRuntimeStream` konsumiert einen asynchronen Chunk-Iterator und schreibt in
eine unveröffentlichte Generation. Es prüft Rollen, steigende Nachrichten-
ordinale, lückenlose Offsets und Nachrichtenabschlüsse. Ein Streamfehler,
Versionswechsel oder fehlender Abschluss bricht den Schreibvorgang ab; die
bestehende atomare Schreibfunktion entfernt die temporäre Datei. Der alte
Index bleibt auf Platte intakt. Eine als geändert bestätigte Runtime-Version
wird bis zum gelungenen Export aus Suchergebnissen ausgeblendet. Es erscheinen
weder halbe Nachrichten noch Treffer aus gemischten Generationen.

Die Exportrevision steht als `runtime-v2:<revision>` im vorhandenen
Fingerprint-Feld der Indexdatei. Nach einem Neustart wird der Katalog erneut
abgerufen; passende persistierte Revisionen sparen durch die lazy Iterator-
Factory sämtliche Textseiten und den Neuaufbau. Dafür musste das bestehende
`catalog()`-Format nicht geändert werden. In laufenden Instanzen unterdrückt
`knownVersions` unveränderte Katalogeinträge vollständig.

Fehlgeschlagene Exporte werden nur innerhalb des aktuellen Syncs quittiert,
um spätere Katalogseiten nicht zu blockieren. Beim nächsten Sync werden sie
erneut angefordert. Tombstones entfernen auch Dateien einer zuvor
fehlgeschlagenen Ersatzgeneration und bleiben je Quelle getrennt.

## Vollständigkeit und ältere Maschinen

`RuntimeThreadIndex.coverage()` liefert `RuntimeSearchCoverage[]`, je Quelle
`complete`, `partial` oder `unavailable`. Mögliche Gründe sind `legacy-prefix`,
`export-failed`, `catalog-stalled` und `memory-budget`.

Provider ohne bestätigtes Protokoll 2 liefern weiterhin ihre bisherigen
Präfixe. Provider, die unbekannte Felder ablehnen, bekommen zusätzlich einen
Request im alten Format. Beide Fälle melden `partial` mit `legacy-prefix`,
auch wenn alle alten Delta-Seiten erfolgreich gelesen wurden. Unerreichbare
Quellen melden `unavailable`; ihre unbestätigten Neustartdaten werden nicht
durchsucht. Ein Fehler einer bereits als Protokoll-2-fähig bestätigten Quelle
führt nicht zu einem vermeintlich vollständigen Legacy-Index.

Der Parent muss diese Abdeckung in seinen neuen Host-/Statuspfad übernehmen:
Nur ausschließlich vollständige relevante Quellen rechtfertigen einen
vollständigen Indexstatus. Für alte Provider ist der durch die UX vorgegebene
Fallbacktext weiterhin zutreffend. Dieser Teilauftrag verändert weder
`kits/search/host.ts` noch `desktop.tsx`, `protocol.ts`, Settings oder Palette.
Der optionale bisherige Speicherindex benutzt weiter seine alte Präfix-API
und meldet ausdrücklich nur teilweise Abdeckung.

## Speicher und Transport

Im Suchprozess bleibt höchstens eine Textseite plus der vorhandene begrenzte
Schreibpuffer erhalten. Es gibt kein Array des vollständigen Exporttexts und
keinen Textverlust durch das frühere Gesamtbudget des RAM-Caches. Katalog,
bekannte Versionen und Threadidentitäten benötigen weiterhin Speicher
proportional zur Threadzahl.

Der SQLite-Worker dekodiert jeweils eine gespeicherte Nachrichtenzeile und
liest spätere Nachrichten erst bei Bedarf. Sehr große einzelne JSON-Nachrichten
werden dort weiterhin als einzelne Zeile dekodiert; bei Claude Code kann das
Zusammenfügen ihrer gespeicherten `textChunks` ebenfalls Speicher proportional
zu dieser einen Nachricht brauchen. Dieser bestehende Zeilenbedarf bleibt im
Worker und überquert weder dessen Grenze noch den Runtime-Befehl. Ein strikt
konstanter Speicherbedarf innerhalb des SQLite-Workers wird nicht behauptet.
Es entsteht kein vollständiges Transkriptarray und keine Hydrierung fremder
Threads für die Suchausgabe.

## Regressionen und Parent-Checks

Neue Regressionen stehen in:

- `src/main/thread-texts.test.ts`: vollständige große Exporte, UTF-16-Offsets,
  Surrogatgrenzen, Nachrichtenabschlüsse, unveränderte Legacy-Grenze,
  gleiche Zeitstempel, gebundene Cursor, leere Exporte, Tombstones und viele
  kleine Nachrichten.
- `kits/_shared/session-store-persistence.test.ts`: diskbasierte Seiten,
  stabile Revision nach Neustart, fremder Writer mit gleichem Zeitstempel,
  Löschung und bewusst veralteter Katalog des Aufrufers.
- `kits/_shared/session-store-lazy.test.ts`: alle sechs Runtime-Stores,
  Claude-Code-`textChunks`, große Exporte ohne fremde Payload-/Usage-Reads
  oder Hydrierung.
- `kits/search/runtime-threads.test.ts`: Treffer jenseits von 64k, entfernte
  Tokens innerhalb einer Nachricht, Trennung verschiedener Nachrichten,
  Neustart ohne Textreexport, Änderungen bei gleicher Zeit, Abbruch während
  Paging, Tombstones trotz fehlschlagender Exporte, alte Provider mit
  ignorierten oder abgelehnten Opt-in-Feldern und explizite Abdeckung.
- `kits/search/persistent-index.test.ts`: atomare Streamveröffentlichung,
  abgebrochene Nachrichten, falsche Offsets, wiederholte/verschachtelte
  Nachrichten-IDs und dauerhafte Revisionen bei gleicher Zeit.

Tests, Typechecks, Builds, Installationen und Appstarts wurden wie beauftragt
nicht ausgeführt. Keine Commits oder Pushes. Der Parent prüft kombiniert:

```sh
npm test -- src/main/thread-texts.test.ts kits/_shared/session-store-persistence.test.ts kits/_shared/session-store-lazy.test.ts kits/search/runtime-threads.test.ts kits/search/persistent-index.test.ts kits/search/host.test.ts kits/search/stream-match.test.ts kits/search/relevance.test.ts
node scripts/check.mjs typecheck -p tooling/tsconfig.electron.json --noEmit
npm run typecheck:kits
```

Im bestehenden `kits/search/host.test.ts`, Test "finds a closed thread of
another runtime through its kit's store", erwartet die Aufrufassertion noch
einen einzigen Legacy-Request. Sie muss im Host-Eigentumsbereich auf einen
Protokoll-2-Katalogrequest und die zwei Textseiten für `codex-new`/`codex-old`
angepasst werden. Der anschließende Keystroke erwartet dieselbe Gesamtzahl
von drei Requests ohne weitere Requests innerhalb des Syncintervalls.

Die CJS-/ESM-Worker-Bundleregression in
`session-store-persistence.test.ts` ist wegen der eingebetteten reinen
Paging-Funktionen ebenfalls Bestandteil der nötigen Parent-Prüfung.

Ausgeführt wurde ausschließlich `git diff --check` für die geänderten
versionierten Dateien sowie dieselbe Whitespace-Prüfung mit `--no-index`
für die bereits vorher unversionierten Indexdateien und diesen Bericht.
Sie ergaben keine Formatfehler. Das ersetzt keine der obigen Parent-Prüfungen.
