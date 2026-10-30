# Downloadanschluss für passive Dokumente, 29. Oktober 2026

Der Files-Fallback verwendet jetzt den vorhandenen Browserressourcenpfad der direkt verbundenen Maschine und den bereits bei Exports verwendeten Blob-/Download-Link. Der Klick auf `Download` veröffentlicht eine Capability, überträgt die geprüfte Datei und übergibt erst die vollständig empfangenen Bytes an den Speichermechanismus des Clients. Das Öffnen einer Vorschau veröffentlicht und lädt keine Downloadressource.

Gelesen wurden `AGENTS.md`, `CONTEXT.md`, ADR 0037 samt Full-access-Amendment, Abschnitt 4 des Opus-UX-Berichts `t3-parity-next-ux-2026-10-29.md`, `t3-document-previews-2026-10-29.md`, die Browserressourcenverwaltung, DeviceReadPaths, Workspace-Pfadprüfungen, vorhandene Export-Downloads und die nativen Dokumentports. Es gibt keine neue Dependency, öffentliche Datei-Route, Gastauthentisierung oder native Geräteaktion.

Die bereits vorhandenen Änderungen des Parents an `DocumentSourceContribution.renderPreview`, FileViewer, Stage, WorkspaceFileSheet und `WorkspaceStore.registerFilePreview/renderFilePreview` bleiben erhalten. Diese Teilaufgabe hat keine Core-Datei, `navigation.tsx` oder Workspace-CSS bearbeitet. Die Source-Registration verwendet nun dieselbe `PassiveTab`-Ansicht wie der Files-Tab, einschließlich des vorhandenen Kopfes und Fallbacks. Die Notebook-Registration bleibt erhalten.

## Vertrag

| Aufruf | Eingabe und Ergebnis |
| --- | --- |
| `tau.workspace/publish-file-download` | `access: "read"`; `{ workspace, path }` ist Pflicht. `workspace` wird ausschließlich über `knownWorkspacePath` aufgelöst. Ergebnis `{ path: "/resources/<64 hex>", name, size }`. `path` im Ergebnis ist eine Capability, niemals ein Dateisystempfad. Die Veröffentlichung öffnet die Datei für Metadaten und schließt das Handle ohne Inhaltslesen. |
| `tau.workspace/release-file-download` | `access: "read"`; `{ workspace, path }` mit Capability-Pfad. Nur die veröffentlichende Verbindung und Erweiterung können diese Ressource über die bestehende Ressourcenverwaltung freigeben. |
| `WorkspaceStore.downloadFile(path, { workspace }, signal)` | Veröffentlicht über den eigenen Host-Client, löst die Capability ausschließlich über dessen `resourceUrl` auf, liest begrenzt und liefert `{ blob, name }`. Der Workspace wird vor dem ersten Await festgehalten. Kein Ersatz durch das aktive Projekt und kein extern eingegebener URL. |
| Files-Fallback | `WorkspaceStoreLike.downloadFile` ist optional für ältere Workspace-Versionen. `OpenInPicker` behält lokale Editoren und reicht den expliziten Workspace weiter. Nur passive Dokumentansichten aktivieren den Downloadfallback. |

Beide Downloadbefehle sind lokale Befehle der bestehenden Machine-Routing-Policy. Hier bedeutet lokal die Maschine der Clientverbindung, auch wenn sie auf einem entfernten Rechner läuft. Eine Capability einer über diese Maschine weitergeleiteten Peer-Maschine wäre gegen den falschen Ressourcenserver gerichtet. Der neue Befehl verlangt deshalb einen auf der direkt verbundenen Maschine bekannten Workspace. Ein unbekannter Workspace erhält den Hinweis, sich direkt mit seiner Maschine zu verbinden. Es gibt keine automatische Auswahl eines anderen Workspaces und keinen Zugriff auf einen gleichlautenden absoluten Benutzerpfad einer anderen Maschine.

## Sicherheits- und Lebensdauergrenzen

- Relative und absolute Eingaben müssen lexikalisch sowie kanonisch innerhalb des expliziten Workspaces liegen. Auch Full access erweitert diesen Downloadvertrag nicht auf beliebige externe Dateien. Absolute Transcriptpfade innerhalb des Workspaces bleiben möglich. Es gibt keinen automatischen Main-checkout-Fallback.
- Für Read-only übernimmt der registrierte `read`-Befehl zunächst die zentrale ADR-0037-Prüfung. Der Ressourcenhandler prüft darüber hinaus selbst mit `deviceReadPaths` den ursprünglichen und den kanonischen Namen. Das schützt auch den späteren Ressourcenabruf, der außerhalb des ursprünglichen Command-Dispatchs stattfindet. Git-Interna und kanonische versteckte Home-Einträge bleiben ausgeschlossen; Projekt-Dotfiles bleiben lesbar. Full access verwendet die bestehenden Full-access-Semantiken innerhalb des Workspaces.
- Geöffnet wird mit `O_RDONLY`, `O_NOFOLLOW` und `O_NONBLOCK`, soweit verfügbar. `FileHandle.stat().isFile()` verweigert Verzeichnisse und Spezialdateien. Die Originalreferenz wird nach dem Öffnen erneut kanonisch geprüft. Beim GET werden kanonischer Pfad, Device, Inode, Größe, mtime und ctime gegen die bei Veröffentlichung erfasste Datei geprüft. Ein späterer Symlinktausch oder regulärer Dateiaustausch wird verweigert.
- Ein Datei-Handle gehört jeweils einem GET/HEAD, nicht der zehn Minuten gültigen Capability. Stream-Ende, Fehler, Request-Abbruch und Body-Cancel schließen es. Vor Ausgabe des letzten Chunks werden EOF, Dateimetadaten und Originalpfad erneut geprüft. Ein später Fehler führt beim Client zu keinem Speicherversuch mit unvollständigen Bytes.
- Wie bei den vorhandenen Workspace-/Preview-Prüfungen gibt es keinen atomaren Walk über festgehaltene Verzeichnis-Handles. Gleichzeitig ausgetauschte und rechtzeitig zurückgetauschte Elternverzeichnisse sind die in ADR 0037 dokumentierte TOCTOU-Grenze. Ebenso ist der Download keine atomare Momentaufnahme gegen konkurrierende In-place-Schreiber.
- `Content-Type` ist immer `application/octet-stream`; `Content-Disposition` ist `attachment`. Der Basename wird gekürzt und von Kontrollzeichen, Formatsteuerzeichen, Surrogaten, Separatoren und problematischen Dateinamenzeichen bereinigt. Der ASCII-Filename enthält keine Quotes oder Headertrenner; `filename*` ist UTF-8-prozentkodiert. `nosniff` und `private, no-store` sind gesetzt. Die bestehende Ressourcenverwaltung ergänzt CSP, Referrer-Policy und ihre Headerbereinigung. Dokumentbytes gelangen in keine HTML-/Script-Ansicht.
- Der Client verlangt exakt HTTP 200, verweigert Redirects, sendet keine Cookies oder anderen Zugangsdaten und prüft jede empfangene Chunklänge sowie die vollständige deklarierte Größe. MIME und Speichernamen werden nicht aus HTTP-Headern ungeprüft übernommen.
- Veröffentlichung und Transfer beginnen nur durch den Klick. Unmount und Herkunftswechsel brechen den Transfer ab. Eine spät eintreffende Capability wird nach Abbruch ebenfalls freigegeben. Erfolg und Fehler geben die Capability frei; bei Release-Fehler bleiben die vorhandene Ablaufzeit und Connection-/Extension-Cleanup wirksam. Die bestehenden Ressourcenmechanismen brechen aktive Antworten bei Freigabe, Disconnect oder Deaktivierung ab.
- Der übertragene Blob bleibt nur für die Übergabe an den vorhandenen Browserdownload verfügbar. Seine Objekt-URL wird nach 60 Sekunden oder beim Unmount freigegeben. Es wird kein Hostpfad auf dem Client geöffnet oder persistent gespeichert.

## Größen und Unterstützung

Das Limit beträgt 10 MiB, exakt die Grenze des vorhandenen Browserressourcen-/Native-Response-Transports. Es gilt vor dem Inhaltslesen, während der Hostausgabe und beim Client. Der Host liest in höchstens 64-KiB-Chunks mit einer zusätzlichen EOF-Probe. Der Client puffert höchstens 10 MiB und erstellt erst danach den Blob. Ein größerer Download erhält eine ausdrückliche Meldung und den Hinweis, die Datei auf ihrer Maschine zu öffnen. Das 20-MiB-Previewlimit wird nicht verändert. Dateien zwischen 10 und 20 MiB können damit weiterhin eine Vorschau haben, aber keinen Download über diesen Vertrag.

Der HTTP-Transfer hat im Client ein Zeitlimit von 30 Sekunden. Die vorhandenen Grenzen der Hostbefehle sowie die Ressourcenablaufzeit bleiben zusätzlich wirksam. Kein Chunking-Protokoll, keine größere Transportgrenze und kein neuer Transport wurden eingeführt.

| Client / Herkunft | Verhalten |
| --- | --- |
| Desktop mit lokalen Dateien und vorhandenem Editor | Vorhandenes `Open in` bleibt. Der passive Tab übergibt jetzt seinen expliziten Workspace an den Editoraufruf. |
| Desktop mit direkt verbundener entfernter Maschine | Capability über den vorhandenen `tau-ext:`-Ressourcenproxy lesen, danach vorhandener Blob-/Download-Link. |
| Web und Compact im Browser, direkt von der Maschine bedient | Dieselbe Aktion über die eigene Ressourcen-URL und den Browserdownload. Read-only darf lesen und auf dem eigenen Client speichern. |
| Native iOS-/Android-App | Sichtbare Meldung vor dem Transfer, dass diese App das Format nicht speichern kann und Browser/Desktop benötigt wird. Der vorhandene Android-`openDocument`-Port akzeptiert ausschließlich PDFs und wird nicht für Office-/Archivdateien zweckentfremdet. Native Ressourcen-URLs werden zusätzlich im Store-Helfer abgefangen, falls die Clientumgebung keine Mobile-Metadaten enthält. |
| Ältere Maschine ohne neuen Befehl | Sichtbare Update-Meldung bei `unknown-command`/`unknown-method` oder entsprechender alter Fehlermeldung. Kein Versuch mit absoluten Clientpfaden. |
| Ältere Workspace-Version ohne Store-Methode | Sichtbare Update-Meldung, keine stille Nichtaktion. |
| Weitergeleiteter Peer-Workspace | Verweis auf die direkte Verbindung zur Dateimaschine. Die lokale Ressourcen-URL wird nicht für eine Peer-Capability verwendet. |
| Cross-origin-/Relay-Verbindung ohne lesbaren Ressourcenpfad | Sichtbarer Transferfehler mit Hinweis auf die direkte Verbindung. Der aktuelle öffentliche Extension-Client bietet keinen `read-browser-resource`-Socketaufruf. Der Download erweitert dessen API und die Ressourcen-CORS-Regeln nicht. Diese Verbindungsart braucht einen gesonderten Core-Anschluss, falls sie ebenfalls unterstützt werden soll. |

Die normale Web-/Compact-Browserunterstützung und Desktop-Unterstützung sind implementiert, in dieser Teilaufgabe aber nicht praktisch verifiziert. Insbesondere die letzte Tabellenzeile ist eine verbleibende Verbindungsgrenze, keine behauptete Unterstützung aller Relay- und Cross-origin-Konfigurationen.

## Regressionen und Parent-Prüfung

Es wurden ausschließlich Regressionen geschrieben. Keine Tests, Typechecks, Builds, Appstarts, Installationen, Commits oder Pushes wurden ausgeführt.

Die neuen Regressionen decken Byteerhalt, passive MIME-Header, Headerinjektion, Traversal, externe Absoluteingaben auch bei Full access, Read-only-Git-/Home-Grenzen, interne Dotfiles, reguläre Dateien, Symlink-/Dateiaustausch nach Veröffentlichung, Größenlimit und Wachstum, HEAD, Body-Cancel, Abort vor und während Transfer, späte Antworten nach Unmount, festgehaltene Herkunft, unvollständige/zu große/fehlgeschlagene Transfers, alte Maschinen, native Nichtunterstützung sowie den tatsächlichen registrierten Files-/Source-Fallback ab. Die bestehende Browserressourcenverwaltung besitzt eigene Tests für Connection-Bindung, fremde Freigaben, Ablauf, Disconnect und Extension-Deaktivierung; diese Verwaltung wurde nicht dupliziert oder geändert.

Für den Parent zur gemeinsamen Prüfung:

```sh
npm test -- kits/workspace/workspace-download.test.ts kits/workspace/file-download-client.test.ts kits/workspace/protocol.test.ts kits/workspace/host.test.ts kits/files/download-file.test.tsx kits/files/desktop.test.tsx
npm run typecheck:kits
```

Zusätzlich sind die beiden neuen Read-Befehle und ihre bewusst lokale Ressourcenherkunft in die vom Parent vorgesehene zentrale Read-only-/Machine-Routing-Prüfung einzubeziehen. Ein Appcheck sollte den Download einer kleinen binären Datei auf Desktop und im direkt bedienten Web-/Compact-Browser prüfen, außerdem einen absichtlich gescheiterten Transfer und die sichtbare native Nichtunterstützung. Diese Checks sind offen.

## Dateien dieser Teilaufgabe

Neu:

- `kits/workspace/workspace-download.ts`
- `kits/workspace/workspace-download.test.ts`
- `kits/workspace/file-download-client.ts`
- `kits/workspace/file-download-client.test.ts`
- `kits/files/download-file.tsx`
- `kits/files/download-file.test.tsx`
- `docs/research/t3-file-download-integration-2026-10-29.md`

Additiv geändert, unter Erhalt aller Vorarbeiten:

- `kits/workspace/protocol.ts`
- `kits/workspace/protocol.test.ts`
- `kits/workspace/host.ts`
- `kits/workspace/host.test.ts`
- `kits/workspace/store.ts`
- `kits/workspace/desktop.tsx`
- `kits/files/kit.ts`
- `kits/files/open-in.tsx`
- `kits/files/editor-tab.tsx`
- `kits/files/desktop.tsx`
- `kits/files/desktop.test.tsx`


## Parent-Korrektur aus dem echten Desktop-Test

Der tatsächliche Electron-Download konnte die Ressourcen-URL nicht per Fetch
lesen. Der Parent hat deshalb den bereits vorhandenen authentifizierten
`read-browser-resource`-Befehl über `HostExtensionClient.readResource` angeboten.
Downloads bevorzugen diesen verbindungsgebundenen Kanal und prüfen Base64,
Status und Bytezahl vor der Blob-Erzeugung. HTTP bleibt nur der ältere Fallback.
Für Downloads wurden CSP und CORS nicht gelockert. Direkte und Relay-Verbindungen mit diesem
Socketvertrag benötigen keine zusätzliche HTTP-Freigabe. Native Clients haben
weiterhin eine ausdrückliche Save-Port-Grenze; Peer-Workspaces werden nicht über
die falsche lokale Verbindung umgebogen. 122 Regressionen in fünf Dateien
bestanden nach dem neuen Anschluss, der reale Downloadtest folgt nach Neubau.
