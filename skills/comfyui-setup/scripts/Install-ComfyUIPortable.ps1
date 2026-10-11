# Windows NVIDIA Portable installer for the DWB ComfyUI setup skill.
# PLAN: read-only metadata + disk check. APPLY: explicit approval, pinned SHA, new folder only.
[CmdletBinding()]
param(
  [ValidateSet('Plan','Apply')][string]$Action = 'Plan',
  [Parameter(Mandatory=$true)][string]$WorkspaceRoot,
  [string]$InstallFolder = 'ComfyUI_windows_portable',
  [ValidateSet('NvidiaCurrent','NvidiaLegacy')][string]$Variant = 'NvidiaCurrent',
  [string]$ReleaseTag = '',
  [string]$ApprovedSha256 = '',
  [string]$OfflineArchive = '',
  [switch]$UserApproved
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
  throw 'Windows portable installation is supported on Windows only.'
}
function Fail([string]$message) { throw ('DWB_COMFYUI_SETUP: ' + $message) }
function Json($obj) { $obj | ConvertTo-Json -Depth 8 }
if ($InstallFolder -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$' -or
    ($InstallFolder -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)' -or $InstallFolder.EndsWith('.'))) {
  Fail 'InstallFolder must be a safe single folder name (no path separators or reserved names).'
}
$root = [IO.Path]::GetFullPath($WorkspaceRoot)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
  Fail 'WorkspaceRoot must already exist and be selected as the ACTIVE DWB workspace.'
}
$root = (Resolve-Path -LiteralPath $root).ProviderPath
if ($root.TrimEnd('\') -eq [IO.Path]::GetPathRoot($root).TrimEnd('\') -or
    $root.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) {
  Fail 'Select a dedicated project workspace, not a drive root or user profile.'
}
if ((Test-Path -LiteralPath (Join-Path $root 'src\broker-server.ts')) -and
    (Test-Path -LiteralPath (Join-Path $root 'web\companion.html'))) {
  Fail 'Do not install ComfyUI inside the DWB source repository. Select a separate demo workspace in a new chat.'
}
$destination = Join-Path $root $InstallFolder
if (Test-Path -LiteralPath $destination) {
  Fail 'Install destination already exists. Choose a NEW folder; existing installations are never overwritten.'
}
$assetName = switch ($Variant) {
  'NvidiaLegacy' { 'ComfyUI_windows_portable_nvidia_cu126.7z' }
  default { 'ComfyUI_windows_portable_nvidia.7z' }
}
$metadata = $null
$source = 'official_github'
$archiveFile = $null
$expectedSha = $null
$archiveSize = 0L
$assetUrl = $null
$resolvedTag = $ReleaseTag
if ($OfflineArchive) {
  $source = 'user_supplied_archive'
  $archiveFile = [IO.Path]::GetFullPath($OfflineArchive)
  if (-not (Test-Path -LiteralPath $archiveFile -PathType Leaf)) {
    Fail 'OfflineArchive does not exist. No files have been changed.'
  }
  $expectedSha = (Get-FileHash -LiteralPath $archiveFile -Algorithm SHA256).Hash.ToLowerInvariant()
  $archiveSize = (Get-Item -LiteralPath $archiveFile).Length
  $assetName = [IO.Path]::GetFileName($archiveFile)
  if (-not $resolvedTag) { $resolvedTag = 'offline-user-supplied' }
} else {
  if ($Action -eq 'Apply' -and -not $ReleaseTag) {
    Fail 'Apply requires a pinned ReleaseTag from the approved Plan, not an unpinned latest release.'
  }
  $api = if ($ReleaseTag) {
    'https://api.github.com/repos/comfyanonymous/ComfyUI/releases/tags/' +
      [Uri]::EscapeDataString($ReleaseTag)
  } else {
    'https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest'
  }
  try {
    $metadata = Invoke-RestMethod -Method Get -Uri $api -TimeoutSec 25 -Headers @{
      'User-Agent' = 'DWB-ComfyUI-Setup'
      'Accept' = 'application/vnd.github+json'
      'X-GitHub-Api-Version' = '2022-11-28'
    }
  } catch { Fail ('Could not inspect official GitHub release metadata: ' + $_.Exception.Message) }
  $resolvedTag = [string]$metadata.tag_name
  $asset = @($metadata.assets | Where-Object { $_.name -eq $assetName })
  if ($asset.Count -ne 1) { Fail ('Expected official asset not found: ' + $assetName) }
  $asset = $asset[0]
  $digestText = [string]$asset.digest
  if ($digestText -match '^sha256:([a-fA-F0-9]{64})$') {
    $expectedSha = $Matches[1].ToLowerInvariant()
  } else {
    Fail 'Official release does not provide a trusted SHA-256 digest; stop instead of installing unverified bytes.'
  }
  $assetUrl = [string]$asset.browser_download_url
  $u = $null
  if (-not [Uri]::TryCreate($assetUrl, [UriKind]::Absolute, [ref]$u) -or
      $u.Scheme -ne 'https' -or $u.Host -ne 'github.com' -or
      $u.AbsolutePath -notmatch '^/(comfyanonymous|Comfy-Org)/ComfyUI/releases/download/') {
    Fail 'Release asset URL is not an official GitHub ComfyUI asset.'
  }
  $archiveSize = [long]$asset.size
}
$driveFree = $null
try {
  $drive = New-Object System.IO.DriveInfo([IO.Path]::GetPathRoot($root))
  if ($drive.IsReady) { $driveFree = [long]$drive.AvailableFreeSpace }
} catch { Fail 'Cannot measure free space for selected install directory.' }
$requiredBytes = [long]([Math]::Max(12GB, ($archiveSize * 3 + 5GB)))
$plan = [ordered]@{
  kind = 'dwb-comfyui-install-plan-v1'
  action = $Action
  source = $source
  releaseTag = $resolvedTag
  variant = $Variant
  assetName = $assetName
  sha256 = $expectedSha
  sizeMiB = [math]::Round(($archiveSize / 1MB), 1)
  destination = $destination
  availableGiB = [math]::Round(($driveFree / 1GB), 1)
  estimatedRequiredGiB = [math]::Round(($requiredBytes / 1GB), 1)
  downloadUrl = $assetUrl
  changesMade = $false
  safety = @(
    'Does not modify existing ComfyUI installations, global Python, Torch, CUDA, drivers, PATH or firewall.',
    'Does not start ComfyUI automatically or select the occupied 8188 port.',
    'Apply requires explicit approval and an exact SHA-256 from this plan.'
  )
}
if ($Action -eq 'Plan') {
  Json $plan
  return
}
if (-not $UserApproved) { Fail 'Apply requires explicit -UserApproved after the user reviews Plan.' }
if ($ApprovedSha256 -notmatch '^[a-fA-F0-9]{64}$') {
  Fail 'Apply requires the 64-character SHA-256 from the approved Plan.'
}
if ($ApprovedSha256.ToLowerInvariant() -ne $expectedSha) {
  Fail 'Expected SHA-256 differs from the approved Plan. Restart Plan and ask for approval.'
}
if ($driveFree -lt $requiredBytes) {
  Fail 'Insufficient disk space for safe staging + extraction. Choose another workspace drive.'
}
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  Fail 'tar.exe is required for extraction. Install a trusted extractor separately with approval.'
}
# New target, unique staging, and only script-created staging is eligible for cleanup.
$stage = Join-Path $root ('.dwb-comfyui-install-' + [Guid]::NewGuid().ToString('N'))
$archive = Join-Path $stage $assetName
$payload = Join-Path $stage 'payload'
$stageCreated = $false
try {
  if (Test-Path -LiteralPath $destination) { Fail 'Destination appeared after Plan. Aborting.' }
  New-Item -Path $stage -ItemType Directory -ErrorAction Stop | Out-Null
  $stageCreated = $true
  New-Item -Path $payload -ItemType Directory | Out-Null
  if ($OfflineArchive) {
    Copy-Item -LiteralPath $archiveFile -Destination $archive -ErrorAction Stop
  } else {
    Invoke-WebRequest -Uri $assetUrl -UseBasicParsing -TimeoutSec 3600 -OutFile $archive -ErrorAction Stop
  }
  $downloadedHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadedHash -ne $expectedSha) { Fail 'Archive SHA-256 mismatch; installation stopped.' }
  $entries = @(& tar.exe -tf $archive 2>&1)
  if ($LASTEXITCODE -ne 0 -or $entries.Count -eq 0) { Fail 'Cannot read archive using tar.exe.' }
  foreach ($entry in $entries) {
    $normalized = ([string]$entry).Replace('\','/').Trim()
    if ($normalized.StartsWith('/') -or $normalized -match ':' -or
        $normalized -match '(^|/)\.\.(/|$)' -or $normalized -match '(^|/)\.(/|$)' -or
        $normalized -match '[\x00-\x1F]') {
      Fail 'Archive contains an unsafe path; extraction blocked.'
    }
  }
  # Refuse archive links. In addition to blocking traversal paths, this prevents links
  # from redirecting the extractor outside the approved staging directory.
  $verboseEntries = @(& tar.exe -tvf $archive 2>&1)
  if ($LASTEXITCODE -ne 0) { Fail 'Could not inspect archive entry types.' }
  foreach ($verboseEntry in $verboseEntries) {
    if (([string]$verboseEntry) -match '^[lh]') { Fail 'Symbolic or hard link entries are not allowed.' }
  }
  & tar.exe -xf $archive -C $payload
  if ($LASTEXITCODE -ne 0) { Fail 'Archive extraction failed.' }
  $candidates = @($payload) + @(Get-ChildItem -LiteralPath $payload -Directory | ForEach-Object { $_.FullName })
  $installRoots = @($candidates | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_ 'run_nvidia_gpu.bat') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $_ 'ComfyUI\main.py') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $_ 'python_embeded\python.exe') -PathType Leaf)
  })
  if ($installRoots.Count -ne 1) { Fail 'Extracted files do not match the expected ComfyUI portable layout.' }
  if (Test-Path -LiteralPath $destination) { Fail 'Install destination was created by another process.' }
  Move-Item -LiteralPath $installRoots[0] -Destination $destination -ErrorAction Stop
  $manifest = @{
    source = $source
    releaseTag = $resolvedTag
    variant = $Variant
    assetName = $assetName
    verifiedSha256 = $downloadedHash
    installedUtc = [DateTime]::UtcNow.ToString('o')
    autoStarted = $false
  }
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination '.dwb-install-manifest.json') -Encoding UTF8
  [ordered]@{
    kind = 'dwb-comfyui-install-result-v1'
    status = 'installed_not_started'
    destination = $destination
    sha256Verified = $true
    changedExistingEnvironment = $false
    startAutomatically = $false
    nextStep = 'Verify the new install with its embedded Python. Start it only after selecting an unused localhost port.'
  } | ConvertTo-Json -Depth 5
} finally {
  if ($stageCreated -and (Test-Path -LiteralPath $stage)) {
    # Remove ONLY the uniquely named temporary folder created by this invocation.
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
