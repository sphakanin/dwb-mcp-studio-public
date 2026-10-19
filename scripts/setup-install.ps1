param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'setup-common.ps1')
. (Join-Path $PSScriptRoot 'external-common.ps1')
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ResultFile = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($RequestFile))) 'result.json'
$PhaseFile = Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($RequestFile))) 'phase.txt'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
function Set-Phase([string]$Value) { [IO.File]::WriteAllText($PhaseFile, $Value, $Utf8) }
$installLock=$null
$backups=@{}
$saving=$false
try {
  $dataDirectory=Get-DwbDataDirectory
  $null=New-Item -ItemType Directory -Path $dataDirectory -Force
  $installLock=[IO.File]::Open((Join-Path $dataDirectory 'setup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  Set-Phase 'checking'
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $machine = Get-DwbMachineState
  if (-not $machine.NodeReady -or -not $machine.NpmReady) { throw 'Install Node.js 22.16 or later with npm, then check again.' }
  if (-not [IO.Path]::IsPathRooted($request.workspace) -or -not (Test-Path -LiteralPath $request.workspace -PathType Container)) { throw 'Choose an existing workspace folder.' }
  $cap = [int]$request.workerCap
  if ($cap -lt 1 -or $cap -gt 64) { throw 'Choose between 1 and 64 workers.' }
  $env:Path = (Split-Path -Parent $machine.Node) + [IO.Path]::PathSeparator + $env:Path
  # The GUI selections are authoritative in this child process.
  foreach ($name in @('DWB_WORKER_ENTRY','DWB_WORKSPACE','DWB_WORKER_CAP','DWB_BASE_DC_CONFIG')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  Set-Phase 'migrating'
  Invoke-DwbNode $machine.Node @((Join-Path $PSScriptRoot 'upgrade.mjs'), 'migrate', (Get-DwbConfigPath)) $ProjectRoot | Write-Output
  Set-Phase 'external'
  Install-DwbExternal
  $worker=Get-DwbManagedWorkerState
  if (-not $worker.Ready) { throw $worker.Message }
  Set-Phase 'installing'
  $built = Test-Path -LiteralPath (Join-Path $ProjectRoot 'dist\index.js') -PathType Leaf
  $rebuild = -not $built -or (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\typescript\package.json')) -or ((Invoke-DwbNode $machine.Node @((Join-Path $PSScriptRoot 'upgrade.mjs'), 'needs-build') $ProjectRoot).Trim() -eq 'true')
  $dependenciesReady = $false
  try {
    $checkArgs = @($machine.Npm, 'ls', '--all', '--json')
    if (-not $rebuild) { $checkArgs += '--omit=dev' }
    $null = Invoke-DwbNode $machine.Node $checkArgs $ProjectRoot
    $dependenciesReady = $true
  } catch {}
  if (-not $dependenciesReady) {
    $installArgs = @($machine.Npm, 'ci', '--no-fund', '--no-audit')
    if (-not $rebuild) { $installArgs += '--omit=dev' }
    Invoke-DwbNode $machine.Node $installArgs $ProjectRoot | Write-Output
  }
  if ($rebuild) {
    Set-Phase 'building'
    Invoke-DwbNode $machine.Node @((Join-Path $PSScriptRoot 'build-companion.mjs')) $ProjectRoot | Write-Output
    Invoke-DwbNode $machine.Node @((Join-Path $ProjectRoot 'node_modules\typescript\bin\tsc'), '-p', (Join-Path $ProjectRoot 'tsconfig.json')) $ProjectRoot | Write-Output
  }
  Set-Phase 'runtime'
  . (Join-Path $PSScriptRoot 'runtime-upgrade.ps1')
  Stop-DwbRuntimeForSetup $machine.Node
  foreach ($file in @((Get-DwbConfigPath), (Join-Path (Split-Path -Parent (Get-DwbConfigPath)) 'mcp-client.json'))) {
    if (Test-Path -LiteralPath $file) { $backups[$file]=[IO.File]::ReadAllBytes($file) } else { $backups[$file]=$null }
  }
  $saving=$true
  Set-Phase 'saving'
  Invoke-DwbNode $machine.Node @((Join-Path $PSScriptRoot 'configure.mjs'), '--worker-entry', $worker.Entry, '--workspace', [IO.Path]::GetFullPath($request.workspace), '--worker-cap', [string]$cap) $ProjectRoot | Write-Output
  Set-Phase 'verifying'
  $doctorText = Invoke-DwbNode $machine.Node @((Join-Path $PSScriptRoot 'doctor.mjs')) $ProjectRoot
  $doctor = $doctorText | ConvertFrom-Json
  if (-not $doctor.ok) { throw 'The configuration check did not pass.' }
  Invoke-DwbNode $machine.Node @((Join-Path $PSScriptRoot 'upgrade.mjs'), 'mark') $ProjectRoot | Write-Output
  $result = @{ ok = $true; configFile = $doctor.configFile; clientConfig = (Join-Path (Split-Path -Parent $doctor.configFile) 'mcp-client.json'); workerCap = $cap }
  [IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Depth 5), $Utf8)
  . (Join-Path $PSScriptRoot 'preferences-common.ps1')
  if((Get-DwbPreferences).startWithWindows){Set-DwbWindowsStartup $true}
  Set-Phase 'complete'
} catch {
  if ($saving) {
    foreach ($file in $backups.Keys) {
      if ($null -ne $backups[$file]) { [IO.File]::WriteAllBytes($file,$backups[$file]) }
      elseif (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
  }
  $result = @{ ok = $false; message = $_.Exception.Message }
  [IO.File]::WriteAllText($ResultFile, ($result | ConvertTo-Json -Depth 5), $Utf8)
  Set-Phase 'failed'
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($installLock) { $installLock.Dispose() }
}
