/**
 * Lightweight AES-256-GCM encryption for storing the DingTalk robot
 * clientSecret at rest. The key is read from env `DSH_DINGTALK_SECRET_KEY`
 * (fallback to a dev-only constant). Encrypted payloads are base64 with an
 * iv+tag prefix so each encryption is unique.
 * @module @deepseek-ai/dsh-dingtalk-host/src/cipher
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** Derive a 32-byte key from the configured secret (or the dev fallback). */
function key(): Buffer {
  const source = process.env.DSH_DINGTALK_SECRET_KEY ?? 'dsh-dingtalk-dev-key-do-not-use-in-prod'
  return createHash('sha256').update(source, 'utf8').digest()
}

/** Encrypt a plaintext; returns `iv:tag:data` base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

/** Decrypt an `iv:tag:data` base64 payload back to plaintext. */
export function decryptSecret(payload: string): string {
  const raw = Buffer.from(payload, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const data = raw.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/** Mask a secret for UI display (keep first 4 chars, else fixed placeholder). */
export function maskSecret(secret: string): string {
  if (secret === '') return ''
  return secret.length > 4 ? `${secret.slice(0, 4)}••••` : '••••'
}
