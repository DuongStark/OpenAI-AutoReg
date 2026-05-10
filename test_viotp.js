const API_TOKEN = "6b43c754ddb346e7a4d564320de6fe7e";
const SERVICE_ID = 1234; // ĐIỀN ID DỊCH VỤ CỦA OPENAI/CHATGPT VÀO ĐÂY (Vd: 1 là Momo, cần tìm ID của OpenAI)

async function testViOTP() {
    console.log("==========================================");
    console.log("🚀 BẮT ĐẦU TEST API ViOTP (KHÔNG DÙNG PLAYWRIGHT)");
    console.log("==========================================");

    if (API_TOKEN === "ĐIỀN_TOKEN_CỦA_BẠN_VÀO_ĐÂY") {
        console.log("❌ Vui lòng điền API_TOKEN của bạn vào dòng 1 của file này trước khi chạy!");
        return;
    }

    // 1. Lấy số điện thoại
    console.log(`\n1️⃣ Đang yêu cầu thuê số điện thoại cho Service ID: ${SERVICE_ID}...`);
    const requestUrl = `https://api.viotp.com/request/getv2?token=${API_TOKEN}&serviceId=${SERVICE_ID}`;
    
    let phoneNumber, requestId;
    try {
        const res = await fetch(requestUrl);
        const json = await res.json();
        
        if (json.status_code === 200 && json.success) {
            phoneNumber = json.data.phone_number;
            requestId = json.data.request_id;
            console.log(`✅ Thành công!`);
            console.log(`📞 Số điện thoại của bạn là: \x1b[32m${phoneNumber}\x1b[0m`);
            console.log(`(Mã giao dịch Request ID: ${requestId})`);
            console.log(`\n👉 BÂY GIỜ HÃY MỞ TRÌNH DUYỆT LÊN, NHẬP SỐ [${phoneNumber}] VÀO WEB VÀ ẤN GỬI MÃ.`);
            console.log(`(Lưu ý: Bạn có thể F12 trên trình duyệt để soi các Selector/ID trong lúc này)`);
        } else {
            console.log("❌ Lỗi khi lấy số:", json.message);
            return;
        }
    } catch (err) {
        console.log("❌ Lỗi kết nối API lấy số:", err.message);
        return;
    }

    // 2. Chờ mã OTP
    console.log(`\n2️⃣ Đang chờ mã OTP gửi về số ${phoneNumber} (Timeout: 2 phút)...`);
    const sessionUrl = `https://api.viotp.com/session/getv2?requestId=${requestId}&token=${API_TOKEN}`;
    
    let otpCode = null;
    let maxRetries = 40; // 40 lần * 3s = 120 giây (2 phút)
    
    for (let i = 0; i < maxRetries; i++) {
        process.stdout.write(`⏳ Lần check ${i + 1}/${maxRetries}... `);
        
        try {
            const res = await fetch(sessionUrl);
            const json = await res.json();
            
            if (json.status_code === 200 && json.data) {
                const status = json.data.Status;
                if (status === 1) { // Đã nhận mã
                    otpCode = json.data.Code;
                    console.log(`\n🎉 ĐÃ NHẬN ĐƯỢC TIN NHẮN!`);
                    console.log(`Nội dung SMS: ${json.data.SmsContent}`);
                    console.log(`🔑 MÃ OTP CỦA BẠN LÀ: \x1b[32m${otpCode}\x1b[0m`);
                    break;
                } else if (status === 2) { // Hết hạn
                    console.log(`\n⚠️ Yêu cầu đã bị HẾT HẠN bên phía ViOTP (Tiền sẽ được hoàn lại).`);
                    break;
                } else if (status === 0) { // Đang chờ
                    console.log(`Chưa có mã.`);
                }
            } else {
                console.log(`Lỗi API: ${json.message}`);
            }
        } catch (err) {
            console.log(`Lỗi mạng.`);
        }
        
        // Đợi 3 giây trước khi check lại
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    if (!otpCode) {
        console.log(`\n❌ Kết thúc: Không lấy được mã OTP.`);
    } else {
        console.log(`\n👉 HÃY NHẬP MÃ [${otpCode}] VÀO TRÌNH DUYỆT ĐỂ HOÀN TẤT.`);
    }
}

testViOTP();
