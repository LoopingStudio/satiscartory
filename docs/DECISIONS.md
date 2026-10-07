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
- **Visée en construction** : le rayon vise le plan du sol (y = 0) plutôt que les colliders, pour pouvoir construire derrière une machine. Hors construction (démontage, interaction), le rayon Rapier touche le premier collider.
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
  - Sol : la tuile `floor` du kit est un carré de couleur unie. Un seul carré étiré sur toute la grille remplace les 16 384 instances (≈ 45 → 90 FPS mesurés).
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
- **Limites** : la voiture reste à 2 m à l'intérieur de la carte (mur mou : la vitesse vers le bord est limitée à 4 m/s par mètre restant). Sous -5 m, couchée ou coincée plus de 1,6 s (même règle qu'en course) ou à plus de 12 m hors de la carte, elle revient à sa dernière position sûre, relevée toutes les 0,5 s quand elle est droite sur ses quatre roues dans la carte. Retour arrière fait de même.
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
- **Cul-de-sac** : une croix rouge 3D au bout d'un convoyeur dont l'avant bute contre un bâtiment qui refuse ses objets (sortie ou mur d'une machine, convoyeur en face, garage). Un avant sur le sol vide n'en est pas un (ligne en cours). Une croix aussi, au-dessus de la machine, sur la face de sortie d'une machine dont toutes les sorties donnent sur un bâtiment ou le bord de la carte (posée sur la face commune, elle restait cachée entre les deux bâtiments) ; son fantôme fait de même, avec « ✕ sortie bloquée par : … ».
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
