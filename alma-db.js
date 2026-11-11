// ALMA · saving to the database (Supabase)
// Everything a person shares is kept in their own private space. A feeling is first put in a small queue on the phone,
// then sent; so nothing is lost when the phone is offline or the person has not signed in yet.
(() => {
  const SUPABASE_URL = 'https://wynwjlsrdoooexalvmty.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_-pRXnzGDtYPZPcTUpx6ERA_jIIjj18h';   // public by design: the database's privacy rules decide what it can do
  const APP = window.ALMA_APP;
  if (!APP) return;
  const ok = !!(window.supabase && window.supabase.createClient);
  const sb = ok ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;
  const $ = id => document.getElementById(id);
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
                  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const pad = n => String(n).padStart(2, '0');
  const localDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  let user = null, flushing = false, warned = false;
  let queue = store.get('alma-queue', []);           // rows not yet in the database
  const FILES = new Map();                            // client_id -> { voice: blobURL } or { photo: File } (kept in memory only)
  const ECHOES = [];                                  // your own journal entries, from the database
  const KIND_TO_DB = { leaf: 'other', quote: 'quote' }, KIND_FROM_DB = { other: 'leaf', words: 'quote' };

  // ---------------- Saving ----------------
  function saveFeeling(k, flav, note, voiceUrl) {
    const d = new Date(), id = uuid();
    queue.push({ type: 'feeling', row: { client_id: id, felt_at: d.toISOString(), local_day: localDay(d), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      emotion_id: k, nuance: flav || null, note: note || null, source: 'app', released: true } });
    if (voiceUrl) FILES.set(id, { voice: voiceUrl });
    store.set('alma-queue', queue); refreshAccount();
    if (!user && !warned) { warned = true; setTimeout(() => APP.toast('Sign in from ◉ to keep your feelings'), 2600); }
    flush();
  }
  function saveEcho({ kind, emotion, title, body, url, file }) {
    const id = uuid();
    queue.push({ type: 'echo', row: { client_id: id, kind: KIND_TO_DB[kind] || kind, emotion_id: APP.idx(emotion), title, body: body || null, url: url || null, visibility: 'private' } });
    if (file) FILES.set(id, { photo: file });
    store.set('alma-queue', queue); refreshAccount();
    if (!user && !warned) { warned = true; setTimeout(() => APP.toast('Sign in from ◉ to keep your journal'), 1200); }
    flush();
  }
  // A photo is redrawn at most 1600 px wide before it leaves the phone. Redrawing also drops the hidden location data cameras add.
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file); const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)); return { blob, w: c.width, h: c.height };
    } catch (e) { return null; }
  }
  async function flush() {
    if (!sb || !user || flushing || !queue.length || !navigator.onLine) return;
    flushing = true;
    try {
      while (queue.length) {
        const it = queue[0], f = FILES.get(it.row.client_id);
        if (it.type === 'feeling') {
          if (f && f.voice && !it.row.voice_path) {
            try { const blob = await (await fetch(f.voice)).blob(), ext = /mp4|m4a|aac/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
              const path = `${user.id}/voice/${it.row.client_id}.${ext}`;
              const { error } = await sb.storage.from('media').upload(path, blob, { contentType: blob.type || 'audio/webm', upsert: true });
              if (!error) it.row.voice_path = path; } catch (e) {}
          }
          const { error } = await sb.from('feelings').upsert(it.row, { onConflict: 'client_id', ignoreDuplicates: true });
          if (error) throw error;
        } else if (it.type === 'echo') {
          const { data, error } = await sb.from('echoes').upsert(it.row, { onConflict: 'client_id', ignoreDuplicates: true }).select('id');
          if (error) throw error;
          const echoId = data && data[0] && data[0].id;
          if (echoId && f && f.photo) {
            const img = await shrink(f.photo);
            if (img) { const path = `${user.id}/echo/${it.row.client_id}.jpg`;
              const up = await sb.storage.from('media').upload(path, img.blob, { contentType: 'image/jpeg', upsert: true });
              if (!up.error) await sb.from('echo_media').insert({ echo_id: echoId, path, mime: 'image/jpeg', width: img.w, height: img.h }); }
          }
        }
        FILES.delete(it.row.client_id); queue.shift(); store.set('alma-queue', queue);
      }
    } catch (e) { console.warn('ALMA: will try again', e); }
    flushing = false; refreshAccount();
  }
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });

  // ---------------- Loading your own history ----------------
  async function signed(paths) {
    if (!paths.length) return {};
    const { data } = await sb.storage.from('media').createSignedUrls(paths, 60 * 60 * 12);
    const out = {}; (data || []).forEach(x => { if (x.signedUrl) out[x.path] = x.signedUrl; }); return out;
  }
  async function load() {
    if (!sb || !user || window.ALMA_DEMO) return;
    const year = new Date().getFullYear();
    const { data: fs, error } = await sb.from('feelings').select('felt_at,local_day,emotion_id,nuance,note,voice_path').gte('local_day', `${year}-01-01`).order('felt_at');
    if (!error) {
      const urls = await signed(fs.filter(x => x.voice_path).map(x => x.voice_path));
      const list = fs.map(x => { const d = new Date(x.felt_at); return { day: x.local_day, m: d.getHours() * 60 + d.getMinutes(), k: x.emotion_id, flav: x.nuance, note: x.note, voice: x.voice_path ? urls[x.voice_path] : null }; });
      queue.filter(q => q.type === 'feeling').forEach(q => { const d = new Date(q.row.felt_at); list.push({ day: q.row.local_day, m: d.getHours() * 60 + d.getMinutes(), k: q.row.emotion_id, flav: q.row.nuance, note: q.row.note, voice: (FILES.get(q.row.client_id) || {}).voice || null }); });
      APP.REFLECT.load(list);
    }
    const { data: es, error: e2 } = await sb.from('echoes').select('id,kind,emotion_id,title,subtitle,body,url,created_at,echo_media(path,ord)').order('created_at');
    if (!e2) {
      const urls = await signed(es.flatMap(x => (x.echo_media || []).map(m => m.path)));
      ECHOES.length = 0;
      es.forEach(x => ECHOES.push({ kind: KIND_FROM_DB[x.kind] || x.kind, emotion: (APP.EMO[x.emotion_id] || {}).name, title: x.title, subtitle: x.subtitle, body: x.body, url: x.url,
        photo: x.echo_media && x.echo_media.length ? urls[x.echo_media[0].path] || null : null }));
      APP.JOURNAL.reset();
    }
  }
  const echoesFor = name => ECHOES.filter(e => e.emotion === name);

  // ---------------- Account: sign in with a code sent by email ----------------
  const css = document.createElement('style');
  css.textContent = `
  .acctBtn small { color: var(--muted); }
  .acctScrim { position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 60; opacity: 0; pointer-events: none; transition: opacity 0.3s; }
  .acct { position: fixed; left: 50%; bottom: 0; transform: translate(-50%, 105%); width: min(100vw, 520px); z-index: 61; transition: transform 0.35s cubic-bezier(.2,.8,.2,1);
    background: #110d0a; border: 1px solid #2c241b; border-bottom: 0; border-radius: 24px 24px 0 0; padding: 20px 20px calc(24px + env(safe-area-inset-bottom)); max-height: 88svh; overflow-y: auto; }
  body.acct-open .acctScrim { opacity: 1; pointer-events: auto; } body.acct-open .acct { transform: translate(-50%, 0); }
  .acct h3 { margin: 0; text-align: center; font: 400 26px var(--serif); color: var(--gold); }
  .acct p { margin: 6px 0 14px; text-align: center; color: var(--muted); font: 300 14.5px/1.45 var(--sans); }
  .acct label { display: block; margin: 12px 0 4px; font: 500 11px var(--sans); letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }
  .acct input[type=email], .acct input[type=text], .acct input[inputmode=numeric] { display: block; width: 100%; box-sizing: border-box; background: #18130f; border: 1px solid #2c241b; border-radius: 12px; padding: 12px 14px; color: var(--text); font: 400 16px var(--sans); }
  .acct input[inputmode=numeric] { letter-spacing: 0.4em; text-align: center; font: 400 22px var(--mono); }
  .acct .go { display: block; width: 100%; margin-top: 12px; min-height: 46px; border-radius: 12px; background: var(--gold); color: #1a130a; border: 0; font: 500 15px var(--sans); cursor: pointer; }
  .acct .quiet { display: block; width: 100%; margin-top: 8px; min-height: 42px; border-radius: 12px; background: #18130f; color: var(--text); border: 1px solid #2c241b; font: 400 15px var(--sans); cursor: pointer; }
  .acct .msg { min-height: 1.4em; margin: 8px 0 0; text-align: center; font: 400 13px var(--sans); color: #e7b25a; }
  .acct .who { text-align: center; font: 400 15px var(--sans); color: var(--text); margin: 4px 0 2px; }
  .acct .cities { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .acct .cities button { text-align: left; background: #18130f; border: 1px solid #2c241b; border-radius: 10px; padding: 9px 12px; color: var(--text); font: 400 14px var(--sans); cursor: pointer; }
  .acct .cities button.on { border-color: var(--gold); }
  .acct label.row2 { text-transform: none; letter-spacing: 0; font: 400 14px var(--sans); color: var(--text); }
  .acct .row2 { display: flex; align-items: center; gap: 10px; margin-top: 16px; font: 400 14px var(--sans); color: var(--text); } .acct .row2 input { accent-color: var(--accent); width: 18px; height: 18px; }
  .acct .row2 small { display: block; color: var(--faint); font-size: 12px; }
  .acct hr { border: 0; border-top: 1px solid #2c241b; margin: 18px 0 6px; }`;
  document.head.appendChild(css);

  const menu = document.querySelector('.plusMenu');
  const btn = document.createElement('button'); btn.className = 'acctBtn'; btn.id = 'acctBtn';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-4 3.4-6.5 7-6.5s6.4 2.5 7 6.5"/></svg><div><span id="acctLabel">Keep your feelings</span><small id="acctSub">Sign in</small></div>';
  if (menu) menu.appendChild(btn);
  const scrim = document.createElement('div'); scrim.className = 'acctScrim';
  const sheet = document.createElement('div'); sheet.className = 'acct'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', 'Your account');
  document.body.append(scrim, sheet);
  const openAcct = () => { renderAcct(); document.body.classList.add('acct-open'); document.body.classList.remove('plus-open'); };
  const closeAcct = () => document.body.classList.remove('acct-open');
  btn.addEventListener('click', e => { e.stopPropagation(); openAcct(); });
  scrim.addEventListener('click', closeAcct);

  let pendingEmail = store.get('alma-pending-email', ''), persona = null, cityPick = null;
  function renderAcct(msg) {
    if (!ok) { sheet.innerHTML = '<h3>Not connected</h3><p>ALMA could not reach its database from here. Check the connection and open it again.</p>'; return; }
    if (!user) {
      sheet.innerHTML = `<h3>Keep your feelings</h3>
        <p>ALMA keeps what you share in your own private space, on every device you use. Enter your email and we will send you a link to open ALMA.</p>
        <label for="acEmail">Email</label><input type="email" id="acEmail" autocomplete="email" inputmode="email" value="${pendingEmail || ''}">
        <button class="go" id="acSend">Send the code</button>
        ${pendingEmail ? `<label for="acCode">The code from the email</label><input inputmode="numeric" id="acCode" maxlength="6" autocomplete="one-time-code"><button class="go" id="acVerify">Open my ALMA</button>` : ''}
        <p class="msg" id="acMsg">${msg || ''}</p>${demoRow()}`;
      $('acSend').addEventListener('click', sendCode);
      if ($('acVerify')) { $('acVerify').addEventListener('click', verify); $('acCode').addEventListener('input', e => { if (e.target.value.replace(/\D/g, '').length === 6) verify(); }); }
    } else {
      const waiting = queue.length;
      sheet.innerHTML = `<h3>Your ALMA</h3><p class="who">${user.email || ''}</p>
        <p>${waiting ? `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} waiting to be saved…` : 'Everything you share is saved.'}</p>
        <label for="acRole">What you do</label><input type="text" id="acRole" maxlength="40" placeholder="Dancer, doctor, student…" value="${(persona && persona.role) || ''}">
        <label for="acCity">Where you live</label><input type="text" id="acCity" maxlength="60" placeholder="Your city" value="${(persona && persona.city) || ''}">
        <div class="cities" id="acCities"></div>
        <p style="margin:6px 0 0;font-size:12.5px">Others only ever see what you do and your city, never your name. Your place on the map is blurred to about 10 km.</p>
        <button class="go" id="acSave">Save</button>
        <p class="msg" id="acMsg">${msg || ''}</p>${demoRow()}<hr>
        <button class="quiet" id="acExport">Download everything I shared</button><button class="quiet" id="acOut">Sign out</button>`;
      $('acCity').addEventListener('change', findCity); $('acCity').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findCity(); } });
      $('acSave').addEventListener('click', savePersona); $('acExport').addEventListener('click', exportAll); $('acOut').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
    }
    $('acDemo').addEventListener('change', e => { store.set('alma-demo', e.target.checked ? 1 : 0); try { localStorage.setItem('alma-demo', e.target.checked ? '1' : '0'); } catch (x) {} location.reload(); });
  }
  const demoRow = () => `<label class="row2"><input type="checkbox" id="acDemo" ${window.ALMA_DEMO ? 'checked' : ''}><span>Example data<small>Fills Reflect and the journal with made-up entries, for presentations. Your own entries are kept either way.</small></span></label>`;
  const say = t => { const m = $('acMsg'); if (m) m.textContent = t; };

  async function sendCode() {
    const email = ($('acEmail').value || '').trim().toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) { say('That email does not look right'); return; }
    $('acSend').disabled = true; say('Sending…');
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
    if (error) { $('acSend').disabled = false; say(error.message.includes('rate') ? 'Too many codes asked for. Wait a minute and try again.' : 'Could not send it: ' + error.message); return; }
    pendingEmail = email; store.set('alma-pending-email', email);
    renderAcct('Sent. Open the email on this device and tap its link, or type the code if it shows one. Check spam too.'); setTimeout(() => $('acCode') && $('acCode').focus(), 200);
  }
  async function verify() {
    const token = ($('acCode').value || '').replace(/\D/g, ''); if (token.length !== 6) { say('The code has six digits'); return; }
    $('acVerify').disabled = true; say('Checking…');
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
    if (error) { $('acVerify').disabled = false; say('That code did not work. Ask for a new one if it is older than an hour.'); return; }
    pendingEmail = ''; store.set('alma-pending-email', '');
  }
  async function findCity() {
    const q = ($('acCity').value || '').trim(); const box = $('acCities'); cityPick = null; if (q.length < 2) { box.innerHTML = ''; return; }
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=${encodeURIComponent(q)}`); const j = await r.json();
      box.innerHTML = ''; (j.results || []).forEach(c => { const b = document.createElement('button'); b.type = 'button'; b.textContent = [c.name, c.admin1, c.country].filter(Boolean).join(', ');
        b.addEventListener('click', () => { cityPick = { city: c.name, country: c.country, lat: c.latitude, lng: c.longitude }; $('acCity').value = c.name; [...box.children].forEach(x => x.classList.toggle('on', x === b)); });
        box.appendChild(b); });
      if (!box.children.length) box.innerHTML = '<p style="margin:4px 0;font-size:13px">No city found with that name</p>';
    } catch (e) { box.innerHTML = ''; }
  }
  async function savePersona() {
    const role = ($('acRole').value || '').trim(), cityTxt = ($('acCity').value || '').trim();
    const row = { person_id: user.id, role: role || null };
    if (cityPick) Object.assign(row, cityPick); else if (!persona || cityTxt !== persona.city) { if (cityTxt) { say('Choose your city from the list'); findCity(); return; } Object.assign(row, { city: null, country: null, lat: null, lng: null }); }
    const { error } = await sb.from('personas').upsert(row, { onConflict: 'person_id' });
    if (error) { say('Could not save: ' + error.message); return; }
    persona = { ...(persona || {}), ...row }; cityPick = null; say('Saved');
  }
  async function exportAll() {
    const [f, e, p] = await Promise.all([sb.from('feelings').select('*').order('felt_at'), sb.from('echoes').select('*, echo_media(*)').order('created_at'), sb.from('personas').select('*')]);
    const out = { exported_at: new Date().toISOString(), email: user.email, persona: (p.data || [])[0] || null, feelings: f.data || [], echoes: e.data || [] };
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    a.download = `alma-${localDay(new Date())}.json`; document.body.appendChild(a); a.click(); a.remove();
  }
  function refreshAccount() {
    const l = $('acctLabel'), s = $('acctSub'); if (!l) return;
    if (user) { l.textContent = 'Your account'; s.textContent = queue.length ? `${queue.length} waiting to be saved` : (window.ALMA_DEMO ? 'Saved · showing example data' : 'Everything is saved'); }
    else { l.textContent = 'Keep your feelings'; s.textContent = queue.length ? `Sign in · ${queue.length} not saved yet` : 'Sign in'; }
    if (document.body.classList.contains('acct-open') && user && !document.activeElement.closest?.('.acct')) renderAcct();
  }
  const jf = $('jaFile'); if (jf) jf.addEventListener('change', () => { const n = $('jaFileName'); if (n) n.textContent = jf.files[0] ? 'Photo: ' + jf.files[0].name : 'Add a photo'; });

  // ---------------- Start ----------------
  if (sb) sb.auth.onAuthStateChange((ev, session) => {
    const was = user && user.id; user = session ? session.user : null; refreshAccount();
    if (user && user.id !== was) {
      setTimeout(async () => {
        const { data } = await sb.from('personas').select('*').eq('person_id', user.id).maybeSingle(); persona = data || null;
        await flush(); await load();
        if (document.body.classList.contains('acct-open')) renderAcct(ev === 'SIGNED_IN' && !persona ? 'Welcome. Tell ALMA what you do and where you live.' : '');
        if (ev === 'SIGNED_IN' && !was) APP.toast('Your feelings are saved now');
      }, 0);
    }
  });
  window.ALMA_DB = { saveFeeling, saveEcho, echoesFor, flush, get user() { return user; }, client: sb };
  refreshAccount();
})();
