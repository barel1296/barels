import { z } from 'zod';

/** Semantic metrics layer contract (docs/04 §4.6, docs/08 §8.4). */

export const metricQueryRequestSchema = z.object({
  metricKey: z.string().min(1),
  grain: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  dimensions: z.array(z.string()).max(4).default([]),
  filters: z.record(z.union([z.string(), z.array(z.string())])).default({}),
  range: z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  compareTo: z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
});
export type MetricQueryRequest = z.infer<typeof metricQueryRequestSchema>;

export const metricQueryResponseSchema = z.object({
  metricKey: z.string(),
  metricVersion: z.number().int(),
  grain: z.string(),
  dimensions: z.array(z.string()),
  rows: z.array(z.record(z.unknown())),
  freshnessAt: z.string().nullable(),
  caveats: z.array(z.string()),
  sqlHash: z.string(),
});
export type MetricQueryResponse = z.infer<typeof metricQueryResponseSchema>;

export const decomposeRequestSchema = z.object({
  metricKey: z.string().min(1),
  windowA: z.object({ from: z.string(), to: z.string() }),
  windowB: z.object({ from: z.string(), to: z.string() }),
  dimensions: z.array(z.string()).min(1).max(3),
  filters: z.record(z.union([z.string(), z.array(z.string())])).default({}),
});
export type DecomposeRequest = z.infer<typeof decomposeRequestSchema>;
