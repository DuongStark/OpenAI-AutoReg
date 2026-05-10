const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

let currentProcess = null;

app.post('/api/start', (req, res) => {
    if (currentProcess) {
        return res.status(400).json({ error: 'Automation is already running' });
    }
    
    const { viotpToken, mode, accountCount } = req.body;
    
    // Lưu cấu hình vào file để auto_reg.js đọc
    fs.writeFileSync('ui_config.json', JSON.stringify({ viotpToken, mode, accountCount }));
    
    // Chạy auto_reg.js như một tiến trình con
    currentProcess = spawn('node', ['auto_reg.js']);
    
    res.json({ success: true });
});

app.post('/api/stop', (req, res) => {
    if (currentProcess) {
        currentProcess.kill();
        currentProcess = null;
    }
    res.json({ success: true });
});

app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const onData = (data) => {
        res.write(`data: ${JSON.stringify({ text: data.toString() })}\n\n`);
    };
    
    if (currentProcess) {
        currentProcess.stdout.on('data', onData);
        currentProcess.stderr.on('data', onData);
        currentProcess.on('close', () => {
            res.write(`data: ${JSON.stringify({ text: '\n✅ [TIẾN TRÌNH ĐÃ HOÀN TẤT]', closed: true })}\n\n`);
            currentProcess = null;
        });
    } else {
        res.write(`data: ${JSON.stringify({ text: 'Chưa có tiến trình nào đang chạy...\n' })}\n\n`);
    }
    
    req.on('close', () => {
        if (currentProcess) {
            currentProcess.stdout.off('data', onData);
            currentProcess.stderr.off('data', onData);
        }
    });
});

app.listen(3000, () => {
    console.log('🚀 Giao diện Web Dashboard đang chạy tại: http://localhost:3000');
    console.log('Vui lòng mở trình duyệt và truy cập đường dẫn trên để sử dụng!');
});
