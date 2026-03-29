param(
  [string]$ProjectRoot = (Get-Location).Path,
  [int]$PollSec = 8,
  [int]$MaxRestart = 999,
  [int]$MaxBackoffSec = 60,
  [string]$ResumePrompt = "Continue the current task. Run node flow.js resume first, then proceed with the protocol.",
  [switch]$NoDangerousBypass
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($PollSec -lt 1) { throw "PollSec must be >= 1" }
if ($MaxRestart -lt 1) { throw "MaxRestart must be >= 1" }
if ($MaxBackoffSec -lt 1) { throw "MaxBackoffSec must be >= 1" }

Set-Location $ProjectRoot

$logDir = Join-Path $ProjectRoot ".flowpilot\daemon"
New-Item -ItemType Directory -Force $logDir | Out-Null

$flowCli = @(
  (Join-Path $ProjectRoot "flow.js"),
  (Join-Path $ProjectRoot "dist\flow.js")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $flowCli) {
  throw "Cannot find flow CLI. Expected one of: $ProjectRoot\\flow.js or $ProjectRoot\\dist\\flow.js"
}

$stopFile = Join-Path $logDir "STOP"
$pidFile = Join-Path $logDir "daemon.pid"

if (Test-Path $pidFile) {
  try {
    $existingPid = [int](Get-Content -Raw $pidFile).Trim()
    if ($existingPid -gt 0) {
      $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
      if ($existing) {
        throw "Daemon already running, PID=$existingPid. Create $stopFile or terminate that process first."
      }
    }
  } catch {
    if ($_.Exception.Message -like "Daemon already running*") { throw }
  }
}

$PID | Set-Content -Encoding UTF8 -NoNewline $pidFile

function Get-WorkflowStatus {
  $progress = Join-Path $ProjectRoot ".workflow\progress.md"
  if (!(Test-Path $progress)) { return $null }
  $match = Select-String -Path $progress -Pattern '^[^:]+:\s*(\S+)' | Select-Object -First 1
  if ($match) {
    $g1 = $match.Matches[0].Groups[1].Value.Trim()
    if ($g1) { return $g1 }
  }
  return $null
}

function Is-WorkflowIdleOrMissing {
  param([string]$Status)
  if ([string]::IsNullOrWhiteSpace($Status)) { return $true }
  if ($Status -in @("idle", "completed", "aborted")) { return $true }
  return $false
}

function Should-Restart {
  param(
    [int]$ExitCode,
    [string]$Text
  )

  if ($ExitCode -ne 0) { return $true }
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }

  $patterns = @(
    "context window",
    "maximum context",
    "context length",
    "too many tokens",
    "context overflow",
    "compact"
  )
  foreach ($p in $patterns) {
    if ($Text -match [regex]::Escape($p)) { return $true }
  }
  return $false
}

function Is-ReconcilingOutput {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  $patterns = @(
    "reconciling",
    "node flow.js adopt",
    "node flow.js restart"
  )
  foreach ($p in $patterns) {
    if ($Text -match [regex]::Escape($p)) { return $true }
  }
  return $false
}

function Is-NoWorkflowOutput {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  $patterns = @(
    "no active workflow",
    "waiting for requirement input"
  )
  foreach ($p in $patterns) {
    if ($Text -match [regex]::Escape($p)) { return $true }
  }
  return $false
}

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string[]]$Args,
    [string]$LogFile
  )

  $text = ""
  $exitCode = 0

  $oldEap = $ErrorActionPreference
  try {
    # Avoid treating native stderr output as terminating errors.
    $ErrorActionPreference = "Continue"
    if ($LogFile) {
      $text = (& $File @Args *>&1 | Tee-Object -FilePath $LogFile | Out-String)
    } else {
      $text = (& $File @Args *>&1 | Out-String)
    }
    $exitCode = $LASTEXITCODE
  } catch {
    $text = ($_ | Out-String)
    if ($LogFile) {
      try { Add-Content -Path $LogFile -Value $text } catch {}
    }
    if ($null -ne $LASTEXITCODE) {
      $exitCode = $LASTEXITCODE
    } else {
      $exitCode = 1
    }
  }
  finally {
    $ErrorActionPreference = $oldEap
  }

  return [pscustomobject]@{
    Text     = $text
    ExitCode = if ($null -eq $exitCode) { 0 } else { [int]$exitCode }
  }
}

$restartCount = 0

try {
  while ($true) {
    if (Test-Path $stopFile) {
      Write-Host "[daemon] STOP file detected, exiting daemon loop."
      break
    }

    $status = Get-WorkflowStatus
    if (-not $status) {
      Write-Host "[daemon] no workflow state file yet, waiting."
      Start-Sleep -Seconds $PollSec
      continue
    }
    if (Is-WorkflowIdleOrMissing -Status $status) {
      Write-Host "[daemon] no active workflow, waiting."
      Start-Sleep -Seconds $PollSec
      continue
    }

    $resumeResult = Invoke-NativeCapture -File "node" -Args @($flowCli, "resume")
    if ($resumeResult.ExitCode -ne 0) {
      Write-Host "[daemon] flow resume failed (exit=$($resumeResult.ExitCode)), retry after $PollSec sec."
      Start-Sleep -Seconds $PollSec
      continue
    }
    $resumeText = $resumeResult.Text
    if (Is-NoWorkflowOutput -Text $resumeText) {
      Write-Host "[daemon] no active workflow, waiting."
      Start-Sleep -Seconds $PollSec
      continue
    }

    if (Is-ReconcilingOutput -Text $resumeText) {
      $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
      Write-Host "[daemon][$ts] reconciling detected; auto-resume paused, waiting manual adopt/restart/skip."
      Start-Sleep -Seconds $PollSec
      continue
    }

    $tsTag = Get-Date -Format "yyyyMMdd-HHmmss"
    $agentLog = Join-Path $logDir "codex-$tsTag.log"

    $cmd = @("exec", "resume", "--last")
    if (-not $NoDangerousBypass) {
      $cmd += "--dangerously-bypass-approvals-and-sandbox"
    }
    $cmd += $ResumePrompt

    $codexResult = Invoke-NativeCapture -File "codex" -Args $cmd -LogFile $agentLog
    $exitCode = $codexResult.ExitCode
    $logText = if (Test-Path $agentLog) { Get-Content -Raw $agentLog } else { $codexResult.Text }

    if (Should-Restart -ExitCode $exitCode -Text $logText) {
      $restartCount++
      if ($restartCount -gt $MaxRestart) {
        throw "Restart limit reached: $restartCount"
      }
      $delay = [Math]::Min($MaxBackoffSec, [Math]::Pow(2, [Math]::Min($restartCount, 6)))
      Write-Host "[daemon] restart #$restartCount after $delay sec."
      Start-Sleep -Seconds $delay
      continue
    }

    $restartCount = 0
    Start-Sleep -Seconds $PollSec
  }
}
finally {
  if (Test-Path $pidFile) {
    try { Remove-Item -Force $pidFile } catch {}
  }
}
