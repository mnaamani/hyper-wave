// Worker IPC: one channel to the hyperwave Bare worker. Decodes/routes incoming
// messages by type (state / token / gallery) to registered listeners, and exposes
// typed command senders. The rest of the renderer talks to the worker only via this.
const bridge = window.bridge
const decoder = new TextDecoder('utf-8')
const HYPERWAVE = '/workers/hyperwave.js'

bridge.startWorker(HYPERWAVE)

const listeners = { state: [], token: [], gallery: [] }

bridge.onWorkerIPC(HYPERWAVE, (data) => {
  let msg
  try {
    msg = JSON.parse(decoder.decode(data))
  } catch {
    return
  }
  const hs = listeners[msg.type]
  if (hs) for (const h of hs) h(msg)
})
bridge.onWorkerStdout(HYPERWAVE, (d) => console.log('[hyperwave]', decoder.decode(d)))
bridge.onWorkerStderr(HYPERWAVE, (d) => console.error('[hyperwave]', decoder.decode(d)))

export function on(type, fn) {
  ;(listeners[type] || (listeners[type] = [])).push(fn)
}

function send(type, extra) {
  bridge.writeWorkerIPC(HYPERWAVE, JSON.stringify({ type, ...extra }))
}

export const startWave = () => send('start-wave')
export const joinWave = () => send('join-wave')
export const setCountry = (country) => send('set-country', { country })
export const stageSelfie = (selfie) => send('stage-selfie', { selfie })

export const appVersion = () => bridge.pkg().version
