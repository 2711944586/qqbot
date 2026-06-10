export type GateName = 'ai' | 'search' | 'vision' | 'tts' | 'stt';

interface GateState {
  limit: number;
  active: number;
  queued: number;
  passiveQueueMax: number;
  rejectedPassive: number;
  highWaterQueued: number;
  queue: Array<{ run: () => void; reject: (err: Error) => void; priority: boolean }>;
}

const DEFAULT_GATE_LIMITS: Record<GateName, number> = {
  ai: 2,
  search: 2,
  vision: 1,
  tts: 1,
  stt: 1,
};

const gates: Record<GateName, GateState> = {
  ai: { limit: DEFAULT_GATE_LIMITS.ai, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  search: { limit: DEFAULT_GATE_LIMITS.search, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  vision: { limit: DEFAULT_GATE_LIMITS.vision, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  tts: { limit: DEFAULT_GATE_LIMITS.tts, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
  stt: { limit: DEFAULT_GATE_LIMITS.stt, active: 0, queued: 0, passiveQueueMax: 20, rejectedPassive: 0, highWaterQueued: 0, queue: [] },
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
    const entry = { run, reject, priority };
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

export function resetGates(options: { resetCounters?: boolean; resetLimits?: boolean } = {}): void {
  for (const [name, gate] of Object.entries(gates) as Array<[GateName, GateState]>) {
    const queued = gate.queue;
    gate.active = 0;
    gate.queued = 0;
    gate.queue = [];
    for (const item of queued) {
      item.reject(new Error(`${name} gate reset`));
    }
    if (options.resetCounters) {
      gate.rejectedPassive = 0;
      gate.highWaterQueued = 0;
    }
    if (options.resetLimits) {
      gate.limit = DEFAULT_GATE_LIMITS[name];
      gate.passiveQueueMax = 20;
    }
  }
}
