import { h, clear, api, describeError, toast, openDialog, fmtTime, field, roleLabel, state } from './ui.js';

export async function renderPeople(root) {
  const [{ users }, { events }] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/audit')]);
  const repaint = () => renderPeople(root);

  const act = async (fn, ok) => {
    try {
      await fn();
      toast(ok, 'ok');
      await repaint();
    } catch (e) {
      toast(describeError(e), 'err');
    }
  };

  clear(root).append(
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row between' }, h('div', null, h('h1', null, 'People'), h('p', { class: 'muted' }, 'Accounts for this local workspace. Only owners can see this page. Owners are created on this computer with `npm run auth:setup`, never from the browser.')), h('button', { class: 'btn primary', type: 'button', onclick: () => addDialog(repaint) }, '+ Add person')),
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h('caption', { class: 'sr-only' }, 'Accounts'),
            h('thead', null, h('tr', null, ['Name', 'Username', 'Role', 'Status', 'Actions'].map((t) => h('th', { scope: 'col' }, t)))),
            h(
              'tbody',
              null,
              users.map((u) =>
                h(
                  'tr',
                  null,
                  h('td', null, h('strong', null, u.name), h('div', { class: 'muted small mono' }, u.id)),
                  h('td', { class: 'mono' }, u.username),
                  h('td', null, roleLabel(u.role), u.owner ? h('span', { class: 'chip teal' }, 'owner') : null),
                  h('td', null, u.disabled ? h('span', { class: 'chip violation-warning' }, 'disabled') : h('span', { class: 'chip approved' }, 'active')),
                  h(
                    'td',
                    null,
                    h(
                      'div',
                      { class: 'row' },
                      u.id === state.user.id ? h('span', { class: 'muted small' }, 'you') : null,
                      u.id !== state.user.id
                        ? h('button', { class: 'btn small', type: 'button', onclick: () => act(() => api('POST', `/api/admin/users/${u.id}/${u.disabled ? 'enable' : 'disable'}`, {}), u.disabled ? 'Account enabled.' : 'Account disabled; its sessions ended.') }, u.disabled ? 'Enable' : 'Disable')
                        : null,
                      h('button', { class: 'btn small', type: 'button', onclick: () => resetDialog(u, repaint) }, 'Reset password'),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', null, 'Sign-in and account activity'), h('span', { class: 'muted small' }, 'Latest 50. No passwords or tokens are ever recorded.')),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h('caption', { class: 'sr-only' }, 'Recent authentication events'),
            h('thead', null, h('tr', null, ['When', 'Event', 'By', 'About'].map((t) => h('th', { scope: 'col' }, t)))),
            h('tbody', null, events.slice(0, 50).map((e) => h('tr', null, h('td', { class: 'small muted' }, fmtTime(e.at)), h('td', null, e.event.replaceAll('_', ' ')), h('td', { class: 'mono small' }, e.actor ?? '–'), h('td', { class: 'mono small' }, e.subject ?? '–')))),
          ),
        ),
      ),
    ),
  );
}

function addDialog(done) {
  const username = h('input', { type: 'text', id: 'np-user', autocomplete: 'off', autocapitalize: 'none' });
  const name = h('input', { type: 'text', id: 'np-name', maxLength: 60, autocomplete: 'off' });
  const role = h('select', { id: 'np-role' }, state.meta.roles.map((r) => h('option', { value: r.id }, r.label)));
  const pw = h('input', { type: 'password', id: 'np-pw', autocomplete: 'new-password' });
  openDialog({
    title: 'Add a person',
    content: [
      field('Username', username, '3–32 characters: letters, digits, dot, dash, underscore.', 'np-user'),
      field('Display name', name, 'Shown in review history.', 'np-name'),
      field('Role', role, null, 'np-role'),
      field('Initial password', pw, 'At least 15 characters. Share it with the person privately; they can change it after signing in.', 'np-pw'),
    ],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create account',
        kind: 'primary',
        onClick: async () => {
          try {
            await api('POST', '/api/admin/users', { username: username.value, displayName: name.value, role: role.value, password: pw.value });
            toast('Account created.', 'ok');
            await done();
            return true;
          } catch (e) {
            toast(describeError(e), 'err');
            return false;
          }
        },
      },
    ],
  });
}

function resetDialog(u, done) {
  const pw = h('input', { type: 'password', id: 'rp-pw', autocomplete: 'new-password' });
  openDialog({
    title: `Reset password for ${u.name}`,
    content: [field('New password', pw, 'At least 15 characters. Their current sessions end immediately.', 'rp-pw')],
    actions: [
      { label: 'Cancel' },
      {
        label: 'Reset password',
        kind: 'primary',
        onClick: async () => {
          try {
            await api('POST', `/api/admin/users/${u.id}/reset-password`, { password: pw.value });
            toast('Password reset.', 'ok');
            await done();
            return true;
          } catch (e) {
            toast(describeError(e), 'err');
            return false;
          }
        },
      },
    ],
  });
}
