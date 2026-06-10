import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERMISSIONS } from '@gros/shared';

/**
 * The permission catalog exists in two places by necessity (TS constant for
 * guards/UI, SQL seed for the database). This test keeps them in lockstep.
 */
describe('permission catalog sync', () => {
  it('migration 005 seeds exactly the shared PERMISSIONS keys', () => {
    const sql = readFileSync(
      join(__dirname, '..', '..', 'migrations', '005_seed_catalog.sql'),
      'utf8',
    );
    const insertBlock = sql.split('INSERT INTO permissions')[1]!.split(';')[0]!;
    const seeded = [...insertBlock.matchAll(/\('([\w:.-]+)',/g)].map((m) => m[1]!);
    const shared = Object.keys(PERMISSIONS).sort();
    expect(seeded.sort()).toEqual(shared);
  });
});
