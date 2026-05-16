<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main//public/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main//public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" />
  <img src="https://raw.githubusercontent.com/bulwarkmail/webmail/refs/heads/main//public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" alt="Bulwark Webmail" width="280" />
</picture>

</div>

# Bulwark Relay

Push notification relay for Bulwark Webmail. Terminates JMAP `PushSubscription`
pushes from the user's mail server and forwards them to Firebase Cloud
Messaging so the mobile app wakes up and fetches new mail over its own JMAP
connection.

Designed so self-hosters don't need their own Firebase project, a single
hosted instance serves every Bulwark client that opts in. The relay never sees
mail content: only opaque FCM tokens, state-id hashes, and timing.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/push/register` | Mobile app stores its FCM token against an opaque `subscriptionId` |
| `POST` | `/api/push/register/web` | PWA stores a Web Push subscription (`endpoint` + `keys`) against an opaque `subscriptionId` |
| `DELETE` | `/api/push/register/:id` | Tear down mapping (logout / uninstall) |
| `GET` | `/api/push/verify/:id` | Poll for the JMAP `PushVerification` code |
| `POST` | `/api/push/jmap/:id` | JMAP server posts `PushVerification` or `StateChange` here — relay dispatches FCM or Web Push depending on the stored record |
| `GET` | `/api/push/vapid-public-key` | Returns the relay's VAPID public key so browsers can subscribe |
| `GET` | `/api/health` | Liveness probe |

## What it stores

Per `subscriptionId`: either an FCM token (mobile) or a Web Push subscription
(`endpoint` + `p256dh`/`auth` keys for the PWA), an optional one-shot
verification code, an optional free-form `accountLabel` (max 120 chars), and
timestamps. No user identity, no server URL, no mail content. Subscriptions
older than 90 days without traffic are evicted automatically.

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
| `FCM_SERVICE_ACCOUNT_JSON` | unset | Either the full JSON inline or an absolute path — falls back to `$PUSH_DATA_DIR/fcm-service-account.json` |
| `VAPID_PUBLIC_KEY` | unset | Base64url-encoded P-256 public key for Web Push. Generate with `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | unset | Matching private key. Web Push is disabled if either VAPID var is missing |
| `VAPID_SUBJECT` | `mailto:postmaster@localhost` | `mailto:` or `https:` contact the push services can reach if the relay misbehaves (RFC 8292) |

## License

Licensed under the GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
