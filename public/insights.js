import { h, clear, api, STATUS_LABEL } from './ui.js';

const KIND = { terminology: 'Terminology', fact: 'Approved fact', 'claim-substantiation': 'Unverified claim', style: 'Style', palette: 'Palette', contrast: 'Contrast', 'alt-text': 'Alt text' };

export async function renderInsights(root) {
  const i = await api('GET', '/api/insights');
  const max = Math.max(1, ...i.recurring.map((r) => r.occurrences));
  const tile = (n, l) => h('div', { class: 'card tile' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l));
  clear(root).append(
    h(
      'div',
      { class: 'stack' },
      h('div', null, h('h1', null, 'Insights'), h('p', { class: 'muted' }, 'Which rules keep coming up across saved revisions, and which have been fixed.')),
      h('div', { class: 'tiles' }, tile(i.submissions, 'Submissions'), tile(i.revisions, 'Revisions saved'), tile(i.statuses.in_review || 0, 'Waiting for review'), tile(i.staleApprovals, 'Approvals that need re-review')),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', null, 'Recurring issues')),
        i.recurring.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                { class: 'table' },
                h('caption', { class: 'sr-only' }, 'Recurring issues by rule'),
                h('thead', null, h('tr', null, ['Rule', 'Type', 'Seen', '', 'Submissions', 'Still open', 'Fixed'].map((t, i) => h('th', { scope: 'col', class: [2, 4, 5, 6].includes(i) ? 'num' : null }, t)))),
                h(
                  'tbody',
                  null,
                  i.recurring.map((r) => {
                    const bar = h('i');
                    bar.style.width = `${Math.round((r.occurrences / max) * 100)}%`;
                    return h('tr', null, h('td', null, h('span', { class: 'mono' }, r.ruleId), h('div', { class: 'small muted' }, r.title)), h('td', null, KIND[r.ruleKind] || r.ruleKind), h('td', { class: 'pill-count num' }, String(r.occurrences)), h('td', null, h('div', { class: 'bar', 'aria-hidden': 'true' }, bar)), h('td', { class: 'pill-count num' }, String(r.submissions)), h('td', { class: 'pill-count num' }, String(r.openNow)), h('td', { class: 'pill-count num' }, String(r.resolved)));
                  }),
                ),
              ),
            )
          : h('div', { class: 'empty' }, 'No issues recorded yet.'),
        h('div', { class: 'card-b' }, h('p', { class: 'muted small' }, i.note)),
      ),
    ),
  );
}
