/**
 * Toy trainer for the AI-training lease prototype.
 *
 * It "trains" a one-parameter model on numeric examples from several owners.
 * Each example carries the authenticated lineage of its owner's grant. The
 * trainer consults one GrantAuthorityGuard per grant before it admits
 * examples, before it starts a step, and between micro-steps of a step.
 *
 * Time passes only through the injected `advance` callback, so tests run a
 * step that "takes" ten minutes in microseconds.
 *
 * PROTOTYPE: experimental AI Training Profile work, off by default.
 */
import {
  type GrantAuthorityGuard,
  type InputLineage,
  type JobRecorder,
  lineageKey,
} from "../../lib/training-lease/worker.ts";

export interface TrainingExample {
  id: string;
  lineage: InputLineage;
  value: number;
}

export type MixedOwnerPolicy = "drop" | "pause";

export interface CompletedStep {
  exampleIds: string[];
  grantIds: string[];
  startedTrueMs: number;
  endedTrueMs: number;
}

export interface ToyTrainerOptions {
  guards: Map<string, GrantAuthorityGuard>;
  recorder: JobRecorder;
  /** Worst-case duration of one step. */
  stepMs: number;
  microSteps: number;
  batchSize: number;
  mixedOwnerPolicy: MixedOwnerPolicy;
  advance: (ms: number) => void;
  /** Real time, used only to label completed steps for the test oracle. */
  trueNow: () => number;
}

export type StepOutcome =
  | { kind: "completed"; step: CompletedStep }
  | { kind: "aborted"; grantIds: string[] }
  | { kind: "paused"; grantId: string }
  | { kind: "idle" };

export class ToyTrainer {
  weight = 0;
  readonly queue: TrainingExample[] = [];
  readonly completed: CompletedStep[] = [];
  readonly #o: ToyTrainerOptions;

  constructor(opts: ToyTrainerOptions) {
    this.#o = opts;
  }

  #guardFor(lineage: InputLineage): GrantAuthorityGuard | undefined {
    return this.#o.guards.get(lineageKey(lineage));
  }

  /** Admit examples into the queue. Examples of an owner whose admission closed are refused. */
  enqueue(examples: TrainingExample[]): { admitted: number; refused: number } {
    let admitted = 0;
    let refused = 0;
    for (const ex of examples) {
      const guard = this.#guardFor(ex.lineage);
      if (guard?.canAdmit().ok) {
        this.queue.push(ex);
        admitted += 1;
      } else {
        refused += 1;
      }
    }
    return { admitted, refused };
  }

  #dropOwner(grantId: string, reason: string): void {
    let dropped = 0;
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]?.lineage.grantId === grantId) {
        this.queue.splice(i, 1);
        dropped += 1;
      }
    }
    this.#o.recorder.record({
      type: "admission_stopped",
      grant_id: grantId,
      reason,
      deadline_trusted_ms:
        [...this.#o.guards.values()].find((g) => g.grantId === grantId)
          ?.deadlineTrustedMs ?? null,
    });
    this.#o.recorder.record({
      type: "drained",
      grant_id: grantId,
      examples_dropped: dropped,
    });
  }

  /** Run one step. Owners that cannot finish the step before their deadline are dropped or pause the job. */
  step(): StepOutcome {
    for (;;) {
      const batch = this.queue.slice(0, this.#o.batchSize);
      if (batch.length === 0) {
        return { kind: "idle" };
      }
      const owners = new Map<string, InputLineage>();
      for (const ex of batch) {
        owners.set(lineageKey(ex.lineage), ex.lineage);
      }
      let blocked: InputLineage | null = null;
      for (const lineage of owners.values()) {
        const guard = this.#guardFor(lineage);
        if (!guard?.canStartStep(this.#o.stepMs)) {
          blocked = lineage;
          break;
        }
      }
      if (blocked) {
        if (this.#o.mixedOwnerPolicy === "pause") {
          this.#o.recorder.record({
            type: "job_paused",
            grant_id: blocked.grantId,
            reason: "owner_authority_insufficient_for_step",
          });
          return { kind: "paused", grantId: blocked.grantId };
        }
        this.#dropOwner(
          blocked.grantId,
          "owner_authority_insufficient_for_step",
        );
        continue;
      }
      return this.#run(batch, [...owners.values()]);
    }
  }

  #run(batch: TrainingExample[], owners: InputLineage[]): StepOutcome {
    const started = this.#o.trueNow();
    const slice = this.#o.stepMs / this.#o.microSteps;
    let delta = 0;
    for (let i = 0; i < this.#o.microSteps; i += 1) {
      // Abort unless this slice can finish before every owner's deadline, so
      // no slice runs across a deadline.
      const expired = owners.filter(
        (l) => !this.#guardFor(l)?.canStartStep(slice),
      );
      if (expired.length > 0) {
        const grantIds = expired.map((l) => l.grantId);
        this.#o.recorder.record({
          type: "step_aborted",
          grant_ids: grantIds,
          reason: "deadline_reached_in_flight",
        });
        // The partial update is never applied: the step aborts, it is not
        // completed-then-discarded.
        return { kind: "aborted", grantIds };
      }
      this.#o.advance(slice);
      const ex = batch[i % batch.length];
      delta += (ex?.value ?? 0) / this.#o.microSteps;
    }
    this.weight += delta;
    this.queue.splice(0, batch.length);
    const step: CompletedStep = {
      exampleIds: batch.map((e) => e.id),
      grantIds: owners.map((l) => l.grantId),
      startedTrueMs: started,
      endedTrueMs: this.#o.trueNow(),
    };
    this.completed.push(step);
    return { kind: "completed", step };
  }
}
