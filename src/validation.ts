export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export function isValidFcmToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 64 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  );
}
