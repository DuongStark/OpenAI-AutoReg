# Hướng dẫn tạo Tool tự động Đăng nhập OpenAI (OAuth2 PKCE)

Tài liệu này hướng dẫn chi tiết cách viết một đoạn script độc lập (bằng Node.js) để thực hiện luồng đăng nhập OAuth2 của OpenAI trên máy tính cá nhân (Local CLI/Desktop App). Sau khi lấy được token, bạn có thể mang bộ token này tích hợp vào bất kỳ dự án nào khác (như `9router`).

## 1. Cơ chế hoạt động (OAuth2 Authorization Code Flow with PKCE)

Do ứng dụng chạy trên máy tính (CLI/Local) không thể lưu trữ `client_secret` một cách an toàn và không có máy chủ web công cộng, chúng ta sẽ sử dụng PKCE (Proof Key for Code Exchange). 

**Luồng hoạt động:**
1. Tạo một mã bí mật ngẫu nhiên (`code_verifier`) và băm nó ra thành `code_challenge`.
2. Khởi động một Local Server (ví dụ ở cổng `1455`) để hứng mã trả về.
3. Mở trình duyệt web trỏ tới trang đăng nhập của OpenAI, kèm theo `client_id` và `code_challenge`.
4. Người dùng đăng nhập, OpenAI sẽ chuyển hướng (redirect) về lại Local Server kèm theo mã uỷ quyền (`code`).
5. Local Server nhận được `code`, tắt server, và gọi API của OpenAI (kèm `code` và `code_verifier`) để đổi lấy Token (gồm `access_token` và `refresh_token`).

## 2. Chuẩn bị Môi trường và Cài đặt

Khởi tạo một dự án Node.js mới và cài đặt 2 thư viện cần thiết:

```bash
mkdir openai-local-login
cd openai-local-login
npm init -y

# Cài đặt express để tạo local server và open để tự động mở trình duyệt
npm install express open
```

## 3. Triển khai Code

Tạo một file có tên `index.js` và copy toàn bộ đoạn mã sau vào:

```javascript
const express = require('express');
const open = require('open');
const crypto = require('crypto');
const http = require('http');

// ==========================================
// CẤU HÌNH OAUTH CỦA OPENAI (Dựa trên 9router)
// ==========================================
const CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  port: 1455,
  get redirectUri() {
    return `http://localhost:${this.port}/callback`;
  }
};

// ==========================================
// HÀM HỖ TRỢ PKCE (Tạo chuỗi bảo mật)
// ==========================================
function base64URLEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ==========================================
// CHƯƠNG TRÌNH CHÍNH
// ==========================================
async function loginToOpenAI() {
  console.log("🚀 Bắt đầu quá trình đăng nhập OpenAI...");

  // 1. Khởi tạo mã PKCE và State
  const pkce = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  // 2. Tạo đường dẫn Authorization URL
  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.clientId,
    redirect_uri: CONFIG.redirectUri,
    scope: CONFIG.scope,
    state: state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    originator: "openai_native", // Optional extra param
  });
  
  const authUrl = `${CONFIG.authorizeUrl}?${authParams.toString()}`;

  // 3. Khởi động Local Web Server để hứng callback
  const app = express();
  let server;

  const codePromise = new Promise((resolve, reject) => {
    app.get('/callback', (req, res) => {
      const { code, state: returnedState, error } = req.query;

      if (error) {
        res.send(`<h1>Lỗi đăng nhập!</h1><p>${error}</p>`);
        return reject(new Error(error));
      }

      if (state !== returnedState) {
        res.send(`<h1>Lỗi bảo mật!</h1><p>State không khớp.</p>`);
        return reject(new Error("State mismatch"));
      }

      // Thông báo thành công trên trình duyệt
      res.send(`
        <h1>✅ Đăng nhập thành công!</h1>
        <p>Vui lòng quay lại màn hình Terminal.</p>
        <script>window.close();</script>
      `);
      
      resolve(code);
    });
  });

  server = http.createServer(app);
  await new Promise(resolve => server.listen(CONFIG.port, resolve));
  console.log(`🌍 Local Server đang chạy tại http://localhost:${CONFIG.port}`);

  // 4. Mở trình duyệt web
  console.log("🌐 Đang mở trình duyệt để bạn đăng nhập...");
  await open(authUrl);

  try {
    // 5. Chờ nhận được Authorization Code
    const code = await codePromise;
    console.log("🔑 Đã nhận được Authorization Code. Đang tiến hành đổi Token...");

    // 6. Tắt server vì không cần thiết nữa
    server.close();

    // 7. Gọi API đổi Code lấy Token
    const tokenResponse = await fetch(CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CONFIG.clientId,
        code: code,
        redirect_uri: CONFIG.redirectUri,
        code_verifier: pkce.verifier
      })
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      throw new Error(`Lỗi đổi token: ${errText}`);
    }

    const tokens = await tokenResponse.json();
    
    console.log("\n🎉 HOÀN TẤT! Dưới đây là thông tin Token của bạn:\n");
    console.log(JSON.stringify(tokens, null, 2));

    // Bạn có thể lưu JSON này ra file ở đây nếu muốn
    const fs = require('fs');
    fs.writeFileSync('openai_tokens.json', JSON.stringify(tokens, null, 2));
    console.log("\n💾 Token đã được lưu vào file openai_tokens.json");

  } catch (error) {
    console.error("❌ Xảy ra lỗi:", error.message);
    if (server) server.close();
  }
}

// Chạy chương trình
loginToOpenAI();
```

## 4. Cách sử dụng

Mở Terminal và chạy lệnh:
```bash
node index.js
```

Chương trình sẽ tự động mở trình duyệt. Sau khi bạn đăng nhập OpenAI thành công, token sẽ in ra màn hình Terminal và được lưu vào file `openai_tokens.json`.

---

## 5. Mang Token sang dự án 9router (Hoặc dự án khác)

Khi bạn đã có file `openai_tokens.json`, nó sẽ chứa `access_token` và `refresh_token`.

Để 9router nhận diện được đăng nhập này, bạn có thể thực hiện một request giả lập lại hành vi của CLI cũ. 

Dùng Postman hoặc viết một script (fetch) gửi HTTP `POST` tới API nội bộ của 9router (Ví dụ: `http://localhost:3000/api/cli/providers/openai`) như sau:

**Endpoint:** `POST /api/cli/providers/openai`
**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <SERVER_TOKEN_CỦA_9ROUTER>`
- `X-User-Id: <USER_ID_CỦA_BẠN>`

**Body (JSON):**
```json
{
  "accessToken": "<Lấy access_token từ file json sinh ra>",
  "refreshToken": "<Lấy refresh_token từ file json sinh ra>",
  "expiresIn": 2592000,
  "idToken": "<Lấy id_token từ file json sinh ra>",
  "scope": "openid profile email offline_access"
}
```

Bằng cách này, `9router` sẽ chấp nhận token vừa tạo như thể nó được đăng nhập trực tiếp từ ứng dụng của chính nó. Vì cả hai đều dùng chung `client_id` là `app_EMoamEEZ73f0CkXaXp7hrann`, các chức năng như tự động Refresh Token của 9router vẫn sẽ hoạt động hoàn hảo.
