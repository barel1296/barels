/**
 * Rule-based conversation guards (English baseline). They are deliberately
 * conservative and run on every message, with or without an LLM guard model.
 * Keyword rules cannot detect everything (e.g. minors reliably); they are one
 * layer beside human review, the escalation queue and the optional LLM guard.
 */
export type InputSignal = 'self_harm_risk' | 'minor_signal' | 'explicit_request' | 'payment_dispute' | 'refund_request' | 'threat_or_illegal' | 'human_requested';

const INPUT_RULES: { signal: InputSignal; re: RegExp }[] = [
  { signal: 'self_harm_risk', re: /\b(kill(ing)? myself|suicid(e|al)|end (it all|my life)|want to die|wanna die|hurt(ing)? myself|self[- ]?harm|cut(ting)? myself|no reason to live|better off dead)\b/i },
  {
    signal: 'minor_signal',
    re: /\b(i['’]?m|i\s+am)\s+(1[0-7]|[5-9])(\s*(yo|y\/o|years?\s*old))?\b(?!\s*(min|mins|minutes|hours?|hrs|days?|weeks?|months?|years?|yrs|times|feet|ft|foot|inches|km|kg|lbs?|cm|%|\$|k\b|am\b|pm\b|o'?clock))|\b(1[0-7]|[5-9])\s*(yo|y\/o|years?\s*old)\b|\b(middle school|junior high|[6-9]th grade|year [7-9]|my (mom|mum|dad) (won'?t|will not) let me)\b/i,
  },
  { signal: 'explicit_request', re: /\b(nudes?|naked|send (me )?(pics|photos) (of|without)|sex(ting|ual)?|porn|nsfw|onlyfans|explicit)\b/i },
  { signal: 'refund_request', re: /\b(refund|money back|chargeback)\b/i },
  { signal: 'payment_dispute', re: /\b(charged (me )?twice|didn'?t (get|receive) (my|the) (access|content|stars)|scam(med)?|stole my (money|stars)|paid but)\b/i },
  { signal: 'threat_or_illegal', re: /\b(i('?ll| will) (kill|hurt|find) you|bomb|shoot (up|you)|buy (drugs|weed|coke|guns?))\b/i },
  { signal: 'human_requested', re: /\b(talk|speak) to (a |an )?(human|real person|person|operator|manager|support)\b/i },
];

export function classifyInbound(text: string): InputSignal[] {
  const t = text.normalize('NFKC');
  return INPUT_RULES.filter((r) => r.re.test(t)).map((r) => r.signal);
}

export const SEVERITY: Record<InputSignal, { severity: 'low' | 'medium' | 'high' | 'critical'; stopAi: boolean; slaMinutes: number }> = {
  self_harm_risk: { severity: 'critical', stopAi: true, slaMinutes: 15 },
  minor_signal: { severity: 'high', stopAi: true, slaMinutes: 60 },
  threat_or_illegal: { severity: 'high', stopAi: true, slaMinutes: 60 },
  payment_dispute: { severity: 'medium', stopAi: false, slaMinutes: 240 },
  refund_request: { severity: 'medium', stopAi: false, slaMinutes: 240 },
  explicit_request: { severity: 'low', stopAi: false, slaMinutes: 1440 },
  human_requested: { severity: 'low', stopAi: false, slaMinutes: 1440 },
};

export type OutputViolation = 'claims_human' | 'sexual_content' | 'off_platform_payment' | 'contact_or_link' | 'meeting' | 'empty' | 'too_long';

const OUTPUT_RULES: { violation: OutputViolation; re: RegExp }[] = [
  { violation: 'claims_human', re: /\b(i('?| a)m|i am) (not (an? )?(ai|bot|robot|program)|(a )?(real|human|real person|real girl|real guy))\b|\bnot an ai\b/i },
  { violation: 'sexual_content', re: /\b(nude|naked|sex(y time|ual)|orgasm|porn|nsfw|explicit)\b/i },
  { violation: 'off_platform_payment', re: /\b(paypal|venmo|cash ?app|zelle|western union|bank transfer|iban|crypto|bitcoin|btc|usdt|wallet address|gift ?card)\b/i },
  { violation: 'contact_or_link', re: /(https?:\/\/|www\.|t\.me\/|@[a-z0-9_]{5,}|\+?\d[\d\s().-]{7,}\d)/i },
  { violation: 'meeting', re: /\b(meet (up|in person|irl)|my (home )?address|come over|visit me)\b/i },
];

export function checkOutbound(text: string, maxChars = 1500): OutputViolation[] {
  const t = text.trim();
  if (!t) return ['empty'];
  const v = OUTPUT_RULES.filter((r) => r.re.test(t)).map((r) => r.violation);
  if (t.length > maxChars) v.push('too_long');
  return v;
}

/** Strips model artefacts (role prefixes, surrounding quotes) from a reply. */
export function cleanReply(text: string, displayName: string): string {
  let t = text.trim();
  t = t.replace(new RegExp(`^(${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|assistant)\\s*:\\s*`, 'i'), '');
  if (/^".*"$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

/** Generic crisis message. Operators configure locale-specific resources in workspace settings; no numbers are invented here. */
export const DEFAULT_CRISIS_MESSAGE =
  "I'm really sorry you're feeling this way. I'm an AI and can't help in an emergency. If you are in danger or thinking about hurting yourself, please contact your local emergency number right now, or reach out to a crisis line or someone you trust. You don't have to go through this alone.";

export const MINOR_MESSAGE =
  "Thanks for telling me. This chat is only for adults (18+), so I can't continue it. Take care of yourself!";

export const HUMAN_REQUEST_MESSAGE = "I'm an AI character. I've let the team know you'd like to talk to a person; someone will look at this chat.";
