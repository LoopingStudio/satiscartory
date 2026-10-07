/**
 * Rapier collision groups (membership << 16 | filter). Driven cars cross conveyor lines (belts are
 * ground-level and everywhere, unlike Satisfactory's raised ones); machines and walls stay solid.
 * The player's character controller ignores groups, so the player still walks on belts.
 */
const ALL = 0xffff;
const CONVEYOR = 0x0002;
const CAR = 0x0004;
export const CONVEYOR_GROUPS = ((CONVEYOR << 16) | (ALL & ~CAR)) >>> 0;
export const CAR_GROUPS = ((CAR << 16) | (ALL & ~CONVEYOR)) >>> 0;
