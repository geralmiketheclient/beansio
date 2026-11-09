const PORT = process.argv[2] || 8099;
function bot(name, rnd) {
  return new Promise(res => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const st = { name, states: 0, rounds: 0 };
    let timer;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name }));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') { st.before = m.me; ws.send(JSON.stringify({ t: 'queue' })); }
      if (m.t === 'match') { st.opp = m.opp.name; timer = setInterval(() => { const k = ['left', 'right', 'down', 'cw', 'ccw'][Math.floor(rnd() * 5)]; ws.send(JSON.stringify({ t: 'key', k, down: true })); setTimeout(() => ws.send(JSON.stringify({ t: 'key', k, down: false })), 60); }, 90); }
      if (m.t === 'state') st.states++;
      if (m.t === 'roundover') st.rounds++;
      if (m.t === 'matchover') { clearInterval(timer); st.result = m; ws.close(); res(st); }
    };
  });
}
let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
(async () => {
  const t0 = Date.now();
  const [a, b] = await Promise.all([bot('BotAlpha', rnd), bot('BotBravo', rnd)]);
  for (const x of [a, b]) console.log(x.name, 'vs', x.opp, '| states', x.states, '| rounds', x.rounds, '| result', x.result.how, 'winner side', x.result.winner, '| wins', x.result.wins.join('-'), '| rating', x.result.before.rating, '->', x.result.after.rating, x.result.after.rank);
  const lb = await (await fetch(`http://localhost:${PORT}/api/status`)).json();
  console.log('status', JSON.stringify(lb), 'secs', ((Date.now() - t0) / 1000).toFixed(1));
})();
