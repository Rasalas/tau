# Datenschutzerklärung

Diese Erklärung gilt für die Android-App Tau mit dem Paketnamen `de.tbuck.tau` und die Tau-Website auf GitHub Pages. Stand: 30. September 2026.

[English: Privacy policy](privacy.md)

## Verantwortlicher und Kontakt

Tau wird von Torben Buck, tbuck software, veröffentlicht. Fragen und Anträge zum Datenschutz kannst du an [tau@tbuck.de](mailto:tau@tbuck.de) richten.

## Dein Telefon und dein Rechner

Tau verbindet dein Telefon mit einem Tau-Host, den du selbst auswählst und verwaltest. Ein Konto bei tbuck software brauchst du dafür nicht. Nachrichten, Projektinformationen, geöffnete oder angehängte Dateien und Befehle werden zwischen dem Telefon und diesem Host übertragen. Der Entwickler betreibt keinen zentralen Server für diese Unterhaltungen und erhält sie bei der gewöhnlichen App-Nutzung nicht.

Dein Host kann Prompts, Dateien und weiteren Kontext an die von dir eingerichteten KI-Anbieter, Werkzeuge und Dienste senden. Dafür gelten deren Verarbeitungs- und Speicherregeln. Wenn jemand anderes deinen Host betreibt, kann diese Person auf die dortigen Daten zugreifen.

Das Telefon speichert Host-Namen, Verbindungsadressen, vertrauenswürdige Host-Schlüssel, Zugangsdaten und App-Einstellungen für spätere Verbindungen. Android schützt gespeicherte Zugangsdaten mithilfe seines Keystores. Die Verbindung zum Host ist mit TLS verschlüsselt. Ein von dir eingerichteter Proxy kann diese Verschlüsselung beenden und den Datenverkehr verarbeiten. Die lokale Netzwerkerkennung kann Tau-Hosts in der Nähe finden.

## Lokale Demo

Der optionale Modus "Try demo" verwendet Beispielgespräche und vorbereitete Antworten direkt in der App. Demo-Nachrichten und Einstellungen bleiben im Arbeitsspeicher des Telefons. Sie gehen weder an einen Tau-Host noch an einen KI-Anbieter und verschwinden beim Verlassen der Demo. Das in der App enthaltene Firebase-SDK wird dadurch nicht deaktiviert; seine Verarbeitung ist unten beschrieben.

## Push-Benachrichtigungen

Die Android-App enthält Googles Firebase Cloud Messaging, kurz FCM. Firebase kann eine Installation registrieren und technische Kennungen verarbeiten, bevor du die Anzeige von Benachrichtigungen erlaubst. Für den Dienst verarbeitet Firebase Installationskennungen, ein Zustell-Token sowie technische App- oder Geräteinformationen. Einzelheiten stehen in [Firebases Angaben zu Android-Daten](https://firebase.google.com/docs/android/play-data-disclosure).

Wenn du Benachrichtigungen aktivierst und dein Host für deren Versand eingerichtet ist, übergibt die App ihr Zustell-Token an diesen Host. Der Host sendet Benachrichtigungsinhalte über Google. Standardmäßig gehören dazu der Thread-Titel und ein kurzer Textauszug, etwa eine Antwort, Frage oder Freigabeanfrage. Kennungen sorgen dafür, dass ein Antippen den passenden Host und Thread öffnet.

In den Push-Einstellungen des Hosts kannst du Benachrichtigungen auf den Titel beschränken. Der Textauszug entfällt dann, Titel und Navigationskennungen gehen weiterhin über Google. Deaktiviere den Push-Versand auf dem Host, um diese Übertragungen zu stoppen. Die Android-Benachrichtigungseinstellungen steuern die Anzeige auf dem Telefon.

FCM verwendet verschlüsselte Verbindungen. Taus Benachrichtigungsinhalte sind jedoch **nicht Ende-zu-Ende-verschlüsselt**. Google verarbeitet sie zur Zustellung. Googles [Dokumentation zur FCM-Verschlüsselung](https://firebase.google.com/docs/cloud-messaging/encryption) und [Datenschutzinformationen zu Firebase](https://firebase.google.com/support/privacy) beschreiben den Dienst, einschließlich Verarbeitungsorten und Speicherdauer.

## Kopplung, Berechtigungen und Analyse

Für die Kopplung verwendet Tau Googles Code-Scanner. Dieser verarbeitet Kamerabilder auf dem Gerät und gibt den gelesenen Kopplungslink an Tau zurück. Laut Google speichert der Scanner weder Bilder noch Scan-Ergebnisse. Siehe die [Dokumentation zum Google Code-Scanner](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner).

Tau enthält keine Werbung, keine Werbe-ID-Anbindung, kein Google Analytics und kein Firebase Crashlytics. Die App fordert weder deine Kontakte noch deinen genauen Standort an. Google-Dienste können Betriebsinformationen verarbeiten, die ihre SDKs benötigen. Der Verzicht auf Tau-Nutzungsanalysen bedeutet deshalb nicht, dass diese Dienste keine Daten verarbeiten.

## Speicherung und Löschung

Entferne einen gespeicherten Host in der App, um seine lokalen Verbindungsdaten und Zugangsdaten zu löschen. Widerrufe zusätzlich das Telefon in den Verbindungseinstellungen dieses Hosts. Dadurch werden sein Zugriff ungültig und seine Push-Registrierung entfernt. Das Entfernen allein auf dem Telefon widerruft das Gerät auf dem Host nicht.

Das Löschen des Android-App-Speichers oder die Deinstallation entfernt die lokalen App-Daten. Unterhaltungen, Projektdateien, Sicherungen und Kopien auf deinem Host oder bei KI-Anbietern bleiben bestehen. Lösche sie auf dem jeweiligen Host oder beim jeweiligen Dienst. Für Firebase-Kennungen und Zustelldaten gelten Googles Aufbewahrungsregeln. Die Deinstallation bewirkt nicht zwingend deren sofortige Löschung bei Google.

Der Entwickler besitzt keine zentrale Kopie deiner Host-Daten, die er löschen könnte. Wenn du eine Support-E-Mail sendest, erhält er deine E-Mail-Adresse, die Nachricht und deine Anhänge. Diese Korrespondenz bleibt so lange gespeichert, wie die Bearbeitung und gegebenenfalls gesetzliche Pflichten es erfordern. Du kannst ihre Löschung unter [tau@tbuck.de](mailto:tau@tbuck.de) anfragen.

## Website und deine Rechte

Diese Website liegt auf GitHub Pages. GitHub verarbeitet technische Zugriffsdaten einschließlich IP-Adressen, um die Website auszuliefern und abzusichern. Die Tau-Website ergänzt weder Nutzungsanalysen noch Tracking-Cookies und lädt Schriften vom eigenen Webauftritt. Siehe [GitHubs Datenschutzerklärung](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Soweit die DSGVO auf die Verarbeitung durch tbuck software anwendbar ist, beruht die Bearbeitung von Serviceanfragen auf Art. 6 Abs. 1 Buchst. b. Betrieb und Absicherung der Website beruhen auf den berechtigten Interessen nach Art. 6 Abs. 1 Buchst. f. Gesetzliche Aufbewahrungspflichten beruhen auf Art. 6 Abs. 1 Buchst. c. Die Rechtsgrundlage für deinen eigenen Host oder einen unabhängig ausgewählten Anbieter richtet sich nach der jeweiligen Nutzung und dem Anbieter.

Unter den gesetzlichen Voraussetzungen kannst du Auskunft, Berichtigung, Löschung, Einschränkung und Übertragbarkeit der bei tbuck software gespeicherten personenbezogenen Daten verlangen und einer Verarbeitung aufgrund berechtigter Interessen widersprechen. Eine Einwilligung kannst du widerrufen, soweit die Verarbeitung darauf beruht. Du kannst dich bei einer Datenschutzaufsichtsbehörde beschweren. Wende dich für diese Rechte an [tau@tbuck.de](mailto:tau@tbuck.de). Für Daten, die ausschließlich dein Host oder ein Anbieter besitzt, ist dessen Betreiber der Ansprechpartner.

Änderungen an dieser Erklärung erscheinen hier mit einem aktualisierten Datum.
