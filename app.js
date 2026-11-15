/* RAFT Front Desk — static single-page app on Supabase (schema "raft").
   Every query names its columns; columns a role cannot see are never requested. */
'use strict';

const sb = window.supabase.createClient(
  'https://yiyzyiqxpmccicxyhxco.supabase.co',
  'sb_publishable_vxxZml6lBY31_VVvbksdRQ_aMo-YRWa',
  { db: { schema: 'raft' } }
);

/* ---------- Roles ---------- */
// What each database role may see (read) and do (write), mirroring the grants in the database.
const ROLES = {
  raft_admin: {
    label: 'Admin',
    seeWage: true, seeNotes: true, seeAssignment: true,
    editRecords: true,   // add/change people, clients, appointments, scheduled clients
    editNotes: true,     // appointment.notes, scheduledfor.assignment
    editKept: true,
  },
  raft_scheduler: {
    label: 'Scheduler',
    seeWage: false, seeNotes: false, seeAssignment: false,
    editRecords: true, editNotes: false, editKept: true,
  },
  raft_counselor: {
    label: 'Counselor',
    seeWage: false, seeNotes: true, seeAssignment: true,
    editRecords: false, editNotes: true, editKept: true,
  },
};

let session = null;
let currentUid = null;
let flash = null; // one-time message shown on the next render

function roleKeyFrom(s) {
  try {
    const part = s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(part.padEnd(part.length + (4 - (part.length % 4)) % 4, '='))
        .split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    return JSON.parse(json).role || null;
  } catch { return null; }
}
const role = () => (session ? ROLES[roleKeyFrom(session)] || null : null);

/* ---------- Column lists ---------- */
const PERSON_COLS = 'personid,firstname,lastname,address,city,state,zip,phone,email';
const CLIENT_COLS = 'clientid,foundout,remindermethod,referredby';
const apptCols = r => 'appointmentid,appointmenttime,duration,counselorid,employeeid,roomnumber' + (r.seeNotes ? ',notes' : '');
const sfCols = r => 'appointmentid,clientid,kept' + (r.seeAssignment ? ',assignment' : '');
const empCols = r => 'employeeid,datehired,supervisorid' + (r.seeWage ? ',wage' : '');

/* ---------- Helpers ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fullName = p => (p ? [p.firstname, p.lastname].filter(Boolean).join(' ') || `Person #${p.personid}` : '—');
const byId = (rows, key) => new Map(rows.map(r => [r[key], r]));
const uniq = arr => [...new Set(arr.filter(v => v !== null && v !== undefined))];
const blankToNull = v => { const t = (v ?? '').trim(); return t === '' ? null : t; };

// "timestamp" columns have no time zone: parse as local time.
function parseTs(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
const fmtTs = s => { const d = parseTs(s); return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };
// "date" columns: format without converting through UTC.
function fmtDate(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { dateStyle: 'medium' });
}
const fmtKept = k => (k === true ? 'Kept' : k === false ? 'Not kept' : 'Not recorded');
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');

async function run(builder) {
  const { data, error } = await builder;
  if (error) throw error;
  return data;
}

// Fetch every row (pages of 1000, the API's default cap).
async function fetchAll(table, cols, order, filter = b => b) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let b = filter(sb.from(table).select(cols));
    for (const o of order) b = b.order(o);
    const data = await run(b.range(from, from + 999));
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Fetch rows whose `col` is in `ids`, in chunks to keep URLs short.
async function fetchIn(table, cols, col, ids) {
  ids = uniq(ids);
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    out.push(...(await run(sb.from(table).select(cols).in(col, ids.slice(i, i + 150)))));
  }
  return out;
}

function errorHtml(e) {
  return `<div class="msg error" role="alert">${esc(e?.message || String(e))}</div>`;
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  return { path: path || 'home', params: new URLSearchParams(qs || '') };
}

/* ---------- Auth & routing ---------- */
sb.auth.onAuthStateChange((event, s) => {
  session = s;
  const uid = s?.user?.id ?? null;
  // Re-render only when who is signed in changes (not on token refresh), so open forms keep their input.
  if (event === 'INITIAL_SESSION' || uid !== currentUid) {
    currentUid = uid;
    setTimeout(route, 0);
  }
});
window.addEventListener('hashchange', route);

function route() {
  const app = $('#app');
  if (!session) return renderSignIn(app);
  const r = role();
  if (!r) return renderNoRole(app);

  const { path, params } = parseHash();
  const screens = { home: renderHome, lookup: renderLookup, dashboard: renderDashboard, edit: renderEdit };
  const screen = screens[path] ? path : 'home';
  app.innerHTML = shell(screen, r) + `<main id="main"><p class="loading">Loading…</p></main>`;
  $('#signout').addEventListener('click', signOut);
  const main = $('#main');
  const msg = flash; flash = null;
  screens[screen](main, r, params).then(() => {
    if (msg) main.insertAdjacentHTML('afterbegin', `<div class="msg ok" role="status">${esc(msg)}</div>`);
  }).catch(e => { main.innerHTML = errorHtml(e); });
}

function shell(active, r) {
  const link = (key, text) => `<a href="#/${key}" class="${active === key ? 'active' : ''}">${text}</a>`;
  return `
  <header class="top">
    <a class="brand" href="#/home">RAFT Front Desk</a>
    <nav class="main" aria-label="Main">
      ${link('home', 'Home')}${link('lookup', 'Client lookup')}${link('dashboard', 'Dashboard')}${link('edit', r.editRecords ? 'Add or edit' : 'Edit notes')}
    </nav>
    <div class="who">
      <span class="badge" title="Signed-in role">${esc(r.label)}</span>
      <span class="muted">${esc(session.user.email)}</span>
      <button id="signout" class="secondary">Sign out</button>
    </div>
  </header>`;
}

async function signOut() {
  await sb.auth.signOut();
  location.hash = '';
}

function renderSignIn(app) {
  app.innerHTML = `
  <div class="signin">
    <h1>RAFT Front Desk</h1>
    <p class="muted">Richmond Area Family Therapy — staff sign-in</p>
    <div class="card">
      <form id="signin-form" novalidate>
        <div><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>
        <div><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>
        <div id="signin-msg"></div>
        <button type="submit">Sign in</button>
      </form>
    </div>
  </div>`;
  const form = $('#signin-form');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = $('#email').value.trim();
    const password = $('#password').value;
    const msg = $('#signin-msg');
    if (!email || !password) { msg.innerHTML = errorHtml('Enter your email and password.'); return; }
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Signing in…'; msg.innerHTML = '';
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      const bad = error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message);
      msg.innerHTML = errorHtml(bad ? 'The email or password is incorrect. Please try again.' : error.message);
      btn.disabled = false; btn.textContent = 'Sign in';
    }
    // On success onAuthStateChange renders the home screen.
  });
}

function renderNoRole(app) {
  app.innerHTML = `
  <div class="signin">
    <h1>RAFT Front Desk</h1>
    <div class="card">
      <p>You are signed in as <strong>${esc(session.user.email)}</strong>, but this account has no RAFT staff role
      (Admin, Scheduler or Counselor), so no data can be shown.</p>
      <button id="signout">Sign out</button>
    </div>
  </div>`;
  $('#signout').addEventListener('click', signOut);
}

/* ---------- Shared lookups ---------- */
async function loadNames(ids) {
  return byId(await fetchIn('person', 'personid,firstname,lastname', 'personid', ids), 'personid');
}

/* ---------- Screen 1: Home ---------- */
const HOME_LIMIT = 10;
// "timestamp" literal for the current local time, to compare against appointmenttime.
function nowTs() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

async function renderHome(main, r) {
  main.innerHTML = `
    <h1>Welcome</h1>
    <p class="muted">Signed in as ${esc(session.user.email)} · Role: <strong>${esc(r.label)}</strong></p>
    <div class="grid" style="margin-top:1rem">
      <a class="card tile" href="#/lookup"><strong>Client lookup</strong>Find a client and see their contact details, appointments and families.</a>
      <a class="card tile" href="#/dashboard"><strong>Dashboard</strong>Key statistics about RAFT, calculated from the database.</a>
      <a class="card tile" href="#/edit"><strong>${r.editRecords ? 'Add or edit a record' : 'Edit appointment notes'}</strong>${
        r.editRecords ? 'Add a new client or appointment, or change an existing one.'
                      : 'Update session notes, homework assignments and whether appointments were kept.'}</a>
    </div>
    <h2 id="appts-heading">Appointments</h2>
    <div class="card" id="today"><p class="loading">Loading…</p></div>`;

  try {
    const cols = 'appointmentid,appointmenttime,duration,counselorid,roomnumber';
    const now = nowTs();
    // Upcoming appointments first; if there are none, the most recent past ones.
    let appts = await run(sb.from('appointment').select(cols)
      .gte('appointmenttime', now).order('appointmenttime').limit(HOME_LIMIT));
    let heading = 'Upcoming appointments';
    if (!appts.length) {
      appts = await run(sb.from('appointment').select(cols)
        .lt('appointmenttime', now).order('appointmenttime', { ascending: false }).limit(HOME_LIMIT));
      heading = 'Most recent appointments';
    }
    $('#appts-heading').textContent = heading;
    const box = $('#today');
    if (!appts.length) { box.innerHTML = '<p class="muted">There are no appointments in the database yet.</p>'; return; }
    if (heading.startsWith('Most')) box.insertAdjacentHTML('beforebegin',
      '<p class="muted" style="margin-top:-.25rem">Nothing is scheduled from now on, so these are the latest appointments on record.</p>');
    const ids = appts.map(a => a.appointmentid);
    const [sf, rooms] = await Promise.all([
      fetchIn('scheduledfor', 'appointmentid,clientid', 'appointmentid', ids),
      fetchIn('room', 'roomnumber,roomname', 'roomnumber', appts.map(a => a.roomnumber)),
    ]);
    const names = await loadNames([...appts.map(a => a.counselorid), ...sf.map(s => s.clientid)]);
    const roomMap = byId(rooms, 'roomnumber');
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Clients</th><th>Counselor</th><th>Room</th><th class="num">Minutes</th></tr></thead>
      <tbody>${appts.map(a => `<tr>
        <td>${fmtTs(a.appointmenttime)}</td>
        <td>${sf.filter(s => s.appointmentid === a.appointmentid)
              .map(s => `<a href="#/lookup?id=${s.clientid}">${esc(fullName(names.get(s.clientid)))}</a>`).join(', ') || '—'}</td>
        <td>${esc(fullName(names.get(a.counselorid)))}</td>
        <td>${esc(roomLabel(roomMap.get(a.roomnumber), a.roomnumber))}</td>
        <td class="num">${a.duration ?? '—'}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { $('#today').innerHTML = errorHtml(e); }
}

const roomLabel = (room, num) => (room?.roomname ? `${room.roomnumber} · ${room.roomname}` : `Room ${num}`);

/* ---------- Screen 2: Client lookup ---------- */
async function renderLookup(main, r, params) {
  const q = params.get('q') || '';
  const id = params.get('id');
  main.innerHTML = `
    <h1>Client lookup</h1>
    <form id="search" class="search" role="search">
      <input id="q" type="search" placeholder="Name, email, phone or client ID" value="${esc(q)}" aria-label="Search clients">
      <button type="submit">Search</button>
    </form>
    <div class="two-col" style="margin-top:1rem; grid-template-columns: minmax(220px, 1fr) minmax(0, 2.5fr)">
      <div class="card"><div id="results"><p class="loading">Loading…</p></div></div>
      <div id="detail">${id ? '<p class="loading">Loading…</p>' : '<div class="card muted">Select a client to see their details.</div>'}</div>
    </div>`;
  $('#search').addEventListener('submit', ev => {
    ev.preventDefault();
    const v = $('#q').value.trim();
    location.hash = '#/lookup' + (v ? '?q=' + encodeURIComponent(v) : '');
  });

  const tasks = [searchClients(q).then(list => {
    $('#results').innerHTML = list.length
      ? `<p class="muted" style="margin-top:0">${list.length} client${list.length === 1 ? '' : 's'}</p>
         <ul class="results">${list.map(p => `<li><a class="${String(p.personid) === id ? 'active' : ''}"
           href="#/lookup?${q ? 'q=' + encodeURIComponent(q) + '&' : ''}id=${p.personid}">
           ${esc(fullName(p))}<br><span class="muted">#${p.personid}${p.phone ? ' · ' + esc(p.phone) : ''}</span></a></li>`).join('')}</ul>`
      : '<p class="muted">No clients match.</p>';
  }).catch(e => { $('#results').innerHTML = errorHtml(e); })];
  if (id) tasks.push(renderClientDetail($('#detail'), r, Number(id)).catch(e => { $('#detail').innerHTML = errorHtml(e); }));
  await Promise.all(tasks);
}

async function searchClients(text) {
  // Keep only characters that are safe inside a PostgREST filter value.
  const words = text.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}@.\-']/gu, '')).filter(Boolean);
  let persons;
  if (!words.length) {
    const clients = await fetchAll('client', 'clientid', ['clientid']);
    persons = await fetchIn('person', 'personid,firstname,lastname,phone,email', 'personid', clients.map(c => c.clientid));
  } else {
    const w = words[0];
    const ors = ['firstname', 'lastname', 'email', 'phone'].map(c => `${c}.ilike.*${w}*`);
    if (/^\d+$/.test(w)) ors.push(`personid.eq.${w}`);
    const found = await run(sb.from('person').select('personid,firstname,lastname,phone,email').or(ors.join(',')).limit(500));
    const clientIds = new Set((await fetchIn('client', 'clientid', 'clientid', found.map(p => p.personid))).map(c => c.clientid));
    const rest = words.slice(1).map(x => x.toLowerCase());
    persons = found.filter(p => clientIds.has(p.personid)).filter(p => {
      const hay = [p.personid, p.firstname, p.lastname, p.email, p.phone].join(' ').toLowerCase();
      return rest.every(x => hay.includes(x));
    });
  }
  return persons.sort((a, b) => (a.lastname || '').localeCompare(b.lastname || '') || (a.firstname || '').localeCompare(b.firstname || ''));
}

async function renderClientDetail(box, r, id) {
  const [person] = await run(sb.from('person').select(PERSON_COLS).eq('personid', id));
  const [client] = await run(sb.from('client').select(CLIENT_COLS).eq('clientid', id));
  if (!person || !client) { box.innerHTML = '<div class="card">No client with ID ' + esc(id) + '.</div>'; return; }

  const [sf, memberships, memberRoles] = await Promise.all([
    run(sb.from('scheduledfor').select(sfCols(r)).eq('clientid', id)),
    run(sb.from('member_in_family').select('familyid,memberid,datejoined').eq('memberid', id)),
    run(sb.from('member_role').select('familyid,memberid,roleid').eq('memberid', id)),
  ]);
  const [appts, families, roles, rooms] = await Promise.all([
    fetchIn('appointment', apptCols(r), 'appointmentid', sf.map(s => s.appointmentid)),
    fetchIn('family', 'familyid,familyname,datefounded', 'familyid', memberships.map(m => m.familyid)),
    fetchIn('role', 'roleid,rolename', 'roleid', memberRoles.map(m => m.roleid)),
    fetchAll('room', 'roomnumber,roomname', ['roomnumber']),
  ]);
  const names = await loadNames([client.referredby, ...appts.map(a => a.counselorid), ...appts.map(a => a.employeeid)]);
  const roomMap = byId(rooms, 'roomnumber');
  const famMap = byId(families, 'familyid');
  const roleMap = byId(roles, 'roleid');
  const sfMap = byId(sf, 'appointmentid');
  const now = new Date();
  appts.sort((a, b) => (b.appointmenttime || '').localeCompare(a.appointmenttime || ''));

  const addr = [person.address, [person.city, person.state].filter(Boolean).join(', '), person.zip].filter(Boolean).join(' ');
  const canEditAppt = r.editRecords || r.editNotes;

  box.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">${esc(fullName(person))} <span class="muted" style="font-weight:400">#${person.personid}</span></h2>
      <dl class="kv">
        <dt>Phone</dt><dd>${esc(person.phone || '—')}</dd>
        <dt>Email</dt><dd>${person.email ? `<a href="mailto:${esc(person.email)}">${esc(person.email)}</a>` : '—'}</dd>
        <dt>Address</dt><dd>${esc(addr || '—')}</dd>
        <dt>Reminder method</dt><dd>${esc(client.remindermethod || '—')}</dd>
        <dt>Found out via</dt><dd>${esc(client.foundout || '—')}</dd>
        <dt>Referred by</dt><dd>${client.referredby ? `<a href="#/lookup?id=${client.referredby}">${esc(fullName(names.get(client.referredby)))}</a>` : '—'}</dd>
      </dl>
      ${r.editRecords ? `<div class="actions"><a class="btn secondary" href="#/edit?type=client&id=${id}">Edit client</a>
        <a class="btn secondary" href="#/edit?type=appointment&client=${id}">New appointment</a></div>` : ''}
    </div>

    <div class="card">
      <h3 style="margin-top:0">Families</h3>
      ${memberships.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Family</th><th>Role(s) in this family</th><th>Joined</th><th>Family founded</th></tr></thead>
        <tbody>${memberships.map(m => {
          const f = famMap.get(m.familyid);
          const rs = memberRoles.filter(x => x.familyid === m.familyid).map(x => roleMap.get(x.roleid)?.rolename).filter(Boolean);
          return `<tr><td>${esc(f?.familyname || 'Family #' + m.familyid)}</td><td>${esc(rs.join(', ') || '—')}</td>
            <td>${fmtDate(m.datejoined)}</td><td>${fmtDate(f?.datefounded)}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<p class="muted">Not a member of any family.</p>'}
    </div>

    <div class="card">
      <h3 style="margin-top:0">Appointments (${appts.length})</h3>
      ${appts.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th class="num">Min</th><th>Counselor</th><th>Room</th><th>Booked by</th><th>Kept</th>
          ${r.seeAssignment ? '<th>Assignment</th>' : ''}${r.seeNotes ? '<th>Notes</th>' : ''}${canEditAppt ? '<th></th>' : ''}</tr></thead>
        <tbody>${appts.map(a => {
          const s = sfMap.get(a.appointmentid) || {};
          const upcoming = parseTs(a.appointmenttime) >= now;
          return `<tr>
            <td>${fmtTs(a.appointmenttime)} ${upcoming ? '<span class="tag">Upcoming</span>' : ''}</td>
            <td class="num">${a.duration ?? '—'}</td>
            <td>${esc(fullName(names.get(a.counselorid)))}</td>
            <td>${esc(roomLabel(roomMap.get(a.roomnumber), a.roomnumber))}</td>
            <td>${esc(fullName(names.get(a.employeeid)))}</td>
            <td>${upcoming && s.kept == null ? '—' : fmtKept(s.kept)}</td>
            ${r.seeAssignment ? `<td class="pre">${esc(s.assignment || '')}</td>` : ''}
            ${r.seeNotes ? `<td class="pre">${esc(a.notes || '')}</td>` : ''}
            ${canEditAppt ? `<td><a href="#/edit?type=appointment&id=${a.appointmentid}">${r.editRecords ? 'Edit' : 'Notes'}</a></td>` : ''}
          </tr>`;
        }).join('')}</tbody></table></div>` : '<p class="muted">No appointments.</p>'}
    </div>`;
}

/* ---------- Screen 3: Dashboard ---------- */
async function renderDashboard(main, r) {
  const [persons, clients, counselors, employees, families, mif, rooms, appts, sf] = await Promise.all([
    fetchAll('person', 'personid,firstname,lastname', ['personid']),
    fetchAll('client', CLIENT_COLS, ['clientid']),
    fetchAll('counselor', 'counselorid,degreesuffix', ['counselorid']),
    fetchAll('employee', empCols(r), ['employeeid']),
    fetchAll('family', 'familyid,familyname,datefounded', ['familyid']),
    fetchAll('member_in_family', 'familyid,memberid', ['familyid', 'memberid']),
    fetchAll('room', 'roomnumber,roomname', ['roomnumber']),
    fetchAll('appointment', 'appointmentid,appointmenttime,duration,counselorid,roomnumber', ['appointmentid']),
    fetchAll('scheduledfor', 'appointmentid,clientid,kept', ['appointmentid', 'clientid']),
  ]);
  const names = byId(persons, 'personid');
  const now = new Date();
  const in7 = new Date(now.getTime() + 7 * 864e5);
  const apptTime = new Map(appts.map(a => [a.appointmentid, parseTs(a.appointmenttime)]));

  const upcoming7 = appts.filter(a => { const d = apptTime.get(a.appointmentid); return d && d >= now && d < in7; }).length;
  const thisMonth = appts.filter(a => { const d = apptTime.get(a.appointmentid); return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(); }).length;
  const pastSf = sf.filter(s => { const d = apptTime.get(s.appointmentid); return d && d < now; });
  const recorded = pastSf.filter(s => s.kept !== null);
  const kept = recorded.filter(s => s.kept).length;
  const durations = appts.map(a => a.duration).filter(d => d != null);
  const avgDur = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;
  const referred = clients.filter(c => c.referredby != null).length;
  const activeClients = new Set(sf.filter(s => { const d = apptTime.get(s.appointmentid); return d && d >= now; }).map(s => s.clientid)).size;
  const famSizes = families.map(f => mif.filter(m => m.familyid === f.familyid).length);
  const avgFam = famSizes.length ? (famSizes.reduce((a, b) => a + b, 0) / famSizes.length).toFixed(1) : '—';

  const count = (rows, key) => {
    const m = new Map();
    for (const x of rows) { const k = (x[key] ?? '').toString().trim() || 'Not recorded'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  // Appointments per month: 6 months back through 2 months ahead of this month.
  // If that window is empty (e.g. all appointments are in the past), center it on the latest appointment instead.
  const times = [...apptTime.values()].filter(Boolean);
  const inWindow = (t, a) => { const m = (t.getFullYear() - a.getFullYear()) * 12 + t.getMonth() - a.getMonth(); return m >= -6 && m <= 2; };
  const latest = times.length ? new Date(Math.max(...times)) : now;
  const anchor = times.some(t => inWindow(t, now)) ? now : latest;
  const months = [];
  for (let i = -6; i <= 2; i++) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() + i, 1);
    const n = times.filter(t => t.getFullYear() === d.getFullYear() && t.getMonth() === d.getMonth()).length;
    const isNow = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    months.push([d.toLocaleDateString([], { month: 'short', year: 'numeric' }) + (isNow ? ' (this month)' : ''), n]);
  }
  const monthsNote = anchor === now ? '' :
    `<p class="muted" style="margin-top:0">No appointments around this month; showing the months around the latest appointment (${esc(latest.toLocaleDateString([], { dateStyle: 'medium' }))}).</p>`;

  const byCounselor = counselors.map(c => {
    const mine = appts.filter(a => a.counselorid === c.counselorid);
    const ids = new Set(mine.map(a => a.appointmentid));
    const rec = recorded.filter(s => ids.has(s.appointmentid));
    return {
      name: fullName(names.get(c.counselorid)) + (c.degreesuffix ? ', ' + c.degreesuffix : ''),
      total: mine.length,
      upcoming: mine.filter(a => apptTime.get(a.appointmentid) >= now).length,
      clients: new Set(sf.filter(s => ids.has(s.appointmentid)).map(s => s.clientid)).size,
      keptRate: pct(rec.filter(s => s.kept).length, rec.length),
    };
  }).sort((a, b) => b.total - a.total);

  const byRoom = rooms.map(rm => {
    const mine = appts.filter(a => a.roomnumber === rm.roomnumber);
    return [roomLabel(rm, rm.roomnumber), mine.length, Math.round(mine.reduce((s, a) => s + (a.duration || 0), 0) / 60)];
  }).sort((a, b) => b[1] - a[1]);

  const wages = r.seeWage ? employees.map(e => e.wage).filter(w => w != null).map(Number) : [];

  const stat = (num, label) => `<div class="card stat"><div class="num">${esc(num)}</div><div class="label">${esc(label)}</div></div>`;
  const bars = rows => {
    const max = Math.max(1, ...rows.map(x => x[1]));
    return rows.length ? `<div class="bars">${rows.map(([k, v]) => `<span>${esc(k)}</span>
      <div class="track" role="img" aria-label="${esc(k)}: ${v}"><div class="fill" style="width:${(100 * v) / max}%"></div></div>
      <span class="v">${v}</span>`).join('')}</div>` : '<p class="muted">No data.</p>';
  };

  main.innerHTML = `
    <h1>Dashboard</h1>
    <p class="muted">Calculated live from the RAFT database · ${esc(now.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</p>
    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-top:1rem">
      ${stat(clients.length, 'Clients')}
      ${stat(activeClients, 'Clients with upcoming appointments')}
      ${stat(counselors.length, 'Counselors')}
      ${stat(employees.length, 'Employees')}
      ${stat(families.length, 'Families')}
      ${stat(rooms.length, 'Rooms')}
      ${stat(appts.length, 'Appointments (all time)')}
      ${stat(upcoming7, 'Appointments in the next 7 days')}
      ${stat(thisMonth, 'Appointments this month')}
      ${stat(pct(kept, recorded.length), `Kept rate (${kept} of ${recorded.length} recorded)`)}
      ${stat(avgDur != null ? avgDur + ' min' : '—', 'Average appointment length')}
      ${stat(pct(referred, clients.length), `Clients referred by a client (${referred})`)}
      ${stat(avgFam, 'Average family size')}
      ${r.seeWage ? stat(wages.length ? '$' + (wages.reduce((a, b) => a + b, 0) / wages.length).toFixed(2) : '—', 'Average employee wage') : ''}
    </div>

    <div class="two-col">
      <div class="card"><h3 style="margin-top:0">Appointments by month</h3>${monthsNote}${bars(months)}</div>
      <div class="card"><h3 style="margin-top:0">How clients found RAFT</h3>${bars(count(clients, 'foundout'))}</div>
      <div class="card"><h3 style="margin-top:0">Reminder method</h3>${bars(count(clients, 'remindermethod'))}</div>
      <div class="card"><h3 style="margin-top:0">Room use</h3>
        <div class="table-wrap"><table><thead><tr><th>Room</th><th class="num">Appointments</th><th class="num">Hours booked</th></tr></thead>
        <tbody>${byRoom.map(([k, n, h]) => `<tr><td>${esc(k)}</td><td class="num">${n}</td><td class="num">${h}</td></tr>`).join('')}</tbody></table></div>
      </div>
    </div>

    <div class="card"><h3 style="margin-top:0">Counselor caseload</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Counselor</th><th class="num">Appointments</th><th class="num">Upcoming</th><th class="num">Distinct clients</th><th class="num">Kept rate</th></tr></thead>
        <tbody>${byCounselor.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${c.total}</td><td class="num">${c.upcoming}</td>
          <td class="num">${c.clients}</td><td class="num">${c.keptRate}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

/* ---------- Screen 4: Add or edit ---------- */
async function renderEdit(main, r, params) {
  const type = r.editRecords ? (params.get('type') === 'appointment' ? 'appointment' : 'client') : 'appointment';
  main.innerHTML = `
    <h1>${r.editRecords ? 'Add or edit a record' : 'Edit appointment notes'}</h1>
    ${r.editRecords ? `<div class="tabs">
      <a class="btn ${type === 'client' ? '' : 'secondary'}" href="#/edit?type=client">Client</a>
      <a class="btn ${type === 'appointment' ? '' : 'secondary'}" href="#/edit?type=appointment">Appointment</a>
    </div>` : `<p class="muted">As a counselor you can update an appointment’s notes, each client’s assignment, and whether the appointment was kept.</p>`}
    <div id="form-area"><p class="loading">Loading…</p></div>`;
  const area = $('#form-area');
  if (type === 'client') await renderClientForm(area, r, params.get('id'));
  else await renderAppointmentForm(area, r, params.get('id'), params.get('client'));
}

const field = (id, label, value, attrs = '') =>
  `<div><label for="${id}">${label}</label><input id="${id}" value="${esc(value ?? '')}" ${attrs}></div>`;
const options = (rows, selected, blank) =>
  (blank != null ? `<option value="">${esc(blank)}</option>` : '') +
  rows.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('');

async function renderClientForm(area, r, idParam) {
  const [clients, persons] = await Promise.all([
    fetchAll('client', CLIENT_COLS, ['clientid']),
    fetchAll('person', PERSON_COLS, ['personid']),
  ]);
  const pMap = byId(persons, 'personid');
  const clientIds = new Set(clients.map(c => c.clientid));
  const id = idParam ? Number(idParam) : null;
  const client = id ? clients.find(c => c.clientid === id) : null;
  if (id && !client) { area.innerHTML = errorHtml(`No client with ID ${id}.`); return; }
  const person = client ? pMap.get(id) : {};
  const sortName = (a, b) => fullName(a).localeCompare(fullName(b));
  const clientOpts = clients.map(c => pMap.get(c.clientid)).filter(Boolean).sort(sortName).map(p => [p.personid, `${fullName(p)} (#${p.personid})`]);
  const nonClients = persons.filter(p => !clientIds.has(p.personid)).sort(sortName);
  const distinct = key => uniq(clients.map(c => c[key])).sort();

  area.innerHTML = `
  <div class="card">
    <div class="fields" style="display:grid; gap:1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))">
      <div><label for="pick">Client to edit</label>
        <select id="pick">${options(clientOpts, id, '— Add a new client —')}</select></div>
      ${!client ? `<div><label for="person-pick">Person</label>
        <select id="person-pick">${options(nonClients.map(p => [p.personid, `${fullName(p)} (#${p.personid})`]), '', 'New person')}</select>
        <span class="muted" style="font-size:.8rem">Or choose someone already in the database (e.g. an employee) who is not yet a client.</span></div>` : ''}
    </div>
  </div>
  <form id="client-form" class="card" novalidate>
    <h3 style="margin-top:0">${client ? `Editing ${esc(fullName(person))} (#${id})` : 'New client'}</h3>
    <div class="fields">
      ${field('firstname', 'First name', person.firstname, 'maxlength="50" required')}
      ${field('lastname', 'Last name', person.lastname, 'maxlength="50" required')}
      ${field('phone', 'Phone', person.phone, 'maxlength="14" type="tel"')}
      ${field('email', 'Email', person.email, 'maxlength="100" type="email"')}
      ${field('address', 'Address', person.address, 'maxlength="50"')}
      ${field('city', 'City', person.city, 'maxlength="50"')}
      ${field('state', 'State', person.state, 'maxlength="2" style="text-transform:uppercase"')}
      ${field('zip', 'ZIP', person.zip, 'maxlength="10"')}
      ${field('foundout', 'How they found RAFT', client?.foundout, 'maxlength="50" list="foundout-list"')}
      ${field('remindermethod', 'Reminder method', client?.remindermethod, 'maxlength="50" list="reminder-list"')}
      <div><label for="referredby">Referred by (client)</label>
        <select id="referredby">${options(clientOpts.filter(([v]) => v !== id), client?.referredby, 'No one')}</select></div>
    </div>
    <datalist id="foundout-list">${distinct('foundout').map(v => `<option value="${esc(v)}">`).join('')}</datalist>
    <datalist id="reminder-list">${distinct('remindermethod').map(v => `<option value="${esc(v)}">`).join('')}</datalist>
    <div id="form-msg"></div>
    <div class="actions">
      <button type="submit">${client ? 'Save changes' : 'Add client'}</button>
      ${client ? `<a href="#/lookup?id=${id}">View in client lookup</a>` : ''}
    </div>
  </form>`;

  $('#pick').addEventListener('change', e => { location.hash = '#/edit?type=client' + (e.target.value ? '&id=' + e.target.value : ''); });
  const personPick = $('#person-pick');
  if (personPick) personPick.addEventListener('change', e => {
    const p = pMap.get(Number(e.target.value)) || {};
    for (const k of ['firstname', 'lastname', 'phone', 'email', 'address', 'city', 'state', 'zip']) $('#' + k).value = p[k] ?? '';
  });

  $('#client-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const msg = $('#form-msg');
    const v = k => blankToNull($('#' + k).value);
    const p = {
      firstname: v('firstname'), lastname: v('lastname'), phone: v('phone'), email: v('email'),
      address: v('address'), city: v('city'), state: v('state')?.toUpperCase() ?? null, zip: v('zip'),
    };
    const c = { foundout: v('foundout'), remindermethod: v('remindermethod'), referredby: v('referredby') ? Number(v('referredby')) : null };
    if (!p.firstname || !p.lastname) { msg.innerHTML = errorHtml('First and last name are required.'); return; }
    if (p.state && p.state.length !== 2) { msg.innerHTML = errorHtml('State must be a two-letter code.'); return; }
    const btn = ev.target.querySelector('button[type=submit]');
    btn.disabled = true; msg.innerHTML = '';
    try {
      let cid = id;
      if (client) {
        await run(sb.from('person').update(p).eq('personid', id));
        await run(sb.from('client').update(c).eq('clientid', id));
        flash = 'Client saved.';
      } else {
        const existing = personPick?.value ? Number(personPick.value) : null;
        if (existing) {
          await run(sb.from('person').update(p).eq('personid', existing));
          cid = existing;
        } else {
          cid = (await run(sb.from('person').insert(p).select('personid').single())).personid;
        }
        await run(sb.from('client').insert({ clientid: cid, ...c }));
        flash = `Client added (#${cid}).`;
      }
      const target = '#/edit?type=client&id=' + cid;
      if (location.hash === target) route(); else location.hash = target;
    } catch (e) {
      msg.innerHTML = errorHtml(e); btn.disabled = false;
    }
  });
}

async function renderAppointmentForm(area, r, idParam, clientParam) {
  const [appts, sfAll, persons, counselors, employees, rooms, clients] = await Promise.all([
    fetchAll('appointment', apptCols(r), ['appointmenttime', 'appointmentid']),
    fetchAll('scheduledfor', sfCols(r), ['appointmentid', 'clientid']),
    fetchAll('person', 'personid,firstname,lastname,email', ['personid']),
    fetchAll('counselor', 'counselorid,degreesuffix', ['counselorid']),
    fetchAll('employee', 'employeeid', ['employeeid']),
    fetchAll('room', 'roomnumber,roomname', ['roomnumber']),
    fetchAll('client', 'clientid', ['clientid']),
  ]);
  const pMap = byId(persons, 'personid');
  const nm = pid => fullName(pMap.get(pid));
  const id = idParam ? Number(idParam) : null;
  const appt = id ? appts.find(a => a.appointmentid === id) : null;
  if (id && !appt) { area.innerHTML = errorHtml(`No appointment with ID ${id}.`); return; }
  // Counselors cannot add appointments: with nothing chosen they see only the picker.
  const isNew = !appt;
  const lockCore = !r.editRecords; // counselors cannot change time, counselor, room, etc.
  const sfFor = aid => sfAll.filter(s => s.appointmentid === aid);
  const existingSf = appt ? sfFor(id) : [];

  const apptOpts = [...appts].reverse().map(a => [a.appointmentid,
    `${fmtTs(a.appointmenttime)} · ${nm(a.counselorid)} · ${sfFor(a.appointmentid).map(s => nm(s.clientid)).join(', ') || 'no clients'} (#${a.appointmentid})`]);
  const byName = (a, b) => a[1].localeCompare(b[1]);
  const counselorOpts = counselors.map(c => [c.counselorid, nm(c.counselorid) + (c.degreesuffix ? ', ' + c.degreesuffix : '')]).sort(byName);
  const employeeOpts = employees.map(e => [e.employeeid, nm(e.employeeid)]).sort(byName);
  const roomOpts = rooms.map(rm => [rm.roomnumber, roomLabel(rm, rm.roomnumber)]);
  const clientOpts = clients.map(c => [c.clientid, `${nm(c.clientid)} (#${c.clientid})`]).sort(byName);
  // Default "booked by" to the signed-in user if their email matches an employee.
  const me = employees.find(e => (pMap.get(e.employeeid)?.email || '').toLowerCase() === (session.user.email || '').toLowerCase());
  const keptSelect = (name, val, disabled) => `<select name="${name}" ${disabled ? 'disabled' : ''}>
      ${options([['', 'Not recorded'], ['true', 'Kept'], ['false', 'Not kept']], val == null ? '' : String(val))}</select>`;

  area.innerHTML = `
  <div class="card">
    <label for="pick">Appointment to ${r.editRecords ? 'edit' : 'update'}</label>
    <select id="pick">${options(apptOpts, id, r.editRecords ? '— Add a new appointment —' : '— Choose an appointment —')}</select>
  </div>
  ${isNew && !r.editRecords ? '' : `
  <form id="appt-form" class="card" novalidate>
    <h3 style="margin-top:0">${isNew ? 'New appointment' : `Appointment #${id}`}</h3>
    <div class="fields">
      <div><label for="time">Date and time</label>
        <input id="time" type="datetime-local" value="${esc(appt?.appointmenttime?.slice(0, 16) || '')}" ${lockCore ? 'disabled' : 'required'}></div>
      <div><label for="duration">Duration (minutes)</label>
        <input id="duration" type="number" min="1" step="1" value="${esc(appt?.duration ?? '')}" ${lockCore ? 'disabled' : ''}></div>
      <div><label for="counselor">Counselor</label>
        <select id="counselor" ${lockCore ? 'disabled' : ''}>${options(counselorOpts, appt?.counselorid, 'Choose…')}</select></div>
      <div><label for="room">Room</label>
        <select id="room" ${lockCore ? 'disabled' : ''}>${options(roomOpts, appt?.roomnumber, 'Choose…')}</select></div>
      <div><label for="employee">Booked by (employee)</label>
        <select id="employee" ${lockCore ? 'disabled' : ''}>${options(employeeOpts, appt ? appt.employeeid : me?.employeeid, 'Choose…')}</select></div>
      ${r.seeNotes ? `<div class="full"><label for="notes">Notes</label>
        <textarea id="notes" maxlength="3000" ${r.editNotes ? '' : 'disabled'}>${esc(appt?.notes || '')}</textarea></div>` : ''}
    </div>

    <h3>Clients on this appointment</h3>
    ${existingSf.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Client</th><th>Kept</th>${r.seeAssignment ? '<th>Assignment</th>' : ''}</tr></thead>
      <tbody>${existingSf.map(s => `<tr data-client="${s.clientid}">
        <td><a href="#/lookup?id=${s.clientid}">${esc(nm(s.clientid))}</a></td>
        <td>${keptSelect('kept', s.kept, !r.editKept)}</td>
        ${r.seeAssignment ? `<td><textarea name="assignment" maxlength="2000" ${r.editNotes ? '' : 'disabled'}>${esc(s.assignment || '')}</textarea></td>` : ''}
      </tr>`).join('')}</tbody></table></div>` : (isNew ? '' : '<p class="muted">No clients are scheduled for this appointment.</p>')}
    ${r.editRecords ? `
      <div id="new-clients"></div>
      <button type="button" class="secondary" id="add-client">+ Add a client</button>
      ${existingSf.length ? '<p class="muted" style="font-size:.85rem">Clients already on an appointment cannot be removed (records cannot be deleted).</p>' : ''}` : ''}

    <div id="form-msg"></div>
    <div class="actions"><button type="submit">${isNew ? 'Add appointment' : 'Save changes'}</button></div>
  </form>`}`;

  $('#pick').addEventListener('change', e => { location.hash = '#/edit?type=appointment' + (e.target.value ? '&id=' + e.target.value : ''); });
  const form = $('#appt-form');
  if (!form) return;

  const taken = new Set(existingSf.map(s => s.clientid));
  const addRow = preset => {
    const row = document.createElement('div');
    row.className = 'fields new-client';
    row.style.marginBottom = '.6rem';
    row.innerHTML = `
      <div><label>Client</label><select name="client">${options(clientOpts.filter(([v]) => !taken.has(v)), preset, 'Choose a client…')}</select></div>
      <div><label>Kept</label>${keptSelect('kept', null, false)}</div>
      ${r.seeAssignment ? '<div><label>Assignment</label><textarea name="assignment" maxlength="2000"></textarea></div>' : ''}
      <div style="align-self:end"><button type="button" class="link">Remove</button></div>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    $('#new-clients').appendChild(row);
  };
  if (r.editRecords) {
    $('#add-client').addEventListener('click', () => addRow(null));
    if (isNew) addRow(clientParam ? Number(clientParam) : null);
  }

  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const msg = $('#form-msg');
    const keptVal = sel => (sel.value === '' ? null : sel.value === 'true');
    const newRows = [...form.querySelectorAll('.new-client')].map(row => ({
      clientid: row.querySelector('[name=client]').value ? Number(row.querySelector('[name=client]').value) : null,
      kept: keptVal(row.querySelector('[name=kept]')),
      assignment: row.querySelector('[name=assignment]') ? blankToNull(row.querySelector('[name=assignment]').value) : undefined,
    }));
    const changedSf = [...form.querySelectorAll('tr[data-client]')].map(tr => {
      const cid = Number(tr.dataset.client);
      const old = existingSf.find(s => s.clientid === cid);
      const upd = {};
      if (r.editKept) { const k = keptVal(tr.querySelector('[name=kept]')); if (k !== old.kept) upd.kept = k; }
      if (r.editNotes && r.seeAssignment) { const a = blankToNull(tr.querySelector('[name=assignment]').value); if (a !== (old.assignment ?? null)) upd.assignment = a; }
      return { cid, upd };
    }).filter(x => Object.keys(x.upd).length);

    let rec = null;
    if (r.editRecords) {
      rec = {
        appointmenttime: $('#time').value ? $('#time').value + ':00' : null,
        duration: $('#duration').value ? Number($('#duration').value) : null,
        counselorid: $('#counselor').value ? Number($('#counselor').value) : null,
        employeeid: $('#employee').value ? Number($('#employee').value) : null,
        roomnumber: $('#room').value ? Number($('#room').value) : null,
      };
      if (!rec.appointmenttime || !rec.counselorid || !rec.employeeid || !rec.roomnumber) {
        msg.innerHTML = errorHtml('Date and time, counselor, room and booked-by employee are required.'); return;
      }
      if (rec.duration != null && !(Number.isInteger(rec.duration) && rec.duration > 0)) {
        msg.innerHTML = errorHtml('Duration must be a whole number of minutes.'); return;
      }
      if (newRows.some(x => !x.clientid)) { msg.innerHTML = errorHtml('Choose a client in each added row, or remove the empty row.'); return; }
      const ids = newRows.map(x => x.clientid);
      if (new Set(ids).size !== ids.length) { msg.innerHTML = errorHtml('The same client is listed twice.'); return; }
      if (isNew && !newRows.length) { msg.innerHTML = errorHtml('Add at least one client to the appointment.'); return; }
    }
    if (r.editNotes && $('#notes')) {
      const n = blankToNull($('#notes').value);
      if (isNew || n !== (appt.notes ?? null)) (rec ||= {}).notes = n;
    }

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; msg.innerHTML = '';
    try {
      let aid = id;
      if (isNew) {
        aid = (await run(sb.from('appointment').insert(rec).select('appointmentid').single())).appointmentid;
      } else if (rec) {
        await run(sb.from('appointment').update(rec).eq('appointmentid', aid));
      }
      for (const { cid, upd } of changedSf) {
        await run(sb.from('scheduledfor').update(upd).eq('appointmentid', aid).eq('clientid', cid));
      }
      if (newRows.length) {
        await run(sb.from('scheduledfor').insert(newRows.map(x => {
          const row = { appointmentid: aid, clientid: x.clientid, kept: x.kept };
          if (r.editNotes && x.assignment !== undefined) row.assignment = x.assignment;
          return row;
        })));
      }
      flash = isNew ? `Appointment added (#${aid}).` : 'Appointment saved.';
      const target = '#/edit?type=appointment&id=' + aid;
      if (location.hash === target) route(); else location.hash = target;
    } catch (e) {
      msg.innerHTML = errorHtml(e); btn.disabled = false;
    }
  });
}
