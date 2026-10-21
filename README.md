# Le Contrat

Jeu de plis aux 22 atouts du Tarot (I à XXI et l'Excuse), de 2 à 5 joueurs, sur le principe du Whist-ascenseur. À chaque donne, on annonce le nombre exact de plis qu'on va faire ; le moins de points gagne. Fonctionne en local et hors ligne.

Trois modes : contre l'ordinateur (1 à 4 adversaires), à plusieurs en se passant l'appareil (2 à 5 joueurs, un écran masque la main entre les tours), et à deux face à face sur un iPad posé à plat.

## Règles

- Donnes de 1, 2, 3… cartes jusqu'au maximum, puis retour à 1 : 7 donnes à 5 joueurs (max 4 cartes), 9 à 4 (max 5), 13 à 3 (max 7), 21 à 2 (max 11).
- Paris à tour de rôle à partir du premier servi (à gauche du donneur). Le donneur parle en dernier et ne peut pas porter la somme des paris au nombre de plis en jeu.
- Hauteur libre : on joue la carte qu'on veut. La plus forte remporte le pli et entame le suivant. L'Excuse vaut 0 ou 22 au choix, au moment où on la joue.
- Marque : contrat tenu = 0 ; sinon 1 point par pli d'écart, doublé si l'Excuse était dans la main ; 1 point de pénalité quand l'Excuse est servie pour la 3<sup>e</sup> fois (le compte repart ensuite de zéro).

## Fichiers

`engine.js` (règles, marque, IA), `app.js` (interface), `index.html`, `sw.js` et `manifest.webmanifest` (PWA hors ligne), `icons/`.
