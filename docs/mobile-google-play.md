# Tau bei Google Play

Stand: 30. September 2026. Die App ist eingerichtet und das erste Bundle liegt als
Entwurf im internen Test. Es ist noch kein Release für Tester oder die Öffentlichkeit
freigegeben.

## Eingerichtet

- Entwicklerkonto: **tbuck software**, Organisationskonto,
  ID `8863683401293141822`. Der Pflicht-Test neuer persönlicher Konten entfällt.
- [Tau in der Play Console](https://play.google.com/console/u/0/developers/8863683401293141822/app/4974173993478757363/app-dashboard):
  Paket `de.tbuck.tau`, kostenlos, Standardsprache `en-US`.
- Kategorie: Productivity, in der deutschen Console **Effizienz**.
- Öffentliche Kontaktadresse: `tau@tbuck.de`.
- Website: <https://rasalas.github.io/tau/>.
- Erklärungen gespeichert: keine Werbung, keine Werbe-ID, keine Behörden-App,
  keine Finanzfunktionen, keine Gesundheitsfunktionen.
- Play App Signing ist aktiv. Das Upload-Zertifikat stimmt mit dem vorhandenen
  Upload-Schlüssel überein. Es wurde kein neuer Upload-Schlüssel erzeugt.

## Automatische Uploads

Cloud-Projekt: `tau-play-publishing`, Projektnummer `657607778022`.
Die API `androidpublisher.googleapis.com` ist aktiviert.

Das Dienstkonto
`tau-play-upload@tau-play-publishing.iam.gserviceaccount.com` ist in der Play Console
aktiv. Sein Zugriff ist auf Tau beschränkt: App-Informationen lesen, Test-Releases
veröffentlichen, Test-Tracks und Testerlisten verwalten sowie Produktions-Releases
veröffentlichen. Für den Store-Upload wurden zusätzlich die Verwaltung der
Store-Präsenz und das Bearbeiten von App-Entwürfen freigeschaltet, ebenfalls nur
für Tau. Es hat keine Cloud-Projektrollen erhalten.

Der private JSON-Schlüssel liegt ausschließlich außerhalb des Repos im Drive-Tresor:

```text
Meine Ablage/tresor/_dev/GitHub/tau/play-service-account.json
```

[Datei im Tresor](https://drive.google.com/file/d/1iD8SraDPM8btWKnbWkTgPT578mlIlfN1/view)

Der Schlüssel wurde durch einen erfolgreichen Bundle-Upload über die Google Play
Developer API geprüft. Der spätere GitHub-Workflow ist noch nicht eingerichtet;
auch das dafür nötige GitHub-Secret wurde in diesem Schritt nicht gesetzt.

## Erster Build

- Version `0.7.15`, Versionscode `715`, Track `internal`, Status `draft`.
- [Interner Test](https://play.google.com/console/u/0/developers/8863683401293141822/app/4974173993478757363/tracks/internal-testing?tab=releases)
- Lokale Datei: `.scratch/play-store/tau-0.7.15-715.aab`, von Git ausgeschlossen.
- SHA-256: `732c13721aa20d686003a9c0784c0279b20cee44ce279f47213b84e2dde3f3f4`.

Gebaut mit `vite build`, `cap sync android` und Gradle `bundleRelease`.
Der Build benötigt `ANDROID_HOME=/Users/tbuck/Library/Android/sdk` auf diesem Mac.
Das Bundle wurde mit dem vorhandenen Keystore, Alias `upload`, signiert.
`jarsigner -verify` bestätigt die Signatur; die Web-Assets enthalten keinen
`tauAutomation`-Verweis. Gradles Release-Lint und Bundle-Build waren erfolgreich.
Ein Gerätetest des Release-Bundles steht aus.

Die alte Firebase-Konfiguration verwendete noch `io.github.rasalas.tau` und
verhinderte den Build. Im bestehenden Firebase-Projekt `tau-push-e3c95` wurde deshalb
die Android-App **Tau Play** für `de.tbuck.tau` registriert:
`1:712111328256:android:c64e113b0a504475d21ce5`.
Die passende `google-services.json` liegt lokal unter `mobile/android/app/` und
aktualisiert im selben Drive-Tresor. Die bisherige Firebase-App bleibt erhalten.

## Vor der Veröffentlichung offen

1. **Datenschutzerklärung.** Die ursprüngliche URL
   `https://tbuck.de/privacy/tau/` antwortete mit HTTP 404. Die Erklärung liegt jetzt
   als Markdown unter `docs/site/privacy.md` und `docs/site/privacy-de.md` und wird
   vom bestehenden GitHub-Pages-Workflow gerendert. Öffentliche URL:
   `https://rasalas.github.io/tau/docs/privacy.html`, Deutsch: `privacy-de.html`.
   Beide Seiten sind live; die englische URL ist in der Play Console gespeichert.
   Der App-Startbildschirm verlinkt die Erklärung seit Commit `ece2f566`.
   Das bereits hochgeladene Bundle `715` enthält diesen Link noch nicht; der nächste
   Build muss ihn übernehmen und braucht einen höheren Versionscode.
2. **Prüfzugang herstellen und testen.** Die App benötigt einen Tau-Host und eine
   Kopplung. Die Console verlangt vollständigen, wiederverwendbaren Zugang.
   Die Erklärung zu Anmeldedaten ist nicht abgeschlossen. Dadurch ist auch der
   Zielgruppenfragebogen noch gesperrt; vorgesehen sind Personen ab 18 Jahren.
   Ein lokaler Demo-Modus mit Beispielgesprächen und simulierten Antworten wird
   im Branch `play-store-demo` vorbereitet. Er benötigt weder einen öffentlichen
   Rechner noch Inferenz. Er deckt echte Kopplung, Agent-Ausführung, Dateioperationen
   und Push-Zustellung nicht ab und ist noch nicht im hochgeladenen Bundle enthalten.
3. **Datensicherheit ausfüllen.** FCM und die Host-Verbindung müssen anhand des
   tatsächlichen Datenflusses bewertet werden. Der Push-Kit sendet standardmäßig
   Thread-Titel und Textauszüge an FCM, siehe `kits/push/protocol.ts`,
   `kits/push/host.ts` und `kits/push/fcm.ts`. Die pauschale Antwort
   "keine Daten erhoben" aus dem ursprünglichen Plan ist nicht übernommen worden.
   Inzwischen als Entwurf gespeichert: In-App-Mitteilungen, Fotos, Dateien und
   Geräte-IDs, jeweils für App-Funktionen. Inhaltsdaten sind optional, IDs wegen
   FCM automatisch erforderlich. Die endgültige Einreichung hängt noch an der
   Zielgruppenangabe; die Angaben bleiben bis dahin prüfbar.
4. **Inhaltsfragebogen abschließen.** Begonnen mit `tau@tbuck.de` und
   "Alle anderen App-Typen". Die Bewertung von Online-Inhalten muss die ausdrücklich
   im Formular genannten KI-generierten Inhalte berücksichtigen. Keine finale
   Altersfreigabe eingereicht. Nach Wiederherstellung der Browser-Verbindung wurde
   der teilweise ausgefüllte Fragebogen gespeichert.
5. **Store-Einträge vervollständigen.** Englische und deutsche Texte, 512 × 512 Icon
   und 1024 × 500 Vorstellungsgrafik sind über die API gespeichert. Die Quellen
   liegen unter `mobile/play/` im Branch `play-store-demo`. Echte Telefon-Screenshots
   fehlen noch im Store-Eintrag.
6. **Internen Test starten.** Tester auswählen, Release prüfen und freigeben.
   Bisher gibt es keine bestätigte Opt-in-URL und keinen veröffentlichten Test-Release.
7. **GitHub-Upload anbinden.** Dienstkonto als Secret hinterlegen und Workflow bauen.
   Der nächste Upload braucht einen höheren Versionscode als `715`.

Die [Recherche zu Googles Vorgaben](research/google-play-publishing.md) enthält
die offiziellen Quellen und die offenen Fragen zur Datenschutzerklärung.
