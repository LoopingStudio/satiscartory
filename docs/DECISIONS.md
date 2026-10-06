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
- **Économie de départ** : 100 plaques et 60 boulons. Le test `objectives.test.ts` vérifie qu'on paie les deux chaînes (fer et caoutchouc), une assembleuse, 25 convoyeurs et les pièces du kart. Le premier essai à 70/36 laissait un joueur à 0 plaque sans chaîne de fer, donc bloqué.
- **Objectifs d'accueil**, dans l'ordre :
  1. Plaques (fer)
  2. Foreuse sur le caoutchouc
  3. Presse « Pneu »
  4. Assembleuse
  5. Pièces
  6. Assemblage
  7. Course avec sa voiture
  8. Bonus : la Sportive

  Ils sont mémorisés dans la sauvegarde.
- **Garage** :
  - Assemblage par emplacement : roues standard ou racing, aileron optionnel.
  - Les barres de stats se comparent à la voiture de course actuelle.
  - On peut changer une pièce (échange avec le stock) ou démonter la voiture, ce qui rembourse ses pièces.
  - La voiture assemblée devient la voiture de course (★).
- **Touche G** : ouvre le garage depuis l'usine. Le panneau du hangar (E) y mène aussi.
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
- **Vue repliée** : un redimensionnement à 0×0 (volet masqué) est ignoré. Sinon le ratio d'aspect nul cassait la projection.

## Retours usine (octobre 2026)

- **Échap** : avec un outil actif (construction, démontage, tracé), Échap ferme seulement l'outil. Le navigateur libère quand même le pointeur, donc le jeu affiche « Clic : reprendre » au lieu du menu pause. Un second Échap ouvre la pause. Un refus de reverrouillage juste après Échap (délai imposé par le navigateur) ne bascule plus en curseur libre si le verrouillage a déjà fonctionné.
- **Orientation des machines** : les modèles Kenney `machine*` sont des tunnels ouverts sur leurs **flancs longs**. Foreuse, presse et assembleuse occupent donc 2×1 cases (2 de large, 1 de profondeur) et les objets les **traversent** : entrée par le flanc arrière (les deux cases), sortie par le flanc avant (l'une ou l'autre case, la première reliée l'emporte). Les entrées par les petits côtés sont supprimées, ce sont des murs pleins. Comme pour un convoyeur, la sortie est « vers l'avant », donc une machine posée après un tracé de convoyeur garde le même sens de flux.
  - Sauvegardes : `FactorySave.version` passe à 2. Au chargement d'une sauvegarde v1, les machines tournent d'un quart de tour, ce qui conserve exactement leurs cases. Les convoyeurs qui arrivaient par les petits côtés ne sont plus reliés et sont à reposer.
- **Modèle de la foreuse** : elle utilisait `machine-fortified`, presque identique à la presse. C'est maintenant une tour de forage composée de pièces du Factory Kit : `piston-thin-round` (tige de forage) dans deux cadres `structure-yellow-medium`, une tête `piston-round` animée quand elle travaille, et un entonnoir `hopper-high-round` collecteur. Sa hauteur (≈ 3,7 m) passe dans le collider de visée.
- **Carte agrandie** : la grille passe de 64×64 à **128×128** cases (256 m), hangar au centre (62, 62). Huit gisements au lieu de cinq, plus grands et espacés : un fer et un caoutchouc à ~17 cases du hangar pour les premières chaînes (≈ 15 convoyeurs chacune, payables avec le stock de départ, test `objectives.test.ts`), les autres entre 26 et 50 cases dans toutes les directions.
  - Sauvegardes : `FactorySave.version` passe à 3. Une sauvegarde de l'ancienne carte est décalée de 32 cases (`LEGACY_MAP_OFFSET`), joueur compris, pour que son hangar tombe sur le nouveau. Les foreuses gardent leur ressource même si l'ancien gisement n'existe plus.
  - Sol : la tuile `floor` du kit est un carré de couleur unie. Un seul carré étiré sur toute la grille remplace les 16 384 instances (≈ 45 → 90 FPS mesurés).
  - Le test de charge (`?layout=stress`) reste sur une grille 64×64 (2 100 objets).
