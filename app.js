/* Le Contrat — interface. Deux modes : contre l'ordinateur ('solo', sauvegardé dans le navigateur)
   et en ligne ('online') : 2 joueurs au plus, chacun sur son appareil, les ordinateurs complètent la table.
   En ligne, l'état complet de la partie vit dans une ligne Supabase ; chaque appareil n'affiche que sa propre main.
   Un « plateau » (iPad en affichage seul) peut montrer la table commune : le téléphone la masque alors. */
(function () {
  'use strict';
  var E = window.Engine, EL = window.EnLigne;
  var SAVE_KEY = 'lecontrat_partie_v1', PREF_KEY = 'lecontrat_prefs_v1', OKEY = 'lecontrat_online_v1', APP_VERSION = '4';
  var BOT_NAMES = ['Camille', 'Hugo', 'Léa', 'Noé'];   // jusqu'à 4 adversaires (5 joueurs)

  var G = null;               // état de la partie (sérialisable)
  var ONL = null;             // partie en ligne : { id, me, version, dirty, pushing, status, watch, retry, plat }
  var PL = null;              // plateau ouvert sur cet appareil : { id, version, watch, rowId, rowVer, timer, t2, busy }
  var screen = 'home';        // 'home' ou 'play'
  var selCard = null;         // id de la carte sélectionnée
  var selBet = null;          // pari sélectionné
  var running = false;        // boucle des adversaires en cours
  var roundOpen = false;      // fenêtre de résultats ouverte
  var roundTimer = null;      // ouverture différée des résultats de donne
  var pendingEx = false;      // choix 0/22 de l'Excuse en attente
  var hintBet = { key: null, val: null };
  var prefs = { aide: true, opp: 2, oppOl: 2, mode: 'solo', n1: '' };

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function mode() { return (G && G.mode) || prefs.mode; }
  function active() { return !!G && (G.phase === 'bet' || G.phase === 'play'); }
  function delay(ms) { return window.BOT_DELAY != null ? window.BOT_DELAY : ms; }

  /* ---------- Sauvegarde (contre l'ordinateur seulement : une partie en ligne vit sur le serveur) ---------- */
  function save() {
    if (G && G.mode === 'online') { if (ONL) { ONL.dirty = true; pushState(); } return; }
    try { if (G) localStorage.setItem(SAVE_KEY, JSON.stringify(G)); } catch (e) {}
  }
  function loadSave() {
    try {
      var s = localStorage.getItem(SAVE_KEY), g = s ? JSON.parse(s) : null;
      return g && g.mode === 'solo' && g.hands && g.sizes && g.phase !== 'over' ? g : null;
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
        prefs.oppOl = Math.min(3, Math.max(0, p.oppOl != null ? p.oppOl : 2));
        if (p.mode === 'online') prefs.mode = 'online';   // les anciens modes « on se passe l'appareil » et « face à face » n'existent plus
        if (typeof p.n1 === 'string') prefs.n1 = p.n1;
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
    var inner;
    if (c.id === 0) {
      // l'Excuse jouée affiche la valeur choisie (0 ou 22) au centre
      inner = '<div class="tl">EXC.</div><div class="num">' + (o.val != null ? o.val : '✦') + '</div>';
    } else {
      inner = '<div class="tl">' + E.roman(c.id) + '</div><div class="num">' + c.id + '</div>';
    }
    return '<div class="' + cls.join(' ') + '" data-id="' + c.id + '">' + inner + '</div>';
  }

  /* ---------- Qui regarde ? ---------- */
  function viewer() { return mode() === 'online' ? (ONL ? ONL.me : 0) : 0; }
  function isTurnOf(p) { return active() && G.turn === p && G.human[p] && (mode() !== 'online' || p === viewer()); }
  function noTable() { return mode() === 'online' && !!ONL && !!ONL.plat && ONL.plat.present && !ONL.plat.override; }

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

  function trickHTML() {
    var plays = null, winner = -1;
    if (G.trick.length) plays = G.trick;
    else if (G.showLast && G.lastTrick) { plays = G.lastTrick.plays; winner = G.lastTrick.winner; }
    if (!plays) return '<div class="trickempty">' + (G.phase === 'bet' ? 'Annonces en cours…' : 'Aucune carte jouée') + '</div>';
    return plays.map(function (t) {
      return '<div class="tk' + (t.p === winner ? ' win' : '') + '">' +
             cardHTML({ id: t.id }, { val: t.id === 0 ? t.val : null }) +
             '<span class="who">' + esc(G.names[t.p]) + '</span></div>';
    }).join('');
  }

  function suggestedBet(p) {
    var key = G.deal + ':' + p + ':' + G.betCount;
    if (hintBet.key !== key) { hintBet.key = key; hintBet.val = E.botBet(G, p, 120); }
    return hintBet.val;
  }

  function renderBets(p, el) {
    var show = G.phase === 'bet' && isTurnOf(p);
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

  function renderHandInto(p, handEl, infoEl) {
    var hand = G.hands[p], h = '';
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

  function fillAction(p, btn) {
    btn.disabled = true; btn.textContent = '…';
    if (G.phase === 'dealEnd') { btn.textContent = 'Voir les résultats'; btn.disabled = false; return; }
    if (!active()) return;
    if (!isTurnOf(p)) { btn.textContent = 'Au tour de ' + G.names[G.turn] + '…'; return; }
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

  // Un joueur vu de l'extérieur : nom, score, pari, éventail de cartes (jamais les cartes elles-mêmes)
  function seatHTML(p, big) {
    var n = G.hands[p].length, fan = '', k;
    for (k = 0; k < Math.min(n, 12); k++) fan += '<i></i>';
    var bt = G.bets[p] === null ? 'Pari : ?' : 'Pari <b>' + G.bets[p] + '</b> · pris <b>' + G.won[p] + '</b>';
    return '<div class="opp' + (G.turn === p && active() ? ' turn' : '') + '">' +
           '<div class="nm"><span>' + esc(G.names[p]) + '</span>' + (G.dealer === p ? '<span class="tag">D</span>' : '') + '</div>' +
           '<div class="sc">' + G.scores[p] + ' pt' + (G.scores[p] > 1 ? 's' : '') + '</div><div class="bt">' + bt + '</div><div class="fan">' + fan + '</div></div>';
  }

  /* ---------- Affichage de la partie ---------- */
  function renderMain() {
    var v = viewer(), nt = noTable(), plOn = !!(ONL && ONL.plat && ONL.plat.present && mode() === 'online');
    $('game').classList.toggle('notable', nt);
    $('btnTable').hidden = !plOn;
    $('btnTable').textContent = nt ? 'Afficher la table' : 'Masquer la table';
    $('roundTitle').textContent = 'Donne ' + (G.deal + 1) + ' / ' + G.sizes.length;
    $('roundSub').textContent = E.plural(G.k, 'carte') + (G.aside ? ' · ' + E.plural(G.aside, 'écartée') : '') + ' · ' +
      (mode() === 'solo' ? 'toi' : G.names[v]) + ' : ' + statusLine(v);
    var h = '', p;
    for (p = 0; p < G.n; p++) if (p !== v) h += seatHTML(p);
    $('opps').innerHTML = h;
    $('trick').innerHTML = trickHTML();
    var m = msgFor(v);
    $('msg').textContent = m.txt; $('msg').className = 'msg' + (m.alert ? ' alert' : '');
    renderBets(v, $('betbar'));
    renderHandInto(v, $('hand'), $('handInfo'));
    fillAction(v, $('btnAction'));
  }

  /* ---------- Écrans ---------- */
  function showScreen() {
    $('home').hidden = screen !== 'home';
    $('game').hidden = !(screen === 'play' && G);
    $('plateau').hidden = !PL;
    if (PL) { $('home').hidden = true; $('game').hidden = true; }
  }
  function render() {
    if (!G || screen !== 'play') { showScreen(); return; }
    showScreen();
    renderMain();
    scheduleRound();
  }

  /* ---------- Actions du joueur ---------- */
  function afterHuman() {
    selCard = null; selBet = null;
    save();
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
  function onAction() {
    if (!G) return;
    var p = viewer();
    if (G.phase === 'dealEnd') { if (!roundOpen) showRound(); return; }
    if (!isTurnOf(p)) return;
    if (G.phase === 'bet') { if (selBet !== null) doBet(selBet); return; }
    if (selCard === null) return;
    if (selCard === 0) { pendingEx = true; $('dlgExcuse').showModal(); return; }
    doPlay(selCard, selCard);
  }
  function onHandClick(e) {
    var c = e.target.closest ? e.target.closest('.card') : null;
    if (!c || !G || !isTurnOf(viewer()) || G.phase !== 'play') return;
    var id = +c.getAttribute('data-id');
    selCard = selCard === id ? null : id;
    render();
  }
  function onBetClick(e) {
    var b = e.target.closest ? e.target.closest('.bb') : null;
    if (!b || b.disabled || !G || !isTurnOf(viewer()) || G.phase !== 'bet') return;
    selBet = +b.getAttribute('data-b');
    render();
  }

  /* ---------- Boucle des adversaires ---------- */
  // En ligne, seul l'hôte (siège 0) fait jouer les ordinateurs ; l'autre appareil reçoit le résultat.
  function isHost() { return mode() !== 'online' || (!!ONL && ONL.me === 0 && !!G.online && G.online.joined); }
  async function advance() {
    if (running || !G || !isHost()) return;
    running = true;
    var g = G;
    try {
      while (G === g && active() && !G.human[G.turn]) {
        render();
        await sleep(delay(G.showLast ? 1500 : 800));
        if (G !== g || !active() || G.human[G.turn]) break;
        var p = G.turn;
        if (G.phase === 'bet') {
          E.placeBet(G, E.botBet(G, p));
        } else {
          var c = E.botPlay(G, p);
          E.playCard(G, c.id, c.val);
        }
        save();
      }
    } finally { running = false; }
    if (G !== g) { setTimeout(advance, 0); return; }   // l'état a été remplacé pendant l'attente (autre appareil) : on repart sur le nouveau
    render();
  }

  /* ---------- Résultats de donne et fin de partie ---------- */
  // La fenêtre de résultats s'ouvre un instant après la dernière carte, sur chaque appareil.
  function scheduleRound() {
    if (!G || screen !== 'play' || G.phase !== 'dealEnd' || roundOpen || roundTimer) return;
    var g = G;
    roundTimer = setTimeout(function () {
      roundTimer = null;
      if (G === g && G.phase === 'dealEnd' && !roundOpen) showRound();
    }, delay(1200));
  }
  function openRound(html) {
    roundOpen = true;
    $('roundBody').innerHTML = html;
    if (!$('dlgRound').open) $('dlgRound').showModal();
  }
  function closeRound() {
    roundOpen = false;
    clearTimeout(roundTimer); roundTimer = null;
    if ($('dlgRound').open) $('dlgRound').close();
  }
  function roundHTML(view) {            // view = affichage seul (plateau) : pas de bouton
    var r = G.result;
    if (!r) return '';
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
    if (!view) h += '<button class="btn gold" data-act="next">' + (G.over ? 'Voir le classement' : 'Donne suivante') + '</button>';
    return h;
  }
  function showRound() {
    var h = roundHTML(false);
    if (h) openRound(h);
  }
  function endHTML(view) {
    var rk = E.ranking(G), medals = ['🥇', '🥈', '🥉'];
    var h = '<h2 class="serif">Fin de la partie</h2>';
    rk.forEach(function (r) {
      h += '<div class="rank' + (r.rank === 1 ? ' win' : '') + '"><span class="pos">' + (medals[r.rank - 1] || r.rank) + '</span>' +
           '<span class="n">' + esc(G.names[r.p]) + '</span><span>' + r.score + ' pt' + (r.score > 1 ? 's' : '') + '</span></div>';
    });
    if (!view) h += '<button class="btn gold" data-act="again">Rejouer</button><button class="btn ghost" data-act="home">Accueil</button>';
    return h;
  }
  function showEnd() {
    if (G.mode === 'solo') clearSave();
    openRound(endHTML(false));
  }
  function onAct(act) {
    if (!G) return;
    if (act === 'next') {
      E.nextDeal(G);
      if (G.phase === 'over') { save(); showEnd(); return; }
      closeRound();
      selCard = null; selBet = null;
      save();
      render();
      advance();
    } else if (act === 'again') {
      closeRound();
      if (mode() === 'online') restartOnline(); else startGame();
    } else if (act === 'home') {
      goHome();
    }
  }

  function scoresHTML() {
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
    return G.history.length ? h : '<p>Aucune donne terminée pour l\'instant.</p>';
  }
  function showScores() { $('scoresBody').innerHTML = scoresHTML(); $('dlgScores').showModal(); }

  /* ---------- Accueil ---------- */
  function updateHome() {
    var on = prefs.mode === 'online';
    Array.prototype.forEach.call($('segMode').children, function (b) { b.classList.toggle('on', b.getAttribute('data-m') === prefs.mode); });
    Array.prototype.forEach.call($('segOpp').children, function (b) { b.classList.toggle('on', +b.getAttribute('data-n') === prefs.opp); });
    Array.prototype.forEach.call($('segOppOl').children, function (b) { b.classList.toggle('on', +b.getAttribute('data-n') === prefs.oppOl); });
    $('optSolo').hidden = on;
    $('optOppOl').hidden = !on;
    $('optNames').hidden = !on;
    $('onlinePanel').hidden = !on;
    if (document.activeElement !== $('n1')) $('n1').value = prefs.n1;
    $('swAide').classList.toggle('on', prefs.aide);
    $('swAide2').classList.toggle('on', prefs.aide);
    $('btnResume').hidden = on || !loadSave();
    $('btnNew').disabled = on && !EL.connecte();
    $('ver').textContent = 'Version ' + APP_VERSION;
    if (on) olRender();
  }

  function startGame() {
    if (prefs.mode === 'online') { onlineCreate(); return; }
    var names = ['Toi'].concat(BOT_NAMES.slice(0, prefs.opp));
    var human = names.map(function (_, j) { return j === 0; });
    savePrefs();
    G = E.newGame({ mode: 'solo', names: names, human: human });
    selCard = null; selBet = null; roundOpen = false;
    screen = 'play';
    save();
    render();
    advance();
  }
  function resumeGame() {
    var g = loadSave();
    if (!g) return;
    G = g; prefs.mode = 'solo';
    selCard = null; selBet = null; roundOpen = false;
    screen = 'play';
    render();
    if (G.phase === 'dealEnd') showRound(); else advance();
  }
  function goHome() {
    plStop();
    if (ONL) onlineStop(); else if (G && G.mode === 'solo') save();
    closeRound();
    G = null; screen = 'home';
    $('wait').hidden = true; $('game').classList.remove('notable');
    showScreen(); updateHome();
  }

  function toggleAide() {
    prefs.aide = !prefs.aide; savePrefs(); updateHome(); if (G && screen === 'play') render();
  }

  /* ---------- En ligne ---------- */
  var OFF_TXT = $('offbar').textContent;
  function olMsg(t) { var e = $('olErr'); e.hidden = !t; e.textContent = t || ''; }
  function olError(e) {
    if (e && e.kind === 'auth') { olMsg('Session expirée : reconnecte-toi.'); olRender(); }
    else if (e && e.kind === 'reseau') olMsg('Pas de réseau : impossible de joindre le service pour l\'instant.');
    else olMsg('Erreur : ' + (e && e.message ? e.message : 'inconnue'));
  }
  function olRender() {
    var inn = EL.connecte();
    $('olLogin').hidden = inn; $('olIn').hidden = !inn;
    $('btnNew').disabled = prefs.mode === 'online' && !inn;
    if (inn) { $('olWho').textContent = EL.email(); olList(); }
  }
  function olList() {
    EL.liste('lecontrat').then(function (a) {
      var h = '';
      a.forEach(function (r) {
        h += '<div class="olitem"><div class="t"><b>' + esc(r.id) + '</b><small>' + esc(r.titre || '') + '</small></div>' +
          '<button data-ol="resume" data-id="' + esc(r.id) + '">Reprendre</button><button data-ol="del" data-id="' + esc(r.id) + '" aria-label="Supprimer la partie ' + esc(r.id) + '">✕</button></div>';
      });
      $('olList').innerHTML = h || '<p class="olwho" style="margin:0">Aucune pour l\'instant.</p>';
    }).catch(olError);
  }
  function getMap() { try { return JSON.parse(localStorage.getItem(OKEY)) || {}; } catch (e) { return {}; } }
  function setMap(id, me) { var m = getMap(); m[id] = me; try { localStorage.setItem(OKEY, JSON.stringify(m)); } catch (e) { /* rien */ } }
  function titre() {
    return G.names.filter(function (n, i) { return G.human[i] && n !== '…'; }).join(' et ') + ' · ' +
      (G.online && G.online.joined ? 'donne ' + (Math.min(G.deal + 1, G.sizes.length)) + '/' + G.sizes.length : 'en attente') + (G.phase === 'over' ? ' (terminée)' : '');
  }
  function onlineStart(id, me, version) {
    onlineStop();
    ONL = { id: id, me: me, version: version, dirty: false, pushing: false, status: 'ok', watch: null, retry: null };
    setMap(id, me);
    ONL.watch = EL.surveiller(id, function () { return ONL ? ONL.version : 0; }, onRemote, onStatus);
    platWatch(ONL);
  }
  function onlineStop() {
    if (ONL) { if (ONL.watch) ONL.watch.stop(); clearTimeout(ONL.retry); if (ONL.plat) { ONL.plat.stopped = true; clearTimeout(ONL.plat.timer); } }
    ONL = null;
    $('offbar').hidden = true; $('wait').hidden = true;
  }
  function onStatus(st) {
    if (!ONL) return;
    ONL.status = st;
    $('offbar').hidden = st !== 'hors-ligne';
    if (st === 'supprimee') { goHome(); olMsg('Cette partie a été supprimée.'); return; }
    if (st === 'auth') { goHome(); olError({ kind: 'auth' }); return; }
    if (st === 'ok' && ONL.dirty && !ONL.pushing) pushState();
  }
  function onlineShow() {          // affiche G selon son avancement : salle d'attente, partie, résultats ou classement
    screen = 'play';
    if (!G.online.joined) { $('waitCode').textContent = ONL.id; $('wait').hidden = false; showScreen(); return; }
    $('wait').hidden = true;
    if (G.phase === 'over') { render(); showEnd(); return; }
    if (G.phase !== 'dealEnd') closeRound();
    render();
    advance();
  }
  function takeRemote(row) {       // l'état du serveur remplace le nôtre
    G = row.etat; ONL.version = row.version; selCard = null; selBet = null;
  }
  function onRemote() {
    var o = ONL;
    if (!o || o.pushing || o.dirty) return;
    return EL.lire(o.id).then(function (row) {
      if (ONL !== o || !row || row.version <= o.version || o.pushing || o.dirty) return;
      takeRemote(row);
      onlineShow();
    });
  }
  function pushState() {
    var o = ONL;
    if (!o || o.pushing || !o.dirty) return;
    o.pushing = true; o.dirty = false;
    EL.ecrire(o.id, o.version, G, titre()).then(function (nv) {
      if (ONL !== o) return;
      o.pushing = false;
      if (nv) { o.version = nv; if (o.status === 'hors-ligne') onStatus('ok'); if (o.dirty) pushState(); return; }
      // conflit : l'autre appareil a écrit avant nous. Son état l'emporte, notre action est annulée.
      return EL.lire(o.id).then(function (row) {
        if (ONL !== o || !row) return;
        o.dirty = false; takeRemote(row);
        if (G.online.uids.indexOf(EL.uid()) < 0) { goHome(); olMsg('Cette partie a déjà ses deux joueurs.'); return; }
        if (active()) G.last = 'Ton action a été annulée : l\'autre appareil a joué en même temps.';
        onlineShow();
      });
    }).catch(function (e) {
      if (ONL !== o) return;
      o.pushing = false; o.dirty = true;
      onStatus(e && e.kind === 'reseau' ? 'hors-ligne' : 'erreur');
      if (e && e.kind === 'auth') return;
      clearTimeout(o.retry);
      o.retry = setTimeout(function () { if (ONL === o) pushState(); }, 2000);
    });
  }
  function onlineCreate() {
    var nm = (prefs.n1 || '').trim() || 'Joueur 1', names = [nm, '…'], human = [true, true], i;
    for (i = 0; i < prefs.oppOl; i++) { names.push(BOT_NAMES[i]); human.push(false); }
    savePrefs();
    var g = E.newGame({ mode: 'online', names: names, human: human });
    g.online = { uids: [EL.uid(), null], joined: false };
    EL.creer('lecontrat', g, nm + ' · en attente').then(function (r) {
      G = g; roundOpen = false; onlineStart(r.id, 0, r.version); onlineShow();
    }).catch(olError);
  }
  function restartOnline() {       // « Rejouer » en ligne : même code, mêmes joueurs, scores remis à zéro
    var o = G.online, ng = E.newGame({ mode: 'online', names: G.names.slice(), human: G.human.slice() });
    G = ng; G.online = o; selCard = null; selBet = null;
    save(); onlineShow();
  }
  function seatFor(id, g) {
    var m = getMap(), me = m[id];
    if (me == null && g.online) { var k = g.online.uids.indexOf(EL.uid()); if (k >= 0) me = k; }
    return me;
  }
  function onlineJoin(code) {
    code = (code || '').trim().toUpperCase();
    if (code.length !== 4) { olMsg('Le code a 4 lettres.'); return; }
    olMsg('');
    EL.lire(code).then(function (row) {
      if (!row || row.jeu !== 'lecontrat') { olMsg('Code inconnu.'); return; }
      var g = row.etat, me = seatFor(code, g);
      if (me != null && (g.online.joined || me === 0)) { G = g; roundOpen = false; onlineStart(code, me, row.version); onlineShow(); return; }
      if (g.online.joined) { olMsg('Cette partie a déjà ses deux joueurs.'); return; }
      var nm = (prefs.n1 || '').trim() || 'Joueur 2';
      if (g.names.indexOf(nm) >= 0) nm += ' (2)';
      G = g; roundOpen = false; onlineStart(code, 1, row.version);
      G.names[1] = nm; G.online.uids[1] = EL.uid(); G.online.joined = true;
      save(); onlineShow();
    }).catch(olError);
  }
  function onlineResume(id) {
    olMsg('');
    EL.lire(id).then(function (row) {
      if (!row) { olMsg('Partie introuvable.'); olList(); return; }
      var me = seatFor(id, row.etat);
      G = row.etat; roundOpen = false; onlineStart(row.id, me != null ? me : 0, row.version); onlineShow();
    }).catch(olError);
  }

  /* ---------- Plateau : détection côté téléphone ---------- */
  // Le plateau écrit régulièrement dans sa propre ligne (jeu « plateau », titre = code de la partie) : la ligne de la partie n'est
  // jamais touchée, donc aucun conflit avec les coups. Le téléphone cache la table tant que cette ligne change (< 30 s), et la
  // réaffiche seul si le plateau disparaît. Au 1er passage on note seulement la version : un reste d'une séance précédente ne compte pas.
  function platPoll() { return window.PLATEAU_POLL != null ? window.PLATEAU_POLL : 5000; }
  function platFresh() { return window.PLATEAU_FRESH != null ? window.PLATEAU_FRESH : 30000; }
  function platBeatMs() { return window.PLATEAU_BEAT != null ? window.PLATEAU_BEAT : 10000; }
  function platWatch(o) {
    var P = o.plat = { present: false, override: false, ver: null, seen: 0, timer: null, stopped: false };
    function next() { if (ONL === o && !P.stopped) P.timer = setTimeout(tick, platPoll()); }
    function tick() {
      if (ONL !== o || P.stopped) return;
      clearTimeout(P.timer);
      if (document.hidden || !G || !G.online || !G.online.joined) { next(); return; }
      EL.liste('plateau').then(function (rows) {
        if (ONL !== o || P.stopped) return;
        var r = null, now = Date.now();
        rows.forEach(function (x) { if (x.titre === o.id) r = x; });
        if (!r) { P.ver = null; P.seen = 0; }
        else if (P.ver == null) P.ver = r.version;
        else if (r.version !== P.ver) { P.ver = r.version; P.seen = now; }
        var pres = !!r && P.seen > 0 && now - P.seen < platFresh();
        if (pres !== P.present) { P.present = pres; if (!pres) P.override = false; if (G && screen === 'play') render(); }
      }).catch(function () { /* réseau : on garde l'état connu */ }).then(next);
    }
    tick();
  }

  /* ---------- Plateau : affichage seul (iPad commun) ---------- */
  function plStop() {
    var o = PL; if (!o) return;
    if (o.watch) o.watch.stop();
    clearInterval(o.timer); clearTimeout(o.t2);
    if (o.rowId) EL.supprimer(o.rowId).catch(function () { /* tant pis : la ligne vieillira toute seule */ });
    PL = null; $('plateau').hidden = true; $('offbar').hidden = true; $('offbar').textContent = OFF_TXT;
  }
  function plBeat() {
    var o = PL; if (!o || o.busy) return;
    o.busy = true;
    var data = { code: o.id, t: Date.now() }, p;
    if (o.rowId) {
      p = EL.ecrire(o.rowId, o.rowVer, data, o.id).then(function (nv) {
        if (nv) { o.rowVer = nv; return; }
        return EL.lire(o.rowId).then(function (row) { if (row) o.rowVer = row.version; else o.rowId = null; });
      });
    } else {
      p = EL.liste('plateau').then(function (rows) {
        var r = null; rows.forEach(function (x) { if (x.titre === o.id) r = x; });
        if (r) { o.rowId = r.id; o.rowVer = r.version; return; }
        return EL.creer('plateau', data, o.id).then(function (x) { o.rowId = x.id; o.rowVer = x.version; });
      });
    }
    p.catch(function () { /* hors ligne : le prochain battement réessaiera */ }).then(function () {
      o.busy = false;
      if (PL !== o && o.rowId) EL.supprimer(o.rowId).catch(function () {});
    });
  }
  function plRender() {
    if (!G) return;
    var p, h = '';
    if (!G.online || !G.online.joined) {
      $('plTitle').textContent = 'Plateau · ' + PL.id; $('plSub').textContent = 'Le Contrat en ligne';
      $('plSeats').innerHTML = ''; $('plTrick').style.display = 'none'; $('plResults').innerHTML = '';
      $('plMsg').textContent = 'En attente des joueurs…';
      return;
    }
    $('plTrick').style.display = '';
    $('plTitle').textContent = 'Donne ' + (Math.min(G.deal + 1, G.sizes.length)) + ' / ' + G.sizes.length;
    $('plSub').textContent = 'Plateau · ' + PL.id + ' · ' + E.plural(G.k, 'carte') + (G.aside ? ' · ' + E.plural(G.aside, 'écartée') : '');
    for (p = 0; p < G.n; p++) h += seatHTML(p);
    $('plSeats').innerHTML = h;
    $('plTrick').innerHTML = G.phase === 'over' ? '' : trickHTML();
    var t;
    if (G.phase === 'over') t = 'Partie terminée';
    else if (G.phase === 'dealEnd') t = 'Donne terminée';
    else t = (G.last ? G.last + ' ' : '') + 'Au tour de ' + G.names[G.turn] + (G.phase === 'bet' ? ' d\'annoncer…' : '…');
    if (G.last && /annulée/.test(G.last)) t = t.replace(G.last + ' ', '');
    $('plMsg').textContent = t;
    $('plResults').innerHTML = G.phase === 'over' ? endHTML(true) : G.phase === 'dealEnd' ? roundHTML(true) : (G.history.length ? scoresHTML() : '');
  }
  function plRemote() {
    var o = PL; if (!o) return;
    return EL.lire(o.id).then(function (row) {
      if (PL !== o || !row || row.version <= o.version) return;
      G = row.etat; o.version = row.version; plRender();
    });
  }
  function plStatus(st) {
    if (!PL) return;
    if (st === 'supprimee') { goHome(); olMsg('Cette partie a été supprimée.'); return; }
    if (st === 'auth') { goHome(); olError({ kind: 'auth' }); return; }
    $('offbar').textContent = 'Hors ligne : le plateau se remettra à jour au retour du réseau';
    $('offbar').hidden = st !== 'hors-ligne';
  }
  function plateauStart(code) {
    code = (code || '').trim().toUpperCase();
    if (code.length !== 4) { olMsg('Le code a 4 lettres.'); return; }
    olMsg('');
    EL.lire(code).then(function (row) {
      if (!row || row.jeu !== 'lecontrat') { olMsg('Code inconnu.'); return; }
      onlineStop(); plStop(); closeRound();
      G = row.etat; screen = 'home'; selCard = null; selBet = null;
      var o = PL = { id: code, version: row.version, watch: null, rowId: null, rowVer: 0, timer: null, t2: null, busy: false };
      showScreen();
      plRender();
      o.watch = EL.surveiller(code, function () { return PL ? PL.version : 0; }, plRemote, plStatus);
      plBeat();
      o.t2 = setTimeout(plBeat, 1500);
      o.timer = setInterval(plBeat, platBeatMs());
    }).catch(olError);
  }

  /* ---------- Branchements ---------- */
  function init() {
    loadPrefs();
    updateHome();

    $('segMode').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      prefs.mode = b.getAttribute('data-m'); savePrefs(); olMsg(''); updateHome();
    });
    $('segOpp').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      prefs.opp = +b.getAttribute('data-n'); savePrefs(); updateHome();
    });
    $('segOppOl').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      prefs.oppOl = +b.getAttribute('data-n'); savePrefs(); updateHome();
    });
    $('n1').addEventListener('input', function () { prefs.n1 = $('n1').value.slice(0, 14); savePrefs(); });
    $('swAide').addEventListener('click', toggleAide);
    $('swAide2').addEventListener('click', toggleAide);
    $('btnNew').addEventListener('click', startGame);
    $('btnResume').addEventListener('click', resumeGame);
    $('btnRules').addEventListener('click', function () { $('dlgRules').showModal(); });

    $('btnScores').addEventListener('click', function () { if (G) showScores(); });
    $('btnMenu').addEventListener('click', function () { $('dlgMenu').showModal(); });
    $('btnMenuRules').addEventListener('click', function () { $('dlgMenu').close(); $('dlgRules').showModal(); });
    $('btnQuit').addEventListener('click', function () { $('dlgMenu').close(); goHome(); });
    $('btnTable').addEventListener('click', function () { if (ONL && ONL.plat) { ONL.plat.override = !ONL.plat.override; render(); } });

    $('hand').addEventListener('click', onHandClick);
    $('betbar').addEventListener('click', onBetClick);
    $('btnAction').addEventListener('click', onAction);

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

    // En ligne
    window.addEventListener('offline', function () { if (ONL) onStatus('hors-ligne'); });
    window.addEventListener('online', function () { if (ONL && ONL.watch) ONL.watch.poke(); });
    $('btnOlLogin').addEventListener('click', function () {
      olMsg('');
      EL.login($('olEmail').value.trim(), $('olPwd').value).then(function () { $('olPwd').value = ''; updateHome(); }).catch(function (e) {
        olMsg(e.kind === 'bad' ? 'E-mail ou mot de passe refusé.' : e.kind === 'reseau' ? 'Pas de réseau.' : 'Erreur : ' + e.message);
      });
    });
    $('btnOlLogout').addEventListener('click', function () { EL.logout(); olMsg(''); updateHome(); });
    $('btnOlJoin').addEventListener('click', function () { onlineJoin($('olCode').value); });
    $('btnOlPlateau').addEventListener('click', function () { plateauStart($('olCode').value); });
    $('olList').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-ol]'); if (!b) return;
      var id = b.getAttribute('data-id');
      if (b.getAttribute('data-ol') === 'resume') onlineResume(id);
      else if (confirm('Supprimer la partie ' + id + ' pour les deux joueurs ?')) EL.supprimer(id).then(olList).catch(olError);
    });
    $('btnWaitCancel').addEventListener('click', function () {
      var id = ONL && ONL.id;
      goHome();
      if (id && confirm('Supprimer la partie ' + id + ' ?')) EL.supprimer(id).catch(function () { /* déjà partie */ });
    });
    $('btnWaitHome').addEventListener('click', goHome);
    $('btnPlQuit').addEventListener('click', goHome);

    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('sw.js'); } catch (e) {}
    }
    showScreen();
  }

  init();
})();
