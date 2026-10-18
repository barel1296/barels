import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../lib/canonical-json.js';

/**
 * Local content-addressed media store (docs/04): files are immutable and keyed by
 * sha256 per influencer, so writes are idempotent and re-ingestion is safe.
 */
export class ContentStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  keyFor(workspaceId: string, influencerId: string, sha256: string, ext: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('invalid sha256');
    if (!/^[a-z0-9]{2,5}$/.test(ext)) throw new Error('invalid extension');
    return `ws/${workspaceId}/inf/${influencerId}/media/${sha256.slice(0, 2)}/${sha256}.${ext}`;
  }

  pathOf(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('storage key escapes the content root');
    return full;
  }

  /** Writes bytes under key unless an identical file exists. Verifies the hash before and after. */
  async put(key: string, bytes: Buffer, sha256: string): Promise<void> {
    if (sha256Hex(bytes) !== sha256) throw new Error('content hash mismatch before write');
    const target = this.pathOf(key);
    try {
      const existing = await stat(target);
      if (existing.size === bytes.length && sha256Hex(await readFile(target)) === sha256) return;
    } catch {
      // not present
    }
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, target);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathOf(key));
  }
}
