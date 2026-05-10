const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

chromium.use(stealth);

// ==========================================
// ĐỌC CẤU HÌNH TỪ WEB UI
// ==========================================
let UI_CONFIG = { viotpToken: "", accountCount: 1 };
if (fs.existsSync('ui_config.json')) {
    try {
        UI_CONFIG = JSON.parse(fs.readFileSync('ui_config.json', 'utf8'));
    } catch (e) {}
}

const VIOTP_API_TOKEN = UI_CONFIG.viotpToken;
if (!VIOTP_API_TOKEN) {
    console.error("[Lỗi] Chưa cấu hình API Token ViOTP. Vui lòng thiết lập trên giao diện!");
    process.exit(1);
}
const VIOTP_SERVICE_ID = 7; // Thường OpenAI là số 7 trên ViOTP. Nếu sai bạn sửa ở đây.

async function rentPhoneNumber() {
    const url = `https://api.viotp.com/request/getv2?token=${VIOTP_API_TOKEN}&serviceId=${VIOTP_SERVICE_ID}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status_code === 200 && json.success) {
        return {
            phoneNumber: json.data.phone_number,
            requestId: json.data.request_id
        };
    }
    throw new Error("Không thể thuê số: " + json.message);
}

async function waitForSmsCode(requestId) {
    console.log(`[WAIT] Đang chờ mã OTP SMS (Timeout: 2 phút)...`);
    const url = `https://api.viotp.com/session/getv2?requestId=${requestId}&token=${VIOTP_API_TOKEN}`;
    for (let i = 0; i < 40; i++) {
        await new Promise(res => setTimeout(res, 3000));
        try {
            const res = await fetch(url);
            const json = await res.json();
            if (json.status_code === 200 && json.data) {
                if (json.data.Status === 1) return json.data.Code;
                if (json.data.Status === 2) throw new Error("Hết hạn thuê số");
            }
        } catch (e) { }
    }
    throw new Error("Hết thời gian chờ mã OTP SMS.");
}

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
      "isActive": true,
      "createdAt": now.toISOString(),
      "updatedAt": now.toISOString(),
      "email": email,
      "accessToken": tokens.access_token,
      "refreshToken": tokens.refresh_token,
      "expiresAt": expiresAt,
      "testStatus": "active",
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
  console.log("[SYSTEM] Bắt đầu quá trình đăng nhập OpenAI...");

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
        <h1> Đăng nhập thành công!</h1>
        <p>Vui lòng quay lại màn hình Terminal.</p>
      `);
      
      resolve(code);
    });
  });

  server = http.createServer(app);
  await new Promise(resolve => server.listen(CONFIG.port, resolve));
  console.log(` Local Server đang chạy tại http://localhost:${CONFIG.port}`);

  // 4. Mở trình duyệt bằng Playwright
  console.log("[ACTION] Đang mở trình duyệt ẨN DANH...");
  // Đặt kích thước màn hình dọc (như mobile) để cửa sổ gọn gàng, không choán chỗ
  const browser = await chromium.launch({ 
      headless: false,
      args: ['--window-size=450,850'] 
  }); 
  const context = await browser.newContext({
      viewport: { width: 450, height: 800 }
  });
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

    // Hàm gọi API lấy mã xác nhận
    async function waitForEmailCode(email) {
      console.log(`[WAIT] Đang chờ email chứa mã xác nhận gửi tới ${email}...`);
      const inboxUrl = `https://temp-mail.starkduong.workers.dev/inbox?email=${email}`;
      
      for (let i = 0; i < 30; i++) { // Thử tối đa 30 lần (90 giây)
        await new Promise(res => setTimeout(res, 3000)); // Delay 3 giây mỗi vòng
        try {
          const res = await fetch(inboxUrl);
          const inbox = await res.json();
          if (inbox && inbox.length > 0) {
            // Lấy id của thư trên cùng
            const topMailId = inbox[0].id;
            
            // Gọi API lấy nội dung chi tiết của mail
            const messageUrl = `https://temp-mail.starkduong.workers.dev/message?email=${email}&id=${topMailId}`;
            const msgRes = await fetch(messageUrl);
            const mailDetail = await msgRes.json();

            if (mailDetail && mailDetail.body) {
              // Dùng Regex tìm 6 chữ số liên tiếp
              const match = mailDetail.body.match(/\b(\d{6})\b/);
              if (match) {
                console.log(`[SUCCESS] Đã lấy được mã xác nhận: ${match[1]}`);
                return match[1];
              }
            }
          }
        } catch (e) {
          // Bỏ qua lỗi fetch và thử lại
        }
      }
      throw new Error("Không nhận được mã xác nhận sau 90 giây.");
    }

    console.log("[ACTION] Đang bấm vào link đăng ký...");
    const signUpSelector = '#_r_1_ > div._section_1wcdi_7._ctas_1wcdi_13 > span > a';
    await page.waitForSelector(signUpSelector, { timeout: 15000 });
    await page.click(signUpSelector);

    console.log("� Đang tạo email ngẫu nhiên...");
    const randomEmail = generateRandomEmail();
    console.log(`[INFO] => Email mới: ${randomEmail}`);

    console.log("[ACTION] Đang điền Email và ấn Enter...");
    const emailInputSelector = 'input[name="email"], input[type="email"]';
    await page.waitForSelector(emailInputSelector, { timeout: 15000 });
    // Chờ một chút để ô input sẵn sàng
    await page.waitForTimeout(500);
    await page.fill(emailInputSelector, randomEmail);
    await page.press(emailInputSelector, 'Enter');

    // Hàm tạo password ngẫu nhiên (ít nhất 12 ký tự)
    function generateRandomPassword() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
      let pass = '';
      for (let i = 0; i < 14; i++) {
        pass += chars[Math.floor(Math.random() * chars.length)];
      }
      return pass + 'A1!'; // Đảm bảo luôn có chữ hoa, số và ký tự đặc biệt
    }

    console.log("[PROCESS] Đang tạo mật khẩu ngẫu nhiên...");
    const randomPassword = generateRandomPassword();
    console.log(`[INFO] => Mật khẩu mới: ${randomPassword}`);

    console.log("[WAIT] Đang chờ ô nhập Mật khẩu...");
    // Selector của ô nhập mật khẩu. Dùng type="password" vì ID react-aria là ID tự động thay đổi
    const passwordSelector = 'input[type="password"], input[name="password"]';
    await page.waitForSelector(passwordSelector, { timeout: 15000 });
    await page.waitForTimeout(1000); // Chờ animation chuyển cảnh
    await page.fill(passwordSelector, randomPassword);
    await page.press(passwordSelector, 'Enter');

    console.log("[PROCESS] Đang lưu tài khoản và mật khẩu vào file accounts.json...");
    const accountsFile = 'accounts.json';
    let accountsList = [];
    if (fs.existsSync(accountsFile)) {
      try {
        accountsList = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
        if (!Array.isArray(accountsList)) accountsList = [accountsList];
      } catch (e) {
        accountsList = [];
      }
    }
    accountsList.push({
      email: randomEmail,
      password: randomPassword,
      createdAt: new Date().toISOString()
    });
    fs.writeFileSync(accountsFile, JSON.stringify(accountsList, null, 2));
    console.log("[SUCCESS] Đã lưu xong vào accounts.json!");

    // Chờ và lấy mã OTP từ API mail
    const verificationCode = await waitForEmailCode(randomEmail);

    console.log("[ACTION] Đang tự động điền mã xác nhận...");
    // Ô OTP thường là các ô input có type="text" hoặc inputmode="numeric".
    // Playwright sẽ tự động phân phát chuỗi 6 ký tự vào các ô nếu focus vào ô đầu tiên.
    const otpSelector = 'input[inputmode="numeric"], input[name="code"]';
    await page.waitForSelector(otpSelector, { timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.fill(otpSelector, verificationCode);
    
    // Nhấn Enter để gửi mã
    await page.press(otpSelector, 'Enter');

    console.log("[SUCCESS] Đã điền xong mã xác nhận Email. Đang chờ chuyển sang bước nhập SĐT...");
    
    // ==========================================
    // BƯỚC XÁC MINH SỐ ĐIỆN THOẠI (ViOTP)
    // ==========================================
    
    // --- VÒNG LẶP LẤY SỐ & CHỜ SMS ---
    let smsCode = null;
    let maxRetries = 5; // Thử tối đa 5 số
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`\n[RETRY] [Lần ${attempt}] Đang xử lý màn hình nhập số điện thoại...`);
        
        const phoneInputSelector = '.PhoneInputInput input, input[type="tel"]';
        await page.waitForSelector(phoneInputSelector, { timeout: 10000 });
        
        // 0. Xóa số cũ (nếu có) TRƯỚC KHI chọn quốc gia
        // Nếu không xóa, lúc chọn VN xong nó sẽ tự nhảy lại +1 (do nhận diện số Mỹ cũ)
        await page.fill(phoneInputSelector, '');
        await page.waitForTimeout(200);

        // 1. Luôn luôn chọn lại quốc gia Việt Nam (phòng trường hợp form bị reset khi quay lại)
        const countryDropdownButton = 'button[aria-haspopup="listbox"]';
        console.log("[ACTION] Đang chọn quốc gia Việt Nam...");
        await page.waitForSelector(countryDropdownButton, { timeout: 20000 });
        await page.click(countryDropdownButton);
        await page.waitForTimeout(500);
        
        await page.keyboard.press('v');
        await page.waitForTimeout(500);
        for (let i = 0; i < 20; i++) {
            const vietnamOption = page.getByRole('option', { name: /Vietnam/i });
            if (await vietnamOption.isVisible()) {
                await vietnamOption.click();
                break;
            }
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(100);
        }
        await page.waitForTimeout(500);
        
        // 2. Lấy số điện thoại từ ViOTP
        const phoneData = await rentPhoneNumber();
        console.log(`[INFO] => Đã thuê được số: ${phoneData.phoneNumber}`);

        // 3. Điền số điện thoại
        await page.fill(phoneInputSelector, phoneData.phoneNumber);
        
        // Tạo "bẫy" để bắt luồng API xem OpenAI có chê số này không
        const responsePromise = page.waitForResponse(
          response => response.url().includes('add-phone/send') && response.request().method() === 'POST',
          { timeout: 15000 }
        ).catch(() => null);

        // Bấm gửi số
        await page.press(phoneInputSelector, 'Enter');
        
        // Chờ kết quả từ API của OpenAI
        const response = await responsePromise;
        if (response && response.status() === 400) {
            console.log("[ERROR] OpenAI từ chối số này (Lỗi 400). Sẽ đổi số khác ngay...");
            await page.waitForTimeout(2000); // Chờ 2s cho UI ổn định rồi thử vòng tiếp theo
            continue; 
        }

        // Nếu API trả về thành công (thường là 200), tiến hành chờ OTP
        try {
            smsCode = await waitForSmsCode(phoneData.requestId);
            console.log(`[SUCCESS] Đã lấy được mã SMS: ${smsCode}`);
            break; // Lấy thành công thì thoát vòng lặp
        } catch (e) {
            console.log(`[ERROR] Lỗi chờ OTP: ${e.message}. Đang ấn nút Quay lại (Back) để thử số khác...`);
            // Sử dụng tính năng "Go Back" của trình duyệt để quay ngược lại trang điền số điện thoại
            await page.goBack();
            await page.waitForTimeout(3000);
        }
    }

    if (!smsCode) {
        throw new Error("Đã thử hết 5 số mà vẫn thất bại. Dừng quá trình cho tài khoản này.");
    }

    // Điền mã OTP SMS vào web
    console.log("[ACTION] Đang điền mã SMS OTP...");
    // Tránh việc nhầm với ô OTP email lúc nãy bằng cách lấy ô nhập mã cuối cùng xuất hiện trên trang
    const smsOtpInputs = await page.locator('input[inputmode="numeric"]');
    await smsOtpInputs.last().waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(1000);
    await smsOtpInputs.last().fill(smsCode);
    await smsOtpInputs.last().press('Enter');

    console.log("[SUCCESS] Đã điền xong mã SMS! Trình duyệt đang chờ hoàn tất quá trình tạo tài khoản...");
    
    // ==========================================
    // BƯỚC HOÀN TẤT PROFILE (Tên & Ngày Sinh)
    // ==========================================
    console.log("[WAIT] Đang chờ trang điền thông tin cá nhân (Tên & Tuổi)...");
    
    // Chờ cho form nhập tên xuất hiện
    await page.waitForSelector('input[type="text"]', { timeout: 20000 });
    
    // 1. Nhập Tên random
    const firstNames = ["John", "David", "Michael", "Chris", "Sarah", "Anna", "Emily", "James", "Robert", "Linda"];
    const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis"];
    const randomName = firstNames[Math.floor(Math.random() * firstNames.length)] + " " + lastNames[Math.floor(Math.random() * lastNames.length)];
    
    console.log(` Đang điền tên: ${randomName}`);
    const nameInput = page.locator('input[type="text"]');
    await nameInput.first().fill(randomName);

    // 2. Nhập Tuổi random (18 - 60 tuổi)
    const randomAge = Math.floor(Math.random() * (60 - 18 + 1)) + 18;
    console.log(` Đang điền số tuổi: ${randomAge}...`);
    
    // Sử dụng selector input có name="age" hoặc type="number" như trong ảnh bạn cung cấp
    const ageInput = page.locator('input[name="age"], input[type="number"]');
    await ageInput.waitFor({ state: 'visible', timeout: 5000 });
    await ageInput.fill(randomAge.toString());
    
    // Nhấn Enter để gửi form
    await ageInput.press('Enter');

    // 3. Click Xác nhận màn hình 1
    console.log("[ACTION] Đang xác nhận màn hình onboarding 1...");
    await page.waitForTimeout(2000);
    // Sử dụng selector bắt class có chứa chữ _ctas_ (Call to Actions)
    let confirmBtn = page.locator('div[class*="_ctas_"] button');
    await confirmBtn.last().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await confirmBtn.last().isVisible()) {
        await confirmBtn.last().click();
    }

    // 4. Chờ và click Xác nhận màn hình 2
    console.log("[ACTION] Đang xác nhận màn hình onboarding 2...");
    await page.waitForTimeout(2000);
    confirmBtn = page.locator('div[class*="_ctas_"] button');
    await confirmBtn.last().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await confirmBtn.last().isVisible()) {
        await confirmBtn.last().click();
    }

    console.log("[SUCCESS] HOÀN TẤT ĐĂNG KÝ PROFILE!");

  } catch (err) {
    console.error("Lỗi Playwright ở bước đăng ký:", err.message);
  }
  // ------------------------------------

  try {
    // 5. Chờ nhận được Authorization Code
    const code = await codePromise;
    console.log("[SUCCESS] Đã nhận được Authorization Code. Đang tiến hành đổi Token...");

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

    console.log("\n[SYSTEM] HOÀN TẤT! Dưới đây là thông tin Token của bạn:\n");
    console.log(JSON.stringify(formattedData, null, 2));

    // Lưu JSON ra file
    fs.writeFileSync(fileName, JSON.stringify(existingData, null, 2));
    console.log(`\n[SUCCESS] Token đã được lưu (Tổng tài khoản: ${existingData.length}) vào file ${fileName}`);

  } catch (error) {
    console.error("[FATAL] Xảy ra lỗi:", error.message);
    if (server) server.close();
    await browser.close();
  }
}

// Hàm chạy vòng lặp tạo nhiều tài khoản
async function runAutomation() {
    const total = UI_CONFIG.accountCount || 1;
    for (let i = 1; i <= total; i++) {
        console.log(`\n======================================================`);
        console.log(`[SYSTEM] BẮT ĐẦU TẠO TÀI KHOẢN THỨ ${i} / ${total}`);
        console.log(`======================================================\n`);
        
        try {
            await loginToOpenAI();
            console.log(`\n[SUCCESS] Thành công tài khoản thứ ${i}! Nghỉ 5 giây trước khi tiếp tục...`);
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {
            console.error(`\n[ERROR] Lỗi nghiêm trọng ở tài khoản ${i}:`, e.message);
            console.log(`[WARN] Bỏ qua và chạy tiếp tài khoản sau...`);
        }
    }
    console.log(`\n[SYSTEM] ĐÃ HOÀN TẤT CHẠY ${total} TÀI KHOẢN!`);
    process.exit(0);
}

runAutomation();