// UI strings (French). Gameplay data names live in data/*.ts.
export const fr = {
  title: 'Satiscartory',
  subtitle: 'Construis ton usine. Fabrique ta voiture. Bats ton chrono.',
  loading: 'Chargement des modèles…',
  loadingRapier: 'Initialisation de la physique…',
  menu: {
    play: 'Usine',
    garage: 'Garage',
    race: 'Courses',
    editor: 'Éditeur de circuit',
    gallery: 'Galerie des modèles (dev)',
    settings: 'Réglages',
    newGame: 'Nouvelle partie',
    confirmNewGame: 'Effacer la sauvegarde et recommencer ?',
    back: 'Retour',
  },
  gallery: {
    title: 'Galerie des modèles',
    hint: 'Clic gauche : orbiter · Molette : zoom · Clic droit : déplacer · F3 : debug physique',
    scaleCorner: 'Contrôle des échelles',
  },
  common: {
    close: 'Fermer',
    cancel: 'Annuler',
    confirm: 'Valider',
    yes: 'Oui',
    no: 'Non',
  },
} as const;
