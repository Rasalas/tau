# Private Secret-Dateien für CLI-Aufrufe, 29. Oktober 2026

Die Umsetzung folgt dem Secret-Abschnitt der [privaten Opus-5.5-UX-Vorgaben](t3-parity-next-ux-2026-10-29.md). Grundlage sind der vorhandene private Webhook-Eingabepfad, ADR 0006, 0009, 0020, 0022 und 0024 sowie die [Upstream-Inventur](t3code-since-2026-10-11.md).

## Umsetzung

Eine eigene gebündelte Erweiterung `tau.private-secrets` bietet `request_secret_file` und `release_secret_file` über MCP und die Pi-Runtime-Registrierung an. Das vorhandene Scheduling-Tool `request_secret` mit Consumer `webhook-signature` bleibt erhalten; dadurch gibt es keine gleichnamigen Tool-Provider oder inkompatiblen Webhook-Aufrufe. Der Datei-Consumer akzeptiert `delivery: "file"`, Begründung, Label, sicheren Dateinamen und 15 bis 1.440 Minuten Lebensdauer, standardmäßig 60 Minuten.

Die Karte steht beim anfragenden Thread über dem Composer. Sie bewahrt einen ungesendeten Composer-Entwurf, verwendet ein Passwortfeld und erlaubt nur eine kürzere Lebensdauer. Nur der Owner auf der Maschine darf speichern, ablehnen oder widerrufen. Andere Geräte sehen den Hinweis aus dem UX-Bericht. Nach dem Speichern erscheint `Delete now`. Fehler leeren den eingegebenen Wert. Die Datenschutzerklärung verspricht nicht, dass ein Shellbefehl den Wert niemals ausgeben kann.

Jede Datei liegt in einem zufälligen Ordner `0700` unter dem Erweiterungs-State und wird exklusiv mit `0600` erzeugt. Benutzerpfade, Verzeichnisse, Symlinks und Überschreiben vorhandener Dateien werden nicht akzeptiert. Eingaben sind auf 64 KiB begrenzt. Tool-Ergebnisse enthalten Status, Dateipfad, zufällige Referenz und Ablaufdatum, keinen Wert. Globale Events enthalten nur `changed`; lesbare Zustände enthalten ausschließlich Request-Metadaten.

Referenzen sind an genau einen Thread gebunden. Andere Threads können sie nicht auflösen oder freigeben. Ablauf, Stop, Run-Ende, Reset, Session-Close, Thread-Löschen und Deaktivierung räumen Dateien auf. Metadaten in `.lease.json` enthalten keinen Secret-Wert. Bei einem Absturz werden ausschließlich vollständige, reguläre und noch gültige Dateien mit begrenzten Metadaten wiederhergestellt; abgelaufene oder unvollständige Ordner werden entfernt. Fehler beim Löschen bleiben sichtbar und wiederholbar.

## Bereits geprüft

- Backend- und Registry-Regressionen zu Datei-/Ordnerrechten, erhaltenen Zeilenumbrüchen, getrennten Threads, Owner-only-Eingabe, Größenlimits, Ablehnung, Abort, Ablauf, Stop/Close/Run-Ende und Crash-Recovery.
- UI-Regressionen zu privatem Speichern, verkürzter Lebensdauer, unmittelbarer Löschung, Fehlermeldung ohne erhaltenen Wert, Read-only-/Telefon-Eingabe und ausgeblendeten Anfragen anderer Threads.
- Der erste lokale Lauf über drei neue Testdateien bestand mit 17 Tests. Das unabhängige Astra-Review fand anschließend zwei konkrete Löschfehler: unterbrochene Schreibvorgänge konnten bei einem fehlgeschlagenen Rollback ihren verwalteten Pfad verlieren; die Historienbegrenzung konnte noch ausstehende Löschungen verwerfen. Der Ordner wird jetzt vor dem ersten Secret-Schreibzugriff registriert. Löschfehler bleiben verwaltet, sichtbar und widerrufbar und zählen zum Limit aktiver Dateien; die Historie verwirft ausschließlich vollständig bereinigte Einträge. Ein weiterer Test korrigierte das Warten auf einen absichtlich blockierten Schreibvorgang im Test selbst.
- Alle 19 Tests in vier Dateien bestanden danach, einschließlich der neuen simulierten Dateisystemfehler und erneuter Löschung nach mehr als 100 beantworteten Requests. Protokoll `/tmp/tau-secret-cleanup-green.log`. Die gezielte Kit-Typprüfung bestand nach Anpassung der fünf Argumente des Tool-Testaufrufs an den bestehenden Pi-Vertrag.

## Noch laufende Integration

- Der Thread-Rail-Archivbefehl muss nach Abschluss der parallel laufenden Rail-Arbeiten die Anbieter des Vertrags `tau.thread-rail/archive` mit `thread-archived` benachrichtigen. Diese Erweiterung bietet den Vertrag bereits an und erlaubt den Befehl ausschließlich für `tau.thread-rail`.
- Die tatsächliche Lesbarkeit der generierten Datei innerhalb der unterstützten Runtime-Sandboxes wird gesondert geprüft. Ein Dateisystemzugriff des Hosts allein belegt sie nicht.
- Unabhängiges Backend-Review, gemeinsame Typ-/Build-Prüfung und visuelle Prüfung in der isolierten App stehen aus.

Keine echten Secrets verwendet, keine Commits oder Pushes.


## Integrationskorrektur nach privatem UI-Review

Gespeicherte Leases bleiben über Run-Ende, Stop, Runtime-Schließen und Reset bis
zur gewählten Frist erhalten. Diese Ereignisse beenden nur noch offene Anfragen.
Ablauf, explizite Freigabe/„Delete now“, Archivieren, Threadlöschung und das
Deaktivieren der Erweiterung räumen gespeicherte Dateien auf. So entspricht die
Fristauswahl dem sichtbaren Versprechen. Die Karte übernimmt keinen Fokus aus
fremden Eingaben, unterscheidet eine nie gespeicherte Anfrage von einer gelöschten
Datei und erlaubt das Schließen ihres Endzustands.
