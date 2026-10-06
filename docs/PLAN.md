# Satiscartory : plan de la tranche verticale

## Contexte

Satiscartory est un jeu navigateur qui part de zéro (le dossier `/Users/keliandaste/Satiscartory` est vide). Il enchaîne deux boucles :

1. **Usine façon Satisfactory, en vue TPS** : on marche avec un personnage, on pose extracteurs, convoyeurs et machines, et on produit des pièces de voiture.
2. **Course façon Trackmania** : on assemble une voiture à partir de ces pièces (ses stats dépendent des pièces), puis on court contre la montre sur des circuits créés dans un éditeur à tuiles.

Choix validés avec l'utilisateur :
- Three.js + TypeScript + Vite + Rapier, plutôt que du WebGL brut.
- Vue TPS pour l'usine.
- Un éditeur de circuit.
- Une tranche verticale où les deux boucles sont minimales mais reliées.

Assets : les trois packs Kenney (CC0), en GLB, avec une texture `colormap.png` partagée. Ce que l'inspection des fichiers a confirmé :
- **car-kit** :
  - Chaque voiture a des nœuds `body` et `wheel-front-left`, `wheel-front-right`, `wheel-back-left`, `wheel-back-right`. Les roues sont séparées et leur rayon est de 0,3.
  - L'avant est en +Z et `race.glb` mesure 2,56 de long. `sedan-sports` a en plus un nœud `spoiler`.
  - Les modèles `debris-*` (plate, bolt, tire, drivetrain, door, spoiler) et `wheel-*` serviront de visuels pour les objets produits.
  - Il y a aussi des karts : `kart-oopi`, etc.
- **factory-kit** :
  - `conveyor` est une tuile 1×1, avec des variantes `-corner`, `-junction-t` et `-slope`.
  - `machine` mesure 1,2×1,3×1,5, avec des variantes `-fortified` et `-window`.
  - `robot-arm-a` est articulé (`element-a` à `f`, plus les pinces), donc animable par code. Il y a aussi `piston-*`, `hopper-*`, `structure-*`, `floor` et `box-*`.
  - `oopi` est la mascotte, statique, sans squelette. Elle servira d'avatar avec une animation procédurale.
- **city-kit-roads** :
  - Les tuiles font 1×1 et la surface de route est à 0,02 de haut : `road-straight`, `road-bend`, `road-curve` (2×2), `road-slant` (+0,25), `road-slant-high` (+0,5), `road-bridge`, `bridge-pillar`, plus les variantes `-barrier`.
  - Les routes sont petites par rapport aux voitures, d'où des échelles différentes par mode.

## Conventions (`src/config/constants.ts`)

- 1 unité = 1 m. +Y est le haut et +Z l'avant, comme dans les modèles Kenney.
- Échelles :
  - `TRACK_CELL = 12` : une tuile de route est agrandie ×12.
  - `LEVEL_H = 3` : un niveau de hauteur vaut 0,25 tuile, soit la montée d'un `road-slant`.
  - `CAR_SCALE = 1.6` : la voiture fait environ 4,1 m.
  - `FACTORY_CELL = 2` : une case d'usine fait 2 m.
  - `PLAYER_HEIGHT = 1.8`.
- Cadences : physique à 60 Hz pour le personnage et le véhicule, simulation d'usine à 20 Hz en déterministe.
- Gravité : -9,81 dans l'usine, -20 en course pour un rendu nerveux. Chaque mode a son propre monde physique.
- Les touches utilisent `KeyboardEvent.code`, donc WASD devient ZQSD automatiquement sur un clavier AZERTY.
- L'interface est en français (`src/ui/i18n/fr.ts`) et le code en anglais.

## Architecture

```
index.html, vite.config.ts (+ config vitest), tsconfig.json (strict), .claude/launch.json (npm run dev, :5173)
scripts/gen-manifest.mjs     → src/core/assets/manifest.gen.ts (union typée ModelKey)
public/assets/kenney/{car-kit,factory-kit,city-kit-roads}/  (GLB + Textures/colormap.png + License.txt)
src/
  main.ts                    RAPIER.init(), préchargement + écran de chargement, new Game()
  config/                    constants.ts, keybinds.ts
  core/                      Game, Loop (rAF + 2 accumulateurs pas fixe), Renderer, Input, PointerLock,
                             ModeManager (enter/exit/fixedUpdate/update), events, rng,
                             assets/AssetLoader (cache GLTF, instantiate, getMergedGeometry, getModelInfo, dédup matériaux),
                             physics/PhysicsWorld (wrapper Rapier, debug render F3)
  data/                      items, recipes, buildings, blueprints, parts, trackPieces, tracks/*.json   (données pures)
  state/                     GameState, SaveManager (localStorage, versions + migrations + backup)
  factory/sim/               FactorySim, Grid, Conveyor, Machine, Extractor, Hub, ports, serialize  (TS pur + tests)
  factory/view/              FactoryView, ConveyorRenderer + ItemRenderer (InstancedMesh), MachineAnimator
  factory/build/             BuildController (fantôme, rotation, tracé de convoyeur, démontage)
  factory/                   FactoryMode, FactoryWorld (sol, gisements, colliders)
  player/                    CharacterController (Rapier KCC), PlayerAvatar (oopi), OrbitCamera
  car/                       stats.ts, tuning.ts (purs), CarModel.ts
  garage/                    assembly.ts (pur), GarageMode, CarPreview
  vehicle/                   Vehicle (DynamicRayCastVehicleController + aides arcade), VehicleInput, ChaseCamera
  track/                     TrackData, connectors.ts + validate.ts (purs), TrackBuilder (trimesh fusionné), gates,
                             editor/ (TrackEditorMode, EditorCamera, palette)
  race/                      RaceSession.ts + crossing.ts (purs), medals, RaceMode, RaceHud
  dev/                       AssetGalleryMode, TuningPanel (lil-gui)
  ui/                        dom.ts, hud/, menus/, styles/, i18n/fr.ts
```

**Règle :** les modules purs n'importent jamais three ni Rapier. Ce sont `data/`, `factory/sim/`, `car/stats|tuning`, `garage/assembly`, `track/connectors|validate` et `race/RaceSession|crossing`. Une règle ESLint `no-restricted-imports` le garantit, et c'est sur eux que porte Vitest.

**Dépendances :** three, @types/three, @dimforge/rapier3d-compat (version épinglée), lil-gui, typescript, vite, vitest. Pas de framework d'interface : DOM et CSS directement.

**Modes :** MainMenu, Factory, Garage, TrackEditor, Race et Gallery (en dev).
- Chaque mode possède sa scène, sa caméra et son monde physique, et `exit()` les libère.
- La simulation d'usine tourne dans `Game` et non dans un mode, donc la production continue pendant une course.
- Des liens profonds facilitent le dev, par exemple `?mode=race&track=oval&debug=1`.

## Systèmes clés

### Usine (simulation déterministe à 20 Hz)

**Grille et bâtiments**
- Grille de 64×64 cases, occupation stockée dans un `Int32Array`.
- Un bâtiment a la forme `{id, type, x, z, rot}`, avec des ports d'entrée et de sortie sur les bords. Les liaisons sont recalculées à chaque pose ou retrait.

**Convoyeurs**
- Positions entières, environ 1 tuile par seconde, au plus 3 objets par tuile.
- Entrée par l'arrière ou les côtés, avec fusion en tourniquet ; c'est ce qui affiche `conveyor-corner` ou `-junction-t`.
- L'ordre de traitement part de l'aval.

**Machines**
- Tampons d'entrée et de sortie, une recette, une progression en ticks, et un statut : idle, working, blocked ou noRecipe.
- **Foreuse :** posée sur un gisement, elle produit un objet toutes les 2 s.
- **Hangar central (hub)** :
  - Occupe 4×4 cases et a 8 entrées.
  - Alimente un stock global qui paie les constructions ; il n'y a pas d'inventaire personnel dans la tranche.
  - Le terminal Garage est accolé au hangar.

**Rendu**
- Un InstancedMesh par type d'objet et par variante de convoyeur.
- Interpolation de `prevPos` à `pos` pour le mouvement des objets.
- Bras robot et pistons animés par code quand la machine travaille.

**Chaîne de production de la tranche**

| Bâtiment | Modèle | Recettes |
|---|---|---|
| Foreuse (2×2) | `machine-fortified` + piston | gisement Fer → Minerai ; gisement Caoutchouc → Latex |
| Presse (2×2, 1→1) | `machine` + piston | Minerai → Plaque ; Minerai → 2 Boulons ; 2 Latex → Pneu |
| Assembleuse (2×2, 2→1) | `machine-window` + `robot-arm-a` | Châssis, Moteur, Roue, Panneau, Aileron |
| Hangar central (4×4) | `structure-*` + `hopper-high` + écran | stockage, terminal Garage |
| Convoyeur (1×1) | `conveyor`, `-corner`, `-junction-t` | — |

**Visuels des objets**

| Objet | Modèle |
|---|---|
| Minerai, Latex | `box-small` teinté |
| Plaque | `debris-plate-a` |
| Boulon | `debris-bolt` |
| Pneu | `debris-tire` |
| Châssis | `debris-drivetrain-axle` |
| Moteur | `debris-drivetrain` |
| Roue | `wheel-default` |
| Panneau | `debris-door` |
| Aileron | `debris-spoiler-a` |

On démarre avec assez de stock pour une petite installation (2 foreuses, 1 presse, 1 assembleuse et 30 convoyeurs). Un kart doit être faisable en moins de 2 minutes.

### Personnage TPS et mode construction

**Personnage et caméra**
- Rapier `KinematicCharacterController` sur une capsule de 1,8 m, avec autostep, snap au sol, saut (Espace) et sprint (Shift). On enjambe les convoyeurs, qui ne font que 0,4 m de haut.
- Caméra orbitale en pointer lock, au-dessus de l'épaule droite, rapprochée par raycast en cas d'obstacle.
- Avatar `oopi` avec rebond et squash procéduraux.

**Construction**
- Q ouvre le menu de construction ; 1 à 5 forment une hotbar.
- Un rayon depuis le centre de l'écran donne une case cible, avec un fantôme vert ou rouge (cases libres, gisement, coût).
- R pour tourner, clic gauche pour poser. Pour les convoyeurs, le cliquer-glisser trace un L.
- F active le démontage, avec remboursement. E interagit : panneau de recette d'une machine, ou terminal Garage.

### Garage et stats

**Plans de voiture**
- **Kart** (`kart-oopi`) : un châssis, un moteur et 4 roues.
- **Sport** (`sedan-sports`) : la même chose, plus 4 panneaux et un aileron optionnel, qui affiche ou masque le nœud `spoiler`.

**Assemblage et stats**
- `assembly.ts` vérifie les pièces manquantes, déduit les pièces du stock et crée une `CarInstance`.
- `computeCarStats` part des stats de base du plan et applique les modificateurs des pièces. Par exemple, la roue racing donne +25 % d'adhérence, et l'aileron +60 % d'appui pour -3 % de vitesse de pointe.
- Barres affichées : Vitesse, Accélération, Adhérence, Poids.

**Réglage du véhicule (`tuning.ts`)**
- Force moteur en transmission intégrale.
- Traînée quadratique : la vitesse de pointe émerge de la physique.
- frictionSlip calculé à partir de l'adhérence.
- Appui aérodynamique proportionnel à v².

**`CarModel`** lit la position des roues dans le GLB, sans valeurs codées en dur.

### Véhicule (arcade façon Trackmania)

**Contrôleur**
- `world.createVehicleController(chassis)`, puis 4 appels à `addWheel` aux positions des nœuds × `CAR_SCALE`.
- Pièges vérifiés :
  - Il faut écrire `vc.setIndexForwardAxis = 2` : c'est un setter mal nommé dans les typings.
  - L'essieu doit être `(-1,0,0)` pour que l'avant soit en +Z.
  - `maxSuspensionForce` doit être monté à environ 1e5.

**Châssis**
- Collider en boîte avec CCD et centre de masse abaissé.
- Inertie en roulis augmentée pour éviter les tonneaux, friction des murs faible.

**Aides de conduite**
- Braquage qui diminue avec la vitesse.
- Appui en v².
- Drift : frein à main, ou frein + braquage à haute vitesse.
- Contrôle en l'air.
- Frein qui passe en marche arrière.
- Tous les paramètres sont réglables en direct dans lil-gui.

**Caméra de poursuite** lissée, avec un FOV qui s'élargit avec la vitesse.

**Collision du circuit**
- Un seul trimesh fusionné, construit à partir des géométries GLB des tuiles, avec `TriMeshFlags.FIX_INTERNAL_EDGES` pour éviter les bosses aux jointures.
- Un plan de mort sous le circuit déclenche un respawn automatique.

### Éditeur de circuit

**Pièces**
- Définition : `{id, model, footprint, rise, connectors: {dx,dz,side,level}[], gate?}`.
- Catalogue de la tranche :
  - `road-straight` et sa variante barrier
  - `road-bend`
  - `road-curve` (2×2)
  - `road-slant` (+1) et `road-slant-high` (+2)
  - Départ, CP et Arrivée
- Plus tard : `road-bridge`, `road-slant-curve`, croisements.
- Les hauteurs de connecteurs sont mesurées par une sonde en phase 0, pas devinées.
- Des piliers `bridge-pillar` sont ajoutés automatiquement sous les pièces en hauteur.

**Validation (pure)**
- Exactement un départ et au moins une arrivée.
- Un graphe de connecteurs (même niveau, côtés opposés), puis un parcours en largeur du départ jusqu'à l'arrivée.
- Les erreurs et avertissements remontent avec les cases fautives, pour les surligner.

**Portiques** : deux piliers `structure-tall` et une bannière en texture canvas qui affiche DÉPART, CP ou ARRIVÉE. Leur volume orienté sert au test de franchissement.

**Ergonomie**
- Caméra RTS.
- Palette de pièces et niveau de construction (PageUp/PageDown).
- Fantôme vert ou rouge, avec des flèches sur les connecteurs ouverts.
- R pour tourner, clic gauche pour poser, clic droit ou X pour supprimer.
- Ctrl+S sauvegarde, « Tester » lance un essai, « Copier JSON » exporte.

**Format JSON** : `{format:"satiscartory-track", version:1, name, size, pieces:[{t,x,z,y,r}], medals}`.
- Les médailles se calculent sur le temps auteur : or ×1,06, argent ×1,2, bronze ×1,5.
- Les circuits fournis sont chargés via `import.meta.glob` ; ceux de l'utilisateur sont en localStorage.

### Course

**`RaceSession` (pure)**
- Enchaîne compte à rebours → course → arrivée.
- Le temps est compté en ticks de physique.

**Checkpoints**
- Test de franchissement sur le segment entre la position précédente et la position actuelle, fiable même à 300 km/h.
- Comme dans Trackmania, les CP comptent dans n'importe quel ordre. L'arrivée ne compte qu'une fois tous les CP passés.

**Commandes**
- Retour arrière : respawn au dernier CP.
- Suppr : redémarrage instantané.
- Entrée : réessayer.

**HUD** : chrono, km/h, CP x/y, écart sur le record personnel à chaque CP (en vert ou rouge), médaille à l'arrivée.

## Jalons (chacun jouable dans le navigateur)

0. **Projet et pipeline d'assets**
   - Contenu :
     - Télécharger et dézipper les 3 packs dans `public/assets/kenney/` (accord déjà donné).
     - Projet Vite TS, Vitest, gen-manifest, Loop/Renderer/Input/ModeManager/AssetLoader.
     - Une galerie des 3 kits.
     - Un coin pour vérifier les échelles (voiture, route, capsule, convoyeur).
     - Une boîte Rapier qui tombe sur une tuile en trimesh.
     - La sonde de connecteurs.
   - Terminé quand : les couleurs sont correctes, la boîte se pose, la console est propre, et `npm test` et `npm run build` passent.
1. **Simulation d'usine sans rendu, plus une vue de debug**
   - Contenu : grille, ports, convoyeur, foreuse, presse, hangar et sérialisation, avec une vue de dessus sur une disposition codée en dur.
   - Terminé quand : les tests Vitest passent, le minerai circule jusqu'au hangar et le compteur monte, avec 2000 objets à 60 FPS.
2. **Personnage TPS et construction**
   - Contenu : KCC, caméra, avatar, menu de construction, fantôme, tracé de convoyeur, démontage, panneau de recette, coûts, sauvegarde.
   - Terminé quand : on construit la chaîne à pied, on recharge la page et l'usine est intacte et produit toujours.
3. **Prototype de véhicule**
   - Contenu : Vehicle et ChaseCamera sur une piste test (plat, rampe, virage 2×2), avec le panneau de réglage.
   - Terminé quand : la voiture roule, drifte et saute sans se retourner, atteint environ 200 km/h, les roues tournent et braquent, et les tests sans rendu passent.
4. **Circuits et course**
   - Contenu : TrackData, TrackBuilder, portiques, RaceSession, HUD, médailles, records, et deux circuits fournis (un ovale et un avec pente).
   - Terminé quand : on boucle un tour, respawn et restart fonctionnent, et le record persiste.
5. **Éditeur de circuit**
   - Contenu : pose, rotation, niveaux, validation, sauvegarde, essai puis retour, temps auteur.
   - Terminé quand : on crée un circuit fermé avec une pente en moins de 5 minutes, on le pilote, et il survit au rechargement.
6. **Boucle complète**
   - Contenu : recettes de l'Assembleuse, mode Garage, stats → réglage, menu principal (Usine ↔ Garage → choix du circuit → Course).
   - Terminé quand : sur une nouvelle partie, on produit les pièces du kart, on l'assemble et on le fait courir, et ses stats diffèrent nettement de la Sport.
7. **Finitions**
   - Contenu : objectifs d'accueil en français, réglages (sensibilité, inversion Y), passe de performance, chasse aux bugs.

## Vérification

**Vitest (modules purs)**
- Débit des convoyeurs, sans perte d'objet quand ils sont bloqués, et fusion en tourniquet.
- Durée des recettes et plafonds de tampon.
- Nombre d'objets de bout en bout de la foreuse au hangar.
- Déterminisme de la sauvegarde : 1000 ticks, sauvegarde, chargement, puis 1000 ticks, doit donner le même résultat que 2000 ticks d'un coup.
- Intégrité des données.
- Assemblage et stats.
- Rotation des connecteurs.
- Fixtures de validation de circuit.
- Machine à états de la course et franchissement à grande vitesse.
- Migrations de sauvegarde.

**Rapier sans rendu (compat fonctionne sous Node)**
- La force moteur fait avancer la voiture en +Z local, ce qui verrouille le piège de l'axe.
- À l'arrêt, la voiture se stabilise.
- La vitesse de pointe tombe à ±10 % de la stat.

**Navigateur**
- Lancer le serveur Vite (`.claude/launch.json`) dans le navigateur intégré, avec des liens profonds par mode.
- `window.__game` en dev pour l'état, `fastForward(ticks)` et `spawnTestFactory()`.
- Overlay F3 : FPS, draw calls, debug de la physique.
- Capture d'écran, lecture de la console, puis validation de la définition de « terminé » de chaque jalon.

## Pièges à surveiller

- **Rapier :** n'utiliser que `-compat` et appeler `init()` une seule fois. Ne plus toucher aux corps après `world.free()`. Épingler la version.
- **Partage des GLTF :** les clones partagent matériaux et géométries. Les fantômes et surbrillances passent par des matériaux de remplacement, et la colormap est dédupliquée.
- **Échelles et origines :** se fier aux bbox mesurées en phase 0.
- **Performance :** InstancedMesh pour les objets et convoyeurs, aucune allocation par frame, circuit en un seul mesh fusionné.
- **Pointer lock :** Échap affiche la pause, et un verrouillage refusé est intercepté.
- **Boucle :** delta plafonné, et le temps passé en onglet inactif est ignoré (pas de production hors ligne dans la tranche).
- **Hors périmètre de la tranche :** splitters, énergie, fondations, fantômes de course, peinture, multijoueur.

---

## Suivi des jalons (définition de « terminé »)

- [x] **P0** : couleurs correctes, la boîte Rapier se pose sur le trimesh de route, console propre, `npm test` et `npm run build` passent.
- [x] **P1** : les tests Vitest passent ; le minerai circule jusqu'au hangar et le compteur monte ; 2000 objets tiennent 60 FPS (2100 objets mesurés à 60 FPS, 19 draw calls).
- [x] **P2** : on construit la chaîne à pied (foreuse, convoyeurs tracés, presse configurée avec E, convoyeurs jusqu'au hangar, via de vrais événements d'entrée) ; après rechargement, l'usine est intacte et produit encore.
- [x] **P3** : la voiture roule, drifte (frein à main : +20° de rotation en 0,8 s en gardant la vitesse) et saute sans se retourner. Elle atteint environ 200 km/h (Sportive mesurée à 244 km/h, kart à 150). Les roues tournent et braquent. Les 8 tests Rapier sans rendu passent.
- [x] **P4** : on boucle un tour par les CP (Ovale et Colline, bot sans rendu et pilote auto avec de vraies touches) ; respawn au dernier CP et restart fonctionnent ; médaille et record persistent après rechargement.
- [ ] **P5** : on crée un circuit fermé avec une pente ; il est validé, on le pilote, et il survit au rechargement.
- [ ] **P6** : sur une nouvelle partie, on produit les pièces du kart, on l'assemble et on court ; ses stats diffèrent nettement de la Sport.
- [ ] **P7** : objectifs d'accueil, réglages, passe de performance.
