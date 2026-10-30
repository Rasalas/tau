# Nachrichtensprung aus globaler Suche, 29. Oktober 2026

Der globale Treffer öffnet Find jetzt mit einem expliziten Zielthread und dem
optionalen Modus `all-words`. Der Host bestimmt damit erneut die Nachricht,
deren Text den globalen Treffer geliefert hat. Getrennte Tokens wie
`quartz moon` passen auf `Quartz lies beside the moon`; eine zusammenhängende
Phrase ist für diesen Einstieg nicht erforderlich. Die Tokens werden im
Zieltranskript einzeln hervorgehoben.

Gelesen wurden AGENTS.md, CONTEXT.md, docs/architecture.md, die ADRs 0002, 0003,
0006, 0010 und 0014, der Bericht t3-search-index-ui-2026-10-29.md und Abschnitt 1
der verbindlichen Opus-UX-Vorgaben in t3-parity-next-ux-2026-10-29.md.

## Vertrag in API 1.79.0

Die bestehende Versionsnummer bleibt unverändert. Die Erweiterungen sind optional.

```ts
type TranscriptFindMode = "literal" | "all-words";
interface TranscriptFindOptions {
  sessionId?: string;
  mode?: TranscriptFindMode;
}
actions.findInThread?(query?: string, options?: TranscriptFindOptions): void;

interface TranscriptFinderContribution {
  id: string;
  find(request: {
    sessionId: string;
    query: string;
    mode?: TranscriptFindMode;
  }): Promise<readonly string[]>;
}
```

Ohne Optionen bleibt der vorhandene Aufruf wörtlich und wirkt auf das montierte
aktive Transkript. Die normale Suche liefert weiterhin alle passenden User- und
Assistant-Nachrichten, einschließlich Reasoning. Reihenfolge und Limit bleiben
unverändert. `mod+f`, der Find-Befehl und `/` aktivieren keinen Tokenmodus. Ein
manueller Find-Aufruf über einer global gestarteten offenen Suche setzt den
Modus auf literal zurück. Auch jede Bearbeitung des Suchfelds wechselt zu literal.
Es gibt keinen neuen Schalter und keine neue Darstellung der Suchleiste.

Die globale Nachrichtenquelle wird von Palette und Compact gemeinsam verwendet.
Erst nach `switchSession(path) === true` ruft ihre Find-Aktion Folgendes auf:

```ts
actions.findInThread?.(query, { sessionId: thread.id, mode: "all-words" });
```

Die Stage-Aktion bleibt erhalten. Fehlgeschlagene oder überholte Threadwechsel,
deren bestehender Navigationsvertrag false liefert, erzeugen keinen Find-Auftrag.

Der Search-Host akzeptiert zusätzlich nur im `ThreadFindInput` das optionale
Feld `mode`. Desktop reicht es durch `registerTranscriptFinder` an
`find-in-thread` weiter. Nur der Wert `all-words` aktiviert die neue Semantik;
fehlende, `literal` und unbekannte Werte behalten die bisherige Suche. Das
Antwortformat `{ messageIds, truncated }` bleibt unverändert.

`all-words` benennt bewusst genau die beste Nachricht, passend zum einen globalen
Snippet pro Thread. Alle durch Whitespace getrennten Tokens müssen in derselben
sichtbaren Textnachricht vorkommen. Die Auswahl verwendet unmittelbar dasselbe
`textMatch` wie `findInThread`: Groß-/Kleinschreibung und beide Sigmaformen werden
gefaltet, ganze Wörter schlagen Präfixe und Teilstrings, Phrasen erhalten den
bestehenden Bonus, Gleichstände gewinnt die frühere Nachricht. Reasoning,
Notices und Tokens in verschiedenen Nachrichten werden nicht zusammengeführt.
Der Finder liefert die aktuelle Runtime-Nachrichten-ID, die der Renderer und
sein vorhandenes `loadThrough` verstehen. Indexdatensätze tragen weiterhin
keinen erfundenen stabilen Anker.

Der Renderer wartet im globalen Modus auf die Host-Auswahl, bevor er springt.
Damit führt ein schwächerer Treffer im bereits geladenen Ende nicht zuerst an
eine andere Stelle. Fällt der Finder aus oder fehlt er, bleibt die vorhandene
Suche in geladenen Turns verfügbar. Ihr Token-Fallback wählt die erste geladene
Textnachricht mit allen Tokens; dieser Fallback kann die globale Bestwertung
über die noch ungeladene Historie nicht garantieren.

## Lebenszyklus und Hervorhebung

Ein `PendingThreadFind` gehört über eine WeakMap zum gemeinsamen Transcript-Ref
des Workbench-Fensters. Er hält genau den jüngsten unübernommenen Auftrag mit
Query, Ziel-ID und Modus. Eine neue globale Anfrage ersetzt ihn; ein manueller
Find-Aufruf verwirft ihn. Das Transkript meldet seine eigene Session-ID im
Layout-Effekt an. Nur der passende Empfänger darf den Auftrag übernehmen,
sowohl vor als auch nach dem Mount. Ein fremdes noch montiertes Transkript kann
ihm weder den Suchtext noch den Modus entnehmen. Es gibt keinen Timer für den
Mount und keinen Bezug zum Composerentwurf.

Die Übernahme entfernt den Auftrag sofort. Ein späterer Rückwechsel spielt ihn
nicht erneut ab. Beim Threadwechsel schließt sich die alte Suche; Query,
Hostantworten und Highlights werden nicht in das neue Transkript übernommen.
Ein nachgeladener Reveal bindet sich zusätzlich an die Lebensdauer der Session.
Wechselt die Person während `loadThrough` weg und wieder zurück, darf das alte
Promise keinen Sprung oder Flash mehr auslösen, auch bei gleichen Nachrichten-IDs.

`TranscriptSearch` hält Hostantworten nach Query und Modus auseinander. Sein
bestehender Effekt verwirft überholte Antworten beim Wechsel oder Unmount.
`useTranscriptFind` bindet auch den Highlightzustand an die Session-ID.
Der Tokenmodus verwendet die bestehende CSS Custom Highlight API, ohne den
Transcript-DOM zu verändern. Tokenbereiche berücksichtigen ursprüngliche
UTF-16-Offsets bei expandierender Kleinschreibung, etwa `İ`, und vereinigen
überlappende Treffer. Der vorhandene Rahmen von 1.500 Bereichen gilt weiter.
Wie bisher werden einzelne über mehrere DOM-Textknoten verteilte Wörter nicht
als ein durchgehender Bereich markiert. Auf Browsern ohne Highlight-API bleibt
der vorhandene Verzicht auf Markierungen bestehen.

## Geänderte Dateien dieses Anschlusses

- `kits/search/threads.ts`, `threads.test.ts`: beste Token-Nachricht nach derselben
  globalen Wertung; Literal-Suche bleibt erhalten.
- `kits/search/protocol.ts`: ausschließlich optionales `ThreadFindInput.mode`.
- `kits/search/host.ts`: ausschließlich Mode-Auswertung im Find-Handler.
- `kits/search/host.test.ts`: Hostgrenze, Ziel-ID, Tokenauswahl und Literal-Fallback.
- `kits/search/desktop.tsx`: ausschließlich Mode-Durchgabe im TranscriptFinder.
- `kits/search/palette-sources.ts`: ausschließlich threadgebundene Find-Aktion.
- `kits/search/desktop.test.tsx`: Finder-Durchgabe und asynchroner erfolgreicher
  beziehungsweise fehlgeschlagener Wechsel aus der globalen Quelle.
- `src/workbench/transcript-find.ts`, `transcript-find.test.ts`: optionale Typen,
  wartender Zielauftrag und Case-Folding für den Renderer-Tokenpfad.
- `src/renderer/extension-system.tsx`, `extension-api.ts`: additive Find-Verträge
  und Typ-Exports innerhalb API 1.79.0.
- `src/renderer/use-workbench-actions.ts`: Find an den gemeinsamen Ref vermitteln.
- `src/renderer/components/transcript-reveal.ts`: DOM-Anschluss und wartender
  threadgebundener Auftrag.
- `src/renderer/components/TranscriptViewport.tsx`: Übernahme beim Mount,
  threadgebundene Suchleiste und Zurücksetzen bei Threadwechsel.
- `src/renderer/components/TranscriptSearch.tsx`, `TranscriptSearch.test.tsx`:
  initialer Tokenmodus, Warten auf Hostauswahl, Rückkehr zur Literal-Suche.
- `src/renderer/components/use-transcript-reveal.ts`: Mode-Durchgabe,
  sessiongebundene Highlights und Verwerfen verspäteter Reveal-Ergebnisse.
- `src/renderer/components/transcript-highlights.ts`,
  `transcript-highlights.test.ts`: einzelne Tokenbereiche, Unicode und Überlappungen.
- `src/renderer/components/TranscriptViewport.find-integration.test.tsx`:
  Workbench-Action, echter Viewport, Suchleiste, Finder, `loadThrough`, Flash und
  CSS-Highlights zusammen. Nur der virtuelle Zeilenrenderer ist vereinfacht.

Indexsteuerung, Settings, persistent-index.ts, runtime-threads.ts,
Core-Runtime-Textpaging und Thread-Sharing wurden nicht bearbeitet.
CommandPalette.tsx und dessen Parent-Fix zum synchronen Quellenbatch wurden
nicht bearbeitet. Alle bereits vorhandenen Änderungen bleiben erhalten.

## Ergänzte Regressionen und Prüfstatus

Die Integrationstests behandeln getrennte Tokens, Mount vor beziehungsweise
nach dem Find-Auftrag, einen noch sichtbaren fremden Thread, einen erst später
nachgeladenen Zielturn, sichtbare Tokenbereiche, Rückwechsel ohne Wiederholung,
verspätete Hostantworten und verspätete Historienantworten. Sie prüfen außerdem
den erhaltenen Composertext und dass kein Composer-Draft-/Seed-Writer aufgerufen
wird. Weitere Fälle öffnen Find manuell oder bearbeiten die global übernommene
Query und verlangen danach wieder den Literal-Vertrag.

Es wurden keine Tests, Typechecks, Builds, Installationen oder Appstarts
ausgeführt. Es gibt keinen Commit oder Push und keinen Unteragenten. Die neuen
Tests sind deshalb nicht als bestanden zu verstehen. `git diff --check` für die
bearbeiteten getrackten Dateien blieb ohne Befund. Der Parent übernimmt den
kombinierten Prüflauf, insbesondere die oben genannten Kit-Tests sowie
`src/workbench/transcript-find.test.ts`,
`src/renderer/components/TranscriptViewport.find-integration.test.tsx`,
`TranscriptViewport.find.test.tsx`, `TranscriptSearch.test.tsx`,
`transcript-highlights.test.ts`, `use-transcript-reveal.test.tsx` und
`src/renderer/use-workbench-actions.test.ts`.
