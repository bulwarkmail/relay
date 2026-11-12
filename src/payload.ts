import type { EmailPush, ForwardPayload, StateChange } from './types.js';

// Below what any transport carries: Web Push about 3990 bytes once encrypted,
// FCM 4000, APNs 4096 with its own wrapper around this.
const MAX_PAYLOAD_BYTES = 3000;
const MAX_LABEL_CHARS = 120;
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;
const DATA_TYPE = /^[A-Za-z]{1,64}$/;
// Stalwart's states are a few letters and digits, the legacy proxy's g<n>r<n>.
// Clients treat a state as opaque and fetch anyway, so one that isn't like these
// is left out and the ping goes without it.
const STATE = /^[A-Za-z0-9_-]{1,64}$/;

function isOversized(payload: ForwardPayload): boolean {
  return Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES;
}

// Only what JMAP says can be in there. Anyone who knows a subscription id can
// post here, and this goes on to the device as is. An account whose states were
// all left out stays, with nothing under it: it still has a change to announce.
function cleanChanged(changed: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!changed || typeof changed !== 'object') return out;
  for (const [account, types] of Object.entries(changed)) {
    if (!JMAP_ID.test(account) || !types || typeof types !== 'object') continue;
    const kept: Record<string, string> = {};
    let leftOut = false;
    for (const [type, state] of Object.entries(types)) {
      if (!DATA_TYPE.test(type) || typeof state !== 'string') continue;
      if (STATE.test(state)) kept[type] = state;
      else leftOut = true;
    }
    if (Object.keys(kept).length > 0 || leftOut) out[account] = kept;
  }
  return out;
}

const hasNewMail = (types: Record<string, string>) => 'EmailDelivery' in types;

// A push that won't fit is refused whole by the service, which loses the alert.
// Older ids go first (the worker names the last), then accounts without new mail.
function fit(payload: ForwardPayload): ForwardPayload {
  while (isOversized(payload) && payload.emailIds.length > 1) {
    payload.emailIds = payload.emailIds.slice(Math.ceil(payload.emailIds.length / 8));
  }
  if (!isOversized(payload)) return payload;
  const entries = Object.entries(payload.changed);
  const mail = entries.filter(([, types]) => hasNewMail(types));
  const rest = entries.filter(([, types]) => !hasNewMail(types));
  const kept = [...mail, ...rest];
  while (kept.length > 1) {
    payload.changed = Object.fromEntries(kept);
    if (!isOversized(payload)) return payload;
    kept.pop();
  }
  payload.changed = Object.fromEntries(kept);
  return payload;
}

// Turn a JMAP push body into the device payload. Deliberately content-blind:
// even if a client asked the server for subjects or senders in its EmailPush
// config, only the message ids leave the relay. The device fetches the rest
// over its own JMAP session.
export function toForwardPayload(
  body: StateChange | EmailPush,
  accountLabel: string | undefined,
): ForwardPayload {
  const label = (accountLabel ?? '').slice(0, MAX_LABEL_CHARS);
  if (body['@type'] === 'EmailPush') {
    const emailIds = (Array.isArray(body.emails) ? body.emails : [])
      .map((email) => (email && typeof email.id === 'string' && JMAP_ID.test(email.id) ? email.id : null))
      .filter((id): id is string => id !== null);
    const accountId = typeof body.accountId === 'string' && JMAP_ID.test(body.accountId) ? body.accountId : '';
    // Synthesize the legacy state-change shape so an older service worker or
    // app build that keys on `changed` still resolves the right account. The key
    // stays; a state that isn't one goes out empty, like a missing one.
    const changed: Record<string, Record<string, string>> = accountId
      ? { [accountId]: { EmailDelivery: typeof body.state === 'string' && STATE.test(body.state) ? body.state : '' } }
      : {};
    return fit({ kind: 'jmap-email-push', accountLabel: label, accountId, emailIds, changed });
  }
  const changed = cleanChanged(body.changed);
  // For a client that looks at one account only: the one with new mail. A batch
  // can hold several (the user's own and their groups'), so `changed` keeps them.
  const accounts = Object.entries(changed);
  const accountId = (accounts.find(([, types]) => hasNewMail(types)) ?? accounts[0])?.[0] ?? '';
  return fit({ kind: 'jmap-state-change', accountLabel: label, accountId, emailIds: [], changed });
}

export function isForwardableBody(body: unknown): body is StateChange | EmailPush {
  if (!body || typeof body !== 'object') return false;
  const type = (body as { '@type'?: unknown })['@type'];
  if (type === 'StateChange') return true;
  if (type === 'EmailPush') {
    const b = body as { accountId?: unknown; emails?: unknown };
    return typeof b.accountId === 'string' && Array.isArray(b.emails);
  }
  return false;
}
