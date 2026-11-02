// Food Factory Fight server: matchmaking + lobby (all-servers chat, gifts, kick, moderators).
const { WebSocketServer } = require('ws');
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PAGE = path.join(__dirname, 'index.html');
// Owner = whoever knows the admin password (hash only, the password itself is never stored here).
const OWNER_HASH = '0b9183d6f531a22363a848273b9855e815d3b18cf69af6bad7eec96f87786ca0';
// Optional moderators: set MOD_KEYS on Render to a comma separated list of secret keys.
const MOD_KEYS = (process.env.MOD_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const roleOf = k => { if (!k) return 'none'; if (sha(k) === OWNER_HASH) return 'owner'; if (MOD_KEYS.includes(String(k))) return 'mod'; return 'none'; };
const server = http.createServer((q, r) => { try { const h = fs.readFileSync(PAGE); r.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); r.end(h); } catch (e) { r.writeHead(200); r.end('Food Factory Fight server OK'); } });
const wss = new WebSocketServer({ server, maxPayload: 20000 });
let waiting = null, nextId = 1, gevUntil = 0, lastOnline = -1;
const send = (ws, o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} };
const all = o => wss.clients.forEach(c => send(c, o));
const online = () => wss.clients.size;
const pushOnline = () => { if (lastOnline !== online()) { lastOnline = online(); all({ t: 'online', n: online() }); } };
wss.on('connection', ws => {
  ws.id = nextId++; ws.partner = null; ws.alive = true; ws.role = 'none'; ws.lastBc = 0; ws.lastAdm = 0;
  ws.on('pong', () => ws.alive = true);
  send(ws, { t: 'role', role: 'none', id: ws.id });
  if (gevUntil > Date.now()) send(ws, { t: 'gev', secs: Math.round((gevUntil - Date.now()) / 1000) });
  pushOnline(); send(ws, { t: 'online', n: online() });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hi') {
      ws.role = roleOf(m.k); send(ws, { t: 'role', role: ws.role, id: ws.id }); send(ws, { t: 'online', n: online() });
    } else if (m.t === 'adm') {
      const role = roleOf(m.k);
      if (role === 'none') return send(ws, { t: 'err', msg: 'Not allowed: wrong admin key (open your admin link once on this device)' });
      const now = Date.now(); if (now - ws.lastAdm < 150) return; ws.lastAdm = now;
      const owner = role === 'owner';
      if (m.c === 'bc') {
        if (now - ws.lastBc < 1000) return; ws.lastBc = now;
        const text = String(m.text || '').slice(0, 200).trim(); if (!text) return;
        all({ t: 'bc', from: owner ? 'Admin' : 'Moderator', text });
      } else if (m.c === 'plist') {
        const list = []; wss.clients.forEach(c => list.push({ id: c.id, st: c.partner ? 'in a match' : (c === waiting ? 'searching' : 'in the menu') }));
        send(ws, { t: 'plist', list: list.slice(0, 60) });
      } else if (m.c === 'kick') {
        const to = parseInt(m.to, 10); wss.clients.forEach(c => { if (c.id === to && c !== ws && c.role !== 'owner') { send(c, { t: 'kick' }); setTimeout(() => { try { c.close(); } catch {} }, 300); } });
      } else if (owner && m.c === 'gift') {
        const kind = String(m.kind); if (!['coins', 'jet', 'pot', 'upg', 'skin', 'map'].includes(kind)) return;
        const n = Math.max(1, Math.min(100000, parseInt(m.n, 10) || 1)), id = crypto.randomBytes(6).toString('hex');
        if (m.to === 'all') all({ t: 'gift', id, kind, n }); else { const to = parseInt(m.to, 10); wss.clients.forEach(c => { if (c.id === to) send(c, { t: 'gift', id, kind, n }); }); }
      } else if (owner && m.c === 'gev') {
        const secs = Math.max(0, Math.min(3600, parseInt(m.secs, 10) || 0)); gevUntil = secs ? Date.now() + secs * 1000 : 0; all({ t: 'gev', secs });
      } else send(ws, { t: 'err', msg: 'Moderators cannot do that' });
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
