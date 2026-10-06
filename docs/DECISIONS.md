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

- **Emprises** :
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
