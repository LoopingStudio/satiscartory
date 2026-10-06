# Satiscartory

Un jeu en navigateur en deux moitiés :

1. **Usine**, à la Satisfactory, vue à la troisième personne. On extrait du minerai de fer et du latex, d’abord à la main puis avec des foreuses, on fond le minerai en lingots, on les façonne en plaques, tiges, boulons et pneus, puis on produit des pièces de voiture : roues, châssis, moteurs, panneaux, ailerons.
2. **Course**, à la Trackmania. On assemble un Kart ou une Sportive au garage, puis on court contre la montre (checkpoints, respawn, médailles) sur les circuits fournis ou sur ceux qu'on crée dans l'**éditeur à tuiles**.

Les assets viennent des kits Kenney (CC0) : [Car Kit](https://kenney.nl/assets/car-kit), [Factory Kit](https://kenney.nl/assets/factory-kit) et [City Kit Roads](https://kenney.nl/assets/city-kit-roads).

## Lancer

```bash
npm install
```

```bash
npm run dev
```

Le jeu tourne ensuite sur http://localhost:5173.

| Commande | Rôle |
|---|---|
| `npm test` | Tests Vitest : simulation d'usine, progression (minage à la main, établi, paliers), circuits, course, véhicule Rapier sans rendu, bot de course. |
| `npm run build` | Vérification de types et build de production. |
| `npm run manifest` | Régénère le manifest typé des modèles. |
| `node scripts/probe-connectors.mjs` | Mesure les tuiles de route dans les GLB. |

## Commandes

Les touches suivent la position physique. Les libellés ci-dessous et dans le jeu sont ceux d’un clavier AZERTY (sur QWERTY, ZQSD devient WASD et A devient Q).

### Usine

| Touche | Action |
|---|---|
| ZQSD | Se déplacer |
| Maj | Courir |
| Espace | Sauter |
| 1 à 5 | Convoyeur, foreuse, fonderie, constructeur, assembleuse (une fois leur palier débloqué) |
| R | Tourner |
| Clic gauche | Poser (maintenu : tracer des convoyeurs) |
| F | Démonter |
| Maintenir E sur un gisement | Miner à la main : un minerai toutes les 0,75 s dans le sac (case libre, à 6 m au plus) |
| E | Utiliser une machine ou une foreuse : recette, « Charger » (sac puis hangar), « Prendre » (production vers le sac) |
| E sur le hangar | Onglets Hangar (échanges sac ↔ hangar), Établi (fabrication à la main) et Paliers (déblocage des bâtiments) |
| Tab ou I | Ouvrir le sac (3 rangées de 8 ; la dernière est la barre toujours visible en bas de l’écran). Glisser une case pour la déplacer, l’échanger ou la fusionner |
| A | Menu de construction |
| G | Garage |
| Échap | Fermer l'outil actif (construction, démontage) ; sans outil, pause |

### Course

| Touche | Action |
|---|---|
| Z / ↑ | Accélérer |
| S / ↓ | Freiner, marche arrière |
| Q, D / ← → | Tourner |
| Espace | Dérapage |
| Retour arrière | Respawn au dernier checkpoint |
| Suppr | Recommencer |
| Entrée | Réessayer après l'arrivée |
| Échap | Quitter |

La manette fonctionne aussi.

### Éditeur

| Touche | Action |
|---|---|
| Clic gauche | Poser |
| R | Tourner |
| Pg↑ / Pg↓ | Changer de niveau |
| X ou clic droit | Effacer |
| ZQSD | Déplacer la caméra |
| Clic droit glissé | Pivoter |
| Molette | Zoomer |
| Ctrl+Z | Annuler |
| Ctrl+S | Enregistrer |

« Tester » lance un essai, qui fixe le temps auteur et les médailles.

## Progression

Une nouvelle partie démarre avec un hangar vide et aucun bâtiment débloqué. On mine le fer à la main, puis on le travaille à l’établi du hangar : minerai → lingot, lingots → plaques ou tiges, tige → boulons. Ces pièces paient les **paliers** du hangar (sac d’abord, puis hangar), qui débloquent les bâtiments un par un :

| Palier | Coût | Débloque |
|---|---|---|
| 1. Extraction | 10 tiges | Foreuse, convoyeur |
| 2. Fonderie | 10 plaques, 10 tiges | Fonderie |
| 3. Constructeur | 30 plaques, 20 tiges, 40 boulons | Constructeur |
| 4. Assemblage | 60 plaques, 40 tiges, 120 boulons, 10 pneus | Assembleuse |

Ensuite, la chaîne du fer prend le relais : foreuse → fonderie (lingots) → constructeur (plaques, tiges, boulons). Une foreuse alimente exactement une fonderie, qui alimente exactement un constructeur (30 minerais, puis 30 lingots par minute). Les sauvegardes d’avant les paliers gardent tout débloqué.

## Architecture

```
src/
  core/        boucle à pas fixe (physique 60 Hz, usine 20 Hz), rendu, entrées, assets GLTF, Rapier
  data/        données de jeu : objets, recettes, bâtiments, paliers, carte, voitures, pièces, circuits, équilibrage
  factory/     sim/ (pure, déterministe, testée), view/ (instancing), build/ (construction), FactoryMode
  player/      contrôleur de personnage, caméra orbitale, avatar
  car/         stats et réglages (purs), modèle 3D
  vehicle/     raycast vehicle Rapier, caméra de poursuite, entrées
  track/       données, connecteurs, validation, édition (purs), construction, editor/
  race/        session de course, franchissement, médailles, records, bot (purs), RaceMode, sélection
  garage/      assemblage (pur), GarageMode
  state/       état de jeu, sauvegarde (localStorage), circuits utilisateur
  ui/          DOM, styles, textes FR, menus
  dev/         galerie, panneau de réglages véhicule, outils de test (window.T)
```

Les modules purs n'importent ni three ni Rapier, ce que vérifie `tests/purity.test.ts`.

Le plan de référence est dans `docs/PLAN.md`, les décisions dans `docs/DECISIONS.md`.

## Outils de dev (`npm run dev`)

| URL ou commande | Effet |
|---|---|
| `?mode=gallery` | Tous les modèles, contrôle des échelles, test Rapier |
| `?mode=factory&layout=demo` | Usine de démonstration (foreuses → fonderies → constructeurs : plaques, tiges, boulons, pneus) |
| `?mode=factory&layout=stress` | 2 100 objets sur les convoyeurs |
| `?mode=race&track=oval\|hill\|test\|drag\|pad&car=loaner\|kart\|kartr\|sport\|sportr` | Course directe |
| `?tune=1` ou F3 | Debug physique et panneau de réglages du véhicule |
| `window.T` | Automatisation par événements réels (`T.autopilot`, `T.drag`, `T.aimCell`…) |
