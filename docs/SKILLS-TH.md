# Agent Skills ใน DWB MCP Studio

Agent Skills ช่วยให้ AI ใช้ขั้นตอนการทำงานที่ติดตั้งไว้ เช่น การเคลียร์ requirement, TDD, code review หรือ security review โดยผู้ใช้ไม่ต้องจำ path ของ `SKILL.md` หรือ copy Skill ไปทุกโปรเจกต์

## แนวคิด

- ติดตั้ง Skill ครั้งเดียวใน DWB MCP Studio
- DWB เก็บสำเนาแบบ managed ไว้ใน data directory ของโปรแกรม
- แต่ละ Workspace เลือก policy ของ Skill ได้เอง
- Agent เห็นเฉพาะ catalog และ policy ผ่านเครื่องมือ `skills`
- companion files ของ Skill อ่านได้หลัง Skill ถูก activate แล้ว

## Policy

| Policy | ความหมาย                                                              |
| ------ | --------------------------------------------------------------------- |
| AUTO   | Agent ใช้ Skill เองได้เมื่อเห็นว่าเหมาะกับงาน                         |
| ASK    | Agent ต้องถามผู้ใช้ก่อน แล้วรอคำตอบยืนยันใน turn ถัดไป                |
| MANUAL | Agent ไม่หยิบมาใช้เอง ใช้เมื่อผู้ใช้เรียก Skill/capability นั้นโดยตรง |

ค่าเริ่มต้นของ Skill ใช้กับทุก Workspace ที่ยังไม่มี override และแต่ละ Workspace เปลี่ยนค่าได้โดยไม่กระทบ Workspace อื่น

## ติดตั้งจากหน้า Studio

เปิด **Dashboard → Agent Skills** แล้วเลือกได้ 3 ทาง: **Recommended**, **GitHub** หรือ **โฟลเดอร์** ที่มี `SKILL.md`

Recommended ปัจจุบันมี **GoLive** (ASK) สำหรับ assisted deployment และ **BRAG Slim** (MANUAL) สำหรับสร้าง launch video / poster / share copy จากโปรเจกต์หรือเว็บไซต์

ตัวอย่าง project-local Skill เดิมเลือกได้จาก:

`.agents\skills\grilling`

หลังติดตั้ง Studio จะ copy ทั้ง package เข้า managed library จึงไม่ต้องพึ่งไฟล์ต้นฉบับตอนใช้งานปกติ Package V1 รับเฉพาะไฟล์/โฟลเดอร์ปกติ ไม่รับ symbolic link/submodule และจำกัด 512 files / 8 MiB ต่อ Skill

การติดตั้งจาก GitHub รองรับ repository URL และ `/tree/<ref>/<skill-path>` โดย DWB resolve commit และดาวน์โหลดเฉพาะ package ของ Skill ที่เลือก ไม่ดาวน์โหลด binary/asset ส่วนอื่นของ repository ที่อยู่นอก skill directory

## ASK ทำงานอย่างไร

1. Agent เห็นว่า Skill แบบ ASK เหมาะกับงานและเรียก activate
2. DWB คืน `approval_required` พร้อม request ID โดยยังไม่ส่งคำสั่งใน Skill ให้ Agent
3. Agent ถามผู้ใช้ในแชท เช่น “งานนี้เหมาะกับ Grilling Skill ต้องการใช้ไหม?”
4. ผู้ใช้ตอบยืนยันใน turn ถัดไป
5. Agent retry request ID เดิมพร้อม confirmation
6. DWB ส่ง `SKILL.md` และเปิด session lease ให้ Skill
7. companion files อ่านผ่าน DWB ได้ระหว่าง activation

ผู้ใช้สามารถเปิดหน้า **Agent Skills** แล้วกด **อนุมัติ / ปฏิเสธ** pending request แทนการตอบในแชทได้ด้วย

Pending ASK หมดอายุประมาณ 10 นาที และ approval หนึ่งรายการใช้ activate ได้ครั้งเดียว

การติดตั้งทับจะยกเลิก approval และ activation เดิมทุกครั้ง รวมถึงกรณีแก้เฉพาะ companion files โดยเก็บค่า policy และ Workspace override ไว้ Agent ต้อง activate เวอร์ชันที่ติดตั้งใหม่อีกครั้ง

## อ่านไฟล์ขนาดใหญ่

`skills` action `read_file` ส่งไฟล์เป็นช่วง ครั้งละ 8192 bytes โดยค่าเริ่มต้น ใช้ `offset` จาก `nextOffset` ในคำตอบเพื่ออ่านต่อจน `nextOffset` เป็น `null` และกำหนด `length` ได้ตั้งแต่ 4 ถึง 65536 bytes ขอบเขตแต่ละช่วงจะไม่ตัดอักขระ UTF-8 กลางตัว

คำตอบจากเครื่องมือ Skills ผ่าน payload guard เช่นเดียวกับผลลัพธ์ของ worker หากถูกจำกัดให้ลด `length` แล้วอ่านช่วงเดิมอีกครั้ง หากคำสั่งตอน activate ยาวเกินเพดาน ให้อ่าน `SKILL.md` ผ่าน `read_file` จนครบก่อนทำตามขั้นตอน

## MANUAL

MANUAL เหมาะกับ Skill ที่ไม่ต้องการให้ Agentเสนอหรือเรียกเอง เช่น full security audit ผู้ใช้ยังพิมพ์ตามธรรมชาติได้ เช่น:

> ใช้ security audit ตรวจ feature นี้ให้หน่อย

## Workspace override

เลือก Workspace ด้านบนของหน้า Agent Skills แล้วเลือก Skill จากรายการ จากนั้นตั้ง AUTO / ASK / MANUAL แล้วกด **บันทึก Workspace**

กด **ใช้ค่าเริ่มต้น** เพื่อลบ override ของ Workspace นั้น

## ข้อมูลที่เก็บ

Skill registry และ policy เก็บแยกจากฐาน workspace เดิมใน `runtime/skills.db` ส่วน package ที่ติดตั้งเก็บใต้ `skills/` ใน DWB data directory

การแยกฐานข้อมูลช่วยให้เพิ่ม/ถอด Skill โดยไม่เปลี่ยน schema ของ workspace/session เดิม

## ขอบเขตความปลอดภัย

Policy Skill เป็น **พฤติกรรมและการยินยอมของผู้ใช้** ไม่ใช่ OS sandbox หรือ security boundary ต่อ process ที่ผู้ใช้อนุญาตให้รันอยู่แล้ว

- ASK ไม่แทน command/file approval
- Workspace guard และ `allowedDirectories` ยังทำงานแยกตามเดิม
- `install_local` ผ่าน MCP chat ยังจำกัด source ให้อยู่ภายใน Workspace ที่ bind
- `install_github` / `install_recommended` ผ่าน MCP chat ทำได้เฉพาะเมื่อ request ปัจจุบันของผู้ใช้สั่งติดตั้ง remote Skill อย่างชัดเจน
- การติดตั้งจากหน้า Studio เกิดจากการกดของผู้ใช้โดยตรง ทั้ง Recommended, GitHub และ local folder
- `SKILL.md` และ companion files ไม่ให้สิทธิ์ filesystem เพิ่มขึ้นเอง

## ตัวอย่างใช้งานง่าย

> อยากเพิ่ม recurring booking ให้ระบบนี้

หาก Grilling = ASK, Agent สามารถเสนอ Skill และถามก่อนใช้

> ทำต่อแบบ TDD

หาก TDD = AUTO, Agent สามารถ activate และทำตามขั้นตอน TDD ได้โดยไม่ต้องให้ผู้ใช้จำชื่อไฟล์หรือ path

## การทดสอบอัตโนมัติ

- `npm test`: policy, consent, payload, การเปิดฐานข้อมูลใหม่, การติดตั้งพร้อมกันจากสอง store และการถอนติดตั้งระหว่างอ่านไฟล์
- `npm run test:skills-ui` (Windows): เรียก click handlers ของปุ่มจริง แล้วตรวจฐานข้อมูลจาก process แยก ครอบคลุมติดตั้ง, default/Workspace override, การแยก Workspace, อนุมัติ/ปฏิเสธ, ยกเลิกถอนติดตั้ง, เปิดหน้าต่างใหม่ และถอนติดตั้งจริง
- `npm run test:upgrade`: จำลองการย้าย dependencies ไป installation ใหม่ และตรวจว่า package, policy, override และ pending consent ใน data directory เดิมยังใช้งานได้

UI test ใช้โฟลเดอร์ชั่วคราวและแทนเฉพาะ folder chooser กับกล่องยืนยันด้วยคำตอบทดสอบ จึงไม่ต้องให้ผู้ใช้กดเอง แต่ยังไม่แทนการตรวจหน้าตา การเลือกโฟลเดอร์จริง หรือการทดสอบติดตั้งรุ่นเผยแพร่บนเครื่องใหม่ Windows CI เรียก Skills UI test หลังชุดทดสอบหลัก
