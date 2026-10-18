/**
 * Prints the current sign-in code (TOTP) for the local demo owner, read from the demo's credentials
 * file, so the demo can be reviewed without an authenticator app. Only works where that file is
 * (the demo machine or dev container); it never leaves it.
 *
 *   npm run demo:totp -- [--out <the demo's --out directory>]
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { totpAt } from '../src/lib/totp.js';

const i = process.argv.indexOf('--out');
const out = resolve(i >= 0 ? process.argv[i + 1]! : (process.env.DEMO_OUT ?? join(tmpdir(), 'golden-demo')));
const creds = readFileSync(join(out, 'demo-credentials.txt'), 'utf8');
const secret = /^TOTP secret[^:]*:\s*(\S+)$/m.exec(creds)?.[1];
if (!secret) throw new Error(`no TOTP secret in ${join(out, 'demo-credentials.txt')}`);
const now = Math.floor(Date.now() / 1000);
console.log(`${totpAt(secret, now)}  (valid for ${30 - (now % 30)} more seconds)`);
