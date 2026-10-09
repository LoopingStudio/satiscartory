/** Wheel/body layout of a car model (model units, before CAR_SCALE). Pure data. */
export interface WheelGeo {
  name: string;
  center: [number, number, number];
  radius: number;
  front: boolean;
  left: boolean;
}

export interface CarGeometry {
  wheels: WheelGeo[];
  bodyMin: [number, number, number];
  bodyMax: [number, number, number];
}

export interface NodeBox {
  /** Name of the top-level node the meshes belong to (e.g. "wheel-front-left", "body"). */
  name: string;
  min: [number, number, number];
  max: [number, number, number];
}

/** Builds the car layout from per-node bounding boxes (wheel nodes are named "wheel-*"). */
export function carGeometryFromBoxes(boxes: NodeBox[]): CarGeometry {
  const wheels: WheelGeo[] = [];
  const bodyMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const bodyMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    if (b.name.startsWith('wheel-')) {
      wheels.push({
        name: b.name,
        center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
        radius: (b.max[1] - b.min[1]) / 2,
        front: b.name.includes('front'),
        left: b.name.includes('left'),
      });
    } else if (b.name !== 'character') {
      for (let i = 0; i < 3; i++) {
        bodyMin[i] = Math.min(bodyMin[i]!, b.min[i]!);
        bodyMax[i] = Math.max(bodyMax[i]!, b.max[i]!);
      }
    }
  }
  wheels.sort((a, b) => Number(b.front) - Number(a.front) || Number(b.left) - Number(a.left));
  return { wheels, bodyMin, bodyMax };
}

/**
 * Where the engine smoke comes out (car frame, meters: +X left, +Y up, +Z forward; `scale` = CAR_SCALE). A rear
 * engine (the kart) puffs over the rear axle just behind the seat; a front one (the Sportive) through the hood over
 * the front axle; a car without wheels from the middle of its body.
 */
export function engineAnchor(g: CarGeometry, mount: 'front' | 'rear' = 'rear', scale = 1): [number, number, number] {
  let n = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  let r = 0;
  for (const w of g.wheels) {
    if (w.front !== (mount === 'front')) continue;
    n++;
    x += w.center[0];
    y += w.center[1];
    z += w.center[2];
    r += w.radius;
  }
  if (n === 0) {
    return [((g.bodyMin[0] + g.bodyMax[0]) / 2) * scale, ((g.bodyMin[1] + g.bodyMax[1]) / 2) * scale, ((g.bodyMin[2] + g.bodyMax[2]) / 2) * scale];
  }
  x /= n;
  y /= n;
  z /= n;
  r /= n;
  if (mount === 'front') return [x * scale, (y + 0.55 * (g.bodyMax[1] - y)) * scale, z * scale];
  return [x * scale, (y + 0.9 * r) * scale, (z - 0.4 * r) * scale];
}

/**
 * Point of the body's box hit by a shock that pushed the car along (lx, lz) (car frame): from the middle of the box
 * against the push, out to its side, at mid-height (meters, `scale` = CAR_SCALE). No push: the middle. Into `out`.
 */
export function contactPoint(g: CarGeometry, lx: number, lz: number, scale: number, out: { x: number; y: number; z: number }): typeof out {
  const cx = (g.bodyMin[0] + g.bodyMax[0]) / 2;
  const cz = (g.bodyMin[2] + g.bodyMax[2]) / 2;
  const hx = (g.bodyMax[0] - g.bodyMin[0]) / 2;
  const hz = (g.bodyMax[2] - g.bodyMin[2]) / 2;
  out.y = ((g.bodyMin[1] + g.bodyMax[1]) / 2) * scale;
  const len = Math.hypot(lx, lz);
  if (!(len > 1e-9)) {
    out.x = cx * scale;
    out.z = cz * scale;
    return out;
  }
  // Against the push, to the first side of the box it reaches.
  const dx = -lx / len;
  const dz = -lz / len;
  const t = Math.min(Math.abs(dx) > 1e-9 ? hx / Math.abs(dx) : Infinity, Math.abs(dz) > 1e-9 ? hz / Math.abs(dz) : Infinity);
  out.x = Math.min(g.bodyMax[0], Math.max(g.bodyMin[0], cx + dx * t)) * scale;
  out.z = Math.min(g.bodyMax[2], Math.max(g.bodyMin[2], cz + dz * t)) * scale;
  return out;
}
