import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import ipaddr from 'ipaddr.js';

function publicAddress(address) {
  const ip = ipaddr.process(address);
  return ip.range() === 'unicast' && (ip.kind() === 'ipv4' || ip.match(ipaddr.parse('2000::'), 3));
}

export function publicUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password ||
      (isIP(host) ? !publicAddress(host) : !host.includes('.') || /\.(?:localhost|local|internal|home\.arpa|onion)$/.test(host))) {
    throw new Error('Only public HTTP and HTTPS addresses are supported');
  }
  return url;
}

export const publicNetwork = new Agent({
  connections: 2,
  connect: {
    lookup(host, options, callback) {
      // Supply only vetted addresses to the connection itself so DNS rebinding cannot bypass this check.
      lookup(host, { all: true, family: options.family, hints: options.hints }, (error, addresses) => {
        if (error) return callback(error);
        const allowed = addresses.filter(({ address }) => publicAddress(address));
        if (!allowed.length) return callback(new Error('The host does not resolve to a public address'));
        if (options.all) return callback(null, allowed);
        return callback(null, allowed[0].address, allowed[0].family);
      });
    },
  },
});
