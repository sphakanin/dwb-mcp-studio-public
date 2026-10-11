# Launch a separately installed Windows ComfyUI Portable instance.
# Inspect is READ-ONLY. Launch changes only child-directory state and starts a new process.
[CmdletBinding()]
param(
  [ValidateSet('Inspect', 'Launch')][string]$Action = 'Inspect',
  [Parameter(Mandatory=$true)][string]$InstallPath,
  [ValidateRange(1024,65535)][int]$Port = 8189,
  [switch]$UserApproved
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Fail([string]$message) { throw ('DWB_COMFYUI_ISOLATED: ' + $message) }
function GiB([double]$bytes) { [math]::Round($bytes / 1GB, 2) }
if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
  Fail 'This launcher supports Windows only.'
}
if (-not (Test-Path -LiteralPath $InstallPath -PathType Container)) {
  Fail 'The approved Portable installation directory does not exist.'
}
$install = (Resolve-Path -LiteralPath $InstallPath).ProviderPath
if ($Port -eq 8188) { Fail 'Port 8188 is reserved for the existing ComfyUI instance. Choose port 8189 or another unused port.' }
$manifestFile = Join-Path $install '.dwb-install-manifest.json'
if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) {
  Fail 'DWB install manifest is required. Refusing to run an unrecognized installation.'
}
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if ($manifest.autoStarted -ne $false -or $manifest.verifiedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
  Fail 'Install manifest is invalid.'
}
$python = Join-Path $install 'python_embeded\python.exe'
$main = Join-Path $install 'ComfyUI\main.py'
$bat = Join-Path $install 'run_nvidia_gpu.bat'
foreach($required in @($python,$main,$bat)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    Fail ('Portable runtime is incomplete: ' + [IO.Path]::GetFileName($required))
  }
}
$instanceHome = Join-Path $install 'instance-data'
$cacheRoot = Join-Path $instanceHome 'cache'
$paths = [ordered]@{
  base = $instanceHome
  user = Join-Path $instanceHome 'user'
  models = Join-Path $instanceHome 'models'
  customNodes = Join-Path $instanceHome 'custom_nodes'
  input = Join-Path $instanceHome 'input'
  output = Join-Path $instanceHome 'output'
  temp = Join-Path $instanceHome 'temp'
  hfCache = Join-Path $cacheRoot 'huggingface'
  torchCache = Join-Path $cacheRoot 'torch'
  cudaCache = Join-Path $cacheRoot 'cuda'
  tritonCache = Join-Path $cacheRoot 'triton'
  torchInductorCache = Join-Path $cacheRoot 'torchinductor'
  pipCache = Join-Path $cacheRoot 'pip'
  uvCache = Join-Path $cacheRoot 'uv'
  processTemp = Join-Path $cacheRoot 'tmp'
}
# Ensure an existing junction/symlink cannot redirect supposedly isolated data to another instance.
foreach($itemPath in @($install) + @($paths.Values)) {
  if (Test-Path -LiteralPath $itemPath) {
    $item = Get-Item -LiteralPath $itemPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail 'Isolated directories may not be links or junctions.'
    }
  }
}
$portListeners = @()
try {
  $portListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
} catch { Fail 'Could not verify port occupancy. Refusing to launch.' }
$otherComfy = @()
try {
  # Count only; no other process's private command line is returned or saved.
  $otherComfy = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match '(?i)(ComfyUI[\\/])?main\.py' -and
                   ($_.CommandLine -match 'ComfyUI' -or $_.CommandLine -match '--windows-standalone-build') })
} catch { Fail 'Could not verify other ComfyUI processes.' }
$gpuProbe = @{
  available = $false; totalMiB = $null; freeMiB = $null; usedMiB = $null;
}
if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) {
  $csv = @(& nvidia-smi.exe --query-gpu=memory.total,memory.free,memory.used --format=csv,noheader,nounits 2>&1)
  if ($LASTEXITCODE -eq 0 -and $csv.Count -eq 1) {
    $parts = ([string]$csv[0]).Split(',')
    if ($parts.Length -eq 3) {
      $gpuProbe = @{
        available = $true;
        totalMiB = [int]$parts[0].Trim();
        freeMiB = [int]$parts[1].Trim();
        usedMiB = [int]$parts[2].Trim();
      }
    }
  }
}
# The same mapping is reported by Inspect and applied ONLY to the child
# ComfyUI process on Launch; user/machine environment variables stay untouched.
$compilerCacheEnvironment = [ordered]@{
  CUDA_CACHE_PATH = $paths.cudaCache
  TRITON_CACHE_DIR = $paths.tritonCache
  TORCHINDUCTOR_CACHE_DIR = $paths.torchInductorCache
}
$report = [ordered]@{
  kind = 'dwb-comfyui-isolated-instance-v1'
  action = $Action
  installPath = $install
  runtimePython = $python
  port = $Port
  listen = '127.0.0.1'
  otherComfyInstanceCount = $otherComfy.Count
  portBusy = ($portListeners.Count -gt 0)
  gpuMemory = $gpuProbe
  paths = $paths
  compilerCacheEnvironment = $compilerCacheEnvironment
  environmentIsolation = @('HF_HOME','HF_HUB_CACHE','TORCH_HOME','XDG_CACHE_HOME','PIP_CACHE_DIR','UV_CACHE_DIR','TEMP','TMP','PYTHONPATH','CUDA_CACHE_PATH','TRITON_CACHE_DIR','TORCHINDUCTOR_CACHE_DIR')
  gpuResourceShared = $true
  safeToLaunch = ($portListeners.Count -eq 0 -and $otherComfy.Count -eq 0 -and
                   $gpuProbe.available -and $gpuProbe.freeMiB -ge 3072)
  changesMade = $false
}
if ($Action -eq 'Inspect') {
  $report | ConvertTo-Json -Depth 8
  return
}
if (-not $UserApproved) { Fail 'Launching requires explicit approval in this chat.' }
if ($portListeners.Count -gt 0) { Fail "Port $Port is already in use; never stop or replace its process." }
if ($otherComfy.Count -gt 0) {
  Fail 'Another ComfyUI Python process is running. Do not launch concurrently on a shared GPU.'
}
if (-not $gpuProbe.available -or $gpuProbe.freeMiB -lt 3072) {
  Fail 'GPU probe unavailable or less than 3 GiB GPU memory is free. Do not start a competing instance.'
}
if ($env:USERNAME -and $install -eq [IO.Path]::GetPathRoot($install)) {
  Fail 'An isolated install must not be at drive root.'
}
if ($env:USERPROFILE -and $install.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\')) {
  Fail 'An isolated install must not be the user profile.'
}
foreach($value in $paths.Values) {
  if (-not (Test-Path -LiteralPath $value)) {
    New-Item -Path $value -ItemType Directory -Force -ErrorAction Stop | Out-Null
  }
}
# Derive all per-instance caches and user data from the approved portable root.
# Never overwrite machine or user-level environment variables.
$arguments = @(
  '-s', ('"' + $main + '"'),
  '--windows-standalone-build','--disable-auto-launch',
  '--listen','127.0.0.1','--port',([string]$Port),
  '--base-directory',('"' + $paths.base + '"'),
  '--user-directory',('"' + $paths.user + '"'),
  '--models-directory',('"' + $paths.models + '"'),
  '--input-directory',('"' + $paths.input + '"'),
  '--output-directory',('"' + $paths.output + '"'),
  '--temp-directory',('"' + $paths.temp + '"'),
  '--disable-all-custom-nodes','--disable-partner-nodes'
) -join ' '
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $python
$psi.Arguments = $arguments
$psi.WorkingDirectory = $install
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $false
$psi.EnvironmentVariables['HF_HOME'] = $paths.hfCache
$psi.EnvironmentVariables['HF_HUB_CACHE'] = $paths.hfCache
$psi.EnvironmentVariables['TORCH_HOME'] = $paths.torchCache
$psi.EnvironmentVariables['XDG_CACHE_HOME'] = $cacheRoot
$psi.EnvironmentVariables['PIP_CACHE_DIR'] = $paths.pipCache
$psi.EnvironmentVariables['UV_CACHE_DIR'] = $paths.uvCache
$psi.EnvironmentVariables['TEMP'] = $paths.processTemp
$psi.EnvironmentVariables['TMP'] = $paths.processTemp
$psi.EnvironmentVariables['PYTHONNOUSERSITE'] = '1'
$psi.EnvironmentVariables['PYTHONPATH'] = ''
foreach($cacheVariable in $compilerCacheEnvironment.Keys) {
  $psi.EnvironmentVariables[$cacheVariable] = $compilerCacheEnvironment[$cacheVariable]
}
$proc = [System.Diagnostics.Process]::Start($psi)
if (-not $proc) { Fail 'ComfyUI process was not created.' }
[ordered]@{
  kind = 'dwb-comfyui-isolated-launch-v1'
  status = 'started_unverified'
  processId = $proc.Id
  url = "http://127.0.0.1:$Port"
  installPath = $install
  dataRoot = $instanceHome
  gpuResourceShared = $true
  nextStep = 'Verify that only the new loopback API responds on the chosen port. A process start alone is not runtime validation.'
} | ConvertTo-Json -Depth 5
