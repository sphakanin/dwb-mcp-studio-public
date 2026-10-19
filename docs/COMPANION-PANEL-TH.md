# DWB Companion — Project Launcher (Experimental)

MCP App ใน ChatGPT conversation panel (thread entrypoint) สำหรับจัดการโปรเจกต์จาก UI โดยตรง ไม่ใช่ Global Sidebar

## งานที่ทำได้

- **One Chat, One Workspace**: แชทที่ยังไม่เลือกโปรเจกต์จะมีตัวค้นหาและปุ่ม Select & Lock ให้เลือกได้เพียงครั้งเดียว หลังจากนั้นแสดงเฉพาะ Current Workspace และ Full Path; ต้องเปิดแชทใหม่จึงจะเลือกโปรเจกต์อื่นได้
- **New Project**: ใช้ได้ก่อนเลือก Workspace เท่านั้น; เลือก parent จาก DWB allowedDirectories, ตั้งชื่อ, เลือก Blank / Website / Documentation แล้วสร้างโฟลเดอร์พร้อม Lock ให้แชทโดยไม่เขียนทับ
- **Add Existing**: ใช้ได้ก่อนเลือก Workspace เท่านั้น; กรอก path ที่มีอยู่ใน Panel ครั้งเดียวเพื่อ register และ lock
- **Reference Workspaces**: ส่วนอ้างอิงแบบ Optional สำหรับ **อ่าน** ข้อมูลจากโปรเจกต์อื่น ไม่ใช่ Workspace หลักที่ใช้แก้ไข; สูงสุด 5 รายการต่อ session, ใช้ Searchable Picker แทน Dropdown และย่อไว้เป็นค่าเริ่มต้นเมื่อไม่มี Reference; การเพิ่ม/ลบไม่เปลี่ยน Active Workspace
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
- SQLite tables: `companion_related_workspaces`, `session_workspace_bindings`, `conversation_workspace_locks`, `companion_presentation_settings`
- npm run build สร้าง dist/companion-panel.html

## Hide / Unhide Workspace — ซ่อนจากรายการเลือกในโหมดปกติ

ใช้เมื่อต้องการสาธิต DWB Companion โดยไม่ให้รายการโปรเจกต์งานภายในปรากฏใน **Project Picker / Reference Picker** โดยไม่ต้องเปิด Presentation Mode:

1. เปิด **Workspace administration → Manage registered projects** (ค่าเริ่มต้นคือ **Visible projects**)
2. ในโปรเจกต์ที่ไม่ต้องการแสดง เลือก **Hide from picker → Review → Confirm change** แม้โปรเจกต์จะมี Active Binding หรือ Reference อยู่ก็ทำได้
3. รายการจะหายไปจาก Picker ในแชทใหม่และหลัง Refresh; เปิดตัวกรอง **Hidden projects** ในหน้าบริหารเพื่อดูรายการที่ซ่อน
4. เลือก **Unhide from picker → Review → Confirm change** เพื่อให้กลับมาแสดง โดยไม่ต้องลงทะเบียนโปรเจกต์ใหม่

สถานะ Hidden เก็บใน SQLite ตาราง `workspace_picker_hidden` ข้ามแชทและการ Restart; ไม่มีการย้าย/ลบ Source Code เปลี่ยน `allowedDirectories` หรือเปลี่ยน Workspace Lock/Bindings/References. โปรเจกต์ที่ถูกซ่อน **ยังเข้าถึงได้ผ่านการระบุ path/workspace ID ในเครื่องมือ MCP ตาม Policy เดิม** และ Active Workspace/Reference ที่เลือกอยู่แล้วในแชทเก่าอาจยังมีชื่อปรากฏ ข้อมูลในแชทเก่าและ System Status ไม่ได้ถูก Mask. จึงควรเปิด **แชทใหม่ที่เลือก Demo Workspace** และตรวจทุกหน้าจอก่อนบันทึกภาพ รวมถึงหลีกเลี่ยงการเปิดตัวกรอง **Hidden projects / All projects** ระหว่างเดโม

Hide เป็นเพียง **การจัดการความสะอาดรายการเลือก (UI visibility)** ไม่ใช่มาตรการรักษาความลับหรือการตัดสิทธิ์ filesystem. ต่างจาก Archive ที่บล็อกโปรเจกต์มี Active Binding/Reference; Unregister ต้อง Archive ก่อนจึงทำได้

## Presentation Mode — โหมดสาธิต

ฟีเจอร์นี้ **ซ่อน Workspace เฉพาะใน DWB Companion UI** เพื่อป้องกันเผลอแสดงชื่อโปรเจกต์งานภายในระหว่างสาธิต; ไม่ลบ/Archive/Unregister Workspace และไม่แก้ `allowedDirectories` หรือสิทธิ์ OS

### วิธีเตรียมและใช้งาน

1. เปิด **DWB Companion** ขณะที่ยังเป็น **Normal Mode** (ค่าเริ่มต้นเมื่อยังไม่เคยเปิด Presentation Mode)
2. เปิด **Workspace administration → Advanced Settings · Presentation Mode / Demo Allowlist** เลือก Workspace ที่เป็น Demo ผ่าน Checkbox ได้หลายรายการ (ต้องเป็น Workspace ที่ลงทะเบียนอยู่แล้ว)
3. กด **Save Demo Allowlist** (ค่าบันทึกในฐานข้อมูล SQLite ฝั่ง DWB ไม่ใช่ browser `localStorage`); ต้องมี Workspace อย่างน้อยหนึ่งรายการที่ยังอยู่ภายใต้ `allowedDirectories` และโฟลเดอร์มีอยู่จริง จึงจะเปิดโหมดได้
4. กด **Enter Presentation Mode**: แถบ **Presentation Mode ON** จะปรากฏ; Project Picker / Search / Reference Picker และรายการที่มองเห็นจะมีเฉพาะ Workspace ใน Allowlist
5. ตรวจว่า Workspace ที่แสดงถูกต้องและ **Path ถูก Mask** แล้ว ค่อยเริ่มอัดคลิป (ควรสร้างแชทสาธิตใหม่หลังตั้งค่าโหมด)
6. เสร็จแล้วกด **Exit Presentation Mode** บนแถบด้านบนเพื่อกลับสู่ Normal Mode และเห็น Workspace ที่เคยลงทะเบียนตามเดิมทั้งหมด

หากผู้ใช้ล็อก Active Workspace ที่ **ไม่ได้อยู่ใน Demo Allowlist** ในแชทเดิม ชื่อและ Path ของ Workspace นั้นจะไม่แสดงใน Presentation Mode แต่ **Workspace Lock ยังทำงาน** ไม่สามารถเปลี่ยน Active Workspace ในแชทเดียวกันได้ ให้เปิด **แชทใหม่** เพื่อเลือก Demo Workspace ที่ต้องการ

**Reference Workspaces** เป็นตัวเลือกเสริม (Optional — ไม่จำเป็นต้องเลือก) และมีไว้ให้ ChatGPT อ่านข้อมูลอ้างอิงจากโปรเจกต์อื่น ไม่ได้เปลี่ยน Workspace หลักที่ใช้แก้ไข UI จะแสดงรายการแบบย่อเมื่อไม่มี Reference และมีช่องค้นหาแทน Dropdown ยาว ๆ; แสดงเฉพาะ Demo Allowlist ใน Presentation Mode โดยจำนวนสูงสุด **5** นับตามรายการอ้างอิงจริงใน Session แม้บางรายการถูกซ่อน Read-only semantics และ Lock เดิมยังคงอยู่

### การซ่อนข้อมูลและข้อจำกัดที่ต้องทราบ

- Presentation Mode ซ่อนชื่อ Workspace ที่ไม่อยู่ใน Allowlist ใน UI, Registry, Picker, Reference, Session list และไม่แสดงจำนวน Session รวม; Path ของ Workspace ที่แสดงถูก Mask และส่วน Admin / Allowed Directories / System Status ถูกซ่อนจาก UI
- การกรองทำฝั่ง DWB ก่อนส่ง Snapshot เข้า MCP App; Model-visible Companion Snapshot ถูกกรองเช่นกัน และ `app.updateModelContext` ในโหมดนี้ส่งเฉพาะ Workspace ID ที่มองเห็น ไม่ส่งชื่อ Workspace หรือ Absolute Path แต่ **Model Context ก่อนเปิดโหมดหรือเนื้อหาในประวัติแชทไม่สามารถย้อนลบได้** จึงควรเริ่ม **แชทใหม่สำหรับ Workshop**
- โหมดเป็น **การจำกัดการแสดงผล ไม่ใช่ Security Boundary**: เครื่องมือ DWB อื่น, filesystem, สิทธิ์ผู้ใช้และ `allowedDirectories` ยังทำงานตามเดิม; ห้ามใช้ Presentation Mode แทนการตั้งค่า Allowed Directories หรือการลบความลับออกจากเนื้อหาที่จะสาธิต
- Settings เป็นแบบ **Local DWB / Global ต่อ Registry** ข้าม Refresh, เปิดแชทใหม่ และ Restart (โดยยังใช้ฐานข้อมูลเดิม); Presentation Mode ไม่ปิดเองเมื่อเปลี่ยนแชท ส่วน Panel ที่เปิดค้างอยู่จากก่อนเปลี่ยนโหมดอาจยังมี Snapshot เก่า **ให้ปิดและเปิดทุก Panel ใหม่ก่อนอัดคลิป**
- เมื่อเปิด Panel ใหม่ ตัว UI จะโหลด Snapshot ล่าสุดก่อนวาดรายชื่อ และซ่อนข้อมูลเก่าระหว่าง Refresh; ไม่แสดง raw exception พร้อม Path ระหว่างอัดคลิป เพื่อช่วยลดการ Flash ข้อมูล
- ก่อนเริ่มอัดควรตรวจ **หน้าจอจริง** ว่าไม่มีชื่อองค์กร/พาธในแชทเก่า, หน้าต่างอื่น, Terminal, Model replies หรือ App/Tool อื่นที่กำลังเปิด; Presentation Mode ควบคุมเฉพาะ Companion UI และ Context Sync ใหม่

## อ่านเพิ่มเติม

- https://openai.com/index/gpt-6-for-everyone/
- https://developers.openai.com/plugins/build/extensions
- https://github.com/openai/mcp-extensions/blob/main/docs/spec.md
