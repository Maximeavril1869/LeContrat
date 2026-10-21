/* Le Contrat — moteur de jeu : cartes, paris, plis, marque, IA.
   22 atouts du Tarot (1 à 21 + l'Excuse), 2 à 5 joueurs, principe du Whist-ascenseur.
   Aucune dépendance. Fonctionne dans le navigateur (window.Engine) et sous Node (module.exports). */
(function (root) {
  'use strict';

  /* ---------- Cartes ---------- */
  // id 0 = l'Excuse (vaut 0 ou 22 au choix de son possesseur), id 1..21 = les atouts.
  function roman(n) {
    var t = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']], s = '', i;
    for (i = 0; i < t.length; i++) while (n >= t[i][0]) { s += t[i][1]; n -= t[i][0]; }
    return s;
  }
  function cardName(c) { return c.id === 0 ? 'Excuse' : roman(c.id); }
  function makeDeck() {
    var d = [], i;
    for (i = 0; i <= 21; i++) d.push({ id: i });
    return d;
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  // Atouts par ordre croissant, l'Excuse en dernier.
  function sortCards(cards) {
    return cards.slice().sort(function (a, b) {
      var ka = a.id === 0 ? 99 : a.id, kb = b.id === 0 ? 99 : b.id;
      return ka - kb;
    });
  }

  /* ---------- Donnes : 1, 2, 3 … max … 3, 2, 1 ---------- */
  var MAX_CARDS = { 2: 11, 3: 7, 4: 5, 5: 4 };
  function dealSizes(n) {
    var m = MAX_CARDS[n], a = [], i;
    for (i = 1; i <= m; i++) a.push(i);
    for (i = m - 1; i >= 1; i--) a.push(i);
    return a;
  }

  function zeros(n) { var a = [], i; for (i = 0; i < n; i++) a.push(0); return a; }
  function plural(n, w) { return n + ' ' + w + (n > 1 ? 's' : ''); }

  /* ---------- Partie ---------- */
  // cfg : { mode, names:[...], human:[bool...] }
  function newGame(cfg) {
    var n = cfg.names.length;
    var G = {
      mode: cfg.mode, n: n, names: cfg.names.slice(), human: cfg.human.slice(),
      sizes: dealSizes(n), deal: 0, dealer: Math.floor(Math.random() * n),
      scores: zeros(n), excuseCount: zeros(n), history: [],
      over: false, veil: false
    };
    startDeal(G);
    return G;
  }

  function startDeal(G) {
    var n = G.n, k = G.sizes[G.deal], deck = shuffle(makeDeck()), p;
    G.hands = [];
    for (p = 0; p < n; p++) G.hands.push(sortCards(deck.splice(0, k)));
    G.aside = deck.length;                       // cartes non distribuées
    G.k = k;
    G.first = (G.dealer + 1) % n;                // premier servi : à gauche du donneur
    G.turn = G.first;
    G.bets = []; for (p = 0; p < n; p++) G.bets.push(null);
    G.won = zeros(n);
    G.betCount = 0;
    G.trick = [];
    G.trickNo = 0;
    G.lastTrick = null;
    G.showLast = false;
    G.last = '';
    G.result = null;
    G.phase = 'bet';
    G.hadExcuse = G.hands.map(function (h) { return h.some(function (c) { return c.id === 0; }); });
    // 3e Excuse reçue : 1 point de pénalité, puis le compteur repart de zéro
    G.streakHit = [];
    for (p = 0; p < n; p++) {
      var hit = false;
      if (G.hadExcuse[p]) {
        G.excuseCount[p]++;
        if (G.excuseCount[p] >= 3) { hit = true; G.excuseCount[p] = 0; }
      }
      G.streakHit.push(hit);
    }
  }

  /* ---------- Paris ---------- */
  // Le dernier à parler (le donneur) ne peut pas porter le total des paris au nombre de plis en jeu.
  function forbiddenBet(G) {
    if (G.phase !== 'bet' || G.betCount !== G.n - 1) return -1;
    var s = 0, i;
    for (i = 0; i < G.n; i++) if (G.bets[i] !== null) s += G.bets[i];
    var f = G.k - s;
    return (f >= 0 && f <= G.k) ? f : -1;
  }
  function legalBets(G) {
    var f = forbiddenBet(G), a = [], b;
    for (b = 0; b <= G.k; b++) if (b !== f) a.push(b);
    return a;
  }
  // Retourne null si ok, sinon un message d'erreur.
  function placeBet(G, b) {
    if (G.phase !== 'bet') return 'Ce n\'est pas le moment des paris.';
    if (!(b >= 0 && b <= G.k) || b !== Math.floor(b)) return 'Pari impossible.';
    if (b === forbiddenBet(G)) return 'Le total des paris ne peut pas être égal au nombre de plis.';
    var p = G.turn;
    G.bets[p] = b;
    G.betCount++;
    G.showLast = false;
    G.last = G.names[p] + ' annonce ' + plural(b, 'pli') + '.';
    if (G.betCount === G.n) {
      G.phase = 'play';
      G.turn = G.first;
      G.last = '';
    } else {
      G.turn = (p + 1) % G.n;
    }
    return null;
  }

  /* ---------- Plis ---------- */
  // val : valeur choisie pour l'Excuse (0 ou 22) ; ignorée pour un atout.
  function playCard(G, id, val) {
    if (G.phase !== 'play') return 'Ce n\'est pas le moment de jouer.';
    var p = G.turn, hand = G.hands[p], i, idx = -1;
    for (i = 0; i < hand.length; i++) if (hand[i].id === id) idx = i;
    if (idx < 0) return 'Carte absente de la main.';
    var v = id;
    if (id === 0) {
      if (val !== 0 && val !== 22) return 'L\'Excuse vaut 0 ou 22.';
      v = val;
    }
    hand.splice(idx, 1);
    G.showLast = false;
    G.last = '';
    G.trick.push({ p: p, id: id, val: v });
    if (G.trick.length < G.n) { G.turn = (p + 1) % G.n; return null; }

    // pli complet : la plus forte carte l'emporte (valeurs toutes distinctes)
    var w = G.trick[0];
    G.trick.forEach(function (t) { if (t.val > w.val) w = t; });
    G.won[w.p]++;
    G.lastTrick = { plays: G.trick.slice(), winner: w.p };
    G.showLast = true;
    G.last = G.names[w.p] + ' remporte le pli.';
    G.trick = [];
    G.trickNo++;
    G.turn = w.p;
    if (G.trickNo === G.k) finishDeal(G);
    return null;
  }

  /* ---------- Marque ---------- */
  // Contrat réalisé : 0. Sinon 1 point par pli d'écart, doublé si l'Excuse était dans la main.
  // 3e Excuse reçue au fil de la partie : +1 point de pénalité.
  function finishDeal(G) {
    var res = { deal: G.deal, k: G.k, bets: G.bets.slice(), won: G.won.slice(), pts: [], doubled: [], streak: G.streakHit.slice() };
    var p;
    for (p = 0; p < G.n; p++) {
      var d = Math.abs(G.bets[p] - G.won[p]);
      var dbl = d > 0 && G.hadExcuse[p];
      var pts = dbl ? d * 2 : d;
      if (G.streakHit[p]) pts += 1;
      res.pts.push(pts);
      res.doubled.push(dbl);
      G.scores[p] += pts;
    }
    G.result = res;
    G.history.push(res);
    G.phase = 'dealEnd';
    G.over = G.deal >= G.sizes.length - 1;
  }

  function nextDeal(G) {
    if (G.phase !== 'dealEnd') return;
    if (G.over) { G.phase = 'over'; return; }
    G.deal++;
    G.dealer = (G.dealer + 1) % G.n;
    startDeal(G);
  }

  // Classement : le moins de points gagne. Retourne [{p, score, rank}] trié.
  function ranking(G) {
    var a = [], i;
    for (i = 0; i < G.n; i++) a.push({ p: i, score: G.scores[i] });
    a.sort(function (x, y) { return x.score - y.score || x.p - y.p; });
    var rank = 1;
    a.forEach(function (r, j) {
      if (j > 0 && r.score > a[j - 1].score) rank = j + 1;
      r.rank = rank;
    });
    return a;
  }

  /* ---------- IA ---------- */
  // Estimation grossière du nombre de plis d'une main (utilisée pour les adversaires simulés).
  function estimate(ids, n) {
    var e = 0;
    ids.forEach(function (id) {
      e += id === 0 ? 0.5 : Math.pow((id - 1) / 21, n - 1);
    });
    return e;
  }

  // Politique de jeu. hand : ids ; table : valeurs déjà jouées dans le pli ;
  // needed : plis qu'il reste à prendre pour tenir le contrat ; left : cartes en main ;
  // after : nombre de joueurs encore à jouer après moi dans ce pli. Retourne { id, val }.
  function choose(hand, table, needed, left, after) {
    var normal = [], hasEx = false, i;
    for (i = 0; i < hand.length; i++) { if (hand[i] === 0) hasEx = true; else normal.push(hand[i]); }
    normal.sort(function (a, b) { return a - b; });
    var best = 0;
    for (i = 0; i < table.length; i++) if (table[i] > best) best = table[i];
    var low = normal[0], high = normal[normal.length - 1];
    function nm(id) { return { id: id, val: id }; }
    function ex(v) { return { id: 0, val: v }; }

    if (needed > 0) {                           // il me faut ce pli (ou un des suivants)
      var beating = normal.filter(function (id) { return id > best; });
      if (beating.length) {
        if (after === 0) return nm(beating[0]); // dernier à jouer : la plus petite qui gagne
        if (needed >= left) return nm(high);    // tous les plis restants sont à prendre
        var thr = Math.min(21, best + 2 * after + 1), j;
        for (j = 0; j < beating.length; j++) if (beating[j] >= thr) return nm(beating[j]);
        return nm(high);
      }
      if (hasEx && (needed >= left || !normal.length)) return ex(22);
      return nm(low);
    }
    // contrat déjà rempli (ou dépassé) : il faut perdre ce pli
    if (table.length) {
      var safe = normal.filter(function (id) { return id < best; });
      if (safe.length) return nm(safe[safe.length - 1]);
      if (hasEx) return ex(0);
      return nm(low);
    }
    if (normal.length) return nm(low);
    return ex(0);
  }

  // Joue une manche entière entre mains simulées. Sièges dans l'ordre à partir de l'entameur.
  function simRound(hands, bets, n, me) {
    var won = zeros(n), leader = 0, k = hands[0].length, t, i, s;
    for (t = 0; t < k; t++) {
      var table = [], seats = [];
      for (i = 0; i < n; i++) {
        s = (leader + i) % n;
        var h = hands[s];
        var c = choose(h, table, bets[s] - won[s], h.length, n - 1 - i);
        h.splice(h.indexOf(c.id), 1);
        table.push(c.val); seats.push(s);
      }
      var wi = 0;
      for (i = 1; i < n; i++) if (table[i] > table[wi]) wi = i;
      leader = seats[wi];
      won[leader]++;
    }
    return won[me];
  }

  // Pari de l'ordinateur : on tire des mains adverses au hasard et on retient le pari
  // qui a le plus de chances d'être tenu (en respectant la contrainte du donneur).
  function botBet(G, p, samples) {
    var k = G.k, n = G.n, forb = forbiddenBet(G);
    var hand = G.hands[p].map(function (c) { return c.id; });
    var pos = (p - G.first + n) % n;
    var unseen = [], id, s, i;
    for (id = 0; id <= 21; id++) if (hand.indexOf(id) < 0) unseen.push(id);
    var cands = [], b;
    for (b = 0; b <= k; b++) if (b !== forb) cands.push(b);
    var hits = {};
    cands.forEach(function (c) { hits[c] = 0; });
    var S = samples || 150;
    for (s = 0; s < S; s++) {
      var pool = shuffle(unseen.slice()), hs = [], idx = 0, bets = [];
      for (i = 0; i < n; i++) {
        if (i === pos) hs.push(hand.slice());
        else { hs.push(pool.slice(idx, idx + k)); idx += k; }
      }
      for (i = 0; i < n; i++) {
        var known = G.bets[(G.first + i) % n];
        bets.push(i === pos ? 0 : (known !== null ? known : Math.min(k, Math.round(estimate(hs[i], n)))));
      }
      cands.forEach(function (c) {
        bets[pos] = c;
        var hh = hs.map(function (a) { return a.slice(); });
        if (simRound(hh, bets, n, pos) === c) hits[c]++;
      });
    }
    var est = estimate(hand, n), bestB = cands[0], bestH = -1;
    cands.forEach(function (c) {
      if (hits[c] > bestH || (hits[c] === bestH && Math.abs(c - est) < Math.abs(bestB - est))) { bestH = hits[c]; bestB = c; }
    });
    return bestB;
  }

  // Carte conseillée / jouée par l'ordinateur pour le joueur p. Retourne { id, val }.
  function botPlay(G, p) {
    var hand = G.hands[p].map(function (c) { return c.id; });
    var table = G.trick.map(function (t) { return t.val; });
    return choose(hand, table, G.bets[p] - G.won[p], hand.length, G.n - 1 - G.trick.length);
  }

  var API = {
    roman: roman, cardName: cardName, makeDeck: makeDeck, shuffle: shuffle, sortCards: sortCards,
    dealSizes: dealSizes, newGame: newGame, startDeal: startDeal, forbiddenBet: forbiddenBet,
    legalBets: legalBets, placeBet: placeBet, playCard: playCard, nextDeal: nextDeal,
    ranking: ranking, botBet: botBet, botPlay: botPlay, choose: choose, plural: plural
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.Engine = API;
})(typeof window !== 'undefined' ? window : this);
