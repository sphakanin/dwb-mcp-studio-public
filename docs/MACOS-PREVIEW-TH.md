# DWB MCP Studio บน macOS — รุ่นเตรียมทดสอบ

เพิ่มหน้าต่างแอป, Dashboard, Setup, managed Tunnel, Keychain, menu bar และตัวเลือกเปิดพร้อมเครื่องแล้ว
สถานะยังเป็น **candidate ที่ต้องทดสอบบน Mac จริง** ไม่ใช่รุ่น macOS ที่ผ่านการรับรองพร้อมแจกทั่วไป
ดูผลที่ตรวจแล้วใน [บันทึกการทดสอบ](MACOS-PREVIEW-VALIDATION.md)

## เตรียมเครื่อง

- macOS 13 ขึ้นไป บน Apple Silicon หรือ Intel
- Node.js 22.16 ขึ้นไปพร้อม npm
- Apple Command Line Tools สำหรับ build แอปจาก source ครั้งแรก หากยังไม่มี รัน `xcode-select --install`
- อินเทอร์เน็ตสำหรับ npm และดาวน์โหลด tunnel-client

ใช้ ZIP ที่ชื่อลงท้าย `macos-source.zip` แล้วแตกไฟล์ไว้ในโฟลเดอร์ที่เขียนได้
แพ็กนี้ไม่รวม Node, third-party binaries, การตั้งค่าส่วนตัว หรือ API key

1. เปิด `Install DWB MCP Studio.command` หากเปิดจาก Finder ไม่ได้ ให้เปิด Terminal ในโฟลเดอร์ที่แตกไฟล์แล้วรัน:

   ```sh
   zsh "Install DWB MCP Studio.command"
   ```

2. ตัวติดตั้งสร้าง `DWB MCP Studio.app` สำหรับเครื่องนี้แล้วเปิดแอปให้
3. ใน **ตั้งค่าเครื่อง** เลือกโฟลเดอร์งานและจำนวน worker แล้วกด **ติดตั้งและบันทึก**
4. กรอก Tunnel ID และ API key เลือกจำ key ใน Keychain ได้ แล้วกด **Start MCP**
5. เมื่อขึ้น Ready ให้เรียก `dwb_broker_status` และ `dwb_session_status` จากแชทเพื่อยืนยันครบเส้นทาง

ต้องสร้าง tunnel และเชื่อมกับ ChatGPT ตามระบบ OpenAI ก่อน ใช้ Tunnel ID คนละตัวกับการเชื่อมต่ออื่นที่กำลังเปิดอยู่
Setup ดาวน์โหลด Desktop Commander 0.2.50 และ tunnel-client 0.0.11 สำหรับ architecture ของ Node ที่ติดตั้ง
ตรวจ checksum ของ tunnel ก่อนแตกไฟล์ และติดตั้งลง `external/macos-preview` ของโปรแกรมนี้เท่านั้น

**เก็บ `.app` ไว้คู่กับโฟลเดอร์ source นี้** แอปเรียก scripts ที่อยู่ข้างกัน
การ build นี้ลงลายเซ็น ad-hoc สำหรับใช้ทดสอบในเครื่อง ยังไม่ได้เซ็นด้วย Developer ID หรือ notarize เพื่อแจกเป็นแอปสำเร็จรูป

## การใช้งานและข้อมูลที่บันทึก

- ปุ่มปิดหน้าต่างซ่อนลง menu bar โดยค่าเริ่มต้น คลิกเมนู DWB เพื่อเปิดกลับ
- เปลี่ยนพฤติกรรมปุ่มปิด/ปุ่มย่อได้ใน **การเปิดและปิดแอป**
- เลือกเปิดพร้อมเข้าสู่ระบบครั้งถัดไปได้ และเลือก Start MCP อัตโนมัติเมื่อบันทึก key ใน Keychain แล้ว
- การลืม key จะปิด Start MCP อัตโนมัติด้วย
- **Stop MCP** หยุด tunnel แล้วขอให้ broker ปิดเมื่อไม่มีงานค้าง หากยังมีงานจะแจ้งให้รอ
- **หยุด MCP และออกจากแอป** จะตรวจงานค้างก่อนปิด ไม่ปิด broker ของ installation อื่น

ข้อมูลอยู่ใน:

```text
~/Library/Application Support/DWB-MCP-Studio-Mac-Preview/
```

API key อยู่ใน Keychain ไม่อยู่ใน config, command-line arguments หรือ profile
หน้าควบคุมฟังเฉพาะ loopback และตรวจ token พร้อม Host/Origin ก่อนรับคำสั่ง
หากต้องใช้ local MCP client ให้ใช้ไฟล์ `mcp-client.json` ใน data directory

หากย้ายหรืออัปเดต source ให้จบงาน กด Stop และออกจากแอปเดิมก่อน
จากนั้นเปิดตัวติดตั้งในโฟลเดอร์ใหม่และกด Setup อีกครั้ง ข้อมูล workspace และ Keychain ยังใช้ data directory เดิม
Setup จะเตรียมส่วนประกอบของโฟลเดอร์ใหม่และปรับ path ให้ รวมถึง path เปิดพร้อมเข้าสู่ระบบ

## ทดสอบบนเครื่อง Mac ที่ยืมมา

ใช้ workspace ทดลองที่เจ้าของเครื่องอนุญาต เช่น:

```sh
mkdir -p "$HOME/DWB-Test-Workspace"
```

หลัง Setup สำเร็จ เปิด Terminal ในโฟลเดอร์ source แล้วรัน:

```sh
node scripts/macos/preview.mjs doctor
npm run test:platform
npm run test:mac
node scripts/macos/native-test.mjs
node scripts/macos/runner-test.mjs
```

- `test:mac` ใช้ข้อมูลชั่วคราวแยก ตรวจสอง client/สอง worker, อ่านเขียนไฟล์, zsh และกู้ worker/broker หลังบังคับปิด
- `native-test` สร้าง key ทดสอบคนละรายการใน Keychain แล้วลบเฉพาะรายการนั้นเมื่อจบ
- `runner-test` ตรวจว่าการปิด supervisor ไม่ทิ้ง process ลูกหลานค้าง
- ต้องเห็น `MAC_PREVIEW_CORE_PASS platform=darwin` ไม่ใช้ผล `win32` แทนผล Mac

ทดสอบผ่านหน้าต่างจริงเพิ่มเติม: เลือกโฟลเดอร์, Start/Stop, สองแชท, workspace alias,
จำ/ลืม key, ปุ่มปิด/ย่อ, เปิดซ้ำ, ออกจากระบบแล้วเข้าใหม่, sleep/wake และสิทธิ์โฟลเดอร์
ทดสอบ APFS แบบแยกตัวพิมพ์ด้วยเมื่อมีเครื่องหรือ volume ที่เหมาะสม

ส่งกลับรุ่น macOS, Apple Silicon/Intel, Node/npm version และผล PASS/ข้อความผิดพลาด
ไม่ส่ง API key หรือไฟล์ส่วนตัวของเจ้าของเครื่อง

## CLI สำหรับ Core

เมื่อปิดแอปแล้ว สามารถ Setup/Stop ผ่าน CLI ได้:

```sh
node scripts/macos/preview.mjs setup --workspace "$HOME/DWB-Test-Workspace"
node scripts/macos/preview.mjs stop
```

`node scripts/macos/preview.mjs start` เป็น stdio server สำหรับ local MCP client ไม่ใช่ปุ่ม Start Tunnel
CLI กับหน้าต่างแอปใช้ installer ชุดเดียวกันและมี lock ป้องกันทำงานซ้อน

## Windows

Windows ยังคงเปิด `DWB MCP Studio.exe` และใช้ WPF, DPAPI, tray และ startup แบบเดิม
การเพิ่ม Mac ไม่ย้าย data directory หรือเปลี่ยนข้อมูล Windows ของผู้ใช้
