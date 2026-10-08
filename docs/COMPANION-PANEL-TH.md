# DWB Companion — ChatGPT Conversation Panel (ทดลอง)

ฟีเจอร์นี้เป็นตัวอย่างการเพิ่ม **MCP App + OpenAI MCP Extensions** เข้าไปใน DWB MCP Studio Public
โดยไม่แก้เครื่องมือ Desktop Commander เดิม ผู้ใช้เปิด DWB Companion เป็น panel ใน conversation
และทำงานกับแชทข้างๆ ได้ ตัว panel เริ่มต้นเป็น **read-only** เพื่อความปลอดภัย

## แยกความหมายให้ถูก

- GPT-6 Intelligent UI คือระบบที่ ChatGPT สร้าง UI ขึ้นมาในคำตอบของโมเดล
- MCP Apps คือ UI แบบกำหนดไว้โดยนักพัฒนาและส่งจาก MCP Server ผ่าน resource
- MCP Extensions ใช้เพิ่มตำแหน่ง UI แบบ thread (ใน conversation) หรือ global (sidebar หลัก)
- ตอนนี้ DWB ใช้ **thread entrypoint** เท่านั้น ไม่ได้เพิ่ม global sidebar icon

## องค์ประกอบ

- Tool: dwb_companion สำหรับเปิด panel และส่ง initial snapshot
- Tool: dwb_companion_snapshot สำหรับ Refresh จาก UI เท่านั้น (app visibility)
- Resource: ui://dwb-mcp-studio/companion-panel
- MIME: text/html;profile=mcp-app
- ตัวแอปอยู่ใน web/companion.html + web/companion.ts
- npm run build bundle UI พร้อม MCP Apps SDK เป็น dist/companion-panel.html
- Broker อ่าน workspace / skill / session status จาก storage ของ DWB โดยไม่เปิด worker ใหม่เพื่อสร้าง snapshot
- UI ส่งคำขอวิเคราะห์ workspace ผ่าน ui/message ให้ ChatGPT ไปเรียก workspace bind เอง;
  Panel ไม่มีปุ่มสั่ง shell/write/deploy โดยตรง

## ข้อจำกัด

1. DWB Connector + Tunnel ต้อง online และ ChatGPT Host ต้องรองรับ MCP Apps/Extensions
2. เครื่องมือ MCP มี text fallback ใน host ที่ไม่แสดง UI
3. ui/message อาจไม่รองรับทุก host หากไม่รองรับแสดง prompt ให้คัดลอกไปแชทแทน
4. ตัวเลขเป็น snapshot แบบ on-demand กด Refresh เพื่ออ่านล่าสุด ไม่ใช่การ subscribe
5. Workspace ที่เลือกใน Panel เป็นเพียงการเลือกฝั่ง UI; การ bind จริงเกิดหลังผู้ใช้ส่งข้อความ
6. ยังไม่ยืนยันว่า entrypoint ถูกแสดงบน ChatGPT web/mobile ของบัญชีจริง
7. Source เป็น PoC ใน branch ฟีเจอร์ ไม่ควรเรียกว่า release stable จนกว่าจะทำ E2E

## เตรียมทดลองใน ChatGPT

ต้องใช้ ChatGPT Host ที่รองรับ MCP Extensions ตามสิทธิ์ของบัญชีและแพลตฟอร์มที่ใช้จริง เอกสาร OpenAI ระบุ Desktop, Work browser และ Mobile โดย **ไม่รวม classic ChatGPT web** ในตารางการรองรับ ณ วันที่เปิดตัว DevDay; อย่ารับปากว่าผู้ใช้ทุกคนจะเห็น Side Panel บนเว็บได้ทันที

โค้ดใน branch นี้ถูก build แล้ว แต่ broker ที่เปิดค้างจะยังใช้โค้ดที่โหลดไปก่อนหน้า หากต้องการทดสอบ:

1. จบทุก process/search ที่กำลังทำงานใน DWB และ disconnect client อื่นก่อน
2. กด Stop MCP ใน Dashboard แล้วใช้ขั้นตอน Setup / ปรับรุ่นของ DWB เพื่อหยุด broker เดิมอย่างปลอดภัยตาม docs/UPDATING-TH.md ห้าม kill broker ระหว่างงาน
3. ใช้ Start MCP จาก source ที่ build แล้ว และ reconnect plugin/tunnel เดิม จากนั้นให้ Host ค้นพบ tools/list ใหม่
4. ทดสอบ thread entrypoint DWB Companion บน ChatGPT Desktop หรือ Work browser ก่อนทดสอบปุ่ม Refresh และ Ask ChatGPT

ก่อนประกาศเป็น Public release ต้องปิดข้อค้นพบจาก npm audit และทบทวนประกาศลิขสิทธิ์ของ SDK/transitive dependencies ใน HTML bundle ด้วย

## ทดสอบ

    npm run typecheck
    npm run build
    npm test
    npx tsx src/protocol-negotiation-test.ts
    npm run test:distribution

ตรวจผ่าน MCP จริง:

1. ตรวจ tools/list พบ dwb_companion พร้อม _meta.ui.resourceUri และ openai/ui entrypoints เป็น thread
2. ตรวจ resources/list และ resources/read ส่ง HTML ที่ bundle แล้ว
3. เรียก dwb_companion คืน structuredContent และ content fallback
4. เปิด Plugin/DWB ที่เชื่อมกับ ChatGPT แล้วตรวจว่ามี **DWB Companion** ในแท็บสนทนา
5. Refresh ดู broker/workspaces และกดเลือก workspace → Ask ChatGPT
6. ChatGPT ได้ข้อความและ bind workspace จริงได้ โดยไม่แก้ไฟล์ใดระหว่างทดสอบ
7. ตรวจ UI บน host ที่ใช้ถ่ายคลิปจริงก่อนประกาศว่ารองรับแพลตฟอร์มนั้น

อ่านข้อมูลอ้างอิง:

- https://developers.openai.com/plugins/build/extensions
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://github.com/openai/mcp-extensions/blob/main/docs/spec.md
