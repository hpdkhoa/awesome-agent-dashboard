# Runs the bridge in the background on Windows: a Task Scheduler task that starts `pythonw -m agent_bridge watch`
# when you log on, with no window. A watchdog trigger fires every minute: while the bridge runs the fire is ignored
# (MultipleInstances IgnoreNew), and a stopped bridge starts again within 1 min (the owner's choice, 2026-11-12:
# "Task watchdog"). Output goes to %USERPROFILE%\.awesome-agent-dashboard\bridge.log.
#   Install:   powershell -ExecutionPolicy Bypass -File bridge\install-task.ps1
#   Remove:    powershell -ExecutionPolicy Bypass -File bridge\install-task.ps1 -Uninstall
# Run `python -m agent_bridge signin` once before installing.
param([switch]$Uninstall)

$Name = "AgentDashboardBridge"
if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed task $Name."
    exit 0
}

$Bridge = $PSScriptRoot
$Pythonw = (Get-Command pythonw -ErrorAction Stop).Source
$Action = New-ScheduledTaskAction -Execute $Pythonw -Argument "-m agent_bridge watch" -WorkingDirectory $Bridge
$Trigger = @(
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
    -Description "awesome-agent-dashboard bridge: syncs Claude Code sessions and token spend (read-only)" -Force | Out-Null
Start-ScheduledTask -TaskName $Name
Write-Output "Installed and started task $Name. Log: $env:USERPROFILE\.awesome-agent-dashboard\bridge.log"
