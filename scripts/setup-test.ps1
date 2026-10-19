param([string]$PreviousSource)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'setup-common.ps1')
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$TestRoot = Join-Path $ProjectRoot ('logs\setup-ui-test-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$InstallRoot = Join-Path $TestRoot 'app with spaces & symbols'
$WorkerRoot = Join-Path $InstallRoot 'external\desktop-commander\node_modules\@wonderwhy-er\desktop-commander'
$Workspace = Join-Path $TestRoot 'workspace'
$Utf8 = New-Object Text.UTF8Encoding($false)
function Assert([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
Assert (Test-DwbNodeVersion 'v22.16.0') 'Minimum Node version should pass.'
Assert (Test-DwbNodeVersion 'v24.11.1') 'Newer Node version should pass.'
Assert (-not (Test-DwbNodeVersion 'v22.15.0')) 'Older Node version must fail.'
Assert (-not (Test-DwbNodeVersion '')) 'Missing Node version must fail.'
Assert (-not (Get-DwbWorkerState 'missing.js').Ready) 'Missing worker must fail.'
foreach ($directory in @($InstallRoot, (Join-Path $WorkerRoot 'dist'), $Workspace)) { $null = New-Item -ItemType Directory -Path $directory -Force }
$firstSource=if($PreviousSource){[IO.Path]::GetFullPath($PreviousSource)}else{$ProjectRoot}
$firstBuilt=Test-Path -LiteralPath (Join-Path $firstSource 'dist\index.js')
$firstFolders=@('scripts','assets','docs')+$(if($firstBuilt){@('dist')}else{@('src','web')})
foreach ($directory in $firstFolders) { Copy-Item -LiteralPath (Join-Path $firstSource $directory) -Destination $InstallRoot -Recurse }
if(-not $firstBuilt){foreach($file in @('tsconfig.json','tsconfig.companion.json')){Copy-Item -LiteralPath (Join-Path $firstSource $file) -Destination $InstallRoot}}
foreach ($file in @('package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $firstSource $file) -Destination $InstallRoot }
$tunnelRoot=Join-Path $InstallRoot 'external\tunnel-client'
$null=New-Item -ItemType Directory -Path $tunnelRoot -Force
Add-Type -TypeDefinition 'using System; class VersionFixture { public static void Main() { Console.WriteLine("0.0.11"); } }' -OutputAssembly (Join-Path $tunnelRoot 'tunnel-client.exe') -OutputType ConsoleApplication
# Own setup fixture: validation does not start an MCP worker.
[IO.File]::WriteAllText((Join-Path $WorkerRoot 'package.json'), '{"name":"@wonderwhy-er/desktop-commander","version":"0.2.50","type":"module"}', $Utf8)
[IO.File]::WriteAllText((Join-Path $WorkerRoot 'dist\index.js'), '// DWB setup test fixture', $Utf8)
[IO.File]::WriteAllText((Join-Path $WorkerRoot 'dist\config.js'), 'export const USER_HOME = os.homedir();', $Utf8)
$machine = Get-DwbMachineState
Assert $machine.NodeReady 'Node is required for the GUI integration test.'
$roundTrip = @('space value','ampersand & value','quote"value','trailing\')
$echoScript = Join-Path $TestRoot 'echo.mjs'
[IO.File]::WriteAllText($echoScript, 'console.log(JSON.stringify(process.argv.slice(2)));', $Utf8)
$actual = (Invoke-DwbNode $machine.Node (@($echoScript) + $roundTrip) $TestRoot) | ConvertFrom-Json
Assert (($actual -join '|') -ceq ($roundTrip -join '|')) 'Native argument quoting did not round-trip.'
$oldDataDir = $env:DWB_DATA_DIR
$oldConfigFile = $env:DWB_CONFIG_FILE
try {
  $env:DWB_DATA_DIR = Join-Path $TestRoot 'user data'
  $env:DWB_CONFIG_FILE = Join-Path $env:DWB_DATA_DIR 'config.json'
  $requestFile = Join-Path $TestRoot 'request.json'
  $request = @{ workerEntry=(Join-Path $WorkerRoot 'dist\index.js'); workspace=$Workspace; workerCap=3 }
  [IO.File]::WriteAllText($requestFile, ($request | ConvertTo-Json), $Utf8)
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'scripts\setup.ps1') -TestRequestFile $requestFile -PreviewPath (Join-Path $TestRoot 'setup-success.png')
  Assert ($LASTEXITCODE -eq 0) 'GUI installation failed.'
  if(Test-Path -LiteralPath (Join-Path $firstSource 'assets\licenses\companion-THIRD-PARTY-NOTICES.txt')){
    $panel=Join-Path $InstallRoot 'dist\companion-panel.html'
    Assert (Test-Path -LiteralPath $panel) 'Setup must build the Companion HTML from source.'
    Assert (([IO.File]::ReadAllText($panel)).Contains('dwb-third-party-notices')) 'Installed Companion must retain bundled notices.'
  }
  $saved = Get-Content -LiteralPath $env:DWB_CONFIG_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert ($saved.workerEntry -eq $request.workerEntry) 'Wrong worker saved.'
  Assert ($saved.workspace -eq $Workspace) 'Wrong workspace saved.'
  Assert ($saved.workerCap -eq 3) 'Wrong cap saved.'
  Assert (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules\@wonderwhy-er\desktop-commander'))) 'Setup must not install Desktop Commander.'
  Assert ((Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules\typescript')) -eq (-not $firstBuilt)) 'Source installs build tools; built releases install production dependencies only.'
  Assert (([IO.File]::ReadAllText((Join-Path $WorkerRoot 'dist\config.js'))) -eq 'export const USER_HOME = os.homedir();') 'External fixture changed.'
  # Simulate extracting the next release on the same Windows account.
  $nextRoot=Join-Path $TestRoot 'next release'
  $null=New-Item -ItemType Directory -Path $nextRoot
  $nextBuilt=Test-Path -LiteralPath (Join-Path $ProjectRoot 'dist\index.js')
  $nextFolders=@('scripts','assets','docs')+$(if($nextBuilt){@('dist')}else{@('src','web')})
  foreach ($directory in $nextFolders) { Copy-Item -LiteralPath (Join-Path $ProjectRoot $directory) -Destination $nextRoot -Recurse }
  if(-not $nextBuilt){foreach($file in @('tsconfig.json','tsconfig.companion.json')){Copy-Item -LiteralPath (Join-Path $ProjectRoot $file) -Destination $nextRoot}}
  foreach ($file in @('package.json','package-lock.json')) { Copy-Item -LiteralPath (Join-Path $ProjectRoot $file) -Destination $nextRoot }
  $sentinel=Join-Path $InstallRoot 'node_modules\dwb-reuse-proof.txt'
  [IO.File]::WriteAllText($sentinel,'must survive migration without npm ci',$Utf8)
  $tunnelData=Join-Path $env:DWB_DATA_DIR 'tunnel'
  $null=New-Item -ItemType Directory -Path $tunnelData -Force
  $keyFile=Join-Path $tunnelData 'key.dpapi'
  [IO.File]::WriteAllText($keyFile,('upgrade-fixture-key' | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString),$Utf8)
  $settingsFile=Join-Path $tunnelData 'settings.json'
  [IO.File]::WriteAllText($settingsFile,'{"tunnelId":"tunnel_upgrade_fixture","rememberKey":true}',$Utf8)
  $workspaceDb=Join-Path $env:DWB_DATA_DIR 'workspace-preservation-fixture.db'
  [IO.File]::WriteAllBytes($workspaceDb,[byte[]](1,2,3,4))
  $customPolicy=Join-Path $env:DWB_DATA_DIR 'custom-policy.json'
  Copy-Item -LiteralPath $saved.basePolicy -Destination $customPolicy
  $saved.basePolicy=$customPolicy
  $saved | Add-Member -NotePropertyName customOption -NotePropertyValue 'preserve me'
  [IO.File]::WriteAllText($env:DWB_CONFIG_FILE,($saved | ConvertTo-Json),$Utf8)
  $preferencesFile=Join-Path $env:DWB_DATA_DIR 'preferences.json'
  [IO.File]::WriteAllText($preferencesFile,'{"startWithWindows":false,"connectOnStartup":false,"closeAction":"exit","minimizeToTray":false}',$Utf8)
  $preserved=@{}
  foreach ($file in @($keyFile,$settingsFile,$workspaceDb,$customPolicy,$preferencesFile)) { $preserved[$file]=(Get-FileHash -LiteralPath $file).Hash }
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $nextRoot 'scripts\setup.ps1') -TestRequestFile $requestFile -PreviewPath (Join-Path $TestRoot 'upgrade-success.png')
  Assert ($LASTEXITCODE -eq 0) 'Upgrade GUI failed.'
  Assert (([IO.File]::ReadAllText((Join-Path $nextRoot 'dist\companion-panel.html'))).Contains('dwb-third-party-notices')) 'Upgraded Companion must retain bundled notices.'
  foreach ($file in $preserved.Keys) { Assert ((Get-FileHash -LiteralPath $file).Hash -eq $preserved[$file]) 'Saved user data changed during upgrade.' }
  $upgraded=Get-Content -LiteralPath $env:DWB_CONFIG_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert ($upgraded.workerEntry.StartsWith($nextRoot)) 'Worker path was not migrated.'
  Assert ($upgraded.workspace -eq $Workspace -and $upgraded.workerCap -eq 3) 'Workspace/cap changed.'
  Assert ($upgraded.basePolicy -eq $customPolicy -and $upgraded.customOption -eq 'preserve me') 'Custom configuration was lost.'
  Assert (Test-Path -LiteralPath (Join-Path $nextRoot 'node_modules\dwb-reuse-proof.txt')) 'npm ci ran instead of reusing dependencies.'
  Assert (Test-Path -LiteralPath $sentinel) 'Old installation was modified.'
  $client=Get-Content -LiteralPath (Join-Path $env:DWB_DATA_DIR 'mcp-client.json') -Raw | ConvertFrom-Json
  Assert ($client.mcpServers.'dwb-core'.args[0].StartsWith($nextRoot)) 'Client launcher still points to old installation.'
  # Force final verification to fail after configure, and check byte-for-byte rollback.
  $beforeFailure=@{}
  foreach ($file in @($env:DWB_CONFIG_FILE,(Join-Path $env:DWB_DATA_DIR 'mcp-client.json'))) { $beforeFailure[$file]=(Get-FileHash -LiteralPath $file).Hash }
  [IO.File]::WriteAllText((Join-Path $nextRoot 'scripts\doctor.mjs'),'console.log(JSON.stringify({ok:false}));',$Utf8)
  $failureDir=Join-Path $TestRoot 'failure'
  $null=New-Item -ItemType Directory -Path $failureDir
  $failureRequest=Join-Path $failureDir 'request.json'
  [IO.File]::WriteAllText($failureRequest,(@{workspace=$Workspace;workerCap=7} | ConvertTo-Json),$Utf8)
  $failureArguments='-NoProfile -ExecutionPolicy Bypass -File ' + (ConvertTo-DwbArgument (Join-Path $nextRoot 'scripts\setup-install.ps1')) + ' -RequestFile ' + (ConvertTo-DwbArgument $failureRequest)
  $failureProcess=Start-Process powershell.exe -ArgumentList $failureArguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $failureDir 'stdout.log') -RedirectStandardError (Join-Path $failureDir 'stderr.log')
  Assert ($failureProcess.ExitCode -eq 1) 'Verification failure should fail setup.'
  foreach ($file in $beforeFailure.Keys) { Assert ((Get-FileHash -LiteralPath $file).Hash -eq $beforeFailure[$file]) 'Configuration rollback failed.' }
  Write-Output 'UPGRADE_ROLLBACK_PASS: failed final verification restored both configuration files.'
  Write-Output 'UPGRADE_GUI_PASS: reused dependencies, no npm ci, old installation retained, saved key/tunnel/workspace/policy preserved, paths updated.'
  Write-Output 'SETUP_TEST_PASS: requirements, safe arguments, GUI save flow, production install, independent worker, generated config.'
  Write-Output "Preview: $(Join-Path $TestRoot 'setup-success.png')"
} finally {
  $env:DWB_DATA_DIR = $oldDataDir
  $env:DWB_CONFIG_FILE = $oldConfigFile
}
