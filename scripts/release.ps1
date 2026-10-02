param([string]$OutputDirectory, [switch]$Source)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ReleaseRoot = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $ProjectRoot 'releases' }
$Package = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
$Flavor = if ($Source) { "source-test" } else { "windows" }
$Name = "dwb-mcp-studio-core-$($Package.version)-$Flavor"
$Zip = Join-Path $ReleaseRoot ($Name + '.zip')
if (Test-Path -LiteralPath $Zip) { throw "Release already exists: $Zip. Rename it or choose a new version before rebuilding." }
& node (Join-Path $PSScriptRoot 'distribution-check.mjs')
if ($LASTEXITCODE -ne 0) { throw 'DWB distribution boundary check failed.' }
$Manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'distribution-files.json') -Raw | ConvertFrom-Json
$Stage = Join-Path $ReleaseRoot ($Name + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $Stage -Force | Out-Null
# Copy only reviewed files, including inside src/scripts/docs/assets.
$Files = @($Manifest.files) + @('DWB MCP Studio.exe')
foreach ($File in $Files) {
  if (-not $Source -and $File.StartsWith('.github/')) { continue }
  $Destination = Join-Path $Stage $File
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Destination)) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $File) -Destination $Destination
}
if (-not $Source) {
$Dist = Join-Path $Stage 'dist'
New-Item -ItemType Directory -Path $Dist | Out-Null
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'dist') -File -Filter '*.js' |
  Where-Object { $_.Name -notlike '*-test.js' -and $_.Name -ne 'test-policy.js' } |
  Copy-Item -Destination $Dist
}
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip -CompressionLevel Optimal
$Hasher = [System.Security.Cryptography.SHA256]::Create()
$ArchiveStream = [IO.File]::OpenRead($Zip)
try { $Hash = ([BitConverter]::ToString($Hasher.ComputeHash($ArchiveStream))).Replace('-','').ToLowerInvariant() }
finally { $ArchiveStream.Dispose(); $Hasher.Dispose() }
Set-Content -LiteralPath ($Zip + '.sha256') -Value "$Hash  $Name.zip" -Encoding ascii
Write-Output "Release: $Zip"
Write-Output "SHA256: $Hash"
