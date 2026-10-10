# DWB Companion — Project Launcher (Experimental)

MCP App ใน ChatGPT conversation panel (thread entrypoint) สำหรับจัดการโปรเจกต์จาก UI โดยตรง ไม่ใช่ Global Sidebar

## งานที่ทำได้

- **One Chat, One Workspace**: แชทที่ยังไม่เลือกโปรเจกต์จะมีตัวค้นหาและปุ่ม Select & Lock ให้เลือกได้เพียงครั้งเดียว หลังจากนั้นแสดงเฉพาะ Current Workspace และ Full Path; ต้องเปิดแชทใหม่จึงจะเลือกโปรเจกต์อื่นได้
- **New Project**: ใช้ได้ก่อนเลือก Workspace เท่านั้น; เลือก parent จาก DWB allowedDirectories, ตั้งชื่อ, เลือก Blank / Website / Documentation แล้วสร้างโฟลเดอร์พร้อม Lock ให้แชทโดยไม่เขียนทับ
- **Add Existing**: ใช้ได้ก่อนเลือก Workspace เท่านั้น; กรอก path ที่มีอยู่ใน Panel ครั้งเดียวเพื่อ register และ lock
- **Reference Workspaces**: แสดงทันทีใต้ Workspace ปัจจุบัน เลือกโปรเจกต์อื่นเป็นแหล่งอ้างอิงสูงสุด 5 รายการต่อ session; การเพิ่ม/ลบ Reference ไม่เปลี่ยน Active Workspace
- **Searchable Project Picker**: แสดงก่อนการเลือกครั้งแรก ค้นหาชื่อ/พาธแล้วกดยืนยัน Select & Lock; หลังเลือกแล้วจะซ่อน Picker ป้องกันการ Switch
- **Workspace administration**: รวม Manage Registry และ Allowed Directories ไว้ในส่วน Advanced ที่ย่อไว้เป็นค่าเริ่มต้น; Registry แยก Ready / Outside allowed roots / Missing / Archived และรองรับ Archive, Restore, Unregister และ Relink แบบ Review → Confirm โดยไม่ลบไฟล์จริง
- **Allowed Directory Manager**: แสดง Base Policy ปัจจุบัน เพิ่ม/ลบ Root ได้เมื่อยืนยัน Review ที่ยังไม่หมดอายุ และไม่มี active worker; บันทึกไฟล์สำรองก่อนเปลี่ยน Policy
- **Context Sync**: ใช้ app.updateModelContext ส่งรหัส Workspace ที่เลือกและ references ให้ ChatGPT ในรอบต่อไปแบบไม่ส่งข้อความใหม่ หาก Host รองรับ
- **Chat-first UX**: ไม่มีปุ่ม Continue with ChatGPT และไม่มี app.sendMessage ที่ส่ง Prompt สำเร็จรูป; ผู้ใช้พิมพ์สั่งงานในแชทเองหลังเลือก Workspace. ใช้ app.updateModelContext เฉพาะเมื่อ Host รองรับ พร้อมหลีกเลี่ยงการ Sync ซ้ำโดยไม่จำเป็น และแจ้งสถานะเมื่อไม่รองรับ
- **Responsive Side Panel**: เมื่อ Panel แคบปุ่ม Refresh ใช้ไอคอนพร้อม accessible label เพื่อไม่ให้ถูกตัด; คำอธิบาย Workspace Lock ย่อให้กระชับและข้อความ Path ยังคงอ่านได้
- **System status**: เก็บ Worker / Session / Skills รวมทั้งเวลาที่ Refresh ล่าสุดและข้อความ Policy ไว้ใต้รายละเอียดที่ย่อได้ ไม่แสดง Footer ที่ไม่จำเป็นในหน้าหลัก; ข้อความ Boot Diagnostics ซ่อนหลังโหลดสำเร็จ แต่แสดงเมื่อเกิดข้อผิดพลาด

## Security และ Project Home

Project Home มาจาก allowedDirectories ที่ DWB Setup อนุญาตอยู่แล้วเท่านั้น ต้องเป็น directory ที่มีจริง และไม่ใช่ Git repository หรือรากโปรเจกต์ Node ที่มี package.json

สร้างชื่อแบบ slug (A-Z, a-z, 0-9, dot, hyphen, underscore; ความยาว 1–60) ไม่รับ traversal หรือชื่อสงวน Windows. สร้างเฉพาะโฟลเดอร์ระดับเดียวและเขียนไฟล์แบบไม่ทับของเดิม หากสร้างสำเร็จแต่ worker ยังยุ่ง จะลงทะเบียนโฟลเดอร์ไว้และไม่ตัดงานเดิม

Model-visible `dwb_companion` ไม่ส่ง absolute path, session ID หรือ worker PID. `dwb_companion_snapshot` / `dwb_companion_action` เป็น app-only และส่งพาธจริงให้ UI เพื่อให้เจ้าของเครื่องเห็นตำแหน่งโปรเจกต์ได้; ข้อมูลพาธไม่ถูกเพิ่มใน Model Context โดยอัตโนมัติ
Related Workspaces ไม่ขยาย filesystem permission; ตัว Read-only ใน Related Workspaces เป็น instruction/Workspace-boundary ไม่ใช่ OS-level sandbox สำหรับ shell commands
Review/Confirm ของทะเบียนบล็อก Workspace ที่ยังมี bindings หรือ references; Unregister ต้อง Archive ก่อน และลบเฉพาะ registry records ไม่ลบไฟล์
Allowed Directories ใช้ `DWB_BASE_DC_CONFIG` ของ Broker/Worker จริง; ห้ามกำหนด `allowedDirectories: []` เพราะ Desktop Commander จะตีความเป็น full filesystem access
การแก้ Allowed Roots ต้องมีอย่างน้อย 1 root และไม่มี Active Workers; ถ้ายังมี Worker ให้หยุดงาน/รอปล่อย Worker ก่อน บันทึกสำรอง Policy ในโฟลเดอร์เดิม และ Restart MCP ภายหลังเพื่อให้ Client/Worker ใหม่โหลด Policy ที่ตรงกัน
Review token อายุ 5 นาที ผูกกับ Session และใช้ได้ครั้งเดียว; หาก Registry/Policy เปลี่ยนระหว่างนั้น ต้องเริ่ม Review ใหม่

การ Lock มีการบังคับที่ Backend ทั้ง `workspace.bind`, `workspace.unbind`, `dwb_companion_action` และ `dwb_resume_session` เพื่อป้องกันการ Switch ผ่าน MCP โดยตรง; Bind ซ้ำ Workspace เดิมเป็น idempotent การสร้างโปรเจกต์ใหม่ผ่าน Panel จะไม่เริ่มหลังจากแชทถูก Lock แล้ว
ระบบบันทึกการเลือกตาม Logical Context Key ที่ Host ส่งมาใน SQLite `conversation_workspace_locks` เพื่อให้กลับมาที่แชทเดิมหรือ restart/reconnect ได้ ข้อมูลโปรเจกต์ยังอยู่ใน Local ไม่ใช่ ChatGPT Memory; ความแยกอิสระระหว่างแชทขึ้นอยู่กับ Host ส่ง Context Key ที่แตกต่างกัน หาก Host ไม่มีคีย์ดังกล่าว ระบบล็อกได้เพียงระดับ MCP Session และควรทดสอบบน Host จริง

## ส่วนประกอบ

- tools: dwb_companion, dwb_companion_snapshot, dwb_companion_action (app-only)
- UI resource: ui://dwb-mcp-studio/companion-panel
- web/companion.ts และ web/companion.html
- src/companion-projects.ts และ src/companion-panel.ts
- SQLite tables: `companion_related_workspaces`, `session_workspace_bindings`, `conversation_workspace_locks`
- npm run build สร้าง dist/companion-panel.html

## QA ก่อนถ่ายคลิป

1. npm test
2. npx tsx src/protocol-negotiation-test.ts
3. npm run test:distribution
4. npm run format:check
5. จบงานเดิมแล้ว Stop MCP/เริ่มใหม่อย่างปลอดภัยตาม docs/UPDATING-TH.md
6. เปิด DWB Companion ใน ChatGPT Host ที่รองรับ MCP Apps / Extensions จริง
7. ทดสอบสร้าง Website project ใน Project Home ที่อนุญาตและอยู่นอก Source Repo
8. ทดสอบแชทใหม่เริ่มจาก Select Workspace, ยืนยันแล้ว Picker หาย และแสดง Locked + Full Path
9. ทดสอบว่า Switch, Unbind, Resume ไปอีก Workspace และ New Project หลัง Lock ถูกบล็อกจาก Backend โดยไม่ตัด Worker เดิม
10. ทดสอบเปิดแชทใหม่เลือก Workspace อื่นได้, กลับแชทเดิมยังคงล็อกเดิม และ Add/Remove Reference ไม่เปลี่ยน Active Workspace
11. ทดสอบหลัง Lock ไม่มีปุ่มส่ง Prompt สำเร็จรูป, ข้อความ Connected ซ้ำซ้อนหายไป, Reference Workspaces อยู่ก่อน Workspace administration และไม่เกิด Chat Message โดยอัตโนมัติ
12. ทดสอบ Registry Archive/Restore/Unregister/Relink ด้วยฐานข้อมูลทดสอบเท่านั้น รวมถึงไม่ลบไฟล์จริง
13. ทดสอบ Policy add/remove กับไฟล์ Base Policy ชั่วคราวเท่านั้น และตรวจ revision conflict, last-root guard, token replay
14. ยืนยันว่า Path ปรากฏเฉพาะ app-only Snapshot และไม่ปรากฏในผล Tool เปิด Panel ที่ model มองเห็น

โค้ดนี้ยังเป็น PoC ใน feature branch ไม่ใช่ Public Release. Unit / MCP integration tests ไม่ยืนยันว่า UI ทำงานบน ChatGPT Host จริงแล้ว. ยังต้องทบทวน npm audit High/Critical และ bundled license notices ก่อนออก release

## อ่านเพิ่มเติม

- https://openai.com/index/gpt-6-for-everyone/
- https://developers.openai.com/plugins/build/extensions
- https://github.com/openai/mcp-extensions/blob/main/docs/spec.md
