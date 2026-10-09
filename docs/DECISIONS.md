# Décisions

Choix tranchés pendant le développement (le plan de référence est `docs/PLAN.md`).

## P0

- **Versions épinglées** : three 0.186, @dimforge/rapier3d-compat 0.21.0 (version exacte), Vite 8, Vitest 5, TypeScript 7 (compilateur natif).
- **Ombres** : `PCFShadowMap`, car `PCFSoftShadowMap` est déprécié dans three 0.186.
- **Matériaux Kenney** : chaque kit a sa propre `colormap.png`. On garde un seul matériau partagé par kit, en conservant le `doubleSided` d'origine des GLB.
- **Sonde de connecteurs** : faite en Node (`scripts/probe-connectors.mjs`, lecture GLB + PNG maison sans dépendance), pas en jeu. Elle écrit `src/data/generated/roadProbe.json`, que les tests vérifient.
  - La route est la zone dont la luminance est < 170 : asphalte, caniveaux et marquages, à l'exclusion des trottoirs lavande.
  - Mesures :
    - `road-straight` est orientée selon **±X** (et non ±Z).
    - `road-bend` relie **+Z et -X**.
    - `road-curve` (2×2) relie la case (0,0) côté -X à la case (1,1) côté +Z.
    - `road-slant` monte d'un niveau (0,25 tuile) de -X vers +X, `road-slant-high` de deux.
    - `road-bridge` est un tablier à 0,5 tuile orienté ±Z.
    - Largeur de route : environ 0,85 tuile, soit environ 10 m à `TRACK_CELL = 12`.
- **Convention des côtés** : 0 = +Z, 1 = +X, 2 = -Z, 3 = -X. Une rotation `r` (`rotation.y = r·π/2`) envoie le côté s sur s+r et le décalage (dx, dz) sur (dz, -dx).
- **Pureté des modules** : vérifiée par un test Vitest (`tests/purity.test.ts`) qui scanne les imports, plutôt que par ESLint (moins d'outillage).
- **Bundle** : environ 5 Mo de JS, dont le WASM Rapier inliné en base64 par le paquet `-compat`. C'est acceptable pour la tranche, et la limite d'avertissement est relevée à 6 Mo.

## P1

- **Emprises** (remplacé en octobre 2026, voir « Retours usine ») :
  - Presse, assembleuse et foreuse occupent 1×2 cases. Elles reçoivent par l'arrière et les côtés de la case arrière, et sortent par l'avant de la case avant. Les modèles `machine*` s'écoulent le long de Z et sont étirés à (1,6 ; 1,6 ; 2,55).
  - Le hangar occupe 3×3 cases et accepte sur tous ses bords extérieurs.
- **Fusion des convoyeurs** : pas de bâtiment dédié. Un convoyeur accepte par l'arrière et par les côtés, en tourniquet sans état transitoire : `lastFrom` est persisté, et le tour passe si un autre alimenteur est prêt.
- **Forme des convoyeurs** : déduite des alimenteurs.
  - Côté seul : `conveyor-corner`, inversé par `scale.x = -1` pour la droite.
  - Plusieurs alimenteurs : `conveyor-junction-t`.
  - Sinon : `conveyor-stripe`.
- **Ordre de traitement** : les convoyeurs sont traités de l'aval vers l'amont (chaînes remontées puis inversées) pour libérer l'espace d'abord. Le reste est traité dans l'ordre des id.
- **Déterminisme** : entiers uniquement. Le hash est calculé sur un JSON canonique (clés triées). Test : 1000 ticks, sauvegarde, chargement, puis 1000 ticks donnent le même résultat que 2000 ticks d'affilée.
- **Gisements** : rendus avec des roches procédurales (icosaèdres en ombrage plat) teintées, faute de modèle de roche dans les trois kits.
- **Texture partagée** : un plugin `GLTFLoader` renvoie une seule texture `colormap` par kit au lieu de 288 décodages PNG. Le chargement complet passe d'environ 10 s à moins de 3 s.

## P2

- **Pointer lock** : s'il est refusé ou indisponible (navigateur intégré, permission), le jeu bascule en **curseur libre**. La visée suit le curseur et le clic droit maintenu tourne la caméra. En pointer lock, la visée part du centre de l'écran.
- **Visée en construction** : le rayon vise le plan du sol (y = 0) plutôt que les colliders, pour pouvoir construire derrière une machine. Hors construction (démontage, interaction), le rayon Rapier touche le premier collider. (Depuis « Relief et herbe », le rayon ne voit que le sol, relief compris : on construit toujours derrière une machine, et une colline arrête la visée.)
- **Marche** : l'autostep monte à 0,9 m, ce qui permet de monter sur les convoyeurs (0,8 m) comme dans Satisfactory. Les machines (2,1 m) bloquent.
- **Le tracé de convoyeur** est en L (axe majeur d'abord), 64 tuiles maximum. Les tuiles non payables apparaissent en rouge.
- **Avatar** : `oopi` est décentré dans son GLB et regarde vers -X. Il est recentré via sa bbox et tourné de π/2 dans un pivot.
- **Sauvegarde** :
  - Clé `satiscartory.save.v1`, avec un emplacement de secours `.bak`.
  - Écriture toutes les 30 s, à chaque changement de mode, sur `visibilitychange` (hidden) et sur `beforeunload`.
  - Le stress test est marqué `ephemeral` et n'est jamais sauvegardé.
- **Outils de test** : `window.T` (dev seulement) pilote le jeu par des événements synthétiques (touches, souris, visée de cellule).

## P3

- **Véhicule** : `DynamicRayCastVehicleController` de Rapier.
  - `setIndexForwardAxis = 2` et essieu `(-1, 0, 0)` ; un angle de braquage positif tourne à gauche (+X). Les tests sans rendu verrouillent ces conventions.
  - Freins : Rapier les prend comme une **impulsion** par pas, donc on applique `force × dt / 4`.
  - Centre de masse entre les essieux, 0,25 m sous le centre de la caisse. Inerties de roulis et de tangage gonflées (×1,8 et ×2,2) pour éviter les tonneaux.
- **Stats → physique** : la traînée quadratique est calibrée pour que la vitesse de pointe émerge (`engine × 0,92 = k·v²`, plus 8 % de résistance au roulement). Vitesses de pointe mesurées à ±10 % (test).
- **Herbe** : le sol hors piste est roulable mais très freinant (vitesse de pointe d'environ 60 km/h). Trackmania n'a pas de mur invisible, et couper par l'herbe ne paie pas.
- **Pièces à barrières** : les modèles `road-*-barrier` ne contiennent **que** les barrières (pas de route), et `road-straight-barrier` est modélisé selon Z (rotation +1). Ce sont donc des pièces composites (route + barrières).
- **Caisse du kart** : le mesh racine `kart-oopi` a les roues et le pilote pour enfants, donc la boîte de caisse se calcule sur la géométrie du nœud seul. `setFromObject` englobait les descendants, ce qui remontait le centre de masse et faisait cabrer le kart.
- **Boucle** : un chien de garde `setInterval` relance les frames quand `requestAnimationFrame` est suspendu (vue intégrée masquée). Les onglets en arrière-plan bridant aussi les timers, rien n'est accéléré.
- **Outils de dev** :
  - `?mode=race&track=test|drag|pad&car=kart|kartr|sport|sportr` lance une course directement.
  - `?tune=1` (ou F3) ouvre le panneau de réglages lil-gui.
  - `T.autopilot(points)` conduit avec de vrais événements clavier.

## P4

- **Chronométrage** :
  - Le temps se compte en ticks de physique (60 Hz), avec une précision sous le tick : le segment parcouru pendant le tick est intersecté avec le plan du portique, et la fraction donne le temps.
  - Pas de raté possible à 300 km/h (test).
- **Règles** (façon Trackmania) :
  - Les CP comptent dans n'importe quel ordre ; l'arrivée ne compte que si tous les CP sont passés.
  - Retour arrière : respawn au dernier CP, le chrono continue.
  - Suppr : redémarrage complet.
  - Entrée : réessayer après l'arrivée.
- **Kart de location** : toujours disponible, plus lent (120 km/h) et moins adhérent, pour pouvoir courir tout de suite. Construire son kart est une vraie amélioration.
- **Médailles** :
  - Ratios : or ×1,07, argent ×1,18, bronze ×1,5 du temps auteur.
  - Temps auteur des circuits officiels : meilleur temps du bot sans rendu ×0,96, après un balayage de ses paramètres (`CALIBRATE=1 npx vitest run tests/race-sim.test.ts`, résultat dans `docs/medal-calibration.tsv`).
  - Résultat : la location vise le bronze, sa propre voiture l'argent, les améliorations l'or.
- **Simulation sans rendu** : `tests/helpers/raceSim.ts` reconstruit le trimesh depuis les GLB et fait rouler le `Bot` (TS pur) avec le vrai `Vehicle`, la `RaceSession` et `crossGate`. Le test exige que chaque circuit officiel soit bouclable par le bot avec la location.
- **Axe central** (`track/layout.centerline`) : milieux d'arêtes partagées et milieu d'arc dans les virages, avec une vitesse indicative `sqrt(32·r)`. Il sert au bot et à `T.autopilot`, qui traduit les commandes du bot en vraies touches.
- **Caméra de poursuite** : un rayon voiture → caméra la rapproche devant les obstacles (poteaux de portique).

## P5

- **Occupation 2D** : une seule pièce par case, quel que soit le niveau. Les ponts au-dessus d'une route ne sont pas pris en charge dans la tranche. Poser une pièce **remplace** ce qu'elle chevauche (fantôme orange). Poser un départ supprime l'ancien.
- **Ancre** : la case visée devient le coin minimal de l'emprise tournée, ce qui couvre aussi les pièces 2×2 et 2×1.
- **Validation** : toute modification efface les médailles. Un essai terminé depuis l'éditeur fixe le temps auteur (on garde le meilleur) et les médailles en découlent (or ×1,07, argent ×1,18, bronze ×1,5).
- **Raccourcis** :
  - Ctrl+Z et Ctrl+S lisent `KeyboardEvent.key`, ce qui marche sur tous les claviers.
  - Les déplacements utilisent `code` (ZQSD sur AZERTY).
  - Le clic droit **sans glisser** efface, le clic droit glissé fait pivoter la caméra.
- **Aperçu** : l'éditeur reconstruit tout le circuit (mesh fusionné) à chaque modification avec `buildTrack(…, world = null)`, sans collider. C'est instantané jusqu'à quelques centaines de pièces.
- **Stockage** : clé localStorage `satiscartory.tracks.v1`. Les circuits officiels se copient dans l'éditeur au lieu de se modifier.

## P6

- **Chargement et collecte manuels** (comme l'insertion à la main dans Satisfactory) :
  - Le panneau d'une machine peut **charger depuis le hangar** les entrées de sa recette, jusqu'à 10× la quantité de la recette ; les convoyeurs restent plafonnés à 2×.
  - Il peut aussi **récupérer la production** vers le hangar.
  - Les convoyeurs restent la voie automatique. Le manuel évite d'imposer une usine complète pour un premier kart.
- **Économie de départ** (remplacée en octobre 2026 par un hangar vide, voir « Progression façon Satisfactory ») : 100 plaques et 60 boulons. Le test `objectives.test.ts` vérifie qu'on paie les deux chaînes (fer et caoutchouc), une assembleuse, 25 convoyeurs et les pièces du kart. Le premier essai à 70/36 laissait un joueur à 0 plaque sans chaîne de fer, donc bloqué.
- **Objectifs d'accueil** (réécrits en octobre 2026, voir « Progression façon Satisfactory »), dans l'ordre :
  1. Plaques (fer)
  2. Foreuse sur le caoutchouc
  3. Presse « Pneu »
  4. Assembleuse
  5. Pièces
  6. Assemblage
  7. Course avec sa voiture
  8. Bonus : la Sportive

  Ils sont mémorisés dans la sauvegarde.
- **Garage** (devenu un bâtiment de l'usine en octobre 2026, voir « Garage dans l'usine ») :
  - Assemblage par emplacement : roues standard ou racing, aileron optionnel.
  - Les barres de stats se comparent à la voiture de course actuelle.
  - On peut changer une pièce (échange avec le stock) ou démonter la voiture, ce qui rembourse ses pièces.
  - La voiture assemblée devient la voiture de course (★).
- **Touche G** (supprimée en octobre 2026, voir « Garage dans l'usine ») : ouvrait le garage depuis l'usine. Le panneau du hangar (E) y menait aussi.
- **Poteaux des portiques** : déplacés juste hors de la tuile. Sur le trottoir, ils accrochaient les voitures en sortie de virage.

## P7 : revue adverse (16 défauts confirmés, tous corrigés et couverts par des tests)

- **Arrivée orientée** : franchir l'arrivée à contre-sens (sens du parcours validé, `finishDirections`) ne compte jamais. Un compteur net (passages en avant moins passages en arrière) empêche de reculer puis repasser. La validation exige **au moins un checkpoint**. Elle traverse une arrivée atteinte avant tous les CP, comme le fait la course.
- **Temps** :
  - Arrondis à la milliseconde **à la source** (RaceSession), donc médailles, records, temps auteur et HUD concordent.
  - Le tick du GO est le premier tick chronométré.
  - Les essais interrompus (restart, quitter) comptent comme tentatives.
- **Éditeur** :
  - L'état « non enregistré » traverse l'essai.
  - Enregistrer un tracé modifié **efface le record** associé (comme un nouvel UID de map).
  - L'aperçu applique les mêmes limites que la pose.
- **Garage et état** :
  - Choisir le kart de location (`null`) survit au rechargement ; un id de voiture disparu retombe sur la première voiture.
  - « Pièces disponibles » tient compte des roues racing en stock (`bestChoices`).
  - L'objectif « course » est validé dès qu'on finit avec sa propre voiture, record ou pas.
- **Véhicule** :
  - Le respawn automatique se déclenche aussi pour une voiture couchée sur le flanc (`up.y < 0,5`, ou moins de 3 roues au sol, à l'arrêt).
  - Le frein à main **s'ajoute** au frein.
  - La boucle n'a plus de `dt` négatif et ses alphas restent dans [0, 1].
  - Masse et centre de masse retirés du panneau de réglages : ils sont figés à la création du corps.
- **Rejetés après vérification** : types de pièces `Object.prototype` (inatteignable) et poteaux de portique absents de la simulation du bot (ils sont hors de la route).

## Inventaire (sac du joueur)

- **Sac** : 24 emplacements, avec une taille de pile par objet (`data/items.ts`, champ `stack`) : 100 minerais ou plaques, 200 boulons, 10 moteurs, etc. Il est sauvegardé avec la partie et nettoyé au chargement (objets inconnus ignorés, piles plafonnées).
- **« Sac d'abord, puis hangar »** (choix validé) : un `Wallet` pioche dans le sac puis complète avec le hangar. Il sert pour :
  - les coûts de construction et le chargement manuel des machines ;
  - l'assemblage au garage ;
  - les remboursements (démontage, changement de recette, démontage d'une voiture), qui remplissent le sac puis débordent au hangar.
- **Récolte** : E sur une machine **ou une foreuse**, puis « Prendre ». La production va dans le sac ; ce qui ne rentre pas reste dans la machine (sac plein signalé).
- **Hangar** : E ouvre le panneau d'échange. Un clic sur une case du sac la dépose ; un clic sur un objet du hangar en prend une pile, dans la limite de la place. « Tout déposer » aussi depuis le sac (Tab), mais seulement près du hangar (12 m).
- **La simulation reste pure** : elle ne connaît que les interfaces `ItemSource` / `ItemSink`. Le hangar en est une (capacité illimitée), le sac et le portefeuille aussi. Un test vérifie la conservation des objets (poser, charger, produire, prendre, démonter).
- **Icônes** : chaque objet est rendu une fois au démarrage depuis son modèle 3D, avec un petit renderer dédié, en PNG.
- **Barre du bas** (choix validé : empilée sous la barre de construction) : les 8 premières cases du sac restent visibles en bas de l’écran, comme une barre d’accès rapide. Une case qui reçoit des objets pulse. Le mini-sac du panneau Hangar disparaît. La barre de construction est masquée quand un panneau est ouvert, et la barre du sac aussi quand le panneau affiche déjà le sac (Tab, hangar).
- **Rangement** (choix validé : glisser-déposer) : le sac s’affiche en 3 rangées de 8, la barre en dernier comme dans Minecraft. Glisser une case vers une case vide la déplace, vers le même objet fusionne jusqu’à la taille de pile (le reste ne bouge pas), vers un autre objet échange les deux. Dans le panneau du hangar, la déposer sur la colonne Hangar la range au hangar. Un simple clic garde son effet (déposer au hangar). Les nouveaux objets remplissent les premières cases libres, donc la barre en premier.
- **Vue repliée** : un redimensionnement à 0×0 (volet masqué) est ignoré. Sinon le ratio d'aspect nul cassait la projection.

## Retours usine (octobre 2026)

- **Échap** : avec un outil actif (construction, démontage, tracé), Échap ferme seulement l'outil. Le navigateur libère quand même le pointeur, donc le jeu affiche « Clic : reprendre » au lieu du menu pause. Un second Échap ouvre la pause. Un refus de reverrouillage juste après Échap (délai imposé par le navigateur) ne bascule plus en curseur libre si le verrouillage a déjà fonctionné.
- **Orientation des machines** : les modèles Kenney `machine*` sont des tunnels ouverts sur leurs **flancs longs**. Foreuse, presse et assembleuse occupent donc 2×1 cases (2 de large, 1 de profondeur) et les objets les **traversent** : entrée par le flanc arrière (les deux cases), sortie par le flanc avant (l'une ou l'autre case, la première reliée l'emporte). Les entrées par les petits côtés sont supprimées, ce sont des murs pleins. Comme pour un convoyeur, la sortie est « vers l'avant », donc une machine posée après un tracé de convoyeur garde le même sens de flux.
  - Sauvegardes : `FactorySave.version` passe à 2. Au chargement d'une sauvegarde v1, les machines tournent d'un quart de tour, ce qui conserve exactement leurs cases. Les convoyeurs qui arrivaient par les petits côtés ne sont plus reliés et sont à reposer.
- **Modèle de la foreuse** : elle utilisait `machine-fortified`, presque identique à la presse. C'est maintenant une tour de forage composée de pièces du Factory Kit : `piston-thin-round` (tige de forage) dans deux cadres `structure-yellow-medium`, une tête `piston-round` animée quand elle travaille, et un entonnoir `hopper-high-round` collecteur. Sa hauteur (≈ 3,7 m) passe dans le collider de visée.
- **Carte agrandie** : la grille passe de 64×64 à **128×128** cases (256 m), hangar au centre (62, 62). Huit gisements au lieu de cinq, plus grands et espacés : un fer et un caoutchouc à ~17 cases du hangar pour les premières chaînes (≈ 15 convoyeurs chacune ; payables à l'époque avec le stock de départ, aujourd'hui à la main, test `objectives.test.ts`), les autres entre 26 et 50 cases dans toutes les directions.
  - Sauvegardes : `FactorySave.version` passe à 3. Une sauvegarde de l'ancienne carte est décalée de 32 cases (`LEGACY_MAP_OFFSET`), joueur compris, pour que son hangar tombe sur le nouveau. Les foreuses gardent leur ressource même si l'ancien gisement n'existe plus.
  - Sol : la tuile `floor` du kit est un carré de couleur unie. Un seul carré étiré sur toute la grille remplace les 16 384 instances (≈ 45 → 90 FPS mesurés). (Une carte plate le garde ; la carte réelle a désormais du relief, voir « Relief et herbe ».)
  - Le test de charge (`?layout=stress`) reste sur une grille 64×64 (2 100 objets).

## Progression façon Satisfactory (octobre 2026)

Une nouvelle partie ne donne plus de stock : on part de rien, à la main, et le hangar débloque les bâtiments par paliers, comme les jalons du HUB de Satisfactory.

- **Choix validés** :
  - **Minage à la main** : maintenir E en visant une case libre d'un gisement, à 6 m au plus du point le plus proche de la case (`HAND.MINE_REACH` ; la visée à la troisième personne tombe un peu devant). Un minerai toutes les 0,75 s (`HAND.MINE_SECONDS`) va dans le sac. Les gisements sont inépuisables. Côté simulation, `FactorySim.mineAt(x, z, sink)` : rien sous un bâtiment (une foreuse couvre ses cases) ni hors gisement, et rien n'est miné si le sac est plein (« Sac plein »), donc rien ne se perd. Le minage à la main ne compte pas dans les statistiques de production (`crafted`).
  - **Établi intégré au hangar** : ce n'est pas un bâtiment, c'est l'onglet « Établi » du panneau du hangar (E → Hangar / Établi / Paliers). Il est posé sur la face sud du hangar, côté apparition du joueur. Ses recettes (`machine: 'bench'`) se fabriquent en maintenant le bouton. `Wallet.craft` prend les entrées dans le sac puis au hangar, met le résultat dans le sac (le surplus déborde au hangar), et ne fait rien s'il manque une entrée.
  - **Fer en trois étapes** : foreuse → **Fonderie** (nouveau bâtiment 2×1, même tunnel que les autres machines) → **Constructeur** (l'ancienne presse, renommée ; son id interne reste `press` pour les sauvegardes) → assembleuse. La fonderie n'a qu'une recette et démarre dessus.
  - **Paliers au hangar** : quatre paliers payés sac d'abord, puis hangar (`GameState.unlockNextTier`) ; un cinquième, Garage, s'y ajoute avec « Garage dans l'usine ». Le palier atteint est sauvegardé (`tier`). Un bâtiment verrouillé reste dans le menu de construction, grisé, avec son palier.
  - **Le hangar démarre vide** (`START_STORAGE = {}`).
- **Cadences** (1 foreuse = 1 fonderie = 1 constructeur) :

  | Machine | Recette | Durée | Débit |
  |---|---|---|---|
  | Foreuse | gisement → 1 minerai (ou latex) | 2 s | 30/min |
  | Fonderie | 1 minerai → 1 lingot | 2 s | 30/min |
  | Constructeur | 3 lingots → 2 plaques | 6 s | 30 lingots → 20 plaques/min |
  | Constructeur | 1 lingot → 1 tige | 2 s | 30/min |
  | Constructeur | 1 tige → 4 boulons | 2 s | 30 tiges → 120 boulons/min |
  | Constructeur | 2 latex → 1 pneu | 3 s | 30 latex → 15 pneus/min |

  Châssis et moteur demandent en plus 2 tiges chacun. Le test `FactorySim.test.ts` mesure ces débits en régime établi, de la foreuse au hangar.
- **Coûts des bâtiments** :

  | Bâtiment | Coût |
  |---|---|
  | Convoyeur | 1 plaque |
  | Foreuse | 6 plaques, 4 tiges |
  | Fonderie | 4 plaques, 6 tiges |
  | Constructeur | 10 plaques, 8 tiges, 16 boulons |
  | Assembleuse | 20 plaques, 12 tiges, 40 boulons |
  | Garage (ajouté ensuite) | 40 plaques, 24 tiges, 80 boulons |

- **Paliers** :

  | Palier | Coût | Débloque |
  |---|---|---|
  | 1. Extraction | 10 tiges | foreuse, convoyeur |
  | 2. Fonderie | 10 plaques, 10 tiges | fonderie |
  | 3. Constructeur | 30 plaques, 20 tiges, 40 boulons | constructeur |
  | 4. Assemblage | 60 plaques, 40 tiges, 120 boulons, 10 pneus | assembleuse |
  | 5. Garage (ajouté ensuite) | 80 plaques, 60 tiges, 160 boulons, 8 pneus | garage |

- **Temps à la main** : 0,75 s par minerai ; à l'établi, 0,75 s pour un lingot, une tige ou 4 boulons, et 1 s pour 2 plaques (3 lingots). Le palier 1 demande environ 22 s de travail (10 minerais, 10 lingots, 10 tiges). Le palier 1, la première foreuse et les ~15 convoyeurs jusqu'au hangar en demandent environ 1 min 30 (le test `objectives.test.ts` exige moins de 2 min).
- **Faisabilité vérifiée par les données** : `tiers.test.ts` calcule par point fixe, sur `RECIPES` et les gisements de la carte, tout ce qui est productible avant chaque palier (main, établi, machines des paliers précédents, foreuses). Il vérifie que le coût du palier et celui des bâtiments qu'il débloque le sont, et qu'au dernier palier tous les objets du jeu le sont. Une modification des recettes, des coûts ou des paliers qui casserait la progression fait donc échouer les tests. `bootstrap.test.ts` joue le début d'une partie (minage, établi, paliers 1 et 2, première foreuse) sur la vraie carte.
- **Objectifs d'accueil**, dans l'ordre : miner à la main, 10 tiges à l'établi, palier 1, foreuse reliée au hangar, palier 2, fonderie, palier 3, plaques au constructeur, pneus, palier 4, pièces de voiture, palier 5, garage, assemblage, course, bonus Sportive (palier 5 et garage ajoutés avec « Garage dans l'usine »). Chaque étape est aussi validée dès que le palier suivant est atteint, donc une sauvegarde où tout est débloqué ne rejoue pas l'amorçage.
- **Sauvegardes** :
  - Sans champ `tier` (sauvegardes d'avant les paliers) : tous les paliers sont débloqués. Une valeur invalide est bornée : négative → 0, non numérique → tout débloqué. Une valeur égale ou supérieure au nombre de paliers de sa version (`tierMax`, voir « Garage dans l'usine ») débloque tout, paliers ajoutés depuis compris.
  - Les recettes de la presse ont changé d'id (`plate` et `bolt` prenaient du minerai ; ce sont maintenant `iron_plate`, `iron_rod` et `bolts`). Une machine sauvegardée avec un ancien id, ou avec la recette d'une autre machine, repart sans recette au chargement, et ses tampons reviennent au hangar.
  - Une recette gardée dont les entrées ont changé (châssis, moteur) : les objets du tampon d'entrée qui ne sont plus des entrées sont rendus au hangar.
  - Démonter un bâtiment rembourse son coût **actuel**, même s'il a été payé à l'ancien prix (accepté : retenir le prix payé par bâtiment n'en vaut pas la peine).
- **Usine de démonstration** (`?layout=demo`) : quatre chaînes, toutes en foreuse → fonderie → constructeur. Les plaques ; les tiges, fusionnées sur la ligne des plaques ; les boulons (un constructeur « Tige » puis un constructeur « Boulons ») ; les pneus.

## Garage dans l'usine (octobre 2026)

Le garage n'est plus une scène à part (touche G, entrée « Garage » du menu principal, `GarageMode` supprimé) : c'est un bâtiment de l'usine, et les voitures assemblées y restent garées et se conduisent entre les machines.

- **Choix validés** :
  - **Garage à construire au palier 5** : un palier « Garage » (80 plaques, 60 tiges, 160 boulons, 8 pneus) débloque le bâtiment (touche 6 ; 40 plaques, 24 tiges, 80 boulons). Il occupe 3×4 cases (6 × 8 m) : des murs sur trois côtés, toute la face avant (le petit côté) ouverte en porte de 2,8 m de haut sous un linteau à enseigne, pas de toit. Sur le fantôme, une flèche bleue (la couleur des entrées) marque la porte ; R tourne le garage. Le hangar n'a plus de terminal Garage.
  - **Panneau dans l'usine** (`GaragePanel`) : E sur un garage ouvre son panneau sans changer de scène, en deux colonnes latérales pour laisser la place visible au milieu.
    - À gauche : les voitures et où elles sont (« Dans ce garage », « Garée ailleurs », « En route », « À ranger »), le kart de location, les nouvelles voitures (Kart, Sportive) et les pièces en stock (sac + hangar).
    - À droite : le brouillon (pièces par emplacement, stats comparées à la voiture de course, « Assembler »), montré en fantôme dans la place vide ; ou la voiture choisie (stats, « Courir », « Choisir pour courir »). Changer une pièce et « Démonter » (confirmé par un second clic) ne valent que pour la voiture garée dans ce garage.
    - « Courir » fait de la voiture la voiture de course et ouvre le choix du circuit, dont le bouton de retour dit alors « Usine » (`TrackSelectParams.origin`, transmis à la course et à l'éditeur). Les boutons « Garage » de la course et du choix de circuit deviennent « Usine ».
    - Les actions sont pures (`garage/actions.ts`, testées) : le sac paie d'abord, puis le hangar, et les remboursements remplissent le sac puis débordent au hangar.
  - **Voitures conduisibles** : E près d'une voiture garée pour monter, commandes de course (Z/S/Q/D ou flèches, Espace frein à main), E pour descendre, Retour arrière pour replacer la voiture, Entrée pour descendre et choisir un circuit avec elle (`RaceParams.carId` : records et objectif « course » pour cette voiture). Le kart de location ne roule que sur les circuits.
- **Une place par garage** : la place est le centre de l'emprise, voiture tournée vers la porte (`parking.bayPose`). Une voiture dont le centre est à moins de 2,2 m de ce point est « dans ce garage » (`carInBay`) ; le bâtiment lui-même ne stocke rien (`GarageB` n'a ni port ni objet), tout se déduit de `CarInstance.pose`.
  - Assembler exige une place libre ; la voiture y apparaît et devient la voiture de course.
  - Un garage occupé ne se démonte pas (« sors-la d'abord »). On ne construit pas sur une voiture, ni, sauf un convoyeur, sur le joueur (`placementGuard` et `dismantleGuard` de `BuildController`).
- **Priorité de E** : d'abord le bâtiment visé (hangar, garage, machine), sinon la voiture garée la plus proche, à 3,2 m au plus de sa boîte. Une voiture dans la place cache le sol du garage : la viser, c'est monter.
- **Bâtiment creux** (`hollow`) : le garage n'a pas de collider de sol, les voitures roulent sur le sol de l'usine. Un rayon qui touche le sol dans son emprise le désigne quand même, et sa surbrillance est un contour avec un sol teinté plutôt qu'une boîte, qui teinterait la vue depuis l'intérieur. Une position sauvegardée dans un garage est gardée au chargement.
- **Murs** : 3,5 m. Un saut (1,6 m) plus l'autostep (0,9 m) atteint 2,5 m depuis le sol et 3,3 m depuis un convoyeur posé contre le mur, mais pas depuis le haut d'une machine (2,1 m). Murs, linteau et caisses des coins arrière sont des colliders. Pas de toit, seulement deux poutres décoratives, pour que la caméra orbitale et la caméra de poursuite ne s'y coincent pas. `garageLayout.ts` partage ces boîtes entre le modèle, les colliders et la surbrillance (tests : la porte laisse passer la Sportive, la place la contient).
- **Caméra du panneau** : tant que le panneau est ouvert, la caméra quitte l'orbite et se place devant la porte, de trois quarts (à 9,5 m de la place, 4,2 m de haut, décalée de 0,45 rad), en visant la place à 0,9 m du sol. Le HUD de l'usine qui passerait sous les colonnes est masqué.
- **Groupes de collision** (`factory/collisionGroups.ts`) : les convoyeurs de l'usine sont au sol et partout, contrairement à ceux, surélevés, de Satisfactory. La caisse d'une voiture conduite et les convoyeurs s'ignorent donc, et les rayons de roue ignorent aussi les convoyeurs (option `wheelFilter`) : la voiture traverse une ligne de convoyeurs sans monter dessus. Machines, murs et voitures garées restent solides ; les rayons de roue ignorent les voitures garées (on ne grimpe pas dessus). Le contrôleur du joueur ignore les groupes : à pied, on marche toujours sur les convoyeurs.
- **Gravité** : le monde de l'usine reste à -9,81 pour le personnage. Le corps d'une voiture conduite a une échelle de gravité de -20 / -9,81 ≈ 2,04 (`CAR_GRAVITY_SCALE`) : elle pèse ce qu'elle pèse en course, avec la même adhérence et la même suspension (test).
- **Vitesse plafonnée** : 25 m/s (90 km/h) dans l'usine, qui n'est pas un circuit. Une résistance horizontale s'ajoute au-delà de 80 % du plafond, calibrée pour que plein gaz sur le plat plafonne juste là (`vehicle/speedCap.ts`) ; une voiture plus lente que le plafond n'est pas touchée, et les chutes ne sont pas freinées. La caméra de poursuite prend ce plafond comme vitesse de pointe pour son FOV. Les trois options du `Vehicle` (gravité, plafond, filtre des roues) sont facultatives : sans elles, la conduite de course est identique au bit près (test).
- **Limites** : la voiture reste à 2 m à l'intérieur de la carte (mur mou : la vitesse vers le bord est limitée à 4 m/s par mètre restant). Sous -5 m (depuis le relief : à plus de 4 m sous le sol, ou noyée dans le lac), couchée ou coincée plus de 1,6 s (même règle qu'en course) ou à plus de 12 m hors de la carte, elle revient à sa dernière position sûre, relevée toutes les 0,5 s quand elle est droite sur ses quatre roues dans la carte. Retour arrière fait de même.
- **Règles de sortie** :
  - E ne fait descendre que sous 3 m/s (sinon « Ralentis pour descendre »), Entrée aussi. La voiture se gare là où elle est : pose enregistrée, hauteur prise sur le sol.
  - Le joueur sort à gauche du siège, sinon à droite, derrière, devant, puis aux mêmes places 1,2 m plus loin. Si tout est bloqué, il sort sur le toit.
  - Pendant la conduite, la capsule du joueur est désactivée et l'avatar caché (le kart montre son pilote assis, masqué quand il est garé). `state.player` garde l'endroit où le joueur est monté, donc un rechargement ne le fait jamais apparaître dans la voiture. Un joueur qui se trouve dans une voiture (assemblée sur lui, ou au chargement) est déplacé à côté (`moveOutOfCars`).
- **Sauvegardes** :
  - `CarInstance.pose` (x, y, z, cap) est écrite à chaque pas de la conduite, donc une sauvegarde peut tomber à tout moment. Au chargement, une pose invalide est ignorée (`sanitizePose`), comme une voiture sans id ou sans plan.
  - Les voitures sans place (anciennes sauvegardes, pose invalide) sont « À ranger ». À l'entrée dans l'usine et à chaque garage construit, elles prennent les places libres, garages dans l'ordre de construction (`GameState.parkCars`). Les voitures d'une ancienne sauvegarde se garent donc dès le premier garage construit, une par garage.
  - `SaveData.tierMax` enregistre le nombre de paliers de la version (absent : 4). Une sauvegarde qui avait tous les paliers de sa version reçoit ceux ajoutés depuis, donc le garage ; une sauvegarde d'avant les paliers garde tout débloqué.
- **Objectifs** : deux étapes entre les pièces de voiture et l'assemblage, palier 5 puis « Construis un garage » (porte vers un espace libre pour sortir en voiture). Toutes deux sont validées dès qu'une voiture existe, donc une sauvegarde qui a déjà une voiture ne les rejoue pas.
- **Barre de construction** (remplacée ensuite, voir « Menu de construction ») : avec six bâtiments, les coûts deviennent compacts, une icône et une quantité par objet (en rouge s'il en manque), avec le texte complet en infobulle.

## Menu de construction (octobre 2026)

- **Plus de barre de construction en bas de l'écran** (choix validé) : on choisit un bâtiment dans un menu, comme dans Satisfactory. Le bas de l'écran ne garde que l'indication du moment et la barre du sac.
- **Menu (A, touche physique Q)** : les bâtiments par catégorie (Logistique, Extraction, Production, Véhicules), côte à côte. Chaque carte montre une miniature rendue une fois depuis le modèle 3D (`BuildingIcons`, comme les icônes d'objets), le nom, le raccourci et le coût en icônes (en rouge s'il en manque). Un bâtiment verrouillé est grisé avec son palier.
- **Fiche détaillée** au survol : grande miniature, taille au sol, rôle, ce que la machine fabrique (ses recettes), coût « j'ai / il faut » et bouton « Placer », ou le palier qui le débloque.
- **Raccourcis 1 à 6** gardés, sans barre : ils marchent en jeu et dans le menu ouvert (un bâtiment verrouillé affiche juste son palier, le menu reste ouvert). F démonte, aussi depuis le menu.
- Le menu ne se redessine que quand les objets utilisés par les coûts, le palier ou l'outil changent (la production du hangar ne le rafraîchit pas en continu, le survol reste stable).


## Ports visibles et raccordement (octobre 2026)

Retour joueur : impossible de savoir où sort une foreuse, et un convoyeur posé à côté ne faisait rien (tourné vers la foreuse, il refuse sa sortie ; le long de son petit côté, il ne touche aucun port).

- **Marqueurs de ports** (`view/portMarkers.ts`, partagés par l'usine et les fantômes) : dans la case devant chaque port, là où va le convoyeur, un cadre au sol avec une flèche plate et une flèche 3D qui flotte à 1,25 m. Orange pour une sortie (elle s'éloigne de la machine), bleu pour une entrée (elle pointe vers elle), vert pour une liaison sur un fantôme. Les flèches plates seules se perdaient dans les rochers et la couleur des gisements de fer ; la flèche 3D se lit au-dessus, sous la caméra basse.
  - Hors construction, seuls les côtés encore libres d'un bâtiment sont marqués (aucune sortie reliée → ses sorties libres, idem pour les entrées), comme un rappel « à brancher ». Avec un outil de construction, tous les ports libres sont marqués et clignotent.
  - Un port dont la case de devant est prise (bâtiment, convoyeur, hors carte) n'est pas marqué. Le hangar (tous ses bords acceptent) et le garage n'ont pas de marqueurs.
  - **Une seule sortie à la fois** : une machine sort par le premier port de sortie relié, jamais par deux. Dès qu'une sortie est reliée, l'autre est « inutilisée » (`PortInfo.state = 'unused'`) : ni marquée, ni proposée à l'accroche. Un convoyeur posé devant ne recevrait rien, ou volerait la sortie de la ligne qui marche (relevé par la revue).
- **Cul-de-sac** : une croix rouge 3D au bout d'un convoyeur dont l'avant bute contre un bâtiment qui refuse ses objets (sortie ou mur d'une machine, convoyeur en face, garage). Un avant sur le sol vide n'en est pas un (ligne en cours) ; un avant sur un sol où aucun convoyeur ne tient (pente, eau) en est un, depuis le relief. Une croix aussi, au-dessus de la machine, sur la face de sortie d'une machine dont toutes les sorties donnent sur un bâtiment ou le bord de la carte (posée sur la face commune, elle restait cachée entre les deux bâtiments) ; son fantôme fait de même, avec « ✕ sortie bloquée par : … ».
- **Accroche des convoyeurs** (`sim/planning.ts`, pur et testé) :
  - Un convoyeur seul prend l'orientation qui se raccorde le mieux : alimenter une machine ou le hangar compte le plus, puis recevoir d'une sortie ou d'un bout de convoyeur ; buter contre un bâtiment compte contre, tout comme prendre la sortie d'une machine à la ligne qu'elle alimente déjà. À égalité, l'orientation dans le prolongement de ce qui l'alimente gagne (devant une foreuse, le convoyeur part tout droit ; au bout d'une ligne, il la continue), puis la dernière orientation utilisée, puis le quart de tour le plus proche. Alimenter un autre convoyeur ne compte pas, sinon un convoyeur posé à côté d'une ligne parallèle s'y fusionnerait de force.
  - **R reprend la main** : sur un fantôme accroché, R tourne à partir de ce qu'il montre et coupe l'accroche sur cette case, jusqu'à ce que la visée la quitte. Toutes les orientations restent donc possibles.
  - **Départ** : viser un bâtiment place le fantôme devant sa sortie libre la plus proche du point visé, sinon devant son entrée libre la plus proche (pour le hangar, la case libre la plus proche le long de ses bords). Viser le bout d'un convoyeur place le fantôme juste après, pour le prolonger. Une case libre devant un port (là où est sa flèche) compte comme ce port : partir de la flèche bleue d'une entrée trace un convoyeur qui y coule, finir sur la flèche orange d'une sortie aussi.
  - **Clic ou tracé** : tant que la visée reste sur la case (ou le bâtiment) où le bouton a été enfoncé, c'est un clic, qui pose exactement le fantôme affiché. Sans cette règle, un clic sur une machine posait deux convoyeurs inutiles (départ devant la sortie, arrivée devant l'entrée, à travers la machine) et un clic sur le bout d'un convoyeur en posait un tête-bêche (relevé par la revue).
  - **Arrivée** : sur un bâtiment, devant le port qui complète le convoyeur (une entrée si le départ est une sortie, une sortie si c'est une entrée ; une entrée, sinon une sortie, depuis une case quelconque), le plus proche du départ (convoyeur le plus court), puis du point visé. Sans port de ce type libre, l'arrivée reste sur le bâtiment : plus de repli sur la face de sortie. Sur un convoyeur : si le tracé vient de devant son bout (ou part d'une entrée), le nouveau convoyeur le prolonge depuis son bout ; sinon il reste la fin et la dernière tuile le rejoint par le côté. La dernière tuile tourne vers l'entrée visée en priorité, pas vers une autre machine dont une entrée donnerait sur la même case.
  - **Sens du convoyeur décidé par les ports**, comme dans Satisfactory : un convoyeur va d'une sortie vers une entrée, quel que soit le bout par lequel on commence. Partir devant une entrée, ou finir devant une sortie, trace le chemin à l'envers (il coule vers l'entrée et sa dernière tuile y tourne).
  - Tracé en L : l'axe le plus long d'abord, sauf si l'autre ordre traverse moins de bâtiments, ou, à égalité, s'il évite de finir de face contre un bâtiment (un convoyeur visé est rejoint par le côté). La dernière tuile tourne vers l'entrée d'une machine ou le hangar à côté d'elle si la ligne droite n'en alimente pas.
  - Pendant un tracé, le bas de l'écran donne la vraie raison d'une tuile rouge (emplacement occupé, véto, plaques manquantes avec leur nombre) ; la case d'un convoyeur rejoint en fin de tracé n'est plus comptée comme une erreur, ni posée. Au relâchement, si rien n'est posé, le message reprend cette raison ; si le dernier convoyeur posé bute contre un bâtiment, le message le dit.
  - Un tracé de plus de 64 tuiles garde le bout où le bouton a été enfoncé, y compris quand il est tracé à l'envers.
  - Un convoyeur qui prendrait la sortie d'une machine à la ligne qu'elle alimente (sur la case de sa sortie inutilisée) montre une flèche rouge et « ⚠ prend la sortie de : … ».
  - Non retenu : tourner automatiquement les machines vers les convoyeurs (le fantôme d'un grand bâtiment qui pivote seul en déplaçant la visée déroute). Leurs ports passent au vert quand ils se relieraient.
- **Aperçu des liaisons** : `FactorySim.planLinks(plan)` calcule, sans rien poser, les liaisons que feraient des bâtiments prévus (ids -1, -2…), avec la même fonction `findLink` que la topologie. Un test aléatoire (60 dispositions, plans de 1 à 3 bâtiments) vérifie qu'il prédit exactement les liaisons obtenues une fois posés. Le fantôme d'un convoyeur montre une flèche verte à chaque liaison avec un bâtiment existant, une croix rouge si son avant bute ; celui d'une machine colore ses ports. L'indication du bas dit « ✓ reçoit : … · alimente : … », « ✕ sortie bloquée par : … » ou « ✕ sortie vers le bord de la carte ».
- **Panneaux** : foreuse et machines disent « Entrée reliée / non reliée » et « Sortie reliée / non reliée », avec quoi faire (flèche bleue, flèche orange), ou pourquoi c'est bloqué (« le convoyeur devant pointe vers la machine, repose-le dans l'autre sens », « Sortie bloquée par : … »). Une foreuse pleine dont la sortie est reliée dit « la chaîne en aval est saturée » au lieu de « relie un convoyeur ».
- **Revues** : trois relecteurs de code (simulation, contrôleur, rendu) et un testeur en jeu, puis une vérification adverse de chaque point : 15 défauts confirmés, tous corrigés ; une seconde revue des corrections en a confirmé 10 autres, mineurs, corrigés aussi (case devant un port, prolongement de face, vol de sortie, plafond des tracés à l'envers, textes) (dont les deux ci-dessus, une flèche fantôme qui scintillait contre une flèche posée au même endroit, et des flèches transparentes mal triées derrière les fantômes). Les relecteurs ont vérifié que la topologie refactorisée est identique à l'ancienne (300 dispositions aléatoires, même hash après 300 ticks et après un aller-retour de sauvegarde) et que `planLinks` prédit exactement les liaisons (3 000 plans aléatoires).
- La simulation ne change pas : mêmes liaisons, même ordre de traitement, mêmes sauvegardes. `portsOf`, `inboundOf`, `isDeadEnd` et `planLinks` ne font que lire la topologie.

## Ramasser sur les convoyeurs (octobre 2026)

- **E sur un convoyeur** prend les objets de la case visée, devant d'abord, dans le sac. **Maintenir E 0,5 s** (`HAND.BELT_LINE_SECONDS`) prend ceux de toute la ligne, avec la même barre de progression que le minage. Pas de touche modificatrice : Maj sert à courir, et Maj+E se déclencherait en courant.
- **La ligne** (`FactorySim.beltLine`) : les convoyeurs reliés de convoyeur à convoyeur, en aval (sa sortie) et en amont (ceux qui l'alimentent, fusions comprises). Une machine ou le hangar la termine ; deux convoyeurs côte à côte ou tête-bêche ne sont pas reliés. Viser un convoyeur chargé (ou dont la ligne l'est) montre la case et, en plus pâle, toute la ligne ; elle s'éclaire pendant qu'on maintient E. Lâcher E ou viser hors de la ligne annule.
- **Sac plein** : `FactorySim.takeFromBelts(ids, sink)` ne retire que ce que le sac accepte ; le reste reste à sa place sur le convoyeur (un test vérifie que rien ne se perd ni ne se duplique ensuite). Message : « Pris : 3 minerais de fer », avec « sac plein, le reste reste sur le convoyeur » si besoin.
- **Priorité de E** : le bâtiment visé (machine, hangar, garage), puis le convoyeur visé s'il y a des objets sur sa ligne, puis la voiture la plus proche. Un convoyeur vide laisse donc E atteindre une voiture garée à côté.
- Le ramassage ne compte ni dans les livraisons au hangar ni dans la production (`delivered`, `crafted`).

## Voitures construites pièce par pièce (octobre 2026)

Demande : pouvoir commencer une voiture, poser ses roues en attendant le reste, et la voir dans le garage.

- **Chantier** (`garage/build.ts`, pur) : une voiture en construction occupe la place d'un garage (`GameState.builds`, un par garage au plus, sauvegardé). Chaque emplacement reçoit **une sorte** de pièce, jusqu'à son nombre : deux roues maintenant, deux plus tard. Pour changer de sorte (roues racing), on retire d'abord celles posées.
- **Poser** : depuis le brouillon d'une nouvelle voiture (« Poser maintenant », place vide), puis depuis la vue « En construction ». Le sac paie d'abord, puis le hangar, autant que l'emplacement en prend et que le stock en a. « Assembler » (tout d'un coup) reste pour quand tout est là.
- **Fin automatique** : dès que les emplacements obligatoires sont pleins, la voiture sort comme une voiture assemblée (numérotée, choisie pour courir, objectif « assemblée »). Un emplacement facultatif (aileron) ne vient avec elle que plein ; sinon ses pièces reviennent au sac. Choisi parce qu'un bouton « Terminer » de plus n'apporte rien : l'aileron se pose aussi après.
- **Retirer / Abandonner** : les pièces reviennent au sac (le surplus au hangar). Un chantier vidé libère la place.
- **Dans la place** : le modèle de la voiture finie, avec ce qui est posé en couleur et le reste en transparence. La carrosserie est transparente sans châssis, en métal nu tant que des panneaux manquent (Sportive), en couleur ensuite. Les roues se posent avant d'abord, gauche d'abord ; une roue manquante est remplacée par une chandelle jaune. Un moteur posé se voit sur son essieu (arrière pour le kart, avant pour la Sportive, `Blueprint.engineMount`), jusqu'à ce que la carrosserie le cache.
- Le chantier est **solide** comme une voiture garée (même boîte de collision) : on ne le traverse ni à pied ni en voiture, et le joueur qui se trouverait dedans est déplacé à côté. Il ne se conduit pas, ne se choisit pas pour courir, et une voiture qui attend une place ne s'y gare pas.
- Un garage avec un chantier ne se démonte pas (« termine-la ou abandonne-la d'abord »). Au chargement, un chantier dont le garage n'existe plus rend ses pièces au hangar.

## Répartiteurs et fusionneurs (octobre 2026)

- **Deux bâtiments 1×1** au palier 1 (2 plaques, 2 tiges), modèle `conveyor-cross` du kit avec des flèches orange sur le dessus, à hauteur de convoyeur : on marche dessus, les voitures les traversent, pas de panneau.
  - **Répartiteur** : entrée à l'arrière, sorties à l'avant, à gauche et à droite (`multiOut` : il sort par **toutes** ses sorties reliées, contrairement aux machines qui n'utilisent que la première). Chaque sortie a sa **place d'attente** (un objet) : l'objet de tête va à la sortie suivante (à partir de celle qui suit la dernière servie) dont la place est libre, une sortie sans convoyeur est sautée ; puis chaque place pousse vers sa cible. Une sortie dont la cible est occupée garde son objet en attente, ce qui lui réserve son tour dans une fusion (elle compte comme « prête » pour cette cible) pendant que les autres sorties continuent. Sans ces places, un répartiteur collé contre un fusionneur ou le flanc d'un convoyeur chargé ne lui envoyait presque rien (relevé par la revue).
  - **Fusionneur** : entrées à l'arrière, à gauche et à droite, sortie à l'avant ; il prend ses entrées à tour de rôle comme la fusion d'un convoyeur (même `mergePriority`). Un convoyeur qui arrive sur le flanc d'un autre fusionne toujours ; le fusionneur rend la chose lisible et prend aussi directement la sortie d'une machine.
- **Simulation** : un petit tampon (`NODE.CAP` = 2 objets) passé à la sortie à raison d'un objet par tick et par sortie. Les répartiteurs et fusionneurs avancent **après** les convoyeurs dans le tick : leur convoyeur de sortie a déjà bougé, donc ils suivent une ligne pleine (un objet tous les 7 ticks, test en régime établi ; avant, 8 ticks, soit 12,5 % de débit en moins). L'objet qui passe se voit au centre de la croix, ceux qui attendent vers leur sortie. Le tampon est sauvegardé, remboursé au démontage, et l'état du tour de rôle (`lastOut`, `lastFrom`) fait partie de la sauvegarde : même avenir après chargement (test du hash).
- **Liaisons** : `findLinks` donne le lien de chaque port de sortie ; la topologie enregistre tous ceux d'un répartiteur (`multiLinks`) et `planLinks` les prévoit aussi (`PlanLinks.outs`), donc le fantôme, les flèches de ports, l'accroche des convoyeurs et les tracés marchent avec eux sans cas particulier. Le test aléatoire de `planLinks` inclut répartiteurs et fusionneurs. Les sorties libres d'un répartiteur restent « libres » (pas « inutilisées ») et un convoyeur posé devant ne « vole » rien.
- **Ramassage** : E ramasse aussi sur un répartiteur ou un fusionneur (son tampon et ses places), et la ligne prise en maintenant E les traverse (`beltLine` suit toutes les pièces de convoyeur).
- **Raccourcis** : 7 et 8. Les touches 1 à 6 gardent leur bâtiment ; l'invariant « les raccourcis suivent l'ordre des paliers » ne vaut plus que pour 1 à 6.

## Manette partout (octobre 2026)

Demande : jouer à la manette (elle ne servait qu'à conduire) au personnage, à la construction et dans les menus.

- **Lecture** : l'API Gamepad n'a pas d'événements de boutons. `Input.poll()` lit `navigator.getGamepads()` une fois par image, au début de `Loop.frame`, avant les pas fixes. `core/gamepad.ts` (pur, testé) en tire l'état tenu, les fronts depuis la fin de l'image et des appuis datés : `consume()` marche depuis `fixedUpdate` comme pour les touches. Mapping standard W3C uniquement : les axes d'un autre périphérique (volant, pédales, HOTAS) veulent dire n'importe quoi. Des pédales au repos à ±1 faisaient marcher le personnage et passaient pour une manette en usage permanent, d'où un curseur caché et jamais de pointer lock. La manette suivie est celle déjà utilisée tant qu'elle reste branchée ; une autre qu'on presse la remplace (avant, seule la manette d'indice 0 comptait, et une manette rebranchée à l'indice 1 était ignorée).
  - Zone morte radiale de 0,18, remise à l'échelle : le mouvement part de 0 au bord de la zone, sans saut. Les gâchettes servent de boutons avec une hystérésis (enfoncées au-dessus de 0,5, relâchées sous 0,3). Le stick droit de la caméra suit une courbe en puissance 1,8, pour viser finement.
- **Liaisons par contexte** : `PADBINDS[profil]` (`foot`, `drive`, `race`, `editor`) relie les actions de `KEYBINDS` aux boutons. Le mode choisit le profil à chaque image (`Input.reset()` le remet à `none` à chaque changement de mode). Le même bouton a donc un sens par contexte : A saute à pied, sert de frein à main en voiture et pose une pièce dans l'éditeur. Un test vérifie qu'aucun bouton ne porte deux actions dans un même contexte. Quelques actions n'existent qu'à la manette (`pause`, `primary`, `secondary`, `rotateBack`, `prevTool`, `nextTool`, `zoomCycle`…) : au clavier, ce sont Échap via le pointer lock, la souris, Maj+R ou la molette.
- **Disposition** : à la Satisfactory sur console.
  - À pied : A sauter, X interagir (comme E : maintenu, il mine et prend la ligne), Y menu de construction, RT poser (maintenu : tracer ; la pose au relâchement, comme la souris), B annuler (comme le clic droit, jamais de pause), LB/RB tourner, ←/→ bâtiment précédent/suivant (dans l'ordre du menu, ceux débloqués), ↓ démonter, ↑ zoom, View sac, Menu pause, clic du stick gauche pour courir tant qu'on avance.
  - En voiture : X descendre (le même bouton que pour monter), Y courir, B replacer.
  - En course : B respawn, View recommencer, Menu quitter.
- **Rien ne passe d'un contexte à l'autre** : `PadGate` donne à chaque consommateur (le jeu, les menus) sa propre vue de la manette, qui peut ignorer ce qui est tenu jusqu'au relâchement (un stick, une gâchette : jusqu'à revenir sous 0,2, car un stick usé ne revient jamais pile à 0). On s'en sert au changement de mode, en montant ou en descendant de voiture (A tenu : saut → frein à main ; RT tenu : poser → accélérer), et quand un menu rend la main (A qui a validé « Placer » ne fait pas sauter). Les gâchettes analogiques font exception à la sortie d'un menu : un accélérateur tenu pendant « Réessayer » doit lancer la voiture au départ.
- **Sans pointer lock** : le navigateur ne compte pas un bouton de manette comme un geste de l'utilisateur, donc `requestPointerLock` est refusé. L'usine a un état « jeu à la manette » (`padPlay`) :
  - la visée reste au centre et la caméra tourne au stick droit ;
  - « Jouer », la fermeture d'un panneau ou du garage à la manette y mènent, sans demander le lock (en mode curseur libre, sans bascule définitive ni message sur le clic droit) ;
  - n'importe quelle action à la manette y revient si on a perdu la main (lock refusé, Échap avec un outil) ;
  - un clic sur le jeu reprend le lock pour la souris.

  Le choix entre lock et jeu à la manette dépend de ce qui a cliqué (`Input.padActivation`, posé par PadNav pendant son clic), pas du dernier appareil utilisé : un clic de souris demande toujours le lock. Un relâchement du bouton gauche sans son appui (le clic qui reprend le lock) ne pose rien. La pause est devenue un état (`paused`) plutôt que « pas de lock ». Menu met en pause (et lâche le lock s'il y en a un). Au clavier, rien ne change : Échap ferme l'outil puis met en pause par la perte du lock, avec la même fenêtre de grâce.
- **Menus** (`ui/padNav.ts`) : le dernier élément `[data-pad-scope]` visible du document (menu, panneau, confirmation) prend la manette, et le jeu n'en lit plus rien.
  - Un focus virtuel (classe `pad-focus`, un cadre bleu distinct du contour orange `.selected`) se déplace à la croix ou au stick. Il saute à l'élément voisin d'après les rectangles à l'écran, selon les règles du FocusFinder d'Android (`ui/spatialNav.ts`, pur, testé), avec une tolérance d'un pixel pour les arrondis.
  - A clique. Des attributs déclarent le reste : `data-pad-btn="b y"` (B = retour), `data-pad-tab` (LB/RB), `data-pad-default`, `data-pad-autofocus`, `data-pad-hold` (A maintenu : pointerdown, puis pointerup). Curseurs et listes déroulantes prennent ←/→.
  - Le `title` de l'élément visé s'affiche dans une bulle, puisqu'une manette ne survole pas. Le survol est simulé (`pointerenter`) pour la fiche du menu de construction.
  - Les panneaux se reconstruisent souvent (le garage et le hangar jusqu'à 5 fois par seconde). Le focus se retrouve par une clé (ses attributs `data-*`, sinon balise, classes et texte sans chiffres), sinon à la position la plus proche. Un `MutationObserver` le remet avant l'affichage : pas de clignotement, pas d'appui perdu.
  - Un menu recouvert (le menu pause sous les Réglages) retrouve son focus quand il revient au premier plan.
  - La première pression ne fait que montrer le cadre quand il n'était pas visible : on venait du clavier ou de la souris, ou le jeu a ouvert l'écran tout seul. L'écran d'arrivée d'une course, par exemple : un coup de frein à main ou de respawn ne clique ni « Réessayer » ni « Circuits ». Un écran ouvert d'un appui de la manette montre son cadre tout de suite.
  - Le focus initial n'est jamais « Fermer » (la première pression de A fermerait ce qui vient de s'ouvrir). Le sac part sur sa première pile, une machine sans recette sur sa première recette. Un élément sorti de la zone visible par le défilement : le prochain appui revient à ce qui est visible.
- **Libellés** (`ui/padHints.ts`) : un bouton est un `<kbd class="pad-btn pad-x">` dont le texte vient du CSS selon `body[data-pad]`. Il donne A/B/X/Y sur Xbox, ✕ ○ □ △ sur PlayStation, et les positions sur Switch : le libellé suit la manette branchée sans rien reconstruire. `body.pad-input` affiche les variantes manette (`.pad-only`) et cache celles du clavier (`.kbm-only`) et le curseur. Le dernier appareil utilisé gagne ; une souris effleurée (moins de 24 px) ne reprend pas la main. Les textes refaits à chaque image (bas de l'écran) choisissent directement ; les objectifs ont des jetons (`{interact}`, `{hotkey2}`, `{hold}`).
- **Sac à la manette** : X prend une case (son icône suit le cadre), puis A ou X la pose sur une autre case (déplacer, fusionner, échanger, comme le glisser-déposer) ou sur la colonne du hangar (déposer). B annule.
- **Confirmations dans la page** (`ui/confirm.ts`) à la place de `window.confirm` : nouvelle partie, supprimer un circuit, quitter l'éditeur sans enregistrer. Une manette ne peut pas répondre à la boîte du navigateur, qui gèle aussi la boucle de jeu. Le focus manette part sur « Annuler » quand l'action détruit quelque chose. Échap annule et Entrée confirme ; la touche qui a ouvert la boîte, si elle se répète, ne la referme pas.
- **Au passage** :
  - les Réglages ne laissent plus leur fond invisible, qui bloquait tous les clics du menu après la première fermeture ;
  - le menu de construction ne se reconstruit plus 5 fois par seconde sans raison ;
  - les panneaux gardent leur défilement quand ils se reconstruisent, comme la liste des circuits.
- **Réglage** : « Sensibilité de la manette » (multiplicateur de la vitesse du stick droit, 3,2 rad/s en lacet au maximum). Elle est sauvegardée, avec une valeur par défaut pour les anciennes sauvegardes. « Inverser l'axe vertical » vaut aussi pour la manette dans l'usine (dans l'éditeur, ni la souris ni la manette ne l'appliquent).
- **Tests** : `gamepad.test.ts`, `spatialNav.test.ts` et `padHints.test.ts` (liaisons, libellés, jetons des objectifs). Dans le navigateur, `T.pad` sert une manette virtuelle par `navigator.getGamepads()` et passe par le vrai chemin de lecture.
- **Revues** : une cartographie de toutes les entrées (8 lecteurs et un critique), puis une revue adverse en 6 axes, chaque constat contre-vérifié. Elle a confirmé 13 défauts et en a jugé 3 plausibles, tous corrigés : les périphériques non standard, l'usage détecté sur un changement et non sur une position, les sticks usés, le défilement défait par les rafraîchissements, l'écran d'arrivée, le focus initial sur « Fermer », le double A après « Assembler », le relâchement de souris orphelin, le tracé suspendu par une pause, la touche d'une confirmation qui se répète… Une seconde passe a vérifié les corrections.

## Relief et herbe (octobre 2026)

Ticket « Belle carte avec du relief et de l'herbe ». Choix validés : relief **partout et constructible** (poser un bâtiment aplanit le sol dessous), **vallonné** (collines de 4 à 8 m, quelques crêtes raides, hangar et premiers gisements sur un plateau), herbe 3D animée avec un réglage, arbres, rochers et fleurs, un lac, un ciel ; la pose **défriche** (le décor revient au démontage) ; la grille n'apparaît qu'avec un outil de construction. Méthode : une cartographie de toutes les hypothèses « sol plat » (six lecteurs, un critique), trois architectures notées par trois juges (« dalles + convoyeurs qui suivent le sol » 22, « architecte libre » 19, « fondations sur terrain fixe » 14, rejetée : elle n'aplanissait rien), puis deux revues adverses, chaque constat contre-vérifié : 12 défauts confirmés à mi-parcours, puis 16 constats (10 défauts distincts) en fin de ticket, tous corrigés.

- **Terrain pur et déterministe** (`factory/sim/terrain.ts`, `terrainNoise.ts`, données dans `data/factoryTerrain.ts`) : hauteurs en **centimètres entiers** aux coins des cases, sur la grille plus une marge de 16 cases (161 × 161 coins). Le générateur n'utilise que + − × ÷, floor, round, abs, min, max et des hachages entiers : bit pour bit identique partout ; un test lit les sources et refuse sin, cos, exp, sqrt, pow, `**`. Le hash de la carte est figé (toute retouche est délibérée).
  - Plateau **exactement à 0** à 24 cases du hangar (hangar, apparition, gisements de départ, usines de test) ; collines en bruit de valeur (3 octaves) ; quelques crêtes raides (bruit « ridged ») ; dalles plates sous chaque gisement ; un lac près du bord, au pied des montagnes, loin des gisements et de la zone des anciennes sauvegardes ; au-delà du bord, une falaise d'environ 10 m (59°, infranchissable à pied) puis des pentes boisées vers des montagnes (une trentaine de mètres en moyenne à 100 m du bord).
  - Invariants testés : au moins 85 % des cases à 12° ou moins hors plateau, 2 à 6 % de cases où aucun convoyeur ne tient, une ligne de convoyeurs possible de chaque gisement au hangar (16 tuiles au plus pour le fer de départ), dénivelé médian de 3 à 6 m sur 40 m.
- **Dalles** : machines, foreuse, garage et hangar reçoivent une hauteur de dalle `py` (cm, sauvegardée) : moyenne du sol naturel de l'emprise arrondie à 10 cm, ou dalle d'un bâtiment voisin à 40 cm près (une rangée sur une pente fait des terrasses). Les coins de l'emprise passent à `py` (un coin partagé prend la dalle la plus basse : la marche se voit sur le socle de la plus haute) ; les coins libres jusqu'à 3 pas reviennent au sol naturel à 75, 50, 25 % (talus, teintés terre). Les convoyeurs, répartiteurs et fusionneurs ne touchent jamais le sol : un tracé de 64 tuiles ne coûte rien au terrain.
  - Le sol effectif est une fonction pure du sol naturel et des dalles posées : rien d'autre à sauvegarder, et un recalcul local (rectangle de l'emprise + 3) est égal au recalcul complet (fuzz de 300 opérations).
- **Convoyeurs sur la pente** : un convoyeur droit monte dans le sens du flux et reste de niveau en travers ; coins, jonctions, répartiteurs, fusionneurs prennent le plan moyen de leurs quatre coins. Les deux plans coïncident au milieu de chaque arête partagée et à `py` au port d'une machine : les objets montent sans saut (inclinés, pas cisaillés). Les tuiles sont cisaillées sur leur plan (pieds verticaux), avec une matrice des normales correcte (copie du matériau du kit, jamais modifié) ; une jupe sombre comble l'écart sous une tuile de niveau en travers.
- **Règles de pose** (`FactorySim.check`, jamais contournées par `force`) : `water` dans le lac ; `steep` sous un bâtiment à dalle au-delà de 14° par case, de 1,5 m de dénivelé ou de 1,2 m de déblai ou remblai ; devant une porte de garage, plus de 35 cm de montée par case (environ 10° : une voiture recule à peine plus), cases sous un convoyeur comprises (les voitures les traversent) ; sous un convoyeur, plus de 21,8° ou une torsion de 40 cm. Une dalle est aussi refusée si ses talus rendaient trop pentu un convoyeur ou l'entrée d'un garage déjà là (les règles tiennent quel que soit l'ordre de construction ; un démontage peut encore raidir un convoyeur voisin, accepté). Sur 14° au plus, la case devant chaque port d'une machine accepte un convoyeur (test). Ports, culs-de-sac et tracés en L traitent une case où aucun convoyeur ne tient comme bloquée (`PortInfo.blockedBy: 'terrain'`).
  - Le HUD donne l'angle mesuré, arrondi au dixième supérieur pour qu'une valeur refusée ne s'affiche jamais comme la limite (« Terrain trop en pente : 17° (14° au plus sous un bâtiment) », « 21,9° (21,8° au plus) ») et, pour un bâtiment posable, son terrassement (« fondation +0,4 m · déblai 0,5 m »).
- **Physique** : un heightfield Rapier sur le treillis, **sans `FIX_INTERNAL_EDGES`** (mesuré : avec, le contrôleur du joueur décolle en descendant le long d'une ligne du treillis). Il a la même diagonale que le maillage three : `heightAt`, la physique et le rendu concordent à 1 mm près (tests). Quand une dalle change le sol, `FactoryWorld.flush()` réécrit la zone et change la forme du collider (`setShape`, même poignée), avant chaque pas et chaque visée. Le heightfield n'a qu'une face : le joueur est remis sur la surface la plus haute (sol ou convoyeur) si elle est montée sous lui ; une voiture garée sur le sol le suit, qu'il monte ou descende (une voiture posée sur autre chose n'est que relevée), et une pose sous le sol est remise dessus.
- **Joueur** : filet de sécurité vers une position récente au sol ; bord à 20 m de la grille (la falaise arrête avant) ; ralenti dans l'eau ; pieds et ombre posés sur la pente ; caméra lissée en hauteur, au-dessus du sol et de l'eau ; « Revenir au hangar » dans la pause (case libre la plus proche de l'apparition) ; minage à la main mesuré en 3D.
- **Voitures** (options du `Vehicle`, la course reste identique au bit près) : garées, montées et replacées inclinées sur la pente (`carMath.terrainFit`, `CarPose` inchangée) ; frein de maintien à l'arrêt ; plafond de vitesse qui compense la descente (27 m/s au plus sur 25°) ; chute relative au sol ; dans le lac, freinées puis remises au sec (« La voiture a pris l'eau ») ; pas de descente au-dessus de 50 cm d'eau (« Sors de l'eau pour descendre » : garée là, elle se noierait à chaque reprise) ; sorties testées sur leur propre sol, « Trop en pente pour descendre » au-delà de 25° ; caméra de poursuite au-dessus du sol. Le garage pose sa place sur sa dalle (assemblage, sortie d'une voiture construite, fantôme et caméra du panneau).
- **Rendu** (relief seulement ; une carte plate rend comme avant) : un seul maillage en grille tensorielle (2 m sur le treillis, 8 m puis 32 m au loin, sans fissure), Lambert à facettes, couleurs naturelles par sommet (verts, herbe sèche, terre, roche, sable, neige) mises en cache par carte avec les positions naturelles (l'entrée dans l'usine reste à quelques dizaines de ms) ; une texture par case pour le shader du sol (béton des dalles, terre des talus, teinte des gisements, cases interdites aux convoyeurs) et la **grille** autour de la visée avec un outil de construction ; ciel en dégradé non tone-mappé (comme le brouillard), lac transparent dessiné le premier, lumière plus basse et ambiance verte.
- **Herbe** : des **touffes** de 24 brins instanciées (une passe), pas un brin par instance (16 384 petites instances coûtaient 40 % d'une image ici). Elles suivent la caméra dans une tuile en boucle (stables dans le monde), se posent sur le sol (texture des hauteurs, même diagonale), disparaissent sur bâtiments, convoyeurs, gisements, eau, pentes, et s'écourtent sur les talus et autour de la visée en construction ; vent, et brins écartés par le joueur et les voitures. Les deux faces s'éclairent comme le sol. Fleurs en prairies (une passe). Réglage « Herbe » : Désactivée, Basse, Moyenne (défaut), Haute ; mesuré à 120 FPS (plafond de l'écran) à chaque niveau, densité 2.
- **Décor procédural** (aucun kit de plus) : forêts de pins, chênes, bouleaux, gros rochers, cailloux et pins lointains, placés par une fonction pure ; rien sur le cœur du plateau, les gisements, les rives, l'apparition ni la falaise. Une instance par type ; troncs et gros rochers solides. Un bâtiment masque ce qui touche son emprise (houppiers compris) et désactive leurs colliders ; un démontage les rend (jamais dans le joueur ni dans une voiture : un tronc attend qu'ils s'en aillent ; au chargement aussi). Au-delà du treillis, les pins lointains se posent sur le sol tel que le maillage le dessine (ses bandes de 8 et 32 m), pas sur la fonction de hauteur, qui monte au-dessus sur les crêtes. Les caméras regardent à travers ; tout près, le décor se dissout en tramé.
- **Sauvegardes** : `FactorySave` version 4, avec `py` et l'identifiant du relief. Une ancienne sauvegarde (bâtie à plat : sans identifiant de relief) garde **tous** ses bâtiments : `py` est calculé au chargement, ceux dans le lac reposent sur un remblai ; ses voitures sont posées sur le sol (dans un garage, sur sa dalle), sauf dans l'eau ou sur une pente trop forte, où elles attendent une place de garage ; un toast l'explique une fois. Une sauvegarde faite sur le relief garde ses voitures où on les a laissées (hors de la carte ou dans le lac exceptés). Une partie de dev `?terrain=` n'est jamais sauvegardée, dès le chargement de la page.
- **Fuites corrigées au passage** : chaque mode laissait une carte d'ombre 2048² à chaque entrée (`LightRig.dispose`) ; la vue de l'usine laissait ses géométries de sol.

## Concession et ventes (octobre 2026)

Ticket « Utiliser le trop-plein de pièces pour fabriquer des voitures et les vendre » : une fois ses voitures construites, les pièces des assembleuses s'entassent au hangar (stock illimité), et le jeu n'avait pas d'argent. Choix validés : un **bâtiment automatique** alimenté par convoyeur **et** un bouton « Vendre » au garage ; des **crédits** affichés et sauvegardés, rien à acheter dans ce ticket (trackdays, essence, réparations les dépenseront) ; un **prix selon les pièces** ; un **palier 6 « Commerce »** payé en pièces de voiture ; la concession monte **la voiture la plus rentable, toute seule** (pas de recette à choisir). Méthode : une cartographie (six lecteurs), trois conceptions par axe (cœur, interface, rendu) et un critique, puis une revue adverse.

- **Concession** (`dealer`, 3×2 cases, touche 9) : un magasin à l'arrière avec trois entrées (une par case, comme `MACHINE_IN`), une vitrine à l'avant, pas de sortie. Coût 60 plaques, 30 tiges, 120 boulons (ce que paie déjà le fuzz de `planLinks`).
  - **Sans plafond** : elle prend toute pièce de voiture (`CAR_PARTS`, déplacé dans `data/blueprints.ts`) et refuse le reste, comme une machine. Avec un plafond par pièce, une ligne mélangée se bloque pour de bon (8 roues attendent un moteur coincé derrière une 9e roue refusée) ; un test fait passer 9 roues devant le châssis et le moteur.
  - **La voiture la plus rentable** (`bestSale`) : les 6 voitures complètes des plans constructibles, triées par prix ; elle prend la première que son stock permet. Les 4 roues d'une voiture sont de la même sorte (`CarInstance.parts` : une pièce par emplacement). 10 s par voiture (`DEALER.SELL_TICKS`), la suivante démarre au même tick, comme une machine. Une ligne mélangée peut lancer un kart juste avant le 4e panneau : les panneaux attendent la voiture suivante, qui sera une Sportive.
  - **Dans la simulation** (entière, déterministe ; elle tourne dans tous les modes et ne voit pas `GameState`) : `DealerB { stock, car, progress }`, `progress` seul change à chaque tick (la clé du panneau l'ignore). Crédits et ventes par plan sont dans `FactorySim` et `FactorySave` (`credits`, `sales` : champs facultatifs, version toujours 4, nettoyés au chargement, compris dans `hash()`). `sell()` est la seule façon de gagner : la concession et le garage passent par elle ; elle émet `sold`. (Depuis « Usure et réparations », `sellWorn` en est une seconde, et `spend` la seule sortie.)
  - **« Charger (sac puis hangar) »** (`loadDealer`, `planLoad`) : exactement les pièces des voitures complètes que permettent le sac, le hangar et son stock (moins ce qu'elle a déjà). Le compte de voitures et de crédits est un écart : une concession déjà pleine n'en annonce pas de nouvelles, quatre panneaux qui font d'un kart en attente une Sportive annoncent « +1 700 cr ». `planCars` prend chaque voiture en bloc, dans l'ordre des prix : même résultat que de reprendre la meilleure encore et encore (le stock ne fait que baisser), en 6 étapes au lieu d'une par voiture (le panneau le recalcule à 5 Hz avec le hangar).
  - **« Reprendre les pièces »** (`unloadDealer`) : le stock en attente, pas la voiture en cours, au sac puis au hangar, dans l'ordre de `CAR_PARTS` (le sac se remplit pareil quel que soit l'ordre d'arrivée). Le démontage rend le coût, le stock et les pièces de la voiture en cours ; les crédits restent.
  - **Sauvegardes** : un stock inconnu est jeté, un objet connu qui n'est pas une pièce va au hangar ; une voiture en cours devenue invalide (emplacement obligatoire vide, pièce que son emplacement ne prend plus) rend au hangar les pièces que les emplacements actuels de son plan prennent encore ; celles d'un plan inconnu ou d'un emplacement disparu sont perdues. Comme pour l'objet en cours d'une machine, un changement futur du nombre de pièces d'un emplacement n'est pas rattrapé.
- **Prix par pièces** (`data/sales.ts`, pur) : valeur d'une pièce = ses matières plus son temps machine, en ticks (recettes de machine seulement, divisées par le nombre produit ; minerai et latex au temps de la foreuse, 40) ; prix = valeurs × 5/4, arrondi à la dizaine, en entiers (`SALE`). L'établi est ignoré : il compterait une plaque 130 au lieu de 180.
  - Valeurs : lingot 80, plaque 180, tige 120, boulon 40, pneu 140 ; châssis 880, moteur 1 100, roue 400, roue racing 640, panneau 340, aileron 460.
  - Prix : Kart 4 480 cr (roues racing +1 200), Sportive 6 180 cr (roues racing +1 200, aileron +570), Sportive complète 7 950 cr. Les bonus affichés sont des différences de `carPrice`, jamais des constantes.
- **Garage** : « Valeur : … cr » sous la voiture ; « Vendre » à côté de « Démonter », pour la voiture dans la place seulement (jamais celle qu'on conduit), avec sa propre confirmation (`sell:` + id ; une seule confirmation à la fois, « Annuler » rend le focus à « Vendre ») et le nom de la voiture de course qui prendra la place. `sellCar` suit `disassembleCar` sans rendre de pièces : la voiture de course retombe sur la première restante, les numéros ne reculent pas, les records gardent l'ancien identifiant (ils ne servent qu'à dire « course faite avec sa voiture »).
- **À l'écran** :
  - **Crédits** : pastille dorée « 4 480 cr » à côté du titre du hangar en haut à droite, dès la concession débloquée ou une première vente ; chiffres groupés par une espace simple (le code n'a aucune espace insécable ; `white-space: nowrap`). Mise à jour sur place à 5 Hz : une hausse fait monter « +7 950 cr » dessous. La liste du hangar, reconstruite à chaque livraison, aurait coupé l'animation : en-tête et liste sont séparés. Pas de toast par vente automatique (le toast est unique : une concession toutes les 10 s masquerait le reste). Le solde est aussi dans l'en-tête des panneaux du hangar, de la concession et du garage (le garage cache le panneau du hangar, et on y vend).
  - **Panneau de la concession** : état (« Assemblage : Sportive (roues racing, aileron) · 7 950 cr », « En attente : il manque 1 moteur, 2 roues pour la prochaine voiture »), barre, pièces montées, liaison de l'entrée, les six pièces en attente (grisées à 0), la suivante, « Charger » (une ligne dit combien de voitures et de crédits), « Reprendre les pièces (n) », ventes, prix de base et bonus. À la manette, le focus part sur la liste des prix : ni sur « Charger », qui peut déplacer des centaines de pièces, ni sur « Fermer ».
  - **Vitrine** : la voiture en cours s'y monte pièce par pièce au fil de la barre (le même rendu que le chantier du garage : `dealerBuild` puis `buildLook`) ; à la vente (événement `sold`), elle s'enfonce dans le podium et « +7 950 cr » monte au-dessus de l'enseigne. Barre de progression sous l'enseigne, lampe verte (assemblage), orange (pièces en attente), grise (vide). La miniature du menu montre une Sportive complète ; le fantôme de construction n'a pas de voiture (il est refait à chaque R).
- **Palier 6 « Commerce »** : 2 châssis, 2 moteurs, 8 roues, 4 panneaux (environ 76 s sur une assembleuse). Une sauvegarde qui avait tous les paliers de sa version le reçoit (règle `tierMax`, testée) : une partie finie voit réapparaître les objectifs « Construis une concession » et « Vends une première voiture », c'est voulu (on y découvre la nouveauté). `BUILD_CATEGORIES` passe dans `data/buildings.ts` : un test vérifie que le menu montre chaque bâtiment une fois, un autre que chaque bâtiment du menu a sa touche chiffre (9 au plus : les jetons `{hotkeyN}` n'ont qu'un chiffre).
- **Objectifs** : `tier6`, `dealer`, `sell` entre la course et le bonus Sportive (`ObjectiveContext.carsSold`).
- **Tests** : `sales.test.ts` (valeurs, prix, choix, plans, chargement, données corrompues), `dealer.test.ts` (entrées, assembleuse collée, vente, enchaînement, ligne mélangée, charger, reprendre, démontage, sauvegarde en cours de vente, anciennes sauvegardes), conservation des pièces avec une concession, vente au garage, crédits et palier 6 dans `GameState`, disposition et colliders sur le relief (`dealerLayout.test.ts`, `terrain-physics.test.ts`).
- **Revues** : un critique a recoupé les trois conceptions avant le code (noms, signatures, un `planLoad` qui recomptait les voitures déjà en stock, deux compilations cassées). La revue adverse en quatre axes (simulation et sauvegardes, interface et manette, rendu, documentation), chaque constat contre-vérifié, a confirmé 2 défauts, corrigés : le « +X cr » rejoué à chaque fermeture du garage (une animation CSS repart quand un élément caché réapparaît : la classe s'enlève maintenant à la fin, comme pour la barre du sac) et une phrase de ces décisions sur les voitures en cours invalides au chargement. 5 constats ont été réfutés. Le contrôle dans le navigateur a fait ajouter un fond au « +X cr » du HUD, qui chevauchait la liste du hangar.
- **Non retenu** : l'argent comme objet (`ItemId` : il lui faudrait une recette, un modèle, une pile, et il passerait par le sac) ; un onglet « Ventes » au hangar avec une réserve à garder (moins visible qu'un bâtiment, et « Charger » couvre le surplus déjà stocké) ; un modèle choisi dans le panneau (il fallait refuser des pièces, donc bloquer des lignes).

## Recettes en icônes (octobre 2026)

Ticket « Mieux voir une recette dans l'assembleuse avec les icônes des ingrédients ». Chaque recette du panneau d'une machine (fonderie, constructeur, assembleuse) montrait seulement l'icône du produit et une ligne de texte (« 2 plaques + 2 tiges de fer + 4 boulons → 1 châssis · 6.0 s »).

- **Ingrédients en cases** (`FactoryHud.recipeChips`) : chaque entrée est une petite case avec son icône et sa quantité dans le coin, comme les cases du sac, puis « → » et le produit. On compare d'un coup d'œil (une roue racing prend 2 pneus et 2 boulons, une roue 1 pneu). Le nom de la recette et sa durée restent sur la ligne du haut.
- **Le texte complet reste dans l'infobulle** du bouton : la souris l'a au survol, la manette dans sa bulle sous la recette visée. Deux icônes proches (roue, roue racing ; châssis, moteur) se distinguent ainsi par leur nom.
- **Durées en français** (`secondsLabel`) : « 6 s », « 0,75 s », au lieu de « 6.0 s » ; l'infobulle de l'établi aussi.
- **Revue** (un relecteur, un contre-vérificateur) : 1 défaut confirmé, corrigé. Les recettes plus hautes font défiler le panneau dès 768 px de haut ; au premier choix, le bloc des entrées apparaît au-dessus de la liste et poussait la recette choisie hors de vue (la manette perdait son focus visible). Elle reste maintenant à sa place à l'écran, sous la souris.
- **Non retenu** : la quantité possédée sur chaque case (comme à l'établi). Une machine est nourrie par convoyeur, et « Charger » dit déjà s'il y a de quoi la remplir : le stock surchargeait la liste.

## Cadences par minute (octobre 2026)

Ticket « Voir le taux de production par minute des machines pour optimiser ». Choix validés : la cadence dans le **panneau** de chaque machine, foreuse et concession, **en visant** une machine (bas de l'écran), et un onglet **Statistiques** au hangar pour toute l'usine.

- **Mesure dans la simulation** : chaque foreuse et machine garde les ticks où ses dernières productions se sont terminées (`done`), chaque concession ceux de ses ventes avec les pièces de chaque voiture (`taken`), sur la dernière minute (`STATS.WINDOW`, 1 200 ticks), et le tick depuis lequel elle est mesurée (`since` : posée, recette choisie, ou sauvegarde chargée sans ces champs). Entiers, sauvegardés, compris dans `hash()`. Ce qui sort de la fenêtre est oublié à chaque tick : l'état vivant et celui d'une sauvegarde rechargée sont identiques. Changer de recette remet la mesure à zéro.
  - `rateOf(b)` compte le **travail fait** dans la fenêtre, pas les productions : chaque production terminée compte pour sa part dans la fenêtre, celle en cours pour son avancement. À plein régime, la cadence vaut exactement le plein régime à chaque tick, quelle que soit la durée de la recette (un moteur prend 160 ticks, 7,5 par minute) et dès la première minute. Compter les productions entières faisait osciller un moteur entre 7 et 7,5/min et donnait des dents de scie pendant la première minute. Jamais au-dessus du plein régime ; « mesure en cours… » pendant les 3 premières secondes (`STATS.MIN_SPAN`). Seul écart restant : une machine commence son premier travail le tick après sa recette (2 % de moins au plus, la première minute).
  - `flows()` : pour toute l'usine, objets produits (foreuses, machines), consommés (machines, concessions) et **demandés** par minute (`demand` : ce que chaque machine prendrait à plein régime ; une concession, ce qu'elle a pris). Une chaîne affamée produit autant qu'elle consomme : seul le besoin montre le manque. Le minage à la main et l'établi ne comptent pas, comme dans les objectifs ; un bâtiment encore en mesure non plus.
  - Choisi plutôt qu'un compteur global par seconde : la cadence d'un bâtiment et le bilan de l'usine viennent des mêmes données, et un bâtiment démonté sort aussitôt des statistiques.
- **À l'écran** (`data/rates.ts`, pur : `perMinute`, `recipeRates`, `rateNumber` « 7,5 » / « 20 ») :
  - **Recettes** : « 6 s · 20/min » (le produit à plein régime) ; l'infobulle ajoute les entrées par minute.
  - **Panneaux** : « Cadence 15/min sur 20 (75 %) » (vert à 95 % et plus, rouge sous 50 %), puis pour une machine « À plein régime » ses entrées et sa sortie par minute : de quoi dimensionner une chaîne (une assembleuse de châssis demande 20 plaques/min, un constructeur de plaques entier).
  - **En visant** : « E configurer : Constructeur · Pneu 15/min (75 %) ». La clé du panneau ignore les tampons de mesure : il ne se redessine que quand un chiffre affiché change.
  - **Hangar → Statistiques** : objet, produit, consommé, besoin, bilan = produit − besoin (rouge : la chaîne en manque, des machines attendent ; vert : ça s'entasse). La clé de rafraîchissement est faite des chiffres affichés. L'onglet prend toute la largeur (le sac n'y sert à rien).
  - « 1 voiture/min », « 2 voitures/min » : pluriel à partir de 2, comme en français.
  - Le rôle du convoyeur dans le menu donne son débit, 180 objets/min.
- **Exemple** (usine de démonstration) : le constructeur de pneus tourne à 75 % ; une foreuse donne 30 latex/min, il en demande 40.
- **Tests** : `rates.test.ts` (chaîne à plein régime, moteur exact à chaque tick, machine affamée, nouvelle recette, foreuse bloquée, concession, bilan d'une chaîne de pneus affamée, sauvegarde après un arrêt, anciennes sauvegardes).
- **Revue** (deux axes, chaque constat contre-vérifié) : 9 défauts confirmés ou plausibles, corrigés. Le comptage de productions entières (moteur qui oscille, dents de scie la première minute), des tampons vieillis gardés en jeu mais pas au rechargement (hash différent), un bilan jamais rouge pour une chaîne affamée (d'où le besoin), « 1 voitures/min », la clé de l'onglet qui ignorait le bilan, l'indication du hangar sans « statistiques », un « 30/min au plus » faux dans le README. 1 constat réfuté.

## Usure et réparations (octobre 2026)

Ticket « Usure des karts et des pneus en course et à l’usage, réparations obligatoires ». Avant lui, une voiture ne s’usait jamais, et les crédits de la concession n’avaient rien à payer. Choix validés par l’auteur :

- **une jauge par emplacement** : châssis, moteur, roues (les 4 ensemble), carrosserie (les 4 panneaux ensemble), aileron ; 100 % = neuf ;
- **effet progressif** : chaque pour cent perdu se sent un peu ; à 100 %, la conduite est identique au bit près ;
- **obligatoire = plus de départ en course** sous un seuil ; la voiture roule encore dans l’usine pour rentrer au garage, et le kart de location reste disponible ;
- **paiement au choix**, deux boutons : en matières (le sac d’abord, puis le hangar) ou en crédits ;
- **causes selon la pièce** : les roues, la distance au sol, beaucoup plus en dérapage, au frein à main et en glisse ; le moteur, la distance, plus à plein gaz ; châssis, carrosserie et aileron, les chocs et les remises en place ;
- **rythme** : des pneus neufs tiennent une séance de chrono, une trentaine de tours d’Ovale ; le moteur et le châssis, plusieurs séances, sauf gros chocs ;
- **réserve de pièces usées** : une pièce retirée reste usée et va dans une réserve partagée par tous les garages (le sac et le hangar ne changent pas). On peut l’y réparer, la vendre selon son état, ou la reposer avec son état sur une voiture ou dans un chantier. Une voiture usée se vend moins cher ;
- **affichage** : une jauge par pièce au garage ; un état résumé au choix du circuit, en course et en conduite dans l’usine ; en 3D, pneus et carrosserie s’assombrissent par paliers, et un moteur très usé fume.

Méthode : une cartographie des points d’accroche (six lecteurs, un critique) ; trois architectures du cœur, « simplicité », « ressenti physique » et « robustesse », notées par deux juges : « simplicité » gagne à 38/50 chez les deux. Une synthèse lui greffe le meilleur des deux autres : courbe convexe, `raceCarFor` pur et livre de comptes de « robustesse » ; panneau d’arrêt, part d’appui de l’aileron, remises en place par cause, chocs cumulés puis quadratiques et prix « neuf moins réparation » de « ressenti physique ». Viennent ensuite la conception de l’interface et du rendu, puis un critique final (19 problèmes, 16 manques, 2 écarts aux choix validés), intégré au plan avant le code. Quatre jalons, un commit chacun : M1 (mesure, sans effet), M2 (effets, réparations, réserve), M3+M4 (blocage, affichage en conduite), M5 (rendu 3D). Chacun a été relu sous plusieurs angles, chaque constat contre-vérifié. Enfin, une revue adverse finale (voir « Revues »).

- **Unité** (`data/wear.ts`, constantes `WEAR` dans `data/balance.ts`) : l’usure se compte en millièmes entiers par emplacement, `CarInstance.wear?: Partial<Record<SlotId, number>>`. 0 veut dire neuf, et la clé est alors absente : une voiture neuve ou réparée n’a pas de `wear` (les `toEqual` des tests de chantier restent verts). L’état affiché vaut ⌊(1000 − w) / 10⌋ % : 100 % seulement pour une pièce neuve, 20 % à 800 ‰. Tous les seuils se lisent « au-delà de » (>).
- **Mesures du `Vehicle`** (lecture seule ; la physique ne bouge pas) :
  - `lateralSpeed` : la vitesse latérale au début du pas (la glisse des pneus) ;
  - `impact` (et `impactX/Y/Z`) : le Δv que les contacts ont donné à la caisse pendant le dernier pas du monde. La vitesse est lue juste après `updateVehicle` (`body.linvel(vOut)`, sans allocation) et retranchée au pas suivant. On retire la gravité, puis la part le long de l’axe haut de la voiture : le bas de la caisse est à hauteur du centre des roues, un atterrissage ou un talonnage compterait sinon ;
  - inclinaison du sol : quand la normale moyenne des roues au sol s’écarte de l’axe haut de plus de 5° (pleinement à 10°, `TILT_FROM` et `TILT_FULL`), la caisse a heurté ce sol (atterrissage nez en avant, pied ou sommet d’une rampe). On retire aussi la part le long de l’inclinaison, mais au plus ce que ce sol a pu donner. Il pousse selon sa normale et frotte au plus aussi fort : à un angle θ, au plus `lift × (sin θ + 1) / (cos θ − sin θ)` dans le plan, `lift` étant la poussée vers le haut. Sans poussée vers le haut, rien n’est retiré ; au-delà de 45°, tout l’est. L’inclinaison se lit avec l’axe haut du moment où les normales ont été prises (`upOut`), pas avec celui d’après le choc ;
  - `reset()` et `hold()` invalident la mesure. `scriptVelocity()` remplace les `setLinvel` de l’eau et du bord mou : même appel, écart retiré de la mesure. `skipImpact(2)` suit le relèvement du sol sous la voiture conduite (une dalle posée).
- **Compteur `WearMeter`** (`car/wearMeter.ts`, pur) : un `step` par pas fixe à 60 Hz, juste après `vehicle.step`. Un pas dont une lecture n’est pas un nombre fini est ignoré : aucun NaN n’atteint la sauvegarde. Par pas, avec sol = min(1, roues au sol / 4), km = |v| × dt / 1000 et glisse = max(0, vitesse latérale − 0,3) × dt / 1000 :
  - roues += sol × (km × (36 + 150 au frein à main) + glisse × 400) ;
  - moteur += km × (3 + 10 × accélérateur) ;
  - chocs : un `impact` au-delà de 2 m/s ouvre une fenêtre de 4 pas au plus, qui cumule les Δv. À sa fermeture, chaque pièce de caisse posée prend min(300, K × max(0, ΣΔv − 3)²) ‰, avec K = 0,33 pour le châssis, 0,5 pour la carrosserie et 0,4 pour l’aileron. Un choc de 10 m/s coûte 16 ‰ au châssis et 24,5 ‰ à la carrosserie. Un mur de face à 100 km/h (Δv ≈ 28 m/s) coûte 206 ‰ au châssis, 300 ‰ à la carrosserie (le plafond) et 250 ‰ à l’aileron. Un choc étalé sur plusieurs pas coûte autant qu’en un seul ;
  - remises en place (`putBack`, ‰ châssis / carrosserie / aileron) : Retour arrière ou voiture coincée 2 / 3 / 3, tonneau 15 / 25 / 30, chute ou sortie de carte 20 / 20 / 20, eau 10 / 15 / 10. Suppr et « Réessayer » ne coûtent rien ;
  - les millièmes entiers s’écrivent en place dans `car.wear` dès qu’ils sont atteints, comme la pose : une sauvegarde peut tomber à tout moment, et fermer l’onglet n’efface rien. `end()` arrondit les fractions (un demi-millième compte). `last` (cause, pièce la plus touchée, ‰, direction) alimente l’éclat du HUD et les étincelles ; son `seq` n’avance qu’à 1 ‰ ou plus.
- **Constantes finales** : celles de la conception, sauf deux. `TIRE_PER_KM` passe de 30 à 36 : le bot glisse à peine, et un tour propre d’Ovale devait prendre environ 21 ‰. Les paliers du rendu passent de 250 / 500 / 750 à 250 / 500 / 800 ‰ : le plus sombre veut dire « à réparer ». Seuils : blocage au-delà de 800 ‰, orange au-delà de 500 ‰, éclat dès 5 ‰, fumée au-delà de 700 ‰.
- **Effets** (`car/wornTuning.ts`, pur) : `wornTuning(réglage, usure, pièces)` renvoie le même objet sans usure, ce qui garde la conduite identique au bit près. Il agit sur le réglage final, jamais sur la masse, le centre de masse ou les suspensions (figés à la création du corps), ni sur `topSpeedMs`, qui règle le braquage selon la vitesse. Courbe L(u) = u(1 + 3u)/4 avec u = w / 1000 : pente 1/4 au départ, L(0,1) = 0,0325, L(0,8) = 0,68, L(1) = 1. Effet d’une pièce hors d’usage (`WEAR.EFFECT`) :

  | Pièce | Hors d’usage | Au seuil (800 ‰) |
  |---|---|---|
  | Roues | les trois frottements −25 % | adhérence −17 % |
  | Moteur | force avant et arrière −20 % | puissance −13,6 %, pointe −7 % |
  | Châssis | braquage −15 %, freins −20 % | −10,2 % et −13,6 % |
  | Carrosserie | traînée +20 % | +13,6 %, pointe −6,2 % |
  | Aileron | −50 % de **sa** part d’appui | −34 % de sa part : −20,4 % de l’appui de la Sportive complète, dont il porte 60 % |

  `wearEffects` donne ces écarts à l’interface (« adhérence −17 % · … »).
- **Application** :
  - en course, l’effet est figé par tentative : calculé au départ et à chaque recommencement (Suppr, « Réessayer », View), jamais au respawn. Le compteur ne tourne qu’en phase `running` : ni le compte à rebours, ni le freinage après la ligne. Une remise en place ne coûte qu’une fois la course partie. `exit` arrondit avant la sauvegarde du changement de mode ;
  - dans l’usine, le réglage usé s’applique à la montée, puis dès qu’un pour cent affiché change (`shownConditions`, sans allocation) : il n’y a pas de chrono à protéger. Le compteur ne tourne que si le joueur a les commandes. Descendre, quitter le mode et `dispose` appellent `end()` ;
  - ne s’usent jamais : le kart de location (il n’a pas de `CarInstance`), l’essai depuis l’éditeur (le temps auteur) et une voiture imposée (`?car=`).
- **Blocage** (`race/raceCar.ts`, pur) : une voiture dont une pièce posée dépasse 800 ‰ (19 % affiché ou moins) ne prend plus le départ. L’aileron compte, et le retirer (« Aucun ») débloque la voiture. `raceCarFor` choisit la voiture d’une course : l’essai depuis l’éditeur et une spec imposée passent avant le blocage. `endAttempt` ferme d’abord un choc encore ouvert, puis `attemptGate` décide au recommencement et à l’arrivée. Chemins couverts :
  1. `RaceMode.enter`, le filet de sécurité (menu principal, `?mode=race`…) : la location court à la place, avec un toast ;
  2. recommencer avec une voiture devenue bloquée : état `halted`. La course reste figée dans son compte à rebours : ni chrono, ni usure, ni respawn. Un panneau passif propose [Courir avec le kart de location] [Usine] [Circuits]. Entrée ou Y lance la location depuis `update`, suivie d’un `return` : aucun changement de mode ne part de `fixedUpdate`, car il libère aussitôt le monde que ce pas fait avancer ;
  3. arrivée : « Réessayer » devient « Courir avec le kart de location » ;
  4. choix du circuit : « Kart Oopi n°1 (à réparer) ». « Courir » devient « À réparer au garage », désactivé, et « Courir avec le kart de location » prend le focus (désactivé lui aussi sur un circuit invalide) ;
  5. garage : « Courir » désactivé, avec une bulle d’explication ;
  6. siège : Entrée affiche un toast et le joueur reste dans la voiture ; l’indication passe en rouge. `raceBlockerOnExit` arrondit d’abord le compteur : une voiture que l’arrondi ferait passer au-delà du seuil reste aussi dedans.

  La voiture reste la voiture de course (`selectedCarId`) : réparée, elle court de nouveau.
- **Prix** (`data/wear.ts`, en entiers) : le kit de réparation d’une pièce vient de sa recette d’assembleuse. Pour une roue, les pneus seuls (1 par roue, 2 par roue racing) ; pour les autres pièces, la moitié de la recette. En matières, ⌈kit × n × w / 1000⌉ de chaque objet du kit. En crédits, la valeur du kit (`PART_VALUES`) plus 25 %, au prorata de l’usure, à la dizaine supérieure. Jamais gratuit : dès 1 ‰, au moins 1 de chaque objet du kit, ou 10 cr. Devis :

  | Pièce | À 800 ‰ (20 %) | Hors d’usage |
  |---|---|---|
  | Roues | 4 pneus ou 560 cr | 4 pneus ou 700 cr |
  | Roues racing | 7 pneus ou 1 120 cr | 8 pneus ou 1 400 cr |
  | Châssis | 1 plaque, 1 tige, 2 boulons ou 380 cr | même kit ou 480 cr |
  | Moteur | 2 plaques, 1 tige, 2 boulons ou 470 cr | même kit ou 590 cr |
  | Carrosserie | 2 plaques, 4 boulons ou 520 cr | même kit ou 650 cr |
  | Aileron | 1 plaque, 1 boulon ou 200 cr | même kit ou 250 cr |

  Après un tour propre d’Ovale (environ 21 ‰ de pneus), des roues standard coûtent 1 pneu ou 20 cr.
  - **Voiture usée** (`wornCarPrice`) : le prix neuf moins la somme des réparations en crédits, jamais sous 0. Un Kart aux roues à 20 % vaut 4 480 − 560 = 3 920 cr ; une Sportive complète à 800 ‰ partout, 7 950 − 2 690 = 5 260 cr. Réparer en crédits puis vendre rapporte exactement autant.
  - **Lot usé** (`wornSetPrice`) : ⌊valeur × n × (1000 − w) / 1000⌋ cr, sans la marge des voitures. 4 roues à 20 % valent 320 cr, un lot hors d’usage 0. Démonter puis vendre les lots rapporte toujours moins que vendre la voiture, d’au moins un quart de la valeur des pièces : un Kart à 800 ‰ partout vaut 3 070 cr entier, 716 cr en lots.
- **Crédits** (`FactorySim`) : `spend(montant, 'repair')` est la seule sortie. Il n’accepte qu’un entier sûr strictement positif, au plus égal au solde ; sinon il renvoie `false` sans rien changer. `sellWorn(objet, n, usure)` est une seconde entrée : un emplacement entier de pièce de voiture, une usure entière de 1 à 1000. Il ne compte ni dans `sales` ni dans `carsSold`. `sell(…, wear)` applique `wornCarPrice`. Nouveaux événements `spent` et `soldWorn`. Le livre de comptes est testé : crédits = Σ voitures vendues + Σ lots vendus − Σ dépenses. La pastille des crédits suit `creditsShown` (pur) : concession débloquée, solde au-dessus de 0, une voiture vendue, ou des crédits dépensés (`state.objectives.creditsSpent`, posé seulement quand `spend` réussit). Une réparation payée en matières ne l’affiche pas.
- **Réserve et chantiers** : `GameState.worn: WornSet[]` (`{ item, n, wear }`, toujours un emplacement entier), sauvegardé dans `SaveData.worn?`. `SaveData.version` reste 1. Y vont une pièce usée échangée ou retirée (« Aucun »), « Remplacer par du neuf », le démontage, « Retirer » et « Abandonner » dans un chantier, et au chargement les lots d’un chantier dont le garage n’existe plus. Jamais au hangar : ils en ressortiraient neufs. Une pièce usée ne redevient un objet du sac qu’après une réparation payée. `BuildSlot.wear?` porte un lot reposé dans un chantier, toujours plein, et `carFromBuild` reporte son usure sur la voiture sortie.
  - Au chargement, `sanitizeWear` ne garde que les emplacements réels du plan (`blueprintById`) qui portent une pièce acceptée, en entiers bornés à 0..1000, zéros retirés. `sanitizeWornSet` exige une pièce de voiture et le nombre de son emplacement. Une usure illisible de lot vaut « hors d’usage », jamais neuf, et un lot partiel dans un chantier est jeté.
- **Actions** (`garage/wearActions.ts`, pures) : `slotQuote`, `carQuote` et `payCheck` ; `repairCarSlot` et `repairCar` (« Tout réparer », tout ou rien) ; `renewCarSlot` (« Remplacer par du neuf »), refusée si le stock manque, sinon des pièces viendraient de rien ; `repairWornSet` et `sellWornSet` ; `installWornSet` sur la voiture de la place (les pièces remplacées vont à la réserve si elles sont usées, au sac sinon) ; `installWornInBuild` dans un chantier, qu’elle peut commencer dans une place vide. Refusées, elles renvoient `null` ou `false` sans rien changer ; l’appelant sauvegarde. `swapCarPart`, `disassembleCar`, `removePart` et `refundBuild` envoient les lots usés à la réserve, et `applyChange` lève une erreur sur un compte négatif.
  - Correctif au passage : `blueprintById` remplace `BLUEPRINTS[x]` dans `assembly.ts`, `FactoryCars.ts` et `GaragePanel.ts`. Une voiture d’un plan nommé « constructor » plantait.
- **Objectif** : « Répare une pièce au garage » (`repair`), juste après « Termine une course avec ta voiture ». Toute réparation le valide (`state.objectives.repair`). Aucun palier ne le valide : une partie avancée le voit apparaître, comme le palier 6, et c’est voulu.
- **Interface** (`ui/wearGauge.ts`, `ui/wearHud.ts`, textes purs dans `data/wearText.ts`) :
  - la jauge : verte, orange au-delà de 500 ‰ (49 % ou moins), rouge au-delà de 800 ‰, avec un trait au seuil ;
  - garage : une jauge et un pourcentage par pièce. Sur une pièce usée, « Réparer » avec ses icônes « j’ai / il faut », « Réparer · 560 cr » et « Remplacer par du neuf (4 en stock) » ; « Tout réparer » dès 2 pièces usées. Sous la voiture, « Valeur : 3 920 cr (4 480 cr réparée) » et les effets de l’usure ; une alerte et « Courir » grisé quand elle est bloquée ; une mini-jauge et « À réparer » dans la liste des voitures ;
  - un onglet « Pièces usées » regroupe les lots par objet, nombre et pourcentage affiché (« ×2 »), avec Réparer (matières ou crédits), Vendre (confirmé) et Poser. Le brouillon d’une place vide propose les lots compatibles pour commencer une voiture ;
  - la clé de rafraîchissement du garage ne contient que les pourcentages affichés et des stocks plafonnés aux devis visibles (`quoteCaps`) : une machine qui remplit le hangar ne redessine rien. Le focus initial ne tombe jamais sur un bouton qui paie ;
  - choix du circuit : « État : roues 46 % » avec une mini-jauge et les effets ; pour la location, « Prêté par le circuit : il ne s’use pas. » ;
  - course : une pastille sous « km/h » (« Roues 46 % », « Neuve ») ; un éclat « Choc : carrosserie −3 % » au-dessus du compteur dès 5 ‰, jamais un toast (le toast est unique et global) ; « Usure de cet essai : roues −3 % · moteur −1 % » à l’arrivée ; un toast, une seule fois, quand le seuil est franchi ;
  - usine : l’indication du bas montre la pièce la plus usée, en orange, puis en rouge au-delà du seuil, où « courir » disparaît. Le même éclat apparaît au-dessus. Un toast, une seule fois par conduite, pour une voiture bloquée à la montée ou au franchissement du seuil. En visant une voiture bloquée : « à réparer (roues 18 %) » en rouge ;
  - manette partout : chaque nouveau bouton porte `data-action`, `data-part-slot`, `data-pay` ou `data-worn` pour retrouver son focus ; les panneaux d’arrêt et d’arrivée sont passifs (un coup de frein à main juste après ne les clique pas).
- **Rendu** (`car/CarModel.ts`, `car/CarFx.ts`) :
  - les pneus (pneu et jante) et la caisse s’assombrissent au-delà de 250, 500 et 800 ‰. La caisse suit la carrosserie sur la Sportive, le châssis sur le kart ; l’aileron suit sa propre jauge ; le pilote ne change jamais ;
  - les matériaux usés sont des copies teintées du matériau du kit (`wornMaterial`), partagées par sorte et par palier : 6 au plus pour tout le jeu, jamais libérées, comme `bareMaterial`. Seule la couleur change : même texture, même programme, aucune compilation quand une voiture s’use. Le matériau du kit n’est jamais modifié ;
  - `setWear(code)` repeint sans reconstruire : l’usure n’est pas dans `carModelKey`. Le code (`wearLookCode` = roues + 4 × caisse + 16 × aileron) se compare à chaque image sans rien allouer ;
  - `CarFx` : fumée au-delà de 700 ‰ de moteur, depuis `engineAnchor` : 5 à 22 bouffées par seconde à plein gaz, 35 % de cela au ralenti, une toux au-delà de 850 ‰. Un choc qui use jette 6 à 32 étincelles (6 + 0,6 par ‰), le long de la surface touchée. Deux `InstancedMesh` en pool (64 et 96 instances), sans allocation par image, à chaque mode (course, usine). Leurs shaders sont compilés à l’entrée, et de nouveau quand on change les ombres (`recompileForShadows`, `refreshSharedCarMaterials`) ;
  - l’usure se voit sur les voitures garées, conduites, en course et dans un chantier. La vitrine de la concession, la location et l’essai depuis l’éditeur restent neufs.
- **Calibration mesurée** :
  - `docs/medal-calibration.tsv` a été re-mesuré en M1 : il datait de P4, et `Vehicle.ts` avait changé depuis. Chaque meilleur temps a pris 6 à 20 ms, et la marge d’argent du kart sur l’Ovale passe de 0,43 % à 0,34 % (19 125 ms pour 19 190). Régénéré à la clôture : identique.
  - `docs/wear-calibration.tsv` (`CALIBRATE=1 npx vitest run tests/wear-sim.test.ts`) fait rouler le bot réglé comme pour les médailles, et un pilote brouillon qui tire le frein à main, plein gaz, dans chaque virage serré au-delà de 12 m/s. Des pneus neufs tiennent 35 à 38 tours propres d’Ovale avant le seuil (21 à 23 ‰ par tour), 14 à 18 tours en dérapant. Un moteur tient 108 à 122 tours. Un tour propre ne coûte rien à la caisse, sur l’Ovale comme sur la Colline (0,00 ‰). Régénéré à la clôture : identique.
  - Les effets se mesurent avec un pilote régulier (`tests/helpers/steadyDriver.ts`), car le tour du bot saute de plusieurs pour cent pour 0,1 % de moteur. Il roule sous la limite d’adhérence (28 m/s²) et, comme un joueur qui connaît sa voiture, prend l’adhérence et les freins de la voiture usée. Un temps au tour est la moyenne de la moitié la plus rapide, sur des départs reculés pas à pas : 5 sur l’Ovale, tous les 40 cm ; 64 sur la Colline, tous les 5 cm ; les 16 premiers au seuil.
  - Résultats : à 10 % d’usure partout, +0,30 à +0,38 % sur l’Ovale et +0,20 à +0,66 % sur la Colline. Au seuil, +8,8 à +9,9 % sur l’Ovale, +10,2 à +11,3 % sur la Colline, et +16,9 % pour la Sportive sur la Colline. La physique seule (le pilote de la voiture neuve) coûte au moins 3 % : 3,9 à 6,4 % sur l’Ovale, 8,0 à 14,1 % sur la Colline. Un kart au seuil reste plus rapide que la location : 21,9 s contre 22,6 s sur l’Ovale, 16,0 s contre 16,3 s sur la Colline.
- **Exceptions** :
  - **pause de l’usine** : rien ne s’use quand le joueur n’a pas les commandes (pause, panneau ouvert, pointeur relâché : `input` null). La voiture continue de rouler sur son élan sans s’user, une fenêtre de choc ouverte se ferme, et une remise en place automatique ne coûte rien ;
  - **double peine du tonneau** : le frottement du flanc peut compter comme un choc, puis la remise en place « tonneau » coûte son forfait (15 / 25 / 30 ‰). Accepté : chaque choc est plafonné à 300 ‰ par pièce ;
  - **la Colline, écart relevé en M2** : l’effet moteur (−20 %) est appliqué tel quel, mais la Sportive n’y tient pas +0,5 %. La rampe raide (6 m sur 12) prend 8,9 m/s² des 20 m/s² de gravité de course, et le moteur de la Sportive n’en pousse que 7,8 : elle monte sur son élan, et un moteur usé l’y ralentit environ deux fois plus vite. Sur 400 départs, 10 % d’usure partout coûtaient 0,43 % aux karts, 0,56 % à la Sportive et 0,69 % à la Sportive complète ; au seuil, 17 % à la Sportive. Borne retenue à 10 % d’usure : 0,5 % sur l’Ovale (même si l’argent du kart n’y tient qu’à 0,34 %) ; sur la Colline, le tiers de la marge de médaille la plus serrée, l’or du kart racing (13 917 ms pour 14 290 : 2,68 %), soit 0,89 %. Au seuil : 20 % pour la Sportive sur la Colline, 15 % ailleurs.
- **Tests** :
  - `tests/wear-golden.test.ts` épingle, sur 7e4ed69, 8 courses du bot (Ovale et Colline, kart et Sportive complète, deux réglages), chacune en 4 variantes (rien, compteur, `wear: {}`, les deux), et 3 conduites dans l’usine (mur et frein à main, bord mou, étang). Temps et poses sont identiques au bit près ;
  - `tests/vehicle-wear.test.ts` (kart et Sportive, gravités de course et d’usine) : sol plat sous 0,05 m/s ; braquer contre un mur sous le seuil ; atterrissages inclinés de 20 à 30° depuis 2 m sans usure, et sous 5 ‰ depuis 4 à 8 m ; mur de face à 20 m/s ; mur à 45° à 25 m/s compté en entier ; Sportive penchée en virage, poussée dans un mur ; reset et hold ; `scriptVelocity` ; voiture garée percutée ; `skipImpact` ; pneus usés sur un skidpad ;
  - `src/car/wearMeter.test.ts` (dont le NaN), `src/car/wornTuning.test.ts` (même objet, part de l’aileron, monotone, jamais la masse ni les suspensions), `src/data/wear.test.ts` (seuils, nettoyage, prix et leurs inégalités, rendu), `src/data/wearText.test.ts` ;
  - `src/garage/wearActions.test.ts` : refus sans changement, renouvellement sans stock, chantier commencé avec un lot, pastille des crédits, et 500 actions au hasard sur 4 graines, où objets, crédits et millièmes restent tous comptés ;
  - `src/race/raceCar.test.ts` (800 passe, 801 bloque, aileron, essai éditeur, spec imposée, voiture disparue, location ; `attemptGate`, `endAttempt`) et `src/factory/sim/credits.test.ts` (dépense, lots, voiture usée, sauvegarde et hash) ;
  - `tests/wear-sim.test.ts` (fourchettes de tours, chocs d’un tour propre, pilote brouillon au moins 1,5 fois plus dur pour les pneus, bornes des effets) et `tests/factory-cars.test.ts` (pause, remises en place, machine percutée, bord mou, lac, sol relevé, collines de 21° à 90 km/h, rendu) ;
  - `tests/car-wear-look.test.ts`, `tests/car-fx.test.ts`, `GameState.test.ts`, `objectives.test.ts`, `dealer-show.test.ts` (vitrine neuve) ; `purity.test.ts` couvre `wearMeter`, `wornTuning`, `geometry`, `wearActions` et `raceCar`.
- **Revues** : en plus des relectures de chaque jalon, la revue adverse finale, sous cinq angles avec deux sceptiques par constat, a relevé 5 constats : 5 confirmés, 0 plausible, 0 réfuté. Ce sont 4 défauts distincts (la pastille a été relevée deux fois), tous corrigés :
  - le retrait « sol incliné » amputait les chocs latéraux du kart sur sol plat. L’axe haut était lu après le choc, qui fait rouler la voiture de 5 à 7°. La copie `upOut` seule ne suffisait pas : la Sportive complète, penchée de 7 à 7,4° en virage serré, ne comptait plus que 62 à 77 % d’un choc contre un mur de ce côté. Relever `TILT_FROM` à 8 ou 10° n’était pas possible (voir « Non retenu »). D’où le plafond « ce que le sol a pu donner ». Les chocs en biais reprennent leur Δv entier : à 45° et 25 m/s, le châssis du kart passe de 134 à 171 ‰ en course, de 95 à 111 ‰ dans l’usine. Atterrissages, sauts, collines, tours propres et calibration sont inchangés ;
  - la pastille des crédits apparaissait après une réparation payée en matières : elle suit maintenant `creditsShown` ;
  - au garage, le nom d’une voiture à réparer se coupait sur deux lignes (« Kart Oopi » / « n°1 »). La mini-jauge et « À réparer » s’empilent à droite, et le lieu (« Dans ce garage ») passe à la ligne entier ;
  - le README disait qu’une pièce retirée d’un chantier revenait au sac, même un lot usé.
- **Non retenu** :
  - **une jauge unique par voiture**, deux jauges (pneus, mécanique) ou des pneus roue par roue : `CarInstance` n’a qu’une pièce par emplacement, et le `Vehicle` applique la même friction aux 4 roues ;
  - **les pièces usées dans le sac ou le hangar** : les objets y sont fongibles, comptés par `ItemId`. Une pièce usée y demanderait un nouvel `ItemId` (recette, valeur, modèle, pile), et démonter puis remonter remettrait à neuf gratuitement. D’où la réserve ;
  - **un bâtiment « Atelier »** : il faudrait une 10e touche (les jetons `{hotkeyN}` n’ont qu’un chiffre) et un palier 7, que la règle `tierMax` offrirait aux parties finies. Le garage répare déjà la voiture de sa place ;
  - **un prix de reprise à moitié pour les lots**, proposé par le critique : un lot se vend à sa valeur × son état, donc une pièce se vend sans voiture complète. Accepté, parce qu’une voiture vendue rapporte 25 % de plus, et que démonter puis vendre les lots rapporte toujours moins ;
  - **un effet moteur de 0,1** au lieu de 0,2 : il tient 0,5 % partout, Colline comprise, mais un moteur usé se sent deux fois moins, et la perte due à la seule physique au seuil tombe sous 3 % sur l’Ovale ;
  - **un blocage dans l’usine** (plus de démarrage à 0 %, avec un dépannage) : le dépannage échoue quand aucune place de garage n’est libre, et la voiture resterait « À ranger », irréparable. On roule même hors d’usage pour rentrer ;
  - **une casse en pleine course** : l’essai en cours se termine toujours, seul le suivant est refusé ;
  - **un réglage figé dans l’usine de la montée à la descente** (la conception d’origine) : à 90 km/h, les pneus perdent 0,9 ‰ par seconde, et un quart d’heure sans descendre les menait au seuil sans rien faire sentir ;
  - **une usure au temps** : elle courrait pendant la pause. On ne compte que la distance et les événements ;
  - **les impulsions de contact de Rapier** (`contactPairsWith` ou les événements `CONTACT_FORCE`) pour les chocs : une infrastructure de plus dans `PhysicsWorld.step`, alors que le reste de vitesse ne fait que lire ;
  - **relever `TILT_FROM` à 8 ou 10°** (revue finale) : sur les collines de 21° de l’usine, le pic de la Sportive passait à 3,26 m/s, au-delà du seuil de choc ;
  - **assombrir le seul caoutchouc ou la seule peinture** : pneu et jante, puis caisse, vitres et phares, sont chacun un seul maillage sur un atlas partagé. Il aurait fallu un shader dédié, donc un programme de plus à compiler ;
  - **un registre générique de jauges** pour le futur ticket « essence » : il reprendra le motif du compteur (`step`, `putBack`, `end`), `RaceBlock.kind`, `spend(…, reason)` et les millièmes.
