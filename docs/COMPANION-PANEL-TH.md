# DWB Companion — Project Launcher (Experimental)

MCP App ใน ChatGPT conversation panel (thread entrypoint) สำหรับจัดการโปรเจกต์จาก UI โดยตรง ไม่ใช่ Global Sidebar

## งานที่ทำได้

- **Switch Workspace**: เลือกโปรเจกต์จากรายการแล้วสลับผ่าน Broker; ระบบไม่ตัด worker ที่ยังมีงาน
- **New Project**: เลือก parent จาก DWB allowedDirectories, ตั้งชื่อ, เลือก Blank / Website / Documentation, สร้างโฟลเดอร์พร้อม starter files โดยไม่เขียนทับ
- **Add Existing**: กรอก path ที่มีอยู่ใน Panel ครั้งเดียว เพื่อ register และ bind
- **Related Workspaces**: เลือกโปรเจกต์อื่นเป็น reference แบบ read-only สูงสุด 5 รายการต่อ session
- **Searchable Project Picker**: แสดง Current Workspace และ local path จาก app-only snapshot; ค้นหาชื่อ/พาธก่อนกดยืนยัน Switch
- **Manage Registry**: แยก Ready / Outside allowed roots / Missing / Archived; Archive, Restore, Unregister และ Relink แบบ Review → Confirm โดยไม่ลบไฟล์จริง
- **Allowed Directory Manager**: แสดง Base Policy ปัจจุบัน เพิ่ม/ลบ Root ได้เมื่อยืนยัน Review ที่ยังไม่หมดอายุ และไม่มี active worker; บันทึกไฟล์สำรองก่อนเปลี่ยน Policy
- **Context Sync**: ใช้ app.updateModelContext ส่งรหัส Workspace ที่เลือกและ references ให้ ChatGPT ในรอบต่อไปแบบไม่ส่งข้อความใหม่ หาก Host รองรับ
- **Continue with ChatGPT**: ปุ่มส่งข้อความผ่าน app.sendMessage โดยผู้ใช้สั่งเอง; Host ที่ไม่รองรับแสดง prompt สำหรับ copy
- **System status**: ย้าย Worker / Session / Skills ไปไว้ใต้รายละเอียดที่ย่อได้

## Security และ Project Home

Project Home มาจาก allowedDirectories ที่ DWB Setup อนุญาตอยู่แล้วเท่านั้น ต้องเป็น directory ที่มีจริง และไม่ใช่ Git repository หรือรากโปรเจกต์ Node ที่มี package.json

สร้างชื่อแบบ slug (A-Z, a-z, 0-9, dot, hyphen, underscore; ความยาว 1–60) ไม่รับ traversal หรือชื่อสงวน Windows. สร้างเฉพาะโฟลเดอร์ระดับเดียวและเขียนไฟล์แบบไม่ทับของเดิม หากสร้างสำเร็จแต่ worker ยังยุ่ง จะลงทะเบียนโฟลเดอร์ไว้และไม่ตัดงานเดิม

Model-visible `dwb_companion` ไม่ส่ง absolute path, session ID หรือ worker PID. `dwb_companion_snapshot` / `dwb_companion_action` เป็น app-only และส่งพาธจริงให้ UI เพื่อให้เจ้าของเครื่องเห็นตำแหน่งโปรเจกต์ได้; ข้อมูลพาธไม่ถูกเพิ่มใน Model Context โดยอัตโนมัติ
Related Workspaces ไม่ขยาย filesystem permission; ตัว Read-only ใน Related Workspaces เป็น instruction/Workspace-boundary ไม่ใช่ OS-level sandbox สำหรับ shell commands
Review/Confirm ของทะเบียนบล็อก Workspace ที่ยังมี bindings หรือ references; Unregister ต้อง Archive ก่อน และลบเฉพาะ registry records ไม่ลบไฟล์
Allowed Directories ใช้ `DWB_BASE_DC_CONFIG` ของ Broker/Worker จริง; ห้ามกำหนด `allowedDirectories: []` เพราะ Desktop Commander จะตีความเป็น full filesystem access
การแก้ Allowed Roots ต้องมีอย่างน้อย 1 root และไม่มี Active Workers; ถ้ายังมี Worker ให้หยุดงาน/รอปล่อย Worker ก่อน บันทึกสำรอง Policy ในโฟลเดอร์เดิม และ Restart MCP ภายหลังเพื่อให้ Client/Worker ใหม่โหลด Policy ที่ตรงกัน
Review token อายุ 5 นาที ผูกกับ Session และใช้ได้ครั้งเดียว; หาก Registry/Policy เปลี่ยนระหว่างนั้น ต้องเริ่ม Review ใหม่

## ส่วนประกอบ

- tools: dwb_companion, dwb_companion_snapshot, dwb_companion_action (app-only)
- UI resource: ui://dwb-mcp-studio/companion-panel
- web/companion.ts และ web/companion.html
- src/companion-projects.ts และ src/companion-panel.ts
- SQLite table: companion_related_workspaces
- npm run build สร้าง dist/companion-panel.html

## QA ก่อนถ่ายคลิป

1. npm test
2. npx tsx src/protocol-negotiation-test.ts
3. npm run test:distribution
4. npm run format:check
5. จบงานเดิมแล้ว Stop MCP/เริ่มใหม่อย่างปลอดภัยตาม docs/UPDATING-TH.md
6. เปิด DWB Companion ใน ChatGPT Host ที่รองรับ MCP Apps / Extensions จริง
7. ทดสอบสร้าง Website project ใน Project Home ที่อนุญาตและอยู่นอก Source Repo
8. ทดสอบ Switch, Add Existing, Add/Remove Related และ updateModelContext ใน ChatGPT
9. ทดสอบว่า worker ที่กำลังทำงานถูกปกป้อง ไม่ถูกตัดตอนเปลี่ยน Workspace
10. ทดสอบ Registry Archive/Restore/Unregister/Relink ด้วยฐานข้อมูลทดสอบเท่านั้น รวมถึงไม่ลบไฟล์จริง
11. ทดสอบ Policy add/remove กับไฟล์ Base Policy ชั่วคราวเท่านั้น และตรวจ revision conflict, last-root guard, token replay
12. ยืนยันว่า Path ปรากฏเฉพาะ app-only Snapshot และไม่ปรากฏในผล Tool เปิด Panel ที่ model มองเห็น

โค้ดนี้ยังเป็น PoC ใน feature branch ไม่ใช่ Public Release. Unit / MCP integration tests ไม่ยืนยันว่า UI ทำงานบน ChatGPT Host จริงแล้ว. ยังต้องทบทวน npm audit High/Critical และ bundled license notices ก่อนออก release

## อ่านเพิ่มเติม

- https://openai.com/index/gpt-6-for-everyone/
- https://developers.openai.com/plugins/build/extensions
- https://github.com/openai/mcp-extensions/blob/main/docs/spec.md
