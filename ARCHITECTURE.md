# Architecture

Application web statique (PWA), sans compilation ni serveur : HTML + JavaScript « classique ». Aucune bibliothèque tierce. Hébergée sur GitHub Pages.

## Fichiers

```
index.html            Écrans (accueil, partie, plateau), styles, modales (règles, scores, donne, Excuse, menu), salle d'attente, bannière « Hors ligne »
engine.js             Moteur pur : cartes, donnes, paris, plis, marque, ordinateur (window.Engine)
en-ligne.js           Brique commune « En ligne » (copie identique dans chaque jeu) : connexion, parties, synchro (window.EnLigne)
app.js                Interface et logique des modes (solo, en ligne, plateau)
sw.js                 Service worker : cache hors ligne (réseau d'abord) ; ne met jamais en cache une requête vers un autre site
manifest.webmanifest, icons/    PWA
tests/e2e/en_ligne.py Deux appareils + plateau + solo simulés (Chromium) + faux Supabase en mémoire (74 vérifications)
```

Ordre de chargement : `engine.js`, `en-ligne.js`, `app.js`. Règle : changer `APP_VERSION` (app.js) et `CACHE` (sw.js) ensemble à chaque livraison.

## Moteur (`engine.js`)

`newGame({mode, names, human})` crée l'état et distribue la donne 0 ; `placeBet(G, b)`, `playCard(G, id, val)` (val = 0 ou 22 pour l'Excuse), `nextDeal(G)`, `forbiddenBet`, `legalBets`, `ranking`, `botBet(G, p, échantillons)` (Monte-Carlo), `botPlay(G, p)`. Il n'y a pas d'« atout » au sens d'une couleur : les 22 cartes sont toutes des atouts (0 = Excuse, 1 à 21).

Les distributions sont aléatoires : l'état complet est recopié tel quel entre appareils (pas de rejeu d'actions).

## État de partie (`G`)

`mode ('solo'|'online'), n, names[], human[], sizes[], deal, dealer, scores[], excuseCount[], history[], over`, et pour la donne en cours : `hands[][], aside, k, first, turn, bets[], won[], betCount, trick[], trickNo, lastTrick, showLast, last, result, phase ('bet'|'play'|'dealEnd'|'over'), hadExcuse[], streakHit[]`. En ligne : `G.online = {uids:[uid hôte, uid invité|null], joined}`.

## Modes

| Mode | Appareils | Détails |
|---|---|---|
| `solo` | 1 | toi + 1 à 4 ordinateurs, sauvegarde locale (`lecontrat_partie_v1`) |
| `online` | 2 humains + 0 à 3 ordinateurs (+ un plateau optionnel) | synchro Supabase, voir ci-dessous |

Les anciens modes « on se passe l'appareil » et « face à face » sont supprimés ; une ancienne sauvegarde ou préférence de ces modes est ignorée.

## Mode en ligne

Fournisseur : Supabase (projet « plan-du-jour », table `parties`, accès réservé aux comptes connectés). Requêtes `fetch` seulement. Le jeu est `lecontrat`. Session partagée sous `foyer_session_v1`.

**Synchro par état complet avec contrôle de version** : après chaque action, `save()` marque l'état « à envoyer » et `pushState()` écrit tout `G` si la version du serveur est celle qu'on connaît. En cas de conflit, **l'état distant l'emporte** et l'action locale est annulée avec un message. Un seul joueur agit à la fois ; le seul cas simultané est « Donne suivante » pressé par les deux, où le premier gagne. `render()` n'écrit jamais : seules les actions (`afterHuman`, boucle des ordinateurs, `onAct`) appellent `save()`. Un coup joué hors ligne part au retour du réseau (bannière `#offbar`).

**Surveillance** : toutes les 1,5 s la version est lue ; si elle a changé, l'état est relu (`onRemote` → `takeRemote` → `onlineShow`). `onlineShow` choisit l'écran : salle d'attente, partie, résultats de donne ou classement final.

**Rôles** : siège 0 = hôte, seul à jouer les ordinateurs (`advance()` ne tourne pas chez l'invité). `viewer()` = siège de l'appareil ; `isTurnOf(p)` exige que ce soit son tour. Les résultats de donne s'ouvrent sur chaque appareil (`scheduleRound`). « Rejouer » (`restartOnline`) recommence la partie dans la même ligne, mêmes joueurs, scores à zéro.

**Mains cachées** : l'état contient toutes les mains ; l'interface n'affiche que celle de l'appareil (les autres joueurs sont montrés par un éventail de dos). Choix assumé : pas de protection contre la lecture du réseau.

## Plateau (iPad en affichage seul)

Écran `#plateau`, ouvert depuis le panneau En ligne (« Ouvrir comme plateau »). Il ne prend aucun siège et n'écrit jamais dans la ligne de la partie (sinon, avec « l'autre gagne », il pourrait faire perdre un coup). Il la lit seulement (`surveiller` → `plRemote` → `plRender`) : joueurs (dos de cartes, nombre de cartes, score, pari, plis pris, donneur, tour), pli en cours ou dernier pli, résultats de la donne (`roundHTML(true)` : sans bouton), historique des scores et classement final (`endHTML(true)`).

**Signe de vie** : le plateau écrit dans une ligne séparée de la table `parties` (`jeu = 'plateau'`, `titre` = code de la partie), au lancement, 1,5 s après, puis toutes les 10 s (`plBeat`). Il réutilise la ligne existante de même titre et la supprime en quittant. **Côté téléphone** (`platWatch`) : toutes les 5 s, `EL.liste('plateau')` ; si la version de cette ligne a changé depuis moins de 30 s, `ONL.plat.present` passe à vrai et `#game.notable` cache les adversaires et le pli. Le premier passage note seulement la version (un reste d'une séance précédente ne cache donc pas la table). Pas de comparaison d'horloges entre appareils. `ONL.plat.override` (bouton « Afficher la table ») force la table ; il retombe quand le plateau disparaît. Réglages de test : `window.PLATEAU_POLL`, `PLATEAU_BEAT`, `PLATEAU_FRESH`, `window.BOT_DELAY`.

Hypothèse à vérifier sur le vrai Supabase : la table `parties` accepte `jeu = 'plateau'`. Sinon les téléphones gardent simplement la table, sans erreur.

## Sauvegardes (localStorage)

| Clé | Contenu |
|---|---|
| `lecontrat_partie_v1` | partie locale (solo) |
| `lecontrat_prefs_v1` | mode, nombre d'adversaires (solo et en ligne), conseils, prénom |
| `lecontrat_online_v1` | partie en ligne → siège de cet appareil |
| `foyer_session_v1` | session de connexion (partagée entre les jeux) |
