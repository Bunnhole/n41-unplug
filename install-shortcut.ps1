# Creates (or refreshes) a "n41 unplug" shortcut on the Desktop that runs the launcher. Windows only.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'n41 unplug.lnk'
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)
$s.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$s.Arguments = "`"$root\n41 unplug.vbs`""
$s.WorkingDirectory = $root
$s.IconLocation = "$env:SystemRoot\System32\shell32.dll,18"
$s.Description = 'n41 unplug (starts the local server, stops it when the window closes)'
$s.Save()
Write-Host "Shortcut written: $lnk"
