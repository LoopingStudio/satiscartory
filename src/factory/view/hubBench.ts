/**
 * Crafting bench (« Établi ») of the hub, in hub-local meters (rotation 0). It is part of the hub, on its
 * south face (-Z, toward the player spawn), between the hopper (±1.45 m) and the footprint edge (±3 m):
 * belts still reach every outer edge of the hub. Shared by the model (BuildingVisuals) and the collider
 * (FactoryWorld).
 */
export const HUB_BENCH = {
  /** Center along the hub's local Z. */
  z: -2.25,
  /** Half length along the face (X). */
  halfW: 1.2,
  /** Half depth (Z). */
  halfD: 0.48,
  /** Height of the work top. */
  top: 1.0,
} as const;
