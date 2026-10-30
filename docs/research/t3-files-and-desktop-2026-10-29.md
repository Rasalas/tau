# Dateien und Desktop, 29. Oktober 2026

Verglichen mit T3 Code bis `7a4f5b6188fed54ddc866723e39446a198b5835c` und Tau-Ausgangspunkt `4df3128d4`.

## Umgesetzt

- Die gerenderte Markdown-Dateivorschau blendet führende YAML-Metadaten aus. Quelltext, Zeilennummern und Zeichenpositionen bleiben erhalten, auch mit CRLF, BOM und Unicode. Chats behalten ihre bisherige Markdown-Darstellung. Umsetzung in `kits/files/markdown-frontmatter.ts` und `editor-tab.tsx`, mit Parser- und Komponentenregressionen. Grundlage: [T3s Frontmatter-Fix](https://github.com/pingdotgg/t3code/commit/f81c4cd79f9afb4beef535d5453c280b831caf31).
- ACP-Dateizugriffe prüfen jetzt auch das Ziel eines Dateisymlinks. Bisher wurde nur der Elternpfad kanonisiert; eine Datei im Workspace konnte dadurch auf ein Ziel außerhalb zeigen. Nicht auflösbare Symlinks gelten nicht mehr als noch anzulegende Pfade. Andere Fehler bei der Pfadauflösung werden nicht mehr durch eine lexikalische Ersatzprüfung übergangen. Bestehende interne Links und neue Unterverzeichnisse funktionieren weiter. Umsetzung in `kits/_acp/session.ts`, Regressionen in `session-files.test.ts`. Die Untersuchung ging von [T3s Antigravity-Pfadkorrektur](https://github.com/pingdotgg/t3code/commit/82515785bb6ec7b1b14894016977117864627b33) aus; der konkrete Dateisymlink-Fund stammt aus Tau. Das ist keine vollständige Absicherung gegen gleichzeitiges Austauschen von Verzeichnissen zwischen Prüfung und Dateizugriff.
- Snooze-Optionen stehen nach ihrer tatsächlichen Zielzeit sortiert. Beispielsweise erscheint um 15:30 Uhr der Abend um 18 Uhr vor „In 3 hours“. IDs und gespeicherte Werte bleiben gleich. Umsetzung und Regression in `kits/thread-rail/meta.ts` und `meta.test.ts`. Grundlage: [T3s chronologische Snooze-Reihenfolge](https://github.com/pingdotgg/t3code/commit/c3858bf1f70a1a16a3582ff870307c55b358b5c3).
- Electron wurde in Manifest und Lockfile gezielt von 44.4.4 auf 44.10.0 angehoben. Die [offiziellen Release Notes](https://releases.electronjs.org/release/v44.10.0) nennen unter anderem korrigierte File-System-Access-Sperren, ASAR-Verarbeitung, Chromium und Node sowie mehrere Plattform-Crashes. Kein allgemeines Dependency-Update. Grundlage des Vergleichs: [T3s Update auf 44.10.0](https://github.com/pingdotgg/t3code/commit/6d82a22e9df93f1dd14afa89d820b7dd1b624eef).

## Integration

Der unabhängige Review fand einen Wiedereintritt beim Stoppen von Subagents: `sessions.abort` ruft Stop-Observer auf, die dieselben Nachfahren erneut erreichen. Laufende Stop-Vorgänge werden jetzt pro Kind geteilt, einschließlich Meldungen und Hooks. Ein Test bildet den Observer-Aufruf innerhalb von `abort` mit drei Ebenen nach. Der 30-Sekunden-Timeout bleibt bestehen und behauptet keine erfolgreiche Prozessbeendigung.

Die abschließenden Prüfergebnisse stehen im gemeinsamen Implementierungsbericht.
