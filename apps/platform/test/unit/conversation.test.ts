import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkOutbound, classifyInbound, cleanReply, DEFAULT_CRISIS_MESSAGE } from '../../src/modules/conversation/guard.js';
import { isSensitiveStatement } from '../../src/modules/conversation/memory.js';
import { PLATFORM_RULES, buildMessages, buildSystemPrompt } from '../../src/modules/conversation/prompt.js';

describe('conversation input guard', () => {
  const cases: [string, string[]][] = [
    ['I want to kill myself', ['self_harm_risk']],
    ["sometimes I feel like I'm better off dead", ['self_harm_risk']],
    ["i'm 15", ['minor_signal']],
    ['I’m 16 years old', ['minor_signal']],
    ['im 14 lol', ['minor_signal']],
    ['I am 9', ['minor_signal']],
    ['in 8th grade rn', ['minor_signal']],
    ["I'm 15 minutes late", []],
    ["I'm 5 feet tall", []],
    ['I am 7 days into my diet', []],
    ["I'm 25", []],
    ['send nudes', ['explicit_request']],
    ['I want a refund', ['refund_request']],
    ['you charged me twice!', ['payment_dispute']],
    ['can I talk to a human please', ['human_requested']],
    ['what a lovely sunset photo', []],
  ];
  for (const [text, expected] of cases) {
    it(`classifies "${text}"`, () => assert.deepEqual(classifyInbound(text), expected));
  }
});

describe('conversation output guard', () => {
  it('blocks claims of being human, contact details, links, off-platform payment and meetings', () => {
    assert.deepEqual(checkOutbound("I'm a real person, promise"), ['claims_human']);
    assert.deepEqual(checkOutbound('I am not an AI'), ['claims_human']);
    assert.deepEqual(checkOutbound('find me at www.example.com'), ['contact_or_link']);
    assert.deepEqual(checkOutbound('call +1 555 123 4567'), ['contact_or_link']);
    assert.deepEqual(checkOutbound('just send it via paypal'), ['off_platform_payment']);
    assert.deepEqual(checkOutbound("let's meet up in person"), ['meeting']);
    assert.deepEqual(checkOutbound('   '), ['empty']);
    assert.deepEqual(checkOutbound('x'.repeat(1501)), ['too_long']);
    assert.deepEqual(checkOutbound("I'm an AI character, but I love talking about hiking!"), []);
  });

  it('cleans role prefixes and wrapping quotes', () => {
    assert.equal(cleanReply('Mia: "hey you!"', 'Mia'), 'hey you!');
    assert.equal(cleanReply('assistant: hello', 'Mia'), 'hello');
  });

  it('crisis text invents no phone numbers', () => {
    assert.doesNotMatch(DEFAULT_CRISIS_MESSAGE, /\d{3}/);
  });
});

describe('fan memory filter', () => {
  it('rejects special-category and identifying statements', () => {
    for (const s of ['Takes medication for anxiety', 'Is gay', 'Votes for the green party', 'Lives at 5 Main Street address', 'Is 16 years old', 'Goes to church on Sundays']) {
      assert.equal(isSensitiveStatement(s), true, s);
    }
    for (const s of ['Loves hiking in the Alps', 'Prefers cats to dogs', 'Plays the cello']) assert.equal(isSensitiveStatement(s), false, s);
  });
});

describe('persona prompt builder', () => {
  const persona = {
    displayName: 'Mia',
    disclosureShort: 'AI-generated virtual creator',
    disclosureLong: 'This account is an AI character.',
    languages: ['en', 'pt'],
    personality: { traits: ['curious', 'warm'] },
    writingStyle: { tone: 'playful' },
    biography: { home_city: 'Lisbon (fictional)' },
    conversationRules: { relationship_framing: 'friendly' },
    canonFacts: ['Has a cat named Figo'],
  };

  it('puts the non-overridable platform rules before persona configuration', () => {
    const p = buildSystemPrompt(persona, { displayName: 'Sam', language: 'pt-BR', memories: [{ category: 'interest', statement: 'Plays the cello' }], summary: null });
    assert.ok(p.indexOf('PLATFORM RULES') < p.indexOf('PERSONALITY'));
    for (const r of PLATFORM_RULES) assert.ok(p.includes(r));
    assert.match(p, /Has a cat named Figo/);
    assert.match(p, /Plays the cello/);
    assert.match(p, /language "pt"/);
  });

  it('maps history to chat roles and skips system messages', () => {
    const msgs = buildMessages(persona, { displayName: null, language: null, memories: [], summary: null }, [
      { author: 'system', body: 'disclosure' },
      { author: 'fan', body: 'hi' },
      { author: 'ai', body: 'hey!' },
      { author: 'operator', body: 'operator note sent to fan' },
    ]);
    assert.deepEqual(
      msgs.slice(1).map((m) => m.role),
      ['user', 'assistant', 'assistant'],
    );
    assert.match(msgs[0]!.content, /language "en"/);
  });
});
