# ติดตั้ง ComfyUI ด้วย ChatGPT + DWB MCP Studio (Windows/NVIDIA)

ชุดนี้คือ Agent Skill สำหรับช่วยตรวจเครื่องและเตรียมการติดตั้ง ComfyUI ไม่ใช่ ComfyUI Model และไม่ใช่ Cloud Service ตัว DWB MCP Studio ใช้ Local Desktop Commander Worker ในการอ่านข้อมูลและสั่งงานที่ผู้ใช้อนุญาต

## เหตุผลที่แบ่งเป็น Preflight → Plan → Approval → Apply → Verify

เครื่องผู้เรียนแตกต่างกันทั้ง GPU/VRAM, driver, OS, Python/PyTorch, พื้นที่ว่าง และอาจติดตั้ง ComfyUI อยู่แล้ว AI Agent จึงต้องตรวจสอบก่อนตัดสินใจแก้ Environment

- Preflight — อ่านข้อมูลระบบ, ตรวจ ComfyUI ผ่าน loopback localhost, คืน JSON ไม่เปลี่ยนไฟล์
- Plan — ตรวจชื่อ/เวอร์ชัน/ขนาด/SHA-256 ของ Portable Release ทางการ ไม่ดาวน์โหลดแพ็กเกจ
- Approval — ผู้ใช้เห็นไฟล์เป้าหมาย ตำแหน่ง และขนาด แล้วตอบอนุญาตใหม่อย่างชัดเจน
- Apply — ติดตั้งเฉพาะโฟลเดอร์ใหม่ใน Active Workspace หลังอนุมัติ โดยไม่แก้ Python/Driver/ComfyUI ที่มีอยู่
- Verify — ตรวจโครงสร้างและ API ด้วยวิธีอ่านข้อมูล; การรันโปรแกรมหรือดาวน์โหลดโมเดลต้องขออนุญาตแยก

## เริ่มใน ChatGPT

1. ติดตั้ง DWB MCP Studio ให้สามารถเชื่อมกับ ChatGPT และเปิด DWB Companion ได้
2. ติดตั้ง Agent Skill นี้แบบ Local จากโฟลเดอร์ skills/comfyui-setup ด้วยเมนู DWB Agent Skills แล้วตั้ง Policy เป็น ASK หรือ MANUAL
3. เปิดแชทใหม่ เลือกโฟลเดอร์สำหรับเรียน/ทดลองติดตั้งใน DWB Companion และ Lock Workspace (หนึ่งแชทต่อหนึ่งโปรเจกต์)
4. ให้ ChatGPT ใช้ Skill comfyui-setup: "ช่วยตรวจว่าเครื่องนี้พร้อมติดตั้ง ComfyUI หรือไม่ ตรวจ OS, GPU, VRAM, RAM, Driver, Disk และ ComfyUI เดิม โดยอ่านอย่างเดียวก่อน อย่าเพิ่งดาวน์โหลด ติดตั้ง หรือแก้ Environment"
5. ดูผลตรวจจริง แล้วเลือกใช้ ComfyUI เดิม, ComfyUI Desktop หรือ Windows Portable

หากเลือก Desktop: ใช้เฉพาะเว็บไซต์ https://comfy.org/download แล้วให้ผู้ใช้อนุมัติและทำ Wizard เอง เพราะ Desktop อาจเขียนไฟล์นอก Workspace

หากต้องการสาธิตติดตั้งแบบ Agent ควบคุมได้: เลือก Windows Portable ลงโฟลเดอร์ใหม่ภายใน Active Workspace; ดู Plan + SHA-256 ก่อน แล้วจึงอนุมัติ Apply ขนาดไฟล์จริงขึ้นอยู่กับ Release

## คำสั่ง PowerShell แบบอ่านอย่างเดียว

จาก Active Workspace ที่ ChatGPT เลือก:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<skill_dir>\scripts\Preflight-ComfyUI.ps1" -WorkspaceRoot "<active_workspace_path>" -ApiUrl "http://127.0.0.1:8188"

ผลลัพธ์เป็น JSON เช่น kind, operatingSystem, memoryGiB, nvidia.devices, comfyui, recommendedNextStep, warnings, changesMade

ถ้าพบ ComfyUI Running: ให้ตรวจและใช้งานตัวเดิมก่อน ห้ามติดตั้งทับหรือหยุดงานใน Queue หากต้องการสาธิตติดตั้งใหม่ให้เปิดแชทใหม่และเลือก Workspace สะอาดอีกแห่ง หรือใช้ VM ใหม่

## ตัวอย่าง Plan สำหรับ Portable (ยังไม่ดาวน์โหลด)

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<skill_dir>\scripts\Install-ComfyUIPortable.ps1" -Action Plan -WorkspaceRoot "<active_workspace_path>" -InstallFolder "ComfyUI_windows_portable" -Variant NvidiaCurrent

สำหรับ Windows + NVIDIA RTX20 series ขึ้นไป ใช้ NvidiaCurrent; NVIDIA รุ่นเก่าต้องตรวจเอกสารแล้วค่อยเลือก NvidiaLegacy ห้ามใช้ตัวเลือก CUDA แบบเดาสุ่ม

Apply จะต้องเพิ่ม ReleaseTag, ApprovedSha256 และ UserApproved ที่มาจากการอนุมัติแผนจริง ไม่มีการ Auto-approve ผ่านคำขอทั่วไป

## ขอบเขตด้านความปลอดภัยและ Privacy

- อ่าน API เฉพาะ 127.0.0.1/localhost; ไม่เปิดรับการเชื่อมต่อจาก LAN/Internet
- คืนเพียงจำนวนงานใน Queue ไม่คืน Prompt/ภาพ/เสียง/ไฟล์ผู้ใช้
- ไม่ติดตั้งทั่วเครื่อง ไม่แก้ System Python, PyTorch, Driver, PATH, Registry, Firewall
- ไม่บันทึก GPU/Workspace path ลง GitHub หรือส่งไปยังบริการนอกเครื่องโดยอัตโนมัติ; เมื่อส่ง JSON รายงานให้ ChatGPT จะมีข้อมูลเครื่องอยู่ในบริบทแชท
- ไม่สร้างภาพหรือวิดีโอในขั้นติดตั้ง ต้องเลือกโมเดลและอนุมัติการดาวน์โหลดต่างหาก
- ComfyUI ใช้งานกับการ์ด 8GB ได้ในบาง Workflow แต่ไม่ควรรับประกัน VRAM, Resolution หรือ Video Duration โดยไม่ทดสอบโมเดลจริง

## อ้างอิงทางการ

- https://github.com/Comfy-Org/ComfyUI
- https://comfy.org/download
- https://github.com/comfyanonymous/ComfyUI/releases
