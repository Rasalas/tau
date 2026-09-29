# Tau im Google Play Store

Recherche vom 29. September 2026. Abgleich der Einrichtungsanleitung mit offiziellen Google-Dokumenten. Die Angaben zu Taus Implementierung sind hier nicht als geprüft vorausgesetzt.

## Konto und geschlossener Test

Die Anforderung mit mindestens zwölf Testpersonen und 14 durchgehenden Tagen stimmt. Sie gilt für persönliche Entwicklerkonten, die nach dem 13. November 2023 angelegt wurden. Beim Produktionsantrag müssen mindestens zwölf Personen bereits seit den vorangegangenen 14 Tagen ohne Unterbrechung angemeldet sein. Eine E-Mail-Liste allein genügt nicht. Google fragt nach tatsächlicher Nutzung, Feedback und Änderungen. Unzureichende Beteiligung kann weitere Tests erforderlich machen. Nach 14 Tagen erfolgt deshalb keine automatische Freischaltung. Diese Sonderanforderung betrifft neue persönliche Konten. [Google: Testanforderungen](https://support.google.com/googleplay/android-developer/answer/14151465)

In der Anleitung fehlt die Geräteprüfung für neue persönliche Konten. Der Kontoinhaber bestätigt mit der Play-Console-App den Zugriff auf ein physisches, nicht gerootetes Android-Gerät ab Android 10. [Google: Geräteprüfung](https://support.google.com/googleplay/android-developer/answer/14316361?hl=en)

Den Kontotyp nach dem tatsächlichen Herausgeber wählen. Google sieht persönliche Konten für persönliche Nutzung und Organisationskonten für Unternehmen oder Organisationen vor. Eine Organisation benötigt grundsätzlich eine D-U-N-S-Nummer; die Beantragung kann laut Google bis zu 30 Tage dauern. [Google: Kontotyp](https://support.google.com/googleplay/android-developer/answer/13634885?hl=en), [Google: erforderliche Kontodaten](https://support.google.com/googleplay/android-developer/answer/13628312?hl=en)

## Dienstkonto und Uploads

Der beschriebene Aufbau stimmt: Cloud-Projekt, aktivierte Google Play Developer API, Dienstkonto und dessen Einladung in die Play Console. Eine zusätzliche Verknüpfung zwischen Entwicklerkonto und Cloud-Projekt ist nicht mehr erforderlich. Die für Billing dokumentierten Finanz- und Bestellrechte sind für diesen Upload-Zweck keine Vorgabe. [Google: Developer API einrichten](https://developers.google.com/android-publisher/getting_started)

Für Tau die App-Berechtigungen vergeben, statt Rechte auf das gesamte Entwicklerkonto auszuweiten:

| Aufgabe des Workflows | Passende Play-Berechtigung |
| --- | --- |
| App-Daten lesen | View app information, read-only |
| Bundles hochladen und Test-Releases veröffentlichen | Release apps to testing tracks |
| Testkonfiguration und Testerlisten ändern | Manage testing tracks and edit tester lists |
| Produktions-Releases veröffentlichen | Release to production, exclude devices, and use Play App Signing |

Die Testverwaltung ist zusätzlich nötig, wenn der Workflow diese Konfiguration wirklich ändert. Produktionsrechte können später hinzukommen. Änderungen an Store-Texten und Bildern benötigen eine separate Berechtigung zur Store-Verwaltung. Die Tabelle folgt Googles [Berechtigungsdefinitionen](https://support.google.com/googleplay/android-developer/answer/9844686).

## Zugang für die App-Prüfung

Der vorgeschlagene englische Hinweis beschreibt die Installation, belegt aber noch keinen funktionierenden Prüfzugang. Google verlangt Zugang zu allen Funktionen, jederzeit erreichbare und wiederverwendbare Zugangsdaten ohne Standortbindung sowie englische Anweisungen. Für QR-Codes verlangt Google eine statische URL in der Console. [Google: Anforderungen an Prüfzugänge](https://support.google.com/googleplay/android-developer/answer/15748846)

Folgerung für Tau: Vor Einreichung den gesamten Ablauf vom frischen Android-Gerät bis zu nutzbaren Projekten und Threads prüfen. Ein abgelaufener Kopplungscode oder eine nur im eigenen LAN erreichbare Host-Adresse erfüllt den beschriebenen Zugang nicht. Ein erreichbarer Demo-Host mit geeigneten Beispieldaten oder ein vollständiger Demo-Modus wäre eine mögliche Lösung. Google schreibt in der zitierten Quelle keinen bestimmten Tau-Demoaufbau vor. Ob Selbstinstallation des Desktop-Hosts ausreichend funktioniert, ist noch offen.

## Datensicherheit und Firebase

Die Aussage "Tau erhebt keine Daten" lässt sich nicht daraus ableiten, dass der Entwickler keinen eigenen Server betreibt. Google zählt grundsätzlich Übertragungen vom Gerät als Erhebung, auch durch SDKs. Die Ausnahme für Dienstleister betrifft die Angabe zur Weitergabe. Eine eigene Ausnahme gilt für tatsächlich Ende-zu-Ende-verschlüsselte Daten, die ausschließlich Sender und Empfänger lesen können. [Google: Datensicherheitsformular](https://support.google.com/googleplay/android-developer/answer/10787469)

Firebase dokumentiert für Cloud Messaging die automatische Erfassung von App-Version und Firebase-User-Agent. Dazu kommt Firebase Installations als Abhängigkeit mit einer Installationskennung. Je nach Konfiguration können weitere Daten hinzukommen. Daher die tatsächlich ausgelieferten SDKs, Einstellungen und Nachrichteninhalte erfassen. Die Installationskennung ist ein Kandidat für die Formularangabe "Geräte- oder andere IDs"; die endgültige Zuordnung hängt von der Verwendung ab. [Firebase: Android-Datenoffenlegung](https://firebase.google.com/docs/android/play-data-disclosure), [Google: Datentypen und Kennungen](https://support.google.com/googleplay/android-developer/answer/10787469)

FCM schützt die Transportwege mit TLS. Es bietet von sich aus keine Ende-zu-Ende-Verschlüsselung des Nachrichteninhalts. Bei sensiblen Nachrichten empfiehlt Firebase zusätzliche Verschlüsselung oder inhaltslose Signale, nach denen die App Daten direkt vom eigenen Server abholt. [Firebase: Nachrichtenverschlüsselung](https://firebase.google.com/docs/cloud-messaging/encryption)

"Die Übertragung ist verschlüsselt" muss auch für die Verbindung zwischen Android-App und Tau-Host stimmen. Die Absicherung von FCM allein belegt das nicht. Noch zu prüfen sind sämtliche HTTP-/WebSocket-Verbindungen, Relay-Verbindungen und deren Nutzdaten.

"Kopplung aufheben oder App entfernen löscht alle Daten" ist ohne Implementierungsprüfung zu weitgehend. Firebase dokumentiert einen eigenen Löschaufruf für Installationen. Nach Löschung einer Installationskennung kann die Entfernung zugehöriger Daten aus Live- und Sicherungssystemen bis zu 180 Tage dauern. [Firebase: Installationen löschen](https://firebase.google.com/docs/projects/manage-installations#delete_a_firebase_installation)

## Offene Tau-Fragen vor endgültigen Formularantworten

- Welche SDKs und Zusatzfunktionen enthält das Release-AAB tatsächlich, insbesondere Analytics, Crashlytics und Installations?
- Entstehen Firebase-Kennungen schon beim App-Start oder erst nach einer bewussten Aktivierung von Push?
- Welche Nachrichtentexte, Projektnamen, Thread-Kennungen oder sonstigen Inhalte laufen durch FCM oder einen Relay-Dienst?
- Welche Nutzdaten gehen an den Host und anschließend gegebenenfalls an Modellanbieter?
- Welche Übertragungswege erlauben unverschlüsseltes HTTP oder WebSocket?
- Was löschen Entkopplung und Deinstallation jeweils auf Telefon, Host und bei Firebase?
- Funktioniert der Prüfzugang außerhalb des eigenen Netzwerks, ohne kurzlebige Einmalcodes und ohne private Projekte freizugeben?

Diese Fragen sind noch keine Feststellungen über Taus Verhalten. Ihre Antworten bestimmen die Datenschutzerklärung und die Angaben im Play-Formular.
