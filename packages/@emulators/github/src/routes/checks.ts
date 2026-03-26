import type { RouteContext, WebhookDispatcher } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubCheckRun,
  GitHubCheckSuite,
  GitHubCommit,
  GitHubRepo,
  GitHubUser,
  GitHubCheckAnnotation,
} from "../entities.js";
import {
  formatRepo,
  formatUser,
  generateNodeId,
  lookupRepo,
  timestamp,
} from "../helpers.js";
import {
  assertRepoRead,
  assertRepoWrite,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";

const CONCLUSION_RANK: Record<string, number> = {
  success: 0,
  neutral: 1,
  skipped: 2,
  cancelled: 3,
  timed_out: 4,
  action_required: 5,
  failure: 6,
};

function findCommitInRepo(gh: GitHubStore, repoId: number, shaParam: string): GitHubCommit | undefined {
  const want = shaParam.toLowerCase();
  const list = gh.commits.findBy("repo_id", repoId);
  return list.find((c) => c.sha === shaParam || c.sha.toLowerCase() === want || c.sha.startsWith(shaParam));
}

function resolveRefToHeadSha(gh: GitHubStore, repo: GitHubRepo, refParam: string): string | undefined {
  const commit = findCommitInRepo(gh, repo.id, refParam);
  if (commit) return commit.sha;
  const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === refParam);
  if (branch) return branch.sha;
  const fullRef = refParam.startsWith("refs/") ? refParam : `refs/heads/${refParam}`;
  const r = gh.refs.findBy("repo_id", repo.id).find((x) => x.ref === fullRef);
  if (r) return r.sha;
  return undefined;
}

function headBranchForSha(gh: GitHubStore, repo: GitHubRepo, headSha: string): string {
  const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.sha === headSha);
  if (branch) return branch.name;
  return repo.default_branch;
}

function getOrCreateCheckSuite(
  gh: GitHubStore,
  repo: GitHubRepo,
  headSha: string,
  headBranch?: string | null
): GitHubCheckSuite {
  const existing = gh.checkSuites
    .findBy("repo_id", repo.id)
    .find((s) => s.head_sha === headSha);
  if (existing) return existing;

  const hb = headBranch?.trim() || headBranchForSha(gh, repo, headSha);
  const row = gh.checkSuites.insert({
    node_id: "",
    repo_id: repo.id,
    head_branch: hb,
    head_sha: headSha,
    status: "queued",
    conclusion: null,
    before: "",
    after: headSha,
    app_id: null,
  } as Omit<GitHubCheckSuite, "id" | "created_at" | "updated_at">);
  gh.checkSuites.update(row.id, { node_id: generateNodeId("CheckSuite", row.id) });
  return gh.checkSuites.get(row.id)!;
}

function worstConclusion(
  conclusions: NonNullable<GitHubCheckRun["conclusion"]>[]
): NonNullable<GitHubCheckSuite["conclusion"]> {
  let best: NonNullable<GitHubCheckSuite["conclusion"]> = "success";
  let rank = -1;
  for (const c of conclusions) {
    const r = CONCLUSION_RANK[c] ?? 3;
    if (r > rank) {
      rank = r;
      best = c;
    }
  }
  return best;
}

function recomputeSuiteFromRuns(runs: GitHubCheckRun[]): {
  status: GitHubCheckSuite["status"];
  conclusion: GitHubCheckSuite["conclusion"];
} {
  if (runs.length === 0) {
    return { status: "completed", conclusion: null };
  }
  const allDone = runs.every((r) => r.status === "completed");
  if (allDone) {
    const conclusions = runs
      .map((r) => r.conclusion)
      .filter((c): c is NonNullable<typeof c> => c != null);
    return {
      status: "completed",
      conclusion: conclusions.length ? worstConclusion(conclusions) : null,
    };
  }
  const anyInProgress = runs.some((r) => r.status === "in_progress");
  if (anyInProgress) {
    return { status: "in_progress", conclusion: null };
  }
  const anyQueued = runs.some((r) => r.status === "queued");
  const anyCompleted = runs.some((r) => r.status === "completed");
  if (anyCompleted && anyQueued) {
    return { status: "in_progress", conclusion: null };
  }
  if (anyQueued) {
    return { status: "queued", conclusion: null };
  }
  return { status: "in_progress", conclusion: null };
}

function recomputeCheckSuite(gh: GitHubStore, suiteId: number) {
  const suite = gh.checkSuites.get(suiteId);
  if (!suite) return;
  const runs = gh.checkRuns
    .findBy("repo_id", suite.repo_id)
    .filter((r) => r.check_suite_id === suiteId);
  const { status, conclusion } = recomputeSuiteFromRuns(runs);
  gh.checkSuites.update(suiteId, { status, conclusion });
}

function parseConclusion(
  raw: unknown
): GitHubCheckRun["conclusion"] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new ApiError(422, "Invalid conclusion");
  const allowed = new Set([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
  ]);
  if (!allowed.has(raw)) throw new ApiError(422, "Invalid conclusion");
  return raw as GitHubCheckRun["conclusion"];
}

function parseStatus(raw: unknown, fallback: GitHubCheckRun["status"]): GitHubCheckRun["status"] {
  if (raw === undefined || raw === null) return fallback;
  if (raw !== "queued" && raw !== "in_progress" && raw !== "completed") {
    throw new ApiError(422, "Invalid status");
  }
  return raw;
}

function normalizeAnnotations(raw: unknown): GitHubCheckAnnotation[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(422, "Invalid annotations");
  const out: GitHubCheckAnnotation[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") throw new ApiError(422, "Invalid annotation");
    const o = a as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path : null;
    const message = typeof o.message === "string" ? o.message : null;
    const start_line = typeof o.start_line === "number" ? o.start_line : parseInt(String(o.start_line), 10);
    const end_line = typeof o.end_line === "number" ? o.end_line : parseInt(String(o.end_line), 10);
    const annotation_level =
      typeof o.annotation_level === "string" ? o.annotation_level : "notice";
    if (!path || !message || !Number.isFinite(start_line) || !Number.isFinite(end_line)) {
      throw new ApiError(422, "Invalid annotation fields");
    }
    out.push({
      path,
      start_line,
      end_line,
      annotation_level,
      message,
    });
  }
  return out;
}

function formatCheckSuiteBrief(
  suite: GitHubCheckSuite,
  repo: GitHubRepo,
  baseUrl: string
) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    id: suite.id,
    node_id: suite.node_id,
    head_branch: suite.head_branch,
    head_sha: suite.head_sha,
    url: `${repoUrl}/check-suites/${suite.id}`,
  };
}

function formatRepoBrief(repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const owner = formatRepo(repo, gh, baseUrl).owner;
  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner,
    url: `${baseUrl}/repos/${repo.full_name}`,
    html_url: `${baseUrl}/${repo.full_name}`,
  };
}

function formatCheckRun(
  run: GitHubCheckRun,
  repo: GitHubRepo,
  gh: GitHubStore,
  baseUrl: string
) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const suite = run.check_suite_id ? gh.checkSuites.get(run.check_suite_id) : null;
  return {
    id: run.id,
    node_id: run.node_id,
    head_sha: run.head_sha,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    started_at: run.started_at,
    completed_at: run.completed_at,
    external_id: run.external_id,
    url: `${repoUrl}/check-runs/${run.id}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${run.head_sha}/checks/${run.id}`,
    details_url: run.details_url,
    output: {
      title: run.output.title,
      summary: run.output.summary,
      text: run.output.text,
      annotations_count: run.output.annotations_count,
    },
    check_suite: suite ? formatCheckSuiteBrief(suite, repo, baseUrl) : null,
    app: null,
    pull_requests: [] as unknown[],
  };
}

function formatCheckSuite(
  suite: GitHubCheckSuite,
  repo: GitHubRepo,
  gh: GitHubStore,
  baseUrl: string
) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    id: suite.id,
    node_id: suite.node_id,
    head_branch: suite.head_branch,
    head_sha: suite.head_sha,
    status: suite.status,
    conclusion: suite.conclusion,
    url: `${repoUrl}/check-suites/${suite.id}`,
    before: suite.before,
    after: suite.after,
    pull_requests: [],
    app: null,
    repository: formatRepoBrief(repo, gh, baseUrl),
    created_at: suite.created_at,
    updated_at: suite.updated_at,
  };
}

function dispatchCheckRun(
  webhooks: WebhookDispatcher,
  gh: GitHubStore,
  repo: GitHubRepo,
  run: GitHubCheckRun,
  actor: GitHubUser,
  baseUrl: string,
  action: string | undefined
) {
  const ownerLogin = ownerLoginOf(gh, repo);
  void webhooks.dispatch(
    "check_run",
    action,
    {
      action,
      check_run: formatCheckRun(run, repo, gh, baseUrl),
      repository: formatRepo(repo, gh, baseUrl),
      sender: formatUser(actor, baseUrl),
    },
    ownerLogin,
    repo.name
  );
}

function dispatchCheckSuite(
  webhooks: WebhookDispatcher,
  gh: GitHubStore,
  repo: GitHubRepo,
  suite: GitHubCheckSuite,
  actor: GitHubUser,
  baseUrl: string,
  action: string | undefined
) {
  const ownerLogin = ownerLoginOf(gh, repo);
  void webhooks.dispatch(
    "check_suite",
    action,
    {
      action,
      check_suite: formatCheckSuite(suite, repo, gh, baseUrl),
      repository: formatRepo(repo, gh, baseUrl),
      sender: formatUser(actor, baseUrl),
    },
    ownerLogin,
    repo.name
  );
}

export function checksRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  // --- Preferences (static path before :check_suite_id) ---
  app.patch("/repos/:owner/:repo/check-suites/preferences", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);
    const auto =
      Array.isArray(body.auto_trigger_checks) && body.auto_trigger_checks.every((x) => x && typeof x === "object")
        ? body.auto_trigger_checks
        : [];
    return c.json({
      preferences: {
        auto_trigger_checks: auto,
      },
    });
  });

  app.post("/repos/:owner/:repo/check-suites", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);
    if (typeof body.head_sha !== "string" || !body.head_sha.trim()) {
      throw new ApiError(422, "head_sha is required");
    }
    const headSha = body.head_sha.trim();
    const headBranch =
      typeof body.head_branch === "string" && body.head_branch.trim() ? body.head_branch.trim() : null;

    const suite = getOrCreateCheckSuite(gh, repo, headSha, headBranch);
    if (headBranch && suite.head_branch !== headBranch) {
      gh.checkSuites.update(suite.id, { head_branch: headBranch });
    }
    const updated = gh.checkSuites.get(suite.id)!;
    dispatchCheckSuite(webhooks, gh, repo, updated, actor, baseUrl, "requested");
    return c.json(formatCheckSuite(updated, repo, gh, baseUrl), 201);
  });

  app.get("/repos/:owner/:repo/check-suites/:check_suite_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const suiteId = parseInt(c.req.param("check_suite_id")!, 10);
    const suite = gh.checkSuites.get(suiteId);
    if (!suite || suite.repo_id !== repo.id) throw notFoundResponse();
    return c.json(formatCheckSuite(suite, repo, gh, baseUrl));
  });

  app.get("/repos/:owner/:repo/check-suites/:check_suite_id/check-runs", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const suiteId = parseInt(c.req.param("check_suite_id")!, 10);
    const suite = gh.checkSuites.get(suiteId);
    if (!suite || suite.repo_id !== repo.id) throw notFoundResponse();
    const { page, per_page } = parsePagination(c);
    let runs = gh.checkRuns
      .findBy("repo_id", repo.id)
      .filter((r) => r.check_suite_id === suiteId);
    runs = runs.sort((a, b) => b.id - a.id);
    const total = runs.length;
    const slice = runs.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);
    return c.json({
      total_count: total,
      check_runs: slice.map((r) => formatCheckRun(r, repo, gh, baseUrl)),
    });
  });

  app.post("/repos/:owner/:repo/check-suites/:check_suite_id/rerequest", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const suiteId = parseInt(c.req.param("check_suite_id")!, 10);
    const suite = gh.checkSuites.get(suiteId);
    if (!suite || suite.repo_id !== repo.id) throw notFoundResponse();

    const runs = gh.checkRuns
      .findBy("repo_id", repo.id)
      .filter((r) => r.check_suite_id === suiteId);
    const now = timestamp();
    for (const r of runs) {
      gh.checkRuns.update(r.id, {
        status: "queued",
        conclusion: null,
        completed_at: null,
        started_at: null,
        updated_at: now,
      });
    }
    gh.checkSuites.update(suiteId, { status: "queued", conclusion: null });
    const suiteAfter = gh.checkSuites.get(suiteId)!;
    dispatchCheckSuite(webhooks, gh, repo, suiteAfter, actor, baseUrl, "rerequested");
    return c.body(null, 201);
  });

  app.get("/repos/:owner/:repo/commits/:ref/check-suites", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const ref = c.req.param("ref")!;
    const headSha = resolveRefToHeadSha(gh, repo, ref);
    if (!headSha) throw notFoundResponse();
    const suites = gh.checkSuites
      .findBy("repo_id", repo.id)
      .filter((s) => s.head_sha === headSha)
      .sort((a, b) => b.id - a.id);
    return c.json({
      total_count: suites.length,
      check_suites: suites.map((s) => formatCheckSuite(s, repo, gh, baseUrl)),
    });
  });

  // --- Check runs ---
  app.post("/repos/:owner/:repo/check-runs", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const body = await parseJsonBody(c);

    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new ApiError(422, "name is required");
    }
    if (typeof body.head_sha !== "string" || !body.head_sha.trim()) {
      throw new ApiError(422, "head_sha is required");
    }

    const name = body.name.trim();
    const headSha = body.head_sha.trim();
    const status = parseStatus(body.status, "queued");
    let conclusion = parseConclusion(body.conclusion);
    if (status === "completed" && (conclusion === undefined || conclusion === null)) {
      throw new ApiError(422, "conclusion is required when status is completed");
    }
    if (status !== "completed") {
      conclusion = null;
    }

    const details_url =
      typeof body.details_url === "string" || body.details_url === null ? (body.details_url as string | null) : null;
    const external_id =
      typeof body.external_id === "string" ? body.external_id : body.external_id == null ? "" : String(body.external_id);

    const started_at =
      body.started_at === undefined
        ? null
        : body.started_at === null
          ? null
          : typeof body.started_at === "string"
            ? body.started_at
            : null;
    let completed_at =
      body.completed_at === undefined
        ? null
        : body.completed_at === null
          ? null
          : typeof body.completed_at === "string"
            ? body.completed_at
            : null;

    if (status === "completed" && !completed_at) {
      completed_at = timestamp();
    }

    const outRaw = body.output && typeof body.output === "object" ? (body.output as Record<string, unknown>) : {};
    const annotations = normalizeAnnotations(outRaw.annotations);
    const output = {
      title: typeof outRaw.title === "string" ? outRaw.title : outRaw.title === null ? null : null,
      summary: typeof outRaw.summary === "string" ? outRaw.summary : outRaw.summary === null ? null : null,
      text: typeof outRaw.text === "string" ? outRaw.text : outRaw.text === null ? null : null,
      annotations_count: annotations.length,
      annotations,
    };

    let actions: GitHubCheckRun["actions"] = null;
    if (Array.isArray(body.actions)) {
      actions = [];
      for (const act of body.actions) {
        if (!act || typeof act !== "object") continue;
        const a = act as Record<string, unknown>;
        if (
          typeof a.id === "string" &&
          typeof a.label === "string" &&
          typeof a.description === "string"
        ) {
          actions.push({ id: a.id, label: a.label, description: a.description });
        }
      }
      if (actions.length === 0) actions = null;
    }

    const suite = getOrCreateCheckSuite(gh, repo, headSha, null);

    const row = gh.checkRuns.insert({
      node_id: "",
      repo_id: repo.id,
      head_sha: headSha,
      name,
      status,
      conclusion: conclusion ?? null,
      started_at,
      completed_at,
      external_id,
      details_url,
      actions,
      output,
      check_suite_id: suite.id,
      app_id: typeof body.app_id === "number" ? body.app_id : null,
    } as Omit<GitHubCheckRun, "id" | "created_at" | "updated_at">);
    gh.checkRuns.update(row.id, { node_id: generateNodeId("CheckRun", row.id) });
    const run = gh.checkRuns.get(row.id)!;

    recomputeCheckSuite(gh, suite.id);

    dispatchCheckRun(webhooks, gh, repo, run, actor, baseUrl, "created");
    return c.json(formatCheckRun(run, repo, gh, baseUrl), 201);
  });

  app.patch("/repos/:owner/:repo/check-runs/:check_run_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const runId = parseInt(c.req.param("check_run_id")!, 10);
    const prev = gh.checkRuns.get(runId);
    if (!prev || prev.repo_id !== repo.id) throw notFoundResponse();

    const body = await parseJsonBody(c);

    const patch: Partial<GitHubCheckRun> = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) throw new ApiError(422, "Invalid name");
      patch.name = body.name.trim();
    }
    if (body.head_sha !== undefined) {
      if (typeof body.head_sha !== "string" || !body.head_sha.trim()) throw new ApiError(422, "Invalid head_sha");
      patch.head_sha = body.head_sha.trim();
    }
    if (body.status !== undefined) {
      patch.status = parseStatus(body.status, prev.status);
    }
    if (body.conclusion !== undefined) {
      const pc = parseConclusion(body.conclusion);
      patch.conclusion = pc === undefined ? null : pc;
    }
    if (body.details_url !== undefined) {
      patch.details_url =
        typeof body.details_url === "string" || body.details_url === null ? (body.details_url as string | null) : null;
    }
    if (body.external_id !== undefined) {
      patch.external_id =
        typeof body.external_id === "string" ? body.external_id : String(body.external_id ?? "");
    }
    if (body.started_at !== undefined) {
      patch.started_at =
        body.started_at === null
          ? null
          : typeof body.started_at === "string"
            ? body.started_at
            : null;
    }
    if (body.completed_at !== undefined) {
      patch.completed_at =
        body.completed_at === null
          ? null
          : typeof body.completed_at === "string"
            ? body.completed_at
            : null;
    }
    if (body.app_id !== undefined) {
      patch.app_id = typeof body.app_id === "number" ? body.app_id : null;
    }
    if (body.actions !== undefined) {
      if (body.actions === null) {
        patch.actions = null;
      } else if (Array.isArray(body.actions)) {
        const actions: NonNullable<GitHubCheckRun["actions"]> = [];
        for (const act of body.actions) {
          if (!act || typeof act !== "object") continue;
          const a = act as Record<string, unknown>;
          if (
            typeof a.id === "string" &&
            typeof a.label === "string" &&
            typeof a.description === "string"
          ) {
            actions.push({ id: a.id, label: a.label, description: a.description });
          }
        }
        patch.actions = actions.length ? actions : null;
      }
    }

    if (body.output !== undefined && body.output !== null && typeof body.output === "object") {
      const outRaw = body.output as Record<string, unknown>;
      const annotations = normalizeAnnotations(outRaw.annotations);
      patch.output = {
        title:
          outRaw.title === undefined
            ? prev.output.title
            : typeof outRaw.title === "string"
              ? outRaw.title
              : null,
        summary:
          outRaw.summary === undefined
            ? prev.output.summary
            : typeof outRaw.summary === "string"
              ? outRaw.summary
              : null,
        text:
          outRaw.text === undefined
            ? prev.output.text
            : typeof outRaw.text === "string"
              ? outRaw.text
              : null,
        annotations_count: annotations.length,
        annotations,
      };
    }

    const nextStatus = patch.status ?? prev.status;
    let nextConclusion: GitHubCheckRun["conclusion"] =
      patch.conclusion !== undefined ? patch.conclusion : prev.conclusion;

    if (patch.head_sha && patch.head_sha !== prev.head_sha) {
      const newSuite = getOrCreateCheckSuite(gh, repo, patch.head_sha, null);
      patch.check_suite_id = newSuite.id;
    }

    if (nextStatus === "completed") {
      if (nextConclusion === undefined || nextConclusion === null) {
        throw new ApiError(422, "conclusion is required when status is completed");
      }
      patch.conclusion = nextConclusion;
      let nextCompleted = patch.completed_at !== undefined ? patch.completed_at : prev.completed_at;
      if (!nextCompleted) {
        patch.completed_at = timestamp();
      }
    } else {
      patch.conclusion = null;
      patch.completed_at = null;
    }

    gh.checkRuns.update(runId, patch);
    const run = gh.checkRuns.get(runId)!;

    if (run.check_suite_id) {
      recomputeCheckSuite(gh, run.check_suite_id);
    }

    if (prev.status !== "completed" && run.status === "completed") {
      dispatchCheckRun(webhooks, gh, repo, run, actor, baseUrl, "completed");
    }

    return c.json(formatCheckRun(run, repo, gh, baseUrl));
  });

  app.get("/repos/:owner/:repo/check-runs/:check_run_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const runId = parseInt(c.req.param("check_run_id")!, 10);
    const run = gh.checkRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();
    return c.json(formatCheckRun(run, repo, gh, baseUrl));
  });

  app.get("/repos/:owner/:repo/check-runs/:check_run_id/annotations", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const runId = parseInt(c.req.param("check_run_id")!, 10);
    const run = gh.checkRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const annotations = run.output.annotations;
    const total = annotations.length;
    const slice = annotations.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);

    const check_annotations = slice.map((a, i) => ({
      path: a.path,
      blob_href: `${baseUrl}/${repo.full_name}/blob/${run.head_sha}/${a.path}`,
      start_line: a.start_line,
      end_line: a.end_line,
      message: a.message,
      title: null as string | null,
      raw_details: null as string | null,
      start_column: null as number | null,
      end_column: null as number | null,
      annotation_level: a.annotation_level,
      id: (page - 1) * per_page + i + 1,
    }));

    return c.json({
      total_count: total,
      check_annotations,
    });
  });

  app.post("/repos/:owner/:repo/check-runs/:check_run_id/rerequest", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const runId = parseInt(c.req.param("check_run_id")!, 10);
    const prev = gh.checkRuns.get(runId);
    if (!prev || prev.repo_id !== repo.id) throw notFoundResponse();

    const now = timestamp();
    gh.checkRuns.update(runId, {
      status: "queued",
      conclusion: null,
      completed_at: null,
      started_at: null,
      updated_at: now,
    });
    const run = gh.checkRuns.get(runId)!;
    if (run.check_suite_id) {
      recomputeCheckSuite(gh, run.check_suite_id);
    }
    dispatchCheckRun(webhooks, gh, repo, run, actor, baseUrl, "rerequested");
    return c.body(null, 201);
  });

  app.get("/repos/:owner/:repo/commits/:ref/check-runs", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const ref = c.req.param("ref")!;
    const headSha = resolveRefToHeadSha(gh, repo, ref);
    if (!headSha) throw notFoundResponse();

    const check_name = c.req.query("check_name")?.trim();
    const statusQ = c.req.query("status")?.trim() as GitHubCheckRun["status"] | undefined;
    const filter = (c.req.query("filter") ?? "latest").toLowerCase();

    let runs = gh.checkRuns.findBy("repo_id", repo.id).filter((r) => r.head_sha === headSha);
    if (check_name) {
      runs = runs.filter((r) => r.name === check_name);
    }
    if (statusQ && (statusQ === "queued" || statusQ === "in_progress" || statusQ === "completed")) {
      runs = runs.filter((r) => r.status === statusQ);
    }

    runs = runs.sort((a, b) => b.id - a.id);

    if (filter === "latest") {
      const byName = new Map<string, GitHubCheckRun>();
      for (const r of runs.sort((a, b) => a.id - b.id)) {
        byName.set(r.name, r);
      }
      runs = [...byName.values()].sort((a, b) => b.id - a.id);
    }

    return c.json({
      total_count: runs.length,
      check_runs: runs.map((r) => formatCheckRun(r, repo, gh, baseUrl)),
    });
  });
}
