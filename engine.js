// Regras do jogo e IA (negamax com poda alfa-beta).
// Tudo fica dentro de createEngine() para que o mesmo código rode na página
// e num Web Worker (o worker é montado a partir de createEngine.toString()).
function createEngine() {
  const N = 9;              // casas por lado
  const W = 8;              // posições de parede por lado
  const GOAL = [0, N - 1];  // linha-alvo: jogador 0 sobe, jogador 1 desce
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const WALL = 100;         // movimentos >= WALL são paredes: WALL + o*64 + r*8 + c
  const WIN = 100000;

  // h[r*8+c]: parede horizontal entre as linhas r e r+1, cobrindo as colunas c e c+1.
  // v[r*8+c]: parede vertical entre as colunas c e c+1, cobrindo as linhas r e r+1.
  function newState() {
    return {
      p: [[N - 1, 4], [0, 4]],
      walls: [10, 10],
      h: new Uint8Array(W * W),
      v: new Uint8Array(W * W),
      turn: 0,
    };
  }

  function clone(s) {
    return { p: [s.p[0].slice(), s.p[1].slice()], walls: s.walls.slice(), h: s.h.slice(), v: s.v.slice(), turn: s.turn };
  }

  // Há parede (ou borda) entre (r,c) e (r+dr,c+dc)?
  function blocked(s, r, c, dr, dc) {
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= N || nc < 0 || nc >= N) return true;
    if (dr !== 0) {
      const wr = dr > 0 ? r : nr;
      return (c < W && s.h[wr * W + c] === 1) || (c > 0 && s.h[wr * W + c - 1] === 1);
    }
    const wc = dc > 0 ? c : nc;
    return (r < W && s.v[r * W + wc] === 1) || (r > 0 && s.v[(r - 1) * W + wc] === 1);
  }

  // ---------- caminhos (BFS, ignorando peões) ----------
  const dist = new Int16Array(N * N);
  const prev = new Int16Array(N * N);
  const queue = new Int16Array(N * N);

  function bfs(s, i, wantPath) {
    dist.fill(-1);
    const sr = s.p[i][0], sc = s.p[i][1], goal = GOAL[i];
    const start = sr * N + sc;
    if (sr === goal) return wantPath ? [start] : 0;
    let head = 0, tail = 0;
    queue[tail++] = start;
    dist[start] = 0;
    prev[start] = -1;
    while (head < tail) {
      const cur = queue[head++];
      const r = (cur / N) | 0, c = cur % N;
      for (let k = 0; k < 4; k++) {
        const dr = DIRS[k][0], dc = DIRS[k][1];
        if (blocked(s, r, c, dr, dc)) continue;
        const n = cur + dr * N + dc;
        if (dist[n] >= 0) continue;
        dist[n] = dist[cur] + 1;
        prev[n] = cur;
        if (r + dr === goal) {
          if (!wantPath) return dist[n];
          const path = [];
          for (let x = n; x >= 0; x = prev[x]) path.push(x);
          return path.reverse();
        }
        queue[tail++] = n;
      }
    }
    return wantPath ? null : -1;
  }

  const distance = (s, i) => bfs(s, i, false);

  // ---------- paredes ----------
  function wallFits(s, o, r, c) {
    if (r < 0 || r >= W || c < 0 || c >= W) return false;
    const i = r * W + c;
    if (s.h[i] || s.v[i]) return false; // mesma posição ou cruzamento
    if (o === 0) return !((c > 0 && s.h[i - 1]) || (c < W - 1 && s.h[i + 1]));
    return !((r > 0 && s.v[i - W]) || (r < W - 1 && s.v[i + W]));
  }

  // O canto (x, y) da grade (0..9) encosta na borda ou em alguma parede?
  function touches(s, x, y) {
    if (x <= 0 || x >= N || y <= 0 || y >= N) return true;
    const r = y - 1, c = x - 1;
    for (let k = x - 2; k <= x; k++) if (k >= 0 && k < W && s.h[r * W + k]) return true;
    for (let k = y - 2; k <= y; k++) if (k >= 0 && k < W && s.v[k * W + c]) return true;
    return false;
  }

  // Uma parede só fecha uma região se encostar na estrutura existente (bordas e
  // outras paredes) em pelo menos dois dos seus três pontos. Com menos, nem
  // precisa da busca de caminho: a grande maioria das paredes cai aqui.
  function mayBlock(s, o, r, c) {
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const hit = o === 0 ? touches(s, c + k, r + 1) : touches(s, c + 1, r + k);
      if (hit && ++n >= 2) return true;
    }
    return false;
  }

  // parede que cabe (wallFits) e não fecha o caminho de ninguém
  function wallOk(s, o, r, c) {
    if (!mayBlock(s, o, r, c)) return true;
    const arr = o === 0 ? s.h : s.v, i = r * W + c;
    arr[i] = 1;
    const ok = distance(s, 0) >= 0 && distance(s, 1) >= 0;
    arr[i] = 0;
    return ok;
  }

  // 'ok' | 'nowalls' | 'overlap' | 'block'
  function wallStatus(s, pl, o, r, c) {
    if (s.walls[pl] <= 0) return 'nowalls';
    if (!wallFits(s, o, r, c)) return 'overlap';
    return wallOk(s, o, r, c) ? 'ok' : 'block';
  }

  function wallMoveOk(s, mv) {
    const id = mv - WALL, r = (id & 63) >> 3, c = id & 7;
    return s.walls[s.turn] > 0 && wallFits(s, id >> 6, r, c) && wallOk(s, id >> 6, r, c);
  }

  // ---------- movimentos ----------
  function pawnCells(s, i) {
    const out = [];
    const r = s.p[i][0], c = s.p[i][1], or = s.p[1 - i][0], oc = s.p[1 - i][1];
    for (let k = 0; k < 4; k++) {
      const dr = DIRS[k][0], dc = DIRS[k][1];
      if (blocked(s, r, c, dr, dc)) continue;
      const nr = r + dr, nc = c + dc;
      if (nr !== or || nc !== oc) { out.push(nr * N + nc); continue; }
      // adversário colado: pula por cima, se não houver parede ou borda atrás dele
      // (sem pulo diagonal: nunca se anda na diagonal)
      if (!blocked(s, nr, nc, dr, dc)) out.push((nr + dr) * N + nc + dc);
    }
    // mais perto do objetivo primeiro (melhora a poda)
    const goal = GOAL[i];
    return out.sort((a, b) => Math.abs(((a / N) | 0) - goal) - Math.abs(((b / N) | 0) - goal));
  }

  // Só considera paredes que cortam o caminho mais curto do adversário
  // ou que ficam ao redor do peão dele; o resto raramente importa e explode a árvore.
  const seen = new Uint8Array(128);
  function candidateWalls(s, pl) {
    const out = [];
    if (s.walls[pl] <= 0) return out;
    seen.fill(0);
    const add = (o, r, c) => {
      if (r < 0 || r >= W || c < 0 || c >= W) return;
      const id = o * 64 + r * W + c;
      if (seen[id]) return;
      seen[id] = 1;
      if (wallFits(s, o, r, c) && wallOk(s, o, r, c)) out.push(WALL + id);
    };
    const path = bfs(s, 1 - pl, true) || [];
    for (let k = 0; k + 1 < path.length; k++) {
      const ra = (path[k] / N) | 0, ca = path[k] % N;
      const rb = (path[k + 1] / N) | 0, cb = path[k + 1] % N;
      if (ra !== rb) {
        const r = Math.min(ra, rb);
        add(0, r, ca); add(0, r, ca - 1);
      } else {
        const c = Math.min(ca, cb);
        add(1, ra, c); add(1, ra - 1, c);
      }
    }
    const or = s.p[1 - pl][0], oc = s.p[1 - pl][1];
    for (let r = or - 1; r <= or; r++) {
      for (let c = oc - 1; c <= oc; c++) { add(0, r, c); add(1, r, c); }
    }
    return out;
  }

  function genMoves(s) {
    return pawnCells(s, s.turn).concat(candidateWalls(s, s.turn));
  }

  // ---------- hash Zobrist (s.hlo/s.hhi, 64 bits em dois inteiros) ----------
  // Mantido por apply/undo; search() o recalcula do zero ao começar.
  let seed = 0x2545f491;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
  const table = n => { const lo = new Int32Array(n), hi = new Int32Array(n); for (let k = 0; k < n; k++) { lo[k] = rnd(); hi[k] = rnd(); } return [lo, hi]; };
  const [ZP_LO, ZP_HI] = table(2 * N * N);   // peão do jogador i na casa x: i*81+x
  const [ZW_LO, ZW_HI] = table(128);         // parede o*64+r*8+c
  const [ZC_LO, ZC_HI] = table(2 * 11);      // jogador i com n paredes na mão: i*11+n
  const ZT_LO = rnd(), ZT_HI = rnd();        // vez do jogador 1

  function hashOf(s) {
    let lo = 0, hi = 0;
    for (let i = 0; i < 2; i++) {
      const x = i * N * N + s.p[i][0] * N + s.p[i][1], w = i * 11 + s.walls[i];
      lo ^= ZP_LO[x] ^ ZC_LO[w];
      hi ^= ZP_HI[x] ^ ZC_HI[w];
    }
    for (let k = 0; k < 64; k++) {
      if (s.h[k]) { lo ^= ZW_LO[k]; hi ^= ZW_HI[k]; }
      if (s.v[k]) { lo ^= ZW_LO[64 + k]; hi ^= ZW_HI[64 + k]; }
    }
    if (s.turn) { lo ^= ZT_LO; hi ^= ZT_HI; }
    s.hlo = lo;
    s.hhi = hi;
  }

  // alterna no hash o que muda com o lance mv do jogador pl (from = casa de origem)
  function toggle(s, pl, mv, from) {
    let lo = ZT_LO, hi = ZT_HI;
    if (mv < WALL) {
      const b = pl * N * N;
      lo ^= ZP_LO[b + from] ^ ZP_LO[b + mv];
      hi ^= ZP_HI[b + from] ^ ZP_HI[b + mv];
    } else {
      const id = mv - WALL, n = s.walls[pl], b = pl * 11;
      // n e n-1 paredes na mão (antes e depois da parede, em qualquer ordem)
      lo ^= ZW_LO[id] ^ ZC_LO[b + n] ^ ZC_LO[b + n - 1];
      hi ^= ZW_HI[id] ^ ZC_HI[b + n] ^ ZC_HI[b + n - 1];
    }
    s.hlo ^= lo;
    s.hhi ^= hi;
  }

  function apply(s, mv) {
    const pl = s.turn;
    let undo = -1;
    if (mv < WALL) {
      undo = s.p[pl][0] * N + s.p[pl][1];
      toggle(s, pl, mv, undo);
      s.p[pl][0] = (mv / N) | 0;
      s.p[pl][1] = mv % N;
    } else {
      const id = mv - WALL;
      toggle(s, pl, mv, 0);
      (id < 64 ? s.h : s.v)[id & 63] = 1;
      s.walls[pl]--;
    }
    s.turn = 1 - pl;
    return undo;
  }

  function undo(s, mv, u) {
    s.turn = 1 - s.turn;
    const pl = s.turn;
    if (mv < WALL) {
      toggle(s, pl, mv, u);
      s.p[pl][0] = (u / N) | 0;
      s.p[pl][1] = u % N;
    } else {
      const id = mv - WALL;
      (id < 64 ? s.h : s.v)[id & 63] = 0;
      s.walls[pl]++;
      toggle(s, pl, mv, 0);
    }
  }

  function encode(m) {
    return m.t === 'm' ? m.r * N + m.c : WALL + m.o * 64 + m.r * W + m.c;
  }

  function decode(mv) {
    if (mv == null) return null;
    if (mv < WALL) return { t: 'm', r: (mv / N) | 0, c: mv % N };
    const id = mv - WALL;
    return { t: 'w', o: id >> 6, r: (id & 63) >> 3, c: id & 7 };
  }

  function winner(s) {
    if (s.p[0][0] === GOAL[0]) return 0;
    if (s.p[1][0] === GOAL[1]) return 1;
    return -1;
  }

  // ---------- busca ----------
  // `me` é sempre quem tem a vez; TEMPO compensa a vantagem de jogar primeiro
  // (não muda a escolha da IA, mas deixa as avaliações da análise comparáveis).
  // Cada parede na mão vale WALL_VALUE (1,6 passo): calibrado em partidas do
  // motor contra si mesmo. Com valor baixo, a IA gastava as paredes cedo e
  // ficava indefesa no fim. A avaliação é só isso de propósito: estimar o que
  // as paredes guardadas ainda podem fazer (testando paredes na avaliação)
  // custava tanto que, no mesmo tempo, a busca mais funda jogava melhor.
  const TEMPO = 5;
  const WALL_VALUE = 16;
  function evaluate(s, me) {
    const dMe = distance(s, me), dOp = distance(s, 1 - me);
    return (dOp - dMe) * 10 + (s.walls[me] - s.walls[1 - me]) * WALL_VALUE + TEMPO;
  }

  // Cache das avaliações pelo hash da posição (que inclui a vez). As mesmas
  // posições aparecem por caminhos diferentes o tempo todo na busca.
  const EC_BITS = 18, EC_MASK = (1 << EC_BITS) - 1;
  const ecHi = new Int32Array(1 << EC_BITS), ecLo = new Int32Array(1 << EC_BITS);
  const ecVal = new Int32Array(1 << EC_BITS), ecOk = new Uint8Array(1 << EC_BITS);

  function evaluateCached(s) {
    const k = s.hlo & EC_MASK;
    if (ecOk[k] && ecHi[k] === s.hhi && ecLo[k] === s.hlo) return ecVal[k];
    const v = evaluate(s, s.turn);
    ecOk[k] = 1; ecHi[k] = s.hhi; ecLo[k] = s.hlo; ecVal[k] = v;
    return v;
  }

  const TIMEOUT = {};
  let deadline = Infinity, nodes = 0;

  // Lances de quem já não tem paredes são só passos de peão (2 ou 3 opções):
  // não gastam profundidade, até MAX_PLY. Assim a busca enxerga armadilhas de
  // várias paredes contra quem não pode mais responder. Sem paredes dos dois
  // lados, sobra uma corrida, que a avaliação já resolve.
  const MAX_PLY = 30;

  // Tabela de transposição: guarda, por posição, o valor já calculado (exato ou
  // um limite, conforme a poda) e o melhor lance, que é testado primeiro depois.
  const TT_BITS = 20, TT_MASK = (1 << TT_BITS) - 1;
  const ttHi = new Int32Array(1 << TT_BITS), ttLo = new Int32Array(1 << TT_BITS);
  const ttVal = new Int32Array(1 << TT_BITS), ttMove = new Int16Array(1 << TT_BITS);
  const ttDepth = new Int8Array(1 << TT_BITS), ttFlag = new Uint8Array(1 << TT_BITS);
  const EXACT = 1, LOWER = 2, UPPER = 3;
  // vitórias forçadas valem WIN - ply; na tabela ficam relativas à posição
  const toTT = (v, ply) => (v > WIN - 1000 ? v + ply : v < -WIN + 1000 ? v - ply : v);
  const fromTT = (v, ply) => (v > WIN - 1000 ? v - ply : v < -WIN + 1000 ? v + ply : v);

  // lances que causaram poda em outras posições da mesma altura (killer moves)
  const killers = new Int16Array(2 * 64);

  function negamax(s, depth, alpha, beta, ply) {
    const w = winner(s);
    if (w >= 0) return (w === s.turn ? 1 : -1) * (WIN - ply);
    if (depth === 0 || (s.walls[0] === 0 && s.walls[1] === 0)) return evaluateCached(s);
    if ((++nodes & 15) === 0 && Date.now() > deadline) throw TIMEOUT;

    const t = s.hlo & TT_MASK;
    const hit = ttFlag[t] !== 0 && ttHi[t] === s.hhi && ttLo[t] === s.hlo;
    if (hit && ttDepth[t] >= depth) {
      const v = fromTT(ttVal[t], ply), f = ttFlag[t];
      if (f === EXACT || (f === LOWER && v >= beta) || (f === UPPER && v <= alpha)) return v;
    }

    const next = s.walls[s.turn] === 0 && ply < MAX_PLY ? depth : depth - 1;
    const alpha0 = alpha;
    let best = -Infinity, bestMv = -1, cut = false;
    const tried = [];
    const play = mv => {
      tried.push(mv);
      const u = apply(s, mv);
      const v = -negamax(s, next, -beta, -alpha, ply + 1);
      undo(s, mv, u);
      if (v > best) { best = v; bestMv = mv; }
      if (v > alpha) alpha = v;
      return (cut = alpha >= beta);
    };

    // ordem: lance da tabela, killers, passos do peão e, só se nada disso
    // podar, as paredes (gerá-las é a parte cara)
    const pawns = pawnCells(s, s.turn);
    const ok = mv => mv >= 0 && !tried.includes(mv) && (mv < WALL ? pawns.includes(mv) : wallMoveOk(s, mv));
    const k0 = killers[2 * ply], k1 = killers[2 * ply + 1];
    if (hit && ok(ttMove[t])) play(ttMove[t]);
    if (!cut && ok(k0)) play(k0);
    if (!cut && ok(k1)) play(k1);
    for (let k = 0; !cut && k < pawns.length; k++) if (!tried.includes(pawns[k])) play(pawns[k]);
    if (!cut) {
      const walls = candidateWalls(s, s.turn);
      for (let k = 0; !cut && k < walls.length; k++) if (!tried.includes(walls[k])) play(walls[k]);
    }
    if (tried.length === 0) return evaluateCached(s);

    if (cut && bestMv !== k0) { killers[2 * ply + 1] = k0; killers[2 * ply] = bestMv; }
    ttHi[t] = s.hhi; ttLo[t] = s.hlo;
    ttVal[t] = toTT(best, ply);
    ttMove[t] = bestMv;
    ttDepth[t] = depth;
    ttFlag[t] = best <= alpha0 ? UPPER : best >= beta ? LOWER : EXACT;
    return best;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Aprofundamento iterativo até maxDepth; se o tempo acabar, usa a última
  // profundidade completa. A profundidade 1 sempre completa.
  // Contra o vaivém, dois custos nos passos de peão da raiz (só a IA do jogo os usa):
  // opts.stall: quantos passos de peão quem joga deu sem bater a menor distância
  // ao objetivo que já alcançou (ver trackProgress). Um passo que não o aproxima
  // do objetivo custa STALL_PENALTY * (stall + 1)²: um desvio isolado custa pouco,
  // o terceiro seguido já pesa. Adiar a entrada num corredor perigoso parece
  // sempre melhor no horizonte da busca, mas cada adiamento dá um lance de graça
  // ao adversário.
  // opts.recent: casas (r*9+c) por onde o peão passou há pouco; voltar a uma
  // delas custa REPEAT_PENALTY por visita. Pega os ciclos (d3, e3, d3…) em que
  // metade dos passos parece avanço.
  const STALL_PENALTY = 3;
  const REPEAT_PENALTY = 8;

  function search(s, maxDepth, timeMs, opts = {}) {
    const start = Date.now();
    deadline = start + timeMs;
    nodes = 0;
    hashOf(s);
    ttFlag.fill(0);
    killers.fill(-1);
    // opts.exact: lance cujo valor exato também se quer (a análise usa para o lance jogado)
    const exact = opts.exact ? encode(opts.exact) : null;
    let moves = shuffle(genMoves(s));
    if (exact !== null && !moves.includes(exact)) moves.push(exact);
    const pens = new Map();
    if (opts.stall != null || opts.recent) {
      const stallPen = STALL_PENALTY * ((opts.stall || 0) + 1) ** 2;
      const recent = opts.recent || [], d0 = distance(s, s.turn);
      for (const mv of moves) {
        if (mv >= WALL) continue;
        const u = apply(s, mv), d = distance(s, 1 - s.turn);
        undo(s, mv, u);
        let pen = recent.filter(x => x === mv).length * REPEAT_PENALTY;
        if (opts.stall != null && d >= d0) pen += stallPen;
        if (pen) pens.set(mv, pen);
      }
    }
    let best = moves.length ? moves[0] : null, bestScore = 0, reached = 0, exactScore = null;
    // exactSmooth: média do valor do lance de opts.exact nas duas últimas profundidades
    // completas. A avaliação favorece quem tem a vez no fim da busca, o que alterna com a
    // paridade da profundidade; a média cancela esse viés no gráfico da análise. (Para
    // classificar lances, melhor e jogado vêm da mesma profundidade, que é comparação justa.)
    let prevExact = null;
    for (let d = 1; d <= maxDepth && moves.length; d++) {
      // cada profundidade custa bem mais que a anterior: se já passou de 40% do tempo,
      // a próxima não terminaria e o trabalho seria jogado fora
      if (d > 1 && Date.now() - start > timeMs * 0.4) break;
      const scored = [];
      let alpha = -Infinity, dBest = null, dScore = -Infinity, dExact = null;
      try {
        for (const mv of moves) {
          const u = apply(s, mv);
          let v;
          const pen = pens.get(mv) || 0;
          const a = mv === exact ? -Infinity : alpha + pen;
          try { v = -negamax(s, d - 1, -Infinity, -a, 1) - pen; } finally { undo(s, mv, u); }
          scored.push([mv, v]);
          if (mv === exact) dExact = v;
          if (v > dScore) { dScore = v; dBest = mv; }
          if (v > alpha) alpha = v;
        }
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        break;
      }
      if (reached) prevExact = exactScore;
      best = dBest; bestScore = dScore; reached = d; exactScore = dExact;
      if (Math.abs(bestScore) > WIN - 1000) break; // resultado forçado encontrado
      moves = scored.sort((a, b) => b[1] - a[1]).map(x => x[0]);
    }
    let exactSmooth = exactScore;
    if (exactScore !== null && prevExact !== null && Math.max(Math.abs(exactScore), Math.abs(prevExact)) < WIN - 1000) {
      exactSmooth = (exactScore + prevExact) / 2;
    }
    return { move: decode(best), depth: reached, score: bestScore, exactScore, exactSmooth, nodes };
  }

  // Atualiza o progresso {best, stall, last} (ver search) de quem vai jogar o
  // lance m em s, antes de aplicá-lo; last é a distância logo depois do lance
  // anterior dele. Se agora ela é maior, foram paredes do adversário (o peão
  // dele não conta na distância), e best sobe na mesma medida.
  function trackProgress(s, m, prog) {
    const i = s.turn, d = distance(s, i);
    let { best, stall, last } = prog || { best: d, stall: 0, last: d };
    if (d > last) best += d - last;
    let d1 = d;
    if (m && m.t === 'm') {
      const t = clone(s);
      apply(t, encode(m));
      d1 = distance(t, i);
      if (d1 < best) { best = d1; stall = 0; } else stall++;
    }
    return { best, stall, last: d1 };
  }

  // Valor de um lance específico (do ponto de vista de quem o joga), na profundidade dada.
  function scoreMove(s, m, depth, opts = {}) {
    deadline = Infinity;
    hashOf(s);
    ttFlag.fill(0);
    killers.fill(-1);
    const mv = encode(m);
    const u = apply(s, mv);
    const v = -negamax(s, depth - 1, -Infinity, Infinity, 1);
    undo(s, mv, u);
    return v;
  }

  // ---------- notação ----------
  // Peão: casa de destino ("e2"). Colunas a–i da esquerda para a direita,
  // linhas 1–9 de baixo (lado do jogador 0) para cima.
  // Parede: casa inferior esquerda do bloco 2×2 que ela divide + h/v ("e3h").
  // "-" indica que o jogador passou a vez (encurralado).
  const FILES = 'abcdefghi';

  function notate(m) {
    if (m.t === 'm') return FILES[m.c] + (N - m.r);
    return FILES[m.c] + (W - m.r) + (m.o === 0 ? 'h' : 'v');
  }

  function parse(str) {
    let x = /^([a-i])([1-9])$/.exec(str);
    if (x) return { t: 'm', r: N - Number(x[2]), c: FILES.indexOf(x[1]) };
    x = /^([a-h])([1-8])([hv])$/.exec(str);
    if (x) return { t: 'w', o: x[3] === 'h' ? 0 : 1, r: W - Number(x[2]), c: FILES.indexOf(x[1]) };
    return null;
  }

  // Para cada lance: melhor lance da posição (b), valor do melhor (s) e do jogado (p),
  // ambos do ponto de vista de quem jogou, e a profundidade usada (d).
  function analyzeGame(moves, depth, timeMs, onProgress, opts = {}) {
    const s = newState(), out = [];
    for (let k = 0; k < moves.length; k++) {
      if (moves[k] === '-') {
        out.push(null);
        s.turn = 1 - s.turn;
      } else {
        const m = parse(moves[k]);
        const res = search(clone(s), depth, timeMs, { ...opts, exact: m });
        const played = res.exactScore;
        // v: valor suavizado do lance jogado, para o gráfico
        out.push({ b: res.move ? notate(res.move) : null, s: Math.max(res.score, played), p: played, v: res.exactSmooth, d: res.depth });
        apply(s, encode(m));
      }
      if (onProgress) onProgress(k + 1, moves.length);
    }
    return out;
  }

  return {
    N, W, GOAL, WIN,
    notate,
    parse,
    scoreMove,
    analyzeGame,
    newState,
    clone,
    distance,
    wallStatus,
    winner,
    search,
    trackProgress,
    pawnMoves: (s, i) => pawnCells(s, i).map(x => [(x / N) | 0, x % N]),
    applyMove: (s, m) => { apply(s, encode(m)); },
  };
}
