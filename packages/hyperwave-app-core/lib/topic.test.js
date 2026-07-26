// The network → directory-topic policy (topic.js). Mainnet peers must land on a DIFFERENT topic
// from everyone else, so real-money and test-money peers never even discover each other.
//   bare lib/topic.test.js   (or `npm test`)
import test from 'brittle';
import { topicForNetwork } from './topic.js';

test('only mainnet moves off the base topic', (t) => {
  const baseTopic = 'hyperwave:demo:v1';
  t.is(
    topicForNetwork({ baseTopic, network: 'mainnet' }),
    'hyperwave:demo:v1:mainnet',
    'mainnet gets its own directory'
  );
  t.is(
    topicForNetwork({ baseTopic, network: 'testnet' }),
    baseTopic,
    'testnet stays on the base topic'
  );
  t.is(
    topicForNetwork({ baseTopic, network: 'unknown' }),
    baseTopic,
    'an unknown network stays on the base topic'
  );
  t.is(
    topicForNetwork({ baseTopic }),
    baseTopic,
    'wallet-less stays on the base topic'
  );
});
