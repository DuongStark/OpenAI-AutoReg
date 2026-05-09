Endpoints
Base URL:  https://temp-mail.starkduong.workers.dev

GET  /inbox?email={email}        → danh sách mail
GET  /message?email={email}&id={id}  → nội dung mail đầy đủ
DELETE /inbox?email={email}      → xóa hòm thư

Ví dụ thực tế
pythonBASE = "https://temp-mail.starkduong.workers.dev"
DOMAIN = "pixpress.art"

# Lấy inbox
GET /inbox?email=abc123@pixpress.art

# Lấy nội dung 1 mail
GET /message?email=abc123@pixpress.art&id=1778322102188-mx08j

# Xóa inbox
DELETE /inbox?email=abc123@pixpress.art

Response format
/inbox trả về array:
json[
  {
    "id": "1778322102188-mx08j",
    "from": "sender@gmail.com",
    "to": "abc123@pixpress.art",
    "subject": "Mã xác nhận của bạn",
    "body": "Mã OTP: 123456",
    "date": "2026-05-09T10:28:22.000Z"
  }
]
/message trả về object đơn:
json{
  "id": "...",
  "from": "...",
  "subject": "...",
  "body": "nội dung đầy đủ...",
  "date": "..."
}

Giới hạn cần biết
Email lưu:     24 giờ
Tối đa:        50 mail/inbox
Worker:        100k requests/ngày (free)
Email nhận:    100 mail/ngày (free)