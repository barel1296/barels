import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Bytes } from './canonical-json.js';

/**
 * Envelope encryption (docs/09 §2): each secret gets a fresh 256-bit data key;
 * the secret is sealed with AES-256-GCM under the data key, and the data key is
 * sealed with AES-256-GCM under the local master key. `aad` binds the ciphertext
 * to its owning row so ciphertexts cannot be swapped between rows.
 */
export interface MasterKey {
  id: string;
  key: Buffer; // 32 bytes
}

export interface Envelope {
  ciphertext: Buffer; // ciphertext || 16-byte tag
  nonce: Buffer; // 12 bytes
  dataKeyCiphertext: Buffer; // nonce(12) || ciphertext(32) || tag(16)
  wrappingKeyId: string;
}

function seal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < 16) throw new Error('envelope: ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
}

export function encryptSecret(master: MasterKey, plaintext: string, aad: string): Envelope {
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  const aadBuf = Buffer.from(aad, 'utf8');
  const ciphertext = seal(dataKey, nonce, Buffer.from(plaintext, 'utf8'), aadBuf);
  const wrapNonce = randomBytes(12);
  const wrapped = seal(master.key, wrapNonce, dataKey, Buffer.from(`dek:${aad}`, 'utf8'));
  dataKey.fill(0);
  return { ciphertext, nonce, dataKeyCiphertext: Buffer.concat([wrapNonce, wrapped]), wrappingKeyId: master.id };
}

export function decryptSecret(masters: Map<string, MasterKey>, env: Envelope, aad: string): string {
  const master = masters.get(env.wrappingKeyId);
  if (!master) throw new Error(`envelope: master key ${env.wrappingKeyId} not loaded`);
  const wrapNonce = env.dataKeyCiphertext.subarray(0, 12);
  const dataKey = open(master.key, wrapNonce, env.dataKeyCiphertext.subarray(12), Buffer.from(`dek:${aad}`, 'utf8'));
  try {
    return open(dataKey, env.nonce, env.ciphertext, Buffer.from(aad, 'utf8')).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}

export function parseMasterKey(id: string, base64: string): MasterKey {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64-encoded');
  return { id, key };
}

/** Random token: `<prefix>_<base64url(32 bytes)>`. Only sha256(token) is stored. */
export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): Buffer {
  return sha256Bytes(token);
}

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Short-lived signed URL parameters for platform assets fetched by the engine (contract §3). */
export function signAssetUrl(secret: Buffer, assetId: string, expiresAtUnix: number): string {
  return createHmac('sha256', secret).update(`asset:${assetId}:${expiresAtUnix}`).digest('base64url');
}

export function verifyAssetSignature(secret: Buffer, assetId: string, expiresAtUnix: number, sig: string, nowUnix: number): boolean {
  if (!Number.isInteger(expiresAtUnix) || expiresAtUnix < nowUnix) return false;
  return safeEqual(signAssetUrl(secret, assetId, expiresAtUnix), sig);
}
