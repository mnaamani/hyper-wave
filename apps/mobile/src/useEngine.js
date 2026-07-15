// useEngine — the mobile host for the shared engine. This is the RN counterpart of the desktop
// renderer's worker bridge: it boots the Bare worklet (hyperwave-engine's worklet/app.js,
// bundled by bare-pack) and speaks the SAME bare-rpc host<->UI seam (hyperwave-engine/lib/rpc)
// over the IPC stream that the desktop uses, exposing engine state + actions to React. The engine
// itself (the sweep, feed, WDK wallet) runs unchanged inside the worklet — this file never touches
// Hyperswarm/Corestore/WDK directly.
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { Worklet } from 'react-native-bare-kit';
import FramedStream from 'framed-stream';
import { createRpcClient } from 'hyperwave-engine/lib/rpc';
import bundle from '../bundles/app.bundle.mjs'; // produced by `npm run bundle` (bare-pack)

// Path the worklet's bare-fs writes to (Corestore + the wallet seed, see lib/wallet.js). NOTE:
// confirm the writable root for react-native-bare-kit's fs on device; production should inject
// the seed from expo-secure-store via config.seed instead of persisting a wallet.seed file.
const STORAGE_DIR = 'hyperwave';

export function useEngine(config = {}) {
  const clientRef = useRef(null);
  const [me, setMe] = useState(null);
  const [peers, setPeers] = useState(0);
  const [phase, setPhase] = useState('idle');
  const [gallery, setGallery] = useState([]);
  const [wallet, setWallet] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const worklet = new Worklet();
    worklet.start('/app.bundle', bundle);

    // Wrap the IPC duplex in the SAME framing the worklet uses (FramedStream(BareKit.IPC)), then
    // speak the bare-rpc host<->UI seam over it. `onEvent` receives every engine notification (and
    // request/response replies, e.g. tip-result — see createRpcClient's doc note).
    const pipe = new FramedStream(worklet.IPC);
    const client = createRpcClient({
      stream: pipe,
      onEvent: (msg) => {
        switch (msg.type) {
          case 'state':
            if (msg.me) {
              setMe(msg.me);
            }
            setPeers((msg.peers || []).length);
            break;
          case 'event':
            if (msg.event === 'started' || msg.event === 'announced') {
              setPhase('active');
            } else if (msg.event === 'completed' || msg.event === 'ended') {
              setPhase('idle');
            }
            break;
          case 'feed':
            // The engine is theme-agnostic: an entry carries an opaque `payload` this app
            // fills with a {image, caption} selfie, and a peer's cosmetic `tag` is its
            // country. Map back to the football shape at the boundary so the UI stays simple.
            setGallery(
              (msg.items || []).map((item) => ({
                ...item,
                image: item.payload?.image || '',
                caption: item.payload?.caption || '',
                country: item.tag
              }))
            );
            break;
          case 'wallet':
            if (msg.error) {
              setToast(`⚠ wallet: ${msg.error}`);
            } else {
              setWallet({ address: msg.address, trx: msg.trx });
            }
            break;
          case 'burn-result':
          case 'tip-result':
            setToast(
              msg.error
                ? `⚠ ${msg.error}`
                : `✓ ${msg.type} ${msg.hash ? msg.hash.slice(0, 8) : ''}`
            );
            break;
        }
      }
    });
    clientRef.current = client;

    // one-time init command: storageDir + config (topicId, bootstrap, seed). serveEngine's
    // onBootstrap builds the engine from it (worklet/app.js).
    client.call('init', { storageDir: STORAGE_DIR, config });

    // Cooperate with the OS lifecycle: react-native-bare-kit's Worklet.update() takes an RN
    // AppStateStatus and suspends/resumes the Bare runtime accordingly, so we don't burn battery
    // (or get killed ungracefully) running the swarm full-tilt in the background. (Sockets still
    // suspend in the background — fine for a foreground "watch the wave" app.)
    worklet.update(AppState.currentState);
    const appSub = AppState.addEventListener('change', (state) => {
      try {
        worklet.update(state);
      } catch {}
    });

    return () => {
      try {
        appSub.remove();
      } catch {}
      try {
        pipe.end();
      } catch {}
      try {
        worklet.terminate();
      } catch {}
    };
  }, []); // boot once on mount

  const call = useCallback((type, args) => {
    if (clientRef.current) {
      return clientRef.current.call(type, args);
    }
    return undefined;
  }, []);

  return {
    me,
    peers,
    phase,
    gallery,
    wallet,
    toast,
    startWave: () => call('start-wave'),
    joinWave: () => call('join-wave'),
    // the app's "country" is the engine's cosmetic peer `tag`; a selfie {image, caption}
    // is just the engine entry's opaque `payload`
    setCountry: (country) => call('set-tag', { tag: country }),
    stageSelfie: (selfie) =>
      call('stage-entry', { entry: { payload: selfie } }),
    // request/response: resolves with the tip-result (also delivered to onEvent's toast)
    tip: (to, amount) => call('tip', { to, amount })
  };
}
