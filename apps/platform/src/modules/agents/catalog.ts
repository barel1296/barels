/**
 * Action catalog (docs/06 §4.2): every action an agent may propose, its
 * rule-based risk, default autonomy level, the hard ceiling no policy can
 * exceed, and the payload schema the executor accepts.
 */
export type Risk = 'low' | 'medium' | 'high' | 'critical';
export const RISK_ORDER: Risk[] = ['low', 'medium', 'high', 'critical'];

export interface ActionSpec {
  risk: Risk;
  defaultLevel: number;
  /** Highest level any autonomy policy may set for this action. */
  maxLevel: number;
  /** Permission needed to approve it when it requires approval (L2). */
  approverRole: string;
  /** Allowed at any level (safety actions: hold, escalate, record QA). */
  alwaysAllowed?: boolean;
  payloadSchema: Record<string, unknown>;
}

const uuid = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
const FORMATS = ['ig_image', 'ig_carousel', 'ig_reel', 'tg_post', 'tg_album', 'tg_video'];

export const PLAN_PAYLOAD = {
  type: 'object',
  additionalProperties: false,
  required: ['period_start', 'period_end', 'strategy_notes', 'items'],
  properties: {
    period_start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    period_end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    strategy_notes: { type: 'string', minLength: 1, maxLength: 2000 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 21,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['planned_for', 'format', 'theme', 'brief'],
        properties: {
          planned_for: { type: 'string', minLength: 16, maxLength: 40 },
          format: { type: 'string', enum: FORMATS },
          theme: { type: 'string', minLength: 1, maxLength: 120 },
          brief: {
            type: 'object',
            additionalProperties: false,
            required: ['scene', 'mood', 'caption_idea'],
            properties: {
              scene: { type: 'string', minLength: 1, maxLength: 500 },
              outfit: { type: 'string', maxLength: 300 },
              location: { type: 'string', maxLength: 200 },
              mood: { type: 'string', minLength: 1, maxLength: 200 },
              shot: { type: 'string', maxLength: 300 },
              caption_idea: { type: 'string', minLength: 1, maxLength: 500 },
              cta: { type: 'string', maxLength: 200 },
            },
          },
        },
      },
    },
  },
};

export const CAPTION_PAYLOAD = {
  type: 'object',
  additionalProperties: false,
  required: ['content_item_id', 'caption', 'hashtags'],
  properties: {
    content_item_id: uuid,
    caption: { type: 'string', minLength: 1, maxLength: 2000 },
    hashtags: { type: 'array', maxItems: 30, items: { type: 'string', pattern: '^#?[\\p{L}\\p{N}_]{1,60}$' } },
    alt_text: { type: 'string', maxLength: 1000 },
  },
};

export const ACTIONS: Record<string, ActionSpec> = {
  'content_plan.propose': { risk: 'medium', defaultLevel: 2, maxLevel: 3, approverRole: 'content_manager', payloadSchema: PLAN_PAYLOAD },
  'caption.propose': { risk: 'low', defaultLevel: 3, maxLevel: 3, approverRole: 'content_manager', payloadSchema: CAPTION_PAYLOAD },
  'item.hold': {
    risk: 'low',
    defaultLevel: 4,
    maxLevel: 4,
    approverRole: 'compliance_officer',
    alwaysAllowed: true,
    payloadSchema: { type: 'object', additionalProperties: false, required: ['content_item_id', 'reason'], properties: { content_item_id: uuid, reason: { type: 'string', minLength: 1, maxLength: 1000 } } },
  },
  'comment.reply': {
    risk: 'medium',
    defaultLevel: 2,
    maxLevel: 3,
    approverRole: 'chat_operator',
    payloadSchema: { type: 'object', additionalProperties: false, required: ['comment_id', 'body'], properties: { comment_id: uuid, body: { type: 'string', minLength: 1, maxLength: 1000 } } },
  },
};

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(a), RISK_ORDER.indexOf(b))]!;
}

/** Risk overrides from docs/06 §4.3: high → at most L2, critical → at most L1. */
export function riskCeiling(r: Risk): number {
  return r === 'critical' ? 1 : r === 'high' ? 2 : 4;
}
