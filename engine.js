// ===== Bean Barrage engine: rules, boards, CPU brain. No DOM. =====
const COLS = 6, ROWS = 13; // row 0 is the hidden spawn row, rows 1..12 visible
const EMPTY = -1, JUNK = 5, NCOL = 5;
const CHAIN_POWER = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512, 544];
const COLOR_BONUS = [0, 3, 6, 12, 24];
const GROUP_BONUS = n => n <= 4 ? 0 : n >= 11 ? 10 : n - 3;
const MULTI_BONUS = [0, 0, 6, 12, 24, 48, 64]; // popping 2+ separate groups in one step
// Junk sent per pop step. Every pop sends something; small pops stay small, long chains get brutal.
// Rocks come from what you actually popped, not just how long the chain was:
//   power of a chain step = beans popped in that step x chain step (+2 beans per extra group popped at once)
//   rocks = power / 2.5, leftovers carry over to your next pop.
// Grows steadily instead of exploding: a 2-chain of 6+6 beans (7) is close to a 3-chain of 4+4+4 (9).
// 1 pop of 4: 1 | 2-chain: 4-5 | 3-chain: 9-10 | 4-chain: 16 | 5-chain: 24 | 6-chain: 33 | 7-chain: 44
const JUNK_DIV = 2.5;
function junkFor(pop, chain) {
  const beans = pop.beans + 2 * Math.max(0, pop.groups.length - 1);
  return beans * chain / JUNK_DIV;                  // fractional; the board keeps the leftover
}
const ROT = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // satellite offset per rotation
const JUNK_RATE = 70;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function newGrid() { const g = []; for (let y = 0; y < ROWS; y++) { g.push(new Array(COLS).fill(EMPTY)); } return g; }
function cloneGrid(g) { return g.map(r => r.slice()); }

// compact columns downward; returns list of moves {x, from, to}
function applyGravity(g) {
  const moves = [];
  for (let x = 0; x < COLS; x++) {
    let w = ROWS - 1;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (g[y][x] !== EMPTY) {
        if (y !== w) { g[w][x] = g[y][x]; g[y][x] = EMPTY; moves.push({ x, from: y, to: w }); }
        w--;
      }
    }
  }
  return moves;
}

// find groups of >=4 among visible rows; returns {cells:Set(idx), groups:[size], colors:Set}
function findPops(g) {
  const seen = new Uint8Array(ROWS * COLS);
  const cells = []; const groups = []; const colors = new Set();
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = g[y][x]; const i = y * COLS + x;
    if (c < 0 || c >= NCOL || seen[i]) continue;
    const stack = [i]; const grp = []; seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(); grp.push(j);
      const jy = (j / COLS) | 0, jx = j % COLS;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = jx + dx, ny = jy + dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        const k = ny * COLS + nx;
        if (!seen[k] && g[ny][nx] === c) { seen[k] = 1; stack.push(k); }
      }
    }
    if (grp.length >= 4) { cells.push(...grp); groups.push(grp.length); colors.add(c); }
  }
  if (!cells.length) return null;
  // junk next to popping beans goes too
  const set = new Set(cells); const junk = [];
  for (const j of cells) {
    const jy = (j / COLS) | 0, jx = j % COLS;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = jx + dx, ny = jy + dy;
      if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
      const k = ny * COLS + nx;
      if (g[ny][nx] === JUNK && !set.has(k)) { set.add(k); junk.push(k); }
    }
  }
  return { cells: set, beans: cells.length, groups, colors: colors.size, junk };
}

function stepScore(pop, chain) {
  let mult = CHAIN_POWER[Math.min(chain - 1, CHAIN_POWER.length - 1)] + COLOR_BONUS[pop.colors - 1];
  for (const n of pop.groups) mult += GROUP_BONUS(n);
  mult += MULTI_BONUS[Math.min(pop.groups.length, MULTI_BONUS.length - 1)];
  mult = Math.max(1, Math.min(999, mult));
  return { base: 10 * pop.beans, mult, pts: 10 * pop.beans * mult };
}

// full resolve on a grid copy (for the AI); returns {score, chains}
function simulateResolve(g) {
  let chain = 0, score = 0, beans = 0, multi = 0, biggest = 0, junk = 0;
  applyGravity(g);
  for (;;) {
    const p = findPops(g); if (!p) break;
    chain++; score += stepScore(p, chain).pts; beans += p.beans; junk += junkFor(p, chain);
    multi = Math.max(multi, p.groups.length); biggest = Math.max(biggest, ...p.groups);
    for (const i of p.cells) g[(i / COLS) | 0][i % COLS] = EMPTY;
    applyGravity(g);
  }
  return { score, chains: chain, beans, multi, biggest, junk };
}

function colHeight(g, x) { for (let y = 0; y < ROWS; y++) if (g[y][x] !== EMPTY) return ROWS - y; return 0; }

// ---------------- Board ----------------
class Board {
  constructor(side, seed, opts = {}) {
    this.side = side;
    this.grid = newGrid();
    this.rand = rng(seed);           // shared-seed sequence so both players get the same pairs
    this.junkRand = rng(seed * 31 + 7 + side * 1013); // junk scatter never touches the pair sequence
    this.queue = [];
    this.score = 0;
    this.pending = 0;                // junk waiting to fall on me
    this.junkAcc = 0;                // score not yet converted to junk
    this.state = 'spawn';
    this.timer = 0;
    this.piece = null;
    this.chain = 0;
    this.maxChain = 0;
    this.popping = null;
    this.anim = new Map();           // idx -> pixel offset (negative = above)
    this.vel = new Map();
    this.slow = new Set();           // junk falls lazily
    this.squash = new Map();         // idx -> frames left
    this.lost = false;
    this.speed = opts.speed || 0.02; // cells per frame
    this.events = [];                // for UI/audio: {t:'pop',chain,...}
    this.opponent = null;
    this.lockFrames = 0; this.lockResets = 0;
    this.softDrop = false;
    this.lastRotFail = -99; this.frame = 0;
    this.chainText = null;
    this.pairsUsed = 0;
    this.colors = opts.colors || 5;
  }
  nextPair() {
    while (this.queue.length < 3) {
      const r = this.rand; const n = this.colors;
      this.queue.push([Math.floor(r() * n), Math.floor(r() * n)]);
    }
    return this.queue.shift();
  }
  peek(i = 0) { while (this.queue.length < 3) { const r = this.rand; const n = this.colors; this.queue.push([Math.floor(r() * n), Math.floor(r() * n)]); } return this.queue[i]; }
  cells(p = this.piece) { const [dx, dy] = ROT[p.rot]; return [[p.x, p.y], [p.x + dx, p.y + dy]]; }
  free(x, y) { return x >= 0 && x < COLS && y < ROWS && (y < 0 || this.grid[y][x] === EMPTY); }
  fits(p) { return this.cells(p).every(([x, y]) => this.free(x, y)); }

  spawn() {
    if (this.grid[1][2] !== EMPTY) { this.lost = true; this.state = 'dead'; this.events.push({ t: 'lose' }); return; }
    const [a, b] = this.nextPair();
    this.piece = { x: 2, y: 1, rot: 0, a, b, fy: 0 };
    this.lockFrames = 0; this.lockResets = 0;
    this.state = 'fall'; this.pairsUsed++;
    this.events.push({ t: 'spawn' });
  }
  move(dx) {
    if (this.state !== 'fall') return false;
    const p = { ...this.piece, x: this.piece.x + dx };
    if (this.fits(p) && (p.fy === 0 || this.fits({ ...p, y: p.y + 1 }) || true)) {
      // when mid-cell, also make sure the cell below-partial is free
      if (p.fy > 0 && !this.fits({ ...p, y: p.y + 1 })) return false;
      this.piece = p; this.touchLock(); this.events.push({ t: 'move' }); return true;
    }
    return false;
  }
  rotate(dir) {
    if (this.state !== 'fall') return false;
    const cur = this.piece;
    const nr = (cur.rot + dir + 4) % 4;
    const tries = [[0, 0]];
    const [sx, sy] = ROT[nr];
    if (sx !== 0) tries.push([-sx, 0]);
    if (sy === 1) tries.push([0, -1]);
    for (const [kx, ky] of tries) {
      const p = { ...cur, rot: nr, x: cur.x + kx, y: cur.y + ky, fy: ky ? 0 : cur.fy };
      if (this.fits(p) && (p.fy === 0 || this.fits({ ...p, y: p.y + 1 }))) { this.piece = p; this.touchLock(); this.events.push({ t: 'rot' }); return true; }
    }
    // quick-flip: two failed rotations in quick succession swap the pair vertically
    if (this.frame - this.lastRotFail < 24 && (cur.rot === 0 || cur.rot === 2)) {
      const p = { ...cur, rot: (cur.rot + 2) % 4 };
      if (p.rot === 2 && !this.fits(p)) p.y -= 1;
      if (this.fits(p)) { this.piece = p; this.lastRotFail = -99; this.events.push({ t: 'rot' }); return true; }
    }
    this.lastRotFail = this.frame;
    return false;
  }
  touchLock() { if (this.lockFrames > 0 && this.lockResets < 10) { this.lockFrames = 0; this.lockResets++; } }

  lockPiece() {
    const p = this.piece; const cs = this.cells(p); const cols = [p.a, p.b];
    // place lower cell first
    const order = cs[0][1] >= cs[1][1] ? [0, 1] : [1, 0];
    for (const k of order) { const [x, y] = cs[k]; if (y >= 0) this.grid[y][x] = cols[k]; }
    this.piece = null; this.chain = 0;
    this.events.push({ t: 'land' });
    for (const [x, y] of cs) if (y >= 0) this.squash.set(y * COLS + x, 8);
    this.startDrop();
  }
  startDrop() {
    const moves = applyGravity(this.grid);
    for (const m of moves) {
      const idx = m.to * COLS + m.x;
      this.anim.set(idx, (this.anim.get(idx) || 0) - (m.to - m.from) * 16);
      this.vel.set(idx, 0);
    }
    this.state = 'drop';
  }
  stepAnim() {
    let moving = false;
    for (const [idx, off] of this.anim) {
      const sl = this.slow.has(idx);
      const v = Math.min((this.vel.get(idx) || 0) + (sl ? 0.13 : 0.45), sl ? 3.2 : 8);
      const n = Math.min(0, off + v);
      if (n === 0) { this.anim.delete(idx); this.vel.delete(idx); this.slow.delete(idx); this.squash.set(idx, 8); }
      else { this.anim.set(idx, n); this.vel.set(idx, v); moving = true; }
    }
    for (const [idx, f] of this.squash) { if (f <= 1) this.squash.delete(idx); else this.squash.set(idx, f - 1); }
    return moving;
  }
  check() {
    const p = findPops(this.grid);
    if (!p) {
      if (this.chain > 0) this.events.push({ t: 'chainEnd', chain: this.chain });
      this.chain = 0;
      // drop junk if any is waiting
      if (this.pending > 0 && !this.droppedThisTurn) { this.dropJunk(); return; }
      this.droppedThisTurn = false;
      this.state = 'spawn';
      return;
    }
    this.chain++; this.maxChain = Math.max(this.maxChain, this.chain);
    const s = stepScore(p, this.chain);
    this.score += s.pts;
    this.chainText = { text: `${s.base}x${s.mult}`, t: 90, chain: this.chain, groups: p.groups.length, beans: p.beans };
    this.popping = { cells: p.cells, t: 0 };
    this.state = 'pop';
    this.events.push({ t: 'pop', chain: this.chain, beans: p.beans, pts: s.pts, groups: p.groups.length, junk: Math.floor(junkFor(p, this.chain)) });
    // junk: beans x chain step, leftovers carry over; offsets what's coming at you first
    this.junkFrac = (this.junkFrac || 0) + junkFor(p, this.chain);
    let n = Math.floor(this.junkFrac + 1e-9); this.junkFrac -= n;
    this.chainText.junk = n; this.junkSent = (this.junkSent || 0) + n;
    if (n > 0) {
      const cancel = Math.min(n, this.pending); this.pending -= cancel; n -= cancel;
      if (n > 0 && this.opponent) { this.opponent.pending += n; this.events.push({ t: 'send', n }); this.opponent.events.push({ t: 'incoming', n }); }
    }
  }
  dropJunk() {
    const n = Math.min(this.pending, 30); this.pending -= n;
    const counts = new Array(COLS).fill(Math.floor(n / COLS));
    let rem = n % COLS; const order = [0, 1, 2, 3, 4, 5].map(v => [this.junkRand(), v]).sort((p, q) => p[0] - q[0]).map(v => v[1]);
    for (let i = 0; i < rem; i++) counts[order[i]]++;
    for (let x = 0; x < COLS; x++) {
      let top = 0; while (top < ROWS && this.grid[top][x] === EMPTY) top++;
      for (let k = 0; k < counts[x]; k++) {
        const y = top - 1 - k; if (y < 0) break;
        this.grid[y][x] = JUNK;
        const idx = y * COLS + x; this.anim.set(idx, -(counts[x] + 4 + this.junkRand() * 2.5) * 16); this.vel.set(idx, 0); this.slow.add(idx);
      }
    }
    this.droppedThisTurn = true;
    this.events.push({ t: 'junk', n });
    this.state = 'drop';
  }
  update(input) {
    this.frame++;
    if (this.chainText && --this.chainText.t <= 0) this.chainText = null;
    if (this.state === 'dead' || this.state === 'won' || this.state === 'idle') { this.stepAnim(); return; }
    if (this.state === 'spawn') { this.spawn(); return; }
    if (this.state === 'fall') {
      const p = this.piece;
      const sp = this.softDrop ? Math.max(0.5, this.speed) : this.speed;
      const below = { ...p, y: p.y + 1 };
      if (this.fits(below)) {
        p.fy += sp;
        this.lockFrames = 0;
        while (p.fy >= 1) {
          if (this.fits({ ...p, y: p.y + 1 })) { p.y++; p.fy -= 1; if (this.softDrop) this.score += 1; }
          else { p.fy = 0; break; }
        }
      } else {
        p.fy = 0;
        this.lockFrames++;
        if (this.lockFrames > (this.softDrop ? 4 : 28)) this.lockPiece();
      }
      this.stepAnim();
      return;
    }
    if (this.state === 'drop') { if (!this.stepAnim()) this.state = 'check'; return; }
    if (this.state === 'check') { this.check(); return; }
    if (this.state === 'pop') {
      this.stepAnim();
      if (++this.popping.t >= 34) {
        for (const i of this.popping.cells) this.grid[(i / COLS) | 0][i % COLS] = EMPTY;
        this.popping = null; this.startDrop();
      }
    }
  }
  height(x) { return colHeight(this.grid, x); }
  maxHeight() { let m = 0; for (let x = 0; x < COLS; x++) m = Math.max(m, this.height(x)); return m; }
}

// ---------------- CPU brain v2 ----------------
// Every rival plays fair: same pieces, same rules, human-ish input speed. They differ in how they build.
// fire = how many junk beans a pop must send before they'll trigger it (patience).
// strat: tetris (flat lines, pops whatever), tower (vertical stacks), speed (fast hands, simple reads),
// side (piles one wall), twochain (always sets up a quick 2-chain and fires it), combo (big clusters,
// multi-group pops), chain (patient staircase chains), counter (keeps low, fires back when junk is coming)
const STYLES = [
  { id: 'granny_gourd',   strat: 'tetris',   delay: 15, think: 26, noise: 0.85, look: 0, pot: 0.00, fire: 1 },
  { id: 'slime_king',     strat: 'tower',    delay: 13, think: 22, noise: 0.70, look: 0, pot: 0.00, fire: 2 },
  { id: 'dj_spudz',       strat: 'speed',    delay: 3,  think: 4,  noise: 0.80, look: 0, pot: 0.05, fire: 2, soft: 1 },
  { id: 'madame_mollusk', strat: 'side',     delay: 15, think: 30, noise: 0.45, look: 0, pot: 0.30, fire: 6, side: -1 },
  { id: 'professor_hoot', strat: 'chain',    delay: 10, think: 18, noise: 0.40, look: 0, pot: 0.60, fire: 4, soft: 1 },
  { id: 'astro_ape',      strat: 'speed',    delay: 3,  think: 4,  noise: 0.40, look: 0, pot: 0.30, fire: 3, soft: 1 },
  { id: 'tiki_tom',       strat: 'side',     delay: 8,  think: 14, noise: 0.28, look: 1, pot: 0.50, fire: 7, side: 1, soft: 1 },
  { id: 'cactus_jack',    strat: 'twochain', delay: 5,  think: 9,  noise: 0.22, look: 1, pot: 0.50, fire: 2, soft: 1 },
  { id: 'yeti_betty',     strat: 'combo',    delay: 7,  think: 12, noise: 0.18, look: 1, pot: 0.50, fire: 6, soft: 1 },
  { id: 'captain_kraken', strat: 'combo',    delay: 6,  think: 10, noise: 0.12, look: 1, pot: 0.70, fire: 8, soft: 1 },
  { id: 'glitch',         strat: 'twochain', delay: 3,  think: 4,  noise: 0.25, look: 1, pot: 0.60, fire: 2, soft: 1 },
  { id: 'sir_crumbs',     strat: 'counter',  delay: 6,  think: 10, noise: 0.08, look: 1, pot: 0.80, fire: 6, soft: 1 },
  { id: 'mega_mutt',      strat: 'twochain', delay: 4,  think: 7,  noise: 0.05, look: 1, pot: 0.90, fire: 2, soft: 1, aggro: 1 },
  { id: 'sgt_brick',      strat: 'tower',    delay: 4,  think: 7,  noise: 0.03, look: 1, pot: 1.05, fire: 12, soft: 1, counter: 1 },
  { id: 'count_fangula',  strat: 'chain',    delay: 3,  think: 6,  noise: 0.00, look: 1, pot: 1.25, fire: 15, soft: 1, counter: 1, aggro: 1 },
  // final boss: Fangula's chain brain, faster hands, and it punishes every opening
  { id: 'giant_grumble',  strat: 'chain',    delay: 2,  think: 4,  noise: 0.00, look: 1, pot: 1.40, fire: 18, soft: 1, counter: 1, aggro: 1 },
];
const AI_LEVELS = i => STYLES[Math.max(0, Math.min(STYLES.length - 1, i))];

function placements() {
  const out = [];
  for (let rot = 0; rot < 4; rot++) for (let x = 0; x < COLS; x++) {
    const sx = x + ROT[rot][0];
    if (sx < 0 || sx >= COLS) continue;
    if ((rot === 2) && false) continue;
    out.push({ x, rot });
  }
  return out;
}

function placeOn(g, pl, a, b) {
  const sx = pl.x + ROT[pl.rot][0];
  const drop = (x, c) => { let y = ROWS - 1; while (y >= 0 && g[y][x] !== EMPTY) y--; if (y < 0) return false; g[y][x] = c; return true; };
  if (sx === pl.x) {
    const lower = pl.rot === 0 ? a : b, upper = pl.rot === 0 ? b : a;
    return drop(pl.x, lower) && drop(pl.x, upper);
  }
  return drop(pl.x, a) && drop(sx, b);
}

function reachable(g, pl) {
  const cols = [pl.x, pl.x + ROT[pl.rot][0]];
  const lo = Math.min(2, ...cols), hi = Math.max(2, ...cols);
  for (let x = lo; x <= hi; x++) if (g[1][x] !== EMPTY) return false;
  return true;
}

// how big a chain could this board fire with 1-2 more beans in the right place?
function chainPotential(g) {
  let best = { score: 0, chains: 0 };
  for (let x = 0; x < COLS; x++) {
    if (g[2][x] !== EMPTY) continue;
    let top = 0; while (top < ROWS && g[top][x] === EMPTY) top++;
    const near = new Set();
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [-1, 1], [1, 1]]) {
      const yy = Math.min(ROWS - 1, top + dy), xx = x + dx;
      if (xx >= 0 && xx < COLS && g[yy][xx] >= 0 && g[yy][xx] < NCOL) near.add(g[yy][xx]);
    }
    for (const c of near) for (const k of [1, 2]) {
      const g2 = cloneGrid(g); let ok = true;
      for (let i = 0; i < k; i++) { let y = ROWS - 1; while (y >= 0 && g2[y][x] !== EMPTY) y--; if (y < 1) { ok = false; break; } g2[y][x] = c; }
      if (!ok) continue;
      const r = simulateResolve(g2);
      if (r.score > best.score) best = { score: r.score / k, chains: r.chains };
    }
  }
  return best;
}

function clusters(g) {
  const seen = new Uint8Array(ROWS * COLS); let s3 = 0, s2 = 0;
  for (let y = 1; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = g[y][x]; if (c < 0 || c >= NCOL || seen[y * COLS + x]) continue;
    let n = 0; const st = [[x, y]]; seen[y * COLS + x] = 1;
    while (st.length) { const [cx, cy] = st.pop(); n++; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || nx >= COLS || ny < 1 || ny >= ROWS) continue; const k = ny * COLS + nx; if (!seen[k] && g[ny][nx] === c) { seen[k] = 1; st.push([nx, ny]); } } }
    if (n === 3) s3++; else if (n === 2) s2++;
  }
  return { s3, s2 };
}

function evalGrid(g, res, st, ctx, pl) {
  const heights = []; for (let x = 0; x < COLS; x++) heights.push(colHeight(g, x));
  if (heights[2] >= 12) return -1e9;
  const maxH = Math.max(...heights);
  const danger = heights[2] >= 10 || maxH >= 11;
  const S = st.strat;
  let s = 0;
  const junk = res.junk;
  // ---- when to pull the trigger
  if (res.chains > 0) {
    let fire = danger || junk >= st.fire
      || ((st.counter || S === 'counter') && ctx.pending >= 2 && junk >= Math.min(ctx.pending, 4))
      || (ctx.pending >= 8 && junk >= 3)
      || (st.aggro && ctx.oppHigh >= 8 && junk >= 3)
      || (ctx.oppHigh >= 10 && junk >= 2);
    if (S === 'twochain') fire = danger || res.chains >= 2 || (ctx.pending >= 4 && junk >= 2);
    if (S === 'combo') fire = danger || res.multi >= 2 || res.biggest >= 6 || res.chains >= 3 || junk >= st.fire;
    if (S === 'tetris' || S === 'speed') fire = true;
    if (fire) {
      s += res.score * 1.2 + junk * 140;
      if (S === 'twochain' && res.chains >= 2) s += 900;
      if (S === 'combo') s += res.multi * 500 + res.biggest * 60;
    } else s -= 160 + res.score * 0.35;
    if (S === 'twochain' && res.chains === 1 && !danger) s -= 500;
  }
  // ---- shape preferences per strategy
  let h = 0, v = 0;
  for (let y = 1; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const c = g[y][x]; if (c < 0 || c >= NCOL) continue;
    if (x + 1 < COLS && g[y][x + 1] === c) h++;
    if (y + 1 < ROWS && g[y + 1][x] === c) v++;
  }
  let bump = 0; for (let x = 0; x + 1 < COLS; x++) bump += Math.abs(heights[x] - heights[x + 1]);
  const vert = pl && (pl.rot === 0 || pl.rot === 2);
  switch (S) {
    case 'tetris':
      s += h * 20 + v * 16 - bump * 14; s += vert ? -50 : 50;
      for (let x = 0; x < COLS; x++) s -= heights[x] * heights[x] * 0.8;
      break;
    case 'tower':
      s += v * 30 + h * 3 - bump * 2; s += vert ? 90 : -40;
      for (let x = 0; x < COLS; x++) s -= heights[x] * heights[x] * (x === 2 ? 3 : 0.45);
      break;
    case 'side': {
      const w = st.side < 0 ? [44, 26, 0, -18, -30, -38] : [-38, -30, -18, 0, 26, 44];
      s += h * 12 + v * 16;
      for (let x = 0; x < COLS; x++) { s += w[x] * heights[x]; s -= heights[x] * heights[x] * (x === 2 ? 3.2 : 0.7); }
      break;
    }
    case 'speed':
      s += h * 12 + v * 12 - bump * 6;
      for (let x = 0; x < COLS; x++) s -= heights[x] * heights[x] * (x === 2 ? 3 : 1);
      break;
    case 'combo': {
      const cl = clusters(g);
      s += h * 14 + v * 14 + cl.s3 * 140 + cl.s2 * 30 - bump * 5;
      for (let x = 0; x < COLS; x++) s -= heights[x] * heights[x] * (x === 2 ? 3.2 : 0.9);
      break;
    }
    case 'twochain':
    case 'chain':
    case 'counter':
    default:
      s += h * 14 + v * 17 - bump * 5;
      for (let x = 0; x < COLS; x++) s -= heights[x] * heights[x] * (x === 2 ? 3.4 : x === 1 || x === 3 ? 1.6 : 1) * (S === 'counter' ? 1.7 : 1);
  }
  if (st.pot > 0 && !danger) {
    const p = chainPotential(g);
    if (S === 'twochain') s += (p.chains === 2 ? 700 : p.chains >= 3 ? 400 : 0) * st.pot + p.score * 0.2 * st.pot;
    else s += (p.score * 0.55 + p.chains * p.chains * 90) * st.pot;
  }
  if (danger) s -= 3000;
  return s;
}

function aiChoose(board, st, rnd) {
  const g0 = board.grid; const a = board.piece.a, b = board.piece.b;
  const nxt = board.peek(0);
  const ctx = { pending: board.pending, oppHigh: board.opponent ? board.opponent.maxHeight() : 0 };
  const first = [];
  for (const pl of placements()) {
    if (!reachable(g0, pl)) continue;
    const g = cloneGrid(g0);
    if (!placeOn(g, pl, a, b)) continue;
    const res = simulateResolve(g);
    const v = evalGrid(g, res, st, ctx, pl);
    first.push({ pl, g, v, res, n: (rnd() - 0.5) * 1400 * st.noise });
  }
  if (!first.length) return { x: 2, rot: 0 };
  if (st.look) {
    first.sort((p, q) => (q.v + q.n) - (p.v + p.n));
    for (const f of first.slice(0, 6)) {
      let b2 = -1e12;
      const ctx2 = { pending: Math.max(0, ctx.pending - f.res.junk), oppHigh: ctx.oppHigh };
      for (const pl2 of placements()) {
        if (!reachable(f.g, pl2)) continue;
        const g2 = cloneGrid(f.g); if (!placeOn(g2, pl2, nxt[0], nxt[1])) continue;
        const r2 = simulateResolve(g2);
        b2 = Math.max(b2, evalGrid(g2, r2, st, ctx2, pl2));
      }
      f.tot = (f.res.chains > 0 ? f.v : f.v * 0.35) + Math.max(b2, -1e6) * 0.75 + f.n;
    }
    let best = null; for (const f of first.slice(0, 6)) if (!best || f.tot > best.tot) best = f;
    return best.pl;
  }
  let best = null; for (const f of first) if (!best || f.v + f.n > best.v + best.n) best = f;
  return best.pl;
}

class CPU {
  constructor(board, level, seed) { this.b = board; this.lv = AI_LEVELS(level); this.rnd = rng(seed); this.plan = null; this.wait = 0; this.lastPairs = -1; }
  update() {
    const b = this.b;
    b.softDrop = false;
    if (b.state !== 'fall' || !b.piece) { this.plan = null; return; }
    if (this.lastPairs !== b.pairsUsed) { this.lastPairs = b.pairsUsed; this.plan = aiChoose(b, this.lv, this.rnd); this.wait = this.lv.think; }
    if (this.wait-- > 0) return;
    const p = b.piece, t = this.plan;
    if (p.rot !== t.rot) {
      const d = ((t.rot - p.rot + 4) % 4) === 3 ? -1 : 1;
      if (!b.rotate(d)) { b.lastRotFail = -99; if (!b.rotate(-d)) { b.lastRotFail = -99; this.plan = { x: p.x, rot: p.rot }; } }
      this.wait = this.lv.delay; return;
    }
    if (p.x !== t.x) { if (!b.move(Math.sign(t.x - p.x))) { this.plan = { x: p.x, rot: p.rot }; } this.wait = this.lv.delay; return; }
    b.softDrop = true;
  }
}

// ---------- account levels + cosmetics (shared by the server and the client) ----------
const XP_NEED = l => 80 + 20 * l;                 // xp needed to go from level l to l+1
function levelOf(xp) {
  let l = 1, left = xp | 0;
  while (l < 99 && left >= XP_NEED(l)) { left -= XP_NEED(l); l++; }
  return { level: l, into: left, need: XP_NEED(l) };
}
const FRAMES = [
  { id: 'wood', name: 'Wooden', lvl: 1 }, { id: 'leafy', name: 'Leafy', lvl: 3 }, { id: 'stone', name: 'Stone', lvl: 6 },
  { id: 'gold', name: 'Golden', lvl: 10 }, { id: 'jade', name: 'Jade', lvl: 15 }, { id: 'neon', name: 'Neon', lvl: 20 },
  { id: 'royal', name: 'Royal', lvl: 30 }, { id: 'cosmic', name: 'Cosmic', lvl: 40 },
  { id: 'league', name: 'Rank colours', lvl: 1, placed: true }, { id: 'crown', name: 'Giant', lvl: 1, baron: true },
];
const TITLES = [
  { id: 'rookie', text: 'Rookie', lvl: 1 }, { id: 'bean_counter', text: 'Bean Counter', lvl: 2 }, { id: 'chain_gang', text: 'Chain Gang', lvl: 4 },
  { id: 'rock_thrower', text: 'Rock Thrower', lvl: 6 }, { id: 'combo_chef', text: 'Combo Chef', lvl: 8 }, { id: 'pile_driver', text: 'Pile Driver', lvl: 12 },
  { id: 'avalanche', text: 'Avalanche', lvl: 16 }, { id: 'night_owl', text: 'Night Owl', lvl: 20 }, { id: 'bean_legend', text: 'Bean Legend', lvl: 25 },
  { id: 'barrage_master', text: 'Barrage Master', lvl: 35 },
  { id: 'chainsmith', text: 'Chainsmith', chain: 6 }, { id: 'baron', text: 'Giant', baron: true },
];
// can this player use this frame/title?  p = { level, best (best chain), tier, placed }
function cosmeticOk(item, p) {
  if (!item) return false;
  if (item.baron) return p.tier >= 5 && p.placed;
  if (item.placed) return !!p.placed;
  if (item.chain) return (p.best || 0) >= item.chain;
  return (p.level || 1) >= item.lvl;
}

if (typeof module !== 'undefined') module.exports = { levelOf, XP_NEED, FRAMES, TITLES, cosmeticOk, Board, CPU, COLS, ROWS, EMPTY, JUNK, rng, findPops, simulateResolve, AI_LEVELS, STYLES };
