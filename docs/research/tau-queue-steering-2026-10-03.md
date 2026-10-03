# Queue und Steering im Chat

Stand 3. Oktober 2026. Nutzervertrag für einen laufenden Turn:

- Enter reiht die Nachricht ein.
- Cmd+Enter steuert den laufenden Agenten direkt.
- Eingereihte Nachrichten lassen sich mit Buttons umsortieren und einzeln sofort senden.

Keine Änderung des Standards auf direktes Steering. Bewusst gespeicherte Prompt-Tools- und Tastatureinstellungen bleiben erhalten.

## Tau-Befund und Änderung

Die Standard-Tastenkombinationen waren bereits vorhanden und werden durch `src/renderer/components/Composer.commands.test.tsx` geprüft. Prompt Tools lässt die Standard-Zustellung ausdrücklich umschalten; `kits/prompt-tools/desktop.test.tsx` prüft diese Auswahl. Ohne solche Anpassung reiht Enter ein und Cmd+Enter steuert.

`src/renderer/components/QueuedMessages.tsx` bot bereits Drag-and-drop, Alt+Pfeiltasten am Griff und „Send now“ für jede einzelne Nachricht. Sichtbare Buttons zum Verschieben nach oben und unten fehlten. Diese wurden ergänzt. Am Anfang beziehungsweise Ende sind die passenden Buttons deaktiviert; für eine einzelne Nachricht sind keine Verschiebe-Buttons nötig. Die Buttons verwenden denselben bestehenden `onReorder`-Vertrag wie Drag-and-drop. Host-Persistenz und Runtime-Zustellung wurden nicht geändert.

Neue Regression zuerst rot: die Buttons waren nicht auffindbar. Nach Ergänzung grün. Bestehende Tests für „Send now“, Zurückholen in den Composer und Drag-and-drop bleiben grün.

## Nachweise

- `env -u ESBUILD_BINARY_PATH npx vitest run src/renderer/components/QueuedMessages.test.tsx src/renderer/components/Composer.commands.test.tsx src/renderer/components/Composer.keys.test.tsx kits/prompt-tools/desktop.test.tsx src/main/queued-messages.test.ts`: 55 Tests grün.
- `npx --no-install oxlint src/renderer/components/QueuedMessages.tsx src/renderer/components/QueuedMessages.test.tsx`: grün.
- `npx --no-install tsc -p tsconfig.json --noEmit`: grün.
- Das anfänglich versehentlich verwendete ESLint ist nicht der Repo-Linter und scheiterte mangels ESLint-Konfiguration. Die Änderung wurde anschließend mit dem Repo-Linter Oxlint geprüft.

Dies sind Komponenten-, Host-Queue- und Typecheck-Nachweise, kein echter Provider-Ende-zu-Ende-Test. Native Pi-/Codex-Steering und die ACP-Abbruch-/Neustartsemantik dürfen nicht gleichgesetzt werden. Keine Runtime-Semantik wurde hier geändert.

## T3-Vergleich und Quellenbegrenzung

`web_explore` lieferte lesbare Beiträge aus [T3-Issue #231](https://github.com/pingdotgg/t3code/issues/231?timeline_page=1). Ein Beitrag beschreibt #2829 mit normalem Senden als Steering, Cmd/Ctrl+Enter als Queue, einer serververwalteten Queue und umsortierbaren beziehungsweise zum Steering beförderbaren Queue-Einträgen. Andere Beiträge schlagen Enter zum Einreihen und Cmd+Enter zum Steering vor. Eine Diskussion ist keine vollständige, versionsgebundene Implementierungsprüfung. Die Behauptung, T3 nutze durchgehend eine bestimmte Standardbelegung, ist damit nicht belegt. Für Tau gilt die oben ausdrücklich vom Nutzer festgelegte Belegung.

Die neuen Buttons liegen nur auf der Parity-Arbeitsbranch. Sie gehören nicht zum bereits veröffentlichten Nightly `0.7.39-nightly.20261003.35` auf `ffc3d481`.
