// Food Factory Fight server: matchmaking + lobby (accounts, usernames, all-servers chat, gifts, roles, kick).
const { WebSocketServer } = require('ws');
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PAGE = path.join(__dirname, 'index.html');
const DB = path.join(process.env.DATA_DIR || __dirname, 'accounts.json');
// Owner = whoever knows the admin password (only its hash is stored here).
const OWNER_HASH = '4c6d56cd706aad1112182ba6b9052b0632ea04945cca1532d36e8d2568e91980';
// Accounts that are ALWAYS admin (survives role changes). Extra names via env PERM_ADMINS=name1,name2
const PERM_ADMINS = ['otis'].concat((process.env.PERM_ADMINS || '').split(',')).map(x => x.trim().toLowerCase()).filter(Boolean);
const MOD_KEYS = (process.env.MOD_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
// ---- accounts (saved to accounts.json; on Render's free plan this file resets when the server redeploys)
let DBD = { users: {}, pending: {}, gev: 0 };
try { DBD = Object.assign(DBD, JSON.parse(fs.readFileSync(DB, 'utf8'))); } catch {}
let dirty = false; const saveDb = () => { dirty = true; };
setInterval(() => { if (dirty) { dirty = false; try { fs.writeFileSync(DB, JSON.stringify(DBD)); } catch {} } }, 3000);
const key = n => String(n || '').toLowerCase();
const validName = n => /^[A-Za-z0-9_]{3,16}$/.test(String(n || ''));
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const keyRole = k => { if (!k) return 'none'; if (sha(k) === OWNER_HASH) return 'owner'; if (MOD_KEYS.includes(String(k))) return 'mod'; return 'none'; };
const server = http.createServer((q, r) => { try { const h = fs.readFileSync(PAGE); r.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); r.end(h); } catch (e) { r.writeHead(200); r.end('Food Factory Fight server OK'); } });
const wss = new WebSocketServer({ server, maxPayload: 20000 });
let waiting = null, nextId = 1, gevUntil = DBD.gev > Date.now() ? DBD.gev : 0, lastOnline = -1;
const send = (ws, o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} };
const all = o => wss.clients.forEach(c => send(c, o));
const online = () => wss.clients.size;
const pushOnline = () => { if (lastOnline !== online()) { lastOnline = online(); all({ t: 'online', n: online() }); } };
const effRole = ws => (ws.keyRole && ws.keyRole !== 'none') ? ws.keyRole : (ws.acctRole || 'none');
const sendRole = ws => send(ws, { t: 'role', role: effRole(ws), id: ws.id, name: ws.user || '' });
const flushPending = ws => { const q = DBD.pending[key(ws.user)]; if (q && q.length) { q.forEach(g => send(ws, { t: 'gift', id: g.id, kind: g.kind, n: g.n })); delete DBD.pending[key(ws.user)]; saveDb(); } };
function loginOk(ws, name) {
  const u = DBD.users[key(name)]; if (PERM_ADMINS.includes(key(name)) && u.role !== 'admin') { u.role = 'admin'; saveDb(); } ws.user = u.name; ws.acctRole = u.role || 'none';
  wss.clients.forEach(c => { if (c !== ws && c.user && key(c.user) === key(u.name)) { send(c, { t: 'kick', why: 'Logged in from another place' }); setTimeout(() => { try { c.close(); } catch {} }, 200); } });
  send(ws, { t: 'acct', ok: true, n: u.name, token: u.token }); sendRole(ws); flushPending(ws);
}
const gevSecs = () => gevUntil > Date.now() ? Math.round((gevUntil - Date.now()) / 1000) : 0;
wss.on('connection', ws => {
  ws.id = nextId++; ws.partner = null; ws.alive = true; ws.keyRole = 'none'; ws.acctRole = 'none'; ws.user = ''; ws.lastBc = 0; ws.lastAdm = 0; ws.lastAuth = 0;
  ws.on('pong', () => ws.alive = true);
  sendRole(ws);
  if (gevSecs()) send(ws, { t: 'gev', secs: gevSecs() });
  pushOnline(); send(ws, { t: 'online', n: online() });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hi') {
      ws.keyRole = keyRole(m.k);
      if (m.token && !ws.user) { const u = Object.values(DBD.users).find(x => x.token === m.token); if (u) loginOk(ws, u.name); }
      sendRole(ws); send(ws, { t: 'online', n: online() });
    } else if (m.t === 'reg' || m.t === 'login') {
      const now = Date.now(); if (now - ws.lastAuth < 800) return send(ws, { t: 'acct', ok: false, msg: 'Slow down' }); ws.lastAuth = now;
      const name = String(m.n || '').trim();
      if (m.t === 'reg') {
        if (!validName(name)) return send(ws, { t: 'acct', ok: false, msg: 'Username: 3-16 letters, numbers or _' });
        if (String(m.p || '').length < 4) return send(ws, { t: 'acct', ok: false, msg: 'Password needs at least 4 characters' });
        if (DBD.users[key(name)]) return send(ws, { t: 'acct', ok: false, msg: 'That username is taken' });
        const salt = crypto.randomBytes(8).toString('hex');
        DBD.users[key(name)] = { name, salt, h: hashPw(m.p, salt), token: crypto.randomBytes(16).toString('hex'), role: 'none', made: Date.now() }; saveDb();
        loginOk(ws, name);
      } else {
        const u = DBD.users[key(name)];
        if (!u || u.h !== hashPw(m.p, u.salt)) return send(ws, { t: 'acct', ok: false, msg: 'Wrong username or password' });
        loginOk(ws, name);
      }
    } else if (m.t === 'logout') {
      ws.user = ''; ws.acctRole = 'none'; sendRole(ws); send(ws, { t: 'acct', ok: false, out: true });
    } else if (m.t === 'won') {
      const u = ws.user && DBD.users[key(ws.user)]; const now = Date.now();
      if (u && !(now - (ws.lastWon || 0) < 20000)) { ws.lastWon = now; u.wins = (u.wins | 0) + 1; saveDb(); }
    } else if (m.t === 'lb') {
      const list = Object.values(DBD.users).filter(u => (u.wins | 0) > 0).sort((a, b) => (b.wins | 0) - (a.wins | 0)).slice(0, 10).map(u => ({ n: u.name, w: u.wins | 0 }));
      send(ws, { t: 'lb', list });
    } else if (m.t === 'adm') {
      const role = (keyRole(m.k) !== 'none') ? keyRole(m.k) : effRole(ws);
      if (role === 'none') return send(ws, { t: 'err', msg: 'Not allowed. Log in with an account that has a role, or open your admin link once.' });
      const now = Date.now(); if (now - ws.lastAdm < 150) return; ws.lastAdm = now;
      const owner = role === 'owner';
      const who = owner ? 'Admin' : 'Moderator';
      const findTargets = to => { const out = []; wss.clients.forEach(c => { if (typeof to === 'number' ? c.id === to : (c.user && key(c.user) === key(to))) out.push(c); }); return out; };
      const parseTo = v => (/^\d+$/.test(String(v)) ? parseInt(v, 10) : String(v || '').trim());
      if (m.c === 'bc') {
        if (now - ws.lastBc < 1000) return; ws.lastBc = now;
        const text = String(m.text || '').slice(0, 200).trim(); if (!text) return;
        all({ t: 'bc', from: owner ? 'Admin' : ((ws.user || 'Moderator')), text });
      } else if (m.c === 'plist') {
        const list = []; wss.clients.forEach(c => list.push({ id: c.id, name: c.user || '', role: effRole(c), st: c.partner ? 'in a match' : (c === waiting ? 'searching' : 'in the menu') }));
        const out = { t: 'plist', list: list.slice(0, 60) };
        if (owner) out.accounts = Object.values(DBD.users).slice(0, 200).map(u => ({ name: u.name, role: u.role || 'none', online: wss.clients.size && [...wss.clients].some(c => c.user === u.name) }));
        send(ws, out);
      } else if (m.c === 'kick') {
        const to = parseTo(m.to); findTargets(to).forEach(c => { if (c !== ws && effRole(c) !== 'owner') { send(c, { t: 'kick' }); setTimeout(() => { try { c.close(); } catch {} }, 300); } });
      } else if (owner && m.c === 'gift') {
        const kind = String(m.kind); if (!['coins', 'jet', 'pot', 'upg', 'skin', 'map', 'food', 'tnt', 'peel', 'ket', 'truck', 'spoon'].includes(kind)) return;
        const n = Math.max(1, Math.min(100000, parseInt(m.n, 10) || 1)), id = crypto.randomBytes(6).toString('hex');
        if (m.to === 'all') all({ t: 'gift', id, kind, n });
        else {
          const to = parseTo(m.to), tg = findTargets(to);
          if (tg.length) tg.forEach(c => send(c, { t: 'gift', id, kind, n }));
          else if (typeof to === 'string' && DBD.users[key(to)]) { (DBD.pending[key(to)] = DBD.pending[key(to)] || []).push({ id, kind, n }); saveDb(); send(ws, { t: 'err', msg: to + ' is offline: gift saved, they get it when they log in' }); }
          else send(ws, { t: 'err', msg: 'No player or account named ' + to });
        }
      } else if (owner && m.c === 'setrole') {
        const nm = String(m.name || '').trim(), r = String(m.role);
        if (!['none', 'mod', 'admin'].includes(r)) return;
        const u = DBD.users[key(nm)]; if (!u) return send(ws, { t: 'err', msg: 'No account named ' + nm });
        if (PERM_ADMINS.includes(key(nm))) return send(ws, { t: 'err', msg: u.name + ' is a permanent admin and cannot be changed' }); u.role = r; saveDb(); findTargets(nm).forEach(c => { c.acctRole = r; sendRole(c); });
        send(ws, { t: 'err', msg: u.name + ' is now: ' + (r === 'none' ? 'normal player' : r === 'mod' ? 'moderator' : 'admin') });
      } else if (owner && m.c === 'gev') {
        const secs = Math.max(0, Math.min(3600, parseInt(m.secs, 10) || 0)); gevUntil = secs ? Date.now() + secs * 1000 : 0; DBD.gev = gevUntil; saveDb(); all({ t: 'gev', secs });
      } else send(ws, { t: 'err', msg: 'Only the owner can do that' });
    } else if (m.t === 'find') {
      if (waiting && waiting !== ws && waiting.readyState === 1) {
        const a = waiting; waiting = null;
        a.partner = ws; ws.partner = a;
        send(a, { t: 'match', role: 'host' }); send(ws, { t: 'match', role: 'guest' });
      } else waiting = ws;
    } else if (m.t === 'msg' && ws.partner && ws.partner.readyState === 1) {
      send(ws.partner, { t: 'msg', topic: String(m.topic).slice(0, 8), data: m.data, peer: ws.id });
    }
  });
  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    if (ws.partner) { send(ws.partner, { t: 'left' }); ws.partner.partner = null; }
    setTimeout(pushOnline, 50);
  });
});
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 20000);
server.listen(process.env.PORT || 8080, () => console.log('listening'));
