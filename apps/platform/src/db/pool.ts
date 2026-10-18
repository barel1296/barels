import pg from 'pg';

// Return bigint/numeric as strings would leak into JSON; parse the small ones we use.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string, applicationName: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, application_name: applicationName, max });
  pool.on('error', (err) => {
    // Idle client errors (e.g. server restart) must not crash the process.
    console.error(`[db:${applicationName}] idle client error: ${err.message}`);
  });
  return pool;
}
