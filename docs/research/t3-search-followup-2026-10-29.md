# T3-Threadsuche, Fortsetzung vom 29. Oktober 2026

Arbeitsbereich ausschließlich `kits/search/` und dieser Bericht. Vorhandene
Änderungen anderer Bereiche bleiben erhalten. Kein Commit, Push, Install,
Testlauf, Typecheck, Build oder Appstart.

## Quellen und Entscheidungen

Upstream read-only unter `/tmp/tau-t3code-upstream-20261029`, HEAD
`7a4f5b6188fed54ddc866723e39446a198b5835c`. Gelesen wurden die beiden Änderungen
und ihre Tests beziehungsweise die gemeinsame Suchlogik:

- [`4812dcad02a86874533540e6a0c4b7f5eaea297a`](https://github.com/pingdotgg/t3code/commit/4812dcad02a86874533540e6a0c4b7f5eaea297a)
  trennt Subagents von Forks und bevorzugt Wortanfänge vor Teilworttreffern.
- [`bb7783e295506ad423f527ed28a019836e331e8c`](https://github.com/pingdotgg/t3code/commit/bb7783e295506ad423f527ed28a019836e331e8c)
  bewertet Namen, Branches und Nachrichtentreffer vor dem Ergebnislimit.
  Der neue persistente Nachrichtenindex und Nutzungsstatistiken werden hier
  nicht übernommen.
- Ausgangspunkt war [die Interaktionsprüfung](t3-interaction-parity-2026-10-29.md),
  ergänzt um AGENTS.md, CONTEXT.md, ADRs 0002, 0003, 0005, 0013 und 0030 sowie die
  Suchbefunde im Audit `t3code-since-2026-10-11.md` und den Paritätsberichten.

ADR 0013 und `src/main/session-lineage.ts` erklären den entscheidenden Unterschied:
`parentThreadId` kennzeichnet delegierte Threads. Pi-Forks haben diesen Eintrag
nicht. Daher bleiben Forks sichtbar; delegierte Threads erscheinen weder über
Titel noch über Text oder PR-Verknüpfungen in der Palette, auch nicht im
Threads-Tab. Direkte Suchbefehle behalten ihre bisherigen Möglichkeiten.
Der explizite `includeSubagents`-Filter des Thread-Verzeichnisses liegt außerhalb
dieses Bereichs und bleibt erhalten.

## Änderungen

- `relevance.ts` bevorzugt vollständige Titel, ganze Wörter und Wortpräfixe.
  Innerhalb derselben Qualität zählen Titel vor Branch und Projekt, dann
  Aktualität. Kurze Teilwörter und gemischte Titel-/Branch-/Projektqueries
  bleiben auffindbar. Wortgrenzen berücksichtigen auch CamelCase und Unicode.
  Nachrichtentreffer wählen die beste Fundstelle. Das Limit greift nach der
  Bewertung; die Quellenreihenfolge hält Titel vor PR- und Nachrichtentreffern.
- Die Palette übergibt für Text und PRs zulässige `sessionIds`, ohne Kinder und
  bereits gezeigte Titel. Der Host filtert diese vor seinem Ergebnislimit,
  bei Pi auch vor der Auswahl der 400 neuesten Dateien. Das optionale Feld
  schränkt direkte Aufrufe ohne Kandidatenliste nicht ein.
- Texttreffer werden über Thread-IDs zugeordnet, nicht über gleiche Pfade auf
  verschiedenen Maschinen. `workspaceId` gewinnt auch beim Projekticon vor
  einem Pfad. Maschinenrouten und Workspace-Filter werden nicht erweitert.
- Pi-Dateien werden zeilenweise gelesen. Bis 400.000 Zeichen bleiben Nachrichten
  vollständig; darüber hält der Cache die ersten und letzten 200.000 Zeichen.
  Auch eine einzelne riesige Nachricht bleibt begrenzt. Ausgelassene Abschnitte
  werden nicht zu erfundenen Phrasen zusammengesetzt. Größe und mtime erneuern
  den Cache nach angehängten Nachrichten.
- Der aktive Thread wird bei jedem Suchaufruf vollständig über `transcript`
  gelesen, auch bei Pi. Damit sind die Mitte großer aktueller Transkripte und
  noch nicht gespeicherter Streaming-Text auffindbar. Das umgeht auch den
  exportierten Textpräfix anderer Runtimes. Bei fehlendem Runtime-Zugriff fällt
  die Suche auf den verfügbaren Cache zurück. Gleiche Treffer erscheinen einmal.

## Regressionen und Prüfung durch den Parent

Neue beziehungsweise ergänzte Testdateien:

- `kits/search/relevance.test.ts`
- `kits/search/threads.test.ts`
- `kits/search/host.test.ts`
- `kits/search/desktop.test.tsx`

Sie decken Rangfolge, Kinder, Forks, direkte Kindthread-Suche, Maschinenidentität,
große aktuelle Transkripte, viele kleine Nachrichten und Cache-Erneuerung ab.

Keine dieser Prüfungen wurde ausgeführt. Für die kombinierte Integration:

```sh
npm test -- kits/search/relevance.test.ts kits/search/threads.test.ts kits/search/host.test.ts kits/search/desktop.test.tsx kits/search/runtime-threads.test.ts
npm run typecheck:kits
```

`git diff --check -- kits/search/ docs/research/t3-search-followup-2026-10-29.md`
bestand ohne Befund.

Nachtrag des integrierenden Parents: Das unabhängige Review fand, dass die Worker-Fassade bei fehlendem Runtime-Zugriff `[]` statt einer Exception liefert. Ein aktiver angehängter Pi-Thread übersprang dadurch seine Sessiondatei. Bei leerem Transkript prüft die Suche nun, ob ein offener Runtime-Thread existiert. Ohne ihn bleibt der Dateicache durchsuchbar; ein tatsächlich leerer offener Thread bleibt maßgeblich. Zwei Regressionen decken beide Fälle ab. Der fehlende Fallback wurde zunächst mit einem roten Test reproduziert; anschließend bestanden alle 21 Host-Suchtests.

## Grenzen

Kein neuer persistenter Index. Bei geschlossenen Pi-Threads bleibt die Mitte
oberhalb des Zeichenbudgets ausgelassen; gesucht werden weiterhin höchstens
400 aktuelle Pi-Dateien. Geschlossene andere Runtimes behalten ihren bisherigen
64.000-Zeichen-Export und den gemeinsamen 4-Millionen-Zeichen-Cache mit dessen
Synchronisationsintervall. Über den aktiven Thread hinaus kommt keine neue
maschinenübergreifende Inhaltsuche hinzu.

Der erste Suchaufruf liest die ausgewählten Pi-Dateien vollständig zeilenweise.
Eine riesige JSON-Zeile wird vorübergehend vollständig geparst. Die Sortierung
prüft den begrenzten Bestand statt nach zwölf Treffern abzubrechen. Performance
und reale App-Bedienung muss der Parent prüfen. Tippfehlerkorrektur, Akzentfaltung,
persistierte Nutzungshäufigkeit und globale Volltextsuche wurden nicht ergänzt.
