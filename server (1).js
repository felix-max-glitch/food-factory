// Food Factory Fight matchmaking server. Pairs players and relays messages.
const { WebSocketServer } = require('ws');
const http = require('http'), fs = require('fs'), path = require('path');
const PAGE = path.join(__dirname, 'index.html');
const server = http.createServer((q, r) => { try { const h = fs.readFileSync(PAGE); r.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); r.end(h); } catch (e) { r.writeHead(200); r.end('Food Factory Fight server OK'); } });
const wss = new WebSocketServer({ server });
let waiting = null, nextId = 1;
wss.on('connection', ws => {
  ws.id = nextId++; ws.partner = null; ws.alive = true;
  ws.on('pong', () => ws.alive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'find') {
      if (waiting && waiting !== ws && waiting.readyState === 1) {
        const a = waiting; waiting = null;
        a.partner = ws; ws.partner = a;
        a.send(JSON.stringify({ t: 'match', role: 'host' }));
        ws.send(JSON.stringify({ t: 'match', role: 'guest' }));
      } else waiting = ws;
    } else if (m.t === 'msg' && ws.partner && ws.partner.readyState === 1) {
      ws.partner.send(JSON.stringify({ t: 'msg', topic: String(m.topic).slice(0, 8), data: m.data, peer: ws.id }));
    }
  });
  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    if (ws.partner) { try { ws.partner.send(JSON.stringify({ t: 'left' })); } catch {} ws.partner.partner = null; }
  });
});
setInterval(() => wss.clients.forEach(c => { if (!c.alive) return c.terminate(); c.alive = false; c.ping(); }), 20000);
server.listen(process.env.PORT || 8080, () => console.log('listening'));
