// useEngine — the mobile host for the shared engine. This is the RN counterpart of the desktop
// renderer's worker bridge: it boots the Bare worklet (hyperwave-lib-core's worklet/app.js,
// bundled by bare-pack), speaks the SAME JSON message protocol over the IPC stream, and exposes
// engine state + actions to React. The engine itself (wave race, gallery, WDK wallet) runs
// unchanged inside the worklet — this file never touches Hyperswarm/Autobase/WDK directly.
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { Worklet } from 'react-native-bare-kit';
import FramedStream from 'framed-stream';
import b4a from 'b4a';
import bundle from '../bundles/app.bundle.mjs'; // produced by `npm run bundle` (bare-pack)

// Path the worklet's bare-fs writes to (Corestore + the wallet seed, see lib/pay.js). NOTE:
// confirm the writable root for react-native-bare-kit's fs on device; production should inject
// the seed from expo-secure-store via config.seed instead of persisting a wallet.seed file.
const STORAGE_DIR = 'hyperwave';

export function useEngine(config = {}) {
  const pipeRef = useRef(null);
  const [me, setMe] = useState(null);
  const [peers, setPeers] = useState(0);
  const [phase, setPhase] = useState('idle');
  const [gallery, setGallery] = useState([]);
  const [wallet, setWallet] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const worklet = new Worklet();
    worklet.start('/app.bundle', bundle);

    // Wrap the IPC duplex in the SAME framing the worklet uses (FramedStream(BareKit.IPC)).
    const pipe = new FramedStream(worklet.IPC);
    pipeRef.current = pipe;

    pipe.on('data', (data) => {
      let msg;
      try {
        msg = JSON.parse(b4a.toString(data));
      } catch {
        return;
      }
      switch (msg.type) {
        case 'state':
          if (msg.me) setMe(msg.me);
          setPeers((msg.peers || []).length);
          break;
        case 'event':
          if (msg.event === 'started' || msg.event === 'announced') setPhase('active');
          else if (msg.event === 'completed' || msg.event === 'ended') setPhase('idle');
          break;
        case 'gallery':
          setGallery(msg.items || []);
          break;
        case 'wallet':
          if (msg.error) setToast(`⚠ wallet: ${msg.error}`);
          else setWallet({ address: msg.address, trx: msg.trx });
          break;
        case 'burn-result':
        case 'tip-result':
          setToast(
            msg.error ? `⚠ ${msg.error}` : `✓ ${msg.type} ${msg.hash ? msg.hash.slice(0, 8) : ''}`
          );
          break;
      }
    });

    // one-time init: storageDir + config (matchId, bootstrap, seed)
    pipe.write(JSON.stringify({ type: 'init', storageDir: STORAGE_DIR, config }));

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((msg) => {
    if (pipeRef.current) pipeRef.current.write(JSON.stringify(msg));
  }, []);

  return {
    me,
    peers,
    phase,
    gallery,
    wallet,
    toast,
    startWave: () => send({ type: 'start-wave' }),
    joinWave: () => send({ type: 'join-wave' }),
    setCountry: (country) => send({ type: 'set-country', country }),
    stageSelfie: (selfie) => send({ type: 'stage-selfie', selfie }),
    tip: (to, amount) => send({ type: 'tip', to, amount })
  };
}
