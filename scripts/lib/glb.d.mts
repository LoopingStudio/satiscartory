export interface Tri { a: number[]; b: number[]; c: number[]; uva: number[]; uvb: number[]; uvc: number[]; node: string; own: string }
export interface Glb { json: any; bin: Uint8Array }
export function readGlb(path: string): Glb;
export function worldTriangles(glb: Glb): { tris: Tri[]; nodes: { name: string; worldPos: number[] }[] };
export function castDown(tris: Tri[], x: number, z: number): { y: number; uv: number[] } | null;
export function readPng(path: string): { width: number; height: number; sample(u: number, v: number): number[] };
export function nodeBoxes(tris: Tri[]): { name: string; min: [number, number, number]; max: [number, number, number] }[];
