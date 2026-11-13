"""Mode « En ligne » du Contrat : deux appareils simulés (deux contextes Chromium), faux serveur Supabase en mémoire.

Aucun réseau réel, aucun vrai compte : e-mails, mots de passe et prénoms inventés.
Couvre aussi le plateau (iPad en affichage seul), une partie complète à deux appareils et la partie solo.
Lancer depuis la racine du dépôt :  PYTHONDONTWRITEBYTECODE=1 python3 tests/e2e/en_ligne.py
"""
import functools
import http.server
import json
import pathlib
import random
import sys
import threading
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
HOST = 'https://zoyrclsppuhgnyzgodjv.supabase.co'
ACCOUNTS = {'max@example.com': ('mot-de-passe-1', 'uid-max'), 'claire@example.com': ('mot-de-passe-2', 'uid-claire'), 'intrus@example.com': ('mot-de-passe-3', 'uid-intrus')}
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, prefer',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS'}
RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok)))
    print(('  OK   ' if ok else '  ECHEC ') + name + ('' if ok else '  -> ' + str(detail)[:300]))


class Faux:
    def __init__(self):
        self.rows = {}
        self.offline = False
        self.cut = set()      # contextes dont le réseau est coupé
        self.n = 0
        self.tokens = {}      # jeton d'accès -> uid
        self.refresh = {}     # jeton de renouvellement -> (email, uid)
        self.conflicts = 0
        self.patches = 0

    def reply(self, route, status, body=None):
        route.fulfill(status=status, headers=CORS, content_type='application/json', body=json.dumps(body) if body is not None else '')

    def new_tokens(self, email, uid):
        self.n += 1
        at, rt = 'AT%d' % self.n, 'RT%d' % self.n
        self.tokens[at] = uid
        self.refresh[rt] = (email, uid)
        return {'access_token': at, 'refresh_token': rt, 'expires_in': 3600, 'user': {'id': uid, 'email': email}}

    def handle(self, route, ctx=None):
        req = route.request
        u = urlparse(req.url)
        q = parse_qs(u.query)
        if req.method == 'OPTIONS':
            route.fulfill(status=204, headers=CORS)
            return
        if self.offline or (ctx is not None and ctx in self.cut):
            route.abort()
            return
        if u.path == '/auth/v1/token':
            body = json.loads(req.post_data or '{}')
            if q.get('grant_type') == ['password']:
                acc = ACCOUNTS.get(body.get('email'))
                if acc and acc[0] == body.get('password'):
                    self.reply(route, 200, self.new_tokens(body['email'], acc[1]))
                else:
                    self.reply(route, 400, {'error_description': 'Invalid login credentials'})
            else:
                r = self.refresh.pop(body.get('refresh_token'), None)
                self.reply(route, 200, self.new_tokens(*r)) if r else self.reply(route, 400, {'error_description': 'Invalid Refresh Token'})
            return
        if u.path == '/rest/v1/parties':
            auth = req.headers.get('authorization', '')
            if not auth.startswith('Bearer ') or auth[7:] not in self.tokens:
                self.reply(route, 401, {'message': 'JWT expired'})
                return
            flt = {k: v[0][3:] for k, v in q.items() if k in ('id', 'jeu', 'version') and v[0].startswith('eq.')}
            match = [r for r in self.rows.values() if all(str(r[k]) == v for k, v in flt.items())]
            if req.method == 'GET':
                cols = q.get('select', ['*'])[0].split(',')
                if q.get('order') == ['maj.desc']:
                    match.sort(key=lambda r: r['maj'], reverse=True)
                out = [r if cols == ['*'] else {c: r[c] for c in cols} for r in match[:int(q.get('limit', ['100'])[0])]]
                self.reply(route, 200, out)
            elif req.method == 'POST':
                it = json.loads(req.post_data)
                if it['id'] in self.rows:
                    self.reply(route, 409, {'code': '23505'})
                else:
                    self.rows[it['id']] = {'id': it['id'], 'jeu': it['jeu'], 'titre': it.get('titre'), 'etat': it['etat'], 'version': it['version'], 'maj': it['maj']}
                    self.reply(route, 201)
            elif req.method == 'PATCH':
                self.patches += 1
                body = json.loads(req.post_data)
                if not match:
                    self.conflicts += 1
                for r in match:
                    r.update({k: body[k] for k in ('etat', 'version', 'maj', 'titre') if k in body})
                self.reply(route, 200, match)
            elif req.method == 'DELETE':
                for r in match:
                    del self.rows[r['id']]
                self.reply(route, 204)
            return
        route.continue_()


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://127.0.0.1:%d/index.html' % srv.server_address[1]


def device(browser, faux, url, poll=150, viewport=None):
    ctx = browser.new_context(viewport=viewport or {'width': 390, 'height': 844})
    ctx.route(HOST + '/**', (lambda c: (lambda route: faux.handle(route, c)))(ctx))
    pg = ctx.new_page()
    pg.errors = []
    pg.on('pageerror', lambda e: pg.errors.append(str(e)))
    pg.on('console', lambda m: pg.errors.append(m.text) if m.type == 'error' and 'ERR_FAILED' not in m.text and 'Failed to load resource' not in m.text else None)
    pg.on('dialog', lambda d: d.accept())
    pg.add_init_script('window.BOT_DELAY=5; window.EL_OPTIONS={poll:%d}; window.PLATEAU_POLL=250; window.PLATEAU_BEAT=300; window.PLATEAU_FRESH=1500;' % poll)
    pg.goto(url)
    return pg


def login(pg, email):
    pg.click('#segMode button[data-m="online"]')
    pg.fill('#olEmail', email)
    pg.fill('#olPwd', ACCOUNTS[email][0])
    pg.click('#btnOlLogin')
    pg.wait_for_selector('#olIn:not([hidden])')


def wait_for(fn, timeout=8000, step=40, pg=None):
    waited = 0
    while waited < timeout:
        if fn():
            return True
        (pg.wait_for_timeout(step) if pg else None)
        waited += step
    return False


def state(faux, id_):
    return faux.rows[id_]['etat']


def my_move(pg):
    """Joue un coup si c'est à cet appareil : un pari, ou une carte. Rend True si quelque chose a été fait."""
    try:
        if pg.locator('#dlgRound[open]').count():
            return False
        t = pg.inner_text('#btnAction')
        if t.startswith('Choisis ton pari') or t.startswith('Annoncer'):
            if t.startswith('Choisis'):
                bbs = pg.locator('#betbar .bb:not([disabled])')
                n = bbs.count()
                if not n:
                    return False
                bbs.nth(random.randrange(n)).click(timeout=2000)
            pg.click('#btnAction', timeout=2000)
            return True
        if t.startswith('Choisis une carte') or t.startswith('Jouer'):
            if t.startswith('Choisis'):
                n = pg.locator('#hand .card').count()
                if not n:
                    return False
                pg.locator('#hand .card').nth(random.randrange(n)).click(timeout=2000)
            pg.click('#btnAction', timeout=2000)
            if pg.locator('#dlgExcuse[open]').count():
                pg.click('#dlgExcuse [data-ex="%d"]' % random.choice((0, 22)), timeout=2000)
            return True
    except Exception:
        return False
    return False


def round_open(pg):
    return pg.locator('#dlgRound[open]').count() > 0


def play_until(pages, cond, limit=40000, budget=240):
    """Fait jouer tous les appareils (au hasard) jusqu'à ce que cond() soit vrai."""
    import time
    t0 = time.time()
    for _ in range(limit):
        if cond():
            return True
        if time.time() - t0 > budget:
            return False
        moved = False
        for pg in pages:
            if my_move(pg):
                moved = True
        pages[0].wait_for_timeout(12 if moved else 60)
    return False


def main():
    srv, url = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        faux = Faux()

        print('Accueil et connexion')
        a = device(browser, faux, url)
        a.evaluate("localStorage.setItem('lecontrat_prefs_v1', JSON.stringify({mode:'passe',opp:2,np:4,aide:true,n1:'Max'}))")
        a.evaluate("localStorage.setItem('lecontrat_partie_v1', JSON.stringify({mode:'duo',n:2,hands:[[],[]],sizes:[1],phase:'bet'}))")
        a.reload()
        check('un ancien choix « on se passe l’appareil » enregistré retombe sur « Contre l’ordinateur »', a.locator('#segMode button[data-m="solo"].on').count() == 1)
        check('une ancienne partie « face à face » n’est pas proposée à la reprise', not a.is_visible('#btnResume'))
        check('les anciens modes n’existent plus', a.locator('#segMode button[data-m="duo"], #segMode button[data-m="passe"]').count() == 0 and a.locator('#duo, #veil, #duoRound').count() == 0)
        a.click('#segMode button[data-m="online"]')
        check('le panneau de connexion apparaît', a.is_visible('#onlinePanel') and a.is_visible('#olLogin'))
        check('« Nouvelle partie » est inactif tant qu’on n’est pas connecté', a.is_disabled('#btnNew'))
        check('en ligne : choix du nombre d’ordinateurs de 0 à 3', a.locator('#segOppOl button').count() == 4 and a.is_visible('#optOppOl') and not a.is_visible('#optSolo'))
        check('la version est affichée', 'Version' in a.inner_text('#ver'))
        a.fill('#olEmail', 'max@example.com'); a.fill('#olPwd', 'faux'); a.click('#btnOlLogin')
        a.wait_for_selector('#olErr:not([hidden])')
        check('mauvais mot de passe : message clair', 'refusé' in a.inner_text('#olErr'), a.inner_text('#olErr'))
        login(a, 'max@example.com')
        check('connecté : e-mail affiché, création possible', 'max@example.com' in a.inner_text('#olWho') and not a.is_disabled('#btnNew'))

        print('Création, salle d’attente, jonction')
        a.fill('#n1', 'Max')
        a.click('#segOppOl button[data-n="1"]')
        a.click('#btnNew')
        a.wait_for_selector('#wait:not([hidden])')
        code = a.inner_text('#waitCode').strip()
        check('code à 4 lettres affiché', len(code) == 4 and code.isalpha() and code.isupper(), code)
        row = faux.rows.get(code)
        check('la partie existe sur le serveur (jeu lecontrat, version 1)', row and row['jeu'] == 'lecontrat' and row['version'] == 1)
        check('3 joueurs : Max, l’invité en attente, un ordinateur', row and len(row['etat']['names']) == 3 and row['etat']['online']['joined'] is False and row['etat']['human'] == [True, True, False])

        b = device(browser, faux, url)
        login(b, 'claire@example.com')
        b.fill('#n1', 'Claire')
        b.fill('#olCode', 'ZZZZ'); b.click('#btnOlJoin')
        b.wait_for_selector('#olErr:not([hidden])')
        check('code inconnu : message', 'inconnu' in b.inner_text('#olErr'), b.inner_text('#olErr'))
        b.fill('#olCode', code.lower()); b.click('#btnOlJoin')
        b.wait_for_selector('#game:not([hidden])')
        check('B voit la partie avec sa propre main (1 carte à la 1re donne)', b.locator('#hand .card').count() == 1 and 'Claire' in b.inner_text('#roundSub'), b.inner_text('#roundSub'))
        check('A sort de la salle d’attente tout seul', wait_for(lambda: not a.is_visible('#wait'), 6000, pg=a))
        check('A voit sa main et se nomme Max', a.locator('#hand .card').count() == 1 and 'Max' in a.inner_text('#roundSub'))
        check('A voit Claire et l’ordinateur parmi les adversaires', 'Claire' in a.inner_text('#opps') and 'Camille' in a.inner_text('#opps'), a.inner_text('#opps'))
        check('les mains des adversaires restent cachées (aucune carte affichée)', a.locator('#opps .card').count() == 0 and b.locator('#opps .card').count() == 0)
        c = device(browser, faux, url)
        login(c, 'intrus@example.com')
        c.fill('#olCode', code); c.click('#btnOlJoin')
        c.wait_for_selector('#olErr:not([hidden])')
        check('une troisième personne ne peut pas rejoindre (2 humains au plus)', 'deux joueurs' in c.inner_text('#olErr'), c.inner_text('#olErr'))
        c.context.close()

        print('Droits de jeu')
        ok = wait_for(lambda: state(faux, code)['turn'] in (0, 1) and state(faux, code)['phase'] == 'bet', 8000, pg=a)
        check('l’hôte fait jouer l’ordinateur : le tour arrive à un humain', ok, (state(faux, code)['turn'], state(faux, code)['phase']))
        turn = state(faux, code)['turn']
        who, other = (a, b) if turn == 0 else (b, a)
        check('seul le joueur dont c’est le tour voit les boutons de pari', wait_for(lambda: who.is_visible('#betbar'), 4000, pg=who) and not other.is_visible('#betbar'))
        check('l’autre appareil est en attente', other.inner_text('#btnAction').startswith('Au tour de') and other.is_disabled('#btnAction'), other.inner_text('#btnAction'))

        print('Hors ligne')
        v_avant = faux.rows[code]['version']
        who.context.set_offline(True); faux.cut.add(who.context)
        check('réseau coupé : la bannière apparaît', wait_for(lambda: who.is_visible('#offbar'), 4000, pg=who))
        check('la bannière ne bloque pas les touchers', who.evaluate("() => getComputedStyle(document.getElementById('offbar')).pointerEvents") == 'none')
        check('hors ligne : on peut quand même annoncer', my_move(who))
        who.wait_for_timeout(300)
        check('rien n’est parti sur le serveur', faux.rows[code]['version'] == v_avant, (faux.rows[code]['version'], v_avant))
        who.context.set_offline(False); faux.cut.discard(who.context)
        check('retour du réseau : la bannière disparaît', wait_for(lambda: not who.is_visible('#offbar'), 8000, pg=who))
        check('le pari hors ligne arrive sur le serveur', wait_for(lambda: faux.rows[code]['version'] > v_avant, 8000, pg=who))

        print('Reprise après rechargement')
        b.reload()
        b.click('#segMode button[data-m="online"]')
        b.wait_for_selector('#olList .olitem')
        check('la partie apparaît dans « Parties en cours »', code in b.inner_text('#olList'))
        b.click('#olList button[data-ol="resume"]')
        b.wait_for_selector('#game:not([hidden])')
        check('reprise : Claire retrouve sa main', b.locator('#hand .card').count() == 1 and 'Claire' in b.inner_text('#roundSub'))

        print('Plateau (iPad en affichage seul)')
        plat_rows = lambda: [r for r in faux.rows.values() if r['jeu'] == 'plateau']
        pl = device(browser, faux, url, viewport={'width': 1024, 'height': 768})
        login(pl, 'max@example.com')
        pl.fill('#olCode', 'ZZZZ'); pl.click('#btnOlPlateau')
        pl.wait_for_selector('#olErr:not([hidden])')
        check('plateau : code inconnu refusé', 'inconnu' in pl.inner_text('#olErr'), pl.inner_text('#olErr'))
        pl.fill('#olCode', code); pl.click('#btnOlPlateau')
        pl.wait_for_selector('#plateau:not([hidden])')
        check('le plateau montre les 3 joueurs avec score, pari et éventail de cartes', pl.locator('#plSeats .opp').count() == 3 and pl.locator('#plSeats .fan i').count() == 3, pl.inner_text('#plSeats'))
        check('le plateau ne montre aucune main (dos de cartes seulement)', pl.locator('#plSeats .card').count() == 0)
        check('le plateau affiche le tour courant', wait_for(lambda: state(faux, code)['names'][state(faux, code)['turn']] in pl.inner_text('#plMsg'), 4000, pg=pl), pl.inner_text('#plMsg'))
        check('le plateau ne se comporte pas comme un joueur (pas de main, pas de bouton de jeu)', pl.locator('#hand .card').count() == 0 and not pl.is_visible('#btnAction') and not pl.is_visible('#betbar'))
        check('le plateau écrit sa propre ligne (jeu « plateau », titre = code)', wait_for(lambda: any(r['titre'] == code for r in plat_rows()), 4000, pg=pl))
        check('la ligne de la partie ne contient rien du plateau', 'plateau' not in state(faux, code))
        check('téléphones : la table commune se cache dès que le plateau est branché', wait_for(lambda: a.locator('#game.notable').count() == 1 and b.locator('#game.notable').count() == 1, 8000, pg=a))
        check('téléphone : adversaires et pli masqués, main et boutons toujours là', not a.is_visible('#opps') and not a.is_visible('#trick') and a.locator('#hand .card').count() == 1 and a.is_visible('#btnAction'))
        check('téléphone : bouton de secours « Afficher la table »', a.is_visible('#btnTable') and a.inner_text('#btnTable') == 'Afficher la table')
        a.click('#btnTable')
        check('bouton de secours : la table revient', a.locator('#game.notable').count() == 0 and a.is_visible('#opps') and a.is_visible('#trick') and a.inner_text('#btnTable') == 'Masquer la table')
        a.click('#btnTable')
        check('et se recache', a.locator('#game.notable').count() == 1)

        print('Une donne complète à deux appareils')
        ended = play_until([a, b], lambda: round_open(a) and round_open(b), budget=60)
        check('la donne va jusqu’au bout sur les deux appareils', ended)
        if ended:
            check('mêmes résultats des deux côtés', a.inner_text('#roundBody') == b.inner_text('#roundBody'))
            check('le serveur indique la fin de donne', state(faux, code)['phase'] == 'dealEnd')
            check('plateau : résultats de la donne affichés, sans bouton', wait_for(lambda: pl.locator('#plResults table.sc').count() == 1, 4000, pg=pl) and pl.locator('#plResults .btn').count() == 0, pl.inner_text('#plResults')[:200])
            print('Donne suivante pressée en même temps')
            clk = "() => { const e = document.querySelector('#roundBody [data-act=next]'); if (e) e.click(); }"
            a.evaluate(clk); b.evaluate(clk)
            check('les deux appareils passent à la donne 2 (une seule fois)', wait_for(lambda: 'Donne 2' in a.inner_text('#roundTitle') and 'Donne 2' in b.inner_text('#roundTitle'), 8000, pg=a), (a.inner_text('#roundTitle'), b.inner_text('#roundTitle')))
            a.wait_for_timeout(1500)
            check('toujours la donne 2 après la synchro', state(faux, code)['deal'] == 1 and not round_open(a) and not round_open(b), state(faux, code)['deal'])
            check('donne 2 : 2 cartes par joueur sur chaque appareil', a.locator('#hand .card').count() == 2 and b.locator('#hand .card').count() == 2)
            check('plateau : passe à la donne 2 avec les deux téléphones', wait_for(lambda: 'Donne 2' in pl.inner_text('#plTitle') and pl.locator('#plResults .btn').count() == 0, 6000, pg=pl), pl.inner_text('#plTitle'))

        print('Plateau fermé sans prévenir, puis rouvert')
        pl.context.close()
        check('le plateau disparaît (iPad éteint) : les téléphones réaffichent la table tout seuls', wait_for(lambda: a.locator('#game.notable').count() == 0 and b.locator('#game.notable').count() == 0, 8000, pg=a))
        check('la ligne laissée par le plateau est encore là (rien ne la nettoie)', len(plat_rows()) == 1)
        pl2 = device(browser, faux, url, viewport={'width': 1024, 'height': 768})
        login(pl2, 'max@example.com')
        pl2.fill('#olCode', code); pl2.click('#btnOlPlateau')
        pl2.wait_for_selector('#plateau:not([hidden])')
        check('nouveau plateau : la table se recache et la ligne est réutilisée (une seule)', wait_for(lambda: a.locator('#game.notable').count() == 1, 8000, pg=a) and len(plat_rows()) == 1, len(plat_rows()))

        print('Partie complète, jusqu’au classement')
        # on joue jusqu'à la dernière donne, on appuie sur le bouton de chaque fenêtre de résultats
        import time
        t0 = time.time()
        while time.time() - t0 < 300 and state(faux, code)['phase'] != 'over':
            if round_open(a) and ('Donne suivante' in a.inner_text('#roundBody') or 'classement' in a.inner_text('#roundBody')):
                a.evaluate("() => { const e = document.querySelector('#roundBody [data-act=next]'); if (e) e.click(); }")
            moved = my_move(a) or my_move(b)
            a.wait_for_timeout(12 if moved else 60)
        check('la partie va jusqu’à la fin (13 donnes à 3 joueurs)', state(faux, code)['phase'] == 'over' and len(state(faux, code)['history']) == 13, (state(faux, code)['phase'], len(state(faux, code)['history'])))
        check('les deux appareils affichent le classement', wait_for(lambda: 'Fin de la partie' in a.inner_text('#roundBody') and 'Fin de la partie' in b.inner_text('#roundBody'), 6000, pg=a))
        check('même classement des deux côtés', a.inner_text('#roundBody') == b.inner_text('#roundBody'))
        check('plateau : le classement est affiché, sans bouton', wait_for(lambda: 'Fin de la partie' in pl2.inner_text('#plResults') and pl2.locator('#plResults .btn').count() == 0, 6000, pg=pl2), pl2.inner_text('#plResults')[:200])
        a.evaluate("() => document.querySelector('#roundBody [data-act=again]').click()")
        check('« Rejouer » : nouvelle partie, mêmes joueurs, scores à zéro, sur les deux appareils', wait_for(lambda: 'Donne 1' in a.inner_text('#roundTitle') and 'Donne 1' in b.inner_text('#roundTitle') and not round_open(b), 8000, pg=a) and state(faux, code)['scores'] == [0, 0, 0] and state(faux, code)['names'][:2] == ['Max', 'Claire'], state(faux, code)['scores'])
        pl2.click('#btnPlQuit')
        pl2.wait_for_selector('#home:not([hidden])')
        check('le plateau quitté efface sa ligne', wait_for(lambda: len(plat_rows()) == 0, 4000, pg=pl2))
        check('les téléphones réaffichent la table', wait_for(lambda: a.locator('#game.notable').count() == 0 and b.locator('#game.notable').count() == 0, 6000, pg=a))
        pl2.context.close()

        print('Suppression')
        b.click('#btnMenu'); b.click('#btnQuit')
        b.wait_for_selector('#olList .olitem')
        b.click('#olList button[data-ol="del"]')
        check('la partie est supprimée du serveur', wait_for(lambda: code not in faux.rows, 4000, pg=b))
        check('l’autre appareil est prévenu et revient à l’accueil', wait_for(lambda: a.is_visible('#home') and 'supprimée' in a.inner_text('#olErr'), 6000, pg=a), a.inner_text('#olErr'))
        check('aucune erreur JavaScript', not a.errors and not b.errors, a.errors + b.errors)

        print('Deux humains sans ordinateur (2 joueurs, 11 cartes au maximum)')
        da = device(browser, faux, url); login(da, 'max@example.com')
        da.fill('#n1', 'Max'); da.click('#segOppOl button[data-n="0"]'); da.click('#btnNew'); da.wait_for_selector('#wait:not([hidden])')
        dcode = da.inner_text('#waitCode').strip()
        check('2 joueurs : 21 donnes prévues', len(faux.rows[dcode]['etat']['sizes']) == 21 and faux.rows[dcode]['etat']['n'] == 2)
        db = device(browser, faux, url); login(db, 'claire@example.com'); db.fill('#n1', 'Max')
        db.fill('#olCode', dcode); db.click('#btnOlJoin'); db.wait_for_selector('#game:not([hidden])')
        check('deux prénoms identiques : le second est distingué', state(faux, dcode)['names'] == ['Max', 'Max (2)'], state(faux, dcode)['names'])
        da.context.close(); db.context.close()

        print('Contre l’ordinateur (sans réseau)')
        s = device(browser, faux, url)
        patches0, rows0 = faux.patches, dict((k, v['version']) for k, v in faux.rows.items())
        s.click('#btnNew')
        s.wait_for_selector('#game:not([hidden])')
        check('solo : 3 joueurs (toi et 2 ordinateurs), une carte', s.locator('#opps .opp').count() == 2 and s.locator('#hand .card').count() == 1)
        check('solo : pas de bouton « Afficher la table »', not s.is_visible('#btnTable'))
        solo_ok = play_until([s], lambda: round_open(s), budget=60)
        check('solo : la donne va jusqu’au bout', solo_ok)
        if solo_ok:
            s.evaluate("() => document.querySelector('#roundBody [data-act=next]').click()")
            check('solo : donne 2', wait_for(lambda: 'Donne 2' in s.inner_text('#roundTitle'), 4000, pg=s))
            s.click('#btnMenu'); s.click('#btnQuit')
            s.wait_for_selector('#home:not([hidden])')
            check('solo : « Reprendre la partie » proposé', s.is_visible('#btnResume'))
            s.click('#btnResume')
            s.wait_for_selector('#game:not([hidden])')
            check('solo : reprise à la donne 2 avec 2 cartes', 'Donne 2' in s.inner_text('#roundTitle') and s.locator('#hand .card').count() == 2)
        check('solo : aucune écriture sur le serveur', faux.patches == patches0 and dict((k, v['version']) for k, v in faux.rows.items()) == rows0)
        check('aucune erreur JavaScript (solo)', not s.errors, s.errors)

        sw = (ROOT / 'sw.js').read_text()
        check('le service worker ne met jamais en cache les requêtes vers un autre site', "origin !== self.location.origin" in sw and 'en-ligne.js' in sw)
        browser.close()
    failed = [n for n, ok in RESULTS if not ok]
    print('\n%d vérifications, %d échec(s)' % (len(RESULTS), len(failed)))
    for n in failed:
        print('  ECHEC : ' + n)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
