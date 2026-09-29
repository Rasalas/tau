# Privacy policy

This policy covers the Tau Android app, package `de.tbuck.tau`, and the Tau website on GitHub Pages. Updated 29 September 2026.

[Deutsch: Datenschutzerklärung](privacy-de.md)

## Who to contact

Tau is published by Torben Buck, tbuck software. For privacy questions and requests, contact [tau@tbuck.de](mailto:tau@tbuck.de).

## Your phone and your computer

Tau connects your phone to a Tau host that you choose and control. It does not require an account with tbuck software. Messages, project information, files you open or attach, and commands travel between the phone and that host. The developer does not operate a central server for these conversations and does not receive them through ordinary app use.

Your host can send prompts, files and other context to the AI providers, tools and services you configure. Their processing and retention rules apply to those transfers. If someone else operates your host, that operator can access data on it.

The phone saves host names, connection addresses, trusted host keys, access credentials and app preferences so it can reconnect. Android protects stored access credentials using its Keystore. Connections to your host use TLS. A proxy that you configure can terminate that encryption and handle the traffic. Local network discovery can find nearby Tau hosts.

## Push notifications

The Android app includes Google's Firebase Cloud Messaging, or FCM. Firebase can register an installation and process technical identifiers before you grant permission to display notifications. It processes installation identifiers, a delivery token and technical app or device information to provide the service. See [Firebase's Android data disclosures](https://firebase.google.com/docs/android/play-data-disclosure).

When you enable notifications and your host is configured to send them, the app supplies its delivery token to that host. The host sends notification content through Google. By default this includes the thread title and a short text excerpt, such as an assistant response, question or approval request. It also includes identifiers that let a tap open the relevant host and thread.

You can choose title-only notifications in the host's Push settings. That removes the text excerpt, but the title and navigation identifiers still pass through Google. Disable push sending on the host to stop these transfers. Android notification settings control whether notifications appear on the phone.

FCM uses encrypted connections, but Tau's notification content is **not end-to-end encrypted**. Google processes that content for delivery. Google's [FCM encryption documentation](https://firebase.google.com/docs/cloud-messaging/encryption) and [Firebase privacy information](https://firebase.google.com/support/privacy) explain the service, including processing locations and retention.

## Pairing, permissions and analytics

Pairing uses Google's code scanner. It processes camera images on the device and returns the scanned pairing link to Tau. Google states that the scanner does not store the images or scan results. See the [Google code scanner documentation](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner).

Tau does not include advertising, an advertising-ID integration, Google Analytics or Firebase Crashlytics. It does not request your contacts or precise location. Google services may process operational information needed to run their SDKs; the absence of Tau analytics does not mean those services process no data.

## Storage and deletion

Remove a saved host in the app to delete its local connection details and access credential. Also revoke the phone in that host's connection settings to invalidate its access and remove its push registration. Removing a host only on the phone does not revoke the device on the host.

Clearing Android app storage or uninstalling Tau removes the app's local data. It does not delete conversations, project files, backups or copies held by your host or AI providers. Delete those at the respective host or service. Google manages Firebase identifiers and delivery data under its own retention rules; uninstalling the app is not a promise of immediate deletion from Google.

The developer has no central copy of your host's data to delete. If you send a support email, the developer receives your email address, message and anything you attach. This correspondence is kept while needed to handle the request and any applicable legal obligations. You can request its deletion at [tau@tbuck.de](mailto:tau@tbuck.de).

## Website and your rights

GitHub Pages hosts this website. GitHub processes technical access data, including IP addresses, to serve and secure it. Tau's website adds no analytics or tracking cookies and serves its fonts locally. See [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Where the GDPR applies to processing by tbuck software, responding to service requests relies on Article 6(1)(b), and operating and securing the website relies on the legitimate interests in Article 6(1)(f). A legal retention obligation relies on Article 6(1)(c). Processing by a host you operate or by an independently selected provider depends on that use and provider.

Subject to the applicable conditions, you can request access, correction, deletion, restriction and portability of personal data held by tbuck software, and object to processing based on legitimate interests. You can withdraw consent where processing relies on it and complain to a data protection supervisory authority. Contact [tau@tbuck.de](mailto:tau@tbuck.de) to exercise your rights. For data held only by your host or a provider, contact its operator.

Changes to this policy will appear here with an updated date.
