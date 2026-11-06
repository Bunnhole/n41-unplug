# Gateway Console launcher (Windows).
# Starts the server (hidden) if it is not already running, opens the console in an app-style
# browser window, waits for that window to close, then stops the server it started.
# The server is also started with --auto-exit, so it quits on its own ~8s after the last open
# console page goes away, even if this script is not the one watching it.

param([int]$Port = 8787)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://localhost:$Port"
$node = (Get-Command node).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

function PortAnswers { try { (Invoke-WebRequest -Uri "$url/api/_meta" -TimeoutSec 1 -UseBasicParsing).StatusCode -eq 200 } catch { $false } }

$serverProc = $null
if (-not (PortAnswers)) {
    $serverProc = Start-Process -FilePath $node -ArgumentList @("`"$root\server.js`"", '--auto-exit', '--port', $Port) -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (PortAnswers) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
}

# Prefer an app-mode window (no tabs or address bar) with its own profile so it is a separate
# process we can wait on, even if Edge or Chrome is already open with other windows.
$browser = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($browser) {
    $profile = Join-Path $env:LOCALAPPDATA 'gateway-console\browser-profile'
    New-Item -ItemType Directory -Force $profile | Out-Null
    $win = Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--user-data-dir=`"$profile`"", '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--disable-features=msEdgeStartupBoost', '--window-size=1180,860') -PassThru
    $win.WaitForExit()
} else {
    # No Edge or Chrome: open the default browser and rely on the server's auto-exit.
    Start-Process $url
    while (PortAnswers) { Start-Sleep -Seconds 2 }
}

if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force }
