/// <reference lib="webworker" />
import { TerrainGenerator, generateHeightmap, type ChunkRequest } from './terrainGen';

let gen: TerrainGenerator | null = null;

type Msg =
  | { type: 'init'; seed: number }
  | { type: 'chunk'; id: number; req: ChunkRequest }
  | { type: 'heightmap'; id: number; size: number; half: number };

self.onmessage = (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    gen = new TerrainGenerator(msg.seed);
    return;
  }
  if (!gen) gen = new TerrainGenerator();
  if (msg.type === 'chunk') {
    const d = gen.generate(msg.req);
    const transfer: Transferable[] = [d.positions.buffer, d.normals.buffer, d.colors.buffer, d.uvs.buffer];
    if (d.trees) transfer.push(d.trees.buffer);
    (self as unknown as Worker).postMessage({ type: 'chunk', id: msg.id, data: d }, transfer);
  } else if (msg.type === 'heightmap') {
    const h = generateHeightmap(gen.world, msg.size, msg.half);
    (self as unknown as Worker).postMessage({ type: 'heightmap', id: msg.id, data: h }, [h.buffer]);
  }
};
