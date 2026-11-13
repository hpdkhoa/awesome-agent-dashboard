# Plug a new box into the dashboard, in one run (Windows). The owner's words, 2026-11-13: "make it in the way I can plug
# and play another box in this dashboard"; "is the setup has setup script to auto run on new box yet?".
#
#   powershell -ExecutionPolicy Bypass -File bridge\setup-box.ps1 -Url https://box2-files.example.com -Roots "labs=D:\labs;web=D:\web"
#
# Before: clone this repo on the box, copy .env from a box that already works (it holds no secret: the Firebase project,
# the page's public key, your email, the page origins), and route -Url to 127.0.0.1:<FILES_PORT> with your own tunnel
# (the script never touches the tunnel).
# It then: installs the bridge's Python packages, writes this box's own lines into .env, signs you in (once), makes the
# empty local database, registers the inbox with Claude Code, installs and starts the background task, and waits until
# the bridge says it registered this box. Safe to run again: every step that is already done is skipped.
param(
    [string]$Url = "",          # this box's own address for the page (required the first time)
    [string]$Roots = "",        # the work folders on this box: "name=path;name=path" (WORK_ROOTS)
    [string]$Name = "",         # the box's name on the dashboard (default: the computer name)
    [int]$Port = 0,             # the local port the address routes to (default 8793)
    [switch]$NoService,         # do everything but the background task
    [switch]$DryRun             # say what would be done, change nothing
)
$ErrorActionPreference = "Stop"
$Bridge = $PSScriptRoot
$Repo = Split-Path $Bridge -Parent
$EnvFile = Join-Path $Repo ".env"
function Step($m) { Write-Output ""; Write-Output "== $m" }
function Fail($m) { Write-Output "STOP: $m"; exit 1 }
function Py { param([Parameter(ValueFromRemainingArguments)]$a) & $script:Python @a; if ($LASTEXITCODE -ne 0) { throw "python $($a -join ' ') ended with $LASTEXITCODE" } }

Step "1. Python"
$cmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $cmd) { Fail "no python found: install Python 3.11 or newer (python.org), with pythonw" }
$script:Python = $cmd.Source
& $Python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) { Fail "Python 3.11 or newer is needed ($(& $Python --version))" }
Write-Output "$(& $Python --version) at $Python"

Step "2. The bridge's packages"
$where = & $Python -c "import agent_bridge, keyring, mcp, psutil, jwt, os; print(os.path.dirname(os.path.dirname(agent_bridge.__file__)))" 2>$null
if ($LASTEXITCODE -eq 0 -and $where -and ((Resolve-Path $where).Path -eq (Resolve-Path $Bridge).Path)) { Write-Output "already installed" }
elseif ($DryRun) { Write-Output "would run: python -m pip install --user -e $Bridge" }
else { Py -m pip install --user -e $Bridge }

Step "3. .env"
if (-not (Test-Path $EnvFile)) { Fail "no $EnvFile : copy .env from a box that already works, then run this again" }
$lines = [System.Collections.Generic.List[string]](Get-Content $EnvFile -Encoding UTF8)
function Has($key) { [bool]($lines | Where-Object { $_ -match "^$key=." }) }
if (-not ((Has "FIREBASE_PROJECT_ID") -or (Has "VITE_FIREBASE_PROJECT_ID"))) { Fail ".env has no FIREBASE_PROJECT_ID" }
if (-not (Has "VITE_FIREBASE_API_KEY")) { Fail ".env has no VITE_FIREBASE_API_KEY" }
function SetEnv($key, $value) {
    if (-not $value) { return }
    if ($DryRun) { Write-Output "would set $key=$value in .env"; return }
    $kept = [System.Collections.Generic.List[string]]($script:lines | Where-Object { $_ -notmatch "^$key=" })
    $kept.Add("$key=$value")
    $script:lines = $kept
    Write-Output "set $key"
}
SetEnv "FILES_URL" $Url.TrimEnd("/")
SetEnv "WORK_ROOTS" $Roots
SetEnv "MACHINE_NAME" $Name
if ($Port) { SetEnv "FILES_PORT" "$Port" }
if (-not $DryRun) { [System.IO.File]::WriteAllLines($EnvFile, $lines, (New-Object System.Text.UTF8Encoding $false)) }
# a copied .env names the first box's folders: they do not belong to this one
if (-not $Roots -and -not $DryRun) {
    $r = ($lines | Where-Object { $_ -match "^WORK_ROOTS=" } | Select-Object -Last 1) -replace "^WORK_ROOTS=", ""
    $paths = @($r -split ";" | Where-Object { $_ -match "=" } | ForEach-Object { ($_ -split "=", 2)[1].Trim() })
    if (-not $paths -or ($paths | Where-Object { -not (Test-Path $_ -PathType Container) })) {
        Fail 'WORK_ROOTS in .env names folders that are not on this box: pass -Roots "name=path;..."'
    }
}
if (-not (Has "FILES_URL") -and -not $DryRun) { Fail "no address for this box: pass -Url https://... (this box's own tunnel address)" }

Push-Location $Bridge
try {
    Step "4. Sign in"
    & $Python -c "from agent_bridge.auth import load_token; raise SystemExit(0 if load_token() else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Output "already signed in" }
    elseif ($DryRun) { Write-Output "would run: python -m agent_bridge signin" }
    else { Py -m agent_bridge signin }

    Step "5. The local database"
    if ($DryRun) { Write-Output "would run: python -m agent_bridge init-local" } else { Py -m agent_bridge init-local }
}
finally { Pop-Location }

Step "6. The inbox in Claude Code"
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) { Write-Output "no claude CLI on this box yet: install Claude Code and sign in, then run this again (runs need it)" }
else {
    $listed = (& claude mcp list 2>$null) -join "`n"
    if ($listed -match "(?m)^agent-inbox") { Write-Output "already registered" }
    elseif ($DryRun) { Write-Output "would run: claude mcp add --scope user agent-inbox -- python -m agent_bridge inbox" }
    else { & claude mcp add --scope user agent-inbox -- $Python -m agent_bridge inbox }
}

Step "7. The background task"
if ($NoService) { Write-Output "skipped (-NoService). Start by hand: cd $Bridge; python -m agent_bridge watch" }
elseif ($DryRun) { Write-Output "would run: bridge\install-task.ps1" }
else { & (Join-Path $Bridge "install-task.ps1") }

Step "8. Registered?"
if ($DryRun -or $NoService) { Write-Output "not checked" }
else {
    $log = Join-Path $env:USERPROFILE ".awesome-agent-dashboard\bridge.log"
    $ok = $false
    for ($i = 0; $i -lt 45 -and -not $ok; $i++) {
        if ((Test-Path $log) -and (Select-String -Path $log -Pattern "registered as box|in the registry" -Quiet)) { $ok = $true } else { Start-Sleep 2 }
    }
    if ($ok) { Write-Output "This box is registered. Open the dashboard: it is under Boxes (right panel), plugged in." }
    else {
        Write-Output "The bridge has not said it registered yet. Look at $log."
        Write-Output "Common causes: the tunnel does not route the address to 127.0.0.1:$(if ($Port) { $Port } else { 8793 }); SITE_ORIGINS in .env lacks the page's address."
    }
}
Write-Output ""
Write-Output "Unplug later: Boxes on the dashboard, Unplug. Remove the task: powershell -ExecutionPolicy Bypass -File bridge\install-task.ps1 -Uninstall"
