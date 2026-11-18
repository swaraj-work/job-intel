// JobIntel Lead & Outreach Engine: Front-end client. Plain JS, talks to Express API.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  if (!t) return;
  t.innerHTML = esc(msg) + (action ? ` <button>${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { action.fn(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

const scoreClass = (s, th = state.threshold) => (s >= th ? 'high' : s >= th - 20 ? 'mid' : 'low');
const initials = (n) => String(n).split(/\s+/).map((x) => x[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const avatar = (l) => `<div class="avatar">${l.logo ? `<img src="${esc(safeUrl(l.logo))}" alt="" loading="lazy" onerror="this.remove()">` : ''}${l.logo ? '' : esc(initials(l.name))}</div>`;

const state = { view: 'jobs', threshold: 60, stats: null, leadsOffset: 0, config: null, pendingLeads: 0 };

// ---------- routing ----------
const VIEWS = ['jobs', 'brief', 'leads', 'reddit', 'live', 'sources', 'config'];
function route() {
  const [v, id] = location.hash.slice(1).split('/');
  const view = VIEWS.includes(v) ? v : 'jobs';
  state.view = view;
  for (const x of VIEWS) {
    const el = $(`#view-${x}`);
    if (el) el.hidden = x !== view;
  }
  const section = { reddit: 'jobs', live: 'sources' }[view] || view;
  for (const a of $$('#tabs a')) {
    const active = a.dataset.view === section;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', view === section ? 'page' : 'location');
    else a.removeAttribute('aria-current');
  }
  const viewLoaders = {
    jobs: loadJobs,
    brief: loadBrief,
    leads: () => loadLeads(true),
    reddit: loadReddit,
    live: loadLive,
    sources: loadSources,
    config: loadConfig
  };
  if (viewLoaders[view]) viewLoaders[view]();
  if (id) openLead(id);
}
window.addEventListener('hashchange', route);

let jobData = { openings: [], funding: [] };
let jobLimit = 50;
let jobRequest = 0;

async function loadJobs() {
  const request = ++jobRequest;
  try {
    const data = await api('/opportunities?hours=' + $('#jobHours').value);
    if (request !== jobRequest) return;
    jobData = data;
    renderJobs();
  } catch (e) {
    if (request === jobRequest) $('#jobsCount').textContent = 'Refresh failed · ' + e.message;
  }
}

function renderJobs() {
  const funding = $('#jobType').value === 'funding';
  const level = $('#jobLevel').value;
  const rows = funding ? jobData.funding : jobData.openings.filter(r => (!level || r.level === level) && (!$('#jobStartup').value || r.startup));
  $('#jobLevelLabel').hidden = $('#jobStartupLabel').hidden = funding;
  $('#jobsCount').textContent = rows.length + (rows.length === 1 ? ' result' : ' results');
  const expanded = new Set($$('#jobsList details[open]').map(el => el.dataset.id));
  $('#jobsList').innerHTML = rows.slice(0, jobLimit).map(r => {
    const metadata = [r.company, r.startup, r.experience || r.level, r.location].filter(Boolean).map(esc).join(' · ');
    const time = r.published ? `<time datetime="${esc(r.published)}" title="${esc(new Date(r.published).toLocaleString())}">${r.approximate ? 'about ' : ''}${ago(r.published)}</time>` : 'Posting time unknown';
    return `<article class="panel"><div class="job-head muted small"><span>${esc(r.source)}</span>${time}</div>
      <h2><a class="link" href="${esc(safeUrl(r.url))}" target="_blank" rel="noopener noreferrer">${esc(r.title)} ↗</a></h2>
      ${metadata ? '<div class="small">' + metadata + '</div>' : ''}
      ${r.summary && r.summary !== r.title ? `<details data-id="${Number(r.id)}" ${expanded.has(String(r.id)) ? 'open' : ''}><summary>Excerpt</summary><p>` + esc(r.summary) + '</p></details>' : ''}
      ${r.companyId ? '<div><a class="link small" href="#jobs/' + Number(r.companyId) + '">Company &amp; outreach →</a></div>' : ''}
    </article>`;
  }).join('') || `<div class="panel">No matching ${funding ? 'funding announcements' : 'openings'}. Change the filters or <a href="#sources">check sources</a>.</div>`;
  $('#jobsMore').hidden = rows.length <= jobLimit;
}
$('#jobHours').onchange = () => {
  jobLimit = 50;
  jobData = { openings: [], funding: [] };
  $('#jobsList').textContent = '';
  $('#jobsMore').hidden = true;
  $('#jobsCount').textContent = 'Loading…';
  loadJobs();
};
for (const id of ['#jobType', '#jobLevel', '#jobStartup']) $(id).onchange = () => { jobLimit = 50; renderJobs(); };
$('#jobsMore').onclick = () => { jobLimit += 50; renderJobs(); };
setInterval(() => { if (state.view === 'jobs' && !document.hidden) loadJobs(); }, 30000);

// ---------- engine status ----------
async function loadStats() {
  try {
    const s = await api('/stats');
    state.stats = s;
    state.threshold = s.threshold;
    const busy = s.running.length || s.queue > 0;
    $('#engine').className = `engine ${busy ? 'busy' : ''}`;
    $('#engineText').textContent = busy ? 'Scanning' : 'Idle';
    $('#scanBtn').classList.toggle('scanning', s.running.length > 0);

    if (state.view === 'brief') renderKpis(s);
    if (state.view === 'live') renderFunnel(s);
  } catch {
    $('#engine').className = 'engine off';
    $('#engineText').textContent = 'Server offline';
  }
}

function renderKpis(s) {
  const kpisEl = $('#kpis');
  if (!kpisEl) return;
  kpisEl.innerHTML = [
    ['Emails sent today', `${s.dailySent ?? 0} / ${s.dailyQuota ?? 20}`],
    ['High match', s.highIntent],
    ['Startups found today', s.newToday],
  ].map(([label, value]) => `<div class="kpi"><div class="label">${label}</div><div class="value">${esc(value)}</div></div>`).join('');

}

// ---------- lead card ----------
function leadCard(l) {
  const f = l.funding;
  const fundTxt = f ? [f.type === 'directory' ? 'YC-backed' : f.stage, f.amount, f.type === 'directory' ? null : fmtDate(f.date)].filter(Boolean).join(' · ') : null;
  const companyDetails = [fundTxt, l.city, l.team?.label].filter(Boolean).join(' · ');
  const stack = (l.techStack || []).slice(0, 4).map((t) => `<span class="tag tech">${esc(t)}</span>`).join('');
  const appBadge = l.applicationStatus && l.applicationStatus !== 'new'
    ? `<span class="status-badge ${esc(l.applicationStatus)}">${esc(l.applicationStatus === 'sent' ? 'Sent' : l.applicationStatus)}</span>`
    : '';

  return `<article class="lead" data-id="${l.id}">
    <div class="lead-top">${avatar(l)}<div class="lead-main">
      <div class="name-row">
        <span class="name">${esc(l.name)}</span>
        <span class="pill">${esc(l.sector || 'Tech')}</span>
        ${appBadge}
        ${l.badge ? `<span class="badge ${l.badge}">${l.badge}</span>` : ''}
        ${l.explore ? '<span class="badge explore" title="Exploration pick">explore</span>' : ''}
        <span class="score ${scoreClass(l.score)}" title="${esc((l.breakdown || []).filter((b) => b.points).map((b) => `${b.label}: ${b.points > 0 ? '+' : ''}${b.points}`).join('\n'))}">${l.score}</span>
      </div>
      ${companyDetails ? '<div class="meta">' + esc(companyDetails) + '</div>' : ''}
      ${l.contact ? `<div class="reach">Founder / CTO: <b>${esc(l.contact.name)}</b>${l.contact.role ? ` (${esc(l.contact.role)})` : ''}${l.contact.hasEmail ? ' · <span style="color:var(--green)">Email available</span>' : ''}</div>` : l.target ? `<div class="reach muted">Target: ${esc(l.target.roles.slice(0, 2).join(' or '))}</div>` : ''}
      <div class="reason">${esc(l.why || '')}</div>
      <div class="tags">${(l.signals || []).slice(0, 4).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}${stack}</div>
    </div></div>
    <div class="lead-foot">
      <span>${esc(l.latest?.source || '')} · ${esc(l.latest?.title || '')}</span>
      <span>${l.corroborations > 1 ? `${l.corroborations} sources · ` : ''}${ago(l.latest?.at || l.lastEventAt)}</span>
    </div>
  </article>`;
}

function bindLeadClicks(root) {
  root.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('a,button,select,input,textarea')) return;
    openLead(el.dataset.id);
  }));
}

// ---------- brief ----------
async function loadBrief() {
  $('#briefLeads').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const [b] = await Promise.all([api('/brief'), loadStats()]);
  state.pendingLeads = 0;
  $('#briefCount').textContent = b.leads.length ? String(b.leads.length) : '';
  $('#briefLeads').innerHTML = b.leads.length ? b.leads.map(leadCard).join('') : '<div class="empty">No new startups to review.</div>';
  bindLeadClicks($('#briefLeads'));
}

$('#ackBrief').onclick = async () => {
  await api('/brief/ack', { method: 'POST' });
  $('#undoAck').hidden = false;
  toast('Batch marked as reviewed. Only fresh discoveries will show.');
  loadBrief();
};
$('#undoAck').onclick = async () => { await api('/brief/undo', { method: 'POST' }); $('#undoAck').hidden = true; loadBrief(); };

// ---------- leads / pipeline ----------
function leadParams() {
  const p = new URLSearchParams();
  const v = (id) => $(id)?.value;
  if (v('#fQ')) p.set('q', v('#fQ'));
  if (v('#fAppStatus')) p.set('appStatus', v('#fAppStatus'));
  if (v('#fSector')) p.set('sector', v('#fSector'));
  if (v('#fStage')) p.set('stage', v('#fStage'));
  if (v('#fMin')) p.set('minScore', v('#fMin'));
  if (v('#fDays')) p.set('days', v('#fDays'));
  if (v('#fSort')) p.set('sort', v('#fSort'));
  if ($('#fEnt')?.checked) p.set('hideEnterprise', '1');
  return p;
}

async function loadLeads(reset) {
  if (reset) state.leadsOffset = 0;
  const p = leadParams();
  $('#csvBtn').href = `/api/leads.csv?${p}`;
  p.set('limit', 50);
  p.set('offset', state.leadsOffset);
  if (reset) $('#leadTable').innerHTML = '<div class="skeleton" style="height:300px;border:0"></div>';
  const [r] = await Promise.all([api(`/leads?${p}`), state.stats ? null : loadStats()]);
  fillSectorFilter();
  $('#leadCount').textContent = `${r.total.toLocaleString('en-IN')} startups in pipeline`;
  const head = '<div class="tr th"><div>Startup</div><div>Score</div><div>Funding</div><div>Opportunity Signal</div><div>Application Status</div><div>Last Signal</div></div>';
  const rows = r.leads.map((l) => `<div class="tr row" data-id="${l.id}">
      <div class="cell-name">${avatar(l)}<div style="min-width:0"><b>${esc(l.name)} ${l.badge === 'new' ? '<span class="badge new">new</span>' : ''}</b><small>${esc([l.sector, l.city].filter(Boolean).join(' · '))}</small></div></div>
      <div><span class="score ${scoreClass(l.score)}" style="margin:0">${l.score}</span></div>
      <div class="trunc small">${esc(l.funding ? [l.funding.type === 'directory' ? 'YC' : l.funding.stage, l.funding.amount].filter(Boolean).join(' · ') : '-')}</div>
      <div class="trunc small muted" title="${esc(l.why)}">${esc((l.signals || []).slice(0, 3).join(' · ') || l.latest?.title || '')}</div>
      <div><span class="status-badge ${esc(l.applicationStatus || 'new')}">${esc(l.applicationStatus === 'new' ? 'To Reach Out' : l.applicationStatus || 'To Reach Out')}</span></div>
      <div class="small muted">${ago(l.latest?.at || l.lastEventAt)}</div>
    </div>`).join('');
  if (reset) $('#leadTable').innerHTML = r.leads.length ? head + rows : '<div class="empty" style="border:0"><strong>No startups match these filters.</strong>Try widening your filters or clearing search.</div>';
  else $('#leadTable').insertAdjacentHTML('beforeend', rows);
  bindLeadClicks($('#leadTable'));
  state.leadsOffset += r.leads.length;
  $('#moreBtn').hidden = state.leadsOffset >= r.total;
}
$('#moreBtn').onclick = () => loadLeads(false);
let fTimer;
for (const id of ['#fQ', '#fAppStatus', '#fSector', '#fStage', '#fMin', '#fDays', '#fSort', '#fEnt']) {
  const el = $(id);
  if (el) el.addEventListener(id === '#fQ' ? 'input' : 'change', () => { clearTimeout(fTimer); fTimer = setTimeout(() => loadLeads(true), 250); });
}

function fillSectorFilter() {
  const sel = $('#fSector');
  if (!sel || sel.options.length > 1 || !state.stats) return;
  for (const s of state.stats.sectors || []) sel.insertAdjacentHTML('beforeend', `<option value="${esc(s.sector)}">${esc(s.sector)} (${s.n})</option>`);
}

// ---------- lead drawer & 5-line outreach cockpit ----------
async function openLead(id) {
  $('#drawerWrap').classList.add('open');
  $('#drawer').innerHTML = '<div class="d-body"><div class="skeleton"></div><div class="skeleton"></div></div>';
  const l = await api(`/leads/${id}`);
  renderDrawer(l);
}

function renderDrawer(l) {
  const pos = (l.breakdown || []).filter((b) => b.max > 0);
  const neg = (l.breakdown || []).filter((b) => b.points < 0);
  const e = l.enrichment;
  const draftSubject = l.outreachSubject || `Quick note re: ${l.name} / ${l.contact?.name || 'founding team'}`;
  const draftBody = l.emailDraft || l.pitch || '';
  const primaryEmail = l.contact?.email || l.contacts?.find((c) => c.email)?.email || l.inboxes?.[0] || '';

  $('#drawer').innerHTML = `
  <div class="d-head">
    <div class="d-title">${avatar(l)}<div style="min-width:0"><h2>${esc(l.name)}</h2>
      <div class="muted small">${esc([l.sector, l.city, l.size !== 'unknown' ? l.size : null].filter(Boolean).join(' · '))}${l.website ? ` · <a href="${esc(safeUrl(l.website))}" target="_blank" rel="noopener">${esc(l.domain || 'website')}</a>` : ''}${e?.social?.linkedin ? ` · <a href="${esc(safeUrl(e.social.linkedin))}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</div></div>
      <div class="bigscore ${scoreClass(l.score)}"><b>${l.score}</b><span>score</span></div></div>
    <div class="d-actions">
      <select class="input" id="dAppStatus">
        ${['new', 'sent', 'replied', 'interview', 'offer', 'rejected'].map((s) => `<option value="${s}" ${s === (l.applicationStatus || 'new') ? 'selected' : ''}>${s === 'new' ? 'To Reach Out' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
      </select>
      <button class="fb up ${l.feedback === 1 ? 'on' : ''}" data-fb="1" title="High-relevance opportunity: teach engine">👍</button>
      <button class="fb down ${l.feedback === -1 ? 'on' : ''}" data-fb="-1" title="Irrelevant / skip: teach engine">👎</button>
      <span class="spacer"></span>
      <button class="btn small" id="dEnrich">${l.enrichedAt ? 'Re-research' : 'Research site'}</button>
      <button class="btn small ghost" id="dClose">Close</button>
    </div>
  </div>
  <div class="d-body">
    <!-- 5-Line Cold Email Cockpit -->
    <div class="panel outreach-card">
      <div class="panel-head">
        <h3>Email draft</h3>
        <span class="muted small">${l.applicationStatus === 'sent' ? `Sent ${fmtDate(l.sentAt)}` : ''}</span>
      </div>
      <div class="outreach-fields">
        <div style="display:flex;gap:10px;margin-bottom:8px;align-items:center;">
          <span class="muted small" style="min-width:55px;">Recipient:</span>
          <b>${esc(l.contact?.name || 'Founder/CTO')}</b>
          ${primaryEmail ? `<a href="mailto:${esc(primaryEmail)}" class="link small">${esc(primaryEmail)}</a>` : '<span class="muted small">Email unavailable</span>'}
        </div>
        <div style="margin-bottom:8px;">
          <label class="muted small" style="display:block;margin-bottom:4px;">Subject</label>
          <input class="input" id="dOutreachSubject" value="${esc(draftSubject)}" style="width:100%;font-weight:500;">
        </div>
        <div style="margin-bottom:12px;">
          <label class="muted small" style="display:block;margin-bottom:4px;">Message</label>
          <textarea class="outreach-textarea" id="dOutreachBody" spellcheck="false">${esc(draftBody)}</textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <button class="btn primary gmail" id="dSendGmail">Open in Gmail</button>
          <button class="btn" id="dCopyEmail">Copy Draft</button>
          <button class="btn mark-sent" id="dMarkSent">${l.applicationStatus === 'sent' ? 'Sent' : 'Mark as sent'}</button>
        </div>
      </div>
    </div>

    <div class="panel"><div class="panel-head"><h3>Opportunity Fit</h3></div><div>${esc(l.why || '')}</div>
      ${(l.signals || []).length ? `<div class="tags" style="margin-top:10px">${l.signals.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}</div>

    ${peoplePanel(l)}

    <div class="panel"><div class="panel-head"><h3>Score breakdown</h3></div>
      ${pos.map((b) => `<div class="bd-row"><span>${esc(b.label)}</span><div class="bar"><i style="width:${b.max ? (b.points / b.max) * 100 : 0}%"></i></div><span class="muted">${b.points}/${b.max}</span><small>${esc(b.detail)}</small></div>`).join('')}
      ${neg.map((b) => `<div class="bd-row neg"><span>${esc(b.label)}</span><div class="bar"><i style="width:100%"></i></div><span class="muted">${b.points}</span><small>${esc(b.detail)}</small></div>`).join('')}
    </div>

    <div class="panel"><div class="panel-head"><h3>Startup facts</h3>${l.enrichedAt ? `<span class="muted small">site checked ${ago(l.enrichedAt)}</span>` : ''}</div>
      <div class="facts">
        <div><span>Funding</span>${esc(l.funding ? [l.funding.stage, l.funding.amount, fmtDate(l.funding.date)].filter(Boolean).join(' · ') : 'Unknown')}</div>
        <div><span>Investors</span>${esc(l.funding?.investors?.join(', ') || '-')}</div>
        <div><span>Team Size</span>${esc(l.team ? `~${l.team.label} people` : 'Unknown')}</div>
        <div><span>Tech Stack</span>${esc((l.techStack || []).join(', ') || 'Not detected on homepage')}</div>
        <div><span>ATS / Job Board</span>${esc(e?.careersAts || 'Unknown')}</div>
        ${e?.emails?.length ? `<div><span>Contact inboxes</span>${esc(e.emails.join(', '))}</div>` : ''}
        <div><span>Description</span>${esc(l.description || '-')}</div>
      </div></div>

    <div class="panel"><div class="panel-head"><h3>Signal timeline</h3><span class="muted small">${l.events.length} signals</span></div>
      <div class="timeline">${l.events.map((ev) => `<div class="tl ${ev.type}"><div class="when">${esc(ev.type)} · ${fmtDate(ev.occurredAt)} · ${esc(ev.source || '')}${ev.corroborations > 1 ? ` · confirmed by ${ev.corroborations} sources` : ''}</div>
        <a href="${esc(safeUrl(ev.url))}" target="_blank" rel="noopener">${esc(ev.title)}</a>
        ${ev.summary ? `<p>${esc(ev.summary)}</p>` : ''}
        ${[ev.stage, ev.amount, ev.investors.length ? `backed by ${ev.investors.join(', ')}` : null].filter(Boolean).length ? `<p class="small">${esc([ev.stage, ev.amount, ev.investors.length ? `backed by ${ev.investors.join(', ')}` : null].filter(Boolean).join(' · '))}</p>` : ''}
      </div>`).join('')}</div></div>

    <div class="panel"><div class="panel-head"><h3>Outreach notes</h3><span class="muted small" id="noteState"></span></div><textarea class="input" id="dNotes" rows="3" placeholder="Founder replies, interview schedule, next steps…">${esc(l.notes)}</textarea></div>
  </div>`;

  // Bind Cockpit Actions
  $('#dSendGmail').onclick = () => {
    const to = primaryEmail;
    const su = encodeURIComponent($('#dOutreachSubject').value);
    const body = encodeURIComponent($('#dOutreachBody').value);
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${su}&body=${body}`;
    window.open(url, '_blank', 'noopener');
  };

  $('#dCopyEmail').onclick = () => {
    const text = `Subject: ${$('#dOutreachSubject').value}\n\n${$('#dOutreachBody').value}`;
    navigator.clipboard.writeText(text);
    toast('Draft copied to clipboard!');
  };

  $('#dMarkSent').onclick = async () => {
    try {
      const subject = $('#dOutreachSubject').value;
      const body = $('#dOutreachBody').value;
      await api(`/leads/${l.id}/mark-sent`, { method: 'POST', body: { subject, body } });
      toast('Marked as sent.');
      loadStats();
      const fresh = await api(`/leads/${l.id}`);
      renderDrawer(fresh);
    } catch (err) {
      toast(err.message);
    }
  };

  $('#dOutreachSubject').onblur = async (ev) => {
    if (ev.target.value !== l.outreachSubject) {
      await api(`/leads/${l.id}/application`, { method: 'PATCH', body: { outreachSubject: ev.target.value } });
      l.outreachSubject = ev.target.value;
    }
  };

  $('#dOutreachBody').onblur = async (ev) => {
    if (ev.target.value !== l.emailDraft) {
      await api(`/leads/${l.id}/application`, { method: 'PATCH', body: { emailDraft: ev.target.value } });
      l.emailDraft = ev.target.value;
    }
  };

  $('#dAppStatus').onchange = async (ev) => {
    await api(`/leads/${l.id}/application`, { method: 'PATCH', body: { status: ev.target.value } });
    toast(`Application marked as ${ev.target.value}`);
    loadStats();
  };

  const patch = async (body, msg) => { await api(`/leads/${l.id}`, { method: 'PATCH', body }); if (msg) toast(msg); const fresh = await api(`/leads/${l.id}`); renderDrawer(fresh); };
  $('#dClose').onclick = closeDrawer;
  $$('.fb', $('#drawer')).forEach((b) => (b.onclick = () => {
    const v = Number(b.dataset.fb);
    patch({ feedback: l.feedback === v ? 0 : v }, v > 0 ? 'Noted. Engine will prioritize similar startup opportunities.' : 'Noted. Engine will deprioritize similar startups.');
  }));
  $('#dNotes').onblur = async (ev) => { if (ev.target.value !== l.notes) { await api(`/leads/${l.id}`, { method: 'PATCH', body: { notes: ev.target.value } }); $('#noteState').textContent = 'Saved'; l.notes = ev.target.value; } };
  $('#dEnrich').onclick = async (ev) => { ev.target.disabled = true; ev.target.textContent = 'Researching…'; try { await api(`/leads/${l.id}/enrich`, { method: 'POST' }); renderDrawer(await api(`/leads/${l.id}`)); toast('Website & stack researched'); } catch (err) { toast(err.message); ev.target.disabled = false; } };
  bindPeople(l);
}

// ---------- decision makers (Founders & CTOs) ----------
const liSearch = (q) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
const gSearch = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const SRC_LABEL = { sprouts: 'Sprouts', news: 'news', article: 'funding news', website: 'startup site', yc: 'Y Combinator', apollo: 'Apollo', manual: 'added manually' };

function peoplePanel(l) {
  const prov = l.emailProviders;
  const canFind = prov?.configured?.length > 0;
  const people = l.contacts || [];
  const teamTxt = l.team ? `Team ~${esc(l.team.label)}` : 'Early-stage startup';
  const person = (p) => {
    const emailBit = p.email
      ? `<a href="mailto:${esc(p.email)}"><b>${esc(p.email)}</b></a> <span class="estatus ${esc(p.emailStatus)}">${esc(p.emailStatus === 'risky' ? 'risky' : p.emailStatus)}</span>`
      : p.dnc ? '' : canFind ? `<button class="btn small" data-find="${p.id}">${p.emailCheckedAt ? 'Retry lookup' : 'Find work email'}</button>${p.emailCheckedAt ? ` <span class="muted small">none verified</span>` : ''}` : '';
    return `<div class="person ${p.dnc ? 'dnc' : ''}">
      <div class="avatar sm">${esc(initials(p.name))}</div>
      <div class="person-main">
        <div><b>${esc(p.name)}</b>${p.primary ? ' <span class="badge new">direct hiring decision-maker</span>' : ''}${p.dnc ? ' <span class="badge dnc-b">skip</span>' : ''}</div>
        <div class="muted small">${esc(p.role || 'Founder / CTO')} · from ${esc(SRC_LABEL[p.source] || p.source)}</div>
        <div class="person-links small">${emailBit}
          <a class="link" href="${esc(p.linkedin ? safeUrl(p.linkedin) : liSearch(`${p.name} ${l.name}`))}" target="_blank" rel="noopener">${p.linkedin ? 'LinkedIn' : 'Search LinkedIn'}</a>
          <a class="link" href="${esc(gSearch(`"${p.name}" "${l.name}"`))}" target="_blank" rel="noopener">Google</a>
        </div>
      </div>
      <div class="person-actions">
        <button class="btn small ghost" data-dnc="${p.id}" data-on="${p.dnc ? 1 : 0}" title="Exclude this person">${p.dnc ? 'Allow' : 'Skip'}</button>
        <button class="btn small ghost danger" data-del-contact="${p.id}" title="Remove">✕</button>
      </div></div>`;
  };
  const roleLinks = (l.target?.roles || ['Founding Engineer', 'CTO', 'Founder']).slice(0, 3).map((r) => `<a class="chip-link" href="${esc(liSearch(`${r} ${l.name}`))}" target="_blank" rel="noopener">${esc(r)} at ${esc(l.name)} ↗</a>`).join('');
  return `<div class="panel"><div class="panel-head"><h3>Decision Makers (Founders & Tech Leaders)</h3><span class="muted small">${teamTxt}</span></div>
    <div class="target"><b>Outbound Target:</b> ${esc((l.target?.roles || []).join(' → '))}<div class="muted small">${esc(l.target?.reason || '')}</div></div>
    ${people.length ? people.map(person).join('') : `<div class="muted small" style="margin:10px 0">No named founders yet. Click "Research site" or add a founder below.</div>`}
    <div class="role-links"><span class="muted small">Quick LinkedIn search:</span> ${roleLinks}</div>
    ${l.inboxes?.length ? `<div class="small" style="margin-top:8px"><span class="muted">Company inboxes:</span> ${l.inboxes.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', ')}</div>` : ''}
    <details class="add-person"><summary class="small link">Add founder manually</summary>
      <form id="addPerson" class="add-grid" style="margin-top:8px"><input class="input" name="name" placeholder="Full name (e.g. Rahul Sharma)" required><input class="input" name="role" placeholder="Role (e.g. Co-founder & CTO)"><input class="input" name="email" type="email" placeholder="Direct work email"><button class="btn small primary">Add</button></form>
    </details>
    <div class="muted small" style="margin-top:10px">${canFind ? `Verified email lookup active (${esc(prov.configured.map((p) => p.label).join(', '))}).` : 'Add APOLLO_API_KEY or HUNTER_API_KEY to your environment to auto-verify founder work emails.'}</div>
  </div>`;
}

function bindPeople(l) {
  const refresh = async () => renderDrawer(await api(`/leads/${l.id}`));
  $$('[data-find]', $('#drawer')).forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Looking up…';
    try { const r = await api(`/contacts/${b.dataset.find}/find-email`, { method: 'POST' }); toast(r.found ? `Found verified email via ${r.provider}!` : r.note || `No verified email found at ${r.provider}`); }
    catch (e) { toast(e.message); }
    refresh();
  }));
  $$('[data-dnc]', $('#drawer')).forEach((b) => (b.onclick = async () => { await api(`/contacts/${b.dataset.dnc}`, { method: 'PATCH', body: { dnc: b.dataset.on !== '1' } }); refresh(); }));
  $$('[data-del-contact]', $('#drawer')).forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this person?')) return;
    await api(`/contacts/${b.dataset.delContact}`, { method: 'DELETE' }); toast('Removed'); refresh();
  }));
  const f = $('#addPerson');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try { await api(`/leads/${l.id}/contacts`, { method: 'POST', body: d }); toast('Founder added'); refresh(); } catch (err) { toast(err.message); }
  };
}

function closeDrawer() {
  $('#drawerWrap').classList.remove('open');
  if (location.hash.includes('/')) history.replaceState(null, '', `#${state.view}`);
  if (state.view === 'leads') loadLeads(true);
}
$('#drawerWrap').addEventListener('click', (e) => { if (e.target.id === 'drawerWrap') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------- reddit hiring posts ----------
const rd = { mode: 'inbox', items: [], status: 'open', band: '', segment: '', intent: '', q: '', sel: null, meta: null };
const RD_STATUS = [['open', 'Fresh Posts'], ['lead', 'Qualified Target'], ['replied', 'Outreach Sent'], ['ignored', 'Ignored']];
const RD_ACTIONS = [['replied', 'Mark Outreach Sent', 'R'], ['lead', 'Mark as Target', 'L'], ['ignored', 'Ignore', 'I']];
const rdStatusOf = (i) => (i.status === 'new' ? 'open' : i.status);
const BAND_RANK = { high: 0, research: 1, monitor: 2 };
const sourceLabel = (sub) => (sub ? `r/${sub}` : 'Hiring query');
const capFirst = (x) => String(x || '').replace(/^\w/, (c) => c.toUpperCase());
const whenOf = (i) => i.published_at || i.created_at;

async function loadReddit() {
  $$('#rdMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === rd.mode));
  $('#rdInbox').hidden = rd.mode !== 'inbox';
  $('#rdInsights').hidden = rd.mode !== 'insights';
  if (rd.mode === 'insights') return loadRedditInsights();
  const r = await api('/reddit?status=all');
  rd.items = r.items.sort((a, b) => (BAND_RANK[a.band?.id] ?? 3) - (BAND_RANK[b.band?.id] ?? 3) || new Date(whenOf(b)) - new Date(whenOf(a)));
  rd.meta = r;
  renderRedditFilters();
  renderReddit();
}

function rdFiltered(ignore) {
  const q = rd.q.trim().toLowerCase();
  return rd.items.filter((i) => (ignore === 'status' || rdStatusOf(i) === rd.status)
    && (ignore === 'band' || !rd.band || i.band?.id === rd.band)
    && (!q || `${i.title} ${i.summary || ''} ${i.meta?.sub || ''}`.toLowerCase().includes(q)));
}

function renderRedditFilters() {
  const m = rd.meta || {};
  const n = (key, pred) => rdFiltered(key).filter(pred).length;
  $('#rdStatus').innerHTML = RD_STATUS.map(([k, l]) => `<button role="tab" aria-selected="${rd.status === k}" class="${rd.status === k ? 'on' : ''}" data-k="${k}">${l}<span class="n">${n('status', (i) => rdStatusOf(i) === k)}</span></button>`).join('');
  $$('#rdStatus button').forEach((b) => (b.onclick = () => { rd.status = b.dataset.k; rd.sel = null; renderRedditFilters(); renderReddit(); }));
  const opts = (key, all, list, pred) => `<option value="">${all}</option>` + (list || []).map((x) => `<option value="${esc(x.id)}" ${rd[key] === x.id ? 'selected' : ''}>${esc(x.label)} (${n(key, (i) => pred(i, x.id))})</option>`).join('');
  $('#rdBand').innerHTML = opts('band', 'Any score', (m.bands || []).map((b) => ({ id: b.id, label: `${b.label} ${b.min ? `${b.min}+` : 'under 50'}` })), (i, id) => i.band?.id === id);
}

function renderReddit() {
  const items = rdFiltered();
  if (!items.some((i) => i.id === rd.sel)) rd.sel = window.innerWidth > 900 ? items[0]?.id ?? null : null;
  $('#rdList').innerHTML = items.length ? items.map((i) => {
    const m = i.meta || {};
    const meta = [sourceLabel(m.sub), ago(whenOf(i)).replace(' ago', ''), m.segmentLabel].filter(Boolean);
    return `<button class="ib-row ${i.id === rd.sel ? 'sel' : ''}" role="option" aria-selected="${i.id === rd.sel}" data-id="${i.id}">
      <span class="sc ${i.band?.id}" title="${esc(i.band?.label)}">${i.score ?? 0}</span>
      <span class="ib-main"><span class="ib-title">${esc(i.title)}</span><span class="ib-meta">${meta.map(esc).join(' · ')}</span></span>
    </button>`;
  }).join('') : `<div class="ib-empty"><strong>No hiring posts here.</strong><span>Developer subreddits are checked regularly.</span></div>`;
  $$('#rdList .ib-row').forEach((b) => (b.onclick = () => selectThread(Number(b.dataset.id))));
  renderThread();
}

function selectThread(id) {
  rd.sel = id;
  $$('#rdList .ib-row').forEach((b) => { const on = Number(b.dataset.id) === id; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on); if (on) b.scrollIntoView({ block: 'nearest' }); });
  renderThread();
}

function renderThread() {
  const i = rd.items.find((x) => x.id === rd.sel);
  $('#rdBox').classList.toggle('detail-open', !!i);
  if (!i) { $('#rdDetail').innerHTML = '<div class="ib-placeholder">Select a post.</div>'; return; }
  const m = i.meta || {}, b = i.band || {};
  const status = rdStatusOf(i);
  $('#rdDetail').innerHTML = `
    <button class="dt-back" data-act="back" aria-label="Back to list">← Posts</button>
    <div class="dt-head">
      <span class="sc lg ${b.id}">${i.score ?? 0}</span>
      <div><div class="dt-band">${esc(b.label || '')}${status !== 'open' ? ` <span class="pill">${esc(RD_STATUS.find(([k]) => k === status)?.[1] || status)}</span>` : ''}</div></div>
    </div>
    <h2 class="dt-title"><a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></h2>
    <div class="dt-meta">${m.sub ? `r/${esc(m.sub)} · ` : ''}posted ${ago(whenOf(i))}</div>
    <div class="dt-actions">
      <a class="btn small primary" href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">Open on Reddit <kbd>O</kbd></a>
      ${RD_ACTIONS.filter(([k]) => k !== status).map(([k, l, key]) => `<button class="btn small" data-act="${k}">${l} <kbd>${key}</kbd></button>`).join('')}
      ${status !== 'open' ? '<button class="btn small" data-act="new">Reopen <kbd>U</kbd></button>' : ''}
    </div>
    ${i.summary ? `<section class="dt-sec"><h3>Post summary</h3><p class="dt-quote">${esc(i.summary)}</p></section>` : ''}
    <section class="dt-sec"><div class="dt-sec-head"><h3>Suggested Outreach Angle</h3><button class="link-btn" data-act="copy">Copy</button></div><p>${esc(i.so_what || '')}</p></section>
    <div class="kbd-hint"><kbd>J</kbd><kbd>K</kbd> move · <kbd>O</kbd> open · <kbd>R</kbd> replied · <kbd>L</kbd> target · <kbd>I</kbd> ignore</div>`;
  $$('#rdDetail [data-act]').forEach((el) => (el.onclick = () => threadAction(el.dataset.act)));
}

async function threadAction(act) {
  const i = rd.items.find((x) => x.id === rd.sel);
  if (!i) return;
  if (act === 'back') { rd.sel = null; renderReddit(); return; }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(i.so_what || ''); toast('Outreach angle copied'); } catch { toast('Copy failed'); }
    return;
  }
  if (act === 'open') { window.open(safeUrl(i.url), '_blank', 'noopener'); return; }
  const list = rdFiltered();
  const idx = list.findIndex((x) => x.id === i.id);
  const prev = i.status;
  await api(`/reddit/${i.id}`, { method: 'PATCH', body: { status: act } });
  i.status = act;
  const next = list[idx + 1] || list[idx - 1];
  rd.sel = rdFiltered().some((x) => x.id === i.id) ? i.id : next?.id ?? null;
  renderRedditFilters();
  renderReddit();
  const label = { replied: 'Marked as Outreach Sent', lead: 'Marked as Target', ignored: 'Ignored', new: 'Reopened' }[act];
  toast(label, act === 'new' ? null : { label: 'Undo', fn: async () => { await api(`/reddit/${i.id}`, { method: 'PATCH', body: { status: prev } }); i.status = prev; rd.sel = i.id; renderRedditFilters(); renderReddit(); } });
}

document.addEventListener('keydown', (e) => {
  if (state.view !== 'reddit' || rd.mode !== 'inbox' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(input|select|textarea)$/i.test(e.target.tagName) || $('#drawerWrap')?.classList.contains('open')) return;
  const list = rdFiltered();
  const idx = list.findIndex((x) => x.id === rd.sel);
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') { const n = list[Math.min(list.length - 1, idx + 1)]; if (n) { e.preventDefault(); selectThread(n.id); } }
  else if (k === 'k' || e.key === 'ArrowUp') { const n = list[Math.max(0, idx - 1)]; if (n) { e.preventDefault(); selectThread(n.id); } }
  else if (rd.sel && { o: 'open', r: 'replied', l: 'lead', i: 'ignored', u: 'new' }[k]) { e.preventDefault(); threadAction({ o: 'open', r: 'replied', l: 'lead', i: 'ignored', u: 'new' }[k]); }
});
$('#rdQ').addEventListener('input', (e) => { rd.q = e.target.value; renderRedditFilters(); renderReddit(); });
$('#rdBand').addEventListener('change', (e) => { rd.band = e.target.value; renderRedditFilters(); renderReddit(); });
$$('#rdMode button').forEach((b) => (b.onclick = () => { rd.mode = b.dataset.mode; loadReddit(); }));

async function loadRedditInsights() {
  const [rep] = await Promise.all([api('/reddit/report')]);
  $('#rdInsights').innerHTML = rep.total ? `
    <div class="tiles">
      <div class="tile"><div class="tile-label">Hiring Posts</div><div class="tile-value">${rep.total}</div><div class="tile-sub">last 7 days</div></div>
      <div class="tile"><div class="tile-label">High Priority</div><div class="tile-value">${rep.bands.high || 0}</div><div class="tile-sub">score 80+</div></div>
      <div class="tile"><div class="tile-label">Outreach Sent</div><div class="tile-value">${rep.subs?.reduce((n, x) => n + (x.replied || 0), 0) || 0}</div><div class="tile-sub">of this week's posts</div></div>
    </div>` : '<div class="empty"><strong>No Reddit hiring posts logged in the last 7 days.</strong></div>';
}

// ---------- live stream ----------
const feedRow = (a) => `<div class="fe"><time>${new Date(a.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span class="t t-${esc(a.type)}">${esc(a.type)}</span><span>${esc(a.msg)}</span></div>`;

async function loadLive() {
  const [a, runs] = await Promise.all([api('/activity?n=200'), api('/runs'), loadStats()]);
  $('#liveFeed').innerHTML = a.map((x) => feedRow(x)).join('');
  $('#runsPanel').innerHTML = runs.slice(0, 40).map((r) => `<div><span class="trunc">${esc(r.name || r.source_id)}</span><span class="${r.status === 'error' ? 'status-error' : 'muted'}" style="white-space:nowrap">${r.status === 'error' ? 'error' : r.status === 'deferred' ? 'rate limited' : `${r.new_items} new / ${r.fetched}`} · ${ago(r.started_at)}</span></div>`).join('');
}

function renderFunnel(s) {
  $('#funnel').innerHTML = [
    ['Articles & Feeds Read', s.itemsTotal, `${s.items24h} in last 24h`],
    ['Hiring & Funding Filtered', s.passedTotal, `${s.filteredTotal} dropped as non-hiring/noise`],
    ['Startups Tracked', s.companies, `${s.newToday} discovered today`],
    ['High-Match Opportunities', s.highIntent, `score ${s.threshold}+`],
    ['Active Ingestion Sources', s.sourcesActive, `${s.agentQueries} dynamic queries`],
  ].map(([l, v, sub]) => `<div class="stage"><div class="l">${l}</div><div class="v">${Number(v).toLocaleString('en-IN')}</div><div class="muted small">${sub}</div></div>`).join('');

  const u = s.llm;
  $('#llmPanel').innerHTML = [
    ['Provider', u.provider === 'none' ? 'Rules' : `${u.label || u.provider} · ${u.model}`],
    ['Calls today', `${u.calls} / ${u.cap}`],
    ['Tokens today', `${(u.tokens_in || 0).toLocaleString()} in · ${(u.tokens_out || 0).toLocaleString()} out`],
    ['Extraction mix', `${s.pipeline.via.llm || 0} LLM · ${s.pipeline.via.rules || 0} rules · ${s.pipeline.via.structured || 0} structured`],
  ].map(([k, v]) => `<div><span class="muted">${k}</span><b>${esc(v)}</b></div>`).join('');
  $('#liveCount').textContent = s.running.length ? `scanning: ${s.running.join(', ')}` : '';
}

$('#agentBtn').onclick = async (e) => {
  e.target.disabled = true;
  try { const r = await api('/agent/run', { method: 'POST' }); toast(`Agent planned ${r.added.length} fresh hiring/funding searches`); } catch (err) { toast(err.message); }
  e.target.disabled = false;
};

// ---------- sources ----------
async function loadSources() {
  const rows = await api('/sources');
  const head = '<div class="tr th"><div>Source</div><div>Last scan</div><div>Interval</div><div>Items</div><div></div></div>';
  const groups = [['system', 'Core hiring & funding sources'], ['user', 'Added by you'], ['agent', 'Agent-discovered queries']];
  let html = head;
  for (const [g, label] of groups) {
    const list = rows.filter((r) => r.created_by === g);
    if (!list.length) continue;
    html += `<div class="group-label">${label} · ${list.filter((r) => r.enabled).length} active</div>`;
    html += list.map((s) => {
      const st = s.running ? 'running' : s.last_status || 'pending';
      const detail = s.params.query || s.params.url || (s.params.sub ? `r/${s.params.sub}` : '') || s.params.search || '';
      return `<div class="tr" style="${s.enabled ? '' : 'opacity:.5'}">
        <div style="min-width:0"><b class="trunc" style="display:block">${s.kind === 'reader' ? `<a class="link" href="${esc(safeUrl(s.params.url))}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a>` : esc(s.name)}</b><small class="muted trunc" style="display:block" title="${esc(s.last_error || detail)}">${esc(s.last_error ? `⚠ ${s.last_error}` : detail)}${s.created_by === 'agent' && s.expires_at ? ` · expires ${fmtDate(s.expires_at)}` : ''}${s.params.why ? ` · ${esc(s.params.why)}` : ''}</small></div>
        <div class="small status-${st}">${st === 'running' ? 'fetching…' : !s.enabled ? 'off' : st === 'deferred' ? 'rate limited' : s.last_run_at ? `${st === 'error' ? 'error · ' : st === 'deferred' ? 'rate limited · ' : ''}${ago(s.last_run_at)}` : 'queued'}</div>
        <div class="small muted">${s.cadence_min >= 60 ? `${Math.round(s.cadence_min / 6) / 10}h` : `${s.cadence_min}m`}</div>
        <div class="small">${s.items_total}</div>
        <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
          <button class="btn small" data-run="${esc(s.id)}" ${s.enabled ? '' : 'disabled'}>Run</button>
          ${s.created_by !== 'system' ? `<button class="btn small danger" data-del="${esc(s.id)}" title="Delete">✕</button>` : ''}
          <button class="toggle ${s.enabled ? 'on' : ''}" data-toggle="${esc(s.id)}" data-en="${s.enabled}" title="Enable/disable"><i></i></button>
        </div></div>`;
    }).join('');
  }
  $('#sourceTable').innerHTML = html;
  $$('[data-run]').forEach((b) => (b.onclick = async () => { b.disabled = true; b.textContent = '…'; const r = await api(`/sources/${b.dataset.run}/run`, { method: 'POST' }); toast(r.error ? `Error: ${r.error}` : `Fetched ${r.fetched ?? 0} items, ${r.fresh ?? 0} new`); loadSources(); }));
  $$('[data-toggle]').forEach((b) => (b.onclick = async () => { await api(`/sources/${b.dataset.toggle}`, { method: 'PATCH', body: { enabled: b.dataset.en !== '1' } }); loadSources(); }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (!confirm('Delete this source?')) return; await api(`/sources/${b.dataset.del}`, { method: 'DELETE' }); loadSources(); }));
}

const PLACEHOLDER = { reader: 'https://company.com/careers', ashby: 'Board name, e.g. sarvam', rss: 'https://example.com/feed', gnews: 'Seed startup raised hiring Bangalore', reddit: 'developersIndia or hiring', hn: 'Who is hiring' };
$('#srcKind').onchange = (e) => ($('#srcValue').placeholder = PLACEHOLDER[e.target.value]);
function sourceBody() {
  const f = new FormData($('#addSource'));
  const kind = f.get('kind');
  const v = String(f.get('value') || '').trim();
  const body = { kind, category: f.get('category'), name: f.get('name') || undefined };
  if (kind === 'rss' || kind === 'reader') body.url = v;
  else if (kind === 'ashby') body.board = v;
  else if (kind === 'reddit') { if (v.startsWith('search:')) body.search = v.slice(7).trim(); else body.sub = v.replace(/^\/?r\//, ''); }
  else body.query = v;
  return body;
}
$('#testSrc').onclick = async () => {
  $('#srcTest').textContent = 'Fetching…';
  try {
    const r = await api('/sources/test', { method: 'POST', body: sourceBody() });
    $('#srcTest').innerHTML = `<b>${r.count} items found.</b><ul>${r.sample.map((s) => `<li>${esc(s.title)} <span class="muted">${s.date ? fmtDate(s.date) : ''}</span></li>`).join('')}</ul>`;
  } catch (e) { $('#srcTest').textContent = `Error: ${e.message}`; }
};
$('#addSource').onsubmit = async (e) => {
  e.preventDefault();
  $('#srcTest').textContent = 'Validating and adding…';
  try {
    const r = await api('/sources', { method: 'POST', body: sourceBody() });
    $('#srcTest').textContent = `Added. ${r.fetched} items fetched, ${r.fresh} queued.`;
    e.target.reset();
    loadSources();
  } catch (err) { $('#srcTest').textContent = `Error: ${err.message}`; }
};

// ---------- config & candidate profile ----------
const WEIGHT_HELP = {
  funding: 'Seed / Pre-seed / Series A funding freshness and stage',
  hiringSignal: 'Explicit hiring announcements, founding engineer, developer posts',
  smallTeam: 'Small team (<=50 headcount) where founders hire directly without HR',
  techMatch: 'Tech stack match with candidate core skills',
  recency: 'Time since the latest dated hiring or funding publication',
  hasEmail: 'Verified founder or decision-maker email found',
  novelty: 'Freshly discovered startup opportunity'
};

async function loadConfig() {
  const [r, cand] = await Promise.all([api('/config'), api('/candidate').catch(() => null)]);
  state.config = r.config;
  renderConfigForm(r.config, r.learned);

  if (cand) {
    if ($('#candName')) $('#candName').value = cand.name || '';
    if ($('#candRoles')) $('#candRoles').value = (cand.targetRoles || []).join(', ');
    if ($('#candSkills')) $('#candSkills').value = (cand.skills || []).join(', ');
    if ($('#candPortfolio')) $('#candPortfolio').value = cand.portfolioUrl || '';
    if ($('#candGithub')) $('#candGithub').value = cand.githubUrl || '';
    if ($('#candLinkedin')) $('#candLinkedin').value = cand.linkedinUrl || '';
    if ($('#candExp')) $('#candExp').value = cand.experience || '';
    if ($('#candPitch')) $('#candPitch').value = cand.oneLinerPitch || '';
  }
}

function renderConfigForm(c, learned = {}) {
  const range = (path, val, min, max, step = 1) => `<input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${val}" oninput="this.nextElementSibling.value=this.value"><output>${val}</output>`;
  const list = (path, arr) => `<textarea class="input" data-list="${path}" rows="3">${esc((arr || []).join(', '))}</textarea>`;
  const totalW = Object.values(c.weights || {}).reduce((a, b) => a + b, 0);

  $('#configForm').innerHTML = `
    <div class="panel"><div class="panel-head"><h3>Opportunity Fit Weights</h3><span class="muted small">total ${totalW} pts</span></div>
      ${Object.entries(c.weights || {}).map(([k, v]) => `<div class="cfg-row" title="${esc(WEIGHT_HELP[k] || '')}"><span>${esc(k)}<br><small class="muted">${esc(WEIGHT_HELP[k] || '')}</small></span>${range(`weights.${k}`, v, 0, 50)}</div>`).join('')}
      <div class="cfg-row"><span><b>High-Match Threshold</b></span>${range('threshold', c.threshold, 20, 90)}</div></div>
    <div class="panel"><div class="panel-head"><h3>Sector Fit</h3><span class="muted small">0 = ignore, 1 = ideal</span></div>
      ${Object.entries(c.sectors || {}).map(([k, v]) => `<div class="cfg-row"><span>${esc(k)}</span>${range(`sectors.${k}`, v, 0, 1, 0.05)}</div>`).join('')}</div>
    <div class="panel"><div class="panel-head"><h3>Penalties & Boundaries</h3></div>
      ${Object.entries(c.penalties || {}).map(([k, v]) => `<div class="cfg-row"><span>${esc(k)}</span>${range(`penalties.${k}`, v, -50, 0)}</div>`).join('')}
      <div class="cfg-row"><span>Recency half-life (days)</span>${range('recencyHalfLifeDays', c.recencyHalfLifeDays, 7, 120)}</div></div>
    <div class="panel"><div class="panel-head"><h3>Targeting Keywords</h3></div><p class="hint">Comma separated.</p>
      <div class="cfg-field"><label>Hiring & Role Keywords</label>${list('keywords.hiring', c.keywords?.hiring || [])}</div>
      <div class="cfg-field"><label>Preferred Funding Stages</label>${list('preferredStages', c.preferredStages || [])}</div>
      <div class="cfg-field"><label>Enterprise Watch List (Deprioritized)</label>${list('enterpriseNames', c.enterpriseNames || [])}</div>
      <div class="cfg-field"><label>Blocklist (Staffing agencies, job boards, aggregators)</label>${list('blocklist', c.blocklist || [])}</div></div>
    <div class="panel"><div class="panel-head"><h3>Outreach settings</h3></div>
      <div class="cfg-row"><span>Daily outbound quota</span>${range('dailyQuota', c.dailyQuota || 20, 5, 50)}</div>
      <div class="cfg-row"><span>Small team max headcount (founder direct hiring)</span>${range('contacts.smallTeamMax', c.contacts?.smallTeamMax || 50, 5, 200, 5)}</div>
      <div class="cfg-field"><label>Email lookup provider (API key required on server)</label><select class="input" data-path="contacts.emailProvider">${['auto', 'apollo', 'hunter', 'sprouts'].map((v) => `<option value="${v}" ${c.contacts?.emailProvider === v ? 'selected' : ''}>${v === 'auto' ? 'Auto (whichever API key is configured)' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></div>
      <div class="cfg-row"><span>Monthly lookup cap</span>${range('contacts.monthlyLookupCap', c.contacts?.monthlyLookupCap || 100, 0, 1000, 10)}</div></div>`;
  $('#cfgRaw').value = JSON.stringify(c, null, 2);
}

function readConfigForm() {
  const c = structuredClone(state.config);
  const set = (path, val) => { const ks = path.split('.'); let o = c; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = val; };
  $$('#configForm [data-path]').forEach((el) => set(el.dataset.path, el.tagName === 'SELECT' ? el.value : Number(el.value)));
  $$('#configForm [data-list]').forEach((el) => set(el.dataset.list, el.value.split(',').map((s) => s.trim()).filter(Boolean)));
  return c;
}

$('#cfgPreview').onclick = async () => {
  const draft = readConfigForm();
  const r = await api('/config/preview', { method: 'POST', body: { config: draft } });
  $('#previewPanel').hidden = false;
  $('#previewSummary').textContent = `${r.movedIntoHigh} startups would enter high priority, ${r.movedOutOfHigh} would drop out`;
  $('#previewTable').innerHTML = `<div class="table" style="box-shadow:none">${r.preview.map((p) => {
    const d = p.after - p.before;
    return `<div class="tr" style="grid-template-columns:1fr 100px 60px 60px 70px"><b>${esc(p.name)}</b><span class="small muted">${esc(p.sector)}</span><span class="small">${p.before}</span><span class="small"><b>${p.after}</b></span><span class="small ${d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : 'muted'}">${d > 0 ? '+' : ''}${d}</span></div>`;
  }).join('')}</div>`;
  $('#previewPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

$('#cfgSave').onclick = async () => {
  const r = await api('/config', { method: 'PUT', body: { config: readConfigForm() } });
  state.config = r.config;
  toast('Config saved. All startups rescored against your criteria.');
  loadConfig();
};

$('#cfgReset').onclick = async () => { if (!confirm('Reset all config to defaults?')) return; await api('/config/reset', { method: 'POST' }); toast('Defaults restored'); loadConfig(); };
$('#cfgRawApply').onclick = () => { try { state.config = JSON.parse($('#cfgRaw').value); renderConfigForm(state.config); toast('Applied to form. Preview or save.'); } catch (e) { toast(`Invalid JSON: ${e.message}`); } };

const saveCandBtn = $('#saveCandidateBtn');
if (saveCandBtn) {
  saveCandBtn.onclick = async () => {
    const body = {
      name: $('#candName').value.trim(),
      targetRoles: $('#candRoles').value.split(',').map((s) => s.trim()).filter(Boolean),
      skills: $('#candSkills').value.split(',').map((s) => s.trim()).filter(Boolean),
      portfolioUrl: $('#candPortfolio').value.trim(),
      githubUrl: $('#candGithub').value.trim(),
      linkedinUrl: $('#candLinkedin').value.trim(),
      experience: $('#candExp').value.trim(),
      oneLinerPitch: $('#candPitch').value.trim()
    };
    try {
      await api('/candidate', { method: 'PUT', body });
      toast('Profile saved.');
      loadStats();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- scan ----------
$('#scanBtn').onclick = async () => {
  $('#scanBtn').classList.add('scanning');
  await api('/scan', { method: 'POST' });
  toast('Scan requested.');
  setTimeout(loadStats, 1500);
};

// ---------- live stream ----------
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('activity', (e) => {
    const a = JSON.parse(e.data);
    if (state.view === 'live') { $('#liveFeed').insertAdjacentHTML('afterbegin', feedRow(a)); const f = $('#liveFeed'); while (f.children.length > 300) f.lastChild.remove(); }
  });
  es.addEventListener('lead', (e) => {
    const l = JSON.parse(e.data);
    if (l.kind === 'new') {
      state.pendingLeads++;
      if (state.view === 'brief' || state.view === 'leads') {
        toast(`${state.pendingLeads} new startup opportunit${state.pendingLeads > 1 ? 'ies' : 'y'} found (latest: ${l.name})`, { label: 'Refresh', fn: () => (state.view === 'brief' ? loadBrief() : loadLeads(true)) });
      }
    }
  });
  let statsTimer;
  const refreshStats = () => { clearTimeout(statsTimer); statsTimer = setTimeout(loadStats, 800); };
  es.addEventListener('stats', refreshStats);
  es.addEventListener('source', () => { refreshStats(); if (state.view === 'sources') { clearTimeout(window.__srcT); window.__srcT = setTimeout(loadSources, 1200); } });
  es.onerror = () => { $('#engine').className = 'engine off'; $('#engineText').textContent = 'Reconnecting…'; };
  es.onopen = () => loadStats();
}

route();
if (!new URLSearchParams(location.search).has('static')) {
  connectStream();
  setInterval(loadStats, 20000);
}

fetch('/api/health').then((r) => r.json()).then((h) => {
  if (!h.auth) return;
  const b = $('#logoutBtn');
  b.hidden = false;
  b.onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/login'; };
}).catch(() => {});
