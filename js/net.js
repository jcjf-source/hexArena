// Peer-to-peer transport. PeerJS's free public broker only introduces the two
// browsers; after that game traffic flows directly over a WebRTC data channel.
// The library is loaded on demand so solo play never touches the network.

const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const ID_PREFIX = 'hexarena-v1-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_LEN = 5;

let loading = null;
function loadPeerJs() {
  if (window.Peer) return Promise.resolve(window.Peer);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('Networking library failed to start.')));
    s.onerror = () => { loading = null; reject(new Error('Could not load the networking library. Check your connection.')); };
    document.head.appendChild(s);
  });
  return loading;
}

export function makeCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

function peerError(err) {
  const map = {
    'peer-unavailable': 'No game found with that code.',
    'network': 'Could not reach the matchmaking server.',
    'server-error': 'The matchmaking server had an error. Try again.',
    'browser-incompatible': 'This browser does not support WebRTC.',
    'unavailable-id': 'That room code is already in use.',
  };
  return new Error(map[err?.type] || err?.message || 'Connection failed.');
}

// Opens a peer registered under the room code. Resolves once the broker accepts it.
export async function openHostPeer(code) {
  const Peer = await loadPeerJs();
  return new Promise((resolve, reject) => {
    const peer = new Peer(ID_PREFIX + code);
    const fail = (e) => { peer.destroy(); reject(Object.assign(peerError(e), { type: e?.type })); };
    peer.once('open', () => { peer.off('error', fail); resolve(peer); });
    peer.once('error', fail);
  });
}

// Connects to a host's room. Resolves with { peer, conn } once the channel is open.
export async function joinRoom(code, timeoutMs = 15000) {
  const Peer = await loadPeerJs();
  return new Promise((resolve, reject) => {
    const peer = new Peer();
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      peer.destroy();
      reject(e?.type ? peerError(e) : e instanceof Error ? e : peerError(e));
    };
    const timer = setTimeout(() => fail(new Error('Timed out connecting to the host. A firewall may be blocking direct connections.')), timeoutMs);
    peer.on('error', fail);
    peer.once('open', () => {
      const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
      conn.once('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ peer, conn });
      });
      conn.once('error', fail);
    });
  });
}
