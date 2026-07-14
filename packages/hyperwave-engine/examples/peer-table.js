// peer-table.js — the PeerTable is the live peer bookkeeping: ring seats (angle always
// derived from the id, never trusted from the wire) and direct-send channels (a direct
// disconnect drops seat + channel at once). Run:  bare examples/peer-table.js
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

// Channels: a connection stores its send fn (broadcast fans out over senderEntries).
table.onConnect(peerA, (str) => console.log('  → wire:', str));
for (const [id, send] of table.senderEntries()) {
  send(`{"kind":"heartbeat","id":"${id.slice(0, 8)}…"}`);
}
console.log('connected peers:', [...table.senderIds()].length);

// A direct disconnect is authoritative: seat + channel drop at once.
table.onDisconnect(peerA);
console.log('connected after disconnect:', [...table.senderIds()].length);
console.log('live ring now:', table.liveRing().length, 'seat(s)');
