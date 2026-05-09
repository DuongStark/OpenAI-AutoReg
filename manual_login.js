const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

chromium.use(stealth);

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
    return `http://localhost:${this.port}/auth/callback`;
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
// HÀM PARSE VÀ FORMAT TOKEN DATA
// ==========================================
function decodeJwtPayload(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

function formatProfileData(tokens, priority = 1) {
  const decodedIdToken = decodeJwtPayload(tokens.id_token || tokens.access_token);
  const email = decodedIdToken?.email || decodedIdToken?.["https://api.openai.com/profile"]?.email || "";
  const authData = decodedIdToken?.["https://api.openai.com/auth"] || {};
  
  const now = new Date();
  const expiresIn = tokens.expires_in || 863999;
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  
  return {
      "id": crypto.randomUUID(), 
      "provider": "codex",
      "authType": "oauth",
      "name": email,
      "priority": priority,
      "isActive": false,
      "createdAt": now.toISOString(),
      "updatedAt": now.toISOString(),
      "email": email,
      "accessToken": tokens.access_token,
      "refreshToken": tokens.refresh_token,
      "expiresAt": expiresAt,
      "testStatus": "unavailable",
      "expiresIn": expiresIn,
      "providerSpecificData": {
        "chatgptAccountId": authData.chatgpt_account_id || "",
        "chatgptPlanType": authData.chatgpt_plan_type || ""
      },
      "lastUsedAt": null,
      "consecutiveUseCount": 0,
      "lastError": null,
      "lastErrorAt": null,
      "errorCode": null,
      "backoffLevel": 0
  };
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
    originator: "openai_native", 
  });
  
  const authUrl = `${CONFIG.authorizeUrl}?${authParams.toString()}`;

  // 3. Khởi động Local Web Server để hứng callback
  const app = express();
  let server;

  const codePromise = new Promise((resolve, reject) => {
    app.get('/auth/callback', (req, res) => {
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
      `);
      
      resolve(code);
    });
  });

  server = http.createServer(app);
  await new Promise(resolve => server.listen(CONFIG.port, resolve));
  console.log(`🌍 Local Server đang chạy tại http://localhost:${CONFIG.port}`);

  // 4. Mở trình duyệt bằng Playwright
  console.log("🌐 Đang mở trình duyệt ẨN DANH...");
  const browser = await chromium.launch({ headless: false }); // Mở trình duyệt có giao diện
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto(authUrl);

  // --- PHẦN TỰ ĐỘNG HÓA THEO YÊU CẦU ---
  try {
    // Hàm tạo email ngẫu nhiên
    function generateRandomEmail() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let prefix = '';
      for (let i = 0; i < 10; i++) {
        prefix += chars[Math.floor(Math.random() * chars.length)];
      }
      return prefix + '@pixpress.art';
    }

    console.log("🖱️ Đang bấm vào link đăng ký...");
    const signUpSelector = '#_r_1_ > div._section_1wcdi_7._ctas_1wcdi_13 > span > a';
    await page.waitForSelector(signUpSelector, { timeout: 15000 });
    await page.click(signUpSelector);

    console.log("📧 Đang tạo email ngẫu nhiên...");
    const randomEmail = generateRandomEmail();
    console.log(`=> Email mới: ${randomEmail}`);

    console.log("✍️ Đang điền Email và ấn Enter...");
    const emailInputSelector = 'input[name="email"], input[type="email"]';
    await page.waitForSelector(emailInputSelector, { timeout: 15000 });
    // Chờ một chút để ô input sẵn sàng
    await page.waitForTimeout(500);
    await page.fill(emailInputSelector, randomEmail);
    await page.press(emailInputSelector, 'Enter');

    console.log("⏸️ Đã điền xong Email. Mời bạn kiểm tra trình duyệt và cho biết bước tiếp theo...");
  } catch (err) {
    console.error("Lỗi Playwright ở bước điền Email:", err.message);
  }
  // ------------------------------------

  try {
    // 5. Chờ nhận được Authorization Code
    const code = await codePromise;
    console.log("🔑 Đã nhận được Authorization Code. Đang tiến hành đổi Token...");

    // 6. Đóng trình duyệt và server
    await browser.close();
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
    
    // Đọc file cũ để tính priority và giữ lại các nick cũ
    const fileName = 'openai_tokens_manual.json';
    let existingData = [];
    if (fs.existsSync(fileName)) {
      try {
        const fileContent = fs.readFileSync(fileName, 'utf8');
        const parsed = JSON.parse(fileContent);
        existingData = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        existingData = [];
      }
    }

    const maxPriority = existingData.reduce((max, item) => Math.max(max, item.priority || 0), 0);
    const newPriority = maxPriority + 1;
    
    // Format lại data theo chuẩn yêu cầu
    const formattedData = formatProfileData(tokens, newPriority);
    
    // Thêm nick mới vào danh sách
    existingData.push(formattedData);

    console.log("\n🎉 HOÀN TẤT! Dưới đây là thông tin Token của bạn:\n");
    console.log(JSON.stringify(formattedData, null, 2));

    // Lưu JSON ra file
    fs.writeFileSync(fileName, JSON.stringify(existingData, null, 2));
    console.log(`\n💾 Token đã được lưu (Tổng tài khoản: ${existingData.length}) vào file ${fileName}`);

  } catch (error) {
    console.error("❌ Xảy ra lỗi:", error.message);
    if (server) server.close();
    await browser.close();
  }
}

// Chạy chương trình
loginToOpenAI();

