import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

// The relay calls whatever URL a caller registered, from inside its own network
// (it runs next to other containers). Only public hosts qualify. The name is
// checked at registration and before each send; what it resolves to is checked
// at connect time, so DNS can't point it somewhere private later on.
//
// Web Push endpoints aren't limited to a list of known push services: browsers
// other than the big ones bring their own, and UnifiedPush distributors can be
// anywhere. PUSH_ALLOW_PRIVATE_ENDPOINTS names hosts an operator wants reachable
// anyway, such as an ntfy on their own network (comma-separated).

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa'];

function allowedPrivateHosts(): string[] {
  return (process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether connecting to this address leaves the relay's own networks. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function isPublicHostname(hostname: string): boolean {
  // URL keeps IPv6 hosts in brackets, and turns 2130706433 or 0x7f.1 into 127.0.0.1.
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (net.isIP(host)) return isPublicAddress(host);
  // A name without a dot is a container or a machine on this network.
  if (!host.includes('.')) return false;
  return !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function namedByOperator(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return allowedPrivateHosts().includes(host);
}

/** Whether the relay may call this URL: https, no credentials, a public host. */
export function isPublicEndpointUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return namedByOperator(url.hostname) || isPublicHostname(url.hostname);
}

type LookupOptions = dns.LookupOptions;
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, '', undefined);
      return;
    }
    const allowed = namedByOperator(hostname) ? addresses : addresses.filter((entry) => isPublicAddress(entry.address));
    if (allowed.length === 0) {
      const refused: NodeJS.ErrnoException = new Error(`${hostname} has no public address`);
      refused.code = 'ENDPOINT_NOT_PUBLIC';
      callback(refused, '', undefined);
      return;
    }
    if (options.all) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
}

/** For every request to a caller-chosen endpoint. */
export const publicOnlyAgent = new https.Agent({ keepAlive: true, lookup: publicLookup as never });

/** The reason a send was refused before anything left the relay, if the DNS lookup refused it. */
export function isNotPublicError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENDPOINT_NOT_PUBLIC';
}
