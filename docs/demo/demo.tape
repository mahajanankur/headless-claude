# headless-claude demo — a real run, recorded with VHS (https://github.com/charmbracelet/vhs).
#   vhs docs/demo/demo.tape          (from the repo root, after `npm ci`)
# Uses a few small Haiku calls on your own Claude credential.

Output docs/demo/demo.gif
Output docs/demo/demo.mp4

Set Shell "bash"
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful

# --- off camera: a clean prompt, keys loaded, helpers defined -------------------------------------
Hide
Type "export PS1='\[\e[1;36m\]headless-claude\[\e[0m\] $ '" Enter
Type "set -a; . ./.gateway-keys.local; set +a" Enter
Type `chat() { curl -s -X POST localhost:4100/api/v1/chat -H "Authorization: Bearer $DEV_KEY" -H 'Content-Type: application/json' -d "$1"; }` Enter
Type "clear" Enter
Show

# --- 1. setup: one command -------------------------------------------------------------------------
Type "# 1. One-command setup (safe to re-run)" Enter
Sleep 400ms
Type "npm run -s setup" Enter
Sleep 9s
Enter
Sleep 3s

# --- 2. start the gateway ---------------------------------------------------------------------------
Type "clear" Enter
Type "# 2. Start the API + worker" Enter
Type "npm run -s dev > /tmp/headless-claude-demo.log 2>&1 &" Enter
Sleep 6s

# --- 3. chat ---------------------------------------------------------------------------------------
Type "# 3. Chat: Claude Code as an API" Enter
Type `R=$(chat '{"message":"In one sentence: what is a mutex?","model":"haiku"}'); echo "$R" | jq -r .data.reply` Enter
Hide
Sleep 20s
Show
Sleep 2s
Type `chat "{\"message\":\"Now compare it to a semaphore in one sentence.\",\"sessionId\":\"$(echo $R | jq -r .data.sessionId)\",\"model\":\"haiku\"}" | jq -r .data.reply` Enter
Hide
Sleep 20s
Show
Sleep 3s

# --- 4. a skill: review a real GitHub repository ---------------------------------------------------
Type "clear" Enter
Type "# 4. Run a skill: review a real GitHub repo in a sandbox" Enter
Type `curl -s -X POST "localhost:4100/api/v1/jobs?wait=55" -H "Authorization: Bearer $DEV_KEY" -H 'Content-Type: application/json' -d '{"skill":"repo-review","model":"haiku","input":{"repoUrl":"https://github.com/mahajanankur/motifer.git"}}' > /tmp/job.json` Enter
Hide
Sleep 58s
Show
Type `JOB=$(jq -r .data.jobId /tmp/job.json); until curl -s localhost:4100/api/v1/jobs/$JOB -H "Authorization: Bearer $DEV_KEY" | jq -e '.data.status|test("succeeded|failed|needs_review|timed_out")' >/dev/null; do sleep 3; done` Enter
Hide
Sleep 40s
Show
Type `curl -s localhost:4100/api/v1/jobs/$JOB/result -H "Authorization: Bearer $DEV_KEY" | jq -r '.data.output.findings[:4][] | "[\(.severity)] \(.file):\(.line // "-")  \(.issue[:90])"'` Enter
Sleep 6s

# --- off camera: stop the gateway -------------------------------------------------------------------
Hide
Type "kill %1; sleep 2" Enter
Sleep 3s
