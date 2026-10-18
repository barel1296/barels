// Golden Influencer admin dashboard. No framework, no third-party code, no
// remote resources: everything is served by the platform under a strict CSP.
// All text is inserted with textContent (never innerHTML), so data from fans,
// agents or platforms cannot inject markup.

const state = { session: null, csrf: null, influencers: [] };

// --------------------------------------------------------------------------
// DOM and API helpers
// --------------------------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function cookie(name) {
  return document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.body = body;
  }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = state.csrf ?? cookie('gi_csrf') ?? '';
  const res = await fetch(path, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && path !== '/v1/auth/login') {
    state.session = null;
    location.hash = '#/login';
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function act(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
    await render();
  } catch (err) {
    toast(err.code ? `${err.code}: ${err.message}` : err.message);
  }
}

const can = (p) => state.session?.permissions.includes(p) || state.session?.is_platform_admin;
const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : String(v));
const when = (v) => (v ? new Date(v).toLocaleString() : '—');
const day = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};
const badge = (text, tone) => h('span', { class: `badge ${tone ?? ''}` }, text);
const tone = (s) =>
  ({ critical: 'bad', high: 'bad', failed: 'bad', dead: 'bad', rejected: 'bad', major: 'warn', medium: 'warn', pending: 'warn', open: 'warn', awaiting_approval: 'warn', drafted: 'warn', pass: 'ok', approved: 'ok', succeeded: 'ok', sent: 'ok', active: 'ok', executed: 'ok', published: 'ok', resolved: 'ok' })[s];

function table(rows, columns, empty = 'Nothing here.') {
  if (!rows?.length) return h('p', { class: 'muted' }, empty);
  return h(
    'table',
    {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', {}, c.render ? c.render(r) : fmt(r[c.key])))))),
  );
}

function form(fields, submitLabel, onSubmit, cls = 'stack') {
  const f = h('form', { class: cls });
  for (const fd of fields) {
    let input;
    if (fd.type === 'select') input = h('select', { name: fd.name }, fd.options.map((o) => h('option', { value: o, selected: o === fd.value }, o)));
    else if (fd.type === 'textarea') input = h('textarea', { name: fd.name, required: fd.required, placeholder: fd.placeholder ?? '' }, fd.value ?? '');
    else input = h('input', { name: fd.name, type: fd.type ?? 'text', value: fd.value ?? '', required: fd.required, autocomplete: fd.autocomplete ?? 'off', inputmode: fd.inputmode, placeholder: fd.placeholder ?? '' });
    f.append(h('label', {}, fd.label, input));
  }
  f.append(h('button', { type: 'submit' }, submitLabel));
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f).entries());
    onSubmit(data);
  });
  return f;
}

function influencerPicker(current, onChange) {
  return h(
    'select',
    { onchange: (e) => onChange(e.target.value), 'aria-label': 'Influencer' },
    state.influencers.map((i) => h('option', { value: i.id, selected: i.id === current }, i.display_name)),
  );
}

// --------------------------------------------------------------------------
// Pages
// --------------------------------------------------------------------------
async function loginPage(view) {
  view.append(
    h(
      'div',
      { class: 'login panel' },
      h('h1', {}, 'Sign in'),
      h('p', { class: 'muted' }, 'Password and authenticator code are both required.'),
      form(
        [
          { name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' },
          { name: 'totp', label: 'Authenticator code', required: true, inputmode: 'numeric', autocomplete: 'one-time-code' },
        ],
        'Sign in',
        async (d) => {
          try {
            const r = await api('POST', '/v1/auth/login', d);
            state.csrf = r.csrf_token;
            await loadSession();
            location.hash = '#/';
          } catch (err) {
            toast(err.message);
          }
        },
      ),
    ),
  );
}

async function overviewPage(view) {
  view.append(h('h1', {}, 'Overview'));
  const from = day(-29);
  const to = day(0);
  const [ov, approvals, esc, alerts] = await Promise.all([
    can('analytics.read') ? api('GET', `/v1/analytics/overview?from=${from}&to=${to}`) : null,
    can('content.read') ? api('GET', '/v1/approvals') : [],
    can('conversation.read') ? api('GET', '/v1/escalations') : [],
    state.session.is_platform_admin ? api('GET', '/v1/ops/alerts') : [],
  ]);
  view.append(
    h(
      'div',
      { class: 'grid' },
      stat('Pending approvals', approvals.length),
      stat('Open escalations', esc.length),
      stat('Open alerts', alerts.length),
      ov && stat('Revenue (Stars, 30 d)', ov.totals.revenue_stars),
      ov && stat('AI share of replies', ov.totals.ai_message_share === null ? '—' : `${Math.round(ov.totals.ai_message_share * 100)}%`),
      ov && stat('New fans (30 d)', ov.totals.new_fans),
    ),
  );
  if (ov) {
    view.append(h('h2', {}, `Influencers (${from} – ${to})`));
    view.append(
      h(
        'div',
        { class: 'panel' },
        table(ov.influencers, [
          { label: 'Influencer', render: (r) => h('a', { href: `#/influencer/${r.influencer_id}` }, r.display_name) },
          { label: 'Status', render: (r) => badge(r.status, tone(r.status)) },
          { label: 'Revenue ★', key: 'revenue_stars' },
          { label: 'Refunds ★', key: 'refunds_stars' },
          { label: 'Subscribers', key: 'active_subscribers' },
          { label: 'IG followers', key: 'ig_followers' },
          { label: 'Messages in', key: 'messages_inbound' },
          { label: 'AI / human', render: (r) => `${r.messages_ai} / ${r.messages_human}` },
          { label: 'Est. cost $', render: (r) => fmt(r.variable_cost_usd + r.fixed_cost_usd) },
        ]),
        h('p', { class: 'muted' }, ov.note),
      ),
    );
  }
  if (alerts.length) {
    view.append(h('h2', {}, 'Alerts'), h('div', { class: 'panel' }, alertsTable(alerts)));
  }
}

function stat(k, v) {
  return h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt(v)), h('div', { class: 'k' }, k));
}

async function influencersPage(view) {
  view.append(h('h1', {}, 'Influencers'));
  view.append(
    h(
      'div',
      { class: 'panel' },
      table(state.influencers, [
        { label: 'Name', render: (r) => h('a', { href: `#/influencer/${r.id}` }, r.display_name) },
        { label: 'Slug', key: 'slug' },
        { label: 'Status', render: (r) => badge(r.status, tone(r.status)) },
        { label: 'Disclosure', key: 'ai_disclosure_short' },
        { label: 'Time zone', key: 'timezone' },
      ]),
    ),
  );
}

async function influencerPage(view, id) {
  const [inf, channels, switches] = await Promise.all([api('GET', `/v1/influencers/${id}`), api('GET', `/v1/influencers/${id}/channels`), api('GET', '/v1/kill-switches').catch(() => [])]);
  view.append(h('h1', {}, inf.display_name, ' ', badge(inf.status, tone(inf.status))));
  view.append(h('p', { class: 'muted' }, inf.ai_disclosure_long));
  const rt = inf.runtime_config ?? inf.runtime ?? {};
  if (can('influencer.update')) {
    view.append(h('h2', {}, 'Runtime configuration'));
    view.append(
      h(
        'div',
        { class: 'panel' },
        form(
          [
            { name: 'free_replies_per_day', label: 'Free AI replies per fan per day', type: 'number', value: rt.free_replies_per_day ?? 0 },
            { name: 'premium_replies_per_day', label: 'Premium replies per day', type: 'number', value: rt.premium_replies_per_day ?? 0 },
            { name: 'default_conversation_mode', label: 'New conversations', type: 'select', options: ['ai_draft', 'ai_auto', 'human'], value: rt.default_conversation_mode ?? 'ai_draft' },
            { name: 'memory_enabled', label: 'Fan memory', type: 'select', options: ['true', 'false'], value: String(rt.memory_enabled ?? true) },
            { name: 'paused', label: 'Paused', type: 'select', options: ['false', 'true'], value: String(rt.paused ?? false) },
          ],
          'Save',
          (d) =>
            act(
              () =>
                api('PATCH', `/v1/influencers/${id}/runtime-config`, {
                  free_replies_per_day: Number(d.free_replies_per_day),
                  premium_replies_per_day: Number(d.premium_replies_per_day),
                  default_conversation_mode: d.default_conversation_mode,
                  memory_enabled: d.memory_enabled === 'true',
                  paused: d.paused === 'true',
                }),
              'Saved',
            ),
          'inline',
        ),
      ),
    );
  }
  if (can('killswitch.manage')) {
    view.append(h('h2', {}, 'Kill switches'));
    const on = (key) => switches.some((s) => s.key === `kill_switch.${key}` && s.influencer_id === id && s.value === true);
    view.append(
      h(
        'div',
        { class: 'panel row' },
        ['autonomy', 'conversations', 'publishing'].map((key) =>
          h(
            'button',
            { class: on(key) ? 'danger' : 'secondary', onclick: () => act(() => api('POST', '/v1/kill-switches', { key, influencer_id: id, enabled: !on(key) }), `${key} ${on(key) ? 'resumed' : 'stopped'}`) },
            `${on(key) ? 'Resume' : 'Stop'} ${key}`,
          ),
        ),
      ),
    );
  }
  view.append(h('h2', {}, 'Channels'));
  view.append(h('div', { class: 'panel' }, table(channels, [{ label: 'Kind', key: 'kind' }, { label: 'Username', key: 'username' }, { label: 'Title', key: 'title' }, { label: 'Status', render: (r) => badge(r.status, tone(r.status)) }, { label: 'Max rating', key: 'max_rating' }])));
  view.append(h('p', {}, h('a', { href: `#/calendar/${id}` }, 'Content calendar →'), ' ', h('a', { href: `#/money/${id}` }, 'Monetization →'), ' ', h('a', { href: `#/analytics/${id}` }, 'Analytics →')));
}

async function approvalsPage(view) {
  view.append(h('h1', {}, 'Approvals'));
  const rows = await api('GET', '/v1/approvals');
  view.append(
    h(
      'div',
      { class: 'panel' },
      table(
        rows,
        [
          { label: 'Request', render: (r) => h('a', { href: `#/approval/${r.id}` }, r.action_type) },
          { label: 'Subject', key: 'subject_type' },
          { label: 'Risk', render: (r) => badge(r.risk_level, tone(r.risk_level)) },
          { label: 'Requested by', render: (r) => `${r.requested_by_type}` },
          { label: 'Expires', render: (r) => when(r.expires_at) },
        ],
        'No pending approvals.',
      ),
    ),
  );
}

async function approvalPage(view, id) {
  const a = await api('GET', `/v1/approvals/${id}`);
  const snap = a.payload_snapshot;
  view.append(h('h1', {}, a.action_type, ' ', badge(a.status, tone(a.status))));
  if (a.qa_reviews?.length) {
    view.append(h('h2', {}, 'Automated QA'));
    view.append(
      h(
        'div',
        { class: 'panel' },
        a.qa_reviews.map((q) => h('div', {}, badge(q.verdict, tone(q.verdict)), ' ', q.reviewer_id, h('ul', {}, (q.issues ?? []).map((i) => h('li', {}, badge(i.severity, tone(i.severity)), ' ', i.message))))),
      ),
    );
  }
  if (a.subject_type === 'content_revision') {
    view.append(h('h2', {}, 'Content'));
    view.append(
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'thumbs' }, (snap.assets ?? []).map((as) => h('img', { src: `/v1/media-assets/${as.media_asset_id}/preview`, alt: `asset ${as.position}` }))),
        h('p', {}, snap.caption ?? h('span', { class: 'muted' }, '(no caption)')),
        h('p', { class: 'muted' }, (snap.hashtags ?? []).map((t) => `#${t}`).join(' ')),
        h('p', {}, badge('Disclosure'), ' ', snap.disclosure_text),
        (snap.assets ?? []).some((x) => x.engine_kind === 'contract_mock') && h('p', { class: 'notice' }, 'Contains contract-mock test output: it can be approved for testing but will never be published.'),
      ),
    );
  } else {
    view.append(h('h2', {}, 'Proposal'), h('div', { class: 'panel' }, h('p', {}, snap.rationale ?? ''), h('pre', {}, JSON.stringify(snap.payload ?? snap, null, 2))));
  }
  if (a.status === 'pending') {
    view.append(
      h(
        'div',
        { class: 'panel' },
        form(
          [
            { name: 'decision', label: 'Decision', type: 'select', options: ['approve', 'request_changes', 'reject'] },
            { name: 'comment', label: 'Comment (required unless approving)', type: 'textarea' },
          ],
          'Submit decision',
          (d) => act(() => api('POST', `/v1/approvals/${id}/decisions`, { decision: d.decision, payload_hash: a.payload_hash, ...(d.comment ? { comment: d.comment } : {}) }), 'Decision recorded'),
        ),
      ),
    );
  }
}

async function inboxPage(view) {
  view.append(h('h1', {}, 'Inbox'));
  const rows = await api('GET', '/v1/conversations?needs_attention=true');
  view.append(
    h(
      'div',
      { class: 'panel' },
      table(
        rows,
        [
          { label: 'Fan', render: (r) => h('a', { href: `#/conversation/${r.id}` }, r.fan_name ?? 'fan') },
          { label: 'Influencer', key: 'influencer_name' },
          { label: 'Mode', render: (r) => badge(r.mode) },
          { label: 'Drafts', key: 'pending_drafts' },
          { label: 'Escalations', render: (r) => (r.open_escalations ? badge(String(r.open_escalations), 'bad') : '0') },
          { label: 'Last message', render: (r) => when(r.last_inbound_at) },
        ],
        'Nothing needs attention.',
      ),
    ),
  );
}

async function conversationPage(view, id) {
  const c = await api('GET', `/v1/conversations/${id}`);
  view.append(h('h1', {}, c.fan.display_name ?? 'Fan', ' ', badge(c.mode), ' ', badge(c.fan.age_status, c.fan.age_status.includes('minor') ? 'bad' : '')));
  view.append(
    h(
      'div',
      { class: 'row' },
      ['ai_draft', 'ai_auto', 'human', 'paused'].map((m) => h('button', { class: m === c.mode ? '' : 'secondary', disabled: m === c.mode, onclick: () => act(() => api('PATCH', `/v1/conversations/${id}`, { mode: m }), `Mode: ${m}`) }, m)),
    ),
  );
  for (const e of c.escalations.filter((x) => x.status !== 'resolved')) {
    view.append(h('p', { class: 'notice' }, badge(e.severity, tone(e.severity)), ` Escalation: ${e.reason} · due ${when(e.sla_due_at)} `, h('a', { href: '#/escalations' }, 'handle')));
  }
  const thread = h('div', { class: 'panel' });
  for (const m of c.messages) {
    const box = h('div', { class: `msg ${m.direction} ${m.status === 'drafted' ? 'drafted' : ''}` }, h('div', { class: 'meta' }, `${m.author_type} · ${m.status} · ${when(m.created_at)}`), m.body ?? h('em', {}, '(no text)'));
    if (m.status === 'drafted' && can('conversation.reply')) {
      const edit = h('textarea', { 'aria-label': 'Edit draft' }, m.body ?? '');
      box.append(
        edit,
        h(
          'div',
          { class: 'row' },
          h('button', { onclick: () => act(() => api('POST', `/v1/conversations/${id}/drafts/${m.id}/approve`, edit.value !== m.body ? { body: edit.value } : {}), 'Sent') }, 'Approve & send'),
          h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/conversations/${id}/drafts/${m.id}/reject`), 'Draft rejected') }, 'Reject'),
        ),
      );
    }
    thread.append(box);
  }
  view.append(thread);
  if (can('conversation.reply')) {
    view.append(h('div', { class: 'panel' }, form([{ name: 'body', label: 'Send as operator (the AI disclosure stays in force)', type: 'textarea', required: true }], 'Send', (d) => act(() => api('POST', `/v1/conversations/${id}/messages`, d), 'Sent'))));
  }
}

async function escalationsPage(view) {
  view.append(h('h1', {}, 'Escalations'));
  const rows = await api('GET', '/v1/escalations');
  view.append(
    h(
      'div',
      { class: 'panel' },
      table(
        rows,
        [
          { label: 'Severity', render: (r) => badge(r.severity, tone(r.severity)) },
          { label: 'Reason', key: 'reason' },
          { label: 'Status', key: 'status' },
          { label: 'Due', render: (r) => h('span', { class: r.sla_breached ? 'badge bad' : '' }, when(r.sla_due_at)) },
          { label: 'Conversation', render: (r) => h('a', { href: `#/conversation/${r.conversation_id}` }, 'open') },
          {
            label: '',
            render: (r) =>
              h(
                'div',
                { class: 'row' },
                r.status === 'open' && h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/escalations/${r.id}/acknowledge`, {}), 'Acknowledged') }, 'Acknowledge'),
                h(
                  'button',
                  {
                    onclick: () => {
                      const note = prompt('How was it resolved?');
                      if (note) act(() => api('POST', `/v1/escalations/${r.id}/resolve`, { resolution: note }), 'Resolved');
                    },
                  },
                  'Resolve',
                ),
              ),
          },
        ],
        'No open escalations.',
      ),
    ),
  );
}

async function calendarPage(view, id) {
  id = id ?? state.influencers[0]?.id;
  view.append(h('h1', {}, 'Content calendar'), influencerPicker(id, (v) => (location.hash = `#/calendar/${v}`)));
  if (!id) return;
  const cal = await api('GET', `/v1/influencers/${id}/calendar?from=${day(-7)}&to=${day(21)}`);
  if (can('agent.run')) {
    view.append(
      h(
        'div',
        { class: 'panel row' },
        h(
          'button',
          {
            onclick: () => {
              const now = new Date();
              const monday = new Date(now);
              monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
              const start = monday.toISOString().slice(0, 10);
              const end = new Date(monday.getTime() + 6 * 86400000).toISOString().slice(0, 10);
              act(() => api('POST', `/v1/influencers/${id}/agent-tasks`, { agent_key: 'content_strategist', input: { period_start: start, period_end: end, posts: 7 } }), 'Planning task queued (plans need approval)');
            },
          },
          'Ask the strategist to plan next week',
        ),
      ),
    );
  }
  view.append(h('h2', {}, 'Plans'), h('div', { class: 'panel' }, table(cal.plans, [{ label: 'Period', render: (r) => `${r.period_start} – ${r.period_end}` }, { label: 'Status', render: (r) => badge(r.status, tone(r.status)) }, { label: 'By', render: (r) => `${r.created_by_type}:${r.created_by_id}` }, { label: 'Notes', key: 'strategy_notes' }])));
  view.append(
    h('h2', {}, 'Items'),
    h(
      'div',
      { class: 'panel' },
      table(cal.items, [
        { label: 'Planned', render: (r) => when(r.planned_for) },
        { label: 'Format', key: 'format' },
        { label: 'Theme / brief', render: (r) => r.brief?.theme ?? r.brief?.scene ?? '' },
        { label: 'Caption', key: 'caption' },
        { label: 'Status', render: (r) => badge(r.status, tone(r.status)) },
        { label: 'QA', render: (r) => (r.qa_verdict ? badge(r.qa_verdict, tone(r.qa_verdict)) : '—') },
        { label: 'Publications', render: (r) => r.publications.map((p) => `${p.kind}: ${p.status}`).join(', ') || '—' },
      ]),
    ),
  );
}

async function mediaPage(view, id) {
  id = id ?? state.influencers[0]?.id;
  view.append(h('h1', {}, 'Media library'), influencerPicker(id, (v) => (location.hash = `#/media/${v}`)));
  if (!id) return;
  const assets = await api('GET', `/v1/influencers/${id}/media-assets`);
  if (!assets.length) {
    view.append(h('p', { class: 'muted' }, 'No media yet. Generated images arrive here after automated checks.'));
    return;
  }
  view.append(
    h(
      'div',
      { class: 'panel thumbs' },
      assets.map((a) =>
        h(
          'figure',
          { class: 'tile' },
          a.kind === 'image' ? h('img', { src: `/v1/media-assets/${a.id}/preview`, alt: `${a.origin} ${a.kind}`, loading: 'lazy' }) : h('div', { class: 'muted' }, a.mime_type),
          h(
            'figcaption',
            { class: 'muted' },
            badge(a.status, a.status === 'valid' ? 'ok' : a.status === 'rejected' || a.status === 'quarantined' ? 'bad' : 'warn'),
            ' ',
            a.origin,
            a.engine_kind ? ` · ${a.engine_kind}` : '',
            a.engine_kind === 'contract_mock' ? h('div', {}, 'test output — never publishable') : null,
            a.status_reason ? h('div', {}, a.status_reason) : null,
          ),
        ),
      ),
    ),
  );
}

async function agentsPage(view) {
  view.append(h('h1', {}, 'Agents'));
  const [agents, proposals, policies] = await Promise.all([api('GET', '/v1/agents'), api('GET', '/v1/proposals'), api('GET', '/v1/autonomy-policies')]);
  const enabled = new Set(agents.definitions.filter((d) => d.status === 'active').map((d) => d.key));
  view.append(
    h(
      'div',
      { class: 'panel' },
      table(agents.available, [
        { label: 'Agent', key: 'title' },
        { label: 'Actions', render: (r) => r.actions.join(', ') },
        { label: 'Max level', render: (r) => `L${r.max_level}` },
        { label: 'Status', render: (r) => (enabled.has(r.key) ? badge('enabled', 'ok') : can('agent.manage') ? h('button', { onclick: () => act(() => api('POST', '/v1/agents/enable', { agent_keys: [r.key] }), 'Enabled') }, 'Enable') : 'off') },
      ]),
    ),
  );
  view.append(
    h('h2', {}, 'Proposals'),
    h(
      'div',
      { class: 'panel' },
      table(proposals, [
        { label: 'When', render: (r) => when(r.created_at) },
        { label: 'Agent', key: 'agent_key' },
        { label: 'Action', key: 'action_type' },
        { label: 'Level', render: (r) => `L${r.resolved_level ?? '?'}` },
        { label: 'Decision', key: 'policy_decision' },
        { label: 'Status', render: (r) => (r.approval_request_id && r.status === 'awaiting_approval' ? h('a', { href: `#/approval/${r.approval_request_id}` }, badge(r.status, 'warn')) : badge(r.status, tone(r.status))) },
        { label: 'Rationale', key: 'rationale' },
      ]),
    ),
  );
  view.append(
    h('h2', {}, 'Autonomy policies'),
    h(
      'div',
      { class: 'panel' },
      table(policies, [
        { label: 'Action', key: 'action_type' },
        { label: 'Agent', key: 'agent_key' },
        { label: 'Level', render: (r) => `L${r.level}` },
        { label: 'Status', render: (r) => badge(r.status, tone(r.status)) },
        { label: '', render: (r) => r.status === 'draft' && can('autonomy.approve') && h('button', { onclick: () => act(() => api('POST', `/v1/autonomy-policies/${r.id}/approve`), 'Policy active') }, 'Approve (second person)') },
      ]),
    ),
  );
}

async function moneyPage(view, id) {
  id = id ?? state.influencers[0]?.id;
  view.append(h('h1', {}, 'Monetization'), influencerPicker(id, (v) => (location.hash = `#/money/${v}`)));
  if (!id) return;
  const [products, payments, subs, refunds, recon] = await Promise.all([
    api('GET', `/v1/influencers/${id}/products`),
    can('payment.read') ? api('GET', `/v1/influencers/${id}/payments`) : [],
    can('payment.read') ? api('GET', `/v1/influencers/${id}/subscriptions`) : [],
    can('payment.read') ? api('GET', '/v1/refunds') : [],
    can('payment.read') ? api('GET', `/v1/influencers/${id}/reconciliation`) : null,
  ]);
  view.append(
    h('h2', {}, 'Products'),
    h(
      'div',
      { class: 'panel' },
      table(products, [
        { label: 'Name', key: 'name' },
        { label: 'Kind', key: 'kind' },
        { label: 'Price ★', key: 'price_stars' },
        { label: 'Status', render: (r) => badge(r.status, tone(r.status)) },
        {
          label: '',
          render: (r) =>
            h(
              'div',
              { class: 'row' },
              r.status === 'draft' && can('product.manage') && h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/products/${r.id}/submit`), 'Submitted') }, 'Submit'),
              r.status === 'pending_approval' && can('product.approve') && h('button', { onclick: () => act(() => api('POST', `/v1/products/${r.id}/approve`), 'Approved') }, 'Approve'),
              r.status === 'active' && can('product.manage') && h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/products/${r.id}/retire`), 'Retired') }, 'Retire'),
            ),
        },
      ]),
    ),
  );
  if (recon) {
    view.append(
      h('h2', {}, 'Reconciliation with Telegram'),
      h(
        'div',
        { class: 'panel' },
        h('div', { class: 'grid' }, stat('Net Stars (platform)', recon.net_stars_platform), stat('Net Stars (Telegram ledger)', recon.net_stars_ledger), stat('Unmatched ledger entries', recon.ledger.unmatched)),
        h('p', { class: 'muted' }, recon.note),
        h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/influencers/${id}/reconciliation/run`), 'Reconciliation finished') }, 'Reconcile now'),
      ),
    );
  }
  view.append(
    h('h2', {}, 'Payments'),
    h(
      'div',
      { class: 'panel' },
      table(payments, [
        { label: 'When', render: (r) => when(r.received_at) },
        { label: 'Product', key: 'product_name' },
        { label: 'Kind', key: 'kind' },
        { label: 'Stars', key: 'amount_stars' },
        { label: 'Refund', render: (r) => (r.refund_status ? badge(r.refund_status, tone(r.refund_status)) : can('refund.request') ? h('button', { class: 'secondary', onclick: () => { const reason = prompt('Reason for the refund request'); if (reason) act(() => api('POST', `/v1/payments/${r.id}/refunds`, { reason }), 'Refund requested (needs a second approver)'); } }, 'Request refund') : '—') },
      ]),
    ),
  );
  view.append(
    h('h2', {}, 'Refund requests'),
    h(
      'div',
      { class: 'panel' },
      table(
        refunds.filter((r) => r.influencer_id === id),
        [
          { label: 'Requested', render: (r) => when(r.created_at) },
          { label: 'Stars', key: 'amount_stars' },
          { label: 'Reason', key: 'reason' },
          { label: 'Status', render: (r) => badge(r.status, tone(r.status)) },
          {
            label: '',
            render: (r) =>
              r.status === 'pending_approval' &&
              can('refund.approve') &&
              h('div', { class: 'row' }, h('button', { onclick: () => act(() => api('POST', `/v1/refunds/${r.id}/approve`, {}), 'Refund approved') }, 'Approve'), h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/refunds/${r.id}/reject`, { note: 'rejected in dashboard' }), 'Refund rejected') }, 'Reject')),
          },
        ],
      ),
    ),
  );
  view.append(h('h2', {}, 'Subscriptions'), h('div', { class: 'panel' }, table(subs, [{ label: 'Product', key: 'product_name' }, { label: 'Status', render: (r) => badge(r.status, tone(r.status)) }, { label: 'Period end', render: (r) => when(r.current_period_end) }, { label: 'Renewals', key: 'renewal_count' }])));
}

async function analyticsPage(view, id) {
  id = id ?? state.influencers[0]?.id;
  view.append(h('h1', {}, 'Analytics'), influencerPicker(id, (v) => (location.hash = `#/analytics/${v}`)));
  if (!id) return;
  const [kpis, posts] = await Promise.all([api('GET', `/v1/influencers/${id}/kpis?from=${day(-29)}&to=${day(0)}`), api('GET', `/v1/influencers/${id}/post-performance`)]);
  view.append(h('h2', {}, 'Revenue (Stars per day)'), h('div', { class: 'panel' }, sparkline(kpis.map((k) => Number(k.revenue_stars)))));
  view.append(
    h('h2', {}, 'Daily KPIs'),
    h(
      'div',
      { class: 'panel' },
      table(
        [...kpis].reverse(),
        [
          { label: 'Day', key: 'kpi_date', render: (r) => String(r.kpi_date).slice(0, 10) },
          { label: 'Followers', key: 'ig_followers' },
          { label: 'Reach', key: 'ig_reach' },
          { label: 'New fans', key: 'new_fans' },
          { label: 'Msgs in', key: 'messages_inbound' },
          { label: 'Revenue ★', key: 'revenue_stars' },
          { label: 'Subscribers', key: 'active_subscribers' },
          { label: 'Est. margin $', render: (r) => fmt(r.est_contribution_margin === null ? null : Number(r.est_contribution_margin)) },
        ],
        'No KPIs yet (the rollup runs hourly).',
      ),
    ),
  );
  view.append(h('h2', {}, 'Posts'), h('div', { class: 'panel' }, table(posts, [{ label: 'Published', render: (r) => when(r.published_at) }, { label: 'Channel', key: 'channel_kind' }, { label: 'Theme', key: 'theme' }, { label: 'Metrics', render: (r) => Object.entries(r.metrics).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—' }, { label: '', render: (r) => r.permalink && h('a', { href: r.permalink, target: '_blank', rel: 'noopener noreferrer' }, 'open') }])));
}

function sparkline(values) {
  if (!values.length) return h('p', { class: 'muted' }, 'No data yet.');
  const max = Math.max(1, ...values);
  const w = 600;
  const hgt = 60;
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${hgt - (v / max) * hgt}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '60');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Revenue trend');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  svg.append(line);
  return svg;
}

function alertsTable(rows) {
  return table(rows, [
    { label: 'Severity', render: (r) => badge(r.severity, tone(r.severity === 'warning' ? 'medium' : r.severity)) },
    { label: 'Code', key: 'code' },
    { label: 'Message', key: 'message' },
    { label: 'Since', render: (r) => when(r.first_seen_at ?? r.created_at) },
    { label: '', render: (r) => h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/ops/alerts/${r.id}/ack`), 'Acknowledged') }, 'Ack'), h('button', { onclick: () => act(() => api('POST', `/v1/ops/alerts/${r.id}/resolve`), 'Resolved') }, 'Resolve')) },
  ]);
}

async function opsPage(view) {
  view.append(h('h1', {}, 'Operations'));
  const [health, alerts, dead, gpu, backups] = await Promise.all([api('GET', '/v1/ops/health'), api('GET', '/v1/ops/alerts'), api('GET', '/v1/ops/jobs?status=dead'), api('GET', '/v1/ops/gpu?minutes=60'), api('GET', '/v1/ops/backups')]);
  view.append(
    h('h2', {}, 'Health ', badge(health.status, health.status === 'ok' ? 'ok' : 'warn')),
    h('div', { class: 'panel' }, table(Object.entries(health.components ?? {}).map(([name, c]) => ({ name, ...c })), [{ label: 'Component', key: 'name' }, { label: 'Status', render: (r) => badge(r.status, r.status === 'ok' ? 'ok' : 'warn') }, { label: 'Detail', render: (r) => JSON.stringify(r.detail ?? r.details ?? {}) }])),
  );
  view.append(h('h2', {}, 'Alerts'), h('div', { class: 'panel' }, alertsTable(alerts)));
  view.append(h('h2', {}, 'Dead-lettered jobs'), h('div', { class: 'panel' }, table(dead.jobs, [{ label: 'Job', key: 'name' }, { label: 'Queue', key: 'queue' }, { label: 'Attempts', key: 'attempts' }, { label: 'Error', render: (r) => r.last_error?.message ?? '' }, { label: '', render: (r) => h('button', { class: 'secondary', onclick: () => act(() => api('POST', `/v1/ops/jobs/${r.id}/retry`), 'Requeued') }, 'Retry') }], 'No dead jobs.')));
  view.append(h('h2', {}, 'GPU (last hour)'), h('div', { class: 'panel' }, table(gpu.samples.slice(-20).reverse(), [{ label: 'Time', render: (r) => when(r.captured_at) }, { label: 'GPU', key: 'gpu_name' }, { label: 'Util %', key: 'util_pct' }, { label: 'VRAM MB', render: (r) => `${fmt(r.vram_used_mb)} / ${fmt(r.vram_total_mb)}` }, { label: '°C', key: 'temp_c' }, { label: 'W', key: 'power_w' }], gpu.monitor_enabled ? 'No samples yet.' : 'GPU monitoring is off (GPU_MONITOR_ENABLED).')));
  view.append(h('h2', {}, 'Backups'), h('div', { class: 'panel' }, table(backups, [{ label: 'When', render: (r) => when(r.finished_at ?? r.started_at) }, { label: 'Kind', key: 'kind' }, { label: 'Status', render: (r) => badge(r.status, tone(r.status)) }, { label: 'Location', key: 'location' }, { label: 'Error', key: 'error' }], 'No backups recorded yet.')));
}

async function usersPage(view) {
  view.append(h('h1', {}, 'Users'));
  const users = await api('GET', '/v1/admin/users');
  view.append(h('div', { class: 'panel' }, table(users, [{ label: 'Name', key: 'display_name' }, { label: 'Email', key: 'email' }, { label: 'Role', key: 'role' }, { label: 'MFA', render: (r) => (r.mfa_enrolled_at ? badge('enrolled', 'ok') : badge('pending', 'warn')) }, { label: 'Status', render: (r) => r.setup_pending ? badge('invited', 'warn') : r.user_status ?? r.membership_status }])));
  view.append(
    h('h2', {}, 'Invite'),
    h(
      'div',
      { class: 'panel' },
      form(
        [
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'display_name', label: 'Name', required: true },
          { name: 'role', label: 'Role', type: 'select', options: ['viewer', 'analyst', 'reviewer', 'chat_operator', 'content_manager', 'finance', 'compliance_officer', 'admin'] },
        ],
        'Invite',
        (d) =>
          act(async () => {
            const r = await api('POST', '/v1/admin/users', d);
            alert(`Give this one-time setup token to ${d.email} over a trusted channel (shown once):\n\n${r.setup_token}`);
          }, 'Invited'),
      ),
    ),
  );
}

// --------------------------------------------------------------------------
// Routing
// --------------------------------------------------------------------------
const NAV = [
  { hash: '#/', label: 'Overview' },
  { hash: '#/influencers', label: 'Influencers', perm: 'influencer.read' },
  { hash: '#/approvals', label: 'Approvals', perm: 'content.read' },
  { hash: '#/inbox', label: 'Inbox', perm: 'conversation.read' },
  { hash: '#/escalations', label: 'Escalations', perm: 'conversation.read' },
  { hash: '#/calendar', label: 'Calendar', perm: 'content.read' },
  { hash: '#/media', label: 'Media', perm: 'content.read' },
  { hash: '#/agents', label: 'Agents', perm: 'proposal.read' },
  { hash: '#/money', label: 'Money', perm: 'influencer.read' },
  { hash: '#/analytics', label: 'Analytics', perm: 'analytics.read' },
  { hash: '#/ops', label: 'Ops', admin: true },
  { hash: '#/users', label: 'Users', perm: 'user.manage' },
];

const ROUTES = [
  [/^#\/login$/, loginPage],
  [/^#\/?$/, overviewPage],
  [/^#\/influencers$/, influencersPage],
  [/^#\/influencer\/([0-9a-f-]{36})$/, influencerPage],
  [/^#\/approvals$/, approvalsPage],
  [/^#\/approval\/([0-9a-f-]{36})$/, approvalPage],
  [/^#\/inbox$/, inboxPage],
  [/^#\/conversation\/([0-9a-f-]{36})$/, conversationPage],
  [/^#\/escalations$/, escalationsPage],
  [/^#\/calendar(?:\/([0-9a-f-]{36}))?$/, calendarPage],
  [/^#\/media(?:\/([0-9a-f-]{36}))?$/, mediaPage],
  [/^#\/agents$/, agentsPage],
  [/^#\/money(?:\/([0-9a-f-]{36}))?$/, moneyPage],
  [/^#\/analytics(?:\/([0-9a-f-]{36}))?$/, analyticsPage],
  [/^#\/ops$/, opsPage],
  [/^#\/users$/, usersPage],
];

async function loadSession() {
  try {
    state.session = await api('GET', '/v1/auth/session');
    state.influencers = can('influencer.read') ? await api('GET', '/v1/influencers') : [];
  } catch {
    state.session = null;
  }
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren();
  document.getElementById('who').textContent = state.session ? `${state.session.user.display_name} · ${state.session.workspace.name}` : '';
  if (!state.session) return;
  for (const item of NAV) {
    if (item.perm && !can(item.perm)) continue;
    if (item.admin && !state.session.is_platform_admin) continue;
    const active = location.hash === item.hash || (item.hash !== '#/' && location.hash.startsWith(item.hash.replace(/s$/, '')));
    nav.append(h('a', { href: item.hash, class: active ? 'active' : '' }, item.label));
  }
  nav.append(
    h(
      'a',
      {
        href: '#/login',
        onclick: async (e) => {
          e.preventDefault();
          await api('POST', '/v1/auth/logout', {}).catch(() => undefined);
          state.session = null;
          location.hash = '#/login';
        },
      },
      'Sign out',
    ),
  );
}

async function render() {
  const view = document.getElementById('view');
  const hash = location.hash || '#/';
  if (!state.session && hash !== '#/login') {
    location.hash = '#/login';
    return;
  }
  renderNav();
  const fresh = h('div');
  const route = ROUTES.find(([re]) => re.test(hash));
  try {
    if (!route) fresh.append(h('p', {}, 'Not found.'));
    else await route[1](fresh, ...(hash.match(route[0]).slice(1).filter(Boolean)));
  } catch (err) {
    fresh.append(h('p', { class: 'notice' }, err.status === 403 ? 'You do not have permission to see this.' : `Could not load: ${err.message}`));
  }
  view.replaceChildren(fresh);
}

window.addEventListener('hashchange', () => void render());
await loadSession();
await render();
