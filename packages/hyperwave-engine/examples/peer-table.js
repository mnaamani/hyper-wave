// peer-table.js — the PeerTable is the live peer bookkeeping: ring seats (angle always
// derived from the id, never trusted from the wire), direct-send channels, pinned ring
// edges (as a mirrorable diff), and churn cooldowns (a just-disconnected peer can't be
// resurrected as a ghost seat). Run:  bare examples/peer-table.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const { PeerTable } = require('hyperwave-engine/lib/peer-table');

const meId = b4a.toString(crypto.keyPair().publicKey, 'hex');
const peerA = b4a.toString(crypto.keyPair().publicKey, 'hex');
const peerB = b4a.toString(crypto.keyPair().publicKey, 'hex');

const table = new PeerTable({ meId, staleMs: 12000 });

// Seats: sightings via gossip/connections; the live ring is sorted clockwise by angle.
table.upsert(peerA, Date.now(), 'BR');
table.upsert(peerB, Date.now());
console.log(
  'live ring:',
  table
    .liveRing()
    .map((seat) => `${seat.id.slice(0, 8)}@${seat.angle.toFixed(1)}`)
);

// Channels: a connection stores its send fn; a disconnect is authoritative.
table.onConnect(peerA, (str) => console.log('  → wire:', str));
table.send(peerA)('{"kind":"pointers"}');
console.log('connected peers:', table.senderCount);

// Pins: hand the table the DESIRED targets; mirror the returned diff into the swarm.
const { added, removed } = table.updatePins(new Set([peerA, peerB]));
console.log('pin diff → join:', added.length, 'leave:', removed.length);
console.log('known (pinned ∪ connected):', table.knownIds().length);

// Churn: the disconnect drops seat+channel at once and arms the cooldown, so DHT
// retries / third-party pointer hints can't re-seed the ghost for staleMs.
const { solo, wasPinned } = table.onDisconnect(peerA);
console.log('disconnect → solo:', solo, 'wasPinned:', wasPinned);
console.log('cooling down (skip re-seed):', table.coolingDown(peerA));
console.log('live ring now:', table.liveRing().length, 'seat(s)');
