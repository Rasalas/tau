# Tau bei Google Play

Stand: 30. September 2026. Version `0.7.15`, Versionscode `71500`, ist im internen
Test freigegeben. Die Liste **Just me** enthält nur `t.buck91@gmail.com`.
Die öffentliche Veröffentlichung ist noch nicht eingerichtet. Das Dashboard
zeigt **8 von 11 Einrichtungsschritten erledigt**.

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

## Interner Test

- Version `0.7.15`, Versionscode `71500`, Track `internal`, API-Status `completed`.
- [Am internen Test teilnehmen](https://play.google.com/apps/internaltest/4700959703604814909),
  mit `t.buck91@gmail.com` anmelden.
- [Interner Test in der Console](https://play.google.com/console/u/0/developers/8863683401293141822/app/4974173993478757363/tracks/internal-testing?tab=releases).
- Lokale Datei: `.scratch/play-store/tau-0.7.15-71500.aab`, von Git ausgeschlossen.
- SHA-256: `1e7f631b26b859d3a43dc52b4e16a9107c4894360132b3ca005b38096a130e61`.
- Enthält den Datenschutz-Link und den lokalen Demo-Modus.
- Play zeigt vor der ersten öffentlichen Prüfung vorübergehend
  `de.tbuck.tau (unreviewed)` als App-Namen.

Das ursprüngliche Bundle `715` wurde im Testrelease durch `71500` ersetzt.
Künftig berechnet Gradle den Versionscode als
`(major × 10000 + minor × 100 + patch) × 100 + Android-Revision`.
Die Revision ist standardmäßig 0 und mit `-PtauAndroidRevision=1` bis 99 erhöhbar.
Ein bereits hochgeladener Versionscode darf nicht erneut verwendet werden.
Die nächste Tau-Version `0.7.16` beginnt somit bei `71600`.

Gebaut mit `vite build`, `cap sync android` und Gradle `bundleRelease lintRelease`.
Der Build benötigt `ANDROID_HOME=/Users/tbuck/Library/Android/sdk` auf diesem Mac.
Das Bundle wurde mit dem vorhandenen Keystore, Alias `upload`, signiert.
`jarsigner -verify` bestätigt die Signatur; die Web-Assets enthalten keinen
`tauAutomation`-Verweis. Gradles Release-Lint und Bundle-Build waren erfolgreich.
Die Demo wurde im isolierten Android-Emulator geprüft: Threads öffnen, Antwort
auf eine Nachricht, neuen Thread anlegen und Rücksetzen beim Verlassen.
Elf betroffene Tests und der Mobile-Typecheck waren erfolgreich.
Das über Play ausgelieferte Release muss noch auf einem echten Telefon geprüft werden.

Die alte Firebase-Konfiguration verwendete noch `io.github.rasalas.tau` und
verhinderte den Build. Im bestehenden Firebase-Projekt `tau-push-e3c95` wurde deshalb
die Android-App **Tau Play** für `de.tbuck.tau` registriert:
`1:712111328256:android:c64e113b0a504475d21ce5`.
Die passende `google-services.json` liegt lokal unter `mobile/android/app/` und
aktualisiert im selben Drive-Tresor. Die bisherige Firebase-App bleibt erhalten.

## Datenschutz und Store

- Die englische [Datenschutzerklärung](https://rasalas.github.io/tau/docs/privacy.html)
  und ihre [deutsche Übersetzung](https://rasalas.github.io/tau/docs/privacy-de.html)
  werden über GitHub Pages gerendert. Die englische URL ist in Play gespeichert.
  Die frühere geplante URL `https://tbuck.de/privacy/tau/` wurde nicht verwendet.
- Englische und deutsche Store-Texte, App-Icon, Vorstellungsgrafiken und je zwei
  echte Android-Screenshots sind in Play gespeichert. Quellen: `mobile/play/`.
- IARC-Fragebogen am 30. September gespeichert, Status **Abgeschlossen**.
  Kategorie: Alle anderen App-Typen. Online-Inhalte einschließlich KI-Ausgaben
  sind angegeben. Kein eigener Inhaltskatalog mit Sex, Gewalt oder Drogen und
  keine Nutzerkommunikation, Standortweitergabe, Käufe oder Glücksspiel.
  Die Inhalte der selbst betriebenen Hosts werden nicht vom Entwickler kuratiert.
  Die geplante Zielgruppe 18+ ist eine separate Erklärung, noch nicht gespeichert.

## Was die öffentliche Veröffentlichung noch blockiert

1. **Vollständiger Prüfzugang.** "Try demo" benötigt weder Rechner noch Inferenz,
   deckt aber echte Kopplung, Agent-Ausführung, Dateioperationen und Push nicht ab.
   Die englische Anleitung ist unter `mobile/play/README.md` dokumentiert.
   Die Console verlangt beim Hinzufügen die Checkbox
   "Die Anmeldedaten in dieser Erklärung gewähren uneingeschränkten Zugriff auf
   alle Funktionen und Inhalte in dieser App, auch auf Premium- oder kostenpflichtige
   Inhalte". Ohne diese Bestätigung schlägt das Speichern fehl. Sie wurde nicht
   bestätigt, weil die Demo diesen Zugriff nicht bietet. Die Anleitung ist daher
   noch nicht in Play gespeichert. Nötig ist ein geeigneter vollständiger Prüfzugang
   oder eine mit Google geklärte Prüfmöglichkeit für diesen Companion-Anwendungsfall.
2. **Zielgruppe.** Vorgesehen: 18 Jahre und älter. Die Console blockiert diesen
   Fragebogen ausdrücklich, bis "Anmeldedaten" abgeschlossen ist.
3. **Datensicherheit.** Der ausgefüllte Entwurf kann erst nach der Zielgruppenangabe
   abgeschlossen werden. Er nennt In-App-Mitteilungen, Fotos, Dateien und Geräte-IDs
   für App-Funktionen. Inhaltsdaten sind optional, FCM-Kennungen automatisch erforderlich.
   Keine pauschale Behauptung "keine Daten erhoben": Auch SDKs und die Host-Verbindung
   zählen. FCM erhält standardmäßig Thread-Titel und Textauszüge; die Push-Nutzlast
   ist nicht Ende-zu-Ende-verschlüsselt. Vor der Einreichung die endgültigen Angaben
   einschließlich Löschmöglichkeit nochmals mit dem tatsächlichen Datenfluss abgleichen.

Danach können die Änderungen zur Google-Prüfung eingereicht und ein öffentlicher
Release eingerichtet werden. Ein geschlossener 12-Personen-Test ist für das
bestehende Organisationskonto nicht vorgeschrieben.

Der ursprünglich für später vorgesehene GitHub-Upload bleibt eine eigene Aufgabe:
Workflow bauen, Schlüssel als Secret hinterlegen und einen Upload testen.
Das Dienstkonto und der vorhandene Upload-Schlüssel sind dafür einsatzbereit.

Die [Recherche zu Googles Vorgaben](research/google-play-publishing.md) enthält
Links zu den offiziellen Quellen.
