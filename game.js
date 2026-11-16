// Interface: desenho no canvas, entrada por mouse/teclado e fluxo das partidas.
(() => {
  'use strict';

  const E = createEngine();
  const N = E.N, W = E.W;
  const HUMAN = 0, CPU = 1;
  const COLOR = ['#00e5ff', '#ff8a1f'];
  const BAD = '#ff2d55';
  const BEST = '#3dff8b';     // melhor jogada, na revisão
  // A análise usa aprofundamento iterativo com orçamento de tempo por posição.
  const ANALYSIS_DEPTH = 20;
  const ANALYSIS_TIME_MS = 1500; // por posição
  const ANALYSIS_OPTS = {};
  const ANALYSIS_VERSION = 5;    // análises salvas com versão menor podem ser refeitas
  // limite de tempo por jogada da IA (nos níveis altos, é ele que decide a força):
  // 3 s até o nível 10, subindo aos poucos até 5 s no nível 20
  const aiTimeMs = level => 3000 + 2000 * Math.min(1, Math.max(0, (level - 10) / 10));
  const MAX_LEVEL = 22;       // nível 22 = minimax profundidade 12

  // [chance de lance aleatório, em décimos; profundidade do minimax] dos níveis 1 a 14;
  // do 15 em diante: nenhum aleatório e profundidade 5, 6, 7…
  const LEVELS = [
    [4, 1], [3, 1], [2, 1], [1, 1], [0, 1],
    [3, 2], [2, 2], [1, 2], [0, 2],
    [2, 3], [1, 3], [0, 3],
    [1, 4], [0, 4],
  ];

  function levelSpec(level) {
    if (level <= LEVELS.length) {
      const [rand, depth] = LEVELS[level - 1];
      return { rand, depth };
    }
    return { rand: 0, depth: 5 + level - LEVELS.length - 1 };
  }

  function describeLevel(level) {
    const { rand, depth } = levelSpec(level);
    const r = rand === 0 ? 'sem lances aleatórios' : `${rand * 10}% de chance de lance aleatório`;
    return `Nível ${level}: ${r}, minimax com profundidade ${depth}`;
  }
  const MOVE_MS = 280;        // duração da animação de um passo (pulo: um pouco mais)
  const WALL_MS = 260;        // duração da animação de uma parede surgindo
  const END_FX_MS = 1500;     // duração da animação de fim de partida, antes do placar
  const TRAIL_LEN = 9;        // casas guardadas no histórico do rastro
  const TRAIL_CELLS = 6;      // comprimento visível do rastro, em casas
  const TRAIL_RADIUS = 0.45;  // raio das curvas do rastro, em casas
  const TRAIL_STEP = 0.04;    // resolução das amostras, em casas

  const $ = id => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');

  // ---------- progresso salvo ----------
  const STORE_KEY = 'neon-walls:progress';
  const progress = loadProgress();

  function loadProgress() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY));
      if (d) return { level: Math.min(MAX_LEVEL, Math.max(1, d.level | 0)), wins: d.wins | 0, losses: d.losses | 0 };
    } catch (e) { /* sem storage: começa do zero */ }
    return { level: 1, wins: 0, losses: 0 };
  }

  function saveProgress() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) { /* ignora */ }
  }

  // ---------- sons (sintetizados com Web Audio) ----------
  const sound = (() => {
    const KEY = 'neon-walls:muted';
    let ac = null, master = null, noiseBuf = null;
    let muted = false;
    try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* ignora */ }

    function audio() {
      if (muted) return null;
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.7;
        master.connect(ac.destination);
        // eco curto, para dar um ar "espacial"
        const delay = ac.createDelay(), fb = ac.createGain();
        delay.delayTime.value = 0.13;
        fb.gain.value = 0.22;
        master.connect(delay);
        delay.connect(fb);
        fb.connect(delay);
        delay.connect(ac.destination);
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }

    function tone({ freq, to = 0, dur = 0.12, type = 'sine', gain = 0.15, delay = 0 }) {
      const a = audio();
      if (!a) return;
      const t = a.currentTime + delay;
      const o = a.createOscillator(), g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.03);
    }

    function noise({ dur = 0.15, freq = 1500, to = 300, gain = 0.2, delay = 0 }) {
      const a = audio();
      if (!a) return;
      const t = a.currentTime + delay;
      const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
      src.buffer = noiseBuf;
      f.type = 'bandpass';
      f.Q.value = 3;
      f.frequency.setValueAtTime(freq, t);
      f.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(master);
      src.start(t);
      src.stop(t + dur + 0.03);
    }

    return {
      get muted() { return muted; },
      toggle() {
        muted = !muted;
        try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* ignora */ }
        if (!muted) tone({ freq: 880, dur: 0.08, gain: 0.08 });
      },
      move(pl, jump) {
        if (pl === HUMAN) {
          tone({ freq: 520, to: 820, dur: 0.1, type: 'triangle', gain: 0.16 });
          if (jump) tone({ freq: 700, to: 1240, dur: 0.12, type: 'triangle', gain: 0.13, delay: 0.09 });
        } else {
          tone({ freq: 330, to: 220, dur: 0.12, type: 'triangle', gain: 0.18 });
          if (jump) tone({ freq: 260, to: 160, dur: 0.14, type: 'triangle', gain: 0.15, delay: 0.09 });
        }
      },
      wall(pl) {
        const base = pl === HUMAN ? 1 : 0.7;
        tone({ freq: 1400 * base, to: 140 * base, dur: 0.22, type: 'sawtooth', gain: 0.07 });
        tone({ freq: 110 * base, to: 55, dur: 0.25, type: 'square', gain: 0.08 });
        noise({ dur: 0.18, freq: 3000 * base, to: 400, gain: 0.12 });
      },
      tick() { tone({ freq: 1500, dur: 0.035, gain: 0.05 }); },
      good() {
        tone({ freq: 784, dur: 0.18, type: 'triangle', gain: 0.13 });
        tone({ freq: 1175, dur: 0.3, type: 'triangle', gain: 0.13, delay: 0.09 });
      },
      bad() {
        tone({ freq: 150, dur: 0.07, type: 'square', gain: 0.07 });
        tone({ freq: 120, dur: 0.1, type: 'square', gain: 0.07, delay: 0.08 });
      },
      win() {
        [523, 659, 784, 1047, 1319].forEach((f, k) =>
          tone({ freq: f, dur: 0.35, type: 'triangle', gain: 0.14, delay: k * 0.08 }));
        tone({ freq: 2093, dur: 1.2, gain: 0.05, delay: 0.4 });
        noise({ dur: 0.6, freq: 6000, to: 800, gain: 0.08 });
      },
      lose() {
        tone({ freq: 440, to: 40, dur: 1.1, type: 'sawtooth', gain: 0.08 });
        [392, 311, 233].forEach((f, k) =>
          tone({ freq: f, dur: 0.4, type: 'triangle', gain: 0.12, delay: 0.1 + k * 0.22 }));
        noise({ dur: 0.9, freq: 2500, to: 100, gain: 0.15 });
      },
    };
  })();

  // ---------- motor num Web Worker (com fallback síncrono) ----------
  // Operações: search (lance da IA), score (valor de um lance), analyze (partida inteira).
  function makeWorker() {
    let worker = null, seq = 0;
    const pending = new Map(); // id -> { done, progress }

    function spawn() {
      try {
        const src = `const createEngine = ${createEngine.toString()};\n` +
          'const E = createEngine();\n' +
          'const ops = {\n' +
          '  search: a => E.search(a.state, a.depth, a.timeMs, a.opts),\n' +
          '  analyze: (a, id) => E.analyzeGame(a.moves, a.depth, a.timeMs, (k, n) => postMessage({ id, progress: [k, n] }), a.opts),\n' +
          '};\n' +
          'onmessage = e => postMessage({ id: e.data.id, result: ops[e.data.op](e.data.args, e.data.id) });';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = e => {
          const p = pending.get(e.data.id);
          if (!p) return;
          if (e.data.progress) {
            if (p.progress) p.progress(...e.data.progress);
            return;
          }
          pending.delete(e.data.id);
          p.done(e.data.result);
        };
        worker.onerror = () => { worker = null; };
      } catch (e) {
        worker = null;
      }
    }

    const local = {
      search: a => E.search(E.clone(a.state), a.depth, a.timeMs, a.opts),
      analyze: (a, progress) => E.analyzeGame(a.moves, a.depth, a.timeMs, progress, a.opts),
    };

    spawn();
    return {
      call(op, args, progress) {
        if (!worker) return new Promise(res => setTimeout(() => res(local[op](args, progress)), 30));
        const id = ++seq;
        return new Promise(done => {
          pending.set(id, { done, progress });
          worker.postMessage({ id, op, args });
        });
      },
      // descarta o trabalho em andamento (ex.: nova partida no meio do lance da IA)
      cancel() {
        if (!worker || pending.size === 0) return;
        worker.terminate();
        pending.clear();
        spawn();
      },
    };
  }

  const ai = makeWorker();      // lances do computador
  const analyst = makeWorker(); // análise do histórico, sem atrasar a partida

  // ---------- estado da partida ----------
  let fx = [], derezAt = [null, null]; // efeitos de fim de partida; quando cada peão some
  let state, owners, trails, disp, anim, lastAct, mode, ghost, busy, over, hover;
  let wallO = 0;          // orientação da parede-fantasma (0 horizontal, 1 vertical)
  let wallNext = false;   // a sua última jogada foi parede: volta ao modo parede na próxima vez
  let cpuProgress = null; // progresso do peão do computador (E.trackProgress), contra o vaivém
  let gameId = 0, shake = 0;
  let record = null;  // lances da partida em andamento, para o histórico
  let review = null;  // visualizador do histórico aberto (ver mais abaixo)

  // O que o tabuleiro desenha. O visualizador do histórico troca a cena
  // e devolve a da partida ao vivo ao fechar.
  const captureScene = () => ({ state, owners, trails, disp, anim, lastAct, fx, derezAt });
  function useScene(sc) {
    ({ state, owners, trails, disp, anim, lastAct, fx, derezAt } = sc);
  }

  function saveRecord(result) {
    if (!record || record.saved) return;
    record.saved = true;
    const { id, date, level, moves } = record;
    GameHistory.add({ id, date, level, result, moves: moves.slice(), analysis: null });
  }

  function saveIfAbandoned() {
    if (record && !over && record.moves.length >= 2) saveRecord('abandoned');
  }

  function newGame() {
    gameId++;
    ai.cancel();
    saveIfAbandoned();
    record = { id: Date.now(), date: new Date().toISOString(), level: progress.level, moves: [], saved: false };
    state = E.newState();
    fx = [];
    derezAt = [null, null];
    owners = new Map();       // "o,r,c" -> { pl, t0 }: quem colocou a parede e quando
    trails = [[], []];
    cpuProgress = null;
    disp = state.p.map(([r, c]) => ({ r, c }));
    anim = [null, null];      // movimento do peão em curso: { t0, dur, from, to }
    lastAct = [null, null];   // última ação de cada jogador (peão ou parede): { t0, dur }
    mode = 'move';
    wallNext = false;
    ghost = null;
    busy = false;
    over = false;
    hover = null;
    $('overlay').classList.add('hidden');
    $('cpu-info').textContent = '';
    setStatus(idleText());
    refresh();
  }

  const canAct = () => (review ? reviewCanAct() : !over && !busy && state.turn === HUMAN);

  // telas de toque ganham a barra de controles no rodapé (ver style.css)
  const root = document.documentElement;
  const isTouch = () => root.classList.contains('touch');
  root.classList.toggle('touch', matchMedia('(pointer: coarse)').matches);

  // No desktop não há modos: as setas movem o peão e o mouse coloca paredes.
  // O modo parede (mode === 'wall') só existe nas telas de toque.
  const showGhost = () => !isTouch() || mode === 'wall';

  function idleText() {
    if (!isTouch()) return 'Sua vez: setas movem o peão, clique coloca uma parede (R gira).';
    if (mode !== 'wall') return 'Sua vez: mova o peão ou coloque uma parede.';
    return 'Modo parede: toque no vão onde quer a parede e toque de novo para confirmar.';
  }

  // a barra do rodapé repete o status do painel visível
  function writeStatus(id, text, kind) {
    for (const el of [$(id), $('tb-status')]) {
      el.textContent = text;
      el.className = 'status' + (kind ? ' ' + kind : '');
    }
  }

  const setStatus = (text, kind = '') => writeStatus('status', text, kind);

  function refresh() {
    $('level').textContent = progress.level;
    $('level-desc').textContent = describeLevel(progress.level);
    $('wins').textContent = progress.wins;
    $('losses').textContent = progress.losses;
    for (const i of [HUMAN, CPU]) {
      $('walls-' + i).textContent = state.walls[i];
      $('dist-' + i).textContent = E.distance(state, i);
      $('tb-walls-' + i).textContent = state.walls[i];
      $('tb-dist-' + i).textContent = E.distance(state, i);
      const pips = $('pips-' + i);
      if (pips.children.length !== 10) pips.innerHTML = '<i></i>'.repeat(10);
      [...pips.children].forEach((el, k) => el.classList.toggle('on', k < state.walls[i]));
    }
    const noWall = !canAct() || state.walls[HUMAN] === 0;
    $('btn-rotate').disabled = noWall;
    $('btn-history').disabled = busy;
    $('lv-rotate').disabled = noWall;
    const tbWall = $('tb-wall');
    tbWall.disabled = !canAct() || state.walls[HUMAN] === 0;
    tbWall.classList.toggle('active', mode === 'wall');
    tbWall.textContent = mode === 'wall' ? 'Cancelar' : 'Parede';
    $('tb-rotate').disabled = mode !== 'wall';
  }

  // ---------- ações ----------
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const progressOf = (a, now = performance.now()) => (a ? Math.min(1, (now - a.t0) / a.dur) : 1);

  function commit(move) {
    if (review) {
      reviewAttempt(move);
      return;
    }
    record.moves.push(E.notate(move));
    const pl = state.turn;
    if (pl === HUMAN) wallNext = move.t === 'w';
    if (state.turn === CPU) cpuProgress = E.trackProgress(state, move, cpuProgress);
    applyVisual(move);

    const w = E.winner(state);
    if (w >= 0) {
      endGame(w);
      return;
    }
    if (state.turn === HUMAN && state.walls[HUMAN] === 0 && humanTargets().length === 0) {
      state.turn = CPU; // encurralado e sem paredes: passa a vez
      record.moves.push('-');
    }
    if (state.turn === CPU) cpuTurn();
    else if (pl === CPU && resumeWallMode()) return;
    else setStatus(idleText());
    refresh();
  }

  // Na sua vez, depois de ter colocado uma parede, já começa no modo parede
  // (com a mesma orientação da última).
  function resumeWallMode() {
    if (!isTouch() || !wallNext || state.walls[HUMAN] === 0) return false;
    ghost = null;
    setMode('wall');
    return mode === 'wall';
  }

  // aplica o lance no estado da cena atual, com animação e som
  function applyVisual(move) {
    const pl = state.turn;
    const t0 = performance.now();
    if (move.t === 'm') {
      trails[pl].push(state.p[pl].slice());
      if (trails[pl].length > TRAIL_LEN) trails[pl].shift();
      // parte de onde o peão está desenhado agora, mesmo no meio de outra animação
      const from = { r: disp[pl].r, c: disp[pl].c };
      const len = Math.hypot(move.r - from.r, move.c - from.c);
      anim[pl] = { t0, dur: MOVE_MS * Math.max(0.5, Math.sqrt(len)), from, to: { r: move.r, c: move.c } };
      lastAct[pl] = anim[pl];
      sound.move(pl, Math.abs(move.r - state.p[pl][0]) + Math.abs(move.c - state.p[pl][1]) > 1);
    } else {
      owners.set(`${move.o},${move.r},${move.c}`, { pl, t0 });
      lastAct[pl] = { t0, dur: WALL_MS };
      sound.wall(pl);
    }
    E.applyMove(state, move);
  }

  function humanTargets() {
    return E.pawnMoves(state, HUMAN);
  }

  function moveTo(r, c) {
    if (!canAct()) return;
    if (humanTargets().some(([mr, mc]) => mr === r && mc === c)) commit({ t: 'm', r, c });
  }

  // Teclado: o lance nessa direção é o passo simples ou o pulo sobre o adversário.
  function keyStep([dr, dc]) {
    if (!canAct()) return;
    const [r, c] = state.p[HUMAN];
    const target = E.pawnMoves(state, HUMAN)
      .find(([mr, mc]) => Math.sign(mr - r) === dr && Math.sign(mc - c) === dc);
    if (target) {
      commit({ t: 'm', r: target[0], c: target[1] });
      return;
    }
    shake = 4;
    sound.bad();
    setStatus('Tem uma parede, a borda ou o adversário bloqueando esse caminho.', 'bad');
  }

  const WALL_MSG = {
    nowalls: 'Você não tem mais paredes.',
    overlap: 'Não cabe aí: sobreporia ou cruzaria outra parede.',
    block: 'Proibido: essa parede fecharia todos os caminhos de alguém.',
  };

  function placeWall() {
    if (!canAct() || !ghost) return;
    const st = E.wallStatus(state, HUMAN, ghost.o, ghost.r, ghost.c);
    if (st !== 'ok') {
      setStatus(WALL_MSG[st], 'bad');
      shake = 6;
      sound.bad();
      return;
    }
    const g = ghost;
    mode = 'move';
    commit({ t: 'w', o: g.o, r: g.r, c: g.c });
  }

  function setMode(m) {
    if (m === 'wall' && (!canAct() || state.walls[HUMAN] === 0)) return;
    mode = m;
    if (m === 'wall' && !ghost) {
      // começa logo à frente do peão do computador
      const [r, c] = state.p[CPU];
      ghost = { o: wallO, r: Math.min(r, W - 1), c: Math.min(c, W - 1) };
    }
    canvas.style.cursor = m === 'wall' ? 'crosshair' : 'default';
    setStatus(idleText());
    refresh();
  }

  function rotate() {
    if (!showGhost()) return;
    wallO = 1 - (ghost ? ghost.o : wallO);
    if (ghost) ghost = { ...ghost, o: wallO };
    sound.tick();
  }

  function randomStep() {
    const moves = E.pawnMoves(state, CPU);
    if (moves.length === 0) return { move: null, random: true };
    const [r, c] = moves[Math.floor(Math.random() * moves.length)];
    return { move: { t: 'm', r, c }, random: true };
  }

  // A IA começa a pensar assim que o seu lance é feito; o lance dela entra
  // quando a busca termina e a sua animação já passou da metade.
  function cpuTurn() {
    busy = true;
    const id = gameId, { rand, depth } = levelSpec(progress.level);
    setStatus('Computador pensando…', 'cpu');
    // cada lance tem rand/10 de chance de ser um passo aleatório do peão
    // ...exceto quando ele pode vencer agora ou você está a um passo de vencer
    const decisive = E.pawnMoves(state, CPU).some(([r]) => r === E.GOAL[CPU]) || E.distance(state, HUMAN) <= 1;
    // passos sem avançar e volta a casas recentes são penalizados (evita vaivém)
    const { stall } = E.trackProgress(state, null, cpuProgress);
    const recent = trails[CPU].slice(-8).map(([r, c]) => r * N + c);
    const choice = !decisive && Math.random() < rand / 10
      ? Promise.resolve(randomStep())
      : ai.call('search', { state, depth, timeMs: aiTimeMs(progress.level), opts: { stall, recent } });
    choice.then(res => {
      if (id !== gameId) return;
      const whenReady = () => {
        if (id !== gameId) return;
        if (progressOf(lastAct[HUMAN]) < 0.5) { requestAnimationFrame(whenReady); return; }
        busy = false;
        $('cpu-info').textContent = res.random
          ? 'Último lance: aleatório'
          : res.depth < depth
            ? `Último lance: chegou à profundidade ${res.depth} das ${depth} do nível (limite de tempo)`
            : `Último lance: minimax, profundidade ${res.depth}`;
        if (!res.move) { // sem lances possíveis: passa a vez
          state.turn = HUMAN;
          record.moves.push('-');
          if (resumeWallMode()) return;
          setStatus(idleText());
          refresh();
          return;
        }
        commit(res.move);
      };
      whenReady();
    });
  }

  function endGame(w) {
    over = true;
    mode = 'move';
    const ov = $('overlay');
    if (w === HUMAN) {
      const before = progress.level;
      progress.wins++;
      progress.level = Math.min(MAX_LEVEL, before + 1);
      $('ov-title').textContent = 'Você venceu';
      $('ov-text').textContent = progress.level > before
        ? `Subiu para o nível ${progress.level}. ${describeLevel(progress.level).split(': ')[1]}.`
        : `Você já está no nível máximo (${MAX_LEVEL}).`;
      ov.dataset.winner = 'you';
      setStatus('Vitória!', 'win');
    } else {
      progress.losses++;
      $('ov-title').textContent = 'O computador venceu';
      $('ov-text').textContent = `Você continua no nível ${progress.level}. Tente de novo.`;
      ov.dataset.winner = 'cpu';
      setStatus('Derrota.', 'cpu');
    }
    saveProgress();
    saveRecord(w === HUMAN ? 'win' : 'loss');
    refresh();
    // a festa começa quando o peão vencedor chega à linha
    const a = anim[w];
    const arrive = a ? Math.max(0, a.t0 + a.dur - performance.now()) : 0;
    endFx(w, performance.now() + arrive);
    const id = gameId;
    setTimeout(() => {
      if (id !== gameId) return;
      if (w === HUMAN) sound.win(); else sound.lose();
    }, arrive);
    setTimeout(() => {
      if (id !== gameId || review) return; // com o histórico aberto, aparece ao fechá-lo
      ov.classList.remove('hidden');
      $('ov-next').focus();
    }, arrive + END_FX_MS);
  }

  // ---------- efeitos de fim de partida ----------
  // Vencedor: clarão, ondas de choque, faíscas e a linha de chegada acendendo em cascata.
  // Perdedor: o peão se desintegra em fragmentos que caem e piscam.
  function endFx(w, t0) {
    const l = 1 - w, col = COLOR[w];
    const [wr, wc] = state.p[w], [lr, lc] = state.p[l];
    const rnd = (a, b) => a + Math.random() * (b - a);
    fx.push({ kind: 'flash', t0, dur: 550, col });
    for (let k = 0; k < 3; k++) fx.push({ kind: 'ring', t0: t0 + k * 150, dur: 1100, r: wr, c: wc, col });
    for (let k = 0; k < 150; k++) {
      const ang = rnd(0, Math.PI * 2), sp = rnd(1.5, 8);
      fx.push({
        kind: 'spark', t0, dur: rnd(700, 1600), r: wr, c: wc,
        vr: Math.sin(ang) * sp, vc: Math.cos(ang) * sp,
        col: Math.random() < 0.25 ? '#ffffff' : col,
      });
    }
    for (let c = 0; c < N; c++) {
      fx.push({ kind: 'cell', t0: t0 + Math.abs(c - wc) * 60, dur: 800, r: E.GOAL[w], c, col });
    }
    const n = 6;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const dr = (i + 0.5) / n - 0.5, dc = (j + 0.5) / n - 0.5;
        fx.push({
          kind: 'shard', t0: t0 + 120 + rnd(0, 250), dur: rnd(900, 1500),
          r: lr + dr * 0.7, c: lc + dc * 0.7,
          vr: dr * rnd(0.5, 2) + rnd(-0.6, 0.3), vc: dc * rnd(0.5, 3), seed: rnd(0, 100),
          col: COLOR[l],
        });
      }
    }
    derezAt[l] = t0 + 120;
  }

  function drawFx(t) {
    if (!fx.length) return;
    fx = fx.filter(f => t < f.t0 + f.dur);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const f of fx) {
      const p = (t - f.t0) / f.dur;
      if (p < 0) continue;
      const s = (t - f.t0) / 1000;
      switch (f.kind) {
        case 'flash':
          ctx.fillStyle = rgba(f.col, 0.22 * (1 - p) * (1 - p));
          ctx.fillRect(0, 0, size, size);
          break;
        case 'ring': {
          const [x, y] = center(f.r, f.c);
          glow(f.col, 20);
          ctx.lineWidth = Math.max(1, cs * 0.14 * (1 - p));
          ctx.strokeStyle = rgba(f.col, 0.9 * (1 - p));
          ctx.beginPath();
          ctx.arc(x, y, step * 5 * (1 - Math.pow(1 - p, 3)), 0, Math.PI * 2);
          ctx.stroke();
          noGlow();
          break;
        }
        case 'spark': {
          const k = (1 - Math.exp(-3 * s)) / 3, tail = 0.06 * Math.exp(-3 * s);
          const r = f.r + f.vr * k, c = f.c + f.vc * k;
          const [x, y] = center(r, c), [x2, y2] = center(r - f.vr * tail, c - f.vc * tail);
          ctx.lineWidth = Math.max(1.5, cs * 0.05);
          ctx.strokeStyle = rgba(f.col, 1 - p);
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x + 0.01, y);
          ctx.stroke();
          break;
        }
        case 'cell': {
          const a = Math.sin(Math.PI * Math.min(1, p));
          glow(f.col, 24 * a);
          ctx.fillStyle = rgba(f.col, 0.45 * a);
          roundRect(pad + f.c * step, pad + f.r * step, cs, cs, cs * 0.12);
          ctx.fill();
          noGlow();
          break;
        }
        case 'shard': {
          const r = f.r + f.vr * s + 1.4 * s * s, c = f.c + f.vc * s;
          const [x, y] = center(r, c);
          const sz = (cs * 0.7 / 6) * (1 - 0.5 * p);
          ctx.fillStyle = rgba(f.col, (1 - p) * (0.55 + 0.45 * Math.sin(s * 45 + f.seed)));
          ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
          break;
        }
      }
    }
    ctx.restore();
  }

  // ---------- geometria ----------
  let size = 0, pad, cs, gap, step;
  const wrap = canvas.parentElement;

  function layout() {
    const dpr = window.devicePixelRatio || 1;
    size = wrap.clientWidth;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = canvas.style.height = size + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pad = size * 0.035;
    cs = (size - 2 * pad) / (N + (N - 1) * 0.24);
    gap = cs * 0.24;
    step = cs + gap;
  }

  const center = (r, c) => [pad + c * step + cs / 2, pad + r * step + cs / 2];
  const clampW = v => Math.max(0, Math.min(W - 1, v));

  function pointerPos(e) {
    const b = canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  function cellAt(x, y) {
    const c = Math.floor((x - pad + gap / 2) / step), r = Math.floor((y - pad + gap / 2) / step);
    return r >= 0 && r < N && c >= 0 && c < N ? { r, c } : null;
  }

  // cruzamento de sulcos mais próximo = centro da parede
  function anchorAt(x, y) {
    return {
      r: clampW(Math.round((y - pad - cs - gap / 2) / step)),
      c: clampW(Math.round((x - pad - cs - gap / 2) / step)),
    };
  }

  // no toque, a orientação vem de onde se tocou: perto de um sulco horizontal
  // (borda de cima/baixo de uma casa) dá parede horizontal, e vice-versa;
  // toques ambíguos, perto do centro da casa ou do cruzamento, mantêm a atual
  function touchWallAt(x, y, o) {
    const a = anchorAt(x, y);
    const dy = Math.abs(y - (pad + a.r * step + cs + gap / 2));
    const dx = Math.abs(x - (pad + a.c * step + cs + gap / 2));
    if (Math.abs(dx - dy) > step * 0.18) o = dy < dx ? 0 : 1;
    return { o, ...a };
  }

  function wallRect(o, r, c) {
    const t = gap * 0.72, off = (gap - t) / 2, inset = cs * 0.04, len = 2 * cs + gap - 2 * inset;
    return o === 0
      ? [pad + c * step + inset, pad + r * step + cs + off, len, t]
      : [pad + c * step + cs + off, pad + r * step + inset, t, len];
  }

  // ---------- desenho ----------
  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function roundRect(x, y, w, h, rad) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
    else ctx.rect(x, y, w, h);
  }

  function glow(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
  function noGlow() { ctx.shadowBlur = 0; }

  function drawCells() {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const x = pad + c * step, y = pad + r * step;
        let edge = 'rgba(0,229,255,0.16)';
        if (r === E.GOAL[HUMAN]) edge = rgba(COLOR[HUMAN], 0.5);
        else if (r === E.GOAL[CPU]) edge = rgba(COLOR[CPU], 0.42);
        roundRect(x, y, cs, cs, cs * 0.12);
        ctx.fillStyle = 'rgba(0,229,255,0.03)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = edge;
        ctx.stroke();
      }
    }
    // coordenadas, como num tabuleiro de xadrez: colunas a–i, linhas 1–9
    ctx.fillStyle = 'rgba(200,246,255,0.32)';
    ctx.font = `600 ${Math.round(cs * 0.19)}px Rajdhani, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    for (let c = 0; c < N; c++) {
      ctx.fillText('abcdefghi'[c], pad + c * step + cs - cs * 0.07, pad + (N - 1) * step + cs - cs * 0.07);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let r = 0; r < N; r++) ctx.fillText(String(N - r), pad + cs * 0.07, pad + r * step + cs * 0.06);
  }

  // Revisão: contorna a parede do último lance e mostra, em verde,
  // a melhor jogada quando o lance foi impreciso (ou a solução, no treino).
  function drawReviewMarks(t) {
    if (!review || review.view === 'list') return;
    const g = review.game, k = review.ply - 1;
    let best = null, from = null;
    if (review.view === 'game' && k >= 0) {
      const played = E.parse(g.moves[k]);
      if (played && played.t === 'w') {
        const [x, y, w, h] = wallRect(played.o, played.r, played.c);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1.5;
        roundRect(x - 3, y - 3, w + 6, h + 6, (Math.min(w, h) + 6) / 2);
        ctx.stroke();
      }
      const a = g.analysis && g.analysis[k];
      if (a && a.b && a.b !== g.moves[k] && GameHistory.classify(a)) {
        best = E.parse(a.b);
        from = review.before.p[GameHistory.moverAt(k)];
      }
    } else if (review.view === 'learn' && review.puzzle.showBest) {
      best = review.puzzle.best;
    }
    if (!best) return;
    const pulse = 0.65 + 0.35 * Math.sin(t / 250);
    if (best.t === 'w') {
      drawWall(best.o, best.r, best.c, BEST, 0.6 * pulse, 14);
      return;
    }
    const [x, y] = center(best.r, best.c);
    glow(BEST, 14);
    ctx.strokeStyle = rgba(BEST, 0.9 * pulse);
    ctx.lineWidth = Math.max(2, cs * 0.05);
    ctx.setLineDash([cs * 0.09, cs * 0.07]);
    if (from) { // seta tracejada de onde o peão estava até a melhor casa
      const [fx0, fy0] = center(from[0], from[1]);
      const ang = Math.atan2(y - fy0, x - fx0), back = cs * 0.34;
      ctx.beginPath();
      ctx.moveTo(fx0 + Math.cos(ang) * back, fy0 + Math.sin(ang) * back);
      ctx.lineTo(x - Math.cos(ang) * back, y - Math.sin(ang) * back);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, cs * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    noGlow();
  }

  function drawMoveHints(t) {
    if (!canAct() || mode !== 'move') return;
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    const m = cs * 0.14;
    ctx.lineWidth = 1.5;
    for (const [r, c] of humanTargets()) {
      const x = pad + c * step, y = pad + r * step;
      const on = hover && hover.r === r && hover.c === c;
      glow(COLOR[HUMAN], on ? 18 : 8);
      ctx.strokeStyle = rgba(COLOR[HUMAN], on ? 0.95 : 0.3 + 0.4 * pulse);
      roundRect(x + m, y + m, cs - 2 * m, cs - 2 * m, cs * 0.1);
      ctx.stroke();
      if (on) {
        ctx.fillStyle = rgba(COLOR[HUMAN], 0.12);
        ctx.fill();
      }
    }
    noGlow();
  }

  // Amostra o caminho do rastro (em coordenadas de casa) com cantos arredondados
  // por curvas de Bézier, em passos curtos, do mais antigo até a cabeça.
  function trailSamples(pts) {
    const out = [];
    const line = (a, b) => {
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / TRAIL_STEP));
      for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    };
    const toward = (from, to, d) => {
      const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
      return [from[0] + (to[0] - from[0]) * d / len, from[1] + (to[1] - from[1]) * d / len];
    };
    let cur = pts[0];
    out.push(cur);
    for (let k = 1; k < pts.length - 1; k++) {
      const p = pts[k - 1], q = pts[k], nx = pts[k + 1];
      const rad = Math.min(TRAIL_RADIUS,
        Math.hypot(q[0] - p[0], q[1] - p[1]) / 2, Math.hypot(nx[0] - q[0], nx[1] - q[1]) / 2);
      const a = toward(q, p, rad), b = toward(q, nx, rad);
      line(cur, a);
      for (let s = 1; s <= 10; s++) {
        const t = s / 10, u = 1 - t;
        out.push([u * u * a[0] + 2 * u * t * q[0] + t * t * b[0], u * u * a[1] + 2 * u * t * q[1] + t * t * b[1]]);
      }
      cur = b;
    }
    line(cur, pts[pts.length - 1]);
    return out;
  }

  // rastro de luz: curva contínua que afina e apaga suavemente com a distância da cabeça
  function drawTrails() {
    const base = Math.max(2, cs * 0.06);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'butt';
    for (const i of [HUMAN, CPU]) {
      const pts = [...trails[i], [disp[i].r, disp[i].c]];
      if (pts.length < 2) continue;
      const smp = trailSamples(pts).map(([r, c]) => center(r, c));
      // distância (em casas) de cada amostra até a cabeça
      const fade = new Array(smp.length);
      fade[smp.length - 1] = 1;
      let acc = 0;
      for (let k = smp.length - 2; k >= 0; k--) {
        acc += Math.hypot(smp[k + 1][0] - smp[k][0], smp[k + 1][1] - smp[k][1]) / step;
        fade[k] = Math.max(0, 1 - acc / TRAIL_CELLS);
      }
      const passes = [
        [4.5, 0.07, COLOR[i]],   // halo largo
        [2.2, 0.16, COLOR[i]],   // brilho
        [1, 0.75, COLOR[i]],     // linha
        [0.35, 0.6, '#ffffff'],  // núcleo quente
      ];
      for (const [wMul, aMul, col] of passes) {
        for (let k = 1; k < smp.length; k++) {
          const f = fade[k];
          if (f <= 0) continue;
          const e = f * f * (3 - 2 * f); // smoothstep
          ctx.lineWidth = base * wMul * (0.25 + 0.75 * e);
          ctx.strokeStyle = rgba(col, aMul * e * (col === '#ffffff' ? e : 1));
          ctx.beginPath();
          ctx.moveTo(smp[k - 1][0], smp[k - 1][1]);
          ctx.lineTo(smp[k][0], smp[k][1]);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  // grow < 1: a parede cresce a partir do centro (animação de surgimento)
  function drawWall(o, r, c, color, alpha, blur, grow = 1) {
    let [x, y, w, h] = wallRect(o, r, c);
    const thin = Math.min(w, h);
    if (grow < 1) {
      if (o === 0) { x += w * (1 - grow) / 2; w = Math.max(thin, w * grow); }
      else { y += h * (1 - grow) / 2; h = Math.max(thin, h * grow); }
    }
    glow(color, blur);
    ctx.fillStyle = rgba(color, alpha);
    roundRect(x, y, w, h, thin / 2);
    ctx.fill();
    noGlow();
    // núcleo claro, como um tubo de neon
    const k = thin * 0.32;
    ctx.fillStyle = `rgba(255,255,255,${0.55 * alpha})`;
    roundRect(x + k, y + k, w - 2 * k, h - 2 * k, (thin - 2 * k) / 2);
    ctx.fill();
  }

  function drawWalls(t) {
    for (const [key, { pl, t0 }] of owners) {
      const [o, r, c] = key.split(',').map(Number);
      const e = ease(Math.min(1, Math.max(0, (t - t0) / WALL_MS)));
      drawWall(o, r, c, COLOR[pl], 0.95, 16 + 24 * (1 - e), e);
    }
  }

  function drawGhost(t) {
    if (!showGhost() || !ghost || !canAct() || state.walls[HUMAN] === 0) return;
    const ok = E.wallStatus(state, HUMAN, ghost.o, ghost.r, ghost.c) === 'ok';
    // semitransparente por inteiro (brilho e núcleo juntos): oscila de 25% a 50%
    ctx.save();
    ctx.globalAlpha = 0.375 + 0.125 * Math.sin(t / 200);
    drawWall(ghost.o, ghost.r, ghost.c, ok ? COLOR[HUMAN] : BAD, 1, 14);
    ctx.restore();
  }

  function drawPawns(t) {
    for (const i of [HUMAN, CPU]) {
      if (derezAt[i] !== null && t >= derezAt[i]) continue;
      const [x, y] = center(disp[i].r, disp[i].c);
      const R = cs * 0.3, col = COLOR[i];
      const thinking = i === CPU && busy;
      glow(col, thinking ? 18 + 12 * Math.sin(t / 140) : 18);
      ctx.lineWidth = Math.max(2, cs * 0.07);
      ctx.strokeStyle = col;
      ctx.fillStyle = '#04070d';
      ctx.beginPath();
      if (i === HUMAN) {
        ctx.arc(x, y, R, 0, Math.PI * 2);
      } else {
        const d = R * 1.18;
        ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, R * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
    noGlow();
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (!size) return;
    for (const i of [HUMAN, CPU]) {
      const a = anim[i];
      if (a) {
        const e = ease(Math.max(0, progressOf(a, t)));
        disp[i].r = a.from.r + (a.to.r - a.from.r) * e;
        disp[i].c = a.from.c + (a.to.c - a.from.c) * e;
      } else {
        disp[i].r = state.p[i][0];
        disp[i].c = state.p[i][1];
      }
    }
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake = shake > 0.3 ? shake * 0.85 : 0;
    }
    drawCells();
    drawTrails();
    drawMoveHints(t);
    drawWalls(t);
    drawGhost(t);
    drawPawns(t);
    drawReviewMarks(t);
    drawFx(t);
    ctx.restore();
  }

  // ---------- histórico, análise e "revisar meus erros" ----------
  // review = { live, game, ply, before, view: 'list' | 'game' | 'learn', puzzle }
  const RESULT = { win: 'Vitória', loss: 'Derrota', abandoned: 'Abandonada' };
  const CLS = GameHistory.CLASSES;
  let analyzing = null; // id da partida em análise

  const fmtDate = iso => new Date(iso).toLocaleString('pt-BR',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  // reconstrói a cena após `ply` lances; se animateLast, anima o último
  function buildScene(moves, ply, animateLast = false) {
    const st = E.newState(), own = new Map(), tr = [[], []], an = [null, null];
    const now = performance.now();
    for (let k = 0; k < ply; k++) {
      const pl = st.turn;
      if (moves[k] === '-') {
        st.turn = 1 - pl;
        continue;
      }
      const m = E.parse(moves[k]);
      const last = animateLast && k === ply - 1;
      if (m.t === 'm') {
        tr[pl].push(st.p[pl].slice());
        if (tr[pl].length > TRAIL_LEN) tr[pl].shift();
        if (last) {
          an[pl] = { t0: now, dur: MOVE_MS, from: { r: st.p[pl][0], c: st.p[pl][1] }, to: { r: m.r, c: m.c } };
          sound.move(pl, Math.abs(m.r - st.p[pl][0]) + Math.abs(m.c - st.p[pl][1]) > 1);
        }
      } else {
        own.set(`${m.o},${m.r},${m.c}`, { pl, t0: last ? now : -1e9 });
        if (last) sound.wall(pl);
      }
      E.applyMove(st, m);
    }
    return {
      state: st, owners: own, trails: tr, disp: st.p.map(([r, c]) => ({ r, c })),
      anim: an, lastAct: [null, null], fx: [], derezAt: [null, null],
    };
  }

  function setReviewView(v) {
    review.view = v;
    document.body.dataset.view = v;
    $('rv-list-view').hidden = v !== 'list';
    $('rv-game-view').hidden = v !== 'game';
    $('rv-learn-view').hidden = v !== 'learn';
  }

  function openHistory() {
    if (busy || review) return;
    review = { live: { scene: captureScene(), mode, ghost }, game: null, ply: 0, before: null, puzzle: null };
    mode = 'move';
    ghost = null;
    hover = null;
    $('overlay').classList.add('hidden');
    $('panel').hidden = true;
    $('review').hidden = false;
    showList();
  }

  function closeHistory() {
    if (!review) return;
    useScene(review.live.scene);
    mode = review.live.mode;
    ghost = review.live.ghost;
    review = null;
    document.body.dataset.view = 'play';
    $('tb-status').textContent = $('status').textContent;
    $('tb-status').className = $('status').className;
    $('panel').hidden = false;
    $('review').hidden = true;
    canvas.style.cursor = 'default';
    if (over) $('overlay').classList.remove('hidden');
    refresh();
  }

  function reviewBack() {
    if (review.view === 'learn') exitLearn();
    else if (review.view === 'game') showList();
    else closeHistory();
  }

  function showList() {
    setReviewView('list');
    review.game = null;
    review.puzzle = null;
    useScene(review.live.scene);
    const ol = $('rv-list');
    ol.innerHTML = '';
    const list = GameHistory.load();
    if (!list.length) {
      ol.innerHTML = '<li class="empty">Nenhuma partida registrada ainda. Jogue uma e volte aqui.</li>';
      return;
    }
    for (const g of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'game-item ' + g.result;
      const extra = g.analysis
        ? `Sua precisão: ${Math.round(GameHistory.summary(g)[0].acc)}%`
        : analyzing === g.id ? 'Analisando…' : 'Não analisada';
      b.innerHTML = `<span class="gi-res">${RESULT[g.result]}</span>` +
        `<span class="gi-meta">${fmtDate(g.date)} · nível ${g.level} · ${g.moves.length} lances</span>` +
        `<span class="gi-extra">${extra}</span>`;
      b.addEventListener('click', () => openGame(g.id));
      li.appendChild(b);
      ol.appendChild(li);
    }
  }

  function openGame(id, autoAnalyze = false) {
    const g = GameHistory.get(id);
    if (!g) return;
    review.game = g;
    review.puzzle = null;
    review.ply = -1;
    setReviewView('game');
    $('rv-title').textContent = `${RESULT[g.result]} · nível ${g.level} · ${fmtDate(g.date)}`;
    renderAnalysis();
    goto(g.moves.length, false);
    if (autoAnalyze && !g.analysis) analyze();
  }

  function renderAnalysis() {
    renderMoves();
    renderSummary();
    renderGraph();
    updateAnalysisButtons();
  }

  function goto(ply, animate = true) {
    const g = review.game;
    ply = Math.max(0, Math.min(g.moves.length, ply));
    const step = ply === review.ply + 1;
    review.ply = ply;
    review.before = buildScene(g.moves, Math.max(0, ply - 1)).state;
    useScene(buildScene(g.moves, ply, animate && step));
    for (const b of $('rv-moves').querySelectorAll('.mv')) {
      const on = Number(b.dataset.ply) === ply;
      b.classList.toggle('current', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    }
    const cur = $('rv-cursor');
    if (cur) {
      const x = (ply / g.moves.length) * 300;
      cur.setAttribute('x1', x);
      cur.setAttribute('x2', x);
    }
    updateComment();
  }

  function updateComment() {
    const g = review.game, k = review.ply - 1, el = $('rv-comment');
    let text, kind = '';
    if (k < 0) {
      text = 'Início da partida.';
    } else {
      const who = GameHistory.moverAt(k) === HUMAN ? 'Você' : 'O computador';
      const num = `${Math.floor(k / 2) + 1}${k % 2 ? '…' : '.'}`;
      if (g.moves[k] === '-') {
        text = `${num} ${who} passou a vez (estava sem lances).`;
      } else {
        text = `${num} ${who} jogou ${g.moves[k]}.`;
        const a = g.analysis && g.analysis[k];
        if (a) {
          const cls = GameHistory.classify(a);
          if (cls) text += ` ${CLS[cls].label}: a melhor era ${a.b}.`;
          else if (a.b === g.moves[k]) text += ' Melhor lance.';
          else text += ' Boa jogada.';
          text += ` Avaliação: ${GameHistory.formatEval(GameHistory.evalAfter(g, k))}.`;
          kind = cls || '';
        } else if (!g.analysis) {
          text += ' Analise a partida para ver os comentários.';
        }
      }
    }
    el.textContent = text;
    el.className = 'status rv-comment' + (kind ? ' ' + kind : '');
  }

  function renderMoves() {
    const g = review.game, el = $('rv-moves');
    el.innerHTML = '<span class="mv-head"></span><span class="mv-head">Você</span><span class="mv-head">Computador</span>';
    for (let i = 0; i < g.moves.length; i += 2) {
      const num = document.createElement('span');
      num.className = 'mv-num';
      num.textContent = i / 2 + 1;
      el.appendChild(num);
      for (const k of [i, i + 1]) {
        const b = document.createElement('button');
        b.className = 'mv';
        if (k < g.moves.length) {
          const cls = GameHistory.classify(g.analysis && g.analysis[k]);
          b.textContent = g.moves[k] + (cls ? ' ' + CLS[cls].sym : '');
          if (cls) b.classList.add(cls);
          b.dataset.ply = k + 1;
          b.addEventListener('click', () => goto(k + 1, false));
        } else {
          b.disabled = true;
        }
        el.appendChild(b);
      }
    }
  }

  function renderSummary() {
    const g = review.game, el = $('rv-summary');
    el.hidden = !g.analysis;
    if (!g.analysis) return;
    const [you, cpu] = GameHistory.summary(g);
    const row = (cls, label, key) =>
      `<tr class="${cls}"><td>${label}</td><td>${you[key]}</td><td>${cpu[key]}</td></tr>`;
    el.innerHTML = '<table><thead><tr><th></th><th>Você</th><th>Computador</th></tr></thead><tbody>' +
      `<tr class="acc"><td>Precisão</td><td>${Math.round(you.acc)}%</td><td>${Math.round(cpu.acc)}%</td></tr>` +
      row('inaccuracy', '?! Imprecisões', 'inaccuracy') +
      row('mistake', '? Erros', 'mistake') +
      row('blunder', '?? Capivaradas', 'blunder') +
      '</tbody></table>';
  }

  // gráfico da avaliação ao longo da partida (acima do meio: vantagem sua)
  function renderGraph() {
    const g = review.game, box = $('rv-graph-box'), svg = $('rv-graph');
    box.hidden = !g.analysis;
    if (!g.analysis) return;
    const n = g.moves.length, Wd = 300, H = 80, mid = H / 2;
    const y = k => mid - GameHistory.chance(GameHistory.evalAfter(g, k)) * mid * 0.92;
    let line = `M0,${mid}`;
    for (let k = 0; k < n; k++) line += ` L${((k + 1) / n * Wd).toFixed(1)},${y(k).toFixed(1)}`;
    let dots = '';
    g.analysis.forEach((a, k) => {
      const cls = GameHistory.classify(a);
      if (cls && cls !== 'inaccuracy') {
        dots += `<circle class="dot ${cls}" cx="${((k + 1) / n * Wd).toFixed(1)}" cy="${y(k).toFixed(1)}" r="2.6"/>`;
      }
    });
    svg.setAttribute('viewBox', `0 0 ${Wd} ${H}`);
    svg.innerHTML =
      `<defs><linearGradient id="rv-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}">` +
      `<stop offset="0" stop-color="${COLOR[HUMAN]}" stop-opacity=".55"/>` +
      `<stop offset=".5" stop-color="${COLOR[HUMAN]}" stop-opacity=".08"/>` +
      `<stop offset=".5" stop-color="${COLOR[CPU]}" stop-opacity=".08"/>` +
      `<stop offset="1" stop-color="${COLOR[CPU]}" stop-opacity=".55"/></linearGradient></defs>` +
      `<path d="${line} L${Wd},${mid} Z" fill="url(#rv-grad)"/>` +
      `<line x1="0" x2="${Wd}" y1="${mid}" y2="${mid}" class="mid"/>` +
      `<path d="${line}" class="curve"/>${dots}` +
      `<line id="rv-cursor" class="cursor" y1="0" y2="${H}" x1="0" x2="0"/>`;
  }

  $('rv-graph').addEventListener('click', e => {
    if (!review || !review.game) return;
    const r = e.currentTarget.getBoundingClientRect();
    goto(Math.round((e.clientX - r.left) / r.width * review.game.moves.length), false);
  });

  const outdated = g => (g.av || 1) < ANALYSIS_VERSION;

  function mistakesOf(g) {
    if (!g.analysis) return [];
    const mine = g.analysis
      .map((a, k) => ({ k, cls: GameHistory.classify(a) }))
      .filter(x => x.cls && GameHistory.moverAt(x.k) === HUMAN);
    const serious = mine.filter(x => x.cls !== 'inaccuracy');
    return (serious.length ? serious : mine).map(x => x.k);
  }

  function updateAnalysisButtons() {
    const g = review.game;
    const btn = $('rv-analyze'), learn = $('rv-learn'), bar = $('rv-progress');
    btn.hidden = !!g.analysis && !outdated(g);
    btn.disabled = analyzing !== null;
    if (analyzing !== g.id) {
      btn.textContent = analyzing ? 'Outra partida em análise…'
        : g.analysis ? 'Reanalisar com o motor melhorado' : 'Analisar partida';
    }
    bar.hidden = analyzing !== g.id;
    learn.hidden = !g.analysis;
    const n = mistakesOf(g).length;
    learn.disabled = n === 0;
    learn.textContent = n ? `Revisar meus erros (${n})` : 'Nenhum erro seu para revisar';
  }

  function analyze() {
    const g = review.game;
    if (analyzing || (g.analysis && !outdated(g))) return;
    analyzing = g.id;
    $('rv-progress').firstElementChild.style.width = '0%';
    updateAnalysisButtons();
    $('rv-analyze').textContent = 'Analisando…';
    const viewing = () => review && review.game && review.game.id === g.id;
    const args = { moves: g.moves, depth: ANALYSIS_DEPTH, timeMs: ANALYSIS_TIME_MS, opts: ANALYSIS_OPTS };
    analyst.call('analyze', args, (k, n) => {
      if (!viewing()) return;
      $('rv-progress').firstElementChild.style.width = `${(k / n) * 100}%`;
      $('rv-analyze').textContent = `Analisando… falta ~${Math.ceil(((n - k) * ANALYSIS_TIME_MS) / 1000)} s`;
    }).then(res => {
      analyzing = null;
      g.analysis = res;
      g.av = ANALYSIS_VERSION;
      GameHistory.update(g);
      if (viewing()) {
        review.game = g;
        renderAnalysis();
        goto(review.ply, false);
      } else if (review && review.view === 'list') {
        showList();
      }
    });
  }

  // --- revisar meus erros ---
  function reviewCanAct() {
    return review.view === 'learn' && review.puzzle.phase === 'solve' && state.turn === HUMAN;
  }

  const learnStatus = (text, kind = '') => writeStatus('lv-status', text, kind);

  function learnButtons() {
    const P = review.puzzle;
    $('lv-progress').textContent = P.idx < P.list.length
      ? `Erro ${P.idx + 1} de ${P.list.length} · acertos de primeira: ${P.ok}`
      : `Acertos de primeira: ${P.ok} de ${P.list.length}`;
    const finished = P.idx >= P.list.length;
    $('lv-solution').hidden = P.phase === 'done' || finished;
    $('lv-skip').hidden = P.phase === 'done' || finished;
    $('lv-next').hidden = P.phase !== 'done' || finished;
    $('lv-wall-row').hidden = P.phase === 'done' || finished;
    refresh();
  }

  function startLearn() {
    const list = mistakesOf(review.game);
    if (!list.length) return;
    review.puzzle = { list, idx: 0, ok: 0 };
    setReviewView('learn');
    loadPuzzle();
  }

  function loadPuzzle() {
    const P = review.puzzle, g = review.game;
    if (P.idx >= P.list.length) {
      P.phase = 'finished';
      learnStatus(`Revisão concluída: você achou a jogada melhor de primeira em ${P.ok} de ${P.list.length}.`, P.ok === P.list.length ? 'win' : '');
      learnButtons();
      return;
    }
    const k = P.list[P.idx], a = g.analysis[k], cls = GameHistory.classify(a);
    Object.assign(P, { k, phase: 'solve', showBest: false, best: E.parse(a.b), tries: 0 });
    review.ply = k;
    useScene(buildScene(g.moves, k));
    mode = 'move';
    ghost = null;
    learnStatus(`Lance ${Math.floor(k / 2) + 1}: aqui você jogou ${g.moves[k]} (${CLS[cls].label.toLowerCase()}). Encontre uma jogada melhor.`, cls);
    learnButtons();
  }

  function reviewAttempt(move) {
    const P = review.puzzle, g = review.game, a = g.analysis[P.k];
    const before = E.clone(state), not = E.notate(move);
    P.phase = 'checking';
    mode = 'move';
    applyVisual(move);
    learnStatus(`Verificando ${not}…`);
    learnButtons();
    const opts = { ...ANALYSIS_OPTS, exact: move };
    analyst.call('search', { state: before, depth: ANALYSIS_DEPTH, timeMs: ANALYSIS_TIME_MS, opts }).then(res => {
      if (!review || review.puzzle !== P) return;
      // certo se não for nem uma imprecisão em relação à melhor jogada da mesma busca
      if (GameHistory.chance(res.score) - GameHistory.chance(res.exactScore) < 0.1) {
        P.phase = 'done';
        if (P.tries === 0) P.ok++;
        sound.good();
        learnStatus(not === a.b
          ? `Correto! ${not} é a melhor jogada.`
          : `Correto! ${not} é tão bom quanto a jogada que a análise encontrou (${a.b}).`, 'win');
        learnButtons();
        return;
      }
      P.tries++;
      sound.bad();
      learnStatus(`${not} não resolve. Tente de novo.`, 'bad');
      setTimeout(() => {
        if (!review || review.puzzle !== P || P.phase !== 'checking') return;
        useScene(buildScene(g.moves, P.k));
        P.phase = 'solve';
        learnButtons();
      }, 900);
    });
  }

  function showSolution() {
    const P = review.puzzle, g = review.game;
    if (P.phase === 'done') return;
    P.phase = 'done';
    P.showBest = true;
    useScene(buildScene(g.moves, P.k));
    mode = 'move';
    applyVisual(P.best);
    learnStatus(`A melhor jogada era ${g.analysis[P.k].b}.`, 'cpu');
    learnButtons();
  }

  function nextPuzzle() {
    review.puzzle.idx++;
    loadPuzzle();
  }

  function exitLearn() {
    const k = review.puzzle ? review.puzzle.k : review.ply;
    review.puzzle = null;
    mode = 'move';
    ghost = null;
    setReviewView('game');
    review.ply = -1;
    goto(k + 1 || 0, false);
  }

  // ---------- entrada ----------
  canvas.addEventListener('pointermove', e => {
    const [x, y] = pointerPos(e);
    if (e.pointerType !== 'touch' && !isTouch()) {
      ghost = { o: wallO, ...anchorAt(x, y) };
      canvas.style.cursor = canAct() && state.walls[HUMAN] > 0 ? 'crosshair' : 'default';
      return;
    }
    if (mode === 'wall') {
      if (e.pointerType !== 'touch') ghost = { o: ghost.o, ...anchorAt(x, y) };
      return;
    }
    hover = cellAt(x, y);
    const target = hover && canAct() && humanTargets().some(([r, c]) => r === hover.r && c === hover.c);
    canvas.style.cursor = target ? 'pointer' : 'default';
  });

  canvas.addEventListener('pointerleave', () => {
    hover = null;
    if (!isTouch()) ghost = null;
  });

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch' && !isTouch()) {
      root.classList.add('touch');
      ghost = null;
      if (canAct()) setStatus(idleText());
    }
    if (e.button !== 0 || !canAct()) return;
    const [x, y] = pointerPos(e);
    if (!isTouch()) {
      ghost = { o: wallO, ...anchorAt(x, y) };
      placeWall();
      return;
    }
    if (mode === 'wall') {
      if (e.pointerType !== 'touch') {
        ghost = { o: ghost.o, ...anchorAt(x, y) };
        placeWall();
        return;
      }
      // no toque, o primeiro toque posiciona e o segundo (na mesma parede) confirma
      const g = touchWallAt(x, y, ghost.o);
      const same = g.o === ghost.o && g.r === ghost.r && g.c === ghost.c;
      ghost = g;
      if (same) placeWall();
      else sound.tick();
      return;
    }
    const cell = cellAt(x, y);
    if (cell) moveTo(cell.r, cell.c);
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    rotate();
  });

  const KEYS = {
    ArrowUp: [-1, 0], KeyW: [-1, 0],
    ArrowDown: [1, 0], KeyS: [1, 0],
    ArrowLeft: [0, -1], KeyA: [0, -1],
    ArrowRight: [0, 1], KeyD: [0, 1],
  };

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const d = KEYS[e.code];
    switch (e.code) {
      case 'KeyR': rotate(); return;
      case 'KeyP': if (isTouch()) setMode(mode === 'wall' ? 'move' : 'wall'); return;
      case 'KeyM': toggleSound(); return;
      case 'Escape':
        if (mode === 'wall') setMode('move');
        else if (review) reviewBack();
        return;
    }
    // navegando no histórico: setas andam pelos lances
    if (review && !canAct() && mode !== 'wall') {
      if (review.view !== 'game') return;
      const nav = {
        ArrowLeft: review.ply - 1, ArrowRight: review.ply + 1,
        ArrowUp: 0, Home: 0, ArrowDown: Infinity, End: Infinity,
      }[e.code];
      if (nav !== undefined) {
        e.preventDefault();
        goto(nav, e.code === 'ArrowRight');
      }
      return;
    }
    if (mode === 'wall') {
      if (d) {
        e.preventDefault();
        ghost = { o: ghost.o, r: clampW(ghost.r + d[0]), c: clampW(ghost.c + d[1]) };
      } else if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        placeWall();
      }
      return;
    }
    if (d) {
      e.preventDefault();
      keyStep(d);
    }
  });

  // botões perdem o foco ao clicar, para Espaço/Enter não os acionarem de novo
  function onClick(id, fn) {
    $(id).addEventListener('click', e => { e.currentTarget.blur(); fn(); });
  }

  onClick('btn-rotate', rotate);
  onClick('tb-wall', () => setMode(mode === 'wall' ? 'move' : 'wall'));
  onClick('tb-rotate', rotate);
  onClick('btn-new', newGame);
  onClick('btn-sound', toggleSound);

  function toggleSound() {
    sound.toggle();
    showSound();
  }

  function showSound() {
    $('btn-sound').innerHTML = `${sound.muted ? 'Som desligado' : 'Som ligado'} <kbd>M</kbd>`;
  }
  showSound();
  onClick('ov-next', newGame);

  onClick('btn-history', openHistory);
  onClick('ov-review', () => {
    const id = record.id;
    openHistory();
    openGame(id, true);
  });
  onClick('rv-back', closeHistory);
  onClick('rv-to-list', showList);
  onClick('rv-first', () => goto(0, false));
  onClick('rv-prev', () => goto(review.ply - 1, false));
  onClick('rv-next', () => goto(review.ply + 1, true));
  onClick('rv-last', () => goto(Infinity, false));
  onClick('rv-analyze', analyze);
  onClick('rv-learn', startLearn);
  onClick('lv-rotate', rotate);
  onClick('lv-solution', showSolution);
  onClick('lv-skip', nextPuzzle);
  onClick('lv-next', nextPuzzle);
  onClick('lv-exit', exitLearn);

  // recarregar ou fechar a página no meio de uma partida também a registra
  window.addEventListener('pagehide', saveIfAbandoned);

  let resetTimer = null;
  onClick('btn-reset', () => {
    const btn = $('btn-reset');
    if (!resetTimer) {
      btn.textContent = 'Clique de novo para confirmar';
      btn.classList.add('armed');
      resetTimer = setTimeout(() => {
        resetTimer = null;
        btn.textContent = 'Zerar progresso';
        btn.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(resetTimer);
    resetTimer = null;
    btn.textContent = 'Zerar progresso';
    btn.classList.remove('armed');
    Object.assign(progress, { level: 1, wins: 0, losses: 0 });
    saveProgress();
    newGame();
  });

  new ResizeObserver(layout).observe(wrap);
  newGame();
  layout();
  requestAnimationFrame(frame);
})();
