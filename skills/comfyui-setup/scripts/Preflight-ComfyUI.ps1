# DWB ComfyUI setup preflight. Read-only; no software changes or model downloads.
# Supports Windows PowerShell 5.1 and PowerShell 7+ on Windows.
[CmdletBinding()]
param(
  [string] $ApiUrl = 'http://127.0.0.1:8188',
  [string] $WorkspaceRoot = '.',
  [string] $ExistingPath = '',
  [switch] $SkipApi,
  [switch] $SkipGpu
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function LocalApiBase([string]$value) {
  $url = $null
  if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$url)) {
    throw 'API URL must be an absolute loopback HTTP URL.'
  }
  if ($url.Scheme -ne 'http' -or
      $url.Host -notin @('localhost','127.0.0.1','::1','[::1]') -or
      $url.UserInfo -or $url.Query -or $url.Fragment -or
      $url.AbsolutePath -ne '/') {
    throw 'Only http://127.0.0.1:<port> or localhost loopback API roots are permitted.'
  }
  return $url.GetLeftPart([UriPartial]::Authority)
}
function AvailableCommand([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}
function SafeGiB($bytes) {
  if ($null -eq $bytes) { return $null }
  return [Math]::Round(([double]$bytes / 1GB), 1)
}
if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
  throw 'This preflight currently supports Windows only. Use the official Desktop instructions for other OSs.'
}
$apiBase = LocalApiBase $ApiUrl
$root = [IO.Path]::GetFullPath($WorkspaceRoot)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
  throw 'WorkspaceRoot must be an existing local directory.'
}
$existing = $null
if ($ExistingPath) {
  $candidate = [IO.Path]::GetFullPath($ExistingPath)
  $existing = @{
    path = $candidate
    exists = [bool](Test-Path -LiteralPath $candidate -PathType Container)
    comfyMain = [bool](Test-Path -LiteralPath (Join-Path $candidate 'ComfyUI\main.py') -PathType Leaf)
    portableLauncher = [bool](Test-Path -LiteralPath (Join-Path $candidate 'run_nvidia_gpu.bat') -PathType Leaf)
  }
}
$os = Get-CimInstance Win32_OperatingSystem
$machine = Get-CimInstance Win32_ComputerSystem
$displayNames = @(Get-CimInstance Win32_VideoController |
  ForEach-Object { [string]$_.Name } | Where-Object { $_ })
$warnings = New-Object System.Collections.Generic.List[string]
$gpu = @()
$gpuProbe = 'skipped'
if (-not $SkipGpu) {
  if (AvailableCommand 'nvidia-smi.exe') {
    try {
      $raw = @(& nvidia-smi.exe --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>&1)
      if ($LASTEXITCODE -ne 0) { throw ('nvidia-smi failed with exit ' + $LASTEXITCODE) }
      foreach ($line in $raw) {
        $parts = ([string]$line).Split(',')
        if ($parts.Length -lt 3) { throw 'Unexpected nvidia-smi CSV format.' }
        $gpu += @{
          name = $parts[0].Trim()
          vramMiB = [int]($parts[1].Trim())
          driverVersion = $parts[2].Trim()
        }
      }
      $gpuProbe = 'available'
    } catch {
      $gpuProbe = 'error'
      $warnings.Add('NVIDIA diagnostics failed: ' + $_.Exception.Message)
    }
  } else {
    $gpuProbe = 'unavailable'
    $warnings.Add('nvidia-smi was not found. GPU and driver compatibility require manual review.')
  }
}
$freeGiB = $null
try {
  $driveRoot = [IO.Path]::GetPathRoot($root)
  $drive = New-Object System.IO.DriveInfo($driveRoot)
  if ($drive.IsReady) { $freeGiB = SafeGiB $drive.AvailableFreeSpace }
} catch {
  $warnings.Add('Could not check free disk space for selected workspace.')
}
$comfy = @{
  apiBase = $apiBase
  reachable = $false
  version = $null
  python = $null
  pytorch = $null
  devices = @()
  runningCount = $null
  pendingCount = $null
  error = $null
}
if (-not $SkipApi) {
  try {
    $stats = Invoke-RestMethod -Uri ($apiBase + '/system_stats') -Method Get -TimeoutSec 4
    $comfy.reachable = $true
    $comfy.version = [string]$stats.system.comfyui_version
    $comfy.python = [string]$stats.system.python_version
    $comfy.pytorch = [string]$stats.system.pytorch_version
    $comfy.devices = @($stats.devices | ForEach-Object {
      @{ name = [string]$_.name; vramTotalGiB = SafeGiB $_.vram_total }
    })
    try {
      $queue = Invoke-RestMethod -Uri ($apiBase + '/queue') -Method Get -TimeoutSec 4
      # Deliberately return COUNTS ONLY. Queue contents can contain private prompts.
      $comfy.runningCount = @($queue.queue_running | Where-Object { $null -ne $_ }).Count
      $comfy.pendingCount = @($queue.queue_pending | Where-Object { $null -ne $_ }).Count
    } catch {
      $warnings.Add('ComfyUI is reachable, but queue counts could not be retrieved.')
    }
  } catch {
    $comfy.error = 'No valid ComfyUI system_stats response on the selected loopback port.'
  }
}
$guidance = New-Object System.Collections.Generic.List[string]
$recommended = 'review_hardware'
if ($comfy.reachable) {
  $recommended = 'reuse_existing_install'
  $guidance.Add('ComfyUI already responds locally; do NOT reinstall, upgrade, restart or clear its queue.')
  if ($comfy.runningCount -gt 0 -or $comfy.pendingCount -gt 0) {
    $guidance.Add('The current ComfyUI queue contains jobs. Do not interrupt or replace this process.')
  }
} elseif ($gpu.Count -gt 0) {
  $recommended = 'desktop_assisted_or_isolated_portable'
  $guidance.Add('Official ComfyUI Desktop is the default beginner path; portable is optional for isolated automation.')
} else {
  $guidance.Add('Hardware backend compatibility is unknown. Do not assume NVIDIA or install CUDA blindly.')
}
if ($gpu.Count -gt 0 -and $gpu[0].vramMiB -le 8500) {
  $guidance.Add('Approximately 8 GB VRAM: choose smaller image/video models, smaller frames or CPU offload; no resolution guarantee.')
}
if ($null -ne $freeGiB -and $freeGiB -lt 25) {
  $warnings.Add('Less than 25 GiB is available on the selected workspace drive. Large models/installers may not fit.')
}
$report = [ordered]@{
  kind = 'dwb-comfyui-preflight-v1'
  timeUtc = [DateTime]::UtcNow.ToString('o')
  operatingSystem = @{ name = [string]$os.Caption; version = [string]$os.Version; architecture = [string]$os.OSArchitecture }
  memoryGiB = SafeGiB $machine.TotalPhysicalMemory
  displayAdapters = $displayNames
  nvidia = @{ probe = $gpuProbe; devices = @($gpu) }
  workspace = @{ path = $root; freeGiB = $freeGiB }
  tools = @{ git = (AvailableCommand 'git.exe'); python = (AvailableCommand 'python.exe'); uv = (AvailableCommand 'uv.exe'); tar = (AvailableCommand 'tar.exe'); sevenZip = (AvailableCommand '7z.exe') }
  existingPath = $existing
  comfyui = $comfy
  recommendedNextStep = $recommended
  guidance = @($guidance)
  warnings = @($warnings)
  changesMade = $false
}
$report | ConvertTo-Json -Depth 8
