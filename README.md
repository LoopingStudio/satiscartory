# Satiscartory

Un jeu en navigateur en deux moitiés :

1. **Usine**, à la Satisfactory, vue à la troisième personne. On extrait du minerai de fer et du latex, d’abord à la main puis avec des foreuses, on fond le minerai en lingots, on les façonne en plaques, tiges, boulons et pneus, puis on produit des pièces de voiture : roues, châssis, moteurs, panneaux, ailerons.
2. **Course**, à la Trackmania. On assemble un Kart ou une Sportive dans un **garage** construit dans l'usine, on la conduit entre les machines, puis on court contre la montre (checkpoints, respawn, médailles) sur les circuits fournis ou sur ceux qu'on crée dans l'**éditeur à tuiles**.

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
| `npm test` | Tests Vitest : simulation d'usine, progression (minage à la main, établi, paliers), garage et voitures dans l'usine, circuits, course, véhicule Rapier sans rendu, bot de course. |
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
| 1 à 8 | Raccourcis du menu de construction : convoyeur, foreuse, fonderie, constructeur, assembleuse, garage, répartiteur, fusionneur (une fois leur palier débloqué) |
| R | Tourner (sur le fantôme d'un garage, une flèche bleue marque la porte). Un convoyeur posé contre une machine s'oriente seul pour s'y raccorder ; R l'oriente autrement sur cette case |
| Clic gauche | Poser (maintenu : tracer des convoyeurs ; viser une machine fait partir le tracé de sa sortie, ou l'arrêter devant son entrée) |
| F | Démonter |
| Maintenir E sur un gisement | Miner à la main : un minerai toutes les 0,75 s dans le sac (case libre, à 6 m au plus) |
| E sur un convoyeur | Prendre les objets de cette case dans le sac ; maintenu 0,5 s : ceux de toute la ligne (les convoyeurs reliés, en amont et en aval). Ce qui ne rentre pas dans le sac reste sur le convoyeur |
| E | Utiliser une machine ou une foreuse : recette, « Charger » (sac puis hangar), « Prendre » (production vers le sac) |
| E sur le hangar | Onglets Hangar (échanges sac ↔ hangar), Établi (fabrication à la main) et Paliers (déblocage des bâtiments) |
| E sur un garage | Panneau du garage : assembler une voiture dans sa place (d'un coup, ou pièce par pièce avec « Poser maintenant »), changer ses pièces, la démonter, choisir la voiture de course, « Courir ». Échap ou « Fermer » le referme |
| E près d'une voiture garée | Monter, à 3,2 m au plus (un bâtiment visé passe avant ; voir ci-dessous) |
| Tab ou I | Ouvrir le sac (3 rangées de 8 ; la dernière est la barre toujours visible en bas de l’écran). Glisser une case pour la déplacer, l’échanger ou la fusionner |
| A | Menu de construction : bâtiments par catégorie, miniature, coût (j'ai / il faut) et palier ; clic pour placer |
| Échap | Fermer l'outil actif (construction, démontage) ; sans outil, pause |

### Voiture dans l'usine

| Touche | Action |
|---|---|
| Z / ↑ | Accélérer |
| S / ↓ | Freiner, marche arrière |
| Q, D / ← → | Tourner |
| Espace | Frein à main |
| E | Descendre, seulement sous 3 m/s (environ 11 km/h) : la voiture reste garée là |
| Retour arrière | Replacer la voiture sur sa dernière position sûre |
| Entrée | Descendre (même condition) et choisir un circuit avec cette voiture |
| Échap | Pause |

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

### Manette

Une manette (Xbox, PlayStation, Switch Pro… en mapping standard) marche partout, à tout moment : la première pression la prend en compte, et les indications à l'écran passent alors à ses boutons (✕ ○ □ △ sur une manette PlayStation). Toucher le clavier ou bouger la souris les remet. Noms ci-dessous : boutons Xbox (A en bas, B à droite, X à gauche, Y en haut).

| Usine, à pied | |
|---|---|
| Stick gauche | Se déplacer (clic du stick : courir, jusqu'à ce qu'on le lâche) |
| Stick droit | Caméra (sensibilité dans les Réglages) ; ↑ : zoom (proche, normal, loin) |
| A | Sauter |
| X | Comme E : utiliser une machine, le hangar, un garage, monter en voiture ; maintenu : miner, prendre toute une ligne de convoyeur |
| Y | Menu de construction |
| ← / → | Bâtiment précédent / suivant (dans l'ordre du menu, ceux débloqués) |
| RT | Poser ; maintenu : tracer un convoyeur. En démontage : démonter |
| LB / RB | Tourner |
| B | Annuler le tracé, puis l'outil (comme le clic droit) |
| ↓ | Démontage |
| View | Sac |
| Menu | Pause |

| Voiture dans l'usine | Course |
|---|---|
| RT accélérer, LT freiner / marche arrière, stick gauche tourner, A frein à main | Pareil, A : dérapage |
| X : descendre (sous 11 km/h) | B : respawn au checkpoint |
| Y : choisir un circuit avec cette voiture | View : recommencer |
| B : replacer la voiture | Menu : quitter |
| Menu : pause | Arrivée : Réessayer (A ou Y), Circuits (B) |

| Menus et panneaux | |
|---|---|
| Croix ou stick gauche | Choisir (un cadre bleu marque le bouton visé, une bulle dit ce que la souris montrerait au survol) |
| A | Valider ; maintenu sur « Maintenir » à l'établi : fabriquer |
| B | Retour, fermer, annuler une confirmation (Y ferme aussi le menu de construction, View le sac) |
| LB / RB | Onglets du hangar ; circuit précédent / suivant ; voiture précédente / suivante dans un garage |
| Stick droit | Faire défiler |
| ← / → | Régler un curseur, changer de voiture au départ d'une course |
| X | Sac (au hangar ou dans le sac) : prendre une case, puis A (ou X) sur sa nouvelle place pour la ranger, ou sur le hangar pour la déposer |

| Éditeur | |
|---|---|
| Stick gauche, stick droit | Déplacer, pivoter la caméra |
| LT / RT | Zoomer |
| A, X | Poser, effacer (au réticule du centre de l'écran) |
| LB / RB | Tourner |
| ← / → | Pièce précédente / suivante |
| ↑ / ↓ | Niveau |
| View, Menu, Y | Annuler, enregistrer, tester |
| B | Quitter (une confirmation demande si le circuit n'est pas enregistré) |

Le navigateur ne donne pas le pointer lock à la manette : en jouant à la manette, la visée reste au centre de l'écran sans verrouiller la souris. Un clic sur le jeu rend la caméra à la souris.

## Progression

Une nouvelle partie démarre avec un hangar vide et aucun bâtiment débloqué. On mine le fer à la main, puis on le travaille à l’établi du hangar : minerai → lingot, lingots → plaques ou tiges, tige → boulons. Ces pièces paient les **paliers** du hangar (sac d’abord, puis hangar), qui débloquent les bâtiments un par un :

| Palier | Coût | Débloque |
|---|---|---|
| 1. Extraction | 10 tiges | Foreuse, convoyeur, répartiteur, fusionneur |
| 2. Fonderie | 10 plaques, 10 tiges | Fonderie |
| 3. Constructeur | 30 plaques, 20 tiges, 40 boulons | Constructeur |
| 4. Assemblage | 60 plaques, 40 tiges, 120 boulons, 10 pneus | Assembleuse |
| 5. Garage | 80 plaques, 60 tiges, 160 boulons, 8 pneus | Garage |

Ensuite, la chaîne du fer prend le relais : foreuse → fonderie (lingots) → constructeur (plaques, tiges, boulons). Une foreuse alimente exactement une fonderie, qui alimente exactement un constructeur (30 minerais, puis 30 lingots par minute). Les sauvegardes d’avant les paliers gardent tout débloqué, et une sauvegarde qui avait tous les paliers de sa version reçoit ceux ajoutés depuis (le garage).

## Raccorder les machines

Chaque machine montre où brancher un convoyeur : devant chaque **sortie**, une flèche **orange** flotte au-dessus d'un cadre au sol ; devant chaque **entrée**, une flèche **bleue** pointe vers la machine. Une foreuse n'a que des sorties, sur sa face avant ; fonderie, constructeur et assembleuse reçoivent par l'arrière et rendent par l'avant. Hors construction, seuls les côtés encore libres sont marqués ; avec un outil de construction en main, tous les ports libres clignotent.

- **Poser un convoyeur** : sur la case d'une flèche, ou en visant la machine, le fantôme s'oriente seul (il reçoit la sortie, ou alimente l'entrée). Une flèche verte montre chaque liaison et l'indication du bas dit « ✓ reçoit : Foreuse · alimente : Fonderie ». Un clic sans bouger pose exactement le fantôme affiché.
- **Tracer** : viser une machine part de sa sortie ; viser le bout d'un convoyeur le prolonge ; finir sur une machine s'arrête devant son entrée la plus proche et y tourne la dernière tuile. Le sens suit les ports : un convoyeur va toujours d'une sortie vers une entrée, même tracé dans l'autre sens (partir de la flèche bleue d'une entrée trace un convoyeur qui y arrive). Le tracé en L contourne les bâtiments quand l'autre ordre est libre.
- Une machine ne sort que par **une** sortie à la fois : dès qu'une est reliée, l'autre n'est plus marquée.
- **Répartiteur** (touche 7) : ce qui entre par l'arrière sort tour à tour à l'avant, à gauche et à droite ; une sortie sans convoyeur ou bouchée est sautée, rien ne s'arrête tant qu'une sortie reste libre. Pour alimenter plusieurs machines depuis une seule ligne.
- **Fusionneur** (touche 8) : jusqu'à trois arrivées (arrière, gauche, droite) réunies en une seule vers l'avant, chacune à son tour. Un convoyeur qui arrive sur le flanc d'un autre fusionne aussi, comme avant.
- **Cul-de-sac** : une croix rouge marque un convoyeur qui bute contre un bâtiment qui refuse ses objets (une sortie, un mur de machine, un convoyeur en face), et les sorties d'une machine qui donnent toutes sur un bâtiment.
- Le panneau d'une foreuse ou d'une machine (E) dit si son entrée et sa sortie sont reliées.
- **Ramasser sur un convoyeur** : E prend les objets de la case visée ; maintenir E (0,5 s) prend ceux de toute la ligne, en surbrillance pendant qu'on vise. Ça marche aussi sur un répartiteur ou un fusionneur, et la ligne les traverse. Pratique pour vider une ligne bouchée ou se servir au passage.

## Garage et voitures

Le garage est un bâtiment de l’usine (touche 6, palier 5 ; 40 plaques, 24 tiges, 80 boulons). Il occupe 3×4 cases et abrite **une** place de voiture : des murs sur trois côtés, toute la face avant ouverte en porte, que marque une flèche bleue sur le fantôme. Il n’y a plus de touche G ni d’écran Garage à part.

- **E sur un garage** ouvre son panneau sans quitter l’usine : la caméra cadre la place depuis la porte, les colonnes laissent la voiture visible au milieu. On y assemble une voiture (la place doit être libre ; le sac paie d’abord, puis le hangar), qu’un fantôme montre dans la place avant l’assemblage. On change les pièces de la voiture garée là ou on la démonte (pièces dans le sac, le surplus au hangar), on choisit la voiture de course (★), et « Courir » ouvre le choix du circuit avec elle.
- **Les voitures restent garées** dans l’usine, là où on les laisse, et se conduisent (commandes ci-dessus). Elles traversent les lignes de convoyeurs, qui sont au sol ; machines, murs et voitures garées restent solides. Dans l’usine, la vitesse est plafonnée à 90 km/h environ. Le kart de location ne roule que sur les circuits.
- **Construire pièce par pièce** : dans le brouillon d'une nouvelle voiture, « Poser maintenant » met dans la place ce qu'on a d'une pièce (deux roues, par exemple) sans attendre le reste. La voiture en construction reste dans le garage : pièces posées en couleur, le reste en transparence, des chandelles jaunes sous les roues manquantes, la carrosserie en métal nu tant qu'il manque des panneaux, le moteur posé sur son essieu. Son panneau dit ce qui est posé (« 3/6 pièces »), pose la suite ou retire une pièce (rendue au sac). La voiture sort, numérotée et choisie pour courir, dès que les pièces obligatoires y sont ; « Abandonner » rend tout.
- Un garage où une voiture est garée ou en construction ne se démonte pas, et on ne construit pas sur une voiture.
- Sauvegardes : les voitures d’une ancienne sauvegarde se garent dès le premier garage construit, une par garage libre ; les autres attendent le suivant.

## Architecture

```
src/
  core/        boucle à pas fixe (physique 60 Hz, usine 20 Hz), rendu, entrées (clavier, souris, manette), assets GLTF, Rapier
  data/        données de jeu : objets, recettes, bâtiments, paliers, carte, voitures, pièces, circuits, équilibrage
  factory/     sim/ (pure, déterministe, testée), view/ (instancing), build/ (construction), cars/ (voitures garées et conduites), FactoryMode
  player/      contrôleur de personnage, caméra orbitale, avatar
  car/         stats et réglages (purs), modèle 3D
  vehicle/     raycast vehicle Rapier, caméra de poursuite, entrées
  track/       données, connecteurs, validation, édition (purs), construction, editor/
  race/        session de course, franchissement, médailles, records, bot (purs), RaceMode, sélection
  garage/      assemblage, actions et places de garage (purs), GaragePanel (panneau dans l'usine)
  state/       état de jeu, sauvegarde (localStorage), circuits utilisateur
  ui/          DOM, styles, textes FR, menus, navigation des menus à la manette, confirmations
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
| `window.T` | Automatisation par événements réels (`T.autopilot`, `T.drag`, `T.aimCell`…) et manette virtuelle servie par `navigator.getGamepads()` (`T.pad.press('a')`, `T.pad.tilt('left', 0, -1, 500)`, `T.pad.trigger('right', 1)`, `T.padFocus()`) |
