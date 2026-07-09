// Links into the Nile block explorer (Tronscan). The renderer is sandboxed, so opening a URL
// goes through main via window.bridge.openExternal — never a bare <a href> that would navigate
// the app window. txLink() builds a clickable element for the transient toast/status lines.
const BASE = 'https://nile.tronscan.io'

const addressUrl = (addr) => `${BASE}/address/${addr}/transactions`
const txUrl = (hash) => `${BASE}/transaction/${hash}/overview`

export function openAddress(addr) {
  if (addr) window.bridge.openExternal(addressUrl(addr))
}
function openTx(hash) {
  if (hash) window.bridge.openExternal(txUrl(hash))
}

// A clickable "tx abcd012345…" link node, for splicing into a status/toast line. Inherits the
// line's colour (see .tx-link) so it fits whichever toast it lands in.
export function txLink(hash, label) {
  const a = document.createElement('a')
  a.className = 'tx-link'
  a.textContent = label || `tx ${hash.slice(0, 10)}…`
  a.title = 'View transaction on Tronscan'
  a.onclick = () => openTx(hash)
  return a
}
