import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import * as bcrypt from 'bcryptjs';

// @node-rs/argon2 Algorithm is an ambient const enum (unusable under
// isolatedModules); 2 === Algorithm.Argon2id.
const ARGON2ID = 2;

/**
 * Password hashing: argon2id (OWASP-recommended params) for all new hashes.
 * Legacy bcrypt hashes (early dev accounts) still verify and are transparently
 * upgraded on successful login.
 */
const ARGON_OPTS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTS);
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (stored.startsWith('$argon2')) {
    const valid = await argonVerify(stored, plain).catch(() => false);
    return { valid, needsRehash: false };
  }
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    const valid = await bcrypt.compare(plain, stored);
    return { valid, needsRehash: valid };
  }
  return { valid: false, needsRehash: false };
}
