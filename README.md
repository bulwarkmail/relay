<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" />
  <img src="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main/public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" alt="Bulwark Webmail" width="280" />
</picture>

</div>

# Bulwark Relay

Push notification relay for Bulwark Webmail. Terminates JMAP `PushSubscription`
pushes from the user's mail server and forwards them as Firebase Cloud
Messaging, Web Push or [UnifiedPush](https://unifiedpush.org) pings so the
mobile app (or PWA) wakes up and fetches new mail over its own JMAP
connection.

Designed so self-hosters don't need their own Firebase project, a single
hosted instance serves every Bulwark client that opts in. The relay never sees
mail content: only push tokens and endpoints, JMAP ids, state strings, the
label a client registered with, and timing.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/push/register` | Mobile app stores its FCM token against an opaque `subscriptionId` |
| `POST` | `/api/push/register/web` | PWA stores a Web Push subscription (`endpoint` + `keys`) against an opaque `subscriptionId` |
| `POST` | `/api/push/register/unifiedpush` | Mobile app stores a [UnifiedPush](https://unifiedpush.org) endpoint (`endpoint` + optional Web Push `keys`) against an opaque `subscriptionId`. Delivery is encrypted Web Push when keys are present (connector >= 3.0), a plain POST of the ping otherwise. Works without VAPID configured - distributors don't require it |
| `POST` | `/api/push/register/apns` | iOS app stores its APNs device token (`deviceToken` + `environment`) against an opaque `subscriptionId` |
| `DELETE` | `/api/push/register/:id` | Tear down mapping (logout / uninstall) |
| `GET` | `/api/push/verify/:id` | Poll for the JMAP `PushVerification` code. It stays readable until the next registration replaces it |
| `GET` | `/api/push/active/:id` | Liveness probe. `{ active: true }` once the subscription has forwarded a push or its client picked up the verification code, and for 10 minutes after registering. `404` if unknown. Clients use it to reap dead leftover subscriptions without touching live ones |
| `POST` | `/api/push/jmap/:id` | JMAP server posts `PushVerification`, `StateChange` or `EmailPush` (draft-ietf-jmap-emailpush) here, and the relay dispatches to the transport of the stored record. For `EmailPush` only the message ids are forwarded, never any other property the server included |
| `GET` | `/api/push/vapid-public-key` | Returns the relay's VAPID public key so browsers can subscribe |
| `GET` | `/api/health` | Liveness probe |
| `GET` | `/metrics` | Prometheus metrics. Keep it off the public side of your proxy |

Every register route answers `503` when the relay has no credentials for that
transport (except UnifiedPush, which needs none), `400` to a body it can't use,
`413` to one over 64 KB. A wrong method on a known path answers `405`.

Anyone holding a `subscriptionId` can replace or delete its record, read its
verification code and post to it, so it has to be long and random. Bulwark
clients use 128 random bits. The relay only checks its format.

## What the mail server gets back

What `POST /api/push/jmap/:id` answers decides whether the mail server tries
again. Stalwart tries a non-2xx answer again after a minute, 3 attempts by
default, merging whatever arrived meanwhile into one push.

| Push service said | Relay does | Answer |
| --- | --- | --- |
| 2xx | | `200 { ok: true }` |
| 404, 410 (FCM `UNREGISTERED`, APNs `Unregistered`, `BadDeviceToken`, `DeviceTokenNotForTopic`) | Deletes the record | `200 { ok: false }` |
| 429, 408, 5xx, no answer within 8 s, network error | Keeps the record | `503 { ok: false }` |
| Any other 4xx | Keeps the record, logs it | `200 { ok: false }` |

## How it treats the push services

- **Urgency.** New mail goes out at high urgency, or what the client asked for in
  its `emailPush` config. Other state pings go out at low urgency.
- **Topic.** Web Push state pings for one account carry an RFC 8030 `Topic`, so a
  device that was offline gets the last one, not all of them. `EmailPush` pushes
  don't, since each names other messages. UnifiedPush gets no Topic.
- **Burst limit.** Web Push and UnifiedPush subscriptions get 10 pushes at once and
  one more every 20 seconds. Past that the relay answers `429` without calling the
  service, and the mail server's next attempt carries everything that piled up.
- **Backoff.** After a `429`, or any answer with `Retry-After`, the relay leaves that
  subscription alone for as long as the service says (60 seconds without a header,
  an hour at most). After 20 `429`s from one host within a minute it leaves the
  whole host alone for that long. Held pushes count in `relay_pushes_held_total`.

## Which endpoints it calls

Only `https` URLs without credentials, on public addresses. Names without a dot,
`.local`, `.internal` and the like are refused at registration, and what a name
resolves to is checked again on every connection. A stored record that fails this
is deleted instead of called. Redirects are not followed. To reach a distributor
on your own network, name it in `PUSH_ALLOW_PRIVATE_ENDPOINTS`.

## What it stores

Per `subscriptionId`: an FCM token (Android app), an APNs device token (iOS
app), a Web Push subscription (`endpoint` + `p256dh`/`auth` keys for the PWA), or
a UnifiedPush endpoint (Android app without Google Play services), the
verification code, an optional free-form `accountLabel` (max 120 chars), and
timestamps. No server URL, no mail content.

The `accountLabel` is what the client sends, and Bulwark clients send the sign-in
name. It is stored here and copied into every push: encrypted to the device for Web
Push and UnifiedPush with keys, but readable to Google and Apple in FCM and APNs
payloads, and to the distributor on a UnifiedPush endpoint without keys.

Subscriptions with no push and no registration for 90 days are evicted.

The store is `subscriptions.json` in `PUSH_DATA_DIR`, written atomically, with the
previous version as `subscriptions.json.bak`. A file that can't be read is kept as
`subscriptions.json.corrupt-<time>` and logged as an error, and the relay starts
from the previous version.

## What it logs

Requests by route, status and duration, with a short hash that follows one
subscription through the logs. Failed forwards also log the push service's host,
status and its reason, with any URL in it removed. Never the subscription id, an
endpoint path, keys, tokens or the label.

## Run locally

```sh
npm install
echo '{...}' > data/fcm-service-account.json   # Firebase service account JSON
npm run dev
```

## Run in Docker

```sh
mkdir -p data
cp path/to/fcm-service-account.json data/
docker compose up -d
```

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3003` | HTTP listen port |
| `HOST` | `0.0.0.0` | |
| `PUSH_DATA_DIR` | `./data` | Where `subscriptions.json` and the FCM key live |
| `FCM_SERVICE_ACCOUNT_JSON` | unset | Either the full JSON inline or an absolute path; falls back to `$PUSH_DATA_DIR/fcm-service-account.json` |
| `VAPID_PUBLIC_KEY` | unset | Base64url-encoded P-256 public key for Web Push. Generate with `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | unset | Matching private key. Web Push is disabled if either VAPID var is missing |
| `VAPID_SUBJECT` | `mailto:postmaster@localhost` | `mailto:` or `https:` contact the push services can reach if the relay misbehaves (RFC 8292) |
| `APNS_KEY_ID`, `APNS_TEAM_ID` | unset | APNs signing key id and team id. APNs is disabled if either is missing |
| `APNS_KEY` | `$PUSH_DATA_DIR/apns-key.p8` | The `.p8` key, inline PEM or a path |
| `APNS_TOPIC` | `org.bulwarkmail.mobile` | Bundle id of the app |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | unset | Comma-separated hosts that may be called even though they aren't public, such as your own ntfy |
| `PUSH_FORWARD_TIMEOUT_MS` | `8000` | How long one attempt at a push service may take. Keep it below the mail server's own timeout (Stalwart: 10 s), or the same push goes out twice |
| `PUSH_SUBSCRIPTION_BURST` | `10` | Pushes one Web Push or UnifiedPush subscription may get at once |
| `PUSH_SUBSCRIPTION_REFILL_MS` | `20000` | Time until one more is allowed |
| `PUSH_HOST_THROTTLE_LIMIT` | `20` | `429`s from one host within a minute before the whole host is left alone |
| `FCM_ORIGIN`, `APNS_ORIGIN` | the real services | Point every push at another server, for tests |

## License

Licensed under the GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
