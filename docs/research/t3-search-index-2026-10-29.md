# Persistente Nachrichtensuche, 29. Oktober 2026

Umsetzung ausschließlich in `kits/search/` und diesem Bericht. Die vorherigen,
absichtlichen Änderungen bleiben erhalten. Keine Änderungen an `src/`, UI,
Manifest oder Dependencies; keine Commits oder Pushes. Keine Unteragenten.

## Quellen und Vorgaben

Gelesen wurden `AGENTS.md`, `CONTEXT.md`, die ADRs 0005, 0006, 0009, 0018,
0020 und 0037 sowie die bestehenden Suchimplementierungen und Tests.
Ausgangspunkt waren
[t3-parity-implementation-2026-10-29.md](t3-parity-implementation-2026-10-29.md),
[t3code-since-2026-10-11.md](t3code-since-2026-10-11.md) und die vorherige
[Suchfortsetzung](t3-search-followup-2026-10-29.md).

Upstream wurde ausschließlich gelesen unter
`/tmp/tau-t3code-upstream-20261029`; `git rev-parse HEAD` bestätigte
`7a4f5b6188fed54ddc866723e39446a198b5835c`. Die Primärquelle
`apps/server/src/orchestration-v2/messageSearchIndex.ts` beschreibt den
[Upstream-Index](https://github.com/pingdotgg/t3code/commit/bb7783e295506ad423f527ed28a019836e331e8c)
auf dessen vorhandener SQL-Persistenz. Tau stellt Such-Kits Pi-Dateien und
`thread-texts` bereit, keine entsprechende SQL-Projektion. Deshalb verwendet
die Umsetzung Dateien im eigenen `services.stateDir`; sie benötigt keine
neue Datenbankdependency oder native Berechtigung. Es wurden keine externen
technischen Quellen außerhalb dieser Primärquellen verwendet.

## Verhalten

Geschlossene Pi-Threads werden vollständig nach sichtbaren Benutzer- und
Assistententexten durchsucht. Weder das bisherige 400.000-Zeichen-Fenster noch
die Vorauswahl von 400 Dateien begrenzen den Host-Suchpfad. Alle zulässigen
Thread-IDs werden vor dem Ergebnislimit bewertet. Nur die besten höchstens
100 Ergebnissnippets bleiben im Ergebnispuffer.

Relevanz bleibt ganze Wörter vor Wortpräfixen vor Teilwörtern, mit Phrasen als
Gleichstandsentscheidung und Aktualität innerhalb derselben Qualität. Mehrere
Suchwörter müssen in derselben Nachricht vorkommen, dürfen dort aber beliebig
weit auseinanderliegen. Textblöcke einer Nachricht sind getrennt durchsuchbar;
eine Phrasenübereinstimmung entsteht nicht über ihre eingefügte Zeilentrennung.
Nachrichten verschiedener Rollen, Dateien oder Versionen werden nicht vermischt.

Die Palette und ihr Filter für delegierte Kinder bleiben unverändert.
`sessionIds` schränkt weiterhin die Kandidaten vor dem Ergebnislimit ein;
direkte Suche nach einem Kind bleibt möglich. Forks bleiben normale Kandidaten.
Die Suche liest nur Pi-Pfade aus `services.sessions.list()` und die explizit
freigegebenen Runtime-Exporte. Eingaben können keinen Indexpfad bestimmen.
Maschinenrouten und Zugriffsrechte werden nicht erweitert.

Ein aktiver Thread wird bei jeder Suche über das vollständige Runtime-Transkript
geprüft. Dieses hat Vorrang vor einem Pi- oder Exportcache, auch wenn es leer ist
und der Thread tatsächlich offen ist. `[]` ohne offenen Runtime-Thread sowie
fehlgeschlagene Transkriptzugriffe erlauben weiterhin den Dateifallback.
Aktive Transkripte werden nicht in den dauerhaften Exportcache geschrieben.

## Persistenz und Ressourcen

`persistent-index.ts` legt unter `stateDir/messages-v1/` pro Identität aus
Quelle, Thread-ID und Pi-Pfad eine Indexdatei an. Der Dateiname ist ein
SHA-256-Wert dieser Identität; die Identität im Header wird beim Lesen geprüft.
Runtime-Exporte verwenden einen eigenen Quellenraum ohne Pi-Pfad.

Der Pi-Fingerprint enthält Gerät, Inode, Größe, `mtimeNs` und `ctimeNs`.
Unveränderte Dateiversionen benötigen nach einem Neustart keine erneute
Extraktion. Gleich große Änderungen mit zurückgesetzter mtime, Ersetzungen,
Anhänge und Kürzungen invalidieren die betroffene Datei. Die Inkrementalität
liegt auf Thread-/Dateiebene: Eine veränderte Pi-Datei wird neu gestreamt;
es gibt bewusst keine unsichere Annahme, dass ein Größenwachstum ausschließlich
ein unverändertes Präfix verlängert. Dateiversionen werden vor und nach der
Extraktion, am geöffneten Deskriptor sowie vor der Rückgabe geprüft. Bei einem
Wechsel wird einmal wiederholt; eine weiter veränderliche oder verschwundene
Datei liefert keinen alten Treffer.

Die Extraktion verwendet einen eigenen begrenzten JSONL-Decoder in
`pi-text-stream.ts`. Auch eine einzelne große JSON-String-Zeile wird nicht als
Ganzes gesammelt oder durch `JSON.parse` geschickt. Eingaben kommen in
64-KiB-Blöcken, extrahierte Textstücke enthalten höchstens 16.384 UTF-16-Einheiten.
JSON-Escapes können über Eingabegrenzen laufen. Rollendiskriminatoren und
Blocktypen dürfen nach dem Text stehen. Kandidatentext wird erst durch einen
gültigen Block- und Nachrichtenabschluss suchbar. Unvollständige und ungültige
Zeilen liefern keine Teiltreffer und werden nach einer Dateiveränderung erneut
extrahiert. Schlüssel und Diskriminatoren benötigen höchstens 128 Einheiten;
die Verschachtelung ist auf 256 Ebenen begrenzt. Mehrdeutige doppelte relevante
JSON-Schlüssel werden verworfen. Übliche Pi-Zeilen benötigen diese Grenzen nicht.
Bei ungewöhnlich umgeordneten, später verworfenen Feldern kann die private
Indexdatei vorläufige Textstücke enthalten; der Matcher gibt diese nicht aus.

`stream-match.ts` hält einen queryabhängigen Überlappungsbereich und einzelne
Token-/Phrasenfunde, keinen ganzen Nachrichtentext. Treffer über Chunk-Grenzen
bleiben erhalten; Suchwörter aus verschiedenen Nachrichten werden nie ergänzt.
Ein fester 2-KiB-Trigramm-Bloomfilter pro Thread verwirft sichere Nichttreffer,
bevor der Text gelesen wird. Kollisionen verursachen zusätzliche Scans.
Einzel- und Zweizeichenqueries sowie gesättigte Filter benötigen vollständige
Scans der betreffenden Indexdateien. Der Index ist kein invertierter Wortindex;
Treffersuche benötigt im schlechtesten Fall I/O proportional zum indexierten
Text. Ein kalter Aufbau liest alle zulässigen Pi-Dateien. Es gibt keine
behauptete konstante Antwortzeit und keinen stillen Textabbruch.

Indexzeilen werden auch beim Lesen in begrenzten Blöcken verarbeitet.
Beschädigte übergroße Indexzeilen können keinen unbeschränkten `readline`-Puffer
aufbauen. Header/Footer werden geprüft, und zurückgegebene Treffer benötigen
einen passenden SHA-256-Digest aller Textdatensätze. Ein beschädigter Pi-Index
wird neu erstellt. Beschädigte Runtime-Indizes werden aus `known` entfernt und
bei der nächsten Synchronisierung neu angefordert. Der Bloomfilter und sein
Header haben eine eigene Integritätsprüfung, damit ein beschädigter Filter
keinen vermeintlich sicheren Ausschluss erzeugt.

Neue Generationen entstehen in zufälligen, exklusiv angelegten Dateien mit
`O_EXCL`, `O_NOFOLLOW` und Modus 0600. Das Indexverzeichnis hat Modus 0700;
ein Symlink an dieser Stelle wird abgelehnt. Nach Inhalt und Footer folgen
Datei-fsync, atomarer Rename und, wo unterstützt, Verzeichnis-fsync. Der alte
Index wird während des Schreibens nicht überschrieben. Fehler räumen die
eigene temporäre Datei auf. Ein Prozessabbruch hinterlässt höchstens eine
unveröffentlichte Scratch-Datei, die nie als Index gelesen wird. Scratch-Dateien
älter als 24 Stunden werden beim nächsten Start entfernt. Katalogänderungen
entfernen verwaiste Pi-Indizes; fehlende Dateien invalidieren ihren Index auch
bei unverändertem Sessionkatalog. Ein Prozess serialisiert Suchen, Schreiben
und Pruning; Deaktivierung wartet auf die laufende Indexarbeit.

Der Arbeitsspeicher für Text hängt von Chunk- und Querygröße ab. Sessionlisten,
Runtime-Versionen und Indexpfade benötigen weiterhin Speicher proportional zur
Threadzahl. Die aktive Runtime-Schnittstelle liefert bereits ganze Transkripte;
deren Speicherbedarf lässt sich im Such-Kit nicht durch Paging begrenzen.
Der Index benötigt Plattenplatz proportional zum extrahierten Text plus
Metadaten. Dateisysteme mit groben oder unzuverlässigen Änderungszeiten können
die Genauigkeit eines stat-basierten Fingerprints begrenzen.

## Unicode

Query, Relevanz und Bloomfilter verwenden dieselbe localeunabhängige
Kleinschreibung. Beide Sigmaformen werden zu `σ`, bevor JavaScript kleinschreibt;
damit hängt das Ergebnis nicht von einer Chunk-Grenze ab. Astrale Buchstaben
bleiben suchbar. Durch `İ` verlängerte Kleinbuchstabenfolgen erhalten eine
Zuordnung zu den ursprünglichen UTF-16-Positionen für Wortgrenzen und Snippets.
Es gibt keine Akzent-, NFC-/NFKC- oder Kompatibilitätsfaltung: `café`, `cafe` und
`cafe` mit separat kombiniertem Akzent bleiben unterschiedliche Literale.
Bestehende CamelCase-, Ziffern- und CJK-Wortgrenzen bleiben erhalten.

## Andere Runtimes und nötige Erweiterung

`runtime-threads.ts` persistiert jetzt die gelieferten `thread-texts`-Exporte.
Neustarts laden deren Versionen und fragen mit `known` nur Änderungen an.
`more` wird im dauerhaften Modus bis zum Ende abgeholt, mit einer Prüfung auf
Fortschritt. Das Suchlimit und die früheren vier Antwortrunden lassen keine
weiteren exportierten Threads aus. Text wird nach dem Persistieren aus dem RAM
freigegeben, statt ältere Threads durch das 4-Millionen-Zeichen-Budget dauerhaft
unauffindbar zu machen. Entfernte IDs werden nur in ihrer jeweiligen Quelle
entfernt. Nicht erreichbare Quellen liefern keine unbestätigten Neustarttreffer.
Die bestehende Synchronisierungsfrist von fünf Sekunden bleibt; Änderungen und
Löschungen geschlossener Nicht-Pi-Threads werden spätestens beim nächsten Sync
sichtbar, nicht mit jeder Taste. Der aktive Runtime-Pfad umgeht diese Frist.

Eine verbliebene Grenze liegt außerhalb des Eigentumsbereichs:
`src/main/thread-texts.ts` begrenzt den Export auf `THREAD_TEXT_CHARS = 64_000`.
Das Such-Kit kann Text außerhalb dieses Exports für geschlossene Nicht-Pi-Threads
nicht rekonstruieren. Es greift dafür nicht in private Runtime-Stores ein.
Für deren vollständige Suche braucht die öffentliche Export-Schnittstelle eine
abwärtskompatible, versionierte Paging-Erweiterung:

- Anfrage für einen Thread mit unveränderlicher Exportversion, Cursor und
  Byte-/Zeichenbudget; Version muss Änderungen auch bei gleicher Zeit erkennen.
- Antwort mit derselben Version, `nextCursor`/Ende und geordneten Stücken aus
  Nachrichten-ID, Rolle, Textoffset, Text und Nachrichtenabschluss. Stückgrenzen
  dürfen keine verlorenen Unicode-Zeichen erzeugen.
- Katalogdelta mit Versionen und Tombstones, unabhängig vom Textbudget. Eine
  Änderung während des Exports muss den Cursor invalidieren; der Suchindex
  veröffentlicht erst eine vollständig gelesene Version.
- Veröffentlichung der Typen über `src/main/host-extension-api.ts` sowie
  Implementierung durch die bestehenden Runtime-Kits an ihren Exportbefehlen,
  insbesondere den gemeinsamen Store in `kits/_shared/session-store-persistence.ts`.

Diese Erweiterung wurde nicht vorgetäuscht und nicht außerhalb des Scopes
implementiert. Für vollständige Pi-Suche ist keine Core-Erweiterung nötig.

## Regressionen und Checks

Neu sind `persistent-index.test.ts` und `stream-match.test.ts`; ergänzt wurden
`host.test.ts`, `runtime-threads.test.ts` und `relevance.test.ts`.
Sie prüfen mittlere Treffer jenseits von 400.000 Zeichen, einzelne riesige
JSON-Nachrichten, entfernte Tokens derselben Nachricht, Chunk-Grenzen,
JSON-Escapes, Unicode, Neustart ohne Quellenneulesen, Änderungen und Löschungen,
einen Dateiversionswechsel während der Extraktion, kaputte/alte Generationen,
Scratch-Dateien, sichere Dateimodi und Symlinks, getrennte Quellen und Pfade,
mehr als 400 Dateien, neue relevante Kandidaten nach warmem Cache,
Runtime-Paging, wiederhergestellte Exportversionen sowie aktive Transkripte
mit fehlendem oder leerem Runtime-Zugriff.

Ausgeführt wurde ausschließlich die erlaubte Whitespace-Prüfung:

```sh
git diff --check -- kits/search/ docs/research/t3-search-index-2026-10-29.md
```

Sie bestand ohne Befund. Tests, Typechecks, Builds, Installationen,
Benchmark und Appstarts wurden ausdrücklich nicht ausgeführt. Der Parent muss
mindestens die folgenden kombinierten Prüfungen ausführen:

```sh
npm test -- kits/search/persistent-index.test.ts kits/search/stream-match.test.ts kits/search/relevance.test.ts kits/search/threads.test.ts kits/search/runtime-threads.test.ts kits/search/host.test.ts kits/search/desktop.test.tsx
npm run typecheck:kits
```

Optional ist `node kits/search/benchmark.mjs 500 150` reproduzierbar ausführbar.
Das Skript erzeugt ausschließlich synthetische Pi-Dateien in einem privaten
Tempverzeichnis, lädt die vorhandene esbuild-Dependency für die TypeScript-Datei
und misst kalten Aufbau, warme Suche, Neustart sowie eine geänderte Datei.
Es enthält auch mehrere Nachrichten mit jeweils fast fünf Millionen Zeichen.
Ausgabe sind Lauf-/CPU-Zeiten, RSS, Quell- und Indexgröße, Trefferzahlen und
Quellenlese-/Rebuildzähler. Es startet keine App und entfernt seine Daten wieder.
Das ist eine synthetische Belastungsprobe, keine Messung einer echten Tau-
Sessionbibliothek. Es liegen hier keine gemessenen Laufzeiten vor.
