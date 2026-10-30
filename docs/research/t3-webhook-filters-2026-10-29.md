# Webhook-Payload-Filter, 29. Oktober 2026

## Quellen und Einordnung

Gelesen wurden `AGENTS.md`, `CONTEXT.md`, die ADRs 0006, 0009, 0010, 0014,
0020 und 0022 sowie die vorhandenen Berichte
[Scheduling-Umsetzung](tau-scheduling-implementation-2026-10-03.md),
[Inventur seit 11. Oktober](t3code-since-2026-10-11.md),
[bisherige Integration](t3-parity-implementation-2026-10-29.md) und
[Orchestrierung](t3-orchestration-parity-2026-10-29.md).
Upstream wurde ausschließlich im vorhandenen Checkout
`/tmp/tau-t3code-upstream-20261029` gelesen, gepinnter HEAD
`7a4f5b6188fed54ddc866723e39446a198b5835c`.

- [0c85b0d: Webhook-Ereignisfilter](https://github.com/pingdotgg/t3code/commit/0c85b0d9977fe9376bf9a4b063a4dd8ab8c97ae6)
  ergänzt mehrere UND-Regeln, Prüfung nach der Signatur und vor der
  Run-Zulassung sowie Filtererhalt bei Updates älterer Clients.
- [defb7e6e: Array-Wildcards](https://github.com/pingdotgg/t3code/commit/defb7e6e6b87d03259745367214db13060fb322b)
  ergänzt `[]` und unterschiedliche Quantifizierung je Operator. Für diese
  begrenzte Tau-Umsetzung bleiben Arrays über feste Indizes erreichbar.

## Umsetzung

Das Scheduling-Kit besitzt bereits Protokoll, Decoder, Persistenz, Editor und
HTTP-Empfang. Es braucht keine Verträge oder Änderungen außerhalb des Kits.
Tau hat hier keinen allgemeinen `schedule_task`-MCP-Vertrag; die vorhandenen
Owner-Kommandos `create` und `update` nehmen die erweiterte Konfiguration an.
Der bestehende `request_secret`-Vertrag bleibt unverändert.

```json
{
  "kind": "webhook",
  "filters": [
    { "path": "action", "op": "equals", "value": "completed" },
    { "path": "check.success", "op": "equals", "value": false },
    { "path": "issue.labels.0.name", "op": "exists" }
  ]
}
```

- Bis zu 16 Regeln, alle müssen passen. `equals` vergleicht Strings, endliche
  Zahlen, Booleans und `null` ohne Typumwandlung. `exists` prüft ein vorhandenes
  eigenes JSON-Feld, auch wenn dessen Wert `null`, `false`, `0`, `""`, ein
  Objekt oder ein Array ist. Das ist bewusst einfacher als Upstreams
  stringbasierter Vergleich und dessen Behandlung von `null` als fehlend.
- Punktpfade beginnen direkt im JSON-Payload. Erlaubt sind ASCII-Buchstaben,
  Ziffern, `_` und `-`, maximal 256 Zeichen und 16 Segmente. Arrays brauchen
  explizite Indizes wie `labels.0.name`; Array- und String-Metadaten sowie
  geerbte Felder zählen nicht. String-Vergleichswerte sind auf 1024 Zeichen
  begrenzt. Der vorhandene Store-Budgetcheck umfasst auch Filter.
- Der Host prüft unverändert HMAC, Zeitfenster und bereits akzeptierte IDs.
  Danach prüft er Filter vor dem Einreihen und erneut beim Start mit der
  aktuellen Konfiguration. Nicht passende und ungültige JSON-Payloads ergeben
  HTTP 204 ohne Antwortkörper. Sie erzeugen keinen Intent, Thread,
  Delivery-Eintrag oder Payload-Log und belegen keinen Run-Platz.
- Ohne Regeln bleibt das bisherige Raw-Body-Verhalten erhalten, auch für
  Nicht-JSON. Bei `update` bewahrt ein fehlendes `filters` vorhandene Regeln;
  `filters: []` löscht sie ausdrücklich. Alte gespeicherte Jobs brauchen
  keine Migration. Bereits akzeptierte IDs behalten ihre Dedupe-Semantik.
- Der Editor bietet Pfad, Equals/Exists und den JSON-Werttyp an, lädt
  vorhandene Regeln und sendet beim Entfernen aller Regeln ausdrücklich `[]`.
  Die Automation-Zeile zeigt die Filteranzahl. Manuelles Run now bleibt eine
  ausdrückliche Owner-Aktion ohne Webhook-Payload.

## Regressionen und Übergabe

Neue bzw. ergänzte Testfälle liegen exakt in:

- `kits/scheduling/webhook-filters.test.ts`: UND-Verknüpfung, JSON-Typen,
  Existenzsemantik, eigene Felder, Array-Indizes, Metadaten und Eingabegrenzen.
- `kits/scheduling/webhooks.test.ts`: echte signierte HTTP-POSTs durch den
  aktiven Listener, Signatur vor Filter, HTTP 204 ohne Persistenz, Wiederverwendung
  ignorierter IDs, Dedupe und Filter nach Neustart, Raw-Body-Kompatibilität,
  Update-Erhalt/Löschen, ungültige Speicherung sowie ein Filterwechsel vor
  einem eingereihten Start. Ein weiterer aktiver Webhook hält den gemeinsamen
  Listener während dieses Update-Szenarios offen.
- `kits/scheduling/page.test.tsx`: Filter über den echten Editor anlegen,
  gespeicherte Typen erhalten, alle Regeln entfernen und ungültige Pfade vor
  dem Speichern ablehnen.

`git diff --check` meldet im eigenen Scope keine Whitespace-Probleme, auch
die neuen Dateien wurden mit `git diff --no-index --check` geprüft.
Auf Anweisung wurden keine Tests, Typechecks, Builds oder Appstarts ausgeführt.
Der Parent soll diese drei Testdateien zusammen mit den bereits vorhandenen
Scheduling-Regressionen prüfen, insbesondere `kits/scheduling/host.test.ts`
mit den erhaltenen Maximaldauer-Fixes, und `npm run typecheck:kits` ausführen.
Die bestehenden Maximaldauer-Änderungen in `host.ts` und `host.test.ts` wurden
nicht ersetzt. Keine Dependency-Installation, Commits oder Pushes.

## Grenzen

Keine Header-/Query-Filter, Payload-Templates, Wildcards, Negation, Regex oder
ausführbare Ausdrücke. Kein neues Coalescing oder Ausführungsrecht.
Payloads bleiben außerhalb von Prompt, Transcript und Persistenz. Filterwerte
selbst sind sichtbare Konfiguration, keine Secrets. Ignorierte IDs werden
nicht dauerhaft gesperrt; eine spätere passende, gültig signierte Lieferung
derselben ID kann starten. Der HTTP-Test verwendet kontrollierte
Session-/OS-Store-Stubs. Eine visuelle Prüfung und die gemeinsamen Checks
stehen beim Parent aus.
