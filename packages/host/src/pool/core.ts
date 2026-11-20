// The worker side (docs/design/m2.md 2.5): synchronous, one message at a time, the same code in a
// Node worker thread and a browser Worker (each entry file is a few lines around it). A bad file
// or a crash comes back as a message, never as a dead worker.

import { accHash, reportHash, reportJson } from '../report-json.ts';
import { buildArms, type BuiltArms, type Job } from '../job.ts';
import { computeReport, header, playOne, renderReport, reportModel, resolveSchedule, runChunk, runnerRun, type RunSchedule } from '@montecrit/engine';
import type { FromWorker, PlayReply, ReportReply, ToWorker, WorkerOp } from './protocol.ts';

export function createWorkerCore(): (msg: ToWorker) => FromWorker {
  let job: Job | null = null;
  let built: BuiltArms | null = null;
  let sched: RunSchedule | null = null;

  const call = (op: WorkerOp): PlayReply | ReportReply => {
    if (!job || !built) throw new Error('call before init');
    const arms = built.arms;
    if (op.op === 'report') {
      const stats = computeReport(arms, op.run.merged, op.meta);
      const model = reportModel(arms, op.run.merged);
      const json = reportJson(arms, op.run, op.meta.seed, stats);
      return { stats, model, text: renderReport(arms, op.run.merged, op.meta, stats, model), json, hash: reportHash(json), accHash: accHash(arms, op.run, op.meta.seed) };
    }
    const arm = arms[op.arm];
    if (!arm) throw new RangeError(`no arm ${op.arm}`);
    const copy = runnerRun(arm, job.seed, op.run);
    const f = playOne(arm.setup, job.seed, op.run, arm.policy, op.explain);
    const castIds = f.events.flatMap((e) => (e.k === 'cast' ? [e.via] : []));
    return {
      events: f.events,
      end: { outcome: f.result.outcome, hp: f.result.hp, hpMax: f.result.hpMax, life: f.result.life, stateHash: f.result.stateHash },
      logHash: f.logHash,
      explained: f.explained,
      policy: f.policy,
      header: header(arm.setup, job.seed, op.run, [], f.policy, f.result.flagsUsed, castIds, op.fileNotes),
      oneRun: copy.acc,
      oneRunStateHash: copy.stateHash,
    };
  };

  return (msg: ToWorker): FromWorker => {
    try {
      if (msg.t === 'init') {
        job = msg.job;
        built = buildArms(job);
        if (built.errors.length) return { t: 'error', gen: msg.gen, message: built.errors.join('\n'), stack: null };
        sched = resolveSchedule(built.arms, job.run);
        return { t: 'ready', gen: msg.gen, scenarioHash: built.setup!.scenarioHash, contentHash: built.setup!.contentHash, policyHashes: built.arms.map((a) => a.policy?.hash ?? null) };
      }
      if (msg.t === 'task') {
        if (!job || !built || !sched) throw new Error('task before init');
        const arm = built.arms[msg.arm];
        if (!arm) throw new RangeError(`no arm ${msg.arm}`);
        return { t: 'chunk', gen: msg.gen, k: msg.k, arm: msg.arm, acc: runChunk([arm], job.seed, msg.k, sched.total, sched.chunkSize).arms[0]! };
      }
      try {
        return { t: 'res', gen: msg.gen, id: msg.id, ok: true, value: call(msg.op) };
      } catch (e) {
        return { t: 'res', gen: msg.gen, id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    } catch (e) {
      return { t: 'error', gen: msg.gen, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? (e.stack ?? null) : null };
    }
  };
}
