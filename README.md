# bulwark-relay

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
| `DELETE` | `/api/push/register/:id` | Tear down mapping (logout / uninstall) |
| `GET` | `/api/push/verify/:id` | Poll for the JMAP `PushVerification` code |
| `POST` | `/api/push/jmap/:id` | JMAP server posts `PushVerification` or `StateChange` here |
| `GET` | `/api/health` | Liveness probe |

## What it stores

Per `subscriptionId`: the FCM token, an optional one-shot verification code,
an optional free-form `accountLabel` (max 120 chars), and timestamps. No user
identity, no server URL, no mail content. Subscriptions older than 30 days
without traffic are evicted automatically.

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
