// The HyperWave engine, host-agnostic. Everything the desktop worker (workers/hyperwave.js) and
// a mobile bare-kit worklet (worklet/app.js) share lives here: it wires the wave protocol
// (wave.js) + the WDK wallet (wallet.js) together and exposes a tiny message surface. Think of it
// like a kernel: the host (userspace) supplies { storageDir, config, emit } and feeds it decoded
// commands via exec() (a syscall); the engine raises events back via emit() (a signal). There's
// no Bare.argv / bare-env / IPC transport in here, so the same engine boots under Electron-spawned
// Bare and a react-native-bare-kit worklet unchanged. `deps` lets tests inject fake factories
// (so the engine is unit-testable without a real swarm or a wallet). Unit-tested in engine.test.js.
const path = require('bare-path');
const { createWave, parseBootstrap } = require('./wave');
const { payFee, confirmBurn, wireWallet } = require('./payments');

/**
 * Host-supplied engine configuration (only these fields are read).
 * @typedef {Object} EngineConfig
 * @property {string} [bootstrap] - Bootstrap peer(s) for the swarm DHT (parsed by parseBootstrap).
 * @property {string} [topicId] - Swarm topic id (isolates rings).
 * @property {boolean} [wallet] - Set `false` to run wallet-less (no burns/paid-gate/tips).
 * @property {string} [seed] - Injected wallet seed phrase (else derived/persisted by wallet.js).
 * @property {number} [accountIndex] - Initial BIP-44 account index for the wallet (default 0). A `set-account` command switches it live; each index is a distinct address from the same seed.
 * @property {Object} [walletOptions] - Opaque config forwarded to the payments factory. The default Tron wallet reads `{ network: 'mainnet' }` (opt into mainnet — testnet by default), `provider`, `fee` (participation fee; default 1), and (USDT) `usdtContract`.
 * @property {string} [swarmSeed] - Injected hex swarm-identity seed (else persisted at <storage>/swarm.seed).
 * @property {boolean} [autoSubscribe] - Set `false` for browse-then-pick: hold cores only for waves the host explicitly subscribes to (scaling.md Phase 2). Default true (auto-engage every announced wave).
 * @property {number} [minFee] - Local anti-sybil floor (default 0 = accept any): refuse to engage/join a paid wave whose initiator-set fee is below this. Only enforced when a wallet is present.
 * @property {number} [maxMessageSize] - Transport per-message byte cap (secret-stream patch), applied per connection on an engine-owned swarm only. Default 1 MB; 0 disables.
 */

/**
 * The engine handle returned by createEngine. Deliberately minimal: the only surface a host
 * needs across the IPC pipe is exec (host->engine) + emit (engine->host, supplied in options)
 * + close. The live wave protocol instance is intentionally NOT exposed — it can't cross the
 * serialization boundary and would leak transport-free internals into the public handle.
 * @typedef {Object} Engine
 * @property {(command: Object) => void} exec - Feed a decoded host->engine command (a syscall).
 * @property {() => Promise<void>} close - Tear down timers, wallet, and the wave protocol.
 */

/**
 * The HyperWave engine, host-agnostic: wires the wave protocol (wave.js) + the WDK wallet (wallet.js)
 * together and exposes a tiny message surface. The host supplies { storageDir, config, emit } and
 * feeds it decoded commands via exec(). `deps` lets tests inject fake factories.
 * @param {Object} options - Engine options.
 * @param {string} options.storageDir - Corestore/wallet storage directory for this instance.
 * @param {EngineConfig} [options.config] - Host-supplied engine configuration.
 * @param {(msg: Object) => void} options.emit - Callback the engine calls to raise messages to the host.
 * @param {(...args: any[]) => void} [options.log] - Logger callback.
 * @param {{createWave?: Function, createPayments?: Function}} [options.deps] - Injected factories. `deps.createPayments` is an `async (opts) => Wallet` returning any `Wallet` (wallet.js) subclass — the engine ships NO wallet, so a host supplies one (e.g. `hyperwave-wallet-cashu`/`hyperwave-wallet-tron`); with none, it runs wallet-less.
 * @param {Object} [options.swarm] - An existing Hyperswarm the host already owns; the engine shares it instead of creating one (correct when the app also uses Hyperswarm — one instance per process) and NEVER destroys it. A live object, so it is passed here, not in the JSON `config`.
 * @returns {Engine} The engine handle (`exec`, `close`).
 */
function createEngine({
  storageDir,
  config = {},
  emit,
  log = (...args) => console.log('[hyperwave]', ...args),
  deps = {},
  swarm
}) {
  const makeWave = deps.createWave || createWave;
  // The engine ships NO wallet — payments are opt-in. A host injects a Wallet factory via
  // `deps.createPayments` (e.g. `require('hyperwave-wallet-cashu').createCashuWallet` or
  // `require('hyperwave-wallet-tron').createPayments`). With none, the engine runs wallet-less
  // (join-attestation feed, no burns / paid-gate / tips) — the same as `config.wallet: false`.
  const makePayments = deps.createPayments;

  // Log the resolved storage dir up front — every host routes through here, so this is the one
  // line that always tells you which dir this engine (and its wallet.seed) is really using. A
  // relative arg is resolved against cwd (the same way bare-fs/Corestore resolve it downstream),
  // so the log shows the true absolute on-disk location, not the ambiguous relative string.
  const absStorageDir = path.resolve(storageDir);
  log('storage dir:', absStorageDir);

  const wave = makeWave({
    storageDir,
    bootstrap: config.bootstrap ? parseBootstrap(config.bootstrap) : undefined,
    topicId: config.topicId,
    // host-injected swarm identity seed (secure-seed-storage.md: the host owns the
    // secret store; the engine never persists an injected seed)
    swarmSeed: config.swarmSeed,
    // subscription policy (Phase 2): undefined → createWave's default (true)
    autoSubscribe: config.autoSubscribe,
    // local anti-sybil fee floor: refuse paid waves whose initiator-set fee is below this
    // (undefined → createWave's default 0 = accept any). Only enforced with a wallet.
    minFee: config.minFee,
    // transport per-message byte cap (secret-stream patch); undefined → createWave default (1 MB).
    // Only applied on an engine-owned swarm.
    maxMessageSize: config.maxMessageSize,
    // an existing host-owned Hyperswarm to share (undefined → the engine creates its own).
    // A live object, so it rides the top-level option, not the serializable `config`.
    swarm,
    // The wave emits typed messages ({type:'state'|'event'|'feed', …}) straight to the host sink —
    // one notifier end to end, no per-kind wrapping here.
    emit,
    log
  });
  log(
    'engine up, me=',
    wave.me.id.slice(0, 8),
    'angle=',
    wave.me.angle.toFixed(1)
  );

  // Self-custodial WDK wallet (Tron testnet TRX) for fee burns + feed tips. Async ESM init;
  // emits `wallet` {address, amount, unit} on ready + every 15s, and wires into the engine (address for
  // tips/attestations + the on-chain burn verifier = the paid-wave anti-spam gate). A host can
  // opt out with `config.wallet: false` — the
  // engine then runs wallet-less (join-attestation feed, no burns/paid-gate/tips).
  let payments = null;
  let tBalance = null;
  let pushBalance = null; // re-fetch the balance + send a `wallet` msg; set once the wallet is up
  // The active BIP-44 account index (multi-account: a distinct address per index from the same
  // seed). A `set-account` command switches it live; `activateSeq` guards against a slow switch
  // clobbering a newer one.
  let activeAccount = Number.isInteger(config.accountIndex)
    ? config.accountIndex
    : 0;
  let activateSeq = 0;
  // Live, mutable wallet-specific options forwarded to the factory (opaque to the engine —
  // network/provider/mint/fee/…). A `set-wallet-options` command merges into this and re-wires
  // the wallet, so a host can switch e.g. the Cashu mint without a currency-specific engine path.
  let walletOptions = { ...(config.walletOptions || {}) };

  // Bring up (or switch to) the wallet at `accountIndex`: dispose the previous wallet + stop its
  // balance poll, derive the new account from the SAME seed (a distinct BIP-44 address), wire it
  // into the wave protocol, and start a fresh balance poll. Called at startup and on `set-account`.
  async function activateWallet(accountIndex) {
    const seq = ++activateSeq;
    clearTimeout(tBalance);
    tBalance = null;
    const previous = payments;
    payments = null;
    if (previous) {
      try {
        previous.dispose();
      } catch {}
    }
    const pay = await makePayments({
      storageDir,
      seed: config.seed,
      log: (...args) => log('[wallet]', ...args),
      // Opaque, wallet-specific config forwarded to the factory (network / provider / mint / …).
      ...walletOptions,
      accountIndex // the live/active index wins over any static walletOptions.accountIndex
    });
    if (seq !== activateSeq) {
      try {
        pay.dispose();
      } catch {} // a newer switch superseded this one — drop it
      return;
    }
    payments = pay;
    activeAccount = accountIndex;
    wireWallet(wave, pay);
    // Echo the wallet next to its storage dir so "which dir → which wallet" is unambiguous.
    log(
      'wallet',
      pay.address,
      'account',
      accountIndex,
      'in dir:',
      absStorageDir
    );
    pushBalance = async () =>
      emit({
        type: 'wallet',
        walletType: pay.type, // the host can label / branch on the payment mechanism
        accountIndex, // which account (address) is active, for the host's picker
        // The active "account" for a mint-based wallet (Cashu) is its mint URL — surfaced so the
        // host's picker can show/persist it. Absent for chain wallets (no mintUrl getter).
        ...(pay.mintUrl ? { mint: pay.mintUrl } : {}),
        // The wallet's selectable mints (Cashu: the curated list + app extras, `{url,label,network}`)
        // — relayed so the host's picker renders the SAME list the wallet classifies against for the
        // cross-network filter (one source of truth, no drift). Absent for chain wallets.
        ...(pay.knownMints ? { mints: pay.knownMints } : {}),
        // The wallet's own settlement network (Cashu: 'testnet'/'mainnet' of its active mint) — so a
        // UI can filter to same-network waves and block cross-network tips. Updates on a mint switch.
        ...(pay.network ? { network: pay.network } : {}),
        ...(await pay
          .balances()
          .catch(() => ({ address: pay.address, amount: 0, unit: pay.unit })))
      });
    await pushBalance();
    // Self-rescheduling poll (CLAUDE.md Code Style: no setInterval): the next poll is armed only
    // after the previous finishes, so slow balance fetches never overlap. A switch (or dispose)
    // nulls tBalance, which also tells an in-flight tick not to re-arm.
    const balanceTick = async () => {
      await pushBalance();
      if (tBalance !== null) {
        tBalance = setTimeout(balanceTick, 15000);
      }
    };
    tBalance = setTimeout(balanceTick, 15000);
  }

  if (config.wallet !== false && makePayments) {
    activateWallet(activeAccount).catch((err) => {
      log('[wallet] init failed:', err.message);
      emit({ type: 'wallet', error: err.message }); // surface to the host (mobile has no console)
    });
  }

  // Switch the active wallet to another BIP-44 account (live re-wire, same seed). No-op wallet-less.
  function handleSetAccount(command) {
    if (config.wallet === false) {
      return;
    }
    const index = Number(command.index);
    if (!Number.isInteger(index) || index < 0) {
      emitBadCommand('set-account needs a non-negative integer index', command);
      return;
    }
    activateWallet(index).catch((err) =>
      emit({ type: 'wallet', error: err.message })
    );
  }

  // Derive the first `count` account addresses (offline) so the host can render an account picker.
  function handleListAccounts(command) {
    if (!payments) {
      return; // wallet not up yet (or wallet-less)
    }
    const count = Math.min(Math.max(Number(command.count) || 5, 1), 20);
    payments
      .accounts(count)
      .then((list) => emit({ type: 'accounts', list, active: activeAccount }))
      .catch((err) => emit({ type: 'accounts', error: err.message }));
  }

  // Merge new wallet-specific options and re-wire the wallet live (same seed). Currency-agnostic:
  // the host passes an opaque `walletOptions` (e.g. `{ mint }` for Cashu) and the engine re-builds
  // the wallet through the factory. No-op wallet-less.
  function handleSetWalletOptions(command) {
    if (config.wallet === false) {
      return;
    }
    const options = command.walletOptions;
    if (!options || typeof options !== 'object') {
      emitBadCommand(
        'set-wallet-options needs a walletOptions object',
        command
      );
      return;
    }
    walletOptions = { ...walletOptions, ...options };
    activateWallet(activeAccount).catch((err) =>
      emit({ type: 'wallet', error: err.message })
    );
  }

  // Fund the wallet (mint-based wallets only, e.g. Cashu): mint `amount` at the active mint and
  // return a `fund-result` — its `invoice` is a bolt11 the host surfaces (QR) when the mint isn't
  // an auto-paying test mint. A chain wallet has no `fund` (funded by a faucet) → clear error.
  async function handleFundWallet(command) {
    if (!payments || typeof payments.fund !== 'function') {
      emit({
        type: 'fund-result',
        id: command.id,
        error: 'funding not supported by this wallet'
      });
      return;
    }
    const amount = Number(command.amount);
    if (!(amount > 0)) {
      emit({ type: 'fund-result', id: command.id, error: 'invalid amount' });
      return;
    }
    try {
      // The invoice is ready before payment — emit it as a `pending` fund-result so the host shows
      // the QR immediately; fund() keeps polling + mints in the background, then we emit the final
      // result (minted) + refresh the balance.
      const result = await payments.fund(amount, {
        onInvoice: (invoice) =>
          emit({
            type: 'fund-result',
            id: command.id,
            pending: true,
            invoice,
            amount
          })
      });
      emit({ type: 'fund-result', id: command.id, ...result });
      pushBalance?.();
    } catch (err) {
      emit({ type: 'fund-result', id: command.id, error: err.message });
    }
  }

  // Redeem a bearer token received out-of-band (a Cashu tip carried in a wave-note). Mint-based
  // wallets implement `receive`; a chain wallet has none (a tip settles on-chain), so this is a
  // no-op there. The token is P2PK-locked to us, so redeeming someone else's is refused by the wallet.
  async function handleRedeem(command) {
    if (!payments || typeof payments.receive !== 'function') {
      return; // chain wallet: nothing to redeem (the transfer already settled)
    }
    try {
      const result = await payments.receive(command.token);
      emit({ type: 'redeem-result', id: command.id, ...result });
      pushBalance?.();
    } catch (err) {
      emit({ type: 'redeem-result', id: command.id, error: err.message });
    }
  }

  // Participation fee (wallet.js), burned to the black hole. The `burn-result` message carries a
  // `stage` so the UI never says "burned" prematurely:
  //   confirming — tx broadcast, awaiting on-chain confirmation (start only)
  //   burned     — confirmed on-chain (start) or broadcast (join, fire-and-forget)
  //   failed     — couldn't burn / never confirmed

  // Fail fast on a fee action from an unfunded wallet: it would broadcast a burn that never
  // confirms — the wave would stall (start) or no peer would seat the join — so refuse up
  // front with a clear message. Only when we could actually read the balance; a failed read
  // returns true and lets the burn try. `action` words the error ('start' / 'join').
  // Callers guard on `payments` so the wallet-less path stays fully synchronous.
  async function fundedForFee(reason, action) {
    const bal = await payments.balances().catch(() => null);
    if (bal && bal.amount < payments.fee) {
      emit({
        type: 'burn-result',
        stage: 'failed',
        reason,
        error: `wallet unfunded (${bal.amount}) — fund it to ${action}`
      });
      return false;
    }
    return true;
  }

  // Start: the wave is NOT announced until the initiator's burn is CONFIRMED on-chain, so
  // peers can verify it and won't join an unpaid (spam) wave.
  async function handleStartWave() {
    if (payments && !(await fundedForFee('start', 'start a wave'))) {
      return;
    }
    const waveId = wave.startWave();
    if (!waveId || !payments) {
      return; // busy / no wallet (unpaid path already announced)
    }
    try {
      const { hash, proof } = await payFee({
        wave,
        payments,
        waveId,
        reason: 'start'
      });
      emit({
        type: 'burn-result',
        stage: 'confirming',
        hash,
        waveId,
        reason: 'start'
      });
      if (await confirmBurn(payments, waveId, hash)) {
        emit({
          type: 'burn-result',
          stage: 'burned',
          hash,
          amount: payments.fee,
          waveId,
          reason: 'start'
        });
        wave.announcePaid(proof);
      } else {
        const error = 'burn not confirmed on-chain';
        emit({
          type: 'burn-result',
          stage: 'failed',
          error,
          waveId,
          reason: 'start'
        });
      }
    } catch (err) {
      emit({
        type: 'burn-result',
        stage: 'failed',
        error: err.message,
        waveId,
        reason: 'start'
      });
    }
  }

  // Join: wave.join() is gated on the start being verified (returns null otherwise), so we only
  // burn the join fee for a wave that's proven paid. The join burn is fire-and-forget (no on-chain
  // confirmation), so it's reported as burned on broadcast.
  async function handleJoin({ waveId: target } = {}) {
    if (payments && !(await fundedForFee('join', 'join the wave'))) {
      return;
    }
    const waveId = wave.join(target); // target waveId, or newest joinable lobby
    if (!waveId || !payments) {
      return;
    }
    try {
      const { hash, fee } = await payFee({
        wave,
        payments,
        waveId,
        reason: 'join'
      });
      emit({
        type: 'burn-result',
        stage: 'burned',
        hash,
        amount: fee, // the wave's announced fee (initiator-set), which may differ from my own
        waveId,
        reason: 'join'
      });
    } catch (err) {
      emit({
        type: 'burn-result',
        stage: 'failed',
        error: err.message,
        waveId,
        reason: 'join'
      });
    }
  }

  // Feed tip: a real testnet TRX transfer to the entry owner's wallet.
  // `id` is an opaque request-correlation token: a command may carry one, and every terminal
  // result echoes it back. The engine never interprets it — it just lets a request/response
  // transport (the bare-rpc IPC seam, lib/rpc.js) match this async tip-result to the exact tip
  // call that produced it, even with several tips in flight. Undefined when the caller omits it.
  async function handleTip({ to, amount, id }) {
    if (!payments) {
      emit({ type: 'tip-result', id, error: 'wallet not ready' });
      return;
    }
    try {
      const { hash } = await payments.send(to, amount);
      emit({ type: 'tip-result', id, hash, to, amount });
      pushBalance?.(); // tipping spends from our balance — reflect it
    } catch (err) {
      emit({ type: 'tip-result', id, error: err.message, to });
    }
  }

  // Plain wallet transfer: send `amount` (native units) to any address. `id` echoes as in handleTip.
  async function handleSend({ to, amount, id }) {
    if (!payments) {
      emit({ type: 'send-result', id, error: 'wallet not ready', to });
      return;
    }
    const amountNum = Number(amount);
    if (!to || !(amountNum > 0)) {
      emit({
        type: 'send-result',
        id,
        error: 'invalid recipient/amount',
        to
      });
      return;
    }
    const bal = await payments.balances().catch(() => null);
    if (bal && bal.amount < amountNum) {
      emit({
        type: 'send-result',
        id,
        error: `insufficient balance (${bal.amount} ${bal.unit})`,
        to
      });
      return;
    }
    try {
      const { hash } = await payments.send(to, amountNum);
      emit({ type: 'send-result', id, hash, to, amount: amountNum });
      pushBalance?.();
    } catch (err) {
      emit({ type: 'send-result', id, error: err.message, to });
    }
  }

  // On-chain transaction history for the wallet view — includes funds/tips RECEIVED (which the
  // app never sees as events), not just what we initiated. Read-only; [] without a wallet.
  // `id` echoes as in handleTip.
  async function handleTransactions({ id } = {}) {
    const list = payments ? await payments.transactions().catch(() => []) : [];
    emit({ type: 'transactions', id, list });
  }

  // Host -> engine commands, like a syscall: userspace (the host) asks the kernel (this engine)
  // to act. One handler per command `type` (a lookup table, not an if/else chain — CLAUDE.md
  // Code Style). Same message shapes the desktop renderer + the RN UI both speak. The reciprocal
  // engine -> host channel is `emit` (kernel raising events).
  const commandHandlers = {
    'start-wave': () => handleStartWave(),
    'join-wave': (command) => handleJoin(command),
    // Subscription layer (scaling.md Phase 2): browse-then-pick. subscribe holds a wave's feed
    // cores (+ receives its control gossip); unsubscribe frees them but stays aware. A host running
    // with autoSubscribe:false drives these to bound its core budget.
    'subscribe-wave': (command) => wave.subscribe(command.waveId),
    'unsubscribe-wave': (command) => wave.unsubscribe(command.waveId),
    'set-tag': (command) => wave.setTag(command.tag),
    'stage-entry': (command) => wave.stageEntry(command.entry),
    // Multi-account wallet: list the derivable accounts (offline) for a picker, and switch the
    // active one live (re-wire, same seed → a distinct BIP-44 address).
    'list-accounts': (command) => handleListAccounts(command),
    'set-account': (command) => handleSetAccount(command),
    // Mint-based wallet (Cashu): switch the active mint (live re-wire), mint funds, and redeem a
    // received bearer token (a tip). Currency-agnostic — no-ops / errors on a chain wallet.
    'set-wallet-options': (command) => handleSetWalletOptions(command),
    'fund-wallet': (command) => handleFundWallet(command),
    redeem: (command) => handleRedeem(command),
    // Broadcast an opaque note on a wave (roster-member announcement; a tip notification is the
    // app's first use). The engine stays theme-agnostic — `note` is host-owned JSON.
    note: (command) =>
      wave.note({ waveId: command.waveId, note: command.note }),
    // Directed (unicast) note to one peer — the private counterpart of `note`. The engine stays
    // theme-agnostic: `note` is opaque host JSON (the desktop's use is a Cashu tip token delivered
    // privately instead of flooded). Surfaced on the recipient as a `dm` event.
    dm: (command) =>
      wave.dm({
        waveId: command.waveId,
        to: command.to,
        note: command.note
      }),
    tip: (command) => handleTip(command),
    'send-trx': (command) => handleSend(command),
    'fetch-transactions': (command) => handleTransactions(command),
    'refresh-wallet': () => pushBalance?.() // manual balance re-check (after funding)
  };

  // Surface a malformed / unknown command to the host instead of silently dropping it. A typo'd
  // `type` used to fall through the if/else chain and no-op invisibly (a whole class of "why
  // didn't my command do anything?" bugs); now the host gets a { type:'error', scope:'command' }
  // it can log/toast. We echo only `command.type` (never the full command) so a big payload — a
  // staged entry's image — can't bloat the error message.
  function emitBadCommand(error, command) {
    const isObject = command && typeof command === 'object';
    const type = isObject ? command.type : command;
    // Echo the correlation id (if any) so a request/response transport awaiting this command's
    // result gets an error reply instead of hanging forever (see handleTip's `id` note).
    const id = isObject ? command.id : undefined;
    emit({ type: 'error', id, scope: 'command', error, command: type });
  }

  function exec(command) {
    if (
      !command ||
      typeof command !== 'object' ||
      typeof command.type !== 'string'
    ) {
      emitBadCommand('command must be an object with a string `type`', command);
      return;
    }
    const handler = commandHandlers[command.type];
    if (!handler) {
      emitBadCommand('unknown command type: ' + command.type, command);
      return;
    }
    // Handlers own their own async errors (they emit a *-result); this guard only catches a
    // synchronous throw (e.g. a bad stage-entry shape) so one bad command can't take down exec.
    try {
      handler(command);
    } catch (err) {
      emitBadCommand('command handler threw: ' + err.message, command);
    }
  }

  async function close() {
    if (tBalance) {
      clearTimeout(tBalance);
      tBalance = null; // also stops an in-flight balanceTick from re-arming
    }
    if (payments) {
      payments.dispose();
    }
    await wave.close();
  }

  return { exec, close };
}

module.exports = { createEngine };
