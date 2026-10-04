# Auto-Settle nach einem Merge

Geprüft am 4. Oktober 2026 im lokalen Checkout des offiziellen Repositorys `pingdotgg/t3code`, Commit `869347bc26051bba7c3c0274a7dfcae7770d3e3a`.

T3code stößt Auto-Settlement bei Änderungen verknüpfter PRs an, einschließlich `thread.pull-request-synced`. Es prüft außerdem nach einem Wechsel der Session in einen nicht laufenden Zustand und hört auf Merge-Meldungen des PR-Service. Ein einminütiger Sweep bleibt als Rückhalt bestehen. Diese Trigger laufen im Server, unabhängig vom Fenster. [ThreadSettlementReactor, Zeilen 309–355](https://github.com/pingdotgg/t3code/blob/869347bc26051bba7c3c0274a7dfcae7770d3e3a/apps/server/src/orchestration/ThreadSettlementReactor.ts#L309-L355).

Tau wartete dagegen auf seinen fünfminütigen Sweep. Auch die Snapshots verknüpfter offener PRs waren fünf Minuten gültig. Ein Turn-Ende entfernte den Thread nur aus der Menge laufender Threads, ohne erneut zu prüfen. [Tau-Ausgangsstand, Thread Rail](https://github.com/Rasalas/tau/blob/88eae5d5/kits/thread-rail/host.ts), [Review Kit](https://github.com/Rasalas/tau/blob/88eae5d5/kits/review/thread-links-host.ts).

Der Fix übernimmt die Ereignis-Trigger für aktualisierte PR-Verknüpfungen und Turn-Ende. Turn-Ende fordert frische PR-Daten an. Ein einminütiger Sweep und eine einminütige Gültigkeit offener PR-Snapshots bleiben für externe Merges. Laufende Threads bleiben ausgeschlossen. Die Integrationsprüfung von Workspace Kit bleibt bestehen, damit ein älterer gemergter PR keine neue, noch nicht integrierte Arbeit erledigt erscheinen lässt.

Die Host-Tests reproduzieren außerdem einen Wettlauf: Während einer Integrationsprüfung kann ein neuer Turn beginnen. Vor dem Anwenden eines Settlement-Ergebnisses prüft Tau deshalb erneut den Laufzustand und die Metadaten des Threads. Ein während einer laufenden Prüfung eingetroffenes Turn-Ende wird anschließend erneut geprüft.
