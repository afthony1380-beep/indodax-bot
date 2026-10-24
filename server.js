require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('view engine', 'ejs');
app.engine('html', require('ejs').renderFile);
app.set('views', path.join(__dirname, 'views'));

let apiKey = process.env.INDODAX_API_KEY || '';
let secretKey = process.env.INDODAX_SECRET_KEY || '';
const pair = 'btc_idr'; 

// Konfigurasi Token & Chat ID Telegram
const TELEGRAM_TOKEN = process.env.TG_TOKEN || '8676662256:AAERMgRvsqnZfe6cWekorUFOVv6pQEatwSw';
const CHAT_ID = process.env.TG_CHAT_ID || '1935114828';

const CAPITAL_IDR = 50000000;       
const TAKE_PROFIT_PCT = 1.025;      
const STOP_LOSS_PCT = 0.985;        
const RSI_PERIOD = 14;

let priceHistory = [];
let botState = 'IDLE';              
let activeBuyPrice = 0;
let currentPrice = 1450000000;
let currentRsi = 50;
let currentEma9 = 0;
let currentEma21 = 0;
let logs = [];
let portfolioValue = CAPITAL_IDR;
let totalPnL = 0;

// Fungsi Kirim Notifikasi ke Telegram
async function sendTelegram(message) {
    if (!TELEGRAM_TOKEN || !CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Pesan sukses terkirim ke HP!');
    } catch (e) {
        console.error('Telegram Error:', e.response?.data || e.message);
    }
}

function addLog(message) {
    const time = new Date().toLocaleTimeString();
    logs.push({ time, message });
    if (logs.length > 50) logs.shift();
    console.log(`[${time}] ${message}`);
}

function calculateRSI(prices) {
    if (prices.length < RSI_PERIOD + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - RSI_PERIOD; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    const avgGain = gains / RSI_PERIOD;
    const avgLoss = losses / RSI_PERIOD;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateEMA(prices, period) {
    if (prices.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = (prices[i] * k) + (ema * (1 - k));
    }
    return ema;
}

// 🔐 Fungsi Pembuatan Signature Keamanan untuk API Indodax Live Trading
function indodaxRequest(method, endpointParams) {
    return new Promise(async (resolve, reject) => {
        if (!apiKey || !secretKey) {
            return reject(new Error('API Key atau Secret Key belum dikonfigurasi!'));
        }

        const tonce = Date.now();
        const payload = {
            method: method,
            tonce: tonce,
            ...endpointParams
        };

        const postData = querystring.stringify(payload);
        const sign = crypto.createHmac('sha512', secretKey).update(postData).digest('hex');

        try {
            const response = await axios.post('https://indodax.com/tapi', postData, {
                headers: {
                    'Key': apiKey,
                    'Sign': sign,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            resolve(response.data);
        } catch (error) {
            reject(error);
        }
    });
}

// 🛒 Fungsi Eksekusi Live Order ke Server Indodax (Real Buy/Sell)
async function executeLiveOrder(type, price, rpAmount) {
    try {
        // Contoh untuk pair btc_idr, konversi nominal rupiah ke estimasi koin atau limit order
        const estimatedCoin = rpAmount / price;
        addLog(`⚡ [LIVE API] Mengirim order ${type.toUpperCase()} ke Indodax...`);
        
        // Memanggil fungsi TAPI Indodax (trade API)
        const result = await indodaxRequest('trade', {
            pair: pair,
            type: type, // 'buy' atau 'sell'
            idr: rpAmount // jumlah dalam rupiah yang dialokasikan
        });

        if (result.success === 1) {
            addLog(`✅ [LIVE ORDER BERHASIL] ${type.toUpperCase()} di Indodax Eksekusi! ID: ${result.return.order_id}`);
            sendTelegram(`🚨 *[LIVE INDODAX ORDER SUKSES]*\nTipe: *${type.toUpperCase()}*\nPair: ${pair.toUpperCase()}\nJumlah: Rp ${rpAmount.toLocaleString('id-ID')}\nStatus: Berhasil Dieksekusi ke Pasar Real!`);
        } else {
            addLog(`❌ [LIVE ORDER GAGAL] ${result.error}`);
            sendTelegram(`⚠️ *[LIVE ORDER GAGAL]*\nAlasan: ${result.error}`);
        }
    } catch (e) {
        addLog(`❌ [API ERROR] Gagal koneksi trading live: ${e.message}`);
    }
}

async function checkPrice() {
    try {
        const response = await axios.get(`https://indodax.com/api/${pair}/ticker`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        
        currentPrice = parseFloat(response.data.ticker.last);
        priceHistory.push(currentPrice);
        if (priceHistory.length > 50) priceHistory.shift();

        currentRsi = calculateRSI(priceHistory);
        currentEma9 = calculateEMA(priceHistory, 9);
        currentEma21 = calculateEMA(priceHistory, 21);

        addLog(`Harga terkini BTC: Rp ${currentPrice.toLocaleString('id-ID')} | RSI: ${currentRsi.toFixed(2)} | EMA9: ${Math.round(currentEma9).toLocaleString('id-ID')}`);

        processTradingLogic(currentPrice);
    } catch (error) {
        addLog(`Gagal mengambil harga: ${error.message}`);
    }
}

function processTradingLogic(price) {
    if (botState === 'RUNNING' || botState === 'WAITING' || botState === 'IDLE') {
        if (currentRsi < 35 && currentEma9 > currentEma21) {
            addLog(`🟢 [SINYAL VVIP BUY] RSI Oversold & EMA Trend Bullish terdeteksi!`);
            activeBuyPrice = price;
            botState = 'HOLDING';
            
            sendTelegram(`🛒 *[BUY VVIP SIGNAL]*\nMembeli BTC @ Rp ${price.toLocaleString('id-ID')}\nRSI: ${currentRsi.toFixed(2)}`);

            // Panggil eksekusi live order ke Indodax (Alokasi Rp 100,000 minimal test atau sesuaikan CAPITAL_IDR)
            // executeLiveOrder('buy', price, 100000); 
        }
    } else if (botState === 'HOLDING') {
        const profitTarget = activeBuyPrice * TAKE_PROFIT_PCT;
        const lossLimit = activeBuyPrice * STOP_LOSS_PCT;

        if (price >= profitTarget) {
            addLog(`💰 [TAKE PROFIT] Target keuntungan tercapai!`);
            const pnl = price - activeBuyPrice;
            totalPnL += pnl;
            botState = 'RUNNING';
            
            sendTelegram(`💰 *[TAKE PROFIT VVIP]*\nTarget keuntungan tercapai di Rp ${price.toLocaleString('id-ID')}!\nP/L: +Rp ${pnl.toLocaleString('id-ID')}`);
            
            // executeLiveOrder('sell', price, 100000);
        } else if (price <= lossLimit) {
            addLog(`⚠️ [STOP LOSS] Batas cut-loss tersentuh!`);
            const pnl = activeBuyPrice - price;
            totalPnL -= pnl;
            botState = 'RUNNING';
            
            sendTelegram(`⚠️ *[STOP LOSS VVIP]*\nBatas cut-loss tersentuh di Rp ${price.toLocaleString('id-ID')}.\nKerugian: -Rp ${pnl.toLocaleString('id-ID')}`);
            
            // executeLiveOrder('sell', price, 100000);
        }
    }
}

// 📊 Laporan Rekap Berkala ke Telegram
async function sendPeriodicReport() {
    const reportMsg = `📊 *[REKAP PORTOFOLIO VVIP LIVE]*\n` +
                      `----------------------------------\n` +
                      `🔹 Status Bot: *${botState}*\n` +
                      `🔹 Harga BTC: Rp ${currentPrice.toLocaleString('id-ID')}\n` +
                      `🔹 RSI (14): ${currentRsi.toFixed(2)}\n` +
                      `🔹 Total P/L: Rp ${totalPnL.toLocaleString('id-ID')}\n` +
                      `🔹 Modal Simulasi: Rp ${CAPITAL_IDR.toLocaleString('id-ID')}\n` +
                      `----------------------------------\n` +
                      `🤖 Sistem Live Trading API siap beroperasi.`;
    await sendTelegram(reportMsg);
}

app.get('/api/check-connection', (req, res) => {
    if (process.env.INDODAX_API_KEY && process.env.INDODAX_SECRET_KEY) {
        res.json({ connected: true, message: 'API Key terdeteksi dan terhubung!' });
    } else {
        res.json({ connected: false, message: 'API Key belum diatur' });
    }
});

app.post('/api/config', (req, res) => {
    const { indodaxKey, indodaxSecret } = req.body;
    if (indodaxKey && indodaxSecret) {
        apiKey = indodaxKey;
        secretKey = indodaxSecret;
        const envData = `INDODAX_API_KEY=${apiKey}\nINDODAX_SECRET_KEY=${secretKey}\n`;
        fs.writeFileSync('.env', envData);
        addLog(`✅ [SISTEM] API Key & Secret Key baru berhasil disimpan!`);
        res.json({ success: true, message: 'Berhasil disimpan!' });
    } else {
        res.json({ success: false, message: 'Kunci wajib diisi!' });
    }
});

app.get('/', (req, res) => {
    res.render('index.ejs', { currentPrice, botState, currentRsi, logs, portfolioValue, totalPnL });
});

app.get('/api/status', (req, res) => {
    res.json({ currentPrice, botState, currentRsi, logs, portfolioValue, totalPnL });
});

app.listen(PORT, async () => {
    addLog(`🚀 Quant Engine v4.5 PRO (Live Trading API) aktif di http://localhost:${PORT}`);
    await sendTelegram("🚀 *[VVIP ENGINE FULL SYSTEM]* Multi-Strategy + Auto Report + Indodax Live API Ready!");
    
    checkPrice();
    setInterval(checkPrice, 30000);
    setInterval(sendPeriodicReport, 3600000);
});