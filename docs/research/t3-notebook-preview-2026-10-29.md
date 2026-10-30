# Jupyter-Dateivorschau, 29. Oktober 2026

## Quellen

- Read-only-Upstream `/tmp/tau-t3code-upstream-20261029`, HEAD `7a4f5b6188fed54ddc866723e39446a198b5835c`. Grundlage ist [T3s Dokument- und Notebook-Vorschau](https://github.com/pingdotgg/t3code/commit/34ead566d44881a29e7438b949a421636742ab20), speziell `NotebookPreview.tsx` und `openNotebook` in `extendedDocumentPreview.ts`.
- Tau-Dateiviewer in `kits/files/`, dessen bestehender 1-MiB-Dateizugriff in `kits/workspace/file-content.ts`, `CONTEXT.md`, ADRs 0002, 0014, 0037 und 0041. Vorhandene Einordnung in [Inventur seit 11.10.](t3code-since-2026-10-11.md), [Dateien und Desktop](t3-files-and-desktop-2026-10-29.md) und [Implementierungsbericht](t3-parity-implementation-2026-10-29.md).

## Änderungen

`.ipynb` öffnet im Files-Kit standardmäßig als gerendertes Notebook. Die vorhandene Source/Rendered-Umschaltung speichert eine eigene Notebook-Präferenz. Die JSON-Rohdatei bleibt im bestehenden CodeMirror-Editor lesbar und bei vollständig geladenen Dateien bearbeitbar. Speichern verwendet weiterhin den unveränderten Dokumentpuffer und die vorhandene Konfliktprüfung. Der Quelleditor erkennt `.ipynb` als JSON. Die bestehenden Frontmatter-Änderungen bleiben erhalten.

`notebook.ts` liest nbformat 4, Markdown-, Code- und Raw-Zellen, Ausführungsnummern, stdout/stderr, `text/plain` bei `display_data` und `execute_result` sowie Fehler mit Traceback oder Fehlername und Meldung. ANSI-Steuersequenzen werden aus Outputs entfernt. Unbekannte Zellen zeigen ihre Quelle als Text; unbekannte oder fehlerhafte Outputs erhalten Hinweise.

`notebook-preview.tsx` verwendet Tau-Markdown und `FileSource`. Notebook-Markdown ersetzt Links, Bilder und Inline-Dateiaktionen durch inaktive Inhalte. Raw-HTML bleibt Text; HTML-, JavaScript-, Bild- und Widget-Outputs werden ausgelassen. Tau-Visualisierungsdirektiven in Markdown führen zur Klartextanzeige der Zelle, da der bestehende Markdown-Wrapper diese vor seinen Komponenten auswertet. Notebook-Inhalte lösen keine Codeausführung oder Ressourcenabfrage aus.

## Grenzen

- Höchstens 1 MiB UTF-8-JSON, passend zum unveränderten Host-Leselimit. Abgeschnittene Host-Antworten werden niemals als vollständiges Notebook interpretiert, auch wenn ihr Präfix gültiges JSON ist. Die geladene Quelle bleibt lesbar; die vollständige Datei ist über den vorhandenen externen Editor erreichbar.
- Höchstens 500 Zellen, 100 gespeicherte Outputs pro Zelle und 1000 Outputs insgesamt. Pro Textfeld höchstens 32 Ki Zeichen, zusammen höchstens 256 Ki Zeichen. Kürzungen werden angezeigt.
- Zunächst 20 Zellen, weitere auf Knopfdruck. Code und Textoutputs scrollen bei langen Inhalten. Kein Kernel, keine Zellenbearbeitung in der Vorschau, keine nbformat-3-Konvertierung und keine Darstellung reicher Outputs oder eingebetteter Bilder.
- Keine neuen Dependencies, Host-Kommandos oder Berechtigungen. Keine Office-, Archiv-, ZIP- oder SQLite-Erweiterung.

## Regressionen und Prüfstatus

Neue Testdateien:

- `kits/files/notebook.test.ts`: nbformat und kaputtes JSON, BOM, Zelltypen, Stringfragmente, Textoutputs, Tracebacks, ANSI, fehlerhafte Felder, unbekannte und reiche Outputs, UTF-8-Größenlimit, abgeschnittene Antworten sowie Zell-, Output- und Textlimits.
- `kits/files/notebook-preview.test.tsx`: gerenderte Inhalte, inaktive URLs, Bilder, HTML, Codefences und Tau-Direktiven, zwanzig Zellen pro Schritt, leere und reparierte Notebooks, Limits und unbekannte Outputs.

Erweiterte Testdateien:

- `kits/files/desktop.test.tsx`: Notebook-Standardansicht, exakte JSON-Quelle und Speicherung, unabhängige Darstellungspräferenz, Reparatur aus dem Puffer und schreibgeschützte Quelle bei abgeschnittenen Reads. Bestehende Frontmatter-Regression erhalten.
- `kits/files/file-kind.test.ts`: `.IPYNB`, Source/Rendered-Beschriftungen und Standardansicht.
- `kits/files/languages.test.ts`: JSON-Modus für `.IPYNB`.

Tests, Typechecks, Builds, Dependency-Installationen und Appstarts wurden auf Anweisung nicht ausgeführt. `git diff --check` im eigenen Scope war sauber, einschließlich der neuen Dateien. Die kombinierte Prüfung übernimmt der Parent, mit `npm test -- <obige fünf Testdateien>` und `npm run typecheck:kits`; die bestehende `kits/files/markdown-frontmatter.test.ts` kann dabei mitlaufen.
