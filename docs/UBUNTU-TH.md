# Ubuntu และ remote VPS

DWB Core ใช้บน Ubuntu ผ่าน terminal ได้โดยไม่ต้องมี desktop environment ตัวติดตั้งเตรียม Desktop Commander และ OpenAI tunnel-client ของ Linux พร้อมสร้าง config สำหรับ local MCP client ส่วน VPS ใช้ user systemd service เพื่อดูแล tunnel, broker และ worker

เป้าหมายทดสอบคือ Ubuntu 22.04 / 24.04 LTS, x64 และ ARM64 ด้วย Node.js 22.16 ขึ้นไป สถานะการทดสอบแต่ละแพลตฟอร์มอยู่ท้ายคู่มือนี้

## เตรียมเครื่องและติดตั้ง

ใช้บัญชีผู้ใช้ปกติที่มีสิทธิ์ในโฟลเดอร์งาน คำสั่งของ Desktop Commander รันด้วยสิทธิ์ของบัญชีนี้ เลือกบัญชีแยกสำหรับ VPS เมื่ออยากแยกงานจากบริการอื่น

ติดตั้ง [Node.js 22.16 ขึ้นไปพร้อม npm](https://nodejs.org/en/download) ก่อน Node ที่ได้จาก `apt install nodejs` ของ Ubuntu อาจเก่าเกินไป ตัวติดตั้งจะตรวจรุ่นและหยุดก่อนติดตั้งถ้าไม่รองรับ

```bash
sudo apt-get update
sudo apt-get install -y git curl unzip ca-certificates
git clone https://github.com/sphakanin/dwb-mcp-studio-public.git
cd dwb-mcp-studio-public
mkdir -p "$HOME/workspace"
bash install.sh --workspace "$HOME/workspace" --worker-cap 4
node scripts/linux/cli.mjs doctor
```

หากใช้ Ubuntu source ZIP ให้ตรวจ `.sha256`, แตก ZIP แล้วรัน `bash install.sh` จากโฟลเดอร์ที่แตกได้เช่นกัน เลือก path ที่มีอยู่จริงและเปลี่ยน workspace ในตัวอย่างให้ตรงกับงานของคุณ เมื่อแจก candidate จาก branch ให้ใช้ source/ZIP ที่มี `install.sh`; README นี้ไม่ได้หมายความว่าไฟล์อยู่ใน release Windows รุ่นเก่าแล้ว

ตัวติดตั้งรัน `npm ci` เมื่อยังไม่มีเครื่องมือ build, build Core และดาวน์โหลด Desktop Commander **0.2.50** จาก npm แยกไว้ใน `external/linux/desktop-commander` จากนั้นดาวน์โหลด tunnel-client **0.0.11** ตามสถาปัตยกรรมจาก [official OpenAI release](https://github.com/openai/tunnel-client/releases/tag/v0.0.11) ด้วย curl ผ่าน HTTPS พร้อม timeout และ retry, ตรวจ SHA-256 ที่ตรึงไว้ก่อนแตก และเก็บ executable, companion กับ license ใน `external/linux/tunnel-client` โปรแกรมภายนอกไม่รวมอยู่ใน source ZIP ของ DWB

ข้อมูลถาวรอยู่ที่ `${XDG_DATA_HOME:-$HOME/.local/share}/DWB-MCP-Studio` แยกจากโปรแกรม ตั้ง `DWB_DATA_DIR` เป็น absolute path หากต้องการแยก installation; ใช้ค่าเดียวกันทุกครั้ง รวมถึงตอนติดตั้ง service

```bash
export DWB_DATA_DIR="$HOME/.local/share/DWB-VPS"
bash install.sh --workspace "$HOME/workspace"
```

ค่า shell ของ worker เป็น `/bin/bash` และ `base-policy.json` อนุญาต workspace ที่เลือก รักษาค่า policy เดิมเมื่อรัน Setup ซ้ำ โฟลเดอร์ข้อมูลสร้างด้วย mode 700 และ config ใหม่ด้วย mode 600 ตัว broker ใช้ Unix socket ของผู้ใช้ใน `/tmp/dwb-mcp-<uid>` โดยใช้ SQLite lease ป้องกัน broker ซ้อนกัน

## เชื่อมจาก ChatGPT / Codex ผ่าน Tunnel

สร้าง Tunnel ID และ runtime API key ที่มีสิทธิ์ใช้ tunnel ตาม [คู่มือ OpenAI](https://github.com/openai/tunnel-client/blob/v0.0.11/docs/onboarding.md) ใช้ Tunnel ID แยกจาก runtime ที่เปิดอยู่บน Windows/macOS เพื่อไม่ให้สองเครื่องแย่งการเชื่อมต่อ

```bash
node scripts/linux/cli.mjs tunnel-config --tunnel-id tunnel_ของคุณ
```

CLI รับ API key แบบซ่อนตัวอักษร แล้วเก็บใน `tunnel-linux/api-key` ที่อ่านได้เฉพาะเจ้าของ ไฟล์นี้เป็น plaintext ที่ป้องกันด้วย Unix file permissions จึงต้องรักษา data directory และ backup เป็นข้อมูลส่วนตัว

สำหรับ provisioning แบบไม่โต้ตอบ ให้เตรียมไฟล์ key ด้วย secret manager ของคุณก่อน แล้วใช้ path ของไฟล์ โดยไฟล์ต้องเป็น regular file ของผู้ใช้ปัจจุบัน, mode 600 และไม่เป็น symlink:

```bash
chmod 600 /absolute/path/to/private-key
node scripts/linux/cli.mjs tunnel-config \
  --tunnel-id tunnel_ของคุณ \
  --key-file /absolute/path/to/private-key
```

ไม่ใส่ API key ใน argv, systemd unit หรือ tunnel profile ตัว launcher อ่านไฟล์เมื่อเริ่มและส่ง key เฉพาะ environment ของ tunnel-client ส่วน `tunnel-mcp.mjs` ลบ key ก่อนเริ่ม adapter/broker/worker

ลองเปิดแบบ foreground ได้ด้วย:

```bash
node scripts/linux/cli.mjs tunnel
```

กด Ctrl+C เพื่อหยุด tunnel หากต้องการให้รันต่อหลังปิด SSH ให้ใช้ service ด้านล่าง Health/Admin UI ของ tunnel ฟังเฉพาะ `127.0.0.1` การเชื่อมกับ OpenAI ใช้ outbound HTTPS ไม่ต้องเปิด public inbound port ให้ MCP ดู [สถาปัตยกรรม upstream](https://github.com/openai/tunnel-client/blob/v0.0.11/docs/architecture.md)

## รันต่อเมื่อปิด SSH และหลัง reboot

```bash
node scripts/linux/cli.mjs service install
sudo loginctl enable-linger "$(id -un)"
node scripts/linux/cli.mjs service start
node scripts/linux/cli.mjs service status
node scripts/linux/cli.mjs doctor
```

`service install` สร้างและ enable unit ใน `~/.config/systemd/user` (หรือ `XDG_CONFIG_HOME`) แต่ยังไม่เชื่อมจนสั่ง `service start` ชื่อ unit แยกตาม data directory คำสั่ง `enable-linger` ทำให้ systemd ของบัญชีนี้ทำงานหลัง logout และเริ่ม unit ที่ enable ไว้หลัง boot ต้องใช้สิทธิ์ sudo สำหรับขั้นตอนนี้ครั้งเดียว

`service status` แสดงสถานะ process ของ systemd ส่วน `doctor` แสดงสถานะ broker และ `tunnel.state` ค่า `ready` มาจาก `/readyz` ของ tunnel-client ยืนยันครบเส้นทางอีกครั้งด้วยการเรียก tool จากแชทที่เชื่อมแล้ว สถานะ broker `stopped` ก่อนมี client เชื่อมเป็นเรื่องปกติและการตรวจไม่เปิด worker เพิ่ม

```bash
node scripts/linux/cli.mjs service restart
node scripts/linux/cli.mjs service stop
unit="$(node scripts/linux/cli.mjs service name)"
journalctl --user -u "$unit" -n 100 --no-pager
```

systemd restart เมื่อ process ล้ม และใช้ `KillMode=control-group` เพื่อหยุด process ลูกที่ service เป็นผู้เริ่ม รวมถึง broker/worker ที่ detach เมื่อสั่ง Stop หาก local stdio ใช้ broker ที่ service เริ่มไว้ การ Stop service จะทำให้การเชื่อมต่อนั้นหลุดด้วย ส่วน broker ที่ local client เริ่มไว้ก่อนและอยู่นอก service จะยังคงรันอยู่

ถ้า `systemctl --user` แจ้งว่าเชื่อม bus ไม่ได้ ให้เข้า SSH ด้วยผู้ใช้เป้าหมายโดยตรงและตรวจ user manager ด้วย `systemctl --user status` เมื่อ VPS มี systemd และผู้ใช้เปิด linger แล้ว บาง session ที่ใช้ `su` ต้องตั้ง `XDG_RUNTIME_DIR=/run/user/$(id -u)` กับ `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` ใหม่ Container ที่ไม่ได้รัน systemd ใช้ foreground tunnel กับ supervisor ของ container แทน

## local client หรือ MCP ผ่าน SSH

Setup สร้าง `<data directory>/mcp-client.json` สำหรับ client บน Ubuntu เครื่องเดียวกัน ให้ client เริ่ม `node scripts/start.mjs` เป็น stdio process ตาม config นี้

Client ที่รันบนเครื่องอื่นและรองรับ stdio command สามารถใช้ SSH เปิด adapter บน VPS ได้เช่นกัน เช่น:

```json
{
  "mcpServers": {
    "dwb-vps": {
      "command": "ssh",
      "args": ["-T", "user@your-vps", "node /home/user/dwb-mcp-studio-public/scripts/start.mjs"]
    }
  }
}
```

เปลี่ยน user/host/path ให้ถูกต้อง ใช้ absolute Node path จาก config หาก Node ไม่อยู่ใน PATH ของ non-interactive SSH ส่วน custom data directory ให้กำหนด `DWB_DATA_DIR` ใน remote command ด้วย อย่าให้ startup shell พิมพ์ข้อความลง stdout เพราะช่องนี้ใช้ MCP protocol

เครื่องมือทำงานกับไฟล์และ process บน VPS โฟลเดอร์บน Windows ของคุณไม่ปรากฏบน VPS อัตโนมัติ ต้อง clone/sync โปรเจกต์ลง VPS แล้ว bind workspace บนเครื่องนั้นก่อน งานสองเครื่องไม่แชร์ worker หรือข้อมูล workspace กันโดยอัตโนมัติ

## อัปเดตและถอน service

หยุด service และปิด local MCP clients ให้หมดก่อนอัปเดต source หรือเปลี่ยน workspace:

```bash
node scripts/linux/cli.mjs service stop
git pull --ff-only
bash install.sh --workspace "$HOME/workspace"
node scripts/linux/cli.mjs service install
node scripts/linux/cli.mjs service start
```

Setup ใช้ component รุ่นที่พร้อมแล้วซ้ำ เก็บ policy/workspace/key ใน data directory เดิม และเขียน Node/source path ปัจจุบันใน config การติดตั้ง service ซ้ำทำให้ path ใน unit ตรงกับ source ปัจจุบัน

```bash
node scripts/linux/cli.mjs service uninstall
```

คำสั่งนี้ stop/disable และลบเฉพาะ unit ของ data directory ปัจจุบัน เก็บ config, workspace, key และโปรแกรมภายนอกไว้เพื่อกลับมาใช้ได้ ไม่เปลี่ยน linger เพราะบัญชีอาจมี service อื่นใช้อยู่

## การทดสอบ

ตรวจในเครื่องวันที่ **2026-09-30**:

| รายการ                                    | ผล                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04.4 x64 ใน WSL2 + Node 22.16.0 | ติดตั้งจาก source ใหม่, `npm test`, platform และ Linux control ผ่าน                                                                                   |
| Desktop Commander 0.2.50 จริง             | ผ่าน smoke, payload, multi-session, broker recovery, logical context, protocol, Bash/workspace และ resume; ไฟล์ upstream ไม่ถูกแก้                    |
| tunnel-client 0.0.11 ของ Linux            | checksum และ HTTP MCP แบบ local ผ่าน; แยกแชทและ bind workspace ด้วย alias ได้                                                                         |
| user systemd                              | install/enable/start/status/stop/uninstall ผ่าน; path ที่มี space/percent/dollar ถูกต้อง; ปิด detached child ที่ไม่ยอมรับ SIGTERM และรักษา config ไว้ |
| Windows + Node 24.11.1                    | Core regression และ recovery/protocol/workspace integration ผ่านหลังแก้ส่วนร่วม                                                                       |
| Ubuntu 22.04 / ARM64                      | เตรียม matrix CI แล้ว ยังไม่ได้รันในเครื่องนี้                                                                                                        |
| OpenAI hosted tunnel / VPS จริง / reboot  | ยังไม่ได้ทดสอบกับบัญชีหรือ VPS จริง; systemd ทดสอบด้วย fixture ที่ไม่ใช้ credential จริง                                                              |

ตรวจเพิ่มเติมวันที่ **2026-10-02**: แยกงานทดลองและไฟล์จากโปรเจกต์อื่นออกจาก public source แล้ว `format:check` ทั้ง repository และ `test:distribution` ผ่าน ตัวสร้าง release ใช้รายการไฟล์ที่ตรวจไว้ใน `scripts/distribution-files.json`

CI ของ Ubuntu แยก Ubuntu 22.04 x64, 24.04 x64 และ 24.04 ARM64 โดยใช้ Node 22.16 ตรวจ core regression, platform, secret-file permissions, ติดตั้ง external worker/tunnel จริง, recovery integration, HTTP MCP ผ่าน tunnel แบบ local และ user systemd lifecycle ที่ไม่ใช้บัญชี OpenAI

```bash
npm test
npm run test:platform
npm run test:linux
# หลัง Setup ใน data directory แยกสำหรับทดสอบ:
export DWB_WORKER_ENTRY="$PWD/external/linux/desktop-commander/node_modules/@wonderwhy-er/desktop-commander/dist/index.js"
npm run test:integration
node scripts/linux/systemd-test.mjs
npm run release:linux
```

`release:linux` สร้าง Ubuntu source ZIP พร้อม SHA-256 และ executable bit ของ `install.sh` ไม่รวม node_modules, external, API key หรือข้อมูลผู้ใช้ ผล CI ของแพลตฟอร์มที่ยังไม่ได้รันต้องตรวจเพิ่มเติมก่อนประกาศรองรับทั่วไป รุ่นนี้เป็น terminal/VPS runtime; หน้าต่าง Setup/Dashboard ของ Windows/macOS ไม่ได้ติดตั้งบน Ubuntu
