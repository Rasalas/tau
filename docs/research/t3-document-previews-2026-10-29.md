# Passive Dateivorschauen, 29. Oktober 2026

Die Files-Erweiterung ergänzt Host-Parser und Stage-Ansichten für DOCX, XLSX, PPTX, ZIP/JAR, TAR/TGZ/TAR.GZ, SQLite und EPUB. Dazu kommen einfache ODT-/ODS-/ODP- und RTF-Leseansichten sowie gespeicherte Notebook-Bilder. Die vorhandenen Notebook-, Frontmatter- und Sprachänderungen bleiben erhalten.

Es wurden keine Tests, Typechecks, Builds, Installationen oder Appstarts ausgeführt. Die Regressionen sind geschrieben und müssen vom Parent gesammelt geprüft werden. Es gibt keine Commits, Pushes oder externen Mutationen. Änderungen dieser Teilaufgabe liegen ausschließlich unter `kits/files/` und in diesem Bericht. `package.json`, `package-lock.json`, `src/` und Buildskripte wurden von dieser Teilaufgabe nicht geändert.

## Quellen und Entscheidungen

- [Parity-Inventur](t3code-since-2026-10-11.md), Abschnitt zu Dateivorschauen, und [bisheriger Implementierungsstand](t3-parity-implementation-2026-10-29.md).
- Upstream schreibgeschützt unter `/tmp/tau-t3code-upstream-20261029`, Pin `7a4f5b6188fed54ddc866723e39446a198b5835c`. Gelesener Parservergleich: `apps/web/src/components/files/officeArchive.ts`. Die dortigen XML-Deklarations-, Struktur- und Bytebegrenzungen waren besonders relevant.
- Zugehörige Primärquellen: [Office-Erweiterungen](https://github.com/pingdotgg/t3code/commit/d69810a97a98747e165b641a51fb1a3080f8382f), [Archive und SQLite](https://github.com/pingdotgg/t3code/commit/9d17a02782ae93b34f57df7e9c810968901b9fdd), [EPUB, Notebooks und OpenDocument](https://github.com/pingdotgg/t3code/commit/34ead566d44881a29e7438b949a421636742ab20).
- Der [Opus-UX-Bericht](t3-parity-next-ux-2026-10-29.md), Abschnitt 4, lag vor den UI-Änderungen vor. Übernommen wurden die Ansichtsarten, vorhandene Stage-/Open-in-Bausteine, der passive Hinweis, kein Source-Schalter für Binärdokumente, Blattwahl, eingeklappte Notizen, Archivmetadaten, Tabellen-/Schemawahl und Kapitelnavigation. Notebook-Bilder verwenden den bereits exportierten `AttachmentLightbox`.
- `CONTEXT.md`, ADR 0006, ADR 0014, ADR 0018 und ADR 0037 bestimmen Modulgrenzen, Worker-Verhalten und Dateiautorisierung. Die Vorschauen sind Host-Befehle mit `access: "read"` und explizitem, bereits aufgenommenem Workspace. Vor dem Öffnen werden relative und kanonische Pfade erneut auf den Workspace begrenzt.

Vor Dependencies wurden vorhandene Fähigkeiten geprüft: `node:zlib`, `node:worker_threads`, `node:fs`, `TextDecoder`, die vorhandenen `node:sqlite`-Nutzungen und installierten Node-Typdefinitionen sowie Blob-URLs und der öffentliche Lightbox-Export. Es ist keine zusätzliche Dependency nötig, also auch kein Lockfile-Anschluss. XML wird als bewusst begrenzte Teilmenge gelesen, ohne DTD-Auflösung, externe Entities oder Netzwerkzugriffe. Nicht unterstütztes XML fällt auf die Meldung zum Öffnen in einer anderen App zurück.

## Verhalten

| Art | Ergebnis |
| --- | --- |
| DOCX | Überschriften, Absätze, Listen und Tabellen. Zeichnungen als `[Image]`; keine Makros, Feldausführung oder eingebetteten Objekte. |
| XLSX | Interne Workbook-Reihenfolge, Blattnamen, Shared Strings, Inline Strings und gespeicherte Zellwerte. Formeln stehen nur im Zelltitel und werden nie berechnet. |
| PPTX | Interne Präsentationsreihenfolge, gespeicherter Folientext und eingeklappte Sprechernotizen. |
| ODT/ODS/ODP | Text aus `content.xml`. Wiederholte ODS-Zeilen und -Spalten werden nur bis zu den Vorschaugrenzen dargestellt. |
| RTF | Einfache Texte, Absätze, Unicode und Bildplatzhalter. Schrift-/Objekt-/Feldanweisungsgruppen werden ausgelassen. |
| ZIP/JAR | Zentralverzeichnis, Namen, Größen, Zeitangaben und Verschlüsselungsmarkierung. Die Archivansicht dekomprimiert keinen Eintrag. |
| TAR/TGZ | Geprüfte TAR-Header, einfache PAX-Metadaten und GNU-Langnamen; Symlink-/Hardlinkziele nur als Text. Gzip wird ausschließlich im Arbeitsspeicher entpackt. |
| SQLite | Vorherige Headerprüfung auch bei `.db`. Private Kopie, `readOnly`, `allowExtension: false`, `query_only`, `trusted_schema=OFF`; nur fest erzeugte Abfragen und validierte Tabellenwahl. Tabellen-/View-Schema, begrenzte Zeilen, BLOB-Größe. Grobe Zeilenzahl nur aus vorhandenem `sqlite_stat1`, kein vollständiges `COUNT(*)`. |
| EPUB | Titel, Autor, Kapitelübersicht aus der Spine-Reihenfolge und einzelne Kapitel als passive Textblöcke. Kapitel-HREFs werden ausschließlich gegen interne Paketnamen aufgelöst. |
| Notebook | Die Maschine liest bis 10 MiB und liefert bereits geparste Zellen. PNG/JPEG/GIF/WebP mit Signaturprüfung und eine eingeschränkte SVG-Teilmenge werden als lokale Blob-Bilder dargestellt. Markdown-Bilder und Links bleiben inaktiv. HTML, JavaScript, Widgets und Ressourcenreferenzen werden ausgelassen. |

Die Darstellung erzeugt aus Office-/EPUB-Inhalten ausschließlich React-Textknoten und eigene Tabellen. Kein `dangerouslySetInnerHTML`, kein authored HTML, keine Markdown-Appdirektiven und keine Dokument-URLs erreichen aktive Elemente. Das übernimmt die inaktive Textdarstellung des bestehenden Files-/Notebook-Viewers, ohne Office-XML in Markdown-Code oder Linksyntax umzuwandeln. Notebook-SVG wird zusätzlich auf bekannte passive Elemente begrenzt; Skripte, Events, Styles, Referenzen, Animationen und fremde Elemente werden verworfen. Blob-URLs werden beim Wechsel und beim Unmount freigegeben.

## Grenzen

| Ressource | Grenze |
| --- | --- |
| Eingabedatei | 20 MiB; begrenzte Handle-Leseoperationen, höchstens Budget plus ein Byte. |
| Notebookdatei | 10 MiB; der bestehende editierbare Quelltextpfad behält sein 1-MiB-Limit. Größere Notebook-Quellen bleiben dadurch weiterhin gegen unvollständiges Speichern geschützt. |
| Parser | Separater Worker je Lesen, 128 MiB Old Space, 16 MiB Young Space, 4 MiB Stack. Kooperative 2,5 Sekunden und harte Terminierung nach 3 Sekunden. Maximal ein aktiver Parser je Files-Aktivierung. |
| Archivverzeichnis | 10.000 Header/Einträge, 100 MiB deklarierte entpackte Bytes, höchstens 4.096 Bytes je ZIP-Name. |
| Office-/EPUB-Parts | 4 MiB je XML-Part, 32 MiB insgesamt tatsächlich angeforderte Parts. Dekompression mit `maxOutputLength`; Größe und CRC werden geprüft. |
| XML | 250.000 Elemente über alle Parts, Tiefe 64, 64 Attribute je Element, maximal 64 KiB je Tag. DTD und Entities werden abgelehnt; EPUB akzeptiert nur eine einfache `DOCTYPE html` ohne externe Angaben. |
| Dokumenttext | 200.000 Zeichen insgesamt; maximal 5.000 Blöcke je Textabschnitt. |
| Tabellen | 1.000 Zeilen × 50 Spalten je Blatt, höchstens 50 Blätter; zusätzlich 50.000 ausgegebene Tabellenzellen insgesamt. |
| Folien und Buch | 200 Folien bzw. 100 Kapitel. |
| Datenbank | 100 Tabellen/Views, 50 Spalten, 200 Zeilen, 1.024 Zeichen je Zelle. BLOBs werden nicht übertragen. Tabellen-SQL wird auf 8.192 Zeichen begrenzt. |
| Notebookbilder | 5 MiB dekodierte gespeicherte Daten je Bild, 30 Bilder je Notebook. Zusätzlich bleiben die vorhandenen Zell-, Text- und Outputlimits erhalten. |

Symlinks und `../` innerhalb von Archiven sind reine Anzeigedaten. Es gibt keine Extraktion ins Dateisystem, keine Rekursion in verschachtelte Archive und keinen Zugriff auf ein Linkziel. Office- und EPUB-Paketbeziehungen dürfen interne relative Beziehungen verwenden; absolute Pfade, Protokolle und ein Verlassen des Paketwurzelverzeichnisses werden abgelehnt.

SQLite liest ausschließlich die private Kopie. Das Original wird weder geöffnet noch mit WAL-/SHM-Dateien verbunden. Daher fehlen noch nicht in die Hauptdatei geschriebene WAL-Änderungen; die Ansicht sagt das ausdrücklich. Views und virtuelle Tabellen zeigen nur ihr Schema und führen kein gespeichertes View-SQL aus. Normale Tabellen werden über aus dem Schema ausgewählte und gequotete Namen gelesen. Eine frei eingegebene SQL-Zeichenfolge gibt es nicht. Die Kopie wird nach Erfolg, Fehler und Worker-Abbruch entfernt. Bei einem vollständigen Prozessabsturz kann das private OS-Tempverzeichnis zurückbleiben; ein bereinigender Neustartdienst wurde hier nicht ergänzt.

## Bewusste Abweichungen und Anschlüsse

- Keine originalgetreue Office-Paginierung, Designs, Diagramme, Fontnachbildung, Datumsformatierung, Bilder oder Formelauswertung. Die Ansicht liest gespeicherten Inhalt. Komplexe XML-Encodings und unbekannte Formate fallen auf die Fehlermeldung zurück.
- ZIP64, Mehrfachvolumen, verschlüsselte Dokumentparts, globale TAR-PAX-Header, Sparse-TAR und DRM-EPUB sind nicht unterstützt. Die Archivliste kann verschlüsselte ZIP-Einträge weiterhin als Metadaten zeigen.
- Die genaue Gesamtzeilenzahl von SQLite wird nicht teuer berechnet. Ohne Statistik fehlt das `about … rows` im Kopf; ein sichtbarer Hinweis kennzeichnet die 200-Zeilen-Grenze.
- EPUB-Kapitel werden aus dem Spine gelesen. Ein abweichend verschachteltes Navigation-Dokument wird nicht als eigener TOC-Baum interpretiert.
- Notebooks aus dem gespeicherten Dateipfad parst die Maschine. Noch nicht gespeicherte Änderungen bleiben wie bisher lokal aus dem begrenzten Editorpuffer lesbar. Ein Texteditor-Reload schaltet weiterhin auf die zuletzt gespeicherte Datei um.
- Die passive Stage ist für alle drei vorhandenen Profile registriert. Der Compact-Entwurf verwendet Selects statt der Blatt-/Tabellenseitenleiste. Die bestehende telefonische Files-Sheet- und AttachmentLightbox-Dateirouten in Core sind nicht geändert. Falls dort passive Dokumente direkt geöffnet werden sollen, muss der Parent auf `tau.files`-Stage-Routing oder die neuen `preview`-/`notebook`-Befehle anschließen.
- Der vorhandene `OpenInPicker` bleibt der Fallback. Er ist wie bisher nur für lokale Dateizugriffe sichtbar. Eine Download-Aktion für entfernte Dateien wird von der hier verfügbaren Files-API nicht angeboten. Dafür braucht der Parent einen vorhandenen autorisierten Downloadpfad oder einen gesonderten API-Anschluss. Es wurde keine neue Download-UX erfunden.
- Die kanonische Pfadprüfung und `O_NOFOLLOW` reduzieren Symlinkprobleme, sind aber kein atomarer Verzeichnis-Handle-Walk gegen gleichzeitig ausgetauschte Elternverzeichnisse. Das ist die bereits in ADR 0037 beschriebene Grenze.
- Parserfunktionen sind absichtlich in sich abgeschlossen und werden als vertrauenswürdiger Programmtext in den Worker übertragen. Nutzereingaben sind ausschließlich Worker-Daten. Der CommonJS-Bundle-Regressionstest muss bestehen, bevor eine Änderung am Bundler diese Funktionsserialisierung verändert.

## Geschriebene Regressionen und Parent-Prüfung

Neue selbst erzeugte ZIP-/TAR-/Office-/EPUB-Fixtures brauchen keine externen Programme. Neue Regressionen prüfen Inhaltsextraktion, Formeln als Text, kaputte CRCs, Verschlüsselung, XML-DTD und Strukturgrenzen, komprimierte Parts, Traversal und Linkziele, Zeilen-/Spaltenlimits, Worker-Timeout, den tatsächlichen CommonJS-Hostbundlepfad, SQLite-Kopien ohne Änderung am Original, die neue Notebook-Lesegrenze, Bildsignaturen, SVG-Ausschlüsse, Bildlimits, Lightbox und Blob-Cleanup. UI-Tests warten auf den Inhalt, den sie anschließend lesen.

Vom Parent einmal gesammelt ausführen, nicht als hier bereits bestandene Checks verstehen:

```sh
npm test -- kits/files/preview-parser.test.ts kits/files/preview-host.test.ts kits/files/passive-preview-view.test.tsx kits/files/notebook-images.test.tsx kits/files/notebook.test.ts kits/files/notebook-preview.test.tsx kits/files/host.test.ts kits/files/desktop.test.tsx kits/files/restart.test.tsx kits/files/document.test.ts kits/files/file-kind.test.ts kits/files/markdown-frontmatter.test.ts
npm run typecheck:kits
```

Zusätzlich gehören die neuen Hostbefehle in die zentrale Read-only-/Machine-Routing-Prüfung des Parents. Der Bundle-Test erzeugt im Test ein temporäres Hostbundle; in dieser Teilaufgabe wurde kein Bundle gebaut. Der Parent soll außerdem seine vorgesehenen gemeinsamen Lint-/Build-/Appprüfungen ausführen, insbesondere die ausgelieferte Electron-Version mit `process.getBuiltinModule`, `node:sqlite` und Worker-Serialisierung sowie kompakte Ansichten und die bestehende Lightbox.

## Geänderte Dateien dieser Teilaufgabe

Neue Dateien:

- `kits/files/passive-preview.ts`
- `kits/files/preview-parser.ts`
- `kits/files/preview-host.ts`
- `kits/files/passive-preview-view.tsx`
- `kits/files/preview-fixtures.ts`
- `kits/files/preview-parser.test.ts`
- `kits/files/preview-host.test.ts`
- `kits/files/passive-preview-view.test.tsx`
- `kits/files/notebook-images.test.tsx`
- `docs/research/t3-document-previews-2026-10-29.md`

Ergänzt, mit Erhalt der vorherigen uncommitteten Änderungen:

- `kits/files/host.ts`, `kits/files/protocol.ts`
- `kits/files/desktop.tsx`, `kits/files/editor-tab.tsx`
- `kits/files/file-kind.ts`, `kits/files/styles.css`
- `kits/files/notebook.ts`, `kits/files/notebook-preview.tsx`, `kits/files/notebook.test.ts`
- `kits/files/host.test.ts`, `kits/files/desktop.test.tsx`, `kits/files/file-kind.test.ts`

`notebook.ts`, `notebook-preview.tsx` und `notebook.test.ts` waren bereits als ungetrackte Dateien vorhanden. Sie zählen hier deshalb zu den Ergänzungen, nicht zur neu begonnenen Notebook-Implementierung. Die vorherigen Änderungen an `languages.ts`, `languages.test.ts`, `markdown-frontmatter.ts` und `markdown-frontmatter.test.ts` wurden nicht bearbeitet.
