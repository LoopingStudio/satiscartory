import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FACTORY_CELL, FACTORY_MODEL_SCALE } from '../../config/constants';
import { DX, DZ } from '../sim/dirs';
import type { Side } from '../../data/buildings';

/**
 * Port markers, shared by placed buildings (FactoryView) and build ghosts (BuildController): in the cell
 * in front of a port (where a conveyor connects), a pad on the floor (cell frame + flat arrow) and a 3D
 * arrow floating over belt height, so that they read from the low third-person camera and over the rocks
 * of resource patches. Outputs orange, inputs blue, a connection green, a dead end red.
 */
export const PORT_COLORS = { out: 0xffa31a, in: 0x5ad1ff, linked: 0x3ddc84, dead: 0xff5d5d } as const;
export type MarkerColor = keyof typeof PORT_COLORS;

/** Floor height of pads (over resource patches at 0.02); top of the belts (0.8 m). */
export const PAD_Y = 0.07;
export const BELT_TOP_Y = 0.4 * FACTORY_MODEL_SCALE;
/** Height of the floating arrows and dead-end crosses: over belts and rocks, under the player's eyes. */
export const POINTER_Y = BELT_TOP_Y + 0.45;

/** Flat arrow pointing +Z, face up, centered on the origin (length 2·half, width 1.7·half). */
function flatArrow(half: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const shaft = 0.32 * half;
  const head = 0.85 * half;
  s.moveTo(-shaft, -half);
  s.lineTo(shaft, -half);
  s.lineTo(shaft, 0);
  s.lineTo(head, 0);
  s.lineTo(0, half);
  s.lineTo(-head, 0);
  s.lineTo(-shaft, 0);
  s.closePath();
  // Shape +Y → -Z once laid flat; a half turn makes it point +Z with its face up.
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2).rotateY(Math.PI);
}

/** Small flat arrow pointing +Z (splitter / merger tops). */
export const smallArrowGeometry = flatArrow(0.3);

/** Pad: a frame along the edges of the cell and a flat arrow in it, pointing +Z. */
export const padGeometry = (() => {
  const c = FACTORY_CELL * 0.92;
  const t = 0.1;
  const bar = (w: number, d: number, x: number, z: number) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, 0, z);
  return mergeGeometries([
    bar(c, t, 0, (c - t) / 2),
    bar(c, t, 0, -(c - t) / 2),
    bar(t, c - 2 * t, (c - t) / 2, 0),
    bar(t, c - 2 * t, -(c - t) / 2, 0),
    flatArrow(0.55),
  ], false)!;
})();

/** 3D arrow (shaft + cone) pointing +Z, 1.1 m long, centered on the origin. */
export const pointerGeometry = (() => {
  const shaft = new THREE.CylinderGeometry(0.09, 0.09, 0.62, 10).rotateX(Math.PI / 2).translate(0, 0, -0.24);
  const head = new THREE.ConeGeometry(0.27, 0.48, 14).rotateX(Math.PI / 2).translate(0, 0, 0.31);
  return mergeGeometries([shaft, head], false)!;
})();

/** 3D cross (dead end): an ✕ in the two vertical planes, so it reads from the front, the side and above. */
export const crossGeometry = (() => {
  const bars: THREE.BufferGeometry[] = [];
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    bars.push(new THREE.BoxGeometry(0.85, 0.16, 0.16).rotateZ(a));
    bars.push(new THREE.BoxGeometry(0.16, 0.16, 0.85).rotateX(a));
  }
  return mergeGeometries(bars, false)!;
})();

/** Unlit pad material (drawn over the floor without z-fighting, never writes depth). */
export function padMaterial(color: number, opacity = 0.85): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** Lit but glowing (opaque) material of the floating arrows and crosses: shaded, so they read as 3D. */
export function pointerMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.5 });
}

/** Yaw that turns a +Z-pointing marker toward world side s. */
export function yawOf(s: Side): number {
  return Math.atan2(DX[s], DZ[s]);
}

/**
 * Where the markers of a port go: the center of the cell in front of the port (where the conveyor goes),
 * pointing out of the building for an output and into it for an input.
 */
export function portPose(cx: number, cz: number, side: Side, dir: 'in' | 'out', out: { x: number; z: number; yaw: number }): void {
  out.x = (cx + 0.5 + DX[side]) * FACTORY_CELL;
  out.z = (cz + 0.5 + DZ[side]) * FACTORY_CELL;
  out.yaw = yawOf(side) + (dir === 'in' ? Math.PI : 0);
}

/**
 * Pad + floating arrow of one port, as a group pointing +Z (ghosts); `setColor` recolors both. The arrow
 * floats a little higher than on placed buildings: a ghost port facing a placed one across a one-cell gap
 * would otherwise put two arrows on the same spot (z-fighting).
 */
export function portMarker(color: MarkerColor): THREE.Group & { setColor(c: MarkerColor): void } {
  const g = new THREE.Group() as THREE.Group & { setColor(c: MarkerColor): void };
  const pad = new THREE.Mesh(padGeometry, sharedPad[color]);
  pad.position.y = PAD_Y;
  pad.renderOrder = 6;
  const pointer = new THREE.Mesh(pointerGeometry, sharedPointer[color]);
  pointer.position.y = POINTER_Y + 0.14;
  pointer.castShadow = false;
  for (const m of [pad, pointer]) m.userData.keepMaterial = true;
  g.add(pad, pointer);
  g.setColor = (c) => {
    pad.material = sharedPad[c];
    pointer.material = sharedPointer[c];
  };
  return g;
}

/** Materials shared by ghost markers (never disposed). */
export const sharedPad = Object.fromEntries(Object.entries(PORT_COLORS).map(([k, c]) => [k, padMaterial(c, 0.9)])) as Record<MarkerColor, THREE.MeshBasicMaterial>;
export const sharedPointer = Object.fromEntries(Object.entries(PORT_COLORS).map(([k, c]) => [k, pointerMaterial(c)])) as Record<MarkerColor, THREE.MeshStandardMaterial>;
