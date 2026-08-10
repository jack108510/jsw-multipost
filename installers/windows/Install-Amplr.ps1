$ErrorActionPreference = 'Stop'

$RepoZip = 'https://github.com/jack108510/jsw-multipost/archive/refs/heads/main.zip'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Amplr'
$ExtDir = Join-Path $InstallDir 'extension'
$TempDir = Join-Path $env:TEMP ('amplr-install-' + [guid]::NewGuid().ToString('N'))
$ZipPath = Join-Path $TempDir 'amplr.zip'
$LogDir = Join-Path $env:LOCALAPPDATA 'Amplr\Logs'
$Runner = Join-Path $InstallDir 'amplr-runner.ps1'
$TaskName = 'Amplr Runner'

function Write-Step($Message) {
  Write-Host "[Amplr] $Message" -ForegroundColor Cyan
}

function Find-Chrome {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  throw 'Google Chrome was not found. Install Chrome first, then run Amplr Installer again.'
}

Write-Host ''
Write-Host 'Amplr Installer' -ForegroundColor White
Write-Host 'This installs Amplr and keeps Chrome available for scheduled posts.' -ForegroundColor Gray
Write-Host ''

$Chrome = Find-Chrome
New-Item -ItemType Directory -Force -Path $TempDir, $InstallDir, $LogDir | Out-Null

Write-Step 'Downloading latest Amplr...'
Invoke-WebRequest -Uri $RepoZip -OutFile $ZipPath -UseBasicParsing

Write-Step 'Installing extension files...'
if (Test-Path $ExtDir) { Remove-Item $ExtDir -Recurse -Force }
Expand-Archive -Path $ZipPath -DestinationPath $TempDir -Force
$SourceDir = Get-ChildItem $TempDir -Directory | Where-Object { $_.Name -like 'jsw-multipost-*' } | Select-Object -First 1
if (-not $SourceDir) { throw 'Downloaded Amplr package did not contain the expected folder.' }
Copy-Item -Path $SourceDir.FullName -Destination $ExtDir -Recurse -Force

Write-Step 'Installing background runner...'
$RunnerContent = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$Chrome = '$Chrome'
`$ExtDir = '$ExtDir'
`$LogDir = '$LogDir'
New-Item -ItemType Directory -Force -Path `$LogDir | Out-Null
function Log(`$m) { Add-Content -Path (Join-Path `$LogDir 'runner.log') -Value ("[{0:u}] {1}" -f (Get-Date), `$m) }
Log 'Amplr runner started.'
while (`$true) {
  `$needle = '--load-extension=' + `$ExtDir
  `$running = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" | Where-Object { `$_.CommandLine -and `$_.CommandLine.Contains(`$needle) } | Select-Object -First 1
  if (-not `$running) {
    Log 'Chrome with Amplr is not running; starting Chrome.'
    Start-Process -FilePath `$Chrome -ArgumentList @('--profile-directory=Default', ('--load-extension=' + `$ExtDir), '--no-first-run', '--disable-features=Translate')
  }
  Start-Sleep -Seconds 30
}
"@
Set-Content -Path $Runner -Value $RunnerContent -Encoding UTF8

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Runner`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description 'Keeps Chrome running with Amplr loaded for scheduled posts.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Step 'Creating desktop shortcut...'
$Desktop = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $Desktop 'Open Amplr.lnk'
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Chrome
$Shortcut.Arguments = "--profile-directory=Default --load-extension=`"$ExtDir`" --no-first-run"
$Shortcut.WorkingDirectory = Split-Path $Chrome
$Shortcut.Description = 'Open Chrome with Amplr loaded'
$Shortcut.Save()

Write-Step 'Opening Chrome with Amplr loaded...'
Start-Process -FilePath $Chrome -ArgumentList @('--profile-directory=Default', ('--load-extension=' + $ExtDir), '--no-first-run')

Write-Host ''
Write-Host 'Amplr installed.' -ForegroundColor Green
Write-Host 'Next: pin/open the Amplr extension, sign into Amplr, and make sure Facebook is logged in.' -ForegroundColor White
Write-Host ''
Read-Host 'Press Enter to close'
