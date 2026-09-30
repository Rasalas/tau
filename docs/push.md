# Push notifications

The phone app hears of a thread that finished, failed, asks something or hands over to
you ("your turn") while you are away from Tau. Push Kit (`kits/push/`) on your machine
decides when; this page is about how a notification gets to the phone.

Apple and Google deliver to the app `de.tbuck.tau` only for a sender that proves it holds
the app's APNs key or the Firebase project's credentials. Your machine does not have
them, and never should. So there are two routes, chosen per platform:

| Route | When | Who reads the text |
|---|---|---|
| **Tau's relay** | The default: no key of your own is saved for that platform. | Nobody on the way. Your machine encrypts title and text with a key only your phone has. |
| **Your own keys** | You saved an APNs key (iPhone) or a Firebase service account (Android) in Settings → Push. | Apple or Google, as with any push. Your machine sends directly; no relay. |

Settings → Push shows under **How pushes travel** which route each platform takes, and
each device row says `relay`, `APNs` or `FCM`.

## What the relay sees

The relay is a single Cloud Function (`relay/`, Firebase project `tau-push-e3c95`,
region `europe-west3`). It holds Tau's APNs key, the Firebase project's own identity and
a key for sealing handles, and nothing else. It has no database and writes nothing to disk.

- When the phone registers, the relay sees its push token, its platform and its IP
  address. It answers with a *handle*, the token encrypted under the relay's key, and
  keeps nothing.
- When your machine sends, the relay sees the handle (which it opens to find the token
  again), the encrypted notification, an opaque collapse id so that a thread's newer
  notification replaces the older one, and your machine's IP address.
- It never sees the thread's title, the agent's words, the thread or host ids, or which
  machine sends. They are inside the encrypted part.

Its own logs hold event names and error codes only: no token, handle, payload or
address. Google Cloud keeps request logs for every call (time, path, status, caller IP
address) for 30 days. Rate limits live in memory: 30 sends in a burst per handle, then one
every 6 seconds; 10 registrations per address, then one a minute. At most two
instances run.

Apple and Google see the token and the ciphertext. An Android phone decrypts the
notification itself and shows the real title and text. An iPhone shows **"A thread
needs your attention"** for now; tapping it opens the thread. Decrypting on the iPhone
needs a Notification Service Extension, which is a later ticket.

## How it works

1. The app gets its push token from iOS or Android and sends `POST /register
   { platform, token }` to the relay (`PUSH_RELAY_URL` in `kits/push/protocol.ts`). It
   asks once per token and app start; if the relay cannot be reached, it registers with
   the token alone.
2. For each host it pairs with, the app makes a random 256-bit key and a random key id
   once, and keeps them in the Keychain or the Keystore-backed store
   (`mobile/src/push-keys.ts`). Forgetting the host deletes its key.
3. Over the existing pinned TLS connection, the app calls the host's `register`
   command with `{ platform, token, host, topic?, relay: { handle, keyId, key } }`. The
   host keeps it in `kit-state/tau.push/devices.json` (mode 0600).
4. For a notification, the host seals `{ title, body, url, kind, tag }` with the phone's
   key and sends `POST /send { handle, payload, collapseId }` to the relay.
5. The relay opens the handle and hands the payload to FCM as a high-priority data
   message `{ sealed }`, or to APNs with the generic alert, `mutable-content: 1` and the
   payload in its own field `sealed`. It tries APNs production first and then the
   sandbox, for a development build's token.
6. On Android, `TauMessagingService` (in the app's native plugin) finds the key by its
   id, decrypts, and shows the notification; a tap opens the thread's `tau://` link. On
   iOS the app decrypts the link when the notification is tapped.

A token that FCM calls unregistered, or that APNs answers with 410 or `BadDeviceToken`,
comes back as `410 gone`. The host then drops that phone's registration, and the phone
registers again the next time it connects.

### Endpoints

Base URL: `https://europe-west3-tau-push-e3c95.cloudfunctions.net/relay`. Both take and
answer JSON; bodies are at most 8 KiB.

| Request | Answer |
|---|---|
| `POST /register { platform: "ios" \| "android", token }` | `200 { handle }`; `400` for a token that does not look like one; `429` with `Retry-After`. Answers any origin (CORS), since the app's web view calls it. |
| `POST /send { handle, payload, collapseId? }` | `200 { ok: true }`; `410 { error: "gone", reason }` for a handle the relay cannot open or a token that is gone for good; `400` for a payload over 3072 characters or outside base64url and dots, or a collapse id over 64; `429`; `502 { error: "upstream", reason }`; `503` for iPhones until the APNs key is set up. |

### Formats

**Handle, version 1** (the relay's own; nobody else opens it):
`base64url(0x01 ‖ keyId ‖ nonce ‖ AES-256-GCM(JSON { p, t }) ‖ tag)`, with a random
96-bit nonce, a one-byte key id, and the associated data `"tau-relay-handle" ‖ 0x01 ‖
keyId`. Changing version or key id makes it fail to open.

**Sealed push, version 1** (host to phone):
`1.<keyId>.<base64url(nonce ‖ ciphertext ‖ tag)>`, AES-256-GCM with a random 96-bit
nonce over the JSON `{ title, body, url?, kind?, tag? }`, with the associated data
`tau-push:1:<keyId>`. The host seals with Node's crypto (`kits/push/relay.ts`), the app
opens with WebCrypto (`mobile/src/push-crypto.ts`) and on Android with `javax.crypto`.
The collapse id is `HMAC-SHA256(HKDF-SHA256(key, info "tau-push:collapse"), threadId)`, cut to 22 characters, so
the relay cannot trace it back to a thread.

A new layout gets a new version number; readers refuse versions they do not know.

### Keys

- `RELAY_HANDLE_KEYS` in Secret Manager holds comma-separated `<id>:<32 bytes, base64>`
  entries, ids 1 to 255. The first one seals new handles; every listed one still opens.
  To rotate, put a new key first (`2:…,1:…`) and deploy. Each phone gets a new handle when
  the app next starts. Once the old key is removed, its handles answer `410`, and those phones
  register again the next time they connect.
- `APNS_KEY_P8`, `APNS_KEY_ID` and `APNS_TEAM_ID` in Secret Manager hold the team's APNs key.
  Until it exists, any placeholder works (`none`); iPhones then get `503`.
- FCM needs no key file. The function runs as `push-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com`,
  which firebase-admin uses to send.
- The phone makes one push key per host. Only the phone and that host have it.

## Your own keys (self-hosting)

With keys of your own, your machine sends to Apple and Google itself and the relay never
hears of it: Settings → Push → iPhone (APNs key, Key ID, Team ID) or Android (Firebase
service account). The steps are in [mobile-testflight.md](mobile-testflight.md#8-push-notifications).
This is also the way for your own build of the app under another bundle id. The keys are
kept in `kit-state/tau.push/keys.json` (mode 0600). Removing them switches that platform
back to the relay.

Running a relay of your own takes a build of the app too: the relay's address is a
constant in `kits/push/protocol.ts` and in the app's content security policy
(`mobile/index.html`), and the relay pushes only to `APNS_TOPIC` (`relay/src/senders.ts`).
A host can be pointed at another relay with `TAU_PUSH_RELAY_URL` (https, or http on
loopback).

## Deploying the relay

`.github/workflows/push-relay.yml` checks every change under `relay/` (and
`kits/push/apns.ts`, which the relay bundles): typecheck, tests and build. On `main`, and
when run by hand, it deploys from the GitHub environment `push-relay`. It signs in to
Google through Workload Identity Federation, so no key file exists. From a checkout,
`npm run relay:deploy` does the same with your own login (`firebase login`, or
`gcloud auth application-default login`).

The deploy runs `firebase deploy --only functions --force` from `relay/`. `--force`
removes functions of the `push-relay` codebase that the source no longer defines, and
sets the Artifact Registry cleanup policy without asking.

### Once, by hand

Project `tau-push-e3c95`, number `712111328256`. Replace the placeholders in angle brackets.

1. **Billing.** Link a billing account (Blaze plan) and set a budget alert at 5 €.
2. **APIs.** Enable `cloudfunctions`, `run`, `cloudbuild`, `artifactregistry`,
   `secretmanager`, `eventarc`, `pubsub`, `storage`, `iamcredentials`, `sts` and `fcm`
   (each `<name>.googleapis.com`).
3. **Secrets.**
   ```sh
   printf '1:%s' "$(openssl rand -base64 32)" | gcloud secrets create RELAY_HANDLE_KEYS --data-file=- --project tau-push-e3c95
   gcloud secrets create APNS_KEY_P8 --data-file=AuthKey_<KEYID>.p8 --project tau-push-e3c95
   printf '<KEYID>' | gcloud secrets create APNS_KEY_ID --data-file=- --project tau-push-e3c95
   printf '<TEAMID>' | gcloud secrets create APNS_TEAM_ID --data-file=- --project tau-push-e3c95
   ```
   Keep the `.p8` file, its Key ID and Team ID, and the value of `RELAY_HANDLE_KEYS` in
   the vault as well. Without the APNs key yet, create the three APNs secrets with the
   value `none`.
4. **Runtime service account** `push-relay-runtime`:
   ```sh
   gcloud iam service-accounts create push-relay-runtime --display-name "Push relay (runtime)" --project tau-push-e3c95
   gcloud projects add-iam-policy-binding tau-push-e3c95 --member serviceAccount:push-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com --role roles/firebasecloudmessaging.admin
   for secret in RELAY_HANDLE_KEYS APNS_KEY_P8 APNS_KEY_ID APNS_TEAM_ID; do
     gcloud secrets add-iam-policy-binding $secret --member serviceAccount:push-relay-runtime@tau-push-e3c95.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor --project tau-push-e3c95
   done
   ```
5. **Deploy service account** `push-relay-deployer`, with these project roles:
   `roles/cloudfunctions.developer`, `roles/run.admin` (for the public invoker on the
   function's Cloud Run service), `roles/artifactregistry.admin` (for the cleanup policy),
   `roles/secretmanager.viewer`, `roles/firebase.viewer` and
   `roles/serviceusage.serviceUsageConsumer`. It also needs `roles/iam.serviceAccountUser`
   on `push-relay-runtime@…` and on the default compute account
   `712111328256-compute@developer.gserviceaccount.com`, which Cloud Build runs as. This
   list follows Firebase's documentation for 2nd-gen functions. If the first deploy
   names a permission that is missing, grant it and run the workflow again.
6. **Workload Identity Federation.** A pool `github` with an OIDC provider `tau-repo`:
   ```sh
   gcloud iam workload-identity-pools create github --location global --display-name GitHub --project tau-push-e3c95
   gcloud iam workload-identity-pools providers create-oidc tau-repo --location global --workload-identity-pool github \
     --issuer-uri https://token.actions.githubusercontent.com \
     --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner_id=assertion.repository_owner_id' \
     --attribute-condition "assertion.repository_owner_id == '7483565' && assertion.repository == 'Rasalas/tau'" \
     --project tau-push-e3c95
   gcloud iam service-accounts add-iam-policy-binding push-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com --role roles/iam.workloadIdentityUser \
     --member 'principal://iam.googleapis.com/projects/712111328256/locations/global/workloadIdentityPools/github/subject/repo:Rasalas/tau:environment:push-relay' \
     --project tau-push-e3c95
   ```
   Only a job in the `push-relay` environment of `Rasalas/tau` can act as the deployer.
7. **GitHub environment** `push-relay` (Settings → Environments): deployment branches
   `main` only, and three variables:

   | Variable | Value |
   |---|---|
   | `PUSH_RELAY_WIF_POOL` | `github` |
   | `PUSH_RELAY_WIF_PROVIDER` | `tau-repo` |
   | `PUSH_RELAY_SERVICE_ACCOUNT` | `push-relay-deployer@tau-push-e3c95.iam.gserviceaccount.com` |

   The deploy job stops with an error that names any variable left out.

After the first deploy, `curl -si -X POST <base URL>/register -d '{}'` should answer
`400`. A test push from Settings → Push on a machine without keys of its own should
reach the phone.

A domain of our own (`push.tbuck.de`) would need a Firebase Hosting rewrite or a Cloud
Run domain mapping, a new `PUSH_RELAY_URL`, and the new origin in `mobile/index.html`.

## Testing

`relay/src/*.test.ts` run with the repository's `npm test`, with FCM mocked and APNs
answered by a loopback fake. They never reach Google or Apple. `relay/src/index.ts`, the
Firebase entry, is checked by `npm --prefix relay run typecheck` after
`npm --prefix relay ci`. For the host, `node scripts/push-fakes.mjs` also starts a fake
relay and prints `TAU_PUSH_RELAY_URL`. Its handles are only encoded, and it records every
send in `.tau-dev/push-fakes/pushes.jsonl` ([testing-the-app.md](agents/testing-the-app.md)).
