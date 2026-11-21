/** The lifecycle of an asynchronous generation job. */
export type JobStatus = "queued" | "in_progress" | "completed" | "failed";

/** Every legal move between job states; completed and failed are terminal. */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["in_progress", "completed", "failed"],
  in_progress: ["in_progress", "completed", "failed"],
  completed: [],
  failed: [],
};

/** How a job ends: with a video (rule-supplied bytes or rendered), or with a provider error. */
export type JobOutcome = { kind: "video"; data?: string } | { kind: "error"; code: string; message: string };

/** One video job. Status advances only when a client reads it, so polling is deterministic. */
export interface VideoJob {
  id: string;
  provider: "openai" | "xai" | "gemini" | "vertex" | "gateway";
  model: string;
  prompt: string;
  status: JobStatus;
  progress: number;
  /** Status reads that report the job in progress before it reaches its outcome. */
  polls: number;
  reads: number;
  seconds: number;
  width: number;
  height: number;
  samples: number;
  outcome: JobOutcome;
  createdAt: number;
  completedAt?: number;
  remixedFrom?: string;
  storageUri?: string;
}

/** Moves a job to `next`, refusing any move the transition table does not allow. */
export function transition(job: VideoJob, next: JobStatus): void {
  if (!TRANSITIONS[job.status].includes(next)) {
    throw new Error(`video job ${job.id} cannot move from ${job.status} to ${next}`);
  }
  job.status = next;
}

/** True once a job can no longer change. */
export function isTerminal(job: VideoJob): boolean {
  return TRANSITIONS[job.status].length === 0;
}

/**
 * Advances a job by one status read: each of its first `polls` reads reports it in progress with rising progress, and
 * the next read settles it on its outcome.
 */
export function advance(job: VideoJob): VideoJob {
  if (isTerminal(job)) return job;
  job.reads += 1;
  if (job.reads <= job.polls) {
    transition(job, "in_progress");
    job.progress = Math.min(99, Math.floor((job.reads / (job.polls + 1)) * 100));
    return job;
  }
  transition(job, job.outcome.kind === "video" ? "completed" : "failed");
  job.progress = job.outcome.kind === "video" ? 100 : job.progress;
  job.completedAt = job.createdAt + job.reads;
  return job;
}
