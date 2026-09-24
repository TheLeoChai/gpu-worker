# gpu-worker self-deploy: fetch -> reset --hard origin/master -> restart worker.
# Runs from Task Scheduler task "gpu-worker-deploy" (user session, interactive).
# Never run this from inside a worker job: the restart kills that job's process tree.
# Exit codes: 0 ok/no-op, 2 job running (defer), 3 locked, 4 git failure, 5 health failure.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$logFile = Join-Path $root "deploy.log"
$lockFile = Join-Path $root "deploy.lock"
$scriptRev = 3

function Log([string]$msg) {
  try {
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) {
      Move-Item -Force $logFile ($logFile + ".old")
    }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
  } catch {}
}

function ExitWith([int]$code, [string]$msg) {
  Log "$msg"
  Log "=== deploy end (exit $code, rev $scriptRev) ==="
  exit $code
}

function Get-RunningJobName {
  try {
    $data = Get-Content (Join-Path $root "jobs.json") -Raw | ConvertFrom-Json
    if ($data.jobs) {
      $r = @($data.jobs.PSObject.Properties | Where-Object { $_.Value.status -eq "running" })
      if ($r.Count -gt 0) { return $r[0].Name }
    }
    if ($data.runningId) { return $data.runningId }
  } catch {
    Log "jobs.json unreadable ($($_.Exception.Message)) - treating as no job running"
  }
  return $null
}

Log "=== deploy start (pid $PID, rev $scriptRev) ==="

# --- single-instance lock; stale locks older than 15 min are broken ---
if (Test-Path $lockFile) {
  $age = (Get-Date) - (Get-Item $lockFile).LastWriteTime
  if ($age.TotalSeconds -lt 900) {
    ExitWith 3 "another deploy in progress (lock age $([int]$age.TotalSeconds)s), aborting"
  }
  Log "removing stale lock (age $([int]$age.TotalSeconds)s)"
  Remove-Item -Force $lockFile
}
Set-Content -Path $lockFile -Value "$PID $(Get-Date -Format o)"

try {
  # --- never restart under a running job (worker is FIFO, one at a time) ---
  $busy = Get-RunningJobName
  if ($busy) { ExitWith 2 "job running ($busy) - deferring deploy to next trigger" }

  # --- fetch + compare ---
  $fetchOut = git -C $root fetch origin 2>&1
  if ($LASTEXITCODE -ne 0) { ExitWith 4 "git fetch failed (exit $LASTEXITCODE): $fetchOut" }
  $head = (git -C $root rev-parse HEAD).Trim()
  $originMaster = (git -C $root rev-parse origin/master).Trim()
  Log "local HEAD $head; origin/master $originMaster"
  if ($head -eq $originMaster) { ExitWith 0 "already at origin/master - no-op" }

  # --- re-check right before stopping the worker (narrow race window) ---
  $busy = Get-RunningJobName
  if ($busy) { ExitWith 2 "job started during deploy ($busy) - deferring to next trigger" }

  # --- hard reset to origin/master (auth.env / jobs.json / logs are untracked + ignored) ---
  $resetOut = git -C $root reset --hard origin/master 2>&1
  if ($LASTEXITCODE -ne 0) { ExitWith 4 "git reset --hard failed: $resetOut" }
  Log "reset to origin/master: $($resetOut | Select-Object -First 1)"

  # --- restart via the repo's own scripts ---
  Log "stopping worker via stop-worker.cmd"
  $null = & cmd.exe /c (Join-Path $root "stop-worker.cmd") 2>&1
  Start-Sleep -Seconds 2
  Log "starting worker via start-worker-hidden.vbs"
  & wscript.exe (Join-Path $root "start-worker-hidden.vbs") | Out-Null
  Start-Sleep -Seconds 10

  # --- verify: loopback health must return 200 ---
  $healthy = $false
  $content = ""
  foreach ($i in 1..12) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:4120/health" -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { $healthy = $true; $content = $r.Content; break }
    } catch { Start-Sleep -Seconds 5 }
  }
  if (-not $healthy) { ExitWith 5 "worker did not return 200 on http://127.0.0.1:4120/health within 60s" }
  Log "health OK: $content"

  $listeners = @(Get-NetTCPConnection -LocalPort 4120 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty LocalAddress -Unique)
  Log "port 4120 listening on: $($listeners -join ', ')"
  if (-not ($listeners | Where-Object { $_ -like "100.*" })) {
    Log "WARNING: tailscale listener not bound yet (server watcher retries every 10s) - continuing"
  }

  $newHead = (git -C $root rev-parse HEAD).Trim()
  ExitWith 0 "deploy complete: HEAD=$newHead"
} finally {
  Remove-Item -Force $lockFile -ErrorAction SilentlyContinue
}
