import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z
    .string()
    .url()
    .default('postgres://gros:gros@localhost:5432/gros'),
  CLICKHOUSE_URL: z.string().url().default('http://localhost:8123'),
  CLICKHOUSE_DB: z.string().default('gros'),
  CLICKHOUSE_USER: z.string().default('gros'),
  CLICKHOUSE_PASSWORD: z.string().default('gros'),
  JWT_ACCESS_SECRET: z.string().min(8).default('dev-only-change-me'),
  JWT_REFRESH_SECRET: z.string().min(8).default('dev-only-change-me-too'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().default(1209600),
  SERVICE_TOKEN: z.string().min(8).default('dev-service-token-change-me'),
  CREDENTIALS_MASTER_KEY: z.string().default('dev-master-key-32-bytes-change!!'),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment: ${parsed.error.message}`);
    }
    if (
      parsed.data.NODE_ENV === 'production' &&
      (parsed.data.JWT_ACCESS_SECRET.startsWith('dev-only') ||
        parsed.data.JWT_REFRESH_SECRET.startsWith('dev-only') ||
        parsed.data.SERVICE_TOKEN.startsWith('dev-service') ||
        parsed.data.CREDENTIALS_MASTER_KEY.startsWith('dev-master'))
    ) {
      throw new Error('Refusing to start in production with dev secrets');
    }
    cached = parsed.data;
  }
  return cached;
}
