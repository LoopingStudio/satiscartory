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
