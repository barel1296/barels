import { telegramContribution } from './integrations/telegram/bot.js';
import { agentsContribution } from './modules/agents/admin.js';
import { analyticsContribution } from './modules/analytics/api.js';
import { conversationContribution } from './modules/conversation/admin.js';
import { monetizationContribution } from './modules/monetization/telegram-sales.js';
import { ingestInstagramComments } from './integrations/instagram/comments.js';
import type { Contribution } from './registry.js';

const instagramContribution: Contribution = (svc, r) => {
  // Only when Instagram is enabled: nothing calls Meta otherwise.
  if (!svc.config.publishing.adapters.includes('instagram')) return;
  r.periodic.push({ name: 'instagram.comments_ingest', intervalSeconds: 600, run: () => ingestInstagramComments(svc) });
};

/** Feature modules that contribute job handlers, event subscriptions, periodic tasks and worker loops. */
export const contributions: Contribution[] = [conversationContribution, telegramContribution, monetizationContribution, instagramContribution, agentsContribution, analyticsContribution];
