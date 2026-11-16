// Histórico das últimas partidas (localStorage) e os cálculos da análise:
// classificação dos lances, precisão e formatação das avaliações.
// As avaliações vêm do motor: 10 pontos = 1 passo de vantagem.
const GameHistory = (() => {
  const KEY = 'neon-walls:history';
  const MAX = 50;
  const WIN = 100000;

  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(d) ? d : [];
    } catch (e) {
      return [];
    }
  }

  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (e) { /* ignora */ }
  }

  function add(game) {
    const list = load().filter(g => g.id !== game.id);
    list.unshift(game);
    save(list);
  }

  function update(game) {
    const list = load();
    const i = list.findIndex(g => g.id === game.id);
    if (i >= 0) {
      list[i] = game;
      save(list);
    }
  }

  const get = id => load().find(g => g.id === id) || null;

  const isForced = score => Math.abs(score) > WIN - 1000;

  // chance de vitória em [-1, 1]; como no Lichess, os lances são julgados
  // pela queda nessa chance, então deslizes em partidas já decididas pesam menos
  const chance = score => (isForced(score) ? Math.sign(score) : Math.tanh(score / 60));

  const CLASSES = {
    inaccuracy: { sym: '?!', label: 'Imprecisão' },
    mistake: { sym: '?', label: 'Erro' },
    blunder: { sym: '??', label: 'Capivarada' },
  };

  const drop = a => chance(a.s) - chance(a.p);

  function classify(a) {
    if (!a) return null;
    const d = drop(a);
    if (d >= 0.3) return 'blunder';
    if (d >= 0.2) return 'mistake';
    if (d >= 0.1) return 'inaccuracy';
    return null;
  }

  // fórmula de precisão do Lichess, sobre a queda em pontos percentuais
  function accuracy(a) {
    const pct = Math.max(0, drop(a)) * 50;
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * pct) - 3.1669));
  }

  // o jogador 0 sempre começa e as vezes se alternam (passar a vez também conta)
  const moverAt = k => k % 2;

  function summary(game) {
    const out = [0, 1].map(() => ({ acc: 0, n: 0, inaccuracy: 0, mistake: 0, blunder: 0 }));
    game.analysis.forEach((a, k) => {
      if (!a) return;
      const o = out[moverAt(k)];
      o.acc += accuracy(a);
      o.n++;
      const c = classify(a);
      if (c) o[c]++;
    });
    for (const o of out) o.acc = o.n ? o.acc / o.n : 100;
    return out;
  }

  // avaliação depois do lance k, do ponto de vista do jogador 0
  // (v é o valor suavizado entre profundidades, quando a análise o tem)
  function evalAfter(game, k) {
    for (; k >= 0; k--) {
      const a = game.analysis[k];
      if (a) {
        const v = a.v ?? a.p;
        return moverAt(k) === 0 ? v : -v;
      }
    }
    return 0;
  }

  function formatEval(score) {
    if (isForced(score)) {
      if (WIN - Math.abs(score) <= 1) return score > 0 ? 'vitória sua' : 'vitória do computador'; // o lance encerrou a partida
      const moves = Math.max(1, Math.ceil((WIN - Math.abs(score)) / 2));
      return (score > 0 ? '+' : '−') + '#' + moves;
    }
    const v = Math.round(score) / 10;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1).replace('.', ',');
  }

  return { MAX, load, add, update, get, chance, classify, CLASSES, summary, evalAfter, formatEval, moverAt };
})();
