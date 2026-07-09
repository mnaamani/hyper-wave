// flood.js — gossip dedup. One rule turns a one-hop broadcast into an epidemic across
// a partial mesh: relay each message id on FIRST SIGHT only. Run:  bare examples/flood.js
const { createFlood } = require('hyperwave-lib-core/lib/flood');

const flood = createFlood({ cap: 4096 });

// Simulate the same message arriving from three different neighbours.
const incoming = [
  { mid: 'msg-1', from: 'peerA' },
  { mid: 'msg-1', from: 'peerB' }, // duplicate of the first
  { mid: 'msg-2', from: 'peerC' },
  { mid: 'msg-1', from: 'peerD' } // duplicate again
];

for (const msg of incoming) {
  if (flood.firstSight(msg.mid)) {
    console.log('process + relay', msg.mid, '(from', msg.from + ')');
  } else {
    console.log('drop         ', msg.mid, '(from', msg.from + ') — already seen');
  }
}

console.log('distinct ids remembered:', flood.size); // 2
