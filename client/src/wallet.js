import { setupWalletSelector } from '@near-wallet-selector/core'
import { setupModal } from '@near-wallet-selector/modal-ui'
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet'
import '@near-wallet-selector/modal-ui/styles.css'

// NEAR testnet only. Never point this at mainnet.
let selectorPromise
export const getSelector = () =>
  (selectorPromise ??= setupWalletSelector({
    network: 'testnet',
    modules: [setupMeteorWallet()]
  }))

export const accountOf = state =>
  state.accounts.find(a => a.active)?.accountId ?? state.accounts[0]?.accountId ?? null

/**
 * Opens the wallet picker. Access is limited to the read-only `get_record` method of the registry
 * contract, so a connected wallet cannot be used to change anything through this app.
 */
export async function openWalletModal(contractId) {
  const selector = await getSelector()
  setupModal(selector, { contractId, methodNames: ['get_record'] }).show()
}

export async function disconnectWallet() {
  const selector = await getSelector()
  const wallet = await selector.wallet()
  await wallet.signOut()
}

export async function callContract(contractId, methodName, args, deposit = '0') {
  const selector = await getSelector()
  const wallet = await selector.wallet()
  return wallet.signAndSendTransaction({
    receiverId: contractId,
    actions: [{ type: 'FunctionCall', params: { methodName, args, gas: '30000000000000', deposit } }]
  })
}

/**
 * "Sign in with NEAR": asks the wallet to sign a one-time message (NEP-413) that proves the user
 * controls the account. It sends no transaction and costs nothing. Returns { accountId, token }.
 */
export async function signInWithNear(apiBase) {
  const selector = await getSelector()
  const wallet = await selector.wallet()
  if (typeof wallet.signMessage !== 'function') throw new Error('This wallet cannot sign messages')

  const challenge = await (await fetch(`${apiBase}/api/auth/challenge`)).json()
  if (!challenge.nonce) throw new Error(challenge.error || 'Could not start sign-in')

  const signed = await wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: Buffer.from(challenge.nonce, 'base64')
  })
  if (!signed) throw new Error('Signing was cancelled, or the wallet needs to redirect')

  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      nonce: challenge.nonce
    })
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error || 'Sign-in failed')
  return body
}
