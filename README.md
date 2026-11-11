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
| `GET` | `/api/health` | Liveness probe. Answers `{ ok: true }` and nothing else; how many records there are is in `/metrics` |
| `GET` | `/metrics` | Prometheus metrics, off by default. With `METRICS_TOKEN` set it wants `Authorization: Bearer <token>` and answers `401` without it; unset, it answers `404` |

Every register route answers `503` when the relay has no credentials for that
transport (except UnifiedPush, which needs none), `400` to a body it can't use,
`413` to one over 64 KB, `429` past the limit per client address and `507` when
the store is full (see [Limits](#limits)). A wrong method on a known path answers
`405`.

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
| 429, 408, 5xx, no answer within 8 s, network error, a name that resolves to no public address | Keeps the record | `503 { ok: false }` (`500` when FCM or APNs can't be reached at all) |
| Any other 4xx | Keeps the record, logs it | `200 { ok: false }` |

## How it treats the push services

- **Urgency**, for Web Push and UnifiedPush. New mail goes out at high urgency, or
  what the client asked for in its `emailPush` config. A ping with `Email` but no
  `EmailDelivery` goes at normal urgency, anything else at low. FCM and APNs always
  go at high priority.
- **Topic.** Web Push pings for new mail in one account carry an RFC 8030 `Topic`,
  so a device that was offline gets the last one, not all of them. `EmailPush` pushes
  don't, since each names other messages. UnifiedPush gets no Topic.
- **Burst limit.** Every subscription gets 10 pushes at once and one more every 20
  seconds, whatever the transport. Past that the relay answers `429` without calling
  the service, and the mail server's next attempt carries everything that piled up.
- **Backoff.** After a `429`, or any answer with `Retry-After`, the relay leaves that
  endpoint (or FCM or APNs token) alone for as long as the service says (60 seconds
  without a header, an hour at most), for every subscription on it. Registering the
  same endpoint again doesn't end it; a new endpoint starts afresh. Stalwart gives up
  after about two minutes, so a longer wait costs the alerts in between: the service
  asked for it, and each one is in the log. After `429`s for 20 different devices on
  one host within a minute it leaves the whole host alone, for two minutes at most.
  Only devices that have delivered a push before count, an endpoint counts once
  whatever fragment it is written with, and browsers and native apps count
  separately. Held pushes count in `relay_pushes_held_total`.

## Which endpoints it calls

Only `https` URLs without credentials, on public addresses. Names without a dot,
`.local`, `.internal` and the like are refused at registration. A stored record with
such a name is deleted instead of called. What a name resolves to is checked on every
connection, and counts as a temporary failure when it isn't public. Redirects are not
followed, and only the first 4 KB of an answer are read. To reach a distributor
on your own network, name it in `PUSH_ALLOW_PRIVATE_ENDPOINTS`.

## What it stores

Per `subscriptionId`: an FCM token (Android app), an APNs device token (iOS
app), a Web Push subscription (`endpoint` + `p256dh`/`auth` keys for the PWA), or
a UnifiedPush endpoint (Android app without Google Play services), the
verification code, an optional free-form `accountLabel` (max 120 chars), and
timestamps. No server URL, no mail content.

Nothing else a client sends is kept. The endpoint is stored as the URL parser
writes it and is refused (`400`) with a control character, tab or newline anywhere
in it. The keys are base64 or base64url of exactly 65 and 16 bytes, with no other
character. The label is printable text, the verification code 1 to 512 printable
ASCII characters.

The `accountLabel` is what the client sends, and Bulwark clients send the sign-in
name. It is stored here and copied into every push: encrypted to the device for Web
Push and UnifiedPush with keys, but readable to Google and Apple in FCM and APNs
payloads, and to the distributor on a UnifiedPush endpoint without keys.

Subscriptions with no push and no registration for 90 days are evicted. One that
never delivered a push and whose verification code no client picked up goes after
7 days without a registration; a real device registers again on every page load
and app start. Expired records go at every start and within the hour while the
relay runs.

The store is a snapshot, `subscriptions.json` in `PUSH_DATA_DIR`, and a journal
next to it, `subscriptions.journal`, which takes one line per change, on disk
before the change is answered. A request that changes nothing (the same
verification code again, a push within a minute of the last) writes nothing. Once
the journal is larger than the snapshot (and at least 1 MB), and when the relay
stops, the journal is folded into a new snapshot. That one is written atomically,
with the previous version kept as `subscriptions.json.bak`. A change that can't be
written is answered `500`, is not kept, and counts in
`relay_store_write_failures_total`. A snapshot that isn't valid is kept as
`subscriptions.json.corrupt-<time>` and logged as an error, and the relay starts
from the previous version. A file that can't be read at all (permissions, a bad
mount) stops the relay at startup with an error, so it can't overwrite the store.
A relay that starts on the `subscriptions.json` of an older relay takes every
record from it.

## Limits

Registration needs no credential, so the relay bounds how many records it keeps
and how fast one client address may add them. The defaults are far above what
Bulwark clients send: a browser registers once per account and page load, an app
once per account and start.

| Var | Default | What happens at the limit |
| --- | --- | --- |
| `PUSH_MAX_SUBSCRIPTIONS` | `50000` | Records the store takes. A new `subscriptionId` past it gets `507 {"error":"Relay is full"}` and nothing is stored. An id that is there can always register again, be pushed to, polled and deleted. A warning is logged at most once a minute |
| `PUSH_REGISTER_BURST` | `60` | Registrations one client address may make at once, on the four register routes together. Past it: `429` with `Retry-After` in seconds, and nothing is stored or changed |
| `PUSH_REGISTER_REFILL_MS` | `2000` | Time until that address may make one more |
| `TRUST_PROXY` | `0` | Number of proxies in front of the relay, see below |

Which address a registration counts for:

- With `TRUST_PROXY=0` the client address is the socket's.
- With `TRUST_PROXY=1` it is the last entry of `X-Forwarded-For`, the one the proxy
  appended; whatever the client wrote in front of it is ignored. With `2` it is the
  second from the end, and so on. A request without the header counts by its socket.
- A port after the address is ignored, and an IPv6 client counts by its /64. An entry
  that is no address at all counts for one budget shared by all such entries.
- When the address is a loopback or private one (the proxy's, with `TRUST_PROXY=0`
  behind a proxy) the relay can't tell its clients apart, and one budget for all of
  them would refuse real devices. Then only `PUSH_MAX_SUBSCRIPTIONS` applies, and the
  relay logs once, as a warning, that `TRUST_PROXY` should be set.

What the clients do with the answers: the webmail reports "Relay register failed:
429" (or `507`) and tries again on the next page load, or when an open tab comes to
the front 15 minutes later or more. The app reports "The push relay rejected the
registration" and tries again at its next start. Neither retries at once, and a
device that is registered already keeps getting its pushes. The mail server sees
no change.

## Behind a reverse proxy

`docker-compose.yml` publishes the port on `127.0.0.1` for a proxy on the same
host. Have the proxy send the client address and set `TRUST_PROXY=1`, and limit the
register routes there as well, as the first line of defence. For nginx:

```nginx
# http block: per client address, 30 a minute, bursts of 60, like the relay's own limit
limit_req_zone $binary_remote_addr zone=relay_register:10m rate=30r/m;

server {
    # ...
    location /api/push/register {
        limit_req zone=relay_register burst=60 nodelay;
        # 429 like the relay: the iOS app reads a 503 as "this relay has no APNs"
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

The prefix also covers `DELETE /api/push/register/:id`, which a client sends once
on logout.

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

The container runs read-only, without capabilities and with `no-new-privileges`:
the relay can write the data volume and `/tmp`, nothing else, and its own code
belongs to root. The data directory on the host has to be writable for the
container's `relay` user.

It joins the external `bulwark` network, through which Prometheus scrapes
`/metrics`. Every container on that network reaches port 3003 directly, without
the reverse proxy and its limits; requests from there come from a private address
and get no limit per client address (see [Limits](#limits)). Keep only trusted
containers on it.

## Environment

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3003` | HTTP listen port |
| `HOST` | `0.0.0.0` | |
| `PUSH_DATA_DIR` | `./data` | Where the store (`subscriptions.json` and its journal) and the FCM key live |
| `FCM_SERVICE_ACCOUNT_JSON` | unset | Either the full JSON inline or an absolute path; falls back to `$PUSH_DATA_DIR/fcm-service-account.json` |
| `VAPID_PUBLIC_KEY` | unset | Base64url-encoded P-256 public key for Web Push. Generate with `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | unset | Matching private key. Web Push is disabled if either VAPID var is missing |
| `VAPID_SUBJECT` | `mailto:postmaster@localhost` | `mailto:` or `https:` contact the push services can reach if the relay misbehaves (RFC 8292) |
| `APNS_KEY_ID`, `APNS_TEAM_ID` | unset | APNs signing key id and team id. APNs is disabled if either is missing |
| `APNS_KEY` | `$PUSH_DATA_DIR/apns-key.p8` | The `.p8` key, inline PEM or a path |
| `APNS_TOPIC` | `org.bulwarkmail.mobile` | Bundle id of the app |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | unset | Comma-separated hosts that may be called even though they aren't public, such as your own ntfy |
| `PUSH_FORWARD_TIMEOUT_MS` | `8000` | How long one attempt at a push service may take, start to finish. Keep it below the mail server's own timeout (Stalwart: 10 s), or the same push goes out twice |
| `PUSH_SUBSCRIPTION_BURST` | `10` | Pushes one subscription may get at once, any transport. Past it the mail server gets `429` |
| `PUSH_SUBSCRIPTION_REFILL_MS` | `20000` | Time until one more is allowed |
| `PUSH_HOST_THROTTLE_LIMIT` | `20` | Devices that delivered before getting a `429` from one host within a minute before the whole host is left alone |
| `PUSH_MAX_SUBSCRIPTIONS` | `50000` | Records the store takes; a new device past it gets `507`. See [Limits](#limits) |
| `PUSH_REGISTER_BURST` | `60` | Registrations one client address may make at once; past it `429` with `Retry-After` |
| `PUSH_REGISTER_REFILL_MS` | `2000` | Time until that address may make one more |
| `TRUST_PROXY` | `0` | Proxies in front of the relay. With `1` the client address is the last entry of `X-Forwarded-For` |
| `METRICS_TOKEN` | unset | Turns on `/metrics`. Prometheus sends it as a bearer token (`authorization: { credentials: <token> }` in the scrape config) |
| `METRICS_TOKEN_FILE` | unset | Path to a file holding the token instead, read on every scrape |
| `FCM_ORIGIN`, `APNS_ORIGIN` | the real services | Point every push at another server, for tests |

## License

Licensed under the GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
