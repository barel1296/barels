import { telegramContribution } from './integrations/telegram/bot.js';
import { conversationContribution } from './modules/conversation/admin.js';
import type { Contribution } from './registry.js';

/** Feature modules that contribute job handlers, event subscriptions, periodic tasks and worker loops. */
export const contributions: Contribution[] = [conversationContribution, telegramContribution];
