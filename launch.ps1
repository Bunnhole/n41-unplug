# n41 unplug launcher (Windows).
# Shows a small splash window, starts the server (hidden) if it is not already running, opens the
# console in an app-style browser window, waits for that window to close, then stops the server.
# The server runs with --auto-exit, so it also quits on its own ~8s after the last console page goes away.

param([int]$Port = 8787)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://localhost:$Port"        # what the browser opens
$checkUrl = "http://127.0.0.1:$Port"   # what this script polls: "localhost" can resolve to ::1 first and stall the probe
$appTitle = 'n41 unplug'

# Launcher log, for "it does nothing" reports: %LOCALAPPDATA%\n41-unplug\launcher.log (last run only)
$logDir = Join-Path $env:LOCALAPPDATA 'n41-unplug'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir 'launcher.log'
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] launcher start, root=$root port=$Port" | Out-File $logFile -Encoding utf8
function Log([string]$m) { "[$(Get-Date -Format 'HH:mm:ss.fff')] $m" | Out-File $logFile -Append -Encoding utf8 }

# ---- splash window -------------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$html = { param($h) [System.Drawing.ColorTranslator]::FromHtml($h) }

$splash = New-Object System.Windows.Forms.Form
$splash.Text = "Starting $appTitle"
$splash.FormBorderStyle = 'FixedToolWindow'
$splash.ControlBox = $false
$splash.StartPosition = 'CenterScreen'
$splash.ClientSize = New-Object System.Drawing.Size(380, 118)
$splash.TopMost = $true
$splash.BackColor = & $html '#161b23'

$title = New-Object System.Windows.Forms.Label
$title.Text = $appTitle
$title.ForeColor = & $html '#e6e9ef'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(20, 16)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Starting local server...'
$status.ForeColor = & $html '#8b94a5'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$status.AutoSize = $false
$status.Size = New-Object System.Drawing.Size(340, 36)
$status.Location = New-Object System.Drawing.Point(22, 50)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 25
$bar.Location = New-Object System.Drawing.Point(20, 94)
$bar.Size = New-Object System.Drawing.Size(340, 8)

$closeBtn = New-Object System.Windows.Forms.Button
$closeBtn.Text = 'Close'
$closeBtn.Size = New-Object System.Drawing.Size(80, 26)
$closeBtn.Location = New-Object System.Drawing.Point(280, 84)
$closeBtn.FlatStyle = 'Flat'
$closeBtn.ForeColor = & $html '#e6e9ef'
$closeBtn.BackColor = & $html '#1d232d'
$closeBtn.Visible = $false
$closeBtn.Add_Click({ $script:userClosed = $true; $splash.Close() })

$splash.Controls.AddRange(@($title, $status, $bar, $closeBtn))
$splash.Show()

function Pump { [System.Windows.Forms.Application]::DoEvents() }
function SetStatus([string]$t) { Log $t; $status.Text = $t; Pump }
function Fail([string]$msg) {
    Log "FAIL: $msg"
    $status.Text = $msg
    $status.ForeColor = & $html '#ff5c5c'
    $bar.Visible = $false
    $closeBtn.Visible = $true
    $splash.TopMost = $true
    $script:userClosed = $false
    while ($splash.Visible -and -not $script:userClosed) { Pump; Start-Sleep -Milliseconds 50 }
    if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force }
    exit 1
}
function WaitPumping([int]$ms) { $end = (Get-Date).AddMilliseconds($ms); while ((Get-Date) -lt $end) { Pump; Start-Sleep -Milliseconds 50 } }

# ---- server --------------------------------------------------------------------------------
# Only trust the port if the thing answering is actually this app (its _meta reply has these fields).
# Uses a raw HttpWebRequest with no proxy: Invoke-RestMethod inside a hidden PowerShell can stall on
# proxy auto-detection and miss a short timeout.
function OurServer {
    try {
        $req = [System.Net.HttpWebRequest]::Create("$checkUrl/api/_meta")
        $req.Proxy = $null; $req.Timeout = 2000; $req.ReadWriteTimeout = 2000
        $resp = $req.GetResponse()
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $txt = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
        return ($txt -match '"autoExit"' -and $txt -match '"gateway"')
    } catch { Log "OurServer: $($_.Exception.Message)"; return $false }
}
function PortBusy {
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $Port); $c.Close(); return $true } catch { return $false }
}

$serverProc = $null
if (PortBusy) {
    if (OurServer) { SetStatus 'Server already running, reusing it.' }
    else { Fail "Port $Port is in use by another program. Close it, or run: node server.js --port 8790" }
} else {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
    if (-not $node) { Fail 'Node.js was not found. Install version 18 or newer from nodejs.org, then try again.' }
    $serverProc = Start-Process -FilePath $node -ArgumentList @("`"$root\server.js`"", '--auto-exit', '--port', $Port) -WorkingDirectory $root -WindowStyle Hidden -PassThru
    Log "started node pid $($serverProc.Id) ($node)"
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (OurServer) -and (Get-Date) -lt $deadline) { WaitPumping 150 }
    if (-not (OurServer)) { Fail 'The server did not start. Run start.cmd to see the error message.' }
}

# ---- browser window ------------------------------------------------------------------------
SetStatus 'Opening the console window...'
$browser = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($browser) {
    # Own profile folder so this is a separate process we can wait on, even if Edge/Chrome is already open.
    $profile = Join-Path $env:LOCALAPPDATA 'n41-unplug\browser-profile'
    New-Item -ItemType Directory -Force $profile | Out-Null
    $win = Start-Process -FilePath $browser -ArgumentList @("--app=$url", "--user-data-dir=`"$profile`"", '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--disable-features=msEdgeStartupBoost', '--window-size=1180,860') -PassThru
    Log "started browser pid $($win.Id) ($browser)"
    # Keep the splash up until the console window actually exists (first run on a fresh profile can take a while).
    $deadline = (Get-Date).AddSeconds(40)
    do { WaitPumping 200; $w = Get-Process | Where-Object { $_.MainWindowTitle -eq $appTitle } | Select-Object -First 1 } until ($w -or (Get-Date) -gt $deadline)
    Log "console window visible: $([bool]$w)"
    $splash.Close()
    $win.WaitForExit()
    Log 'browser window closed'
} else {
    # No Edge or Chrome: open the default browser and rely on the server's auto-exit.
    SetStatus 'Opening in your default browser...'
    Start-Process $url
    WaitPumping 3000
    $splash.Close()
    while (OurServer) { Start-Sleep -Seconds 2 }
}

if ($serverProc -and -not $serverProc.HasExited) { Stop-Process -Id $serverProc.Id -Force; Log 'server stopped' }
Log 'launcher exit'
