// Review loop controller. The agents review and fix; every loop decision is made here.
//   start [--base <ref>] [--restart]
//                                 open round 1 and print the reviewer plan; --restart discards
//                                 a review that is not done
//   add <reviewer> --reason <why> add a reviewer to the current round
//   judge [--quiet]               read the reviewers' output, then print DONE, FIX or ABORT
//   next                          read the responses to open findings and open the next round
//   status                        print the state
//   summary                       print the review record for the pull request body
//   integ                         run the integration test against AWS and record the result
//   gate                          PreToolUse hook: block `gh pr create` until the review is done
//                                 and the integration test passed on the reviewed files
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_ROUNDS = 3;
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const CONFIDENCES = ['possible', 'likely', 'confirmed'];
const THRESHOLD = { severity: 'medium', confidence: 'likely' };
const REASON_TYPES = ['false-positive', 'out-of-scope', 'by-design', 'accepted-risk'];

export const REVIEWERS = {
  general: {
    categories: ['correctness', 'error-handling', 'maintainability', 'tests', 'docs'],
    paths: [/./],
  },
  cdk: {
    categories: [
      'construct-id',
      'resource-lifecycle',
      'jsii-api',
      'props-defaults',
      'synth',
      'cost',
    ],
    paths: [/^src\//, /^test\/(?!harness\/)/, /^\.projenrc\.ts$/, /^cdk\.json$/],
  },
  security: {
    categories: ['iam', 'secrets', 'network', 'encryption', 'supply-chain', 'injection'],
    paths: [
      /^\.github\/workflows\//,
      /^package\.json$/,
      /^pnpm-lock\.yaml$/,
      /^pnpm-workspace\.yaml$/,
      /^\.claude\/settings(\.local)?\.json$/,
      /^\.mcp\.json$/,
      /^\.claude\/(hooks|review|agents|skills)\//,
    ],
    // Matched against added and removed lines.
    content: [
      /aws-iam|\biam\./,
      /Policy(Statement|Document)/,
      /\.grant\w*\(/,
      /Secret|aws-kms|\bkms\./,
      /SecurityGroup|\bPeer\./,
      /publicReadAccess|BlockPublicAccess|encryption/i,
    ],
  },
  script: {
    categories: ['shell-safety', 'hook-contract', 'portability', 'error-handling', 'performance'],
    paths: [
      /^\.claude\/(hooks|review)\//,
      /^\.claude\/settings(\.local)?\.json$/,
      /\.(mjs|cjs|sh|bash)$/,
      /^\.github\/workflows\//,
    ],
  },
};

// Too large or generated to review line by line; listed by name only.
const DIFF_EXCLUDE = ['pnpm-lock.yaml', 'API.md'];
// Written by integ-runner: the synthesized templates and bundled assets.
const INTEG_SNAPSHOT = /^test\/[^/]+\.snapshot\//;
const hiddenFromDiff = (f) => DIFF_EXCLUDE.includes(f) || INTEG_SNAPSHOT.test(f);
// Inside the working tree so worktree-isolated agents can write their output. Kept out of snapshots.
export const STATE_DIR = '.claude/review/.state';
// Claude Code decides which commands reach the gate through the hook's `if` rules in
// .claude/settings.json; it also runs the hook when it cannot parse a command (`echo $(date)`).
// This loose check lets those unrelated commands through. It over-matches on purpose.
export function mentionsPullRequestCreation(command) {
  return /\bgh\b/.test(command) && /\bpr\b[\s\S]*\b(create|new)\b/.test(command);
}

class ReviewError extends Error {}

// Compare real paths: a symlinked project directory must not turn the script into a no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2));
}

function main(argv) {
  const [command, ...args] = argv;
  const commands = { start, add, judge, next, status, summary, integ };
  // gate runs on every Bash call, so it opens the repository only when it has to.
  if (command === 'gate') return gate();
  try {
    if (!commands[command]) fail(`unknown command: ${command ?? '(none)'}`);
    commands[command](openRepo(process.cwd()), args);
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Commands

function start(repo, args) {
  const state = repo.load();
  if (state && state.status !== 'done' && !args.includes('--restart')) {
    fail(`a review is already ${state.status}; pass --restart to discard it`);
  }
  // Pin the base to a commit so a moving ref cannot change later diffs.
  const base = option(args, '--base')
    ? repo
        .git(['rev-parse', '--verify', '--end-of-options', `${option(args, '--base')}^{commit}`])
        .trim()
    : repo.git(['merge-base', 'HEAD', 'origin/main']).trim();
  const tree = repo.snapshot();
  const files = repo.changedFiles(base, tree);
  rmSync(repo.dir, { recursive: true, force: true });
  const fresh = {
    base,
    status: 'reviewing',
    abort: null,
    passedTree: null,
    rounds: [],
    findings: {},
  };
  if (files.length === 0) {
    fresh.status = 'done';
    fresh.passedTree = tree;
    repo.save(fresh);
    print({ result: 'DONE', message: 'No changes against the base; nothing to review.' });
    return;
  }
  openRound(repo, fresh, { from: base, tree, files, carried: [] });
}

function add(repo, args) {
  const state = requireStatus(repo, 'reviewing');
  const name = args[0];
  const reason = option(args, '--reason');
  if (!REVIEWERS[name]) fail(`unknown reviewer: ${name}`);
  if (!reason) fail('--reason is required');
  const round = state.rounds.at(-1);
  if (round.reviewers[name]) fail(`${name} is already in round ${round.n}`);
  round.reviewers[name] = { selectedBy: 'agent', reason, files: round.files };
  writeReviewerInput(repo, state, round, name);
  repo.save(state);
  print({ result: 'ADDED', reviewer: reviewerPlan(repo, state, round, name) });
}

function judge(repo, args) {
  const state = requireStatus(repo, 'reviewing');
  const round = state.rounds.at(-1);
  const outputs = {};
  const errors = [];
  for (const name of Object.keys(round.reviewers)) {
    const path = outputPath(repo, round.n, name);
    if (!existsSync(path)) {
      errors.push(`${name}: missing ${path}`);
      continue;
    }
    try {
      outputs[name] = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      errors.push(`${name}: invalid JSON (${error.message})`);
      continue;
    }
    errors.push(...validateOutput(state, round, name, outputs[name]));
  }
  if (errors.length)
    fail(`reviewer output rejected; re-run those reviewers:\n${errors.join('\n')}`);

  const result = applyJudgement(state, round, outputs);
  if (result.result === 'DONE') state.passedTree = round.tree;
  repo.save(state);
  print(args.includes('--quiet') ? { result: result.result } : result);
}

function next(repo) {
  const state = requireStatus(repo, 'fixing');
  const round = state.rounds.at(-1);
  const path = responsesPath(repo, round.n);
  if (!existsSync(path)) fail(`write your responses to ${path} first`);
  let responses;
  try {
    responses = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`invalid JSON in ${path} (${error.message})`);
  }
  const errors = validateResponses(state, responses);
  if (errors.length) fail(`responses rejected:\n${errors.join('\n')}`);

  const result = applyResponses(state, round, responses);
  if (result) {
    repo.save(state);
    print(result);
    return;
  }

  const tree = repo.snapshot();
  const files = repo.changedFiles(round.tree, tree);
  const carried = openFindings(state).map((f) => f.id);
  openRound(repo, state, { from: round.tree, tree, files, carried });
}

function status(repo) {
  const state = repo.load();
  if (!state) fail('no review has been started');
  const round = state.rounds.at(-1);
  print({
    status: state.status,
    round: round?.n ?? 0,
    abort: state.abort,
    openFindings: openFindings(state),
    integ: integStatus(state, repo.loadInteg()),
    // Lets an interrupted session re-launch the reviewers of the current round.
    reviewers:
      state.status === 'reviewing'
        ? Object.keys(round.reviewers).map((name) => reviewerPlan(repo, state, round, name))
        : undefined,
  });
}

function summary(repo) {
  const state = repo.load();
  if (!state) fail('no review has been started');
  process.stdout.write(renderSummary(state, repo.loadInteg()));
}

function integ(repo) {
  const before = repo.snapshot();
  // integ-runner's output goes to stderr so stdout stays JSON.
  const r = spawnSync('pnpm', ['exec', 'projen', 'integ'], {
    cwd: repo.root,
    stdio: ['ignore', 2, 2],
  });
  const tree = repo.snapshot();
  const outside = repo.changedFiles(before, tree).filter((f) => !INTEG_SNAPSHOT.test(f));
  const passed = r.status === 0 && outside.length === 0;
  repo.saveInteg({ status: passed ? 'passed' : 'failed', tree, at: new Date().toISOString() });
  if (r.status !== 0) {
    fail(`integration test failed (${r.error?.message ?? `exit ${r.status ?? r.signal}`})`);
  }
  if (outside.length) {
    fail(`files outside the integ snapshots changed during the run: ${outside.join(', ')}`);
  }
  print({
    result: 'PASSED',
    snapshotChanged: tree !== before,
    next:
      tree === before
        ? 'Recorded. The gate accepts it once the review passes on these files.'
        : 'integ-runner wrote a snapshot. Commit it; the review must pass on the files as they are now.',
  });
}

// Why the recorded integration test run does not cover the reviewed files, or null.
function integStatus(state, record) {
  if (!record) return 'the integration test has not been run';
  if (record.status !== 'passed') return 'the last integration test run failed';
  if (record.tree !== state.passedTree) {
    return 'the integration test did not run on the reviewed files';
  }
  return null;
}

function gate() {
  let why;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    if (!mentionsPullRequestCreation(input.tool_input?.command ?? '')) return;
    const repo = openRepo(input.cwd ?? process.cwd());
    const state = repo.load();
    why = !state
      ? 'no review has been run'
      : state.status !== 'done'
        ? `the review is ${state.status}`
        : state.passedTree !== repo.snapshot()
          ? 'files changed after the review passed'
          : // The pull request is built from pushed commits, not from the working tree.
            state.passedTree !== repo.treeOf('HEAD')
            ? 'the reviewed files are not all committed; commit them, push, then run gh pr create on its own'
            : state.passedTree !== repo.treeOf(`refs/remotes/origin/${repo.branch}`)
              ? `the reviewed commit is not pushed to origin/${repo.branch}; push, then run gh pr create on its own`
              : integStatus(state, repo.loadInteg());
  } catch (error) {
    // Fail closed: only exit 2 blocks the tool call.
    why = `the review state could not be checked (${error.message})`;
  }
  if (!why) return;
  process.stderr.write(`Pull request blocked: ${why}. Run the review-pr skill first.\n`);
  // exitCode rather than exit() so the reason is not cut off on a pipe.
  process.exitCode = 2;
}

// ---------------------------------------------------------------------------
// Rounds

function openRound(repo, state, { from, tree, files, carried }) {
  // The round limit is enforced in applyJudgement, before a round can be opened.
  const n = state.rounds.length + 1;
  const diff = repo.diff(from, tree, files);
  const reviewers = selectReviewers(files, diff);
  // Reviewers with carried findings must answer them and see any change to those files.
  for (const id of carried) {
    const finding = state.findings[id];
    const reviewer = (reviewers[finding.reviewer] ??= { selectedBy: 'carried', files: [] });
    if (files.includes(finding.file) && !reviewer.files.includes(finding.file)) {
      reviewer.files.push(finding.file);
    }
  }
  const round = { n, from, tree, files, reviewers, carried };
  state.rounds.push(round);
  state.status = 'reviewing';
  mkdirSync(roundDir(repo, n), { recursive: true });
  for (const name of Object.keys(reviewers)) writeReviewerInput(repo, state, round, name);
  repo.save(state);
  print({
    result: 'REVIEW',
    round: n,
    reviewers: Object.keys(reviewers).map((name) => reviewerPlan(repo, state, round, name)),
    next: 'Run every reviewer in parallel, then run `judge`.',
  });
}

export function selectReviewers(files, diff) {
  const selected = {};
  for (const [name, rule] of Object.entries(REVIEWERS)) {
    const byPath = files.filter((f) => rule.paths.some((p) => p.test(f)));
    const byContent = (rule.content ?? []).length
      ? files.filter((f) => changedLines(diff, f).some((l) => rule.content.some((p) => p.test(l))))
      : [];
    const matched = [...new Set([...byPath, ...byContent])];
    if (matched.length) selected[name] = { selectedBy: 'rule', files: matched };
  }
  return selected;
}

function changedLines(diff, file) {
  const section = diff.split(/^diff --git /m).find((s) => s.startsWith(`a/${file} `));
  if (!section) return [];
  return section
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    .map((l) => l.slice(1));
}

function writeReviewerInput(repo, state, round, name) {
  const reviewer = round.reviewers[name];
  const diff = reviewer.files.length ? repo.diff(round.from, round.tree, reviewer.files) : '';
  writeFileSync(diffPath(repo, round.n, name), diff);
  const carried = round.carried
    .map((id) => state.findings[id])
    .filter((f) => f.reviewer === name)
    .map((f) => ({ ...f, lastResponse: f.responses.at(-1) }));
  writeFileSync(carriedPath(repo, round.n, name), JSON.stringify(carried, null, 2));
}

function reviewerPlan(repo, state, round, name) {
  const reviewer = round.reviewers[name];
  return {
    reviewer: name,
    agent: `review-${name}`,
    selectedBy: reviewer.selectedBy,
    reason: reviewer.reason,
    files: reviewer.files,
    prompt: [
      `Review round ${round.n} as the ${name} reviewer. Follow .claude/review/protocol.md.`,
      round.n === 1
        ? `Diff to review (base ${state.base.slice(0, 12)}): ${diffPath(repo, round.n, name)}`
        : `Diff of the fixes since round ${round.n - 1}: ${diffPath(repo, round.n, name)}`,
      `Findings carried from earlier rounds, each needing a reply: ${carriedPath(repo, round.n, name)}`,
      `Write your output to: ${outputPath(repo, round.n, name)}`,
      `Allowed categories: ${REVIEWERS[name].categories.join(', ')}`,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Judgement

export function isBlocking(finding) {
  return (
    SEVERITIES.indexOf(finding.severity) >= SEVERITIES.indexOf(THRESHOLD.severity) &&
    CONFIDENCES.indexOf(finding.confidence) >= CONFIDENCES.indexOf(THRESHOLD.confidence)
  );
}

function findingKey(f) {
  return `${f.file}|${f.reviewer}|${f.category}`;
}

export function applyJudgement(state, round, outputs) {
  for (const [name, output] of Object.entries(outputs)) {
    for (const reply of output.replies ?? []) {
      const finding = state.findings[reply.id];
      finding.replies.push({ round: round.n, verdict: reply.verdict, comment: reply.comment });
      if (reply.verdict === 'withdraw') finding.status = 'withdrawn';
    }
    (output.findings ?? []).forEach((raw, i) => {
      const id = `${name}-R${round.n}-${i + 1}`;
      state.findings[id] = {
        id,
        reviewer: name,
        round: round.n,
        file: raw.file,
        line: raw.line ?? 0,
        severity: raw.severity,
        confidence: raw.confidence,
        category: raw.category,
        summary: raw.summary,
        failureScenario: raw.failure_scenario,
        status: isBlocking(raw) ? 'open' : 'note',
        responses: [],
        replies: [],
      };
    });
  }

  // Same file, reviewer and category raised as new blocking findings in two consecutive rounds.
  // Findings answered with a dispute are excluded.
  const raisedIn = (n) =>
    Object.values(state.findings).filter((f) => f.round === n && isBlocking(f));
  const previousKeys = new Set(
    raisedIn(round.n - 1)
      .filter((f) => f.responses.at(-1)?.action !== 'dispute')
      .map(findingKey),
  );
  const repeated = raisedIn(round.n).filter((f) => previousKeys.has(findingKey(f)));
  if (repeated.length) {
    abort(
      state,
      'repeated-finding',
      `the same file, reviewer and category came back in rounds ${round.n - 1} and ${round.n}`,
      repeated.map((f) => f.id),
    );
    return { result: 'ABORT', abort: state.abort, openFindings: openFindings(state) };
  }

  const open = openFindings(state);
  if (open.length === 0) {
    state.status = 'done';
    return {
      result: 'DONE',
      notes: Object.values(state.findings).filter((f) => f.status === 'note'),
    };
  }
  if (round.n >= MAX_ROUNDS) {
    abort(
      state,
      'round-limit',
      `blocking findings remain after round ${round.n}; the limit is ${MAX_ROUNDS}`,
      open.map((f) => f.id),
    );
    return { result: 'ABORT', abort: state.abort, openFindings: open };
  }
  state.status = 'fixing';
  return {
    result: 'FIX',
    round: round.n,
    openFindings: open,
    responses: `For every open finding, fix it or dispute it, then write the responses and run \`next\`.`,
  };
}

export function applyResponses(state, round, responses) {
  const stalemates = [];
  for (const r of responses) {
    const finding = state.findings[r.id];
    const previous = finding.responses.at(-1);
    const lastReply = finding.replies.at(-1);
    if (
      r.action === 'dispute' &&
      previous?.action === 'dispute' &&
      previous.reasonType === r.reasonType &&
      lastReply?.verdict === 'maintain'
    ) {
      stalemates.push(r.id);
    }
    finding.responses.push({
      round: round.n,
      action: r.action,
      reasonType: r.reasonType,
      reason: r.reason,
      evidence: r.evidence,
    });
  }
  if (stalemates.length === 0) return null;
  abort(
    state,
    'disputed-twice',
    'the reviewer maintained a finding that was disputed twice in a row for the same reason',
    stalemates,
  );
  return { result: 'ABORT', abort: state.abort, openFindings: openFindings(state) };
}

function openFindings(state) {
  return Object.values(state.findings).filter((f) => f.status === 'open');
}

function abort(state, kind, message, findingIds = []) {
  state.status = 'aborted';
  state.abort = { kind, message, findings: findingIds };
}

// ---------------------------------------------------------------------------
// Validation

export function validateOutput(state, round, name, output) {
  const errors = [];
  const at = (msg) => errors.push(`${name}: ${msg}`);
  if (typeof output !== 'object' || output === null) return [`${name}: output must be an object`];
  if (!Array.isArray(output.findings)) at('`findings` must be an array');
  if (!Array.isArray(output.replies)) at('`replies` must be an array');
  if (errors.length) return errors;
  if ([...output.replies, ...output.findings].some((x) => typeof x !== 'object' || x === null)) {
    return [`${name}: every reply and finding must be an object`];
  }

  const expected = round.carried.filter((id) => state.findings[id].reviewer === name);
  const answered = output.replies.map((r) => r.id);
  for (const id of expected) if (!answered.includes(id)) at(`no reply for carried finding ${id}`);
  for (const r of output.replies) {
    if (!expected.includes(r.id)) at(`reply to unknown or uncarried finding ${r.id}`);
    if (!['withdraw', 'maintain'].includes(r.verdict))
      at(`${r.id}: verdict must be withdraw or maintain`);
    if (!r.comment) at(`${r.id}: comment is required`);
  }
  output.findings.forEach((f, i) => {
    const where = `findings[${i}]`;
    if (!f.file) at(`${where}: file is required`);
    if (!SEVERITIES.includes(f.severity))
      at(`${where}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (!CONFIDENCES.includes(f.confidence))
      at(`${where}: confidence must be one of ${CONFIDENCES.join(', ')}`);
    if (!REVIEWERS[name].categories.includes(f.category)) {
      at(`${where}: category must be one of ${REVIEWERS[name].categories.join(', ')}`);
    }
    if (!f.summary) at(`${where}: summary is required`);
    if (!f.failure_scenario) at(`${where}: failure_scenario is required`);
  });
  return errors;
}

export function validateResponses(state, responses) {
  if (!Array.isArray(responses)) return ['responses must be an array'];
  if (responses.some((r) => typeof r !== 'object' || r === null)) {
    return ['every response must be an object'];
  }
  const errors = [];
  const open = openFindings(state).map((f) => f.id);
  const answered = responses.map((r) => r.id);
  for (const id of new Set(answered)) {
    if (answered.indexOf(id) !== answered.lastIndexOf(id))
      errors.push(`duplicate response for ${id}`);
  }
  for (const id of open)
    if (!answered.includes(id)) errors.push(`no response for open finding ${id}`);
  for (const r of responses) {
    if (!open.includes(r.id)) errors.push(`response to unknown or closed finding ${r.id}`);
    if (r.action === 'dispute') {
      if (!REASON_TYPES.includes(r.reasonType)) {
        errors.push(`${r.id}: reasonType must be one of ${REASON_TYPES.join(', ')}`);
      }
      if (!r.reason) errors.push(`${r.id}: reason is required for a dispute`);
      const evidence = Array.isArray(r.evidence) ? r.evidence : [];
      if (evidence.length === 0 || evidence.some((e) => !e?.source || !e?.detail)) {
        errors.push(`${r.id}: a dispute needs evidence, each item with source and detail`);
      }
    } else if (r.action !== 'fix') {
      errors.push(`${r.id}: action must be fix or dispute`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Summary

function renderSummary(state, integRecord) {
  const findings = Object.values(state.findings);
  const lines = [
    `## Review`,
    '',
    `Result: **${state.status}** after ${state.rounds.length} round(s).`,
  ];
  if (state.abort) lines.push('', `Aborted (${state.abort.kind}): ${state.abort.message}`);
  const reviewers = state.rounds.flatMap((r) =>
    Object.entries(r.reviewers).map(
      ([name, v]) => `round ${r.n} ${name} (${v.selectedBy}${v.reason ? `: ${v.reason}` : ''})`,
    ),
  );
  lines.push('', `Reviewers: ${reviewers.join('; ')}`);
  const integProblem = integStatus(state, integRecord);
  lines.push(
    '',
    integProblem
      ? `Integration test: **not passed** (${integProblem}).`
      : `Integration test: **passed** on the reviewed files (${integRecord.at}).`,
  );
  const section = (title, list) => {
    if (list.length === 0) return;
    lines.push('', `### ${title}`, '');
    for (const f of list) {
      lines.push(
        `- \`${f.file}:${f.line}\` ${f.reviewer}/${f.category} (${f.severity}, ${f.confidence}) — ${f.summary}`,
      );
      for (const r of f.responses) {
        lines.push(
          `  - round ${r.round} ${r.action}${r.reasonType ? ` (${r.reasonType})` : ''}${r.reason ? `: ${r.reason}` : ''}`,
        );
        for (const e of r.evidence ?? []) lines.push(`    - evidence \`${e.source}\`: ${e.detail}`);
      }
      for (const r of f.replies)
        lines.push(`  - round ${r.round} reviewer ${r.verdict}: ${r.comment}`);
    }
  };
  section(
    'Withdrawn after a dispute',
    findings.filter(
      (f) => f.status === 'withdrawn' && f.responses.some((r) => r.action === 'dispute'),
    ),
  );
  section(
    'Open',
    findings.filter((f) => f.status === 'open'),
  );
  section(
    'Below the threshold',
    findings.filter((f) => f.status === 'note'),
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Git

export function openRepo(cwd) {
  // Paths passed to git are relative to the root, so every call after the first runs there.
  let at = cwd;
  const git = (args, options = {}) => {
    const r = spawnSync('git', args, {
      cwd: at,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    if (r.error || r.status !== 0) fail(`git ${args.join(' ')} failed:\n${r.stderr ?? r.error}`);
    return r.stdout;
  };
  const root = git(['rev-parse', '--show-toplevel']).trim();
  at = root;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const dir = join(root, STATE_DIR, branch.replace(/[^\w.-]+/g, '-'));
  const statePath = join(dir, 'state.json');
  // Outside `dir`, which `start` wipes: the test may run before the review starts.
  const integPath = `${dir}.integ.json`;

  return {
    root,
    branch,
    dir,
    git,
    load: () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null),
    loadInteg: () => (existsSync(integPath) ? JSON.parse(readFileSync(integPath, 'utf8')) : null),
    saveInteg: (record) => {
      mkdirSync(join(root, STATE_DIR), { recursive: true });
      writeFileSync(integPath, JSON.stringify(record, null, 2));
    },
    save: (state) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    },
    // Tree of the working copy, untracked files included, without touching the real index.
    snapshot: () => {
      const temp = mkdtempSync(join(tmpdir(), 'claude-review-'));
      const index = join(temp, 'index');
      const env = { ...process.env, GIT_INDEX_FILE: index };
      try {
        // Start from the real index so its stat cache spares rehashing unchanged files.
        const real = resolve(root, git(['rev-parse', '--git-path', 'index'], { cwd: root }).trim());
        if (existsSync(real)) copyFileSync(real, index);
        else git(['read-tree', 'HEAD'], { env, cwd: root });
        git(['add', '-A'], { env, cwd: root });
        // Excluded even where .gitignore does not cover it; an exclude pathspec fails when it does.
        git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', STATE_DIR], {
          env,
          cwd: root,
        });
        return git(['write-tree'], { env, cwd: root }).trim();
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
    treeOf: (ref) => {
      const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], {
        cwd: root,
        encoding: 'utf8',
      });
      return r.status === 0 ? r.stdout.trim() : null;
    },
    // -z keeps non-ASCII paths unquoted; --no-renames lists both sides of a rename.
    changedFiles: (from, to) =>
      git(['diff', '--name-only', '-z', '--no-renames', from, to, '--'])
        .split('\0')
        .filter(Boolean),
    diff: (from, to, files) => {
      const shown = files.filter((f) => !hiddenFromDiff(f));
      const hidden = files.filter(hiddenFromDiff);
      const body = shown.length
        ? git([
            '-c',
            'core.quotePath=false',
            'diff',
            // Fixed format regardless of user config; changedLines parses the a/ b/ headers.
            '--no-ext-diff',
            '--no-color',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            '--no-renames',
            from,
            to,
            '--',
            ...shown,
          ])
        : '';
      return hidden.length ? `${body}\n# Changed but not shown: ${hidden.join(', ')}\n` : body;
    },
  };
}

function roundDir(repo, n) {
  return join(repo.dir, `round-${n}`);
}
function diffPath(repo, n, name) {
  return join(roundDir(repo, n), `${name}.diff`);
}
function carriedPath(repo, n, name) {
  return join(roundDir(repo, n), `${name}.carried.json`);
}
function outputPath(repo, n, name) {
  return join(roundDir(repo, n), `${name}.json`);
}
function responsesPath(repo, n) {
  return join(roundDir(repo, n), 'responses.json');
}

// ---------------------------------------------------------------------------
// Helpers

function requireStatus(repo, expected) {
  const state = repo.load();
  if (!state) fail('no review has been started; run `start`');
  if (state.status !== expected) {
    fail(
      `the review is ${state.status}, not ${expected}${state.abort ? `: ${state.abort.message}` : ''}`,
    );
  }
  return state;
}

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  throw new ReviewError(message);
}
