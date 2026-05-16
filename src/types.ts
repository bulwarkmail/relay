// Records exist in one of two flavours: FCM (mobile app) or Web Push (PWA in
// the browser). Older on-disk records predate the discriminator and only have
// `fcmToken` - the loader fills in `kind: 'fcm'` for those.
export type SubscriptionRecord =
  | FcmSubscriptionRecord
  | WebSubscriptionRecord;

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

export interface WebSubscriptionRecord extends BaseSubscriptionRecord {
  kind: 'web';
  webPush: WebPushSubscription;
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

export type JmapPushBody = PushVerification | StateChange;
