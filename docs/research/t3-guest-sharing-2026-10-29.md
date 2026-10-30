# Eingeschränkte Gastfreigabe, 29. Oktober 2026

Im gemeinsamen Worktree ist `kits/thread-sharing/` neu implementiert. Ein lokaler Owner kann einen einzelnen offenen, gespeicherten und nicht archivierten Thread für einen Browser freigeben. Gastzugriff läuft über eine eigene HTTP-Route und separate Credentials. Ein Gast wird kein gepaartes Gerät und bekommt keinen Workbench-Zugang.

Der Code ist noch nicht ausgeführt oder kompiliert worden. Auf ausdrückliche Anweisung liefen weder Tests, Typechecks, Builds, Installationen noch Appstarts. Es gibt keine Commits, Pushes, veröffentlichten Links oder anderen externen Mutationen. Alle bestehenden Änderungen anderer Arbeiten wurden erhalten.

## Quellen und Vorgaben

Gelesen wurden `AGENTS.md`, `CONTEXT.md`, `docs/agents/domain.md`, die ADRs 0002, 0006, 0009, 0020, 0023, 0024 und 0037 sowie `kits/README.md`. Inhaltlicher Ausgangspunkt sind [Paritätsbericht](t3-parity-implementation-2026-10-29.md), [Inventur mit Primärquellen](t3code-since-2026-10-11.md) und Abschnitt 6 des [UX-Berichts](t3-parity-next-ux-2026-10-29.md). Der UX-Bericht lag vor den UI-Änderungen vor.

Upstream wurde ausschließlich lesend unter `/tmp/tau-t3code-upstream-20261029` benutzt. `HEAD` entspricht dem geforderten Pin `7a4f5b6188fed54ddc866723e39446a198b5835c`. Gelesene Primärquellen:

- [Ursprüngliche Gastfreigabe, Commit fb76594](https://github.com/pingdotgg/t3code/commit/fb76594d7b9f38d27d8d093733a791d0005c921c).
- [HTTP-Routen am Pin](https://github.com/pingdotgg/t3code/blob/7a4f5b6188fed54ddc866723e39446a198b5835c/apps/server/src/guest/http.ts), einschließlich No-store, Begrenzung von Requests und getrennten Gastantworten.
- [GuestShareService am Pin](https://github.com/pingdotgg/t3code/blob/7a4f5b6188fed54ddc866723e39446a198b5835c/apps/server/src/guest/GuestShareService.ts), [Gastprojektion](https://github.com/pingdotgg/t3code/blob/7a4f5b6188fed54ddc866723e39446a198b5835c/apps/server/src/guest/guestView.ts) und [Attachment-Prüfung](https://github.com/pingdotgg/t3code/blob/7a4f5b6188fed54ddc866723e39446a198b5835c/apps/server/src/guest/guestAttachments.ts).

Tau übernimmt die abgegrenzte Gastansicht und moderierte Zustellung. Credential- und Transportmodell sind an Tau angepasst; die Upstream-Routen für Dateien, Tool-Items und Render-Ergebnisse werden nicht übernommen.

## Implementiertes Verhalten

Settings → Connections erhält `Guest links (beta)`. `Allow guest links` ist standardmäßig aus. Der Owner erstellt über `Share with a guest…` im Titel-/Zeilenmenü oder der Palette einen Link mit 1, 8 oder 24 Stunden Laufzeit. Standard sind acht Stunden und `Watch and suggest messages`; `Watch` ist auswählbar. Ein neuer Link ersetzt den vorherigen Link desselben Threads. Erstellung, Aktivierung und Widerruf sind serverseitig Owner-Befehle und lehnen Aufrufe anderer Host-Extensions zusätzlich ab.

Die Adresse muss bereits von einem Netzwerkmodul als HTTPS-Endpunkt mit vertrauenswürdigem Zertifikat veröffentlicht sein. Der tatsächlich vorhandene Anbieter dafür ist Tailscale HTTPS. Das Gastmodul ruft weder `holdProxy` noch `keepProxy` auf und öffnet keinen Listener. Ohne passenden Endpunkt erklärt der Dialog die nötige Einrichtung gemäß UX-Bericht. Die Registrierung selbst öffnet auch keinen Port.

Die fokussierte Gastseite liegt unter `/extensions/tau.thread-sharing/guest`. Das Linkcredential steht ausschließlich im Fragment `#guest=…`. Das Seitenskript entfernt das Fragment vor Speicherung, Netzwerkzugriff und Rendering. Es erzeugt mit Web Crypto ein separates Browsercredential, speichert es je Freigabe im Browser und meldet es beim Claim an. Der Server speichert SHA-256-Hashes des gesamten Link- und Browsercredentials, vergleicht sie mit `timingSafeEqual` und behält nie die Bearerwerte auf Disk. Ein erneuter Claim desselben Browsers ist für verlorene HTTP-Antworten idempotent; ein anderer Browser erhält `409 claimed`. Diese Browserbindung ist eine Bearerbindung an den Browser-Speicher, kein Schutz gegen absichtliches Kopieren dieses Speichers.

Alle Gast-API-Aufrufe verwenden `Authorization: Bearer …`, niemals Cookies oder Querytokens. Es gibt ausschließlich Claim, Lesen und Vorschlagen. Eine Thread-ID, ein Dateipfad, ein Toolname oder ein fremder RPC-Aufruf können keine Route auswählen. Gastcredentials werden nicht in `HostAccess` eingetragen. Der vorhandene WebSocket-Handshake lehnt beide Gastcredential-Formen ab.

Vor jedem Lesen und Vorschlag prüft die Route Credential, Aktivierung, Ablauf und den gespeicherten Thread. Nach asynchronen Transcript- und Indexreads prüft sie erneut, bevor sie antwortet oder einen Vorschlag annimmt. Widerruf entfernt den Grant sofort aus dem Arbeitsspeicher, verwirft wartende Vorschläge und speichert die Änderung atomar. Ein bereits gestarteter Read darf nach Widerruf keinen Transcripttext liefern. Ersatzlinks, Stop, die Archiv-/Papierkorb-Ereignisse von Thread Rail und endgültiges Löschen widerrufen ebenfalls. Ein neuer `beforeRemove`-Hook im zentralen Core-Löschpfad wartet auf den dauerhaften Widerruf, bevor ein Thread in den Papierkorb geht; sofortiges Restore reaktiviert keinen alten Link. Ausschalten pausiert die Grants und löscht Vorschläge; Einschalten aktiviert noch nicht abgelaufene Grants wieder.

Die serverseitige Projektion übernimmt ausschließlich `{ role, text }` aus sichtbaren User-/Assistant-Nachrichten. Notices, Shell-Nachrichten, aus dem Modellkontext ausgeschlossene Nachrichten, Thinking, Fehlerfelder, Bilder, Tool-Daten, Quell-Entry-IDs und sonstige Metadaten werden nicht serialisiert. Eine begrenzte öffentliche Textprojektion wird mit dem Grant gespeichert und bei Änderungen aktualisiert. Cache-Schreibvorgänge sind an die Grant-ID gebunden, damit ein verspäteter Read keinen Ersatzlink mit einer alten Projektion überschreiben kann. Dadurch kann ein Gast nach Neustart den zuletzt geteilten Text lesen, ohne dass die Gastanfrage eine Runtime öffnet. Offene Threads liefern über die bestehende `HostThread.transcript()`-Projektion auch den aktuellen Assistant-Text.

Gastvorschläge enthalten bis zu 8.000 Zeichen und vier PNG-/JPEG-/WebP-Bilder mit insgesamt 10 MiB. MIME-Typ, Base64 und Dateisignatur werden geprüft; Pfade, URLs, HTML und SVG sind keine Attachments. Alle wartenden Bilder zusammen sind zusätzlich auf 14 MiB Base64 begrenzt. Vorschläge leben nur im Arbeitsspeicher, einer darf je Link warten. Der Gast erhält nur ID und Entscheidungsstatus zurück.

`Guest suggests` erscheint mit den bestehenden Queue-Shelf-Klassen über dem Composer, einschließlich Bildern, `Send` und `Dismiss`. Die aktuelle Queue-Shelf-Komponente hat keine Contribution-Schnittstelle für noch nicht zugestellte Vorschläge. Deshalb nutzt die Extension den vorhandenen `composer-above`-Slot und das Queue-Shelf-Aussehen; erst das explizite `Send` stellt über `services.sessions.send(..., { delivery: "queue" })` in die vorhandene Queue zu. Es gibt keine Wake-Regel und keinen automatischen Versand. Send ist erst nach Hover oder Fokus auf der Karte aktiv. Read only kann beide Entscheidungen nicht auslösen; ein Full-Gerät kann sie auslösen. Eine erneute Berechtigungsprüfung nach asynchroner Vorbereitung verhindert Zustellung, wenn währenddessen pausiert oder widerrufen wurde. Unklare Zustellfehler ermöglichen keinen blinden Retry.

Der Header zeigt `Shared` bzw. `Shared · guest watching`. Sein Menü bietet Copy, Stop und Ablaufzeit. Die Rail zeigt `Suggestion`. Ein neu erstellter Link wird mit Copy-Button und lokal erzeugtem QR-Code angezeigt. Reine Bearerwerte bleiben nur in diesem Fenster im Speicher; nach Fenster-Neuladen ist Copy für alte Links deaktiviert. Der Owner muss dann einen Ersatzlink erstellen. So führt die Copy-Funktion zu keiner rückholbaren Klartextspeicherung auf dem Server.

## Begrenzungen der Route

- Höchstens 20 Grants, 500 Nachrichten, 32.000 UTF-16-Zeichen je Nachricht und 200.000 Zeichen insgesamt. Die Gastseite nennt ausgelassene ältere Inhalte.
- Pro tatsächlichem TCP-Absender 1.800 Requests/Minute, zehn Claims/Minute und sechs Vorschläge/Minute; pro autorisiertem Grant 90 Requests/Minute. `X-Forwarded-For` wird nicht zur Erhöhung des Budgets benutzt. Gäste hinter demselben Proxy teilen die Absenderlimits.
- Höchstens 16 gleichzeitige API-Requests, maximal 1 KiB Claim-JSON bzw. ungefähr 14 MiB Vorschlags-JSON. Größenprüfung auch während des Lesens, zehn Sekunden Bodyfrist und 15 Sekunden Antwortfrist. Ein intern hängender Read behält seinen belegten Slot, damit ein Timeout keine unbegrenzten Hintergrundreads erzeugt.
- Querystrings und ungewöhnliche Pfade werden abgelehnt. Origin-/Fetch-Site-Prüfung, kein CORS, kein Cache, kein Referrer, `nosniff`, Frame-Verbot und CSP ohne externe Ressourcen.
- Nachrichtentext wird über `textContent` inert dargestellt. Es wird weder Markdown-HTML interpretiert noch ein Link, Bild oder eingebetteter Inhalt aus Nachrichtentext geladen.
- Die Gastseite fragt alle 1,5 Sekunden ab; das Workbench-Management alle drei Sekunden. Serverseitig wirkt Widerruf sofort. Die normale Gastseite leert ihre Darstellung bei der nächsten Antwort. Schon gelesenen oder kopierten Inhalt kann ein Widerruf nicht zurückholen.

## Geschriebene Regressionen, noch nicht ausgeführt

| Datei | Abgedecktes Verhalten |
| --- | --- |
| `kits/thread-sharing/http.test.ts` | Echter isolierter Node-HTTP-Listener und zwei verschiedene Threads; fehlende, falsche, Link-statt-Browser-, abgelaufene, widerrufene und ersetzte Tokens; Restart; konkurrierende Claims; Widerruf während Read; fehlender Thread ohne Fallback; Moderation; adversariale Felder, SVG/HTML, Größen-/Bildlimits, Origins, Rate-Limit und CSP. |
| `kits/thread-sharing/store.test.ts` | Default-off, paralleler Linkersatz, Grantlimit, öffentliche Projektion und Widerruf über Restart, Schutz des Ersatzlink-Caches vor alten Reads, Pause/Widerruf während moderierter Zustellung, Bereinigung von Attachments und unsichere Wiederholung. |
| `kits/thread-sharing/projection.test.ts` | Ausschluss privater Felder, Reasoning, System-/Shell-Zeilen; Textbudgets; frühes Entfernen des Fragments; literale Credential-RegEx und inertes DOM. |
| `kits/thread-sharing/host.test.ts` | Echter Registry-Aufruf mit Owner, Full und Read only; kein Netzwerk-Hold; nur ausdrückliche Queue-Zustellung; Cache ohne Runtime; Stop; synchrone Archiv-/Papierkorb-Invalidierung; Auswahl eines tatsächlich passenden Threads; direkter Core-Löschhook ohne Rail-Ereignis. |
| `kits/thread-sharing/desktop.test.tsx` | Eigene Kit-Lifecycle-Regression, Settings-Leerzustand, Ownergrenze, explizites Erstellen und Kopieren, Fokus-/Hover-Sperre für Send und beide Read-only-Entscheidungen. |
| `src/main/guest-network.test.ts` | Echte Registrierung auf isoliertem bestehenden HTTP-Server, Namespace und Freigabe; beide Gastcredential-Formen werden am echten Host-WebSocket vor Hello-Antwort, Methoden und Pushes abgewiesen; Await-/Fehlerverhalten des Löschhooks. |

Für den gemeinsamen Parent-Lauf sind diese sechs Dateien vorgesehen, plus `src/main/host-network-contributions.test.ts`, `src/main/host-extensions.test.ts`, `src/shared/kits-boundary.test.ts` und die globale Kit-Lifecycle-Prüfung. Relevante Typprüfungen sind Kits, Renderer und Electron. Keine dieser Prüfungen wurde hier gestartet. Auch `git diff --check` und Lint wurden nicht ausgeführt; die Arbeit wurde nur lesend im Source durchgesehen.

## Zwingende Core-Anschlüsse und Koordination

Fünf bestehende Core-Dateien wurden minimal ergänzt:

1. `src/main/host-extensions.ts`: optionale In-process-Methoden `network.publishedEndpoints()` und `network.registerHttpRoute(name, handler)` sowie `context.observeExtensionEvent(source, name, listener)`. Der Event-Absender stammt aus der aktiven Registry-Identität; der Listener wird an seine Aktivierung gebunden und beim Deaktivieren entfernt. Außerdem bekommt `HostThreadLifecycle` den In-process-Hook `beforeRemove`, den `HostThreadLifecycleSet` vor der Entfernung vollständig abwartet. Alte Kontexte können keine neuen Listener registrieren.
2. `src/main/host-network-contributions.ts`: namespacegebundene Routenregistrierung unter `/extensions/<extension-id>/<name>` und Dispatcher auf bestehenden Listenern. Registrierung erstellt keine Netzwerk-Holds.
3. `src/main/headless.ts`: Routen der Netzwerk-Contributions und die bestehende externe MCP-Route werden verkettet. Derselbe Dispatcher hängt an Loopback, Web, Proxy und bereits freigegebenen Netzwerklistenern.
4. `src/main/host-extension-api.ts`: ausschließlich der neue Typexport `HostHttpRoute`. Gleichzeitig entstandene Änderungen der Suchimplementierung an den Thread-Text-Exporten dieser Datei sind nicht Teil dieses Pakets und wurden erhalten.

5. `src/main/pi-host.ts`: genau eine zusätzliche Zeile in `removeThread`, nach den vorhandenen Zulässigkeitsprüfungen und vor Release/Trash. Sie ruft `threadLifecycle.beforeRemove(sessionId, session.projectPath)` auf. Das ist ein zwingender Lebensdauer-/Autorisierungsanschluss, damit direkte Core-Aufrufer keine Gastfreigabe über Löschen und Restore erhalten.

Dazu kommt die neue Core-Regression `src/main/guest-network.test.ts`. Kein Eingriff in `kits/workspace/`, `kits/private-secrets/` oder `kits/scheduling/`.

Der Parent muss außerhalb dieses Eigentumsbereichs noch `sharing` aus `./thread-sharing/desktop.js` in die globale Liste von `kits/kit-lifecycle.test.tsx` aufnehmen. Das eigene Lifecycle-Testcase existiert bereits. Ebenso sind die vier optionalen API-Erweiterungen in `docs/EXTENSIONS.md` zu dokumentieren und gemeinsam mit den anderen parallelen API-Erweiterungen zu versionieren. Das Manifest akzeptiert die gegenwärtige Linie `^1.79.0`; ältere Implementierungen ohne die nötigen optionalen Methoden melden die Freigabe als nicht verfügbar. Eine neue globale Versionsnummer wurde nicht konkurrierend vergeben.

## Grenzen und noch nötige Produktanschlüsse

Dies ist eine nutzbare eingeschränkte Textfreigabe, aber keine vollständige Umsetzung aller Details aus Abschnitt 6 des UX-Berichts:

- `Show tool output` bleibt ausgeschaltet und deaktiviert. Der Owner-Befehl weist `showToolOutput: true` ab. Auch Toolnamen/-status werden derzeit nicht exportiert. Die bestehende generische Schnittstelle trennt öffentliche Toolinformationen nicht belastbar von verborgenen Ergebnissen und privaten Feldern. Der präzise Anschluss dafür ist eine typisierte, bereits im jeweiligen Runtime-Modul gefilterte öffentliche Toolprojektion, bevor die Checkbox aktiviert werden darf.
- Transcriptbilder, reiches Markdown und gemeinsame Stylesheet-Dateien der Web-Workbench werden nicht geladen. Die kleine Gastseite nutzt Systemschrift, Light/Dark-Systemfarben und inerten Text. Vorschlagsbilder funktionieren separat. Für identisches Workbench-Markdown braucht es einen isolierten Renderer ohne Remote-Ressourcen und ohne HTML-/Dateiverknüpfungen.
- Erreichbarkeit funktioniert über bereits publiziertes browservertrauenswürdiges HTTPS, praktisch Tailscale Serve. Die bestehende Tau-Connect-WebSocket-Relay-Adresse ist kein allgemeiner HTTP-Tunnel für diese Route. Der vorgegebene Hinweis nennt Tau Connect mit, eine reine Tau-Connect-Einrichtung allein reicht für dieses Paket deshalb noch nicht. Ein echter HTTP-Proxy in Tau Connect wäre ein eigenes Infrastrukturanschlussstück.
- Die Anzeige `Shared by` verwendet den Betriebssystemnamen der Maschine. Ein späterer kleiner, lesender API-Anschluss kann den in Tau konfigurierten Anzeigenamen liefern, ohne der Extension die Berechtigung `machines` für fremde Maschinen zu geben.
- Der öffentliche Snapshot enthält den zuletzt vom Gastpfad oder bei Erstellung gelesenen Text. Wenn eine Runtime nach Neustart geschlossen bleibt, wird sie für den Gast nicht gestartet. Er liest dann diesen Snapshot bis zum nächsten Öffnen des Threads durch den Owner. Attached-Pi ohne `HostThread` kann keinen neuen Link erstellen.
- Sofortige Archiv-Invalidierung benutzt die gebundenen Thread-Rail-Ereignisse; jeder Gastrequest prüft zusätzlich den Sessionindex und die gespeicherte Rail-Metadatei. Löschen ist zusätzlich durch den zentralen `beforeRemove`-Hook abgesichert. `ThreadTrash` wurde nicht geändert.
- Eine fehlgeschlagene persistente Widerrufsschreibung wird als Fehler gemeldet; im aktuellen Prozess ist die Freigabe bereits entfernt bzw. die Extension geschlossen. Ohne erfolgreiche Datenträgerschreibung kann die alte Diskversion nach einem späteren Neustart noch existieren. Es wird kein erfolgreicher dauerhafter Widerruf behauptet, wenn das Schreiben fehlgeschlagen ist.
- Es gab keine reale Browser-/Proxy-/Appprüfung. Die globalen ADR-/API-Anschlüsse und diese Grenzen gehören in die Integrationsentscheidung des Parents, bevor die Beta als vollständig geprüft gilt.

## Architekturentscheidung zur Übernahme in die nächste globale ADR

Status: vorgeschlagen; der Text liegt wegen des eingeschränkten Dateieigentums hier statt mit konkurrierend vergebener Nummer unter `docs/adr/`.

### Guests have a separate HTTP audience for one thread

A guest is the audience of one owner's expiring thread grant. Its invitation and browser credentials are separate hashed capabilities accepted only by a dedicated HTTP route on existing, explicitly enabled listeners. They never establish a workbench, pairing, socket, RPC, MCP, terminal, file or tool principal. The extension builds an allowlisted public transcript projection on the server and reauthorizes every response after asynchronous reads; revocation removes the grant and pending proposals immediately. Guest proposals wait outside runtime admission until a Full-access person explicitly sends them through the existing queue. This avoids changing the meaning of the Full and Read-only device presets in ADRs 0023, 0024 and 0037, while retaining core's existing placement and extension boundary from ADRs 0002 and 0006.

## Geänderte Dateien dieses Pakets

Neu unter `kits/thread-sharing/`: `tau-extension.json`, `protocol.ts`, `store.ts`, `projection.ts`, `http.ts`, `page.ts`, `host.ts`, `desktop.tsx`, `styles.css` sowie `store.test.ts`, `projection.test.ts`, `http.test.ts`, `host.test.ts`, `desktop.test.tsx`.

Außerdem die oben genannten fünf bestehenden Core-Dateien, `src/main/guest-network.test.ts` und dieser Bericht. Es wurden keine Test- oder Buildresultate erzeugt und keine fremden uncommitteten Änderungen zurückgesetzt.
