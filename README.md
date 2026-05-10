# 🤖 OpenAI Automation Tool

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)
![License](https://img.shields.io/badge/license-MIT-important.svg)

Giải pháp tự động hóa toàn diện quy trình đăng ký tài khoản OpenAI, tích hợp giao diện điều khiển Web Dashboard hiện đại, hệ thống thuê số điện thoại và xác thực email tự động.

---

## Tính năng nổi bật

- **Giao diện Dashboard chuyên nghiệp**: Điều khiển mọi hoạt động của bot thông qua trình duyệt web với thiết kế Glassmorphism tối giản.
- **Tự động hóa hoàn toàn**: Từ bước nhập email, mật khẩu đến việc xác minh OTP Email và OTP SMS.
- **Cơ chế Retry thông minh**: 
    - Tự động phát hiện số điện thoại bị OpenAI chặn thông qua Network API (Error 400).
    - Tự động quay lại bước trước (Go Back) và thực hiện chọn lại quốc gia, thuê số mới nếu không nhận được mã SMS.
- **Bảo mật & Ẩn danh**: Sử dụng `Playwright Stealth` để giảm thiểu khả năng bị phát hiện là bot.
- **Quản lý dữ liệu**: Tự động lưu trữ thông tin tài khoản (`accounts.json`) và Access Token (`openai_tokens_manual.json`) sau khi hoàn tất.

---

## 🛠 Cấu trúc dự án

- `dashboard.js`: Máy chủ backend (Express) quản lý giao diện và điều phối tiến trình automation.
- `auto_reg.js`: Lõi xử lý automation (Playwright), thực hiện các thao tác trên trình duyệt.
- `public/index.html`: Giao diện người dùng Web UI.
- `accounts.json`: Danh sách email và mật khẩu của các tài khoản đã tạo.
- `openai_tokens_manual.json`: Lưu trữ Access Token và Refresh Token phục vụ mục đích tích hợp API.

---

##  Hướng dẫn khởi động

### 1. Yêu cầu hệ thống
- Máy tính đã cài đặt **Node.js** (Phiên bản 18 trở lên).

### 2. Cài đặt thư viện
Mở Terminal tại thư mục dự án và chạy lệnh:
```bash
npm install express playwright-extra puppeteer-extra-plugin-stealth
npx playwright install chromium
```

### 3. Chạy ứng dụng
Khởi động Dashboard điều khiển:
```bash
node dashboard.js
```

### 4. Sử dụng
- Truy cập địa chỉ: `http://localhost:3000`
- Nhập **ViOTP API Token** của bạn.
- Nhập **Số lượng tài khoản** muốn tạo.
- Bấm **Chạy Automation** và theo dõi Log trực tiếp trên màn hình.

---

## Lưu ý quan trọng

- **ViOTP Service ID**: Hiện tại công cụ đang mặc định sử dụng Service ID của OpenAI trên ViOTP. Nếu hệ thống thay đổi, bạn có thể điều chỉnh biến `VIOTP_SERVICE_ID` trong file `auto_reg.js`.
- **IP Reputation**: Để đạt tỷ lệ thành công cao nhất, nên sử dụng Proxy sạch hoặc phát mạng 4G/5G khi tạo số lượng lớn tài khoản để tránh bị OpenAI chặn dải IP.

---
*© 2024 OpenAI Automation Dashboard - Professional Edition*
