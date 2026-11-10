// ===== Bean Barrage online server (prototype) =====
// 1v1 ranked: matchmaking by rating, server-authoritative games, Glicko-2 ratings, leaderboard.
// Zero dependencies: plain Node 18+.   Run:  node server.js   then open http://localhost:8080
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Board, levelOf, FRAMES, TITLES, cosmeticOk } = require('./engine.js');

const PORT = +process.env.PORT || 8080;
const DATA = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA, 'players.json');
const FT = 2;                 // first to 2 round wins
const PLACEMENT = 5;          // placement matches before you get a league rank
const TICK = 1000 / 60;

// ---------------- persistence ----------------
fs.mkdirSync(DATA, { recursive: true });
let DB = { players: {} };
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
let dirty = false;
function saveNow() { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(DB)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); dirty = false; }
setInterval(() => { if (dirty) saveNow(); }, 3000);
process.on('SIGINT', () => { saveNow(); process.exit(0); });

function newPlayer(name) {
  const id = crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(18).toString('hex');
  DB.players[id] = { id, token, name, r: 1500, rd: 350, vol: 0.06, games: 0, wins: 0, losses: 0, created: Date.now(), last: Date.now() };
  stats(DB.players[id]);
  dirty = true; return DB.players[id];
}
function stats(p) {
  if (!p.st) p.st = { best: 0, rocks: 0, pops: 0, fw: 0, fl: 0, bestStreak: 0, secs: 0 };
  if (!p.hist) p.hist = [];
  if (p.motto === undefined) p.motto = '';
  if (p.xp === undefined) p.xp = 0;
  if (!p.frame) p.frame = 'wood';
  if (!p.title) p.title = 'rookie';
  return p.st;
}
function cosmeticCtx(p) { const L = lg(p); return { level: levelOf(p.xp).level, best: (p.st && p.st.best) || 0, tier: L.tier, placed: L.placed >= PLACEMENT }; }
// XP: every match counts, wins count more, big chains add a bit, first win of the day is a fat bonus
function grantXp(p, parts) {
  const before = levelOf(p.xp), ctx0 = cosmeticCtx(p);
  const gain = parts.reduce((a, x) => a + x[1], 0);
  p.xp += gain; dirty = true;
  const after = levelOf(p.xp), ctx1 = cosmeticCtx(p);
  const unlocks = [...FRAMES.filter(f => !cosmeticOk(f, ctx0) && cosmeticOk(f, ctx1)).map(f => f.name + ' frame'),
                   ...TITLES.filter(t => !cosmeticOk(t, ctx0) && cosmeticOk(t, ctx1)).map(t => '"' + t.text + '" title')];
  return { gain, parts, before, after, unlocks, levelUp: after.level > before.level };
}
function firstWinBonus(p, won) {
  const day = new Date().toISOString().slice(0, 10);
  if (won && p.fwod !== day) { p.fwod = day; return [['First win of the day', 50]]; }
  return [];
}
for (const p of Object.values(DB.players)) stats(p);
function cleanMotto(m) { return String(m || '').replace(/[^\w !?.,'&+\-:()]/g, '').slice(0, 48); }
function byToken(t) { return Object.values(DB.players).find(p => p.token === t); }
function cleanName(n) { return String(n || '').replace(/[^A-Za-z0-9_ ]/g, '').trim().slice(0, 14) || 'Bean' + (Math.random() * 9999 | 0); }

// ---------------- league ----------------
// Visible ladder: Seed -> Sprout -> Vine -> Stalk -> Cloud (divisions III, II, I, 100 Bean Points each),
// then GIANT (open ladder). The top 10 Giants hold the GOLDEN GOOSE.
// Hidden MMR (Glicko-2) decides how many points you win/lose, so the ladder can't be farmed.
// Twists: Shell Shield (3 games of demotion protection after a promotion), Hot Streak (3+ wins: bonus BP),
// Promo Clash (Division I at 100 BP -> one all-or-nothing match to enter the next tier).
// The Beanstalk: you climb from a SEED in the dirt up to the GIANT's castle in the clouds.
const TIERS = ['SEED', 'SPROUT', 'VINE', 'STALK', 'CLOUD', 'GIANT'];
const BARON = TIERS.length - 1;
const ROMAN = ['', 'I', 'II', 'III'];
const tierMMR = (t, d) => t >= BARON ? 2250 : 1250 + t * 200 + (3 - d) * 66;   // where a division "should" sit
function lg(p) {
  if (!p.lg) p.lg = { tier: 0, div: 3, bp: 0, shield: 0, streak: 0, promo: false, peak: 0, placed: 0 };
  return p.lg;
}
function leagueLabel(p) {
  const L = lg(p);
  if (L.placed < PLACEMENT) return `PLACEMENT ${L.placed}/${PLACEMENT}`;
  if (L.tier >= BARON) return crownHolders().includes(p.id) ? 'GOLDEN GOOSE' : 'GIANT';
  return `${TIERS[L.tier]} ${ROMAN[L.div]}`;
}
function crownHolders() { return Object.values(DB.players).filter(q => q.lg && q.lg.tier >= BARON).sort((a, b) => b.lg.bp - a.lg.bp).slice(0, 10).map(q => q.id); }
function ladderValue(p) { const L = lg(p); return L.placed < PLACEMENT ? -1 : L.tier * 1000 + (L.tier >= BARON ? L.bp : (3 - L.div) * 100 + L.bp); }
function applyLeague(p, won) {
  const L = lg(p), notes = [];
  const before = { tier: L.tier, div: L.div, bp: L.bp };
  if (L.placed < PLACEMENT) {
    L.placed++;
    if (L.placed === PLACEMENT) {           // placement done: seed from hidden MMR, capped at GOLD II
      let t = 0, d = 3;
      for (let tt = 0; tt <= 2; tt++) for (let dd = 3; dd >= 1; dd--) if (p.r >= tierMMR(tt, dd) - 33 && !(tt === 2 && dd < 2)) { t = tt; d = dd; }
      L.tier = t; L.div = d; L.bp = 25; notes.push('PLACED');
    }
    L.streak = won ? Math.max(1, L.streak + 1) : 0;
    return { before, after: { tier: L.tier, div: L.div, bp: L.bp }, delta: 0, notes };
  }
  const gap = Math.max(-10, Math.min(12, (p.r - tierMMR(L.tier, L.div)) / 25));
  let delta;
  if (won) {
    L.streak = Math.max(1, L.streak + 1);
    delta = Math.round(20 + gap);
    if (L.streak >= 3) { const bonus = Math.min(8, (L.streak - 2) * 3); delta += bonus; notes.push('HOT STREAK +' + bonus); }
  } else {
    L.streak = 0;
    delta = -Math.round(Math.max(8, 19 - gap));
  }
  if (L.promo) {                      // Promo Clash result
    L.promo = false;
    if (won) { L.tier++; L.div = L.tier >= BARON ? 0 : 3; L.bp = 0; L.shield = 3; notes.push('PROMOTED'); }
    else { L.bp = 70; notes.push('PROMO CLASH LOST'); }
  } else if (L.tier >= BARON) {
    L.bp = Math.max(0, L.bp + delta);
    if (L.bp === 0 && !won && L.shield <= 0) { L.tier = BARON - 1; L.div = 1; L.bp = 75; notes.push('DEMOTED'); }
  } else {
    L.bp += delta;
    if (L.bp >= 100) {
      if (L.div > 1) { L.div--; L.bp -= 100; L.shield = 3; notes.push('PROMOTED'); }
      else { L.bp = 100; L.promo = true; notes.push('PROMO CLASH READY'); }
    } else if (L.bp < 0) {
      if (L.shield > 0) { L.bp = 0; notes.push('SHELL SHIELD'); }
      else if (L.tier === 0 && L.div === 3) L.bp = 0;
      else { if (L.div < 3) L.div++; else { L.tier--; L.div = 1; } L.bp = 75; notes.push('DEMOTED'); }
    }
  }
  if (L.shield > 0 && !notes.includes('PROMOTED')) L.shield--;
  L.peak = Math.max(L.peak, ladderValue(p));
  return { before, after: { tier: L.tier, div: L.div, bp: L.bp }, delta, notes };
}
function rankOf(p) { return leagueLabel(p); }
function valueLabel(v) {
  if (v < 0) return null;
  const t = Math.floor(v / 1000); if (t >= BARON) return 'GIANT';
  const d = 3 - Math.floor((v % 1000) / 100); return `${TIERS[t]} ${ROMAN[Math.max(1, Math.min(3, d))]}`;
}
function ladder() { return Object.values(DB.players).filter(p => ladderValue(p) >= 0).sort((a, b) => ladderValue(b) - ladderValue(a)); }
function profile(p) {
  const st = stats(p), L = lg(p), lad = ladder(), pos = lad.indexOf(p);
  return { ...pub(p), created: p.created, lastSeen: p.last, online: online.has(p.id),
           position: pos >= 0 ? pos + 1 : null, of: lad.length, peak: valueLabel(L.peak || -1),
           stats: { ...st, fw: st.fw, fl: st.fl }, hist: p.hist.slice(0, 25) };
}
function pub(p) {
  const L = lg(p);
  return { id: p.id, name: p.name, avatar: p.avatar || 'jelly_jo', rating: Math.round(p.r), rank: leagueLabel(p),
           league: { tier: L.tier, div: L.div, bp: L.bp, shield: L.shield, streak: L.streak, promo: L.promo, placed: L.placed, crown: L.tier >= BARON && crownHolders().includes(p.id) },
           games: p.games, wins: p.wins, losses: p.losses, motto: p.motto || '', best: (p.st && p.st.best) || 0,
           xp: p.xp || 0, ...levelOf(p.xp || 0), frame: p.frame || 'wood', title: p.title || 'rookie',
           fwod: p.fwod === new Date().toISOString().slice(0, 10) };
}

// ---------------- Glicko-2 ----------------
function glicko2(p, opp, score) {
  const Q = 173.7178, tau = 0.5;
  const mu = (p.r - 1500) / Q, phi = p.rd / Q, muj = (opp.r - 1500) / Q, phij = opp.rd / Q;
  const g = 1 / Math.sqrt(1 + 3 * phij * phij / (Math.PI * Math.PI));
  const E = 1 / (1 + Math.exp(-g * (mu - muj)));
  const v = 1 / (g * g * E * (1 - E));
  const delta = v * g * (score - E);
  const a = Math.log(p.vol * p.vol);
  const f = x => (Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x))) / (2 * Math.pow(phi * phi + v + Math.exp(x), 2)) - (x - a) / (tau * tau);
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v); else { let k = 1; while (f(a - k * tau) < 0) k++; B = a - k * tau; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 60 && Math.abs(B - A) > 1e-6; i++) { const C = A + (A - B) * fA / (fB - fA), fC = f(C); if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2; B = C; fB = fC; }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * g * (score - E);
  return { r: muNew * Q + 1500, rd: Math.max(45, Math.min(350, phiNew * Q)), vol };
}

// ---------------- websocket (RFC 6455, minimal) ----------------
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = { socket, buf: Buffer.alloc(0), alive: true, onmsg: null, onclose: null };
  conn.send = obj => {
    if (!conn.alive) return;
    const data = Buffer.from(JSON.stringify(obj)); const n = data.length;
    const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
    try { socket.write(Buffer.concat([head, data])); } catch (e) {}
  };
  const close = () => { if (!conn.alive) return; conn.alive = false; clearInterval(conn.ping); try { socket.destroy(); } catch (e) {} if (conn.onclose) conn.onclose(); };
  conn.close = close;
  // keep idle connections (e.g. waiting in a friend room) from being cut by proxies
  conn.ping = setInterval(() => { try { socket.write(Buffer.from([0x89, 0])); } catch (e) {} }, 20000);
  socket.on('data', chunk => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    while (conn.buf.length >= 2) {
      const b0 = conn.buf[0], b1 = conn.buf[1], op = b0 & 15, masked = b1 & 128;
      let len = b1 & 127, off = 2;
      if (len === 126) { if (conn.buf.length < 4) return; len = conn.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (conn.buf.length < 10) return; len = Number(conn.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return close();
      const mlen = masked ? 4 : 0;
      if (conn.buf.length < off + mlen + len) return;
      const mask = masked ? conn.buf.slice(off, off + 4) : null;
      const payload = Buffer.from(conn.buf.slice(off + mlen, off + mlen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      conn.buf = conn.buf.slice(off + mlen + len);
      if (op === 8) return close();
      if (op === 9) { try { socket.write(Buffer.concat([Buffer.from([0x8A, payload.length]), payload])); } catch (e) {} continue; }
      if (op === 1 && conn.onmsg) { let m; try { m = JSON.parse(payload.toString()); } catch (e) { continue; } conn.onmsg(m); }
    }
  });
  socket.on('close', close); socket.on('error', close);
  return conn;
}

// ---------------- sessions, queue, matches ----------------
const online = new Map();   // playerId -> conn
const queue = [];           // { p, since }
const matches = new Map();  // matchId -> match
const rooms = new Map();    // code -> { host conn, p }
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { let c; do { c = Array.from({ length: 5 }, () => CODE_CH[crypto.randomInt(CODE_CH.length)]).join(''); } while (rooms.has(c)); return c; }

function lobbyInfo() { return { online: online.size, queue: queue.length, matches: matches.size }; }

function handleConn(conn) {
  let me = null;
  conn.onmsg = m => {
    if (m.t === 'hello') {
      me = (m.token && byToken(m.token)) || newPlayer(cleanName(m.name));
      let tab = false;
      const prev = online.get(me.id);
      const tabId = String(m.tab || '').slice(0, 24);
      if (prev && prev !== conn && prev.alive) {
        if (tabId && prev.tabId === tabId) prev.close();      // same tab reloaded: replace the stale connection
        else { me = newPlayer('Guest' + (1000 + crypto.randomInt(9000))); tab = true; }   // second tab: its own guest account
      }
      conn.tabId = tabId;
      if (typeof m.avatar === 'string' && /^[a-z_]{3,20}$/.test(m.avatar)) me.avatar = m.avatar;
      online.set(me.id, conn); conn.pid = me.id; me.last = Date.now(); dirty = true;
      conn.send({ t: 'welcome', token: me.token, tab, me: pub(me), lobby: lobbyInfo() });
      return;
    }
    if (!me) return;
    if (m.t === 'rename') { me.name = cleanName(m.name); dirty = true; conn.send({ t: 'me', me: pub(me) }); }
    if (m.t === 'avatar' && /^[a-z_]{3,20}$/.test(m.avatar || '')) { me.avatar = m.avatar; dirty = true; conn.send({ t: 'me', me: pub(me) }); }
    if (m.t === 'queue') { if (!queue.find(q => q.p === me) && !conn.match) { queue.push({ p: me, since: Date.now() }); conn.send({ t: 'queued', lobby: lobbyInfo() }); } }
    if (m.t === 'unqueue') { const i = queue.findIndex(q => q.p === me); if (i >= 0) queue.splice(i, 1); conn.send({ t: 'unqueued' }); }
    if (m.t === 'key' && conn.match) conn.match.key(me.id, m.k, !!m.down);
    if (m.t === 'room_create' && !conn.match) {
      for (const [c, r] of rooms) if (r.p === me) rooms.delete(c);
      const code = newCode(); rooms.set(code, { host: conn, p: me, at: Date.now() }); conn.room = code;
      conn.send({ t: 'room', code });
    }
    if (m.t === 'room_cancel') { if (conn.room) rooms.delete(conn.room); conn.room = null; conn.send({ t: 'room_closed' }); }
    if (m.t === 'room_join' && !conn.match) {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const r = rooms.get(code);
      if (!r || !r.host.alive) { rooms.delete(code); conn.send({ t: 'room_error', why: 'ROOM NOT FOUND' }); return; }
      if (r.p === me) { conn.send({ t: 'room_error', why: "THAT'S YOUR OWN ROOM" }); return; }
      rooms.delete(code); r.host.room = null;
      new Match(r.p, me, r.host, conn, false);
    }
    if (m.t === 'rematch' && conn.last && !conn.match) {
      const L = conn.last; L.want = L.want || new Set(); L.want.add(me.id);
      const other = online.get(L.ids.find(id => id !== me.id));
      if (!other || !other.alive || other.match) { conn.send({ t: 'room_error', why: 'RIVAL LEFT' }); return; }
      other.send({ t: 'rematch_asked' });
      if (L.want.size === 2) { const pa = DB.players[L.ids[0]], pb = DB.players[L.ids[1]]; new Match(pa, pb, online.get(pa.id), online.get(pb.id), false); }
    }
    if (m.t === 'leaderboard') conn.send({ t: 'leaderboard', top: ladder().slice(0, 50).map(pub) });
    if (m.t === 'lobby') conn.send({ t: 'lobby', lobby: lobbyInfo() });
    if (m.t === 'cpu') {
      const now = Date.now(); me.cpuWin = (me.cpuWin || []).filter(t => now - t < 3600e3);
      if (me.cpuWin.length >= 25) return;            // max 25 rewarded CPU games an hour
      me.cpuWin.push(now);
      const parts = [[m.story ? (m.won ? 'Story win' : 'Story match') : (m.won ? 'CPU win' : 'CPU match'), m.won ? (m.story ? 20 : 12) : 4]];
      conn.send({ t: 'xp', xp: grantXp(me, parts), me: pub(me) });
    }
  };
  conn.onclose = () => {
    if (!me) return;
    if (online.get(me.id) === conn) online.delete(me.id);
    const i = queue.findIndex(q => q.p === me); if (i >= 0) queue.splice(i, 1);
    if (conn.room) rooms.delete(conn.room);
    if (conn.match) conn.match.forfeit(me.id);
  };
}

// matchmaking: closest ratings, window widens the longer you wait
setInterval(() => {
  const now = Date.now();
  queue.sort((a, b) => a.p.r - b.p.r);
  for (let i = 0; i + 1 < queue.length; i++) {
    const A = queue[i], B = queue[i + 1];
    const win = q => 100 + (now - q.since) / 1000 * 30;
    if (Math.abs(A.p.r - B.p.r) <= Math.min(win(A), win(B)) || now - Math.max(A.since, B.since) > 30000) {
      queue.splice(i, 2); i--;
      const ca = online.get(A.p.id), cb = online.get(B.p.id);
      if (ca && cb && ca.alive && cb.alive) new Match(A.p, B.p, ca, cb);
      else { if (ca) queue.push(A); if (cb) queue.push(B); }
    }
  }
}, 500);

class Ctl {  // server-side copy of the client's key handling (DAS)
  constructor(board) { this.b = board; this.held = {}; this.edge = {}; this.das = 0; this.dir = 0; }
  key(k, down) { if (down && !this.held[k]) this.edge[k] = true; this.held[k] = down; }
  update() {
    const b = this.b, h = this.held;
    b.softDrop = !!h.down;
    if (this.edge.cw) b.rotate(1);
    if (this.edge.ccw) b.rotate(-1);
    const d = h.left ? -1 : h.right ? 1 : 0;
    if (d !== this.dir) { this.dir = d; this.das = 0; if (d) b.move(d); }
    else if (d) { this.das++; if (this.das > 9 && this.das % 2 === 0) b.move(d); }
    this.edge = {};
  }
}

class Match {
  constructor(pa, pb, ca, cb, ranked = true) {
    this.id = crypto.randomBytes(5).toString('hex'); this.ranked = ranked;
    this.p = [pa, pb]; this.c = [ca, cb]; this.wins = [0, 0]; this.round = 0; this.over = false;
    this.best = [0, 0]; this.rocks = [0, 0]; this.pops = [0, 0]; this.t0 = Date.now();
    ca.match = this; cb.match = this;
    matches.set(this.id, this);
    for (let s = 0; s < 2; s++) this.c[s].send({ t: 'match', id: this.id, side: s, ranked: this.ranked, you: pub(this.p[s]), opp: pub(this.p[1 - s]), ft: FT });
    this.startRound();
    this.timer = setInterval(() => this.tick(), TICK);
  }
  startRound() {
    this.round++; this.frame = 0; this.phase = 'countdown'; this.phaseT = 180;
    const seed = crypto.randomBytes(4).readUInt32BE(0);
    this.b = [new Board(0, seed, { colors: 5 }), new Board(1, seed, { colors: 5 })];
    this.b[0].opponent = this.b[1]; this.b[1].opponent = this.b[0];
    this.ctl = [new Ctl(this.b[0]), new Ctl(this.b[1])];
    this.events = [[], []];
    this.broadcast({ t: 'round', round: this.round, wins: this.wins });
  }
  key(pid, k, down) { const s = this.p[0].id === pid ? 0 : 1; if (['left', 'right', 'down', 'cw', 'ccw'].includes(k)) this.ctl[s].key(k, down); }
  tick() {
    if (this.over) return;
    if (this.phase === 'countdown') { if (--this.phaseT <= 0) this.phase = 'play'; }
    else if (this.phase === 'play') {
      this.frame++;
      const sp = Math.min(0.16, 0.03 + this.frame / 3600 * 0.014);
      for (let s = 0; s < 2; s++) { this.b[s].speed = sp; this.ctl[s].update(); this.b[s].update(); }
      for (let s = 0; s < 2; s++) {
        for (const e of this.b[s].events) {
          if (e.t === 'move' || e.t === 'rot') continue;
          if (e.t === 'pop') { this.pops[s]++; this.best[s] = Math.max(this.best[s], e.chain); }
          if (e.t === 'send') this.rocks[s] += e.n;
          this.events[s].push(e);
        }
        this.b[s].events.length = 0;
      }
      const l0 = this.b[0].lost, l1 = this.b[1].lost;
      if (l0 || l1) {
        const w = l0 && l1 ? (this.b[0].score >= this.b[1].score ? 0 : 1) : l0 ? 1 : 0;
        this.wins[w]++; this.phase = 'roundover'; this.phaseT = 150;
        this.b[w].state = 'won'; this.b[1 - w].state = 'dead';
        this.broadcast({ t: 'roundover', winner: w, wins: this.wins });
      }
    } else if (this.phase === 'roundover') {
      for (const b of this.b) b.stepAnim();
      if (--this.phaseT <= 0) { if (Math.max(...this.wins) >= FT) this.finish(this.wins[0] > this.wins[1] ? 0 : 1, 'win'); else this.startRound(); }
    }
    if (this.frame % 2 === 0 || this.phase !== 'play') this.sendState();
  }
  snap(b) {
    return {
      g: b.grid.map(r => r.map(c => c < 0 ? '.' : c).join('')).join(''),
      pc: b.piece ? [b.piece.x, b.piece.y, +b.piece.fy.toFixed(2), b.piece.rot, b.piece.a, b.piece.b] : null,
      nx: [b.peek(0), b.peek(1)], pend: b.pending, sc: b.score, st: b.state,
      pop: b.popping ? [b.popping.t, [...b.popping.cells]] : null,
      an: b.anim.size ? [...b.anim].map(([i, o]) => [i, Math.round(o)]) : null,
      ct: b.chainText ? [b.chainText.text, b.chainText.t, b.chainText.chain, b.chainText.groups, b.chainText.junk || 0] : null,
      sp: b.state === 'fall' ? +(b.softDrop ? Math.max(0.5, b.speed) : b.speed).toFixed(3) : 0,
    };
  }
  sendState() {
    const msg = { t: 'state', ph: this.phase, pt: this.phaseT, f: this.frame, b: [this.snap(this.b[0]), this.snap(this.b[1])], ev: this.events };
    this.broadcast(msg); this.events = [[], []];
  }
  broadcast(m) { for (const c of this.c) c.send(m); }
  forfeit(pid) { if (this.over) return; const s = this.p[0].id === pid ? 0 : 1; this.finish(1 - s, 'forfeit'); }
  finish(w, how) {
    if (this.over) return; this.over = true; clearInterval(this.timer);
    const [A, B] = this.p; const before = [pub(A), pub(B)]; const lres = [null, null];
    if (this.ranked) {
      const na = glicko2(A, B, w === 0 ? 1 : 0), nb = glicko2(B, A, w === 1 ? 1 : 0);
      Object.assign(A, na); Object.assign(B, nb);
      lres[0] = applyLeague(A, w === 0); lres[1] = applyLeague(B, w === 1);
      for (const s of [0, 1]) { const P = this.p[s]; P.games++; if (s === w) P.wins++; else P.losses++; P.last = Date.now(); }
    }
    const secs = Math.round((Date.now() - this.t0) / 1000);
    for (const s of [0, 1]) {
      const P = this.p[s], O = this.p[1 - s], st = stats(P), won = s === w;
      st.best = Math.max(st.best, this.best[s]); st.rocks += this.rocks[s]; st.pops += this.pops[s]; st.secs += secs;
      if (!this.ranked) { if (won) st.fw++; else st.fl++; }
      if (this.ranked) st.bestStreak = Math.max(st.bestStreak, lg(P).streak);
      const parts = [];
      if (this.ranked) parts.push(won ? ['Ranked win', 60] : ['Ranked match', 25]);
      else parts.push(won ? ['Friendly win', 35] : ['Friendly match', 15]);
      if (how === 'forfeit' && won) parts[0][1] = Math.round(parts[0][1] / 2), parts[0][0] += ' (rival left)';
      if (this.best[s] >= 3) parts.push([`${this.best[s]}x chain`, Math.min(21, (this.best[s] - 2) * 3)]);
      parts.push(...firstWinBonus(P, won && how !== 'forfeit'));
      this.xpRes = this.xpRes || [null, null]; this.xpRes[s] = grantXp(P, parts);
      P.hist.unshift({ at: Date.now(), ranked: this.ranked, won, how, score: [this.wins[s], this.wins[1 - s]],
        opp: { id: O.id, name: O.name, avatar: O.avatar || 'jelly_jo' }, me: P.avatar || 'jelly_jo',
        delta: lres[s] ? lres[s].delta : 0, rank: this.ranked ? leagueLabel(P) : null, chain: this.best[s], rocks: this.rocks[s], secs });
      if (P.hist.length > 25) P.hist.length = 25;
      P.last = Date.now();
    }
    dirty = true; saveNow();
    for (let s = 0; s < 2; s++) {
      this.c[s].send({ t: 'matchover', ranked: this.ranked, winner: w, how, wins: this.wins, before: before[s], after: pub(this.p[s]), opp: pub(this.p[1 - s]), league: lres[s], xp: this.xpRes ? this.xpRes[s] : null });
      this.c[s].match = null; this.c[s].last = { ids: [A.id, B.id] };
    }
    matches.delete(this.id);
  }
}

// ---------------- http ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/api/leaderboard') {
    return json(200, ladder().slice(0, 200).map((p, i) => ({ ...pub(p), position: i + 1, online: online.has(p.id) })));
  }
  if (url.pathname.startsWith('/api/profile/')) {
    const p = DB.players[url.pathname.slice(13)];
    return p ? json(200, profile(p)) : json(404, { error: 'not found' });
  }
  if (url.pathname === '/api/me') {
    const p = byToken(req.headers['x-token'] || '');
    if (!p) return json(401, { error: 'no account' });
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 4000) req.destroy(); });
      req.on('end', () => {
        let m = {}; try { m = JSON.parse(body); } catch (e) {}
        if (typeof m.name === 'string' && m.name.trim()) p.name = cleanName(m.name);
        if (typeof m.motto === 'string') p.motto = cleanMotto(m.motto);
        if (typeof m.avatar === 'string' && /^[a-z_]{3,20}$/.test(m.avatar)) p.avatar = m.avatar;
        const cx = cosmeticCtx(p);
        if (typeof m.frame === 'string' && cosmeticOk(FRAMES.find(f => f.id === m.frame), cx)) p.frame = m.frame;
        if (typeof m.title === 'string' && cosmeticOk(TITLES.find(t => t.id === m.title), cx)) p.title = m.title;
        dirty = true;
        const c = online.get(p.id); if (c) c.send({ t: 'me', me: pub(p) });
        json(200, profile(p));
      });
      return;
    }
    return json(200, profile(p));
  }
  if (url.pathname === '/api/status') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(lobbyInfo())); }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }
  res.writeHead(404); res.end('not found');
});
server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();
  handleConn(wsAccept(req, socket));
});
if (require.main === module) server.listen(PORT, () => console.log(`Bean Barrage server on http://localhost:${PORT}`));
module.exports = { server, glicko2, DB, applyLeague, lg, leagueLabel, profile };
