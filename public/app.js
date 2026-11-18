const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = ts => ts ? new Date(ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }) : '—';
const STATUS = { pending: 'ממתין', done: 'פורסם', failed: 'נכשל', skipped: 'בוטל' };
let state = null;
let campSig = '';

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/** Run an action with the button disabled; report errors as a toast; refresh afterwards. */
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); }
  catch (e) { toast(e.message, true); }
  finally { if (btn) btn.disabled = false; await refresh(); }
}

// ---------- tabs
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button, .tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); $('#' + b.dataset.tab).classList.add('active');
});

// ---------- render
function render() {
  const { status: st, settings, groups, posts, campaigns, queue, log } = state;
  const gName = id => groups.find(g => g.id === id)?.name ?? id;
  const pName = id => posts.find(p => p.id === id)?.title ?? id;

  $('#st-run').innerHTML = st.running ? (st.current ? `<span class="ok">מפרסם עכשיו…</span>` : '<span class="ok">פעיל</span>') : '<span class="bad">כבוי</span>';
  $('#st-wait').textContent = st.current || (st.running ? st.waitReason : st.quiet || '');
  $('#st-login').innerHTML = st.loggedIn === true ? '<span class="ok">מחובר ✓</span>' : st.loggedIn === false ? '<span class="bad">לא מחובר</span>' : '<span class="muted">דפדפן סגור</span>';
  $('#st-today').textContent = st.postsToday;
  $('#st-cap').textContent = settings.dailyCap;
  $('#st-pending').textContent = st.counts.pending;
  $('#st-counts').textContent = `ממתינים · ${st.counts.done} פורסמו · ${st.counts.failed} נכשלו`;

  const lastByGroup = {};
  queue.forEach(q => { if (q.status === 'done' && (!lastByGroup[q.groupId] || q.doneAt > lastByGroup[q.groupId])) lastByGroup[q.groupId] = q.doneAt; });
  const gf = $('#group-filter').value.trim().toLowerCase();
  if (!$('#groups-body').contains(document.activeElement)) $('#groups-body').innerHTML = groups
    .filter(g => !gf || g.name.toLowerCase().includes(gf) || g.tags.join(',').toLowerCase().includes(gf))
    .map(g => `<tr>
      <td><input type="checkbox" data-gtoggle="${esc(g.id)}" ${g.enabled ? 'checked' : ''}></td>
      <td><a href="${esc(g.url)}" target="_blank">${esc(g.name)}</a></td>
      <td><input class="small" data-gtags="${esc(g.id)}" value="${esc(g.tags.join(', '))}" placeholder="נדל״ן, מרכז"></td>
      <td>${fmt(lastByGroup[g.id])}</td>
      <td><button class="sm danger" data-gdel="${esc(g.id)}">מחק</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">אין קבוצות עדיין</td></tr>';

  $('#posts-list').innerHTML = posts.map(p => `<div class="post">
      <b>${esc(p.title)}</b><pre>${esc(p.text)}</pre>
      <div class="thumbs">${p.images.map(f => `<img src="/images/${esc(f)}">`).join('')}</div>
      <div><button class="sm danger" data-pdel="${esc(p.id)}">מחק</button></div></div>`).join('')
    || '<p class="muted">אין פוסטים עדיין</p>';

  // Campaign pickers: only rebuild when the underlying lists change, so ticked boxes survive polling.
  const sig = posts.map(p => p.id + p.title).join() + '|' + groups.map(g => g.id + g.name + g.enabled + g.tags).join();
  if (sig !== campSig) {
    campSig = sig;
    const keep = new Set([...document.querySelectorAll('#camp-form input[type=checkbox]:checked')].map(i => i.value));
    $('#camp-posts').innerHTML = posts.map(p => `<label><input type="checkbox" name="postIds" value="${esc(p.id)}" ${keep.has(p.id) ? 'checked' : ''}> ${esc(p.title)}</label>`).join('') || '<span class="muted">צור פוסט קודם</span>';
    $('#camp-groups').innerHTML = groups.filter(g => g.enabled).map(g => `<label data-name="${esc((g.name + ' ' + g.tags.join(' ')).toLowerCase())}"><input type="checkbox" name="groupIds" value="${esc(g.id)}" ${keep.has(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('') || '<span class="muted">הוסף קבוצות קודם</span>';
    filterCampGroups();
  }

  $('#camps-body').innerHTML = campaigns.map(c => {
    const qs = queue.filter(q => q.campaignId === c.id);
    const done = qs.filter(q => q.status === 'done').length;
    return `<tr><td><input type="checkbox" data-ctoggle="${esc(c.id)}" ${c.enabled ? 'checked' : ''}></td>
      <td>${esc(c.name)}</td><td>${c.postIds.map(id => esc(pName(id))).join('<br>')}</td><td>${c.groupIds.length}</td>
      <td>${c.repeatDays ? `כל ${c.repeatDays} ימים` : 'חד פעמי'}</td><td>${done} / ${qs.length}</td>
      <td><button class="sm danger" data-cdel="${esc(c.id)}">מחק</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">אין קמפיינים עדיין</td></tr>';

  $('#queue-body').innerHTML = queue.map(q => `<tr>
      <td><span class="badge b-${q.status}">${STATUS[q.status]}</span></td>
      <td>${esc(pName(q.postId))}</td><td>${esc(gName(q.groupId))}</td>
      <td>${fmt(q.doneAt || q.dueAt)}</td><td class="bad">${esc(q.error || '')}</td>
      <td>${q.status === 'pending' || q.status === 'failed' ? `<button class="sm" data-qnow="${q.id}">פרסם עכשיו</button>` : ''}
          ${q.status === 'failed' ? `<button class="sm" data-qretry="${q.id}">החזר לתור</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">התור ריק</td></tr>';

  $('#log-list').innerHTML = log.map(l => `<li class="${l.level}"><time>${fmt(l.at)}</time>${esc(l.msg)}</li>`).join('') || '<li class="muted">אין רשומות</li>';
}

function fillSettings() {
  const f = $('#settings-form');
  for (const [k, v] of Object.entries(state.settings)) {
    const el = f.elements[k]; if (!el) continue;
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
  }
}

function filterCampGroups() {
  const q = $('#camp-filter').value.trim().toLowerCase();
  document.querySelectorAll('#camp-groups label').forEach(l => (l.hidden = !!q && !l.dataset.name.includes(q)));
}

async function refresh() {
  try { state = await api('GET', '/api/state'); render(); }
  catch (e) { $('#st-run').innerHTML = '<span class="bad">השרת לא זמין</span>'; }
}

// ---------- events (delegated)
document.body.addEventListener('change', e => {
  const t = e.target, d = t.dataset;
  if (d.gtoggle) act(null, () => api('PATCH', `/api/groups/${d.gtoggle}`, { enabled: t.checked }));
  if (d.gtags !== undefined) act(null, () => api('PATCH', `/api/groups/${d.gtags}`, { tags: t.value }), 'התגיות נשמרו');
  if (d.ctoggle) act(null, () => api('PATCH', `/api/campaigns/${d.ctoggle}`, { enabled: t.checked }));
});

document.body.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset;
  if (d.gdel && confirm('למחוק את הקבוצה?')) act(t, () => api('DELETE', `/api/groups/${d.gdel}`));
  if (d.pdel && confirm('למחוק את הפוסט?')) act(t, () => api('DELETE', `/api/posts/${d.pdel}`));
  if (d.cdel && confirm('למחוק את הקמפיין? פריטים ממתינים יבוטלו.')) act(t, () => api('DELETE', `/api/campaigns/${d.cdel}`));
  if (d.qnow) act(t, () => api('POST', `/api/queue/${d.qnow}/post-now`), r => r.status === 'done' ? 'פורסם ✓' : `נכשל: ${r.error}`);
  if (d.qretry) act(t, () => api('POST', `/api/queue/${d.qretry}/retry`));
});

$('#btn-login').onclick = e => act(e.target, () => api('POST', '/api/browser/login'), 'התחבר בחלון הדפדפן שנפתח');
$('#btn-start').onclick = e => act(e.target, () => api('POST', '/api/runner/start'), 'הפרסום האוטומטי הופעל');
$('#btn-stop').onclick = e => act(e.target, () => api('POST', '/api/runner/stop'), 'נעצר');
$('#btn-import').onclick = e => { toast('סורק את הקבוצות שלך… (עד דקה)'); act(e.target, () => api('POST', '/api/groups/import'), r => `נמצאו ${r.found} קבוצות, נוספו ${r.added}`); };
$('#btn-add-groups').onclick = e => act(e.target, async () => { const r = await api('POST', '/api/groups', { text: $('#group-urls').value }); $('#group-urls').value = ''; return r; }, r => `נוספו ${r.added} קבוצות`);
$('#group-filter').oninput = render;
$('#camp-filter').oninput = filterCampGroups;
$('#camp-all').onclick = () => {
  const boxes = [...document.querySelectorAll('#camp-groups label:not([hidden]) input')];
  const on = boxes.some(b => !b.checked); boxes.forEach(b => (b.checked = on));
};

const readFile = f => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); });
$('#post-form').elements.images.onchange = async e => {
  $('#img-preview').innerHTML = (await Promise.all([...e.target.files].slice(0, 10).map(readFile))).map(u => `<img src="${u}">`).join('');
};
$('#post-form').onsubmit = e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button');
  act(btn, async () => {
    const images = await Promise.all([...f.elements.images.files].slice(0, 10).map(async file => ({ dataUrl: await readFile(file) })));
    await api('POST', '/api/posts', { title: f.elements.title.value, text: f.elements.text.value, images });
    f.reset(); $('#img-preview').innerHTML = '';
  }, 'הפוסט נשמר');
};

$('#camp-form').onsubmit = e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button.primary');
  const checked = name => [...f.querySelectorAll(`input[name=${name}]:checked`)].map(i => i.value);
  act(btn, async () => {
    const r = await api('POST', '/api/campaigns', {
      name: f.elements.name.value, postIds: checked('postIds'), groupIds: checked('groupIds'),
      repeatDays: f.elements.repeatDays.value, startAt: f.elements.startAt.value || null,
    });
    f.reset(); f.querySelectorAll('input[type=checkbox]').forEach(i => (i.checked = false));
    return r;
  }, 'הקמפיין נוצר ונכנס לתור');
};

$('#settings-form').onsubmit = e => {
  e.preventDefault();
  const f = e.target, body = {};
  for (const el of f.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  act(f.querySelector('button'), async () => { await api('PUT', '/api/settings', body); }, 'ההגדרות נשמרו');
};

refresh().then(() => state && fillSettings());
setInterval(refresh, 5000);
