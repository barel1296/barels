import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function newUuid(): string {
  return randomUUID();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Local KMS abstraction: AES-256-GCM with a key derived from the master key.
 * Production swaps this for cloud-KMS envelope encryption behind the same
 * encrypt/decrypt interface (per-tenant DEKs).
 */
export function encryptSecret(plaintext: string, masterKey: string): Buffer {
  const key = scryptSync(masterKey, 'gros-credentials', 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decryptSecret(blob: Buffer, masterKey: string): string {
  const key = scryptSync(masterKey, 'gros-credentials', 32);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
