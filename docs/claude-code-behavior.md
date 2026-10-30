# Verified Claude Code behaviour

The design depends on how `claude -p` actually behaves, not on assumptions. Each row below was observed, and recorded outputs are in [`test/fixtures/claude/`](../test/fixtures/claude) (scrubbed of personal data).

**Environment:**
- Claude Code 2.1.312 on macOS, 2026-10-28.
- `--model haiku --permission-mode dontAsk --output-format stream-json --verbose`.
- A clean environment (`env -i`), stdin set to `/dev/null`.
- Re-verify after upgrading the pinned version.

## Output stream

| Observation | Fixture | Consequence |
|---|---|---|
| Event types: `system` (`init`), `assistant`, `user` (tool results), **`rate_limit_event`**, `result` | `success.jsonl` | The parser handles all five and keeps unknown types as `other` |
| `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}` carries `utilization` (0–1), `resetsAt` and `status` | `success.jsonl` | **Live plan utilization is observable.** The scheduler stops starting jobs above configured thresholds |
| The `result` event carries `subtype`, `is_error`, `terminal_reason`, `api_error_status`, `num_turns`, `usage` (incl. `cache_read_input_tokens`), `modelUsage`, `total_cost_usd`, `permission_denials`, `session_id`, `structured_output` | `success.jsonl` | All attempt metrics come from this event |
| `--json-schema` returns `structured_output` (the `result` text holds the same JSON) | `json_schema.jsonl` | Use `structured_output` |
| Without stdin redirected, the CLI waits 3 s for input | — | Always spawn with `stdio[0] = 'ignore'` |

## Outcomes and exit codes

| Situation | Result event | Exit code | Fixture |
|---|---|---|---|
| Success | `subtype: success`, `is_error: false` | 0 | `success.jsonl` |
| `--max-turns` reached | `subtype: error_max_turns`, `terminal_reason: max_turns`, `errors[]` | 1 | `max_turns.jsonl` |
| Invalid token | **`subtype: success`**, `is_error: true`, `terminal_reason: api_error`, `api_error_status: 401` | 1 | `bad_token.jsonl` |
| Not logged in | **`subtype: success`**, `is_error: true`, `terminal_reason: api_error` | 1 | `cfgdir_auth.jsonl` |
| SIGINT during a tool | `subtype: error_during_execution`, `terminal_reason: aborted_tools` | **0** | `sigint.jsonl` |

**Consequence:** classify on `is_error`, `terminal_reason`, `api_error_status` and `subtype` together. Never on the exit code, and never on `subtype` alone.

## Permissions and file access (`dontAsk` mode)

| Probe | Result |
|---|---|
| Read a file outside the cwd, no allow rule | **Blocked** |
| Read a file outside the cwd with `--allowedTools Read` | **Allowed**: a bare `Read` grants access to any file |
| Read a file inside the cwd, no allow rule | Allowed |
| Read a file in an `--add-dir` directory, no allow rule | Allowed |

| Write a file inside the cwd, `--permission-mode acceptEdits` | Allowed |
| Write a file outside the cwd, `acceptEdits` | **Blocked** (`permission_denials`) |
| Write a file inside the cwd, `--permission-mode dontAsk` | **Blocked** |

**Consequences:**
- The manifest validator rejects bare file tools. File access stays inside the cwd and `--add-dir` directories.
- Skills that edit files (`edits: true`, or `changes ≠ none`) run with `acceptEdits`; read-only skills run with `dontAsk`.
- `--max-turns` works but is not listed in `--help`.

## Tools and bundled skills (real runs on a GitHub repository)

| Observation | Consequence |
|---|---|
| Claude Code 2.1.312's built-in tools: `Task`, `Bash`, `Cron*`, `Edit`, worktree tools, `Monitor`, `NotebookEdit`, `Read`, `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`, `StructuredOutput`, `TaskStop`, `ToolSearch`, `WebFetch`, `WebSearch`, `Write`. There's **no** `Grep`, `Glob` or `LS` | The gateway passes an explicit `--tools` allow-list (`Read` by default). It writes `repo-files.txt` so read-only skills can find files without Bash |
| Claude Code bundles commands and skills (`code-review`, `simplify`, `verify`, `debug`, `security-review`, …). `/code-review` ran the **bundled** skill instead of a gateway skill with the same name | Names of bundled commands are reserved (`RESERVED_SKILL_NAMES`) |
| Invoking a skill grants that skill's `allowed-tools`. The bundled `code-review` ran `Bash` under `dontAsk` with no grant from us, and read files outside the job workspace | `--disable-slash-commands`, no `Skill` tool, and `allowed-tools` in a gateway `SKILL.md` is rejected. The gateway injects `SKILL.md` as system instructions itself |
| With `Skill` absent from `--tools`, `/<name>` prompts no longer expand ("slash command is not installed") | Prompts don't start with `/<name>`; the instructions are injected |
| A denied call returns `tool_result` with `is_error: true` and the text `Permission to use <Tool> has been denied …` | Denied calls don't count as acting; only calls that ran do |

## Configuration, skills and sessions

| Observation | Fixture | Consequence |
|---|---|---|
| A skill loads through `--add-dir <dir>` when `<dir>/.claude/skills/<name>/SKILL.md` exists, and `/<name>` in the prompt runs it (with the `Skill` tool available) | `skill.jsonl` | Skill folder layout. The gateway no longer relies on this (see the bundled-skill finding above) |
| With the default `HOME`, a run loads all of the operator's personal skills and plugins | — | Each app gets its own `HOME`/`CLAUDE_CONFIG_DIR` |
| A custom `CLAUDE_CONFIG_DIR` on macOS reports "Not logged in" (the keychain login is tied to the default dir) | `cfgdir_auth.jsonl` | Per-app config dirs need `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) or an API key |
| `--setting-sources user`: a repository's `.claude/settings.json` `SessionStart` hook did **not** run (cwd = repo, or its parent) | — | Repository config never loads |
| `--resume <id>` works from the same cwd and from a different cwd | `resume_*.jsonl` | Resume doesn't depend on the cwd |

## Still to verify on Linux

Run [`ops/phase0/probe.sh`](../ops/phase0/probe.sh) on a **non-critical** host. The script lists everything it creates and removes it with `--cleanup`. It checks:

- systemd transient units surviving a worker restart
- the bubblewrap sandbox in `-p` mode
- permission deny rules vs `Read` and `cat`
- whether the token is visible to Bash subprocesses
- two concurrent runs on one config dir
- git and psql through the sandbox
- bubblewrap inside Docker
- the exact plan-limit message text
