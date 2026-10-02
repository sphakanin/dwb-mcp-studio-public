# เผยแพร่ผ่าน Git

ใช้โฟลเดอร์ `dwb-mcp-studio-public` เป็น repository สำหรับแจก แยกจากประวัติ Git ของโปรแกรมส่วนตัว

## เนื้อหา repository

เก็บ source ของ DWB, scripts, assets ของ DWB, docs, package.json, package-lock.json, LICENSE และ THIRD-PARTY.md ไว้ครบ

`.gitignore` กัน `external/`, `node_modules/`, `dist/`, `logs/`, `data/`, `runtime/`, `releases/`, `.env` และไฟล์ key ที่ระบุไว้ ผู้ใช้ clone แล้วเปิด Setup เพื่อ build และติดตั้งส่วนประกอบได้ ไม่ต้อง commit โปรแกรมที่ดาวน์โหลดแล้ว

ก่อน push ให้ดู `git status` และ `git diff --cached` ตรวจชื่อไฟล์และเนื้อหาที่จะขึ้น repository ด้วย `.gitignore` ไม่เอาไฟล์ที่เคย tracked ออกจาก Git และไม่ล้างข้อมูลในประวัติเดิม

## ตรวจขอบเขตไฟล์ก่อนแจก

scripts/distribution-files.json ระบุชื่อไฟล์ของ DWB ที่เข้า ZIP แต่ละแพลตฟอร์ม ส่วน developmentFiles ต้องเป็นรายการว่าง หลักฐาน engineering และ audit เก็บเฉพาะในโฟลเดอร์ที่ Git ignore ไว้ ตัวสร้าง ZIP ของ Windows/macOS/Ubuntu และ npm prepack ตรวจรายการนี้ก่อนแพ็ก ถ้ามีไฟล์ใหม่ใน src, scripts, docs, assets หรือ .github ที่ยังไม่อยู่ในรายการจะหยุดสร้างแพ็ก

```sh
npm run test:distribution
```

เมื่อเพิ่ม source, installer, test หรือเอกสารของ DWB ให้เพิ่มชื่อไฟล์ในรายการนี้โดยตรวจเนื้อหาด้วย งานโปรเจกต์อื่น, lab, dataset, model weights, วิดีโอ, แผนอัดคลิป และ credential ของบริการอื่นต้องอยู่ใน workspace ของงานนั้นนอก repository นี้

อย่าแจก ZIP ที่สร้างจากโฟลเดอร์ติดตั้งทั้งก้อน ใช้ตัวสร้าง release ของ DWB และตรวจชื่อไฟล์ใน ZIP รวมถึง SHA-256 ก่อนเผยแพร่

Workflow Secret scanning ใช้ Gitleaks ตรวจประวัติ Git เมื่อ push และเปิด pull request ก่อนเผยแพร่ต้องสแกน source และ ZIP ที่จะอัปโหลดด้วย รวมถึงตรวจ npm audit และผลทดสอบของรุ่นนั้น การตรวจไม่พบ secret เป็นหลักฐานของรายการที่ตรวจ ณ เวลานั้น ไม่ได้รับประกันว่าเครื่องมือจะรู้จัก credential ทุกชนิด

## License และ attribution

- LICENSE ปัจจุบันของ DWB เป็น MIT และระบุ `Copyright (c) 2026 Phakanin` ตรวจให้ตรงผู้ถือสิทธิ์ของโค้ดก่อนเผยแพร่
- MIT อนุญาตให้ผู้รับนำไปดัดแปลง แจกต่อ และขายได้ โดยรักษาประกาศลิขสิทธิ์และใบอนุญาต หากต้องการจำกัดการขายต่อ ต้องตัดสินใจเรื่อง license ของโค้ดที่คุณถือสิทธิ์ก่อนเผยแพร่ ดู [MIT ต้นฉบับ](https://opensource.org/license/mit)
- Desktop Commander 0.2.50 เป็น [MIT](https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/v0.2.50/LICENSE) และ tunnel-client 0.0.11 เป็น [Apache-2.0](https://raw.githubusercontent.com/openai/tunnel-client/v0.0.11/LICENSE) Setup ดาวน์โหลดจากเจ้าของโดยตรงและเก็บไฟล์ license ที่มากับแพ็กเกจไว้
- หากมีโค้ดหรือ assets ของผู้อื่นรวมอยู่ใน repository ต้องรักษาเงื่อนไขและประกาศของส่วนนั้น การใส่ LICENSE ของ DWB ไม่ได้เปลี่ยนสิทธิ์ของผู้อื่น
- ใช้ชื่อ DWB เป็นชื่อผลิตภัณฑ์ ระบุโปรแกรมที่ทำงานร่วมกันตามจริง โดยไม่อ้างการรับรองจากเจ้าของโปรแกรมเหล่านั้น

## หน้า Releases

ถ้าต้องการให้ผู้ใช้ดาวน์โหลดตัวที่ build แล้ว ให้แนบ ZIP และ `.sha256` ที่สร้างด้วย `npm run release` ในหน้า Releases ของบริการ Git ที่ใช้ ไม่ต้อง commit ZIP ลง source repository และไม่บีบอัดโฟลเดอร์ที่ติดตั้งใช้งานแล้วเพื่อแจก

ตัวอย่างข้อความหน้า repository:

> DWB MCP Studio Core เป็นตัวกลาง MCP แบบหลาย worker สำหรับ Windows พัฒนาโดย Dev with Bebz โค้ด DWB เผยแพร่ภายใต้ MIT License ตัวติดตั้งดาวน์โหลด Desktop Commander และ OpenAI tunnel-client จากเจ้าของโดยตรงตาม license ของแต่ละโปรเจกต์ โปรแกรมนี้เป็นโครงการอิสระ ไม่ใช่ผลิตภัณฑ์ทางการของ OpenAI หรือ Desktop Commander

## DWB launcher

`DWB MCP Studio.exe` เป็น launcher ของ DWB เอง สร้างจาก `scripts/launcher.cs` ด้วย `scripts/build-launcher.ps1` พร้อมไอคอนจากโลโก้ผู้พัฒนา จึงรวมใน Git และ release ได้ภายใต้ MIT ของโครงการ โปรแกรมภายนอกยังดาวน์โหลดแยกโดย Setup และไม่รวมใน release
