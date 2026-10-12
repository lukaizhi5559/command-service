'use strict';
// lan-probe — detects macOS Local Network (TCC) denial for the spawning
// process's responsible-app identity. When an app lacks the Local Network
// grant, the kernel refuses sends to LAN peers and multicast groups with
// EHOSTUNREACH for every non-Apple binary it spawns — which is why
// `catt scan` reports "No devices found" while Apple tools (dns-sd/nc/curl)
// see the Chromecast fine. The default gateway itself is exempt, so the
// probe targets (a) a same-/24 neighbor of our own LAN address and
// (b) the mDNS multicast group. UDP send() is used: it returns instantly —
// EHOSTUNREACH when the kernel refuses to route, success otherwise (the
// peer need not exist; sendto succeeds once routed).

const dgram = require('node:dgram');
const os = require('node:os');

const DENIED_ERRNOS = new Set(['EHOSTUNREACH', 'EHOSTDOWN', 'EACCES', 'EPERM']);
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

function _lanNeighborIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info && info.family === 'IPv4' && !info.internal
          && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) {
        const parts = info.address.split('.');
        const last = Number(parts[3]);
        // Any other /24 neighbor works — the peer does not need to exist.
        parts[3] = String(last === 2 ? 3 : 2);
        const candidate = parts.join('.');
        if (candidate !== info.address) return candidate;
      }
    }
  }
  return null;
}

function _udpSend(target, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (code) => { try { sock.close(); } catch (_) {} resolve(code); };
    const timer = setTimeout(() => done('TIMEOUT'), timeoutMs);
    sock.once('error', (err) => {
      clearTimeout(timer);
      done(err && err.code ? err.code : 'ERROR');
    });
    sock.send(Buffer.from('lan-probe'), port, target, (err) => {
      clearTimeout(timer);
      done(err && err.code ? err.code : 'SENT');
    });
  });
}

/**
 * @returns {Promise<{ok: true|false|null, reason: string}>}
 *   ok=true  — LAN sends routed (Local Network policy allowed)
 *   ok=false — kernel refused routing (Local Network denial signature)
 *   ok=null  — inconclusive (non-macOS skipped, no LAN iface, timeouts)
 */
async function probeLocalNetwork({ timeoutMs = 1500 } = {}) {
  if (os.platform() !== 'darwin') return { ok: true, reason: 'non_darwin' };
  const targets = [[MDNS_GROUP, MDNS_PORT]];
  const neighbor = _lanNeighborIp();
  if (neighbor) targets.push([neighbor, 9]); // discard port — never replied to
  const results = await Promise.all(targets.map(([h, p]) => _udpSend(h, p, timeoutMs)));
  if (results.some((c) => DENIED_ERRNOS.has(c))) {
    return { ok: false, reason: `kernel_refused:${results.find((c) => DENIED_ERRNOS.has(c))}` };
  }
  if (results.every((c) => c === 'SENT')) return { ok: true, reason: 'reachable' };
  return { ok: null, reason: `inconclusive:${results.join(',')}` };
}

const LAN_BLOCK_GUIDANCE =
  'Open System Settings → Privacy & Security → Local Network, ' +
  'enable this app, then retry.';

// Errno/discovery phrases worth probing for — cheap regex prefilter; the
// live probe result is authoritative ("No devices found" is only flagged
// when the kernel actually refuses LAN sends).
const LAN_DENIAL_RE =
  /no route to host|ehostunreach|host unreachable|network is unreachable|no devices? found|operation not permitted/i;

module.exports = { probeLocalNetwork, LAN_DENIAL_RE, LAN_BLOCK_GUIDANCE };
