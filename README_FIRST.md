# PAI.DUY.NA Full Version v2

แพ็กเกจนี้แยกเว็บสาธารณะและเครื่องมือผู้ดูแลออกจากกันแล้ว

```text
PAI_DUY_NA_Full/
├── paiduyna/      อัปโหลดเฉพาะไฟล์ในโฟลเดอร์นี้ขึ้น GitHub Pages
└── admin-local/   เก็บไว้ในเครื่องของผู้ดูแล ห้ามอัปโหลดขึ้นเว็บไซต์
```

## เผยแพร่เว็บไซต์

นำไฟล์ทั้งหมดภายในโฟลเดอร์ `paiduyna` ไปวางที่รากของ GitHub Repository

## อัปเดตข่าวสถานะ

1. เปิด `admin-local/PAI_DUY_NA_Admin.html`
2. กรอกข่าวและกด Export `status.json`
3. นำไฟล์ไปแทน `paiduyna/data/status.json`
4. Commit และ Push ด้วยบัญชี GitHub ของผู้ดูแล

หน้าเว็บสาธารณะไม่มีปุ่ม Admin และไม่มี Password ฝังอยู่ใน JavaScript
