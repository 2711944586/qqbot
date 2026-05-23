export type GateName = 'ai' | 'search' | 'vision' | 'tts' | 'stt';

interface GateState {
  limit: number;
  active: number;
  queued: number;
  passiveQueueMax: number;
  rejectedPassive: number;
  highWaterQueued: number;
  queue: Array<{ run: () => void; priority: boolean }>;
}

const gates: Record<GateName, GateState> = {
  ai: { limit: 2, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  search: { limit: 2, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  vision: { limit: 1, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  tts: { limit: 1, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  stt: { limit: 1, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
};

function normalizeLimit(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

function pump(gate: GateState): void {
  while (gate.active < gate.limit && gate.queue.length > 0) {
    const next = gate.queue.shift();
    if (!next) return;
    gate.queued = Math.max(0, gate.queued - 1);
    gate.active++;
    next.run();
  }
}

export function configureGates(config: {
  ai?: number;
  search?: number;
  vision?: number;
  tts?: number;
  stt?: number;
  passiveQueueMax?: number;
}): void {
  gates.ai.limit = normalizeLimit(config.ai, gates.ai.limit);
  gates.search.limit = normalizeLimit(config.search, gates.search.limit);
  gates.vision.limit = normalizeLimit(config.vision, gates.vision.limit);
  gates.tts.limit = normalizeLimit(config.tts, gates.tts.limit);
  gates.stt.limit = normalizeLimit(config.stt, gates.stt.limit);
  const passiveQueueMax = Math.max(0, Math.floor(Number(config.passiveQueueMax ?? gates.ai.passiveQueueMax)));
  for (const gate of Object.values(gates)) gate.passiveQueueMax = passiveQueueMax;
  for (const gate of Object.values(gates)) pump(gate);
}

export function withGate<T>(name: GateName, task: () => Promise<T>, priority: boolean = false): Promise<T> {
  const gate = gates[name];
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      task()
        .then(resolve, reject)
        .finally(() => {
          gate.active = Math.max(0, gate.active - 1);
          pump(gate);
        });
    };

    if (gate.active < gate.limit) {
      gate.active++;
      run();
      return;
    }

    if (!priority && gate.passiveQueueMax > 0 && gate.queued >= gate.passiveQueueMax) {
      gate.rejectedPassive++;
      reject(new Error(`${name} gate passive queue full`));
      return;
    }

    gate.queued++;
    gate.highWaterQueued = Math.max(gate.highWaterQueued, gate.queued);
    const entry = { run, priority };
    if (priority) {
      const firstPassiveIndex = gate.queue.findIndex((item) => !item.priority);
      if (firstPassiveIndex >= 0) gate.queue.splice(firstPassiveIndex, 0, entry);
      else gate.queue.push(entry);
    } else {
      gate.queue.push(entry);
    }
  });
}

export function getGateStats(): Record<GateName, { limit: number; active: number; queued: number; passiveQueueMax: number; rejectedPassive: number; highWaterQueued: number }> {
  return {
    ai: { limit: gates.ai.limit, active: gates.ai.active, queued: gates.ai.queued, passiveQueueMax: gates.ai.passiveQueueMax, rejectedPassive: gates.ai.rejectedPassive, highWaterQueued: gates.ai.highWaterQueued },
    search: { limit: gates.search.limit, active: gates.search.active, queued: gates.search.queued, passiveQueueMax: gates.search.passiveQueueMax, rejectedPassive: gates.search.rejectedPassive, highWaterQueued: gates.search.highWaterQueued },
    vision: { limit: gates.vision.limit, active: gates.vision.active, queued: gates.vision.queued, passiveQueueMax: gates.vision.passiveQueueMax, rejectedPassive: gates.vision.rejectedPassive, highWaterQueued: gates.vision.highWaterQueued },
    tts: { limit: gates.tts.limit, active: gates.tts.active, queued: gates.tts.queued, passiveQueueMax: gates.tts.passiveQueueMax, rejectedPassive: gates.tts.rejectedPassive, highWaterQueued: gates.tts.highWaterQueued },
    stt: { limit: gates.stt.limit, active: gates.stt.active, queued: gates.stt.queued, passiveQueueMax: gates.stt.passiveQueueMax, rejectedPassive: gates.stt.rejectedPassive, highWaterQueued: gates.stt.highWaterQueued },
  };
}
