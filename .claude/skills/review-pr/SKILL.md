---
name: review-pr
description: Run the integration test, review this branch with reviewer subagents in a loop, then open the pull request. Use before creating any pull request; `gh pr create` is blocked until the review passes and the integration test has passed on the reviewed files.
---

# Test and review, then open the pull request

`.claude/review/review.mjs` decides everything about the loop: which reviewers run, what they see, and when the loop ends. You run the reviewers, fix or dispute what they find, and do exactly what the script's `result` says. Do not skip a step, and do not decide on your own that the review is good enough.

Run every command from the repository root as `node .claude/review/review.mjs <command>`.

## 0. Run the integration test

Make sure the Stop hook's verification passes first, and commit your changes.

```sh
node .claude/review/review.mjs integ
```

It runs `npx projen integ`: integ-runner deploys every `test/integ.*.ts` to AWS in ap-northeast-1, runs its assertions, compares the template with the committed snapshot, and destroys the stack. It takes several minutes; run it in the background. The result is recorded against the exact files in the working tree, and the gate accepts it only for the files the review passes.

It needs AWS credentials for a sandbox account (for example `AWS_PROFILE=sandbox`). Check them with `aws sts get-caller-identity` first. If they are missing or expired, stop and ask the user; do not log in yourself.

- `PASSED` with `snapshotChanged: false` — go to step 1.
- `PASSED` with `snapshotChanged: true` — integ-runner wrote a snapshot for a new test. Commit it, then go to step 1.
- It fails because the snapshot differs from the synthesized template — stop and report the diff to the user. Never pass `--update-on-failed` or delete a snapshot to make it pass.
- It fails for another reason — fix the cause and run it again. If a stack was left behind, `npx projen integ:destroy` removes it.

## 1. Start

```sh
node .claude/review/review.mjs start
```

Pass `--base <ref>` if the branch does not start from `origin/main`. If this branch already has a review that is not done, `start` refuses. When it is `reviewing` or `fixing` (an earlier session stopped midway), continue it from step 2 or 4 according to `node .claude/review/review.mjs status`. When it is `aborted`, ask the user; pass `--restart` only if they tell you to.

Review state lives in `.claude/review/.state/<branch>/`, which git ignores. Never edit it by hand.

`result: "DONE"` here means there is nothing to review. Go to step 5.

## 2. Run the reviewers

`result: "REVIEW"` lists reviewers. For each one, launch the subagent named in `agent` with `prompt` as its prompt, unchanged. Launch them all in parallel, in one message.

Before launching, look at the change yourself. If it needs a reviewer the rules did not pick (for example an IAM change in a file only `cdk` matched), add it:

```sh
node .claude/review/review.mjs add security --reason "grants a new role access to the bucket"
```

`add` prints the plan for that reviewer; launch it with the others.

## 3. Judge

When every reviewer has finished:

```sh
node .claude/review/review.mjs judge
```

If it rejects a reviewer's output, launch that reviewer again with the same prompt plus the error, then run `judge` again.

- `DONE` — go to step 5.
- `FIX` — go to step 4.
- `ABORT` — go to step 6.

## 4. Fix or dispute

For every finding in `openFindings`, either fix it or dispute it. Dispute only when you can show why the finding is wrong for this repository; a finding that is inconvenient is not wrong.

Before disputing, investigate. Read the code the finding points at and what calls it, the library source under `node_modules/` (for example `aws-cdk-lib`), the AWS or tool documentation, and run read-only commands (`pnpm exec vp test run`, a synth, `git log`) that settle the question. Every dispute needs at least one `evidence` item the reviewer can check on their own: a `source` (`file:line`, URL, or the exact command) and a `detail` saying what it shows. The reviewer is told to verify each item and to ignore anything that is only an assertion, so an argument without evidence will be maintained.

If the investigation shows the reviewer is right, fix it instead.

Write one response per open finding to `.claude/review/.state/<branch>/round-<n>/responses.json` (the exact path is in the error if you run `next` without it):

```json
[
  { "id": "cdk-R1-1", "action": "fix" },
  {
    "id": "security-R1-2",
    "action": "dispute",
    "reasonType": "by-design",
    "reason": "The wildcard is scoped by the aws:ResourceTag condition two lines below.",
    "evidence": [
      {
        "source": "src/workstation.ts:88",
        "detail": "The statement adds a StringEquals condition on aws:ResourceTag/workstation."
      },
      {
        "source": "https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrockagentcore.html",
        "detail": "The actions in the statement support the aws:ResourceTag condition key."
      }
    ]
  }
]
```

`reasonType` is one of `false-positive`, `out-of-scope`, `by-design`, `accepted-risk`. Then:

```sh
node .claude/review/review.mjs next
```

It prints the next `REVIEW` plan (back to step 2) or `ABORT`.

## 5. Open the pull request

```sh
node .claude/review/review.mjs summary
```

Append its output to the pull request body. Commit everything the review saw, push, and then run `gh pr create` as a command of its own. The gate lets it through only when the working tree, `HEAD` and `origin/<branch>` all match what the review passed, so push to a branch of the same name (`git push -u origin HEAD`). If you change any file after `DONE`, the gate blocks again; run the skill from step 1.

## 6. Aborted

Stop. Do not restart, fix further, or open the pull request. Report to the user:

- `abort.kind` and `abort.message`
- each finding in `abort.findings` with its responses and the reviewer's replies (`node .claude/review/review.mjs status` shows them)

Then wait for the user's decision.
