import { h, clear, api, routeStamp, fmtTime, statusChip, STATUS_LABEL } from './ui.js';

let filter = 'all';
const ORDER = { in_review: 0, approval_stale: 1, rejected: 2, draft: 3, approved: 4 };
const REASON = { content: 'copy', asset: 'image', imagetext: 'image text', guideline: 'guidelines' };

export async function renderQueue(root, go) {
  const stale = routeStamp();
  const { submissions } = await api('GET', '/api/submissions');
  if (stale()) return; // the person has gone elsewhere: do not paint over that page
  const paint = () => {
    const rows = submissions
      .filter((s) => filter === 'all' || s.status === filter)
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt));
    const count = (st) => submissions.filter((s) => s.status === st).length;
    const filters = [['all', `All (${submissions.length})`], ...Object.keys(STATUS_LABEL).map((k) => [k, `${STATUS_LABEL[k]} (${count(k)})`])];
    clear(root).append(
      h(
        'div',
        { class: 'stack' },
        h('div', null, h('h1', null, 'Review queue'), h('p', { class: 'muted' }, 'Submissions waiting for a decision come first. “Re-review required” means an approved item changed after approval.')),
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by status' }, filters.map(([k, l]) => h('button', { class: 'filter', type: 'button', 'aria-pressed': filter === k, onclick: () => ((filter = k), paint()) }, l))),
          rows.length
            ? h(
                'div',
                { class: 'table-wrap' },
                h(
                  'table',
                  { class: 'table' },
                  h('thead', null, h('tr', null, ['Campaign', 'Status', 'Revision', 'Blocking', 'Warnings', 'Comments', 'Updated'].map((t, i) => h('th', { scope: 'col', class: i >= 2 && i <= 5 ? 'num' : null }, t)))),
                  h(
                    'tbody',
                    null,
                    rows.map((s) =>
                      h(
                        'tr',
                        null,
                        h('td', null, h('a', { class: 'title', href: `#/workspace/${s.id}` }, s.title), h('div', { class: 'muted small mono' }, s.id)),
                        h('td', null, statusChip(s.status), s.staleApproval ? h('div', { class: 'muted small' }, `${s.staleApproval.reasons.map((r) => REASON[r]).join(' + ')} changed since approval`) : null),
                        h('td', { class: 'pill-count num' }, `${s.headRevision}`),
                        h('td', { class: 'pill-count num' }, s.summary.error ? h('span', { class: 'chip violation' }, s.summary.error) : '0'),
                        h('td', { class: 'pill-count num' }, s.summary.warning ? h('span', { class: 'chip violation-warning' }, s.summary.warning) : '0'),
                        h('td', { class: 'pill-count num' }, `${s.commentCount}`),
                        h('td', { class: 'small muted nowrap' }, fmtTime(s.updatedAt)),
                      ),
                    ),
                  ),
                ),
              )
            : h('div', { class: 'empty' }, 'Nothing here.'),
        ),
      ),
    );
  };
  paint();
}
