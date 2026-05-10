const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const crypto = require('crypto');
const http = require('http');

chromium.use(stealth);

const CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  scope: "openid profile email offline_access",
  port: 1455,
  get redirectUri() {
    return `http://localhost:${this.port}/auth/callback`;
  }
};

function base64URLEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function openUIForInspection() {
  console.log("🚀 Đang khởi tạo URL đăng nhập OpenAI...");

  const pkce = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: CONFIG.clientId,
    redirect_uri: CONFIG.redirectUri,
    scope: CONFIG.scope,
    state: state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    originator: "openai_native", 
  });
  
  const authUrl = `${CONFIG.authorizeUrl}?${authParams.toString()}`;

  // Khởi tạo server nhỏ để nếu web có redirect về thì không bị lỗi
  const app = express();
  app.get('/auth/callback', (req, res) => {
      res.send(`<h1>Bạn đang ở chế độ Test UI.</h1><p>Quá trình đã hoàn tất, bạn có thể đóng trình duyệt.</p>`);
  });
  const server = http.createServer(app);
  server.listen(CONFIG.port);

  console.log("🌐 Đang mở trình duyệt để test giao diện...");
  const browser = await chromium.launch({ headless: false }); 
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto(authUrl);

  console.log("\n===================================================================");
  console.log("✅ TRÌNH DUYỆT ĐÃ MỞ THÀNH CÔNG VÀ ĐANG Ở TRANG ĐĂNG NHẬP OPENAI!");
  console.log("👉 Bây giờ bạn có thể thao tác tay trên trình duyệt.");
  console.log("👉 Bấm F12 để thoải mái xem ID/Class của các phần tử (Email, Password, SĐT, OTP...).");
  console.log("👉 Code Playwright sẽ DỪNG LẠI Ở ĐÂY, không tự điền gì cả, cũng KHÔNG TỰ ĐÓNG.");
  console.log("👉 Khi nào test xong, nhấn Ctrl + C ở cửa sổ terminal này để thoát.");
  console.log("===================================================================\n");
}

openUIForInspection();
