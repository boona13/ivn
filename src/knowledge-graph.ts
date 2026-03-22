import type { Edge, Knowledge, TraversalStep } from './types.js';

export function getRelatedKnowledge(options: {
  id: string;
  edges: Edge[];
  getKnowledge: (id: string) => Knowledge | null;
}): Array<{ edge: Edge; knowledge: Knowledge }> {
  const { id, edges, getKnowledge } = options;
  return edges
    .map((edge) => {
      const relatedId = edge.source_id === id ? edge.target_id : edge.source_id;
      const knowledge = getKnowledge(relatedId);
      if (!knowledge) return null;
      return { edge, knowledge };
    })
    .filter((item) => item !== null);
}

export function traverseKnowledge(options: {
  id: string;
  direction: 'incoming' | 'outgoing' | 'both';
  maxDepth: number;
  getKnowledge: (id: string) => Knowledge | null;
  getEdges: (id: string, direction: 'incoming' | 'outgoing' | 'both') => Edge[];
}): TraversalStep[] {
  const { id, direction, maxDepth, getKnowledge, getEdges } = options;
  const start = getKnowledge(id);
  if (!start) throw new Error(`Knowledge #${id} not found`);

  const cappedDepth = Math.max(1, Math.min(8, Math.floor(maxDepth) || 4));
  const steps: TraversalStep[] = [{ depth: 0, knowledge: start, edge: null, direction: 'start' }];
  const visited = new Set<string>([id]);
  const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= cappedDepth) continue;

    for (const edge of getEdges(current.id, direction)) {
      const nextId = resolveNextId(edge, current.id, direction);
      if (!nextId || visited.has(nextId)) continue;

      const knowledge = getKnowledge(nextId);
      if (!knowledge) continue;

      visited.add(nextId);
      steps.push({
        depth: current.depth + 1,
        knowledge,
        edge,
        direction: edge.source_id === current.id ? 'outgoing' : 'incoming',
      });
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }

  return steps;
}

function resolveNextId(
  edge: Edge,
  currentId: string,
  direction: 'incoming' | 'outgoing' | 'both',
): string | null {
  if (direction === 'incoming') return edge.source_id;
  if (direction === 'outgoing') return edge.target_id;
  if (edge.source_id === currentId) return edge.target_id;
  if (edge.target_id === currentId) return edge.source_id;
  return null;
}
