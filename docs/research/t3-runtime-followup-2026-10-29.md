# Claude-Resume und quotierte Terminalpfade, 29. Oktober 2026

Diese Runde schließt die beiden Runtime-/Parser-Lücken aus dem [Implementierungsbericht](t3-parity-implementation-2026-10-29.md), dem [Runtime-Abgleich](t3-runtime-parity-2026-10-29.md) und dem [Bedienungsabgleich](t3-interaction-parity-2026-10-29.md). Grundlage sind AGENTS.md, CONTEXT.md, ADR 0005 und ADR 0022 sowie die [Inventur seit dem 11. Oktober](t3code-since-2026-10-11.md). Der Upstream-Checkout `/tmp/tau-t3code-upstream-20261029` wurde nur gelesen, weiterhin am Pin `7a4f5b6188fed54ddc866723e39446a198b5835c`.

## Claude-Resume

Primärquelle ist [Upstream 572cf74275bc0fc4dcdaee754db64fb3d5b575c1, #25372](https://github.com/pingdotgg/t3code/commit/572cf74275bc0fc4dcdaee754db64fb3d5b575c1). Dort wird eine beim Resume hängende MCP-Registrierung einmal wiederholt. Der alte Promptkanal wird vorher geschlossen; der Ersatz wartet auf das Ende des alten Prozesses. Neue Session-IDs werden nicht automatisch erneut verwendet.

Tau setzt dies in [sdk-session.ts](../../kits/claude-code/sdk-session.ts) mit der vorhandenen SDK-Version um, ohne Abhängigkeiten zu ändern:

- Die erste Registrierung erhält weiterhin 90 Sekunden. Nur ein Resume-Timeout erlaubt einen weiteren Versuch, und nur bevor ein Prompt die Query erreicht hat. Jeder Versuch hat einen eigenen AbortController und ein eigenes Gate zum gemeinsamen Send-Puffer.
- Das alte Gate schließt vor Abort und SDK-Disposal. Tau wartet höchstens zehn Sekunden auf Disposal, den bisherigen Nachrichtenleser und den nachgewiesenen Exit des über `spawnClaudeCodeProcess` gestarteten Prozesses. Ein nicht beendeter Prozess oder fehlgeschlagenes Disposal verhindert den Neustart. `kill()` allein gilt nicht als Exit.
- Die SDK-Disposal räumt Control-Anfragen und SDK-Hooks auf. Tau bricht zusätzlich die Signale laufender Berechtigungs-/Dialogcallbacks ab, verweigert alte Callback-Aufrufe und verwirft verspätete Callback-Antworten und Nachrichten. Der Adapter entfernt seinen stderr-Listener bei Abort oder Exit.
- Wartende Prompts behalten Inhalt, UUID und Priorität. Auch Sends während des Aufräumens bleiben im selben Puffer. Modell, Effort und Berechtigungsmodus werden beim Neustart übernommen. Ein Ergebnis kann nur einen tatsächlich gesendeten Prompt erledigen; ein altes Resume-Ergebnis darf keinen noch wartenden Send aus dem Puffer entfernen.
- MCP-Konfigurationen werden aus den Startoptionen entfernt und ausschließlich über `setMcpServers` übertragen. Registrierungsfehler geben nur Servernamen weiter, niemals SDK-Fehlertexte mit möglichen Authorization-Headern. Der Retry erzeugt keine Protokolllogs mit Optionen oder Credentials.
- Ein zweiter Resume-Timeout beendet die Session mit einem verständlichen, festen Fehlertext über das vorhandene `onExit` des Backends. Wartende Sends erhalten denselben Fehler; kein Prompt geht an eine Query ohne bestätigte Registrierung. Neue Sessions behalten die bisherige Timeout-Warnung und können ohne Tau-Tools weiterlaufen. Beantwortete Registrierungsfehler bleiben ebenfalls beim bisherigen Verhalten ohne Retry.
- `close()` und ein äußerer Abort lösen Registrierung und Prompt-Gate, verhindern den Ersatzversuch und melden den Session-Exit genau einmal. Die Query-Disposal wird pro Versuch nur einmal begonnen.

Regressionen:

- [sdk-session-mcp.test.ts](../../kits/claude-code/sdk-session-mcp.test.ts) steuert Registrierung, Disposal und Prozessende getrennt. Fälle umfassen erhaltene Sends samt Prioritäten, neue Sends während Disposal, verspätete fehlerhafte Registrierung und Auth-Frames, fehlschlagendes Disposal ohne Credential-Leak, altes Resume-Ergebnis, zwei Timeouts, frische Sessions, beantwortete Fehler, Close/Abort, Close während Disposal, abgebrochene Hooks und die fehlende Exit-Bestätigung.
- [mcp-control-channel.test.ts](../../kits/claude-code/mcp-control-channel.test.ts) verwendet das echte installierte SDK mit einem kontrollierten CLI über dessen Spawn-Hook. Neue Fälle prüfen zwei Resume-Prozesse, Registration auf stdin vor dem Prompt, Credentials außerhalb von argv und Umgebung, genau eine Zustellung pro Send sowie Retry-Erschöpfung ohne gesendeten Prompt.
- [runtime-adapter.test.ts](../../kits/claude-code/runtime-adapter.test.ts) berücksichtigt den Controller des einzelnen Query-Versuchs und die Callback-Wrapper. Bereits vorhandene Regressionen aus früheren Runden bleiben erhalten.

## Quotierte Terminalpfade

Die offene Stelle ist im [Bedienungsabgleich](t3-interaction-parity-2026-10-29.md) beschrieben. Die dort belegte [Upstream-Unicode-Korrektur](https://github.com/pingdotgg/t3code/commit/9ac1355e01efd84c0aded502b44b41b24ebb4130) und Taus vorhandene Zellabbildung bilden die Grundlage. Die Erweiterung selbst ist Tau-Parserverhalten in [links.ts](../../kits/terminal/links.ts), keine übernommene Terminal-UI.

Der Parser liest zusammenhängende Ausdrücke in einfachen, doppelten oder Backtick-Quotes. Leerzeichen und escaped Quote-Delimiters gehören zum Dateinamen. Zeile und Spalte dürfen innerhalb oder hinter den Quotes stehen. Unterstützt bleiben relative und absolute POSIX-Pfade, Home-Pfade, Windows-Laufwerke und UNC. Quotierte einzelne Dateinamen benötigen eine Erweiterung. Bare relative Verzeichnispfade benötigen wie bisher eine Erweiterung oder Zeilenposition.

Der aufzulösende Pfad enthält keine äußeren Quotes und keine Escape-Zeichen vor dem Quote-Delimiter. Der Linkbereich verwendet dagegen die ursprünglichen UTF-16-Offsets einschließlich Quotes und äußerer Positionsangabe. Deshalb bleiben Wrapped-Zeilen, breite Glyphen, Surrogate, kombinierte Zellen und sichtbare Escape-Zeichen mit der vorhandenen `positionIn`-Abbildung vereinbar. Interpunktion innerhalb der Quotes bleibt im Dateinamen erhalten.

Ungültige oder nicht geschlossene quotierte Ausdrücke liefern keine teilweise erkannten inneren Pfade. URL-Überlappungen bleiben ausgeschlossen. Die bisherigen strengeren Regeln für unquotierten Text werden nicht um Leerzeichen erweitert; Kontraktionen wie `don't`, Brüche und `and/or` bleiben Text.

[links.test.ts](../../kits/terminal/links.test.ts) ergänzt Regressionen für beide Positionsschreibweisen, POSIX/Home/Windows/UNC, Unicode, escaped einfache und doppelte Quotes, Dateinamen mit Leerzeichen, Satzzeichen, URL-Abgrenzung, unvollständige Quotes, unquotierte Prosa und die gemeinsame Zellabbildung über einen Zeilenumbruch. Eine Auflösungsprüfung verbindet den dekodierten Parserpfad mit `resolveTerminalPath`.

## Prüfung und Übergabe

Es wurden keine Tests, Typechecks, Builds, Installationen oder Appstarts ausgeführt. Es wurden keine Commits erstellt oder Änderungen gepusht. Die umfangreichen vorhandenen Änderungen im gemeinsamen Worktree wurden erhalten. Änderungen dieser Runde liegen ausschließlich in `kits/claude-code/`, `kits/terminal/links.ts`, `kits/terminal/links.test.ts` und diesem Bericht.

`git diff --check` im freigegebenen Scope war sauber. Der Parent führt die kombinierten Checks aus. Relevante Testdateien sind `kits/claude-code/sdk-session-mcp.test.ts`, `kits/claude-code/sdk-session.test.ts`, `kits/claude-code/mcp-control-channel.test.ts`, `kits/claude-code/runtime-adapter.test.ts`, `kits/claude-code/thread-backend.test.ts`, `kits/claude-code/process-lifecycle.test.ts` und `kits/terminal/links.test.ts`; dazu `npm run typecheck:kits` über den gemeinsamen Check-Slot. Die Stub-Regressionen ersetzen keinen Versuch mit einem tatsächlich hängenden Claude-Resume.
