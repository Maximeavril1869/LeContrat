/* Le Contrat — interface. Tout est local : la partie est sauvegardée dans le navigateur (localStorage).
   Trois modes : contre l'ordinateur ('solo'), à plusieurs en se passant l'appareil ('passe'),
   à deux face à face sur un iPad posé à plat ('duo'). */
(function () {
  'use strict';
  var E = window.Engine;
  var SAVE_KEY = 'lecontrat_partie_v1', PREF_KEY = 'lecontrat_prefs_v1';
  var BOT_NAMES = ['Camille', 'Hugo', 'Léa', 'Noé'];   // jusqu'à 4 adversaires (5 joueurs)

  var G = null;               // état de la partie (sérialisable)
  var screen = 'home';        // 'home' ou 'play'
  var selCard = null;         // id de la carte sélectionnée
  var selBet = null;          // pari sélectionné
  var running = false;        // boucle des adversaires en cours
  var roundOpen = false;      // fenêtre de résultats ouverte
  var reveal = [false, false];// mode face à face : main visible ou cachée par siège
  var pendingEx = false;      // choix 0/22 de l'Excuse en attente
  var hintBet = { key: null, val: null };
  var prefs = { aide: true, opp: 2, mode: 'solo', np: 3, names: ['Joueur 1', 'Joueur 2', 'Joueur 3', 'Joueur 4', 'Joueur 5'] };

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mode() { return (G && G.mode) || prefs.mode; }
  function active() { return !!G && (G.phase === 'bet' || G.phase === 'play'); }

  /* ---------- Sauvegarde ---------- */
  function save() { try { if (G) localStorage.setItem(SAVE_KEY, JSON.stringify(G)); } catch (e) {} }
  function loadSave() {
    try {
      var s = localStorage.getItem(SAVE_KEY), g = s ? JSON.parse(s) : null;
      return g && g.hands && g.sizes && g.phase !== 'over' ? g : null;
    } catch (e) { return null; }
  }
  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem(PREF_KEY));
      if (p) {
        prefs.aide = p.aide !== false;
        prefs.opp = Math.min(4, Math.max(1, p.opp || 2));
        prefs.np = Math.min(5, Math.max(2, p.np || 3));
        if (p.mode === 'passe' || p.mode === 'duo') prefs.mode = p.mode;
        if (p.names && p.names.length) for (var i = 0; i < 5; i++) if (p.names[i]) prefs.names[i] = p.names[i];
      }
    } catch (e) {}
  }

  /* ---------- Cartes en HTML ---------- */
  function cardHTML(c, o) {
    o = o || {};
    var cls = ['card'];
    cls.push(c.id === 0 ? 'exc' : c.id <= 7 ? 't1' : c.id <= 14 ? 't2' : 't3');
    if (o.sel) cls.push('sel');
    if (o.sug) cls.push('sug');
    if (o.dual) cls.push('dual');
    var inner;
    if (c.id === 0) {
      // l'Excuse jouée affiche la valeur choisie (0 ou 22) au centre
      inner = '<div class="tl">EXC.</div>' + (o.dual ? '<div class="tl br">EXC.</div>' : '') +
              '<div class="num">' + (o.val != null ? o.val : '✦') + '</div>';
    } else {
      var r = E.roman(c.id);
      inner = '<div class="tl">' + r + '</div>' + (o.dual ? '<div class="tl br">' + r + '</div>' : '') +
              '<div class="num">' + c.id + '</div>';
    }
    return '<div class="' + cls.join(' ') + '" data-id="' + c.id + '">' + inner + '</div>';
  }

  /* ---------- Qui regarde ? ---------- */
  function viewer() {
    if (mode() === 'passe') return G.turn;
    for (var i = 0; i < G.n; i++) if (G.human[i]) return i;
    return 0;
  }
  function isTurnOf(p) { return active() && G.turn === p && G.human[p]; }
  function veilOn() { return mode() === 'passe' && !!G.veil && active(); }

  /* ---------- Éléments communs ---------- */
  function msgFor(p) {
    if (!active()) return { txt: G.last || 'Donne terminée', alert: false };
    var pre = G.last ? G.last + ' ' : '';
    if (isTurnOf(p)) {
      if (G.phase === 'bet') {
        var f = E.forbiddenBet(G);
        return { txt: pre + 'À toi d\'annoncer.' + (f >= 0 ? ' Interdit : ' + f + ' (le total ne peut pas égaler ' + G.k + ').' : ''), alert: f >= 0 };
      }
      return { txt: pre + (G.trick.length ? 'À toi de jouer.' : 'Tu entames.'), alert: false };
    }
    return { txt: pre + 'Au tour de ' + G.names[G.turn] + (G.phase === 'bet' ? ' d\'annoncer…' : '…'), alert: false };
  }

  function trickHTML(dual) {
    var plays = null, winner = -1;
    if (G.trick.length) plays = G.trick;
    else if (G.showLast && G.lastTrick) { plays = G.lastTrick.plays; winner = G.lastTrick.winner; }
    if (!plays) return '<div class="trickempty">' + (G.phase === 'bet' ? 'Annonces en cours…' : 'Aucune carte jouée') + '</div>';
    return plays.map(function (t) {
      return '<div class="tk' + (t.p === winner ? ' win' : '') + '">' +
             cardHTML({ id: t.id }, { dual: dual, val: t.id === 0 ? t.val : null }) +
             '<span class="who">' + esc(G.names[t.p]) + '</span></div>';
    }).join('');
  }

  function suggestedBet(p) {
    var key = G.deal + ':' + p + ':' + G.betCount;
    if (hintBet.key !== key) { hintBet.key = key; hintBet.val = E.botBet(G, p, 120); }
    return hintBet.val;
  }

  function renderBets(p, el, hidden) {
    var show = G.phase === 'bet' && isTurnOf(p) && !hidden;
    el.hidden = !show;
    if (!show) return;
    var forb = E.forbiddenBet(G), sug = prefs.aide ? suggestedBet(p) : -1, h = '', b;
    if (selBet === forb) selBet = null;
    for (b = 0; b <= G.k; b++) {
      h += '<button class="bb' + (b === selBet ? ' on' : '') + (b === sug ? ' sug' : '') + '" data-b="' + b + '"' + (b === forb ? ' disabled' : '') + '>' + b + '</button>';
    }
    el.innerHTML = h;
  }

  function needText(p) {
    var need = G.bets[p] - G.won[p];
    if (need > 0) return 'Il te reste <b>' + E.plural(need, 'pli') + '</b> à prendre';
    if (need === 0) return 'Contrat rempli pour l\'instant : <b>évite de prendre</b> les plis';
    return 'Contrat dépassé de <b>' + E.plural(-need, 'pli') + '</b>';
  }

  // Remplit la main du joueur p. hidden = cartes face cachée.
  function renderHandInto(p, handEl, infoEl, hidden) {
    var hand = G.hands[p], h = '', i;
    if (hidden) {
      for (i = 0; i < hand.length; i++) h += '<div class="cardback"></div>';
      handEl.innerHTML = h;
      infoEl.textContent = 'Main cachée';
      return;
    }
    var canPlay = isTurnOf(p) && G.phase === 'play', sug = null, info = '';
    if (canPlay) {
      var ok = false;
      hand.forEach(function (c) { if (c.id === selCard) ok = true; });
      if (!ok) selCard = null;
      if (prefs.aide) sug = E.botPlay(G, p);
    }
    hand.forEach(function (c) { h += cardHTML(c, { sel: canPlay && c.id === selCard, sug: !!sug && c.id === sug.id }); });
    handEl.innerHTML = h;

    if (G.phase === 'bet') {
      if (isTurnOf(p)) info = 'Combien de plis vas-tu faire ?' + (prefs.aide ? ' Conseil : <b>' + suggestedBet(p) + '</b>' : '');
    } else if (G.phase === 'play' && G.bets[p] !== null) {
      info = 'Pari <b>' + G.bets[p] + '</b> · pris <b>' + G.won[p] + '</b> — ' + needText(p);
      if (sug) info += '<br>Conseil : ' + (sug.id === 0 ? 'Excuse (' + sug.val + ')' : E.roman(sug.id));
    }
    infoEl.innerHTML = info;
  }

  function fillAction(p, btn, hidden) {
    btn.disabled = true; btn.textContent = '…';
    if (G.phase === 'dealEnd') { btn.textContent = 'Voir les résultats'; btn.disabled = false; return; }
    if (!active()) return;
    if (!isTurnOf(p)) { btn.textContent = 'Au tour de ' + G.names[G.turn] + '…'; return; }
    if (hidden) { btn.textContent = 'Affiche ta main'; return; }
    if (G.phase === 'bet') {
      if (selBet === null) btn.textContent = 'Choisis ton pari';
      else { btn.textContent = 'Annoncer ' + E.plural(selBet, 'pli'); btn.disabled = false; }
      return;
    }
    if (selCard === null) { btn.textContent = 'Choisis une carte'; return; }
    btn.textContent = selCard === 0 ? 'Jouer l\'Excuse…' : 'Jouer ' + E.roman(selCard);
    btn.disabled = false;
  }

  function statusLine(p) {
    var s = G.scores[p] + ' pt' + (G.scores[p] > 1 ? 's' : '');
    if (G.bets[p] !== null) s += ' · pari ' + G.bets[p] + ' · pris ' + G.won[p];
    return s;
  }

  /* ---------- Affichage : ordinateur / on se passe l'appareil ---------- */
  function renderMain() {
    var v = viewer();
    $('roundTitle').textContent = 'Donne ' + (G.deal + 1) + ' / ' + G.sizes.length;
    $('roundSub').textContent = E.plural(G.k, 'carte') + (G.aside ? ' · ' + E.plural(G.aside, 'écartée') : '') + ' · ' +
      (mode() === 'solo' ? 'toi' : G.names[v]) + ' : ' + statusLine(v);
    var h = '', p;
    for (p = 0; p < G.n; p++) {
      if (p === v) continue;
      var n = G.hands[p].length, fan = '', k;
      for (k = 0; k < Math.min(n, 12); k++) fan += '<i></i>';
      var bt = G.bets[p] === null ? 'Pari : ?' : 'Pari <b>' + G.bets[p] + '</b> · pris <b>' + G.won[p] + '</b>';
      h += '<div class="opp' + (G.turn === p && active() ? ' turn' : '') + '">' +
           '<div class="nm"><span>' + esc(G.names[p]) + '</span>' + (G.dealer === p ? '<span class="tag">D</span>' : '') + '</div>' +
           '<div class="sc">' + G.scores[p] + ' pt' + (G.scores[p] > 1 ? 's' : '') + '</div><div class="bt">' + bt + '</div><div class="fan">' + fan + '</div></div>';
    }
    $('opps').innerHTML = h;
    $('trick').innerHTML = trickHTML(false);
    var m = msgFor(v);
    $('msg').textContent = m.txt; $('msg').className = 'msg' + (m.alert ? ' alert' : '');
    var vl = veilOn();
    renderBets(v, $('betbar'), vl);
    renderHandInto(v, $('hand'), $('handInfo'), vl);
    fillAction(v, $('btnAction'), false);
    $('veil').hidden = !vl;
    if (vl) {
      $('veilTitle').textContent = 'À ' + G.names[G.turn] + (G.phase === 'bet' ? ' d\'annoncer' : ' de jouer');
      $('veilLast').textContent = G.last || ('Donne ' + (G.deal + 1) + ' / ' + G.sizes.length);
      $('btnVeil').textContent = 'Je suis ' + G.names[G.turn];
    }
  }

  /* ---------- Affichage : face à face ---------- */
  var seatEls = null;
  function initSeats() {
    seatEls = [0, 1].map(function (p) {
      var r = $('seat' + p);
      return { root: r, head: r.querySelector('.seathead'), msg: r.querySelector('.msg'), bets: r.querySelector('.betbar'),
               info: r.querySelector('.handinfo'), hand: r.querySelector('.hand'),
               reveal: r.querySelector('.js-reveal'), action: r.querySelector('.js-action') };
    });
  }
  function renderSeat(p) {
    var el = seatEls[p], hidden = !reveal[p];
    el.root.classList.toggle('turn', active() && G.turn === p);
    el.head.innerHTML = '<div class="who"><b>' + esc(G.names[p]) + (G.dealer === p ? ' <span class="tag">D</span>' : '') + '</b><span>' + statusLine(p) + '</span></div>' +
      '<div class="rd">Donne ' + (G.deal + 1) + ' / ' + G.sizes.length + '<br>' + E.plural(G.k, 'carte') + '</div>';
    var m = msgFor(p);
    el.msg.textContent = m.txt; el.msg.className = 'msg' + (m.alert ? ' alert' : '');
    renderBets(p, el.bets, hidden);
    renderHandInto(p, el.hand, el.info, hidden);
    el.reveal.textContent = hidden ? 'Afficher ma main' : 'Masquer ma main';
    fillAction(p, el.action, hidden && isTurnOf(p));
  }
  function renderDuo() {
    $('duoTrick').innerHTML = trickHTML(true);
    renderSeat(0); renderSeat(1);
  }

  /* ---------- Écrans ---------- */
  function showScreen() {
    $('home').hidden = screen !== 'home';
    $('game').hidden = !(screen === 'play' && G && mode() !== 'duo');
    $('duo').hidden = !(screen === 'play' && G && mode() === 'duo');
    if (screen !== 'play') $('veil').hidden = true;
  }
  function render() {
    if (!G || screen !== 'play') { showScreen(); return; }
    showScreen();
    if (mode() === 'duo') renderDuo(); else renderMain();
    save();
  }

  /* ---------- Actions du joueur ---------- */
  function afterHuman() {
    reveal = [false, false];
    selCard = null; selBet = null;
    if (mode() === 'passe' && active()) G.veil = true;
    render();
    advance();
  }
  function doBet(b) {
    if (!isTurnOf(G.turn) || G.phase !== 'bet') return;
    if (E.placeBet(G, b) === null) afterHuman();
  }
  function doPlay(id, val) {
    if (!isTurnOf(G.turn) || G.phase !== 'play') return;
    if (E.playCard(G, id, val) === null) afterHuman();
  }
  function onAction(p) {
    if (!G) return;
    if (G.phase === 'dealEnd') { if (!roundOpen) showRound(); return; }
    if (!isTurnOf(p)) return;
    if (G.phase === 'bet') { if (selBet !== null) doBet(selBet); return; }
    if (selCard === null) return;
    if (selCard === 0) { pendingEx = true; $('dlgExcuse').showModal(); return; }
    doPlay(selCard, selCard);
  }
  function onHandClick(p, e) {
    var c = e.target.closest ? e.target.closest('.card') : null;
    if (!c || !isTurnOf(p) || G.phase !== 'play' || (mode() === 'duo' && !reveal[p])) return;
    var id = +c.getAttribute('data-id');
    selCard = selCard === id ? null : id;
    render();
  }
  function onBetClick(p, e) {
    var b = e.target.closest ? e.target.closest('.bb') : null;
    if (!b || b.disabled || !isTurnOf(p) || G.phase !== 'bet') return;
    selBet = +b.getAttribute('data-b');
    render();
  }

  /* ---------- Boucle des adversaires ---------- */
  async function advance() {
    if (running || !G) return;
    running = true;
    var g = G;
    try {
      while (G === g && active() && !G.human[G.turn]) {
        render();
        await sleep(G.showLast ? 1500 : 800);
        if (G !== g || !active() || G.human[G.turn]) break;
        var p = G.turn;
        if (G.phase === 'bet') {
          E.placeBet(G, E.botBet(G, p));
        } else {
          var c = E.botPlay(G, p);
          E.playCard(G, c.id, c.val);
        }
        if (mode() === 'passe') G.veil = true;
        save();
      }
    } finally { running = false; }
    if (G !== g) return;
    render();
    if (G.phase === 'dealEnd' && !roundOpen) {
      await sleep(1200);
      if (G === g && G.phase === 'dealEnd' && !roundOpen) showRound();
    }
  }

  /* ---------- Résultats de donne et fin de partie ---------- */
  function openRound(html) {
    roundOpen = true;
    if (mode() === 'duo') {
      $('rpTop').innerHTML = html; $('rpBottom').innerHTML = html; $('duoRound').hidden = false;
    } else {
      $('roundBody').innerHTML = html;
      if (!$('dlgRound').open) $('dlgRound').showModal();
    }
  }
  function closeRound() {
    roundOpen = false;
    if ($('dlgRound').open) $('dlgRound').close();
    $('duoRound').hidden = true;
  }
  function showRound() {
    var r = G.result;
    if (!r) return;
    var h = '<h2 class="serif">Donne ' + (r.deal + 1) + ' / ' + G.sizes.length + '</h2>' +
      '<table class="sc' + (G.n > 3 ? ' many' : '') + '"><tr><th>Joueur</th><th>Pari</th><th>Pris</th><th>Pts</th><th>Total</th></tr>';
    var anyD = false, anyS = false, p;
    for (p = 0; p < G.n; p++) {
      var pts = r.pts[p], cell = '<span class="' + (pts === 0 ? 'ok' : 'bad') + '">' + pts + '</span>';
      if (r.doubled[p]) { cell += ' <small>×2</small>'; anyD = true; }
      if (r.streak[p]) { cell += ' <small>+1</small>'; anyS = true; }
      h += '<tr><td>' + esc(G.names[p]) + '</td><td>' + r.bets[p] + '</td><td>' + r.won[p] + '</td><td>' + cell + '</td><td><b>' + G.scores[p] + '</b></td></tr>';
    }
    h += '</table>';
    if (anyD) h += '<p class="note">×2 : contrat manqué avec l\'Excuse en main.</p>';
    if (anyS) h += '<p class="note">+1 : Excuse servie pour la 3<sup>e</sup> fois.</p>';
    h += '<button class="btn gold" data-act="next">' + (G.over ? 'Voir le classement' : 'Donne suivante') + '</button>';
    openRound(h);
  }
  function showEnd() {
    var rk = E.ranking(G), medals = ['🥇', '🥈', '🥉'];
    var h = '<h2 class="serif">Fin de la partie</h2>';
    rk.forEach(function (r) {
      h += '<div class="rank' + (r.rank === 1 ? ' win' : '') + '"><span class="pos">' + (medals[r.rank - 1] || r.rank) + '</span>' +
           '<span class="n">' + esc(G.names[r.p]) + '</span><span>' + r.score + ' pt' + (r.score > 1 ? 's' : '') + '</span></div>';
    });
    h += '<button class="btn gold" data-act="again">Rejouer</button><button class="btn ghost" data-act="home">Accueil</button>';
    clearSave();
    openRound(h);
  }
  function onAct(act) {
    if (!G) return;
    if (act === 'next') {
      E.nextDeal(G);
      if (G.phase === 'over') { showEnd(); return; }
      closeRound();
      selCard = null; selBet = null; reveal = [false, false];
      if (mode() === 'passe') G.veil = true;
      render();
      advance();
    } else if (act === 'again') {
      closeRound(); startGame();
    } else if (act === 'home') {
      closeRound(); G = null; screen = 'home'; updateHome(); showScreen();
    }
  }

  function showScores() {
    var h = '<table class="sc' + (G.n > 3 ? ' many' : '') + '"><tr><th>Donne</th>';
    var p;
    for (p = 0; p < G.n; p++) h += '<th>' + esc(G.names[p]) + '</th>';
    h += '</tr>';
    G.history.forEach(function (r) {
      h += '<tr><td>' + (r.deal + 1) + ' <small>(' + r.k + ')</small></td>';
      for (p = 0; p < G.n; p++) h += '<td class="' + (r.pts[p] === 0 ? 'ok' : '') + '">' + r.pts[p] + '</td>';
      h += '</tr>';
    });
    var best = Math.min.apply(null, G.scores);
    h += '<tr class="tot"><td>Total</td>';
    for (p = 0; p < G.n; p++) h += '<td class="' + (G.scores[p] === best ? 'best' : '') + '">' + G.scores[p] + '</td>';
    h += '</tr></table>';
    if (!G.history.length) h = '<p>Aucune donne terminée pour l\'instant.</p>';
    $('scoresBody').innerHTML = h;
    $('dlgScores').showModal();
  }

  /* ---------- Accueil ---------- */
  function updateHome() {
    Array.prototype.forEach.call($('segMode').children, function (b) { b.classList.toggle('on', b.getAttribute('data-m') === prefs.mode); });
    Array.prototype.forEach.call($('segOpp').children, function (b) { b.classList.toggle('on', +b.getAttribute('data-n') === prefs.opp); });
    Array.prototype.forEach.call($('segPlayers').children, function (b) { b.classList.toggle('on', +b.getAttribute('data-n') === prefs.np); });
    $('optSolo').hidden = prefs.mode !== 'solo';
    $('optPasse').hidden = prefs.mode !== 'passe';
    $('optNames').hidden = prefs.mode === 'solo';
    var cnt = prefs.mode === 'duo' ? 2 : prefs.np, i;
    for (i = 1; i <= 5; i++) {
      var inp = $('n' + i);
      inp.hidden = i > cnt;
      if (document.activeElement !== inp) inp.value = prefs.names[i - 1];
    }
    $('swAide').classList.toggle('on', prefs.aide);
    $('swAide2').classList.toggle('on', prefs.aide);
    $('btnResume').hidden = !loadSave();
  }

  function startGame() {
    var names, human, i;
    if (prefs.mode === 'solo') {
      names = ['Toi'].concat(BOT_NAMES.slice(0, prefs.opp));
      human = names.map(function (_, j) { return j === 0; });
    } else {
      var cnt = prefs.mode === 'duo' ? 2 : prefs.np;
      names = [];
      for (i = 0; i < cnt; i++) {
        var v = ($('n' + (i + 1)).value || '').trim() || ('Joueur ' + (i + 1));
        prefs.names[i] = v;
        names.push(v);
      }
      names = names.map(function (nm, j) {
        return names.indexOf(nm) !== j ? nm + ' ' + (j + 1) : nm;
      });
      human = names.map(function () { return true; });
    }
    savePrefs();
    G = E.newGame({ mode: prefs.mode, names: names, human: human });
    selCard = null; selBet = null; reveal = [false, false]; roundOpen = false;
    G.veil = prefs.mode === 'passe';
    screen = 'play';
    save();
    render();
    advance();
  }
  function resumeGame() {
    var g = loadSave();
    if (!g) return;
    G = g; prefs.mode = G.mode;
    selCard = null; selBet = null; reveal = [false, false]; roundOpen = false;
    if (mode() === 'passe') G.veil = true;
    screen = 'play';
    render();
    if (G.phase === 'dealEnd') showRound(); else advance();
  }

  function toggleAide() {
    prefs.aide = !prefs.aide; savePrefs(); updateHome(); render();
  }

  /* ---------- Branchements ---------- */
  function init() {
    loadPrefs();
    initSeats();
    updateHome();

    $('segMode').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      prefs.mode = b.getAttribute('data-m'); savePrefs(); updateHome();
    });
    $('segOpp').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      prefs.opp = +b.getAttribute('data-n'); savePrefs(); updateHome();
    });
    $('segPlayers').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      prefs.np = +b.getAttribute('data-n'); savePrefs(); updateHome();
    });
    $('swAide').addEventListener('click', toggleAide);
    $('swAide2').addEventListener('click', toggleAide);
    $('btnNew').addEventListener('click', startGame);
    $('btnResume').addEventListener('click', resumeGame);
    $('btnRules').addEventListener('click', function () { $('dlgRules').showModal(); });

    $('btnScores').addEventListener('click', function () { if (G) showScores(); });
    $('btnMenu').addEventListener('click', function () { $('dlgMenu').showModal(); });
    $('btnMenuDuo').addEventListener('click', function () { $('dlgMenu').showModal(); });
    $('btnMenuRules').addEventListener('click', function () { $('dlgMenu').close(); $('dlgRules').showModal(); });
    $('btnQuit').addEventListener('click', function () {
      $('dlgMenu').close(); save(); screen = 'home'; updateHome(); showScreen();
    });

    $('hand').addEventListener('click', function (e) { onHandClick(G ? viewer() : 0, e); });
    $('betbar').addEventListener('click', function (e) { onBetClick(G ? viewer() : 0, e); });
    $('btnAction').addEventListener('click', function () { if (G) onAction(viewer()); });
    $('btnVeil').addEventListener('click', function () { if (G) { G.veil = false; render(); } });

    [0, 1].forEach(function (p) {
      var el = seatEls[p];
      el.hand.addEventListener('click', function (e) { onHandClick(p, e); });
      el.bets.addEventListener('click', function (e) { onBetClick(p, e); });
      el.action.addEventListener('click', function () { onAction(p); });
      el.reveal.addEventListener('click', function () { reveal[p] = !reveal[p]; render(); });
    });

    $('dlgExcuse').addEventListener('click', function (e) {
      var b = e.target.closest('[data-ex]');
      if (b) {
        $('dlgExcuse').close();
        if (pendingEx) { pendingEx = false; doPlay(0, +b.getAttribute('data-ex')); }
      }
    });
    $('dlgExcuse').addEventListener('close', function () { pendingEx = false; });
    Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (d) {
      d.addEventListener('click', function (e) {
        if (e.target.hasAttribute && e.target.hasAttribute('data-close')) d.close();
      });
    });
    $('dlgRound').addEventListener('cancel', function (e) { e.preventDefault(); });
    $('dlgRound').addEventListener('click', function (e) { var b = e.target.closest('[data-act]'); if (b) onAct(b.getAttribute('data-act')); });
    $('duoRound').addEventListener('click', function (e) { var b = e.target.closest('[data-act]'); if (b) onAct(b.getAttribute('data-act')); });

    [1, 2, 3, 4, 5].forEach(function (i) {
      $('n' + i).addEventListener('input', function () { prefs.names[i - 1] = $('n' + i).value; savePrefs(); });
    });

    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('sw.js'); } catch (e) {}
    }
    showScreen();
  }

  init();
})();
