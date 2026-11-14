# Starts the desktop avatar when you sign in to Windows (plan b73e97ad, step p4): a Task Scheduler task, like the
# bridge's install-task.ps1. Build first: cargo build --release (in this folder).
#   Install:   powershell -ExecutionPolicy Bypass -File avatar\install-startup.ps1
#   Remove:    powershell -ExecutionPolicy Bypass -File avatar\install-startup.ps1 -Uninstall
param([switch]$Uninstall)

$Name = "AgentAvatar"
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed task $Name."
    exit 0
}

$Exe = Join-Path $PSScriptRoot "target\release\agent-avatar.exe"
if (-not (Test-Path $Exe)) { throw "No $Exe. Run: cargo build --release" }
$Action = New-ScheduledTaskAction -Execute $Exe -WorkingDirectory $PSScriptRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
    -Description "hayaku, the awesome-agent-dashboard desktop avatar: status box (read-only)" -Force | Out-Null
Write-Output "Installed task $Name (starts at sign-in)."
