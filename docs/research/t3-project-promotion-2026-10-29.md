# Projekt-Promotion, 29. Oktober 2026

Ein vorhandener projektloser Thread kann seinen privaten Ordner am bestehenden Ort als Projekt registrieren. Der Vorgang verschiebt keine Dateien, kopiert keine Session und erzeugt keinen Fork. Thread-ID, Session-Datei, Runtime-Backend, Ausführungskonto, Workspace-ID, Titel, Nachrichten, laufende Tools und bestehende Worktrees bleiben bestehen.

## Entscheidung und Quellen

- [Opus-UX, Abschnitt 5](t3-parity-next-ux-2026-10-29.md#5-projektlose-threads-in-projekte-umwandeln) legt die Registrierung am bestehenden Ort, den Dialog und die optionale Git-Initialisierung fest. Dieser Bericht war vor Beginn der UI-Änderungen vorhanden und wurde gelesen.
- [ADR 0003](../adr/0003-core-owns-threads-extensions-own-navigation.md), [ADR 0005](../adr/0005-thread-runtime-backends.md), [ADR 0017](../adr/0017-worktrees-for-threads-and-agents.md), [ADR 0020](../adr/0020-host-command-authority.md) und [ADR 0030](../adr/0030-the-workbench-controls-every-machine.md) begründen die unveränderten Thread-, Backend-, Pfad- und Maschinenidentitäten. `AGENTS.md` und `CONTEXT.md` wurden gelesen.
- Die [Inventur](t3code-since-2026-10-11.md) verweist auf [Upstream-Promotion, Commit 58e60bf5](https://github.com/pingdotgg/t3code/commit/58e60bf5e808fc226d9b769d66d1ea9fec014d23). Gelesen wurden die Commit-Änderungen und `ScratchThreadPromotion.ts` aus dem lokalen, unveränderten Upstream-Checkout. Dessen HEAD wurde als `7a4f5b6188fed54ddc866723e39446a198b5835c` bestätigt.
- [Upstream-Implementierung am Pin](https://github.com/pingdotgg/t3code/blob/7a4f5b6188fed54ddc866723e39446a198b5835c/apps/server/src/project/ScratchThreadPromotion.ts) registriert ebenfalls den vorhandenen Ordner und berücksichtigt weitere Threads und gebundene Automationen. Tau braucht keine Projekt-ID-Umschreibung dieser Daten, weil die bestehende Workspace-ID und der Pfad erhalten bleiben. Die Tau-UX erlaubt die reine Registrierung auch während einer Antwort; nur das optionale Git-Setup verlangt einen ruhenden Ordner.

## Verhalten

`Turn into project…` steht bei projektlosen Threads im Zeilen- und Titelmenü unmittelbar über `Project settings…`, außerdem in der Palette des aktiven Threads. Der Dialog verwendet den Threadtitel als Vorschlag, maximal 60 Zeichen, nennt weitere Threads im selben Ordner und lässt Git standardmäßig aus. Nach Erfolg erscheint der vorgegebene Toast mit `Project settings`. Auswahl und aktiver Thread werden nicht gewechselt.

Dialog und Projektdetails liegen in einer gemeinsamen Region für `desktop`, `web` und `compact`. Zuvor waren Projektdetails an die Desktop-Sidebar gebunden. Der native Dateimanager wird nur für einen auf diesem Gerät erreichbaren lokalen Projektordner angeboten. Read-only-Geräte sehen die Schreibaktion deaktiviert; der Host verweigert sie zusätzlich.

`promotion-info` und `promote-scratch` verlangen sowohl die opaque Workspace-ID als auch die Thread-ID. Die Befehle bleiben außerhalb der lokalen Routing-Ausnahmen des Workspace-Kits. Dadurch übernimmt das vorhandene Maschinenrouting die Weiterleitung zum Heimatgerät und entfernt dort den Proxy-Präfix der Thread-ID. Der Zielhost prüft die tatsächliche Zuordnung erneut und verweigert eigene Maschinen-Proxys. Projekte anderer Maschinen blockieren den lokalen Namen nicht.

Die dauerhafte Registrierung liegt außerhalb des Workspace unter `<Workspace-Kit-State>/promoted-projects/<allocation UUID>.json`. Der Marker enthält Version, kanonischen Pfad und Projektnamen. Eine vollständig geschriebene und synchronisierte temporäre Datei wird durch einen Hardlink ohne Überschreibung veröffentlicht; die Markerdatei hat Modus `0600`. `isScratchWorkspace` prüft jetzt auch diesen Status. Beim Start werden registrierte Ordner wieder zugelassen und ihre Projektfakten gelesen, selbst ohne verbleibende Session. Die normale Begrenzung der Projekt-Historie bleibt bestehen; der Marker überlebt deren Verdrängung. Bewusst ausgeblendete Projekte bleiben ausgeblendet.

Weitere Threads im selben Ordner erhalten die neue Klassifikation und den Projektnamen über den gemeinsamen Index. Titel und Session-Daten ändern sich nicht. Ein registrierter Ordner wird als eigener Projektstamm klassifiziert, auch wenn darin bereits ein Git-Worktree liegt. Neue Worktrees eines promovierten Repositorys bekommen dessen Projektnamen auch nach einem Neustart.

Für Pi ist der Checkpoint-Adapter bereits im privaten Thread installiert, nimmt dort aber keine Inputs an. Nach der Promotion können künftige Turns Checkpoints erzeugen, ohne die Runtime neu zu starten. Ein bereits laufender Turn erhält keinen nachträglichen Vorher-Snapshot.

## Validierung und Fehlerbehandlung

- Die Promotion läuft serialisiert mit anderen Promotions und dem Core-Thread-Lifecycle. Fehlende Ordner, fremde Thread-/Workspace-Zuordnungen, ungültige Namen und Namenskollisionen werden vor der Mutation verweigert. Die Kollisionserkennung liest auch Registrierungen ohne verbleibende Threads, die nicht mehr in der Projekt-Historie stehen.
- Wiederholte und gleichzeitige Aufrufe mit demselben Namen liefern dieselbe Workspace-ID. Ein anderer Name für einen bereits promovierten Ordner wird verweigert.
- Bestehende Branding-Dateien und `t3.json` werden erhalten. Falls ein Icon fehlt, werden ausschließlich neue Dateien angelegt. Bei vorhandener Konfiguration nutzt das Icon einen bereits unterstützten Dateinamen, ohne die Konfiguration umzuschreiben.
- Git wird nur auf ausdrücklichen Wunsch initialisiert. Laufende Threads, bestehende `.git`-Dateien, Verzeichnisse, Symlinks und geerbte Repositorys verhindern dieses Setup. Die normale Promotion ohne Git bleibt möglich. Ein frisches `.git` wird mit atomarer Kollisionsverweigerung angelegt; der erste Commit erfasst den aktuellen, nicht ignorierten Inhalt. Commit-Hooks werden für diesen Initial-Commit deaktiviert.
- Bei Fehlern werden der eigene Marker, das eigene neue Git-Verzeichnis und unverändert gebliebene, selbst erzeugte Branding-Dateien zurückgenommen. Geänderte Benutzerdateien werden nicht gelöscht. Die Core-Registrierung wird erneut gelesen und der Index aktualisiert. Rollback-Fehler werden zusätzlich zur ursprünglichen Ursache gemeldet; sie werden nicht als Erfolg ausgegeben.
- Nach dauerhaft erfolgreicher Registrierung ist ein Fehler bei der Index-Publikation kein Grund, das Projekt wieder zurückzunehmen. Er wird protokolliert. Ein erneuter Aufruf ist idempotent.
- Cancel vor dem Schreiben führt ausschließlich zum Schließen des Dialogs. Während der Mutation sind Cancel, Escape-Schließen und doppeltes Absenden gesperrt.

## Geänderte Dateien dieser Teilaufgabe

Workspace-Implementierung:

- `kits/workspace/project-promotion.ts`, neu. Validierung, Serialisierung, optionale Git-Initialisierung und Rollback.
- `kits/workspace/project-starts.ts`. Trennung von privater Allocation und projektlosem Status, Markerlesen.
- `kits/workspace/host.ts`. Befehle, Wiederherstellung beim Start und Projektfakten.
- `kits/workspace/protocol.ts`. Typisierte Host-Befehle und Dialogzustand.
- `kits/workspace/project-promotion-dialog.tsx`, neu. Dialog, profilübergreifende Registrierung, Palette und Projektdetails.
- `kits/workspace/project-promotion-menu.ts`, neu. Gemeinsame Menüaktion.
- `kits/workspace/desktop.tsx`, `store.ts`, `navigation.tsx`, `ProjectSettingsDialog.tsx`, `styles.css`. Bestehende UI-Anschlüsse.
- `kits/workspace/host-lifecycle.ts`, `pi-turn-checkpoint-extension.ts`, `workspace-kit-checkpoints.ts`. Checkpoints nach Promotion ohne Runtime-Wechsel.

Neue und ergänzte Regressionen:

- `kits/workspace/project-promotion.test.ts`, neu. Persistenz, alle Runtime-Eigentümer, laufende Threads, unveränderte Session-Datei, konkurrierende Geräteaufrufe, Namen ohne Historieneintrag, fremde Maschinen, Read-only-Zugriff, Rollback, vorhandenes Git und bestehende Worktrees.
- `kits/workspace/project-promotion-dialog.test.tsx`, neu. Alle Profile, Abbruch ohne Schreiben, IDs beim Remote-Aufruf, Fehler und Wiederholung, Read-only und Menüposition.
- `kits/workspace/host.test.ts`, `protocol.test.ts`, `pi-turn-checkpoint-extension.test.ts`. Start ohne Session, Encoding und Checkpoints künftiger Turns.

Der notwendige Core-Anschluss ist ausdrücklich auf diese Dateien begrenzt:

- `src/main/project-registration.ts`, neu. Projektfakten aktualisieren und Registrierung persistieren, ohne einen Thread zu öffnen.
- `src/main/project-registration.test.ts`, neu. Veraltete Scratch-Klassifikation, Persistenz ohne Sessions, Schreibfehler und bewusst ausgeblendete Projekte.
- `src/main/project-facts-cache.ts`. Gezieltes Neulesen bereits gecachter Fakten.
- `src/main/host-extensions.ts`. Optionaler In-process-Service `refreshProject`.
- `src/main/host-ports.ts`, `src/main/pi-host-components.ts`. Schmale Verdrahtung dieses Services.
- `src/main/external-session-shells.ts`, `src/main/external-session-shells.test.ts`. Ein normal gelistetes Remote-Projekt setzt `projectless` ausdrücklich auf `false`, damit ein offener Maschinen-Proxy den früheren Scratch-Status bei der Index-Zusammenführung verliert.
- `src/shared/extension-permissions.ts`. Service verlangt `workspace:write`.
- `src/main/host-extension-api.ts`. Export des vorhandenen Icon-Lesers, damit bestehendes Branding wiederverwendet wird.

Die bereits uncommitteten Git-, NUL-Pfad- und Worktree-Entfernungsfixes wurden erhalten. Keine Workspace-Datei eines anderen Teilauftrags wurde zurückgesetzt. Änderungen anderer Teilaufgaben in den gemeinsam verwendeten Core-Dateien bleiben bestehen. Keine Änderungen an Runtime-Backends, Scheduling oder Guest Sharing.

## Checks und Grenzen

Auftragsgemäß wurden keine Tests, Typprüfungen, Builds, Installationen oder Appstarts ausgeführt. Kein Commit, Push oder externer Schreibzugriff. `git diff --check` über die berührten vorhandenen Dateien war sauber; neue Dateien wurden statisch gelesen.

Der Parent sollte diese Tests in seine einmalige kombinierte Prüfung aufnehmen:

```sh
npm test -- kits/workspace/project-promotion.test.ts kits/workspace/project-promotion-dialog.test.tsx kits/workspace/host.test.ts kits/workspace/protocol.test.ts kits/workspace/pi-turn-checkpoint-extension.test.ts kits/workspace/host-lifecycle.test.ts kits/workspace/store.test.ts kits/workspace/desktop.test.ts kits/workspace/rail-interactions.test.tsx src/main/project-registration.test.ts src/main/project-facts-cache.test.ts src/main/external-session-shells.test.ts
npm run typecheck:kits
node scripts/check.mjs typecheck -p tooling/tsconfig.electron.json --noEmit
```

Die neue In-process-API gehört zum gemeinsamen API-Minor der Integrationscharge. Der Worktree steht bereits durch parallele Änderungen auf API `1.79.0`; diese Teilaufgabe hat die zentrale Versionsdatei nicht nochmals geändert. Worker erhalten keinen neuen Lifecycle-RPC. Das Workspace-Kit läuft deklarativ In-process.

Es gibt keinen Ordnerwechsel und keine spätere Umbenennung durch diesen Vorgang. Ein Prozessabbruch vor Veröffentlichung des Markers kann selbst angelegte Branding- oder Git-Dateien zurücklassen. Sie überschreiben keine vorherigen Dateien; eine Wiederholung ohne erneutes Git-Setup kann den vorhandenen Ordner registrieren. Ein beschädigter oder zum kanonischen Pfad unpassender Marker wird nicht als gültige Registrierung behandelt. Die Dateiprüfungen sind kein Schutz gegen einen anderen lokalen Prozess, der während der Operation Verzeichnisse austauscht.

Die UI, echte Wiederöffnung nach einem vollständigen Tau-Neustart und das Ende-zu-Ende-Routing zu einer verbundenen fremden Maschine wurden hier nicht ausgeführt. Die geschriebenen Regressionen ersetzen diese noch ausstehende Parent-Prüfung nicht.
