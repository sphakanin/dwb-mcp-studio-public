# DWB MCP Studio Core

Windows Beta · 0.1.0-beta.15

สำหรับ **Ubuntu / remote VPS**: เพิ่มตัวติดตั้งผ่าน terminal พร้อม Bash, OpenAI Tunnel และ user systemd service แล้ว ดู [คู่มือติดตั้ง Ubuntu](docs/UBUNTU-TH.md) ใช้ `bash install.sh --workspace /absolute/folder` หลังติดตั้ง Node.js 22.16+, curl และ unzip รุ่น Ubuntu นี้ยังเป็น candidate ระหว่างตรวจแพลตฟอร์มก่อนแจก

สำหรับ macOS: เพิ่ม [แอป Setup/Dashboard, Tunnel, Keychain และ menu bar](docs/MACOS-PREVIEW-TH.md) ใน source แล้ว รุ่นนี้ยังต้องทดสอบบน Mac จริงก่อนแจกทั่วไป ดู [ผลการตรวจ Windows และรายการตรวจ Mac](docs/MACOS-PREVIEW-VALIDATION.md)

## ดาวน์โหลดและเริ่มใช้

- [Windows beta.15 ZIP](https://github.com/sphakanin/dwb-mcp-studio-public/releases/download/v0.1.0-beta.15/dwb-mcp-studio-core-0.1.0-beta.15-windows.zip) — แตกทั้งชุดแล้วเปิด DWB MCP Studio.exe
- [Ubuntu beta.15 source ZIP](https://github.com/sphakanin/dwb-mcp-studio-public/releases/download/v0.1.0-beta.15/dwb-mcp-studio-0.1.0-beta.15-ubuntu-source.zip) — รุ่นทดลองสำหรับ terminal/VPS ยังไม่มี DWB Dashboard
- [หน้า Releases และไฟล์ SHA-256](https://github.com/sphakanin/dwb-mcp-studio-public/releases/tag/v0.1.0-beta.15)

- **ใช้ Git:** clone repository นี้ แล้วเปิด `DWB MCP Studio.exe` ในโฟลเดอร์ที่ clone มา
- **ดาวน์โหลด source ZIP:** แตกไฟล์ แล้วเปิด `DWB MCP Studio.exe` ได้เหมือนกัน
- **ใช้แพ็กที่ build แล้ว:** ดาวน์โหลด ZIP ของ DWB จากหน้า Releases แล้วเปิด `DWB MCP Studio.exe`

Setup เตรียมโปรแกรมจาก source ให้เองเมื่อยังไม่มี `dist` และดาวน์โหลด Desktop Commander กับ tunnel-client ลง `external` ของโฟลเดอร์นี้ หลังติดตั้ง กรอก **Tunnel ID + API key → Start MCP** ต้องมี Node.js 22.16 ขึ้นไปพร้อม npm

โค้ด DWB ใช้ [MIT License](LICENSE) ส่วนโปรแกรมภายนอกมี license ของเจ้าของตาม [THIRD-PARTY](THIRD-PARTY.md) หากจะเผยแพร่ repository ดู [แนวทางเผยแพร่ผ่าน Git](docs/PUBLISHING.md)

## เกี่ยวกับโปรแกรม

ตัวกลาง MCP สำหรับใช้ **Desktop Commander หลาย worker** พร้อมระบบกู้การเชื่อมต่อและป้องกันการเขียนไฟล์ทับข้าม session

ใช้ Setup เตรียมเครื่องและการเชื่อมต่อ ตั้งชื่อ workspace เพื่อเรียกใช้ในแชทถัดไป และดูสถานะ worker กับงานที่กำลังทำผ่าน Dashboard

### Agent Skills ใน beta.15

Source ปัจจุบันเพิ่มหน้า **Agent Skills** ใน Dashboard สำหรับติดตั้ง Skill ครั้งเดียวจาก **Recommended Skills, GitHub หรือ local folder** แล้วตั้งพฤติกรรมแยกแต่ละ Workspace เป็น **AUTO**, **ASK** หรือ **MANUAL** ได้

- AUTO — Agent ใช้เองเมื่อเหมาะกับงาน
- ASK — Agent ถามผู้ใช้ในแชทก่อน และรอคำตอบยืนยันใน turn ถัดไป
- MANUAL — ใช้เมื่อผู้ใช้เรียก Skill/capability นั้นโดยตรง
- Workspace แต่ละตัว override ค่า default ของ Skill ได้
- ASK ที่รออยู่สามารถอนุมัติ/ปฏิเสธจากหน้า Studio ได้เช่นกัน

อ่าน [คู่มือ Agent Skills](docs/SKILLS-TH.md) สำหรับ flow, storage และขอบเขตความปลอดภัย หน้า Studio มี **GoLive** (ASK) สำหรับพาแอปจาก local ไปสู่ deployment และ **BRAG Slim** (MANUAL) สำหรับสร้าง launch video, poster และ share copy จากงานที่ทำเสร็จแล้ว การติดตั้ง GitHub แบบระบุ skill path ดาวน์โหลดเฉพาะ package นั้น และ remote install จากแชทต้องเกิดจากคำสั่งของผู้ใช้โดยตรง

### ปรับปรุงใน beta.14

เพิ่มปุ่ม **การเปิดและปิดแอป** ใน Dashboard และเมนู tray เลือกเปิดพร้อม Windows, Start MCP อัตโนมัติ, ปุ่ม × ซ่อนหรือปิดแอป และปุ่ม − ย่อที่ taskbar หรือ tray ได้ โปรแกรมจำค่าข้ามรุ่น ดู [ตัวเลือกการเปิดและปิด](docs/APP-PREFERENCES-TH.md)

### ปรับปรุงใน beta.13

- ล็อกไฟล์ใช้ path จริงร่วมกันเมื่อสะกดตัวพิมพ์ต่างกันหรือผ่าน junction และตรวจขอบเขต workspace อีกครั้งก่อนส่งงาน
- คำขอที่หมดเวลาขณะรอจะไม่ถูกส่งไปทำทีหลัง งานที่เริ่มแล้วคงล็อกจนจบและแจ้งให้ตรวจผลก่อนสั่งซ้ำ
- ลงทะเบียน workspace/alias แบบครบชุดหรือไม่บันทึก และแสดงเมื่อบันทึก session ไม่สำเร็จ
- ป้องกัน restart/update ขณะ worker มี process หรือ search ที่ยังทำงาน
- แสดงรุ่น broker ที่รันจริงและสลับ runtime ผ่าน Setup โดยใช้ Tunnel ID, key และ workspace เดิม
- กรอง heartbeat ออกจากเหตุการณ์ล่าสุด พร้อมเพิ่มการทดสอบก่อนแจก

### ปรับปรุงใน beta.12

- เปิด **DWB MCP Studio.exe** อันเดียว: Setup, Dashboard และตั้งค่า Tunnel อยู่ในแอปเดียวกัน
- ใช้โลโก้ DWB สำหรับไอคอนเปิดโปรแกรม หน้าต่าง taskbar และถาดไอคอนข้างนาฬิกา
- กด × หรือย่อเพื่อซ่อนลงถาดไอคอน คลิกไอคอน DWB เพื่อเรียกกลับ (Windows อาจเก็บไว้ใต้ลูกศร ^)
- เปิดซ้ำจะเรียกหน้าต่างเดิมของโฟลเดอร์โปรแกรมนั้นกลับมา
- คลิกขวาที่ไอคอนถาด → **ออกจากหน้าควบคุม (MCP ยังทำงาน)** เพื่อปิดหน้า UI จริง ๆ; กด Stop ใน Dashboard เมื่อต้องการหยุด tunnel
- การตั้งค่าและส่วนประกอบเดิมย้ายตามขั้นตอนอัปเดต beta.11 ได้

### ปรับปรุงใน beta.10

- เพิ่ม **Core Dashboard** สำหรับดู Tunnel, Broker, worker, workspace, session, คิวและเหตุการณ์ล่าสุด
- เปิด `DWB MCP Studio.exe` แล้วใช้ Start/Stop และตั้งค่าจากหน้าเดียว
- รีเฟรชทุก 3 วินาทีโดยไม่สร้าง session/worker เพิ่ม อ่าน [วิธีใช้ Dashboard](docs/DASHBOARD.md)

![Core Dashboard](docs/dashboard.png)

### ปรับปรุงใน beta.9

- Setup ดาวน์โหลดส่วนประกอบลง `external` ของ DWB นี้ พร้อมตรวจรุ่นและ checksum
- ยกเลิกการค้นหา tunnel-client จาก PATH และการเลือก Desktop Commander จากแอปอื่น
- ตั้ง path ให้อัตโนมัติ แล้วเข้าสู่หน้า Tunnel ID + API key → Start MCP

### ปรับปรุงใน beta.8

- หลังตั้งค่าเครื่อง ใช้เพียง **Tunnel ID + API key → Start MCP** โปรแกรมสร้าง config และเปิด tunnel-client ที่ติดตั้งไว้ให้เอง
- เปิด `DWB MCP Studio.exe` ครั้งถัดไป เพื่อ Start/Stop และดูสถานะ ไม่ต้องแก้ JSON/YAML หรือเขียน MCP command
- ค้นหา tunnel-client จาก PATH และตำแหน่งติดตั้งทั่วไป หากไม่พบเลือกไฟล์เพียงครั้งแรก
- จำ API key ด้วย Windows DPAPI สำหรับบัญชีผู้ใช้ปัจจุบัน เลือกไม่จำได้ ไม่ใส่ key ลง profile/command line และไม่ส่งต่อไปยัง DWB broker/worker

### ปรับปรุงใน beta.7

- แก้ resume จากแชทใหม่ให้คำขอถัดไปยังใช้ session/workspace ที่เลือก รวมถึงหลัง reconnect และ broker restart
- เก็บตัวระบุการเชื่อมต่อแยกจากโฟลเดอร์เริ่มต้นของ session เพื่อ resume ได้แม้ adapter ใหม่เริ่มจากคนละโฟลเดอร์
- แก้การเลือก ID แชท: ไม่ใช้ request/run/trace ID หรือชื่อหัวข้อแชทเป็นตัวแบ่ง worker
- ผ่านการทดสอบ Node.js 22.16, Desktop Commander 0.2.50 ที่ติดตั้งใหม่จาก npm และ Setup จาก ZIP ในโฟลเดอร์/ข้อมูลใหม่
- ผ่านการเชื่อมต่อ HTTP ด้วย tunnel-client ภายนอกในโหมด local รวมถึงเปิดแชทใหม่เลือก workspace ด้วย alias ดูขอบเขตที่ตรวจแล้วใน [VALIDATION](docs/VALIDATION.md)

### ปรับปรุงใน beta.6

- เพิ่มคู่มือ Workspace ภาษาไทยแบบออฟไลน์ พร้อมตัวอย่างการบอกโฟลเดอร์ครั้งแรก ตั้งชื่อ/alias และเลือก workspace ในแชทใหม่
- เพิ่มปุ่ม **วิธีใช้ Workspace** ในหน้า Setup และหัวข้อเริ่มใช้ workspace ใน README

### ปรับปรุงใน beta.5

- เมื่อผู้ใช้บอก working directory คำสั่ง MCP แนะนำให้ AI เรียก `workspace` เพื่อ register และ bind ในขั้นตอนเดียว ไม่ต้องให้ผู้ใช้สั่งสร้าง workspace ซ้ำ
- ผูกกับโฟลเดอร์ที่ระบุโดยตรง รวมถึงโฟลเดอร์ย่อยของ workspace ที่มีอยู่แล้ว
- worker เริ่มในโฟลเดอร์ที่ผูกกับแชทนั้น การเปลี่ยนโฟลเดอร์จะคืน worker ว่างเดิมและเปิดตัวใหม่เมื่อมีคำขอถัดไป โดยไม่กระทบ worker ของแชทอื่น
- ถ้ายังมีคำขอ/process/search ทำงานอยู่ จะไม่เปลี่ยนโฟลเดอร์กลางงาน
- แสดง `workingDirectory` แยกจาก `workspaceKey` ซึ่งใช้ระบุโฟลเดอร์เริ่มต้นของ adapter สำหรับ reconnect

### ปรับปรุงใน beta.4

- แก้จังหวะหลาย session แย่ง worker ว่างจนจำนวน process เกิน cap
- นับคำขออ่าน resource และรายการ tools/resources เป็นงานที่กำลังทำ ป้องกันการคืน worker ระหว่างใช้งาน
- รอ worker ที่กำลังเริ่มหรือปิดให้จบก่อนคืนโควตา และป้องกัน restart/resume แทรกระหว่างคำขอที่ยังไม่จบ
- แสดงตำแหน่งคิวและเวลารอใน `dwb_session_status`
- เพิ่ม `node scripts/doctor.mjs` ดูผลตรวจการตั้งค่า พร้อมสถานะ broker ที่กำลังทำงาน โดยไม่เปิด worker เพิ่ม

```text
MCP client / external tunnel
  ├─ stdio adapter A ─┐
  ├─ stdio adapter B ─┼─ DWB Broker ─┬─ worker A
  └─ stdio adapter C ─┘             ├─ worker B
                                   └─ worker C
```

## เริ่มใช้งานจาก ZIP

ต้องมี Windows x64/ARM64 และ [Node.js](https://nodejs.org/en/download) 22.16 ขึ้นไปพร้อม npm จากนั้น:

1. แตก ZIP ไปยังโฟลเดอร์ที่คุณเขียนไฟล์ได้ แล้วเปิด `DWB MCP Studio.exe`
2. เลือกโฟลเดอร์งานและจำนวน worker แล้วกด **ติดตั้งและเตรียมใช้งาน**
3. Setup ดาวน์โหลด Desktop Commander **0.2.50** จาก npm และ tunnel-client **0.0.11** จาก release ของ OpenAI ลง `external` ของ DWB นี้ ตรวจ checksum ของ tunnel แล้วตั้ง path ให้เอง ไม่มีช่องเลือกโปรแกรมจากแอปอื่น
4. หน้า Dashboard จะเปิดขึ้น กด **Start MCP** เพื่อกรอก **Tunnel ID + API key** ครั้งแรก หรือกด **ตั้งค่า Tunnel / API key**
5. ใน ChatGPT ที่เชื่อม tunnel นี้ เรียก `dwb_broker_status` และ `dwb_session_status` เพื่อทดสอบครบเส้นทาง

```text
DWB-MCP-Studio/
├─ DWB MCP Studio.exe
├─ scripts/
└─ external/
   ├─ desktop-commander/
   └─ tunnel-client/
```

ครั้งต่อไปเปิด `DWB MCP Studio.exe` แล้วกด Start ได้เลย หากเลือกจำ key จะเก็บแบบเข้ารหัสด้วยบัญชี Windows นี้ ค่าเริ่มต้นเมื่อปิดหน้าต่างจะซ่อนลง tray โดย tunnel ยังทำงาน เลือกเปิดพร้อม Windows / Start MCP อัตโนมัติ หรือเปลี่ยนให้ปุ่ม × ปิดแอปและหยุด MCP ได้ใน **การเปิดและปิดแอป**

โปรแกรมที่ติดตั้งไว้ใน PATH หรือโฟลเดอร์อื่นจะไม่ถูกนำมาใช้ใน Setup/Start MCP ของ DWB ไม่ดาวน์โหลดซ้ำเมื่อส่วนประกอบในแอปนี้มีรุ่นที่รองรับอยู่แล้ว การติดตั้งที่ล้มเหลวจะอยู่ใน staging แยก จึงลองใหม่ได้

ZIP ที่แจกยังมีเฉพาะ DWB ไม่มี third-party binary หรือ `external` ที่ติดตั้งแล้ว การดาวน์โหลดเกิดบนเครื่องผู้ใช้เมื่อกดติดตั้ง ดู [แหล่งดาวน์โหลดและการแยกโฟลเดอร์](docs/EXTERNAL.md)

ข้อมูล workspace, config และ key ยังคงอยู่ใน `%LOCALAPPDATA%\DWB-MCP-Studio` เมื่อย้ายโฟลเดอร์โปรแกรมให้เปิด Setup ใหม่เพื่อตั้ง path ส่วนตัวโปรแกรมภายนอกอยู่ใน `external` ของแต่ละ installation

ยังต้องสร้าง tunnel บน OpenAI และเชื่อมกับ ChatGPT ตามระบบของ OpenAI ใช้ **Tunnel ID คนละตัวกับระบบเดิมที่กำลังเปิดอยู่** DWB สร้างโปรไฟล์แยกใน data directory และเลือกพอร์ตว่างอัตโนมัติ สถานะพร้อมเป็นผลจาก tunnel-client; ยืนยันการใช้งานครบเส้นทางด้วยการเรียกเครื่องมือจากแชท

สำหรับ local MCP client ใช้ไฟล์ `%LOCALAPPDATA%\DWB-MCP-Studio\mcp-client.json` ที่ Setup สร้างให้ ดู [การเชื่อมต่อ](docs/CONFIGURATION.md) `node scripts/start.mjs` เป็น stdio server ให้ client เปิด ส่วน `DWB MCP Studio.exe` เป็นหน้าต่างสำหรับ Start/Stop OpenAI Tunnel

เปิด `node scripts/doctor.mjs` เพื่อตรวจ config และสถานะ broker โดยไม่เปิด worker เพิ่ม สถานะ `stopped` เป็นปกติก่อน client เชื่อมต่อ

![ตั้งค่าเครื่อง](docs/setup.png)
![Start MCP](docs/tunnel-setup.png)

## ใช้ชื่อ Workspace แทนการพิมพ์ directory ซ้ำ

**Workspace คือชื่อที่ผูกกับโฟลเดอร์งาน** ช่วยให้แชทเลือกโปรเจกต์และเริ่ม worker ในโฟลเดอร์ที่ถูกต้อง อ่าน [คู่มือ Workspace พร้อมตัวอย่าง](docs/workspaces.html) ได้ออฟไลน์ หรือกด **วิธีใช้ Workspace** ใต้ช่องโฟลเดอร์งานใน Setup

### ครั้งแรก: บอกโฟลเดอร์และชื่อที่จำง่าย

> ทำงานใน D:\Projects\coffee-shop ตั้งชื่อ workspace ว่า “ร้านกาแฟ” และเพิ่ม alias “coffee-shop” ให้ด้วย

เปลี่ยน path เป็นโฟลเดอร์ที่มีอยู่จริงของคุณ AI ควรลงทะเบียนและผูก workspace ให้ด้วยคำสั่งเดียว ไม่ต้องสั่งสร้างแยก หากบอกเฉพาะ path ชื่อเริ่มต้นจะเป็นชื่อโฟลเดอร์ เช่น `coffee-shop` ส่วน **alias** คือชื่อเรียกเพิ่มเติมที่ชี้ไปโฟลเดอร์เดียวกัน

### แชทใหม่: เรียกชื่อที่เคยลงทะเบียนไว้

> ทำงานใน workspace ร้านกาแฟ

หรือ “ทำ coffee-shop ต่อ ช่วยตรวจหน้าเมนูให้หน่อย” AI จะค้นชื่อหรือ alias แล้วผูก workspace ให้แชทใหม่ โดยใช้ข้อมูล workspace ชุดเดิมของ DWB ในเครื่องคุณ

| สถานการณ์                   | สิ่งที่ควรทำ                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------- |
| พบชื่อ/alias ตรงรายการเดียว | เลือก workspace นั้นได้ ไม่ต้องพิมพ์ path ซ้ำ                                           |
| ชื่อซ้ำหรือพบหลายรายการ     | เลือกจากชื่อและโฟลเดอร์ที่แสดง หรือระบุ path/ID ให้ตรงตัว                               |
| ไม่รู้จักชื่อนั้น           | บอกโฟลเดอร์ครั้งแรกและตั้งชื่อไว้ก่อน                                                   |
| ไม่บอกชื่อหรือโฟลเดอร์      | แชทใหม่ยังไม่มี binding และ worker ใช้โฟลเดอร์เริ่มต้นจาก Setup ไม่ได้เลือกจากแชทล่าสุด |

ถามว่า **“แสดง workspace ที่มี พร้อมโฟลเดอร์”** เพื่อดูรายการ หรือ **“แชทนี้ใช้ workspace ไหนและ working directory อะไร?”** เพื่อตรวจว่าอยู่ถูกโปรเจกต์ ถ้าจะเปลี่ยน ให้บอก **“เปลี่ยนแชทนี้ไปใช้ workspace ร้านกาแฟ”**; หากยังมีงานรันอยู่ ต้องให้งานจบก่อนเปลี่ยน

แชทสองอันใช้ workspace เดียวกันได้และใช้ไฟล์ชุดเดียวกัน แต่แยก worker เมื่อ client ส่งข้อมูลพอให้แยก session ได้ การเลือก workspace ไม่ได้ส่งประวัติแชทหรือต่อ process เดิมให้เอง และไม่ขยายสิทธิ์ไฟล์ที่ตั้งไว้ใน `base-policy.json`

ตัว broker รับคำสั่ง MCP จาก AI ไม่ได้อ่านข้อความโดยตรง หาก AI ยังไม่ผูก workspace ให้ บอกว่า **“ใช้เครื่องมือ workspace ผูกโฟลเดอร์นี้ก่อนเริ่มงาน”** การเลือกโฟลเดอร์ใน Setup เพียงอย่างเดียวยังไม่ได้ลงทะเบียนชื่อ workspace

## ติดตั้งจาก source

```powershell
npm ci
npm run build
npm run configure
npm run doctor
```

ตั้งค่าแบบไม่ต้องตอบคำถาม:

```powershell
node scripts/configure.mjs --worker-entry "D:/My Tools/DC/node_modules/@wonderwhy-er/desktop-commander/dist/index.js" --workspace "D:/My Projects" --worker-cap 4
```

path ในตัวอย่างต้องเปลี่ยนเป็นของคุณ Setup ใช้ตำแหน่งจริงของ Node และ DWB สร้าง config ให้ จึงไม่ผูกกับเครื่องผู้พัฒนา

## Core ที่มีให้

- Broker เดียวต่อผู้ใช้และ data directory พร้อม worker ประจำแต่ละ MCP session
- จำกัด worker เริ่มต้น 4 ตัว มีคิวรอและคืน worker ที่ว่าง
- แยก logical context เมื่อ client ส่ง metadata ที่ใช้ระบุบริบทได้ หากไม่มี จะใช้ session ของ adapter
- กู้ worker เมื่อ crash พร้อม backoff และ circuit breaker
- เก็บ session/fingerprint เพื่อกู้ session หลัง broker crash
- ต่อ session ที่ detach กลับมาได้ภายในช่วงเก็บรักษา
- File read/write locks และ stale-write protection สำหรับ file tools ที่รองรับ
- Workspace binding เพื่อกัน file mutation ข้าม root ที่ผูกไว้
- Agent Skills registry พร้อม global default + per-workspace AUTO / ASK / MANUAL policy
- Payload guard เริ่มต้น 256 KiB พร้อมผลตอบกลับที่แจ้งว่าข้อมูลใหญ่เกิน
- Proxy tools และ MCP resources จาก Desktop Commander ที่ผู้ใช้ติดตั้งเอง

เครื่องมือ DWB ที่เพิ่มจาก upstream มี 9 ตัว: `dwb_bridge_status`, `dwb_broker_status`, `dwb_session_status`, `dwb_restart_worker`, `dwb_list_sessions`, `dwb_list_detached_sessions`, `dwb_resume_session`, `skills`, `workspace`

เมื่อผู้ใช้ระบุ working directory ให้ AI เรียก `workspace(action="bind", path="<absolute path>")` ทันที ก่อนทำงานกับไฟล์หรือ shell โดยคำสั่งเดียวจะลงทะเบียนหรือใช้ workspace ที่ตรงกับ path นั้น แล้วผูกกับแชทปัจจุบัน ไม่ต้องให้ผู้ใช้สั่ง register แยก การ bind เปลี่ยนโฟลเดอร์เริ่มต้นของ worker ในแชทนั้น แต่ไม่ขยายสิทธิ์ `allowedDirectories` ของ Desktop Commander ใช้ absolute path กับ file tools ต่อไป

ตัว broker ไม่ได้อ่านข้อความแชทโดยตรง การแปลงข้อความที่ผู้ใช้บอก path เป็นคำสั่ง bind ขึ้นอยู่กับ AI/client ที่เรียก MCP เราใส่แนวทางนี้ทั้ง server instructions และคำอธิบาย tool ถ้ายังไม่มีการระบุ workspace แชทจะยังไม่มี binding และใช้โฟลเดอร์เริ่มต้นจาก Setup โดยไม่เดาจากแชทอื่น

## ข้อมูลและขอบเขต

- เก็บข้อมูลใน `%LOCALAPPDATA%\DWB-MCP-Studio` แยกจากโฟลเดอร์โปรแกรม เพื่อเก็บการตั้งค่าและ workspace ไว้เมื่ออัปเดต
- ไม่มีการนำเข้าแชต ประวัติ Desktop Commander หรือ config ส่วนตัวโดยอัตโนมัติ
- `base-policy.json` ที่ Setup สร้างอนุญาตโฟลเดอร์งานที่เลือก ปรับเพิ่มโฟลเดอร์ได้เอง แล้วเริ่ม broker ใหม่
- แต่ละ worker มี config home ของตัวเอง โดยไม่เปลี่ยน OS home ที่ Git/SSH และคำสั่งอื่นใช้ และไม่ patch ไฟล์ Desktop Commander บน disk
- DWB เก็บ event metadata, workspace paths และ file fingerprints ในเครื่อง Payload archive ใช้ redaction เป็นค่าเริ่มต้น แต่ไม่รับประกันว่าจะลบข้อมูลอ่อนไหวได้ทุกชนิด เลือก `DWB_PAYLOAD_ARCHIVE_MODE=off` หากไม่ต้องการเก็บ
- Desktop Commander อาจเก็บประวัติ tool ของตัวเองใน worker config home ดูรายละเอียดที่โปรเจกต์ต้นทาง
- File locks และ workspace guard **ไม่ใช่ OS sandbox** ไม่ได้ครอบคลุมการแก้ไฟล์ผ่าน shell, ทุก tool หรือโปรแกรมภายนอก จึงควรใช้กับ client ที่คุณไว้ใจ
- คำสั่งที่ connection หลุดระหว่างทำงานจะไม่ถูก replay อัตโนมัติ ต้องตรวจผลก่อนสั่งใหม่
- Broker crash จะสร้าง worker ใหม่ จึงไม่กู้ in-memory process/search handles ของ worker เก่า

ดู [การเชื่อมต่อและ config](docs/CONFIGURATION.md), [การอัปเดต/ถอน](docs/OPERATIONS.md) และ [ขอบเขตการแจก](THIRD-PARTY.md)

## พัฒนาและทดสอบ

```powershell
npm test
# integration ใช้ Desktop Commander ที่ติดตั้งแยกไว้เอง:
$env:DWB_WORKER_ENTRY = 'D:/My Tools/DC/node_modules/@wonderwhy-er/desktop-commander/dist/index.js'
npm run test:integration
npm run test:setup
npm run format:check
npm run release
```

`npm test` ใช้ test double ที่ DWB เขียนเอง ไม่ดาวน์โหลด Desktop Commander การทดสอบ integration ใช้ตัวจริงภายนอกและตรวจว่า config.js ไม่ถูกแก้ไข

`npm run release` สร้าง ZIP และ SHA-256 ใน `releases/` จากรายการไฟล์ที่กำหนดเท่านั้น ไม่มี `node_modules`, ข้อมูล runtime, log, config ผู้ใช้ หรือโปรแกรมภายนอก ตัว ZIP มี source ของ DWB และ JavaScript ที่ build แล้ว ส่วน npm libraries ให้ผู้ใช้ดาวน์โหลดตอน Setup

## อัปเดตจากรุ่นเดิม

เปิด `DWB MCP Studio.exe` ในรุ่นใหม่ แล้วกด **อัปเดตและใช้การตั้งค่าเดิม** ระบบนำส่วนประกอบจาก DWB เดิมมาใช้และรักษา workspace, Tunnel ID และ key ที่บันทึกไว้ ไม่ต้องผูก connector ใหม่บนเครื่องเดิม ดู [วิธีอัปเดต](docs/UPDATING-TH.md) รวมขั้นตอนปิด runtime เดิมหลังจบงาน
