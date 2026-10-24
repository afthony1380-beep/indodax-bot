require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');

const apiKey = process.env.INDODAX_API_KEY;
const secretKey = process.env.INDODAX_SECRET_KEY;
const pair = 'btc_idr'; 

// Pengaturan Konfigurasi Bot & Manajemen Risiko
const CAPITAL_IDR = 15000;          // Modal per transaksi (sesuaikan minimal order Indodax)
const TAKE_PROFIT_PCT = 1.05;       // Target Profit 5% dari harga beli
const STOP_LOSS_PCT = 0.97;         // Batas Rugi / Cut Loss di -3%
const RSI_PERIOD = 14;              // Periode perhitungan RSI

let priceHistory = [];              // Menyimpan riwayat harga
let botState = 'WAITING';           // Status bot: WAITING, HOLDING_ASSET
let activeBuyPrice = 0;             // Mencatat harga saat kita beli

// Fungsi Tanda Tangan Keamanan (HMAC-SHA512) untuk Private API Indodax
function signRequest(params) {
    const query = querystring.stringify(params);
    const sign = crypto.createHmac('sha512', secretKey).update(query).digest('hex');
    return { query, sign };
}

// 1. Ambil Harga Pasar Terkini (Public API)
async function checkPrice() {
    try {
        const response = await axios.get(`https://indodax.com/api/${pair}/ticker`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const price = parseFloat(response.data.ticker.last);
        console.log(`[INFO] Harga terkini ${pair.toUpperCase()}: Rp ${price.toLocaleString('id-ID')}`);
        
        processTradingLogic(price);
    } catch (error) {
        console.error('Gagal mengambil harga:', error.message);
    }
}

// 2. Kalkulator Indikator RSI Sederhana (SUDAH DIPERBAIKI)
function calculateRSI(prices) {
    if (prices.length < RSI_PERIOD + 1) return 50; // Nilai netral jika data belum cukup
    
    let gains = 0;
    let losses = 0;
    
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

// 3. Logika Utama Pasar & Manajemen Risiko (RSI + Stop Loss / Take Profit)
function processTradingLogic(currentPrice) {
    priceHistory.push(currentPrice);
    if (priceHistory.length > 50) priceHistory.shift(); // Batasi memori riwayat harga

    const currentRsi = calculateRSI(priceHistory);
    console.log(`[ANALISIS] Status Bot: ${botState} | RSI Terkini: ${currentRsi.toFixed(2)}`);

    // SKENARIO A: Jika bot sedang tidak punya aset, cari sinyal BELI (RSI < 30 / Oversold)
    if (botState === 'WAITING') {
        if (currentRsi < 30) {
            console.log(`🟢 [SINYAL BUY] RSI jenuh jual (< 30) terdeteksi! Waktunya akumulasi.`);
            // executeOrder('buy', currentPrice); // Buka komentar jika ingin live order
            activeBuyPrice = currentPrice;
            botState = 'HOLDING_ASSET';
        } else {
            console.log(`⚪ [WAIT] Pasar belum valid untuk beli. Menunggu momentum...`);
        }
    } 
    // SKENARIO B: Jika sedang memegang aset, pantau Take Profit atau Stop Loss
    else if (botState === 'HOLDING_ASSET') {
        const profitTarget = activeBuyPrice * TAKE_PROFIT_PCT;
        const lossLimit = activeBuyPrice * STOP_LOSS_PCT;

        console.log(`🎯 [PANTAU] Harga Beli: Rp ${activeBuyPrice.toLocaleString('id-ID')} | Target TP: Rp ${profitTarget.toLocaleString('id-ID')} | Batas SL: Rp ${lossLimit.toLocaleString('id-ID')}`);

        if (currentPrice >= profitTarget) {
            console.log(`💰 [TAKE PROFIT] Target keuntungan tercapai! Mengeksekusi JUAL...`);
            // executeOrder('sell', currentPrice); // Buka komentar jika ingin live order
            botState = 'WAITING';
        } else if (currentPrice <= lossLimit) {
            console.log(`⚠️ [STOP LOSS] Batas cut-loss tersentuh! Mengamankan dana...`);
            // executeOrder('sell', currentPrice); // Buka komentar jika ingin live order
            botState = 'WAITING';
        } else {
            console.log(`⏳ [HOLD] Posisi aman, menunggu target profit atau cut-loss.`);
        }
    }
}

// 4. Eksekusi Order ke Server Indodax (Trade API)
async function executeOrder(type, price) {
    try {
        const url = 'https://indodax.com/tapi';
        const nonce = Date.now();
        
        const params = {
            method: 'trade',
            pair: pair,
            type: type, // 'buy' atau 'sell'
            price: price,
            idr: CAPITAL_IDR,
            nonce: nonce
        };

        const { query, sign } = signRequest(params);

        const response = await axios.post(url, query, {
            headers: {
                'Key': apiKey,
                'Sign': sign,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.data.success === 1) {
            console.log(`✅ [BERHASIL] Order ${type.toUpperCase()} dieksekusi!`, response.data.return);
        } else {
            console.log(`❌ [GAGAL ORDER]:`, response.data.error);
        }
    } catch (error) {
        console.error('Error jaringan saat eksekusi order:', error.message);
    }
}

// 5. Inisialisasi & Loop Bot Otomatis
async function startBot() {
    console.log('==================================================');
    console.log('🤖 Bot Trading Indodax Pro (RSI + Risk Management)');
    console.log('==================================================');
    
    await checkPrice();

    // Pengecekan otomatis berkala setiap 30 detik
    setInterval(async () => {
        console.log('\n--------------------------------------------------');
        await checkPrice();
    }, 30000);
}

startBot();