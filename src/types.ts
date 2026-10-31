// Records exist in one of four flavours: FCM (Android app), APNs (iOS app),
// Web Push (PWA in the browser) or UnifiedPush (Android app without Google
// Play services).
// Older on-disk records predate the discriminator and only have `fcmToken` -
// the loader fills in `kind: 'fcm'` for those.
export type SubscriptionRecord =
  | FcmSubscriptionRecord
  | ApnsSubscriptionRecord
  | WebSubscriptionRecord
  | UnifiedPushSubscriptionRecord;

interface BaseSubscriptionRecord {
  verificationCode: string | null;
  createdAt: number;
  lastPushAt: number | null;
  accountLabel?: string;
}

export interface FcmSubscriptionRecord extends BaseSubscriptionRecord {
  kind: 'fcm';
  fcmToken: string;
}

// The iOS app's APNs device token (hex). `environment` is the APNs host the
// token belongs to: TestFlight and App Store builds get production tokens,
// development builds and simulators sandbox ones.
export interface ApnsSubscriptionRecord extends BaseSubscriptionRecord {
  kind: 'apns';
  deviceToken: string;
  environment: 'production' | 'sandbox';
}

export interface WebSubscriptionRecord extends BaseSubscriptionRecord {
  kind: 'web';
  webPush: WebPushSubscription;
}

// UnifiedPush (https://unifiedpush.org): the distributor app on the device
// hands the client an RFC 8030 push endpoint. Connectors >= 3.0 also provide
// RFC 8291 Web Push keys, so delivery is the same encrypted Web Push as the
// PWA path; `keys: null` marks a legacy distributor that only understands a
// plain POST of the payload bytes.
export interface UnifiedPushSubscriptionRecord extends BaseSubscriptionRecord {
  kind: 'up';
  endpoint: string;
  keys: { p256dh: string; auth: string } | null;
}

// Mirror of the browser's PushSubscriptionJSON: https://w3c.github.io/push-api
export interface WebPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushVerification {
  '@type': 'PushVerification';
  pushSubscriptionId: string;
  verificationCode: string;
}

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<string, Record<string, string>>;
}

// draft-ietf-jmap-emailpush: sent instead of a StateChange when the client
// registered a per-account delivery filter on its PushSubscription. `emails`
// holds whatever Email properties the client asked for - Bulwark clients ask
// for ids only, and the relay forwards nothing but ids regardless.
export interface EmailPush {
  '@type': 'EmailPush';
  accountId: string;
  emails: Array<Record<string, unknown>>;
  state?: string;
}

export type JmapPushBody = PushVerification | StateChange | EmailPush;

// What the relay actually forwards to a device. `changed` is always present
// so clients that only understand the state-change ping keep working; `kind`
// and `emailIds` tell newer clients which messages were delivered.
export interface ForwardPayload {
  kind: 'jmap-state-change' | 'jmap-email-push';
  accountLabel: string;
  accountId: string;
  emailIds: string[];
  changed: Record<string, Record<string, string>>;
}
