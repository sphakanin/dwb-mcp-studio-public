param([Parameter(Mandatory=$true)][string]$Zip,[string[]]$PreviousZip=@())
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('dwb-release-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
$current=Join-Path $testRoot 'downloaded release'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Zip))
try {
  foreach($entry in $archive.Entries){
    if($entry.FullName -match '(^|/)(node_modules|external|runtime|logs|data|\.git|experiments|brag-output[^/]*)/|(^|/)\.env($|\.)|\.(dpapi|key|pem|pfx|p12|safetensors|ckpt|pt|pth|onnx|ipynb|jsonl|mp4|mp3|wav)$|RECORDING-SKILLS-TH\.md$|(^|/)(config|mcp-client)\.json$'){throw ('Private/unrelated file in archive: '+$entry.FullName)}
    if($entry.FullName -match '\.exe$' -and $entry.FullName -ne 'DWB MCP Studio.exe'){throw ('Foreign executable in archive: '+$entry.FullName)}
  }
}finally{$archive.Dispose()}
Expand-Archive -LiteralPath $Zip -DestinationPath $current
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $current 'scripts\setup-test.ps1')
if($LASTEXITCODE -ne 0){throw 'Downloaded release fresh Setup test failed.'}
foreach($oldZip in $PreviousZip){
  $old=Join-Path $testRoot ([IO.Path]::GetFileNameWithoutExtension($oldZip))
  Expand-Archive -LiteralPath $oldZip -DestinationPath $old
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $current 'scripts\setup-test.ps1') -PreviousSource $old
  if($LASTEXITCODE -ne 0){throw ('Upgrade from archive failed: '+$oldZip)}
  Write-Output ('LEGACY_ZIP_UPGRADE_PASS: '+[IO.Path]::GetFileName($oldZip))
}
Write-Output ('RELEASE_ZIP_PASS: '+(Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant())
Write-Output ('Evidence: '+$testRoot)
