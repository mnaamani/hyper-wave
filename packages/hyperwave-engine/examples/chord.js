// chord.js — pure Chord pointer math over a 64-bit id ring (nodeId = top 8 bytes of
// the key). wave.js uses it to pick which peers to physically connect to so the logical
// ring's edges become real. All ids are hex; keyspace positions are BigInt mod 2^64.
// Run:  bare examples/chord.js
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const chord = require('hyperwave-engine/lib/chord');

const ids = Array.from({ length: 8 }, () => b4a.toString(crypto.keyPair().publicKey, 'hex'));
const myId = ids[0];
const short = (hex) => (hex ? hex.slice(0, 8) : hex);

// Neighbourhood — pass the full id list; it injects/dedupes myId internally.
console.log('successor-list:', chord.successors(ids, myId, 3).map(short));
console.log('predecessor:   ', short(chord.predecessor(ids, myId)));
console.log('fingers (O(log N)):', [...chord.fingers(ids, myId)].map(short));
console.log('pinTargets (succ+pred+fingers):', [...chord.pinTargets(ids, myId, 3)].map(short));

// Find the successor of an arbitrary keyspace position.
const target = (chord.nodeIdOfHex(myId) + 1n) % chord.RING;
console.log('findSuccessor(target):', short(chord.findSuccessor(ids, target)));

// One hop of the DISTRIBUTED lookup, using only what THIS node knows. Applied
// hop-to-hop (each node using its own `known`) this converges in O(log N) hops.
const succId = chord.successors(ids, myId, 3)[0] ?? null;
const known = [...chord.fingers(ids, myId), ...chord.successors(ids, myId, 3)];
const step = chord.findSuccessorStep({ me: myId, successor: succId, known, target });
console.log(
  'findSuccessorStep:',
  step.done
    ? { done: true, successor: short(step.successor) }
    : { done: false, next: short(step.next) }
);

// Stabilize: adopt my successor's predecessor if it slotted in between us.
console.log('stabilizeStep:', short(chord.stabilizeStep(myId, succId, ids[3])));
