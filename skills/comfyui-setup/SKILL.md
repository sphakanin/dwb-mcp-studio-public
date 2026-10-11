---
name: comfyui-setup
description: Safely inspect a local machine, guide a first-time ComfyUI installation, troubleshoot dependencies, and verify local operation through DWB MCP Studio. Windows NVIDIA first; never reinstall an existing runtime without approval.
---

# ComfyUI Setup Assistant — DWB MCP Studio

Use this skill for explicit requests to install, verify, or troubleshoot ComfyUI locally. Follow DWB active-workspace, least-privilege, one-chat-one-workspace and permission policies. Do not generate images or videos automatically.

## Sources and support

- Official installation advice: https://github.com/Comfy-Org/ComfyUI (Desktop recommended for beginners; Portable optional).
- Official ComfyUI downloads: https://comfy.org/download
- Official Portable metadata: https://api.github.com/repos/comfyanonymous/ComfyUI/releases
- Course demo decision: **Windows Portable with its embedded Python/PyTorch in a NEW isolated folder**, never Manual Git + uv for this scenario. Mention Desktop only as a simpler alternative for other beginners.
- Packaged first: Windows PowerShell + NVIDIA. AMD, Intel, Apple Silicon, Linux require vendor-specific documentation and manual review; never guess CUDA/PyTorch variants.
- VRAM needs vary by model, quantization, resolution and frame count. Do not promise 720p or 5-second video merely from 8/16 GB VRAM.

## Stage 0: Fix the active project boundary

1. Start a NEW chat, open DWB Companion, select the intended demo workspace ONCE. The primary workspace stays locked. Never attempt unbind, switch or resume to another project.
2. Check DWB allowedDirectories. Do not expand access, change permissions, or write into another project without separate authorization.
3. These scripts are local source, not arbitrary downloaded installer commands. Inspect them before first use. Run read-only preflight first.
4. An existing ComfyUI process may have active requests. Never stop, upgrade, change its environment, clear its queue or reuse its port without explicit permission.

## Stage 1: Preflight (read-only)

Run through the DWB start_process tool from the selected workspace:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<skill_dir>\scripts\Preflight-ComfyUI.ps1" -WorkspaceRoot "<active_workspace_path>" -ApiUrl "http://127.0.0.1:8188"

The script checks OS/RAM/GPU/VRAM/driver/disk/tools and loopback-only ComfyUI /system_stats and /queue. Queue contents are reduced to counts; never send prompts or private media to ChatGPT. Preflight makes no changes.

Explain the report in Thai. If comfyui.reachable is true, recommend REUSE for normal users. **Exception: an explicitly requested installation teaching demo** may PLAN a second isolated Portable installation in a new dedicated workspace, but may not silently apply the plan or launch it concurrently with the existing ComfyUI GPU process.

## Stage 2: Select installation route

- **This course demo always selects isolated Windows NVIDIA Portable**, installed into a NEW direct child folder of the ACTIVE workspace. The bundle has its OWN python_embeded/PyTorch. Variant NvidiaCurrent is for NVIDIA RTX/20-series or newer; NvidiaLegacy is for older NVIDIA 10-series or below after compatibility review.
- Ordinary beginners may choose ComfyUI Desktop from https://comfy.org/download as a separate tutorial, but do not switch this demo from Portable to Desktop or Manual Git + uv without the user changing the decision explicitly.
- Unsupported/unknown GPU: stop to explain limitations and alternatives; no forced CUDA installation.

## Stage 3: Plan before installing

For a Windows RTX NVIDIA Portable demonstration:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<skill_dir>\scripts\Install-ComfyUIPortable.ps1" -Action Plan -WorkspaceRoot "<active_workspace_path>" -InstallFolder "ComfyUI_windows_portable" -Variant NvidiaCurrent

Plan retrieves official GitHub RELEASE METADATA only, not archives or models. Print exact release tag, asset, SHA-256, size, destination, disk estimate and risks. Ask: "May I download and extract this exact version and SHA-256 to this NEW folder?" Wait for the next user turn with explicit approval.

A preflight request or general request to prepare video teaching materials is NOT approval to install.

## Stage 4: Apply after explicit approval only

Use the actual plan tag and 64-character hash, never invented values:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<skill_dir>\scripts\Install-ComfyUIPortable.ps1" -Action Apply -WorkspaceRoot "<active_workspace_path>" -InstallFolder "ComfyUI_windows_portable" -Variant NvidiaCurrent -ReleaseTag "<tag_from_plan>" -ApprovedSha256 "<sha256_from_plan>" -UserApproved

The script refetches metadata, checks official asset origin + SHA, stages and extracts inside the selected DWB workspace, and refuses to overwrite an existing install. No global driver, Python, CUDA, PATH, firewall or model changes.

Never auto-run ComfyUI launch scripts or download gigabytes of models without a new explicit approval. Do not share models, custom nodes, input/output or caches with another instance. The embedded Portable Python environment must not be replaced with a global Python or a shared .venv.

## Stage 5: Verify installation and isolation before any GPU use

- Check new folder has ComfyUI\main.py, python_embeded\python.exe and run_nvidia_gpu.bat; read .dwb-install-manifest.json.
- With approval, probe embedded Python --version, without touching system Python or dependencies.
- Inspect launch readiness **without starting** using the included script:

  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<skill_dir>\scripts\Start-ComfyUI-Isolated.ps1" -Action Inspect -InstallPath "<new_install_path>" -Port 8189

- The report lists independent user, models, custom_nodes, input, output, temp and HF/Torch/PIP/UV cache locations, plus process-only compiler cache mappings: `CUDA_CACHE_PATH` → `instance-data/cache/cuda`, `TRITON_CACHE_DIR` → `instance-data/cache/triton`, `TORCHINDUCTOR_CACHE_DIR` → `instance-data/cache/torchinductor`. No cache folders or environment variables are changed in Inspect mode.
- These three paths are applied to the **new ComfyUI child process only**, not Windows user/machine variables or the existing ComfyUI instance. These caches hold compiled code/artifacts, not regular models or generated images; setting them is an isolation improvement, not a prerequisite for ComfyUI to run. Check the `compilerCacheEnvironment` section of the Inspect JSON.
- **Never start two CUDA ComfyUI instances on the same GPU during this demo.** Even completely separate software environments share VRAM, GPU compute, system RAM and driver. If the existing instance is running, request that the user stop it _themselves when idle_; do not stop, kill, clear the queue or modify it through the Agent.
- After the user separately approves Launch, use the same script with `-Action Launch -InstallPath "<new_install_path>" -Port 8189 -UserApproved`. It creates only per-instance folders and starts embedded Python with `--listen 127.0.0.1`, isolated base/user/models/input/output/temp directories and `--disable-partner-nodes`. Never use the default run_nvidia_gpu.bat because it defaults to port 8188.
- Confirm the new loopback API on 8189 using GET /system_stats; report ComfyUI/Python/PyTorch. A process ID alone is not verification.
- First image generation is the next lesson. Ask which model to download/use, report size/license/VRAM tradeoffs and obtain consent before downloading or queueing prompts.

## Troubleshooting boundaries

- Preserve the last known working runtime. Read actual errors before retrying.
- Investigate GPU/driver, local Torch/CUDA, model directories, missing assets, security software, storage and occupied port.
- Do NOT perform blind global pip installs/uninstalls, PATH edits, admin privilege escalation, system-wide driver updates, delete output or models, --listen 0.0.0.0, or external API calls.
- Summarize what was inspected, what exists, what was modified, what needs approval and the next safe step. Never treat a browser page alone as proof of backend health.

## Student-facing output

Report OS/GPU/VRAM/RAM/disk; detected ComfyUI and API state; recommended Desktop vs Portable; estimated download size/local paths; explicit approval gate; verification result; realistic VRAM limitations and next lesson's image workflow.
