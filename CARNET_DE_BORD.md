# Carnet de bord

Journal des opérations du projet, pour pouvoir le reprendre sans rien perdre. Les entrées récentes sont en bas ; l'état courant est résumé en tête.

## État courant

- Modes : contre l'ordinateur (hors ligne) et **en ligne** (2 humains sur 2 appareils + 0 à 3 ordinateurs), avec **plateau** optionnel (iPad en affichage seul). « On se passe l'appareil » et « face à face » supprimés.
- Version 2. Testé en navigateur simulé uniquement ; l'en ligne et le plateau n'ont pas encore été essayés sur de vrais appareils pour ce jeu.

## À faire

- Essayer l'en ligne sur de vrais appareils (2 téléphones) puis avec un iPad en plateau ; vérifier que le vrai Supabase accepte la ligne `jeu = 'plateau'` (les téléphones gardent la table sinon).
- Pas de mode facile (décision de l'auteur).

## Historique avant 2026-11-13

Version 1 : jeu complet (moteur, ordinateur à Monte-Carlo, conseils de pari et de carte), modes ordinateur / on se passe l'appareil / face à face, PWA hors ligne, licence « Tous droits réservés ». Ce carnet n'existait pas : cet historique est reconstitué à partir du dépôt.

## Version 2 (13/11/2026) — En ligne et plateau

Décisions de l'auteur : 2 humains au plus, ordinateurs pour compléter la table, mains cachées par confiance ; l'en ligne remplace les modes à un seul appareil ; plateau commun pour ce jeu à main cachée, contenu validé : pli en cours, paris, plis pris, scores, tour courant ; en ligne et plateau livrés ensemble ; pas de mode facile.

Opérations :

1. `en-ligne.js` copié de 5 Rois (identique). `sw.js` : cache `lecontrat-v2`, `en-ligne.js` ajouté, requêtes d'un autre site jamais mises en cache (la version 1 les mettait en cache : une coupure réseau pouvait être masquée).
2. `index.html` : modes « Contre l'ordinateur » / « En ligne », choix de 0 à 3 ordinateurs, prénom, panneau compte / code / parties en cours, salle d'attente, bannière « Hors ligne », écran `#plateau`, bouton « Afficher la table » ; suppression du voile, du face à face et de leurs styles.
3. `app.js` réécrit : suppression du code passe-passe / duo (voile, sièges, `reveal`) ; bloc En ligne (synchro d'état complet, conflit = l'état distant l'emporte, hôte seul à jouer les ordinateurs, résultats de donne et classement sur chaque appareil, « Rejouer ») ; plateau (signe de vie dans une ligne séparée, détection côté téléphone) ; `render()` n'enregistre plus (seules les actions le font, sinon chaque affichage aurait écrit sur le serveur). `engine.js` : champ `veil` retiré.
4. Pas d'« atout » dans ce jeu (les 22 cartes sont toutes des atouts) : le plateau n'en affiche pas ; il montre le nombre de cartes par joueur, les cartes écartées et le dernier pli remporté.
5. Tests : `tests/e2e/en_ligne.py` (74 vérifications : anciens modes ignorés, connexion, code inconnu, 3e personne refusée, mains cachées, droits de jeu, hors ligne puis envoi, reprise, plateau, donne suivante pressée en même temps, partie complète de 13 donnes jusqu'au classement sur 2 appareils + plateau, « Rejouer », fermeture du plateau sans prévenir puis réouverture, suppression, 2 humains sans ordinateur, noms identiques, solo avec reprise, service worker).
6. Corrigé pendant les essais : le bouton « Afficher la table » dans la barre du haut faisait déborder le titre → déplacé sur sa propre ligne ; la boucle des ordinateurs est relancée si l'état est remplacé pendant son attente.
