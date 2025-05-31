process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from "fs";
import path from "path";
import WebSocket from "ws";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { EMA } from "technicalindicators";
const BOT_TOKEN = "7550630369:AAHZM-GAPSsppbEawp14-d0KL5MFFShM_pc";
const CHAT_ID = "887640660";

dotenv.config();

/* === SEND TELEGRAM MESSAGE === */
const sendTelegram = async text => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: CHAT_ID,
                text,
                parse_mode: "Markdown",
            }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.description);
        console.log("📨 Telegram sent:", text);
    } catch (err) {
        console.error("❌ Telegram error:", err.message);
    }
};

/* === MAIN NOTIFICATION FUNCTION === */
const notify = async (subject, body) => {
    await sendTelegram(`*${subject}*\n${body}`);
};

/* === EMAIL SETTINGS === */
const EMAIL = "thinking1242@gmail.com";
const APP_PASSWORD = "iqmpamea jici ncxb";

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        user: EMAIL,
        pass: APP_PASSWORD,
    },
});

const sendMail = async (subject, body) => {
    try {
        console.log("📤 Sending mail:", subject);
        await transporter.sendMail({
            from: `\"EMA Bot\" <${EMAIL}>`,
            to: EMAIL,
            subject,
            text: body,
        });
        console.log("📧 Mail sent successfully");
    } catch (err) {
        console.error("❌ Email send error:", err.response || err.message);
    }
};

/* === CONFIG === */
const API_TOKEN = "Sst6KXGL2Nh8zpx";
const APP_ID = "1089";
const SYMBOLS = ['BOOM500','BOOM1000',"BOOM600","BOOM900",
    'CRASH500','CRASH600','CRASH900','CRASH1000'];
const EMA_FAST = 14;
const EMA_SLOW = 30;
const TIMEFRAME = 1800;
const WIN = 100;
const TRADE_AMOUNT = 1;
const STATE = path.resolve("trend_state.json");

/* === STATE === */
const lastTrend = Object.fromEntries(SYMBOLS.map((s) => [s, null]));
const lastBarEp = Object.fromEntries(SYMBOLS.map((s) => [s, null]));
if (fs.existsSync(STATE)) Object.assign(lastTrend, JSON.parse(fs.readFileSync(STATE)));
const saveTrend = () => fs.writeFileSync(STATE, JSON.stringify(lastTrend));

const buffers = Object.fromEntries(SYMBOLS.map((s) => [s, []]));
const openPos = {};  // Tracks active positions: { symbol: { id, direction } }

/* === Trade Execution === */
async function placeTrade(symbol, direction) {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

    ws.on("open", () => ws.send(JSON.stringify({ authorize: API_TOKEN })));

    const contractMultiplier = 100;

    ws.on("message", (data) => {
        const msg = JSON.parse(data);

        if (msg.error) {
            console.error(`❌ Trade error for ${symbol}: ${msg.error.message}`);
            notify(`⚠️ Trade Error: ${symbol}`, msg.error.message);
            return;
        }

        if (msg.msg_type === "authorize") {
            // const stopLoss = +(TRADE_AMOUNT * 0.5).toFixed(2);
            // const takeProfit = 5;

            const contract = {
                buy: 1,
                price: TRADE_AMOUNT,
                parameters: {
                    amount: TRADE_AMOUNT,
                    basis: "stake",
                    contract_type: direction === "up" ? "MULTUP" : "MULTDOWN",
                    currency: "USD",
                    symbol,
                    multiplier: contractMultiplier,
                    // limit_order: { take_profit: takeProfit,  },
                },
            };
            ws.send(JSON.stringify(contract));
        }

        if (msg.msg_type === "buy" && msg.buy?.contract_id) {
            const contractId = msg.buy.contract_id;
            openPos[symbol] = { id: contractId, direction };

            ws.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            }));

            console.log(`✅ Trade placed: ${symbol} [${direction}] | ID: ${contractId}`);
            notify(`📅 Trade Executed: ${symbol}`, `Direction: ${direction}\nContract ID: ${contractId}`);
        }

        if (msg.msg_type === "proposal_open_contract") {
            if (msg.proposal_open_contract.is_sold) {
                delete openPos[symbol];
                console.log(`📤 Position closed (natural): ${symbol}`);
            }
        }
    });

    ws.on("error", (err) => {
        console.error(`⚠️ WebSocket trade error (${symbol}):`, err.message);
    });
}

/* === Close existing trade === */
async function closeTrade(symbol) {
    const pos = openPos[symbol];
    if (!pos) return;

    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

    ws.on("open", () => ws.send(JSON.stringify({ authorize: API_TOKEN })));

    ws.on("message", (raw) => {
        const msg = JSON.parse(raw);
        if (msg.msg_type === "authorize") {
            ws.send(JSON.stringify({ sell: pos.id, price: 0 }));
        }
        if (msg.msg_type === "sell") {
            console.log(`💱 Closed ${symbol} | sold_for=${msg.sell?.sold_for}`);
            delete openPos[symbol];
            ws.close();
        }
    });
}

/* === EMA Crossover Logic === */
async function checkCrossover(symbol) {
    const buf = buffers[symbol];
    if (buf.length < EMA_SLOW + 2) return;

    const prices = buf.map((c) => c.close);
    const fast = EMA.calculate({ period: EMA_FAST, values: prices });
    const slow = EMA.calculate({ period: EMA_SLOW, values: prices });

    const currF = fast.at(-1);
    const currS = slow.at(-1);
    const prevF = fast.at(-2);
    const prevS = slow.at(-2);
    const currEpoch = buf.at(-1).epoch;

    if (currEpoch === lastBarEp[symbol]) return;
    lastBarEp[symbol] = currEpoch;

    if (lastTrend[symbol] === null) {
        lastTrend[symbol] = currF > currS ? "up" : "down";
        console.log(`🚦 [${symbol}] Initial trend: ${lastTrend[symbol]}`);
        saveTrend();
        return;
    }

    if (prevF < prevS && currF > currS && lastTrend[symbol] !== "up") {
        if (openPos[symbol]?.direction === "up") return;
        if (openPos[symbol]) await closeTrade(symbol);
        lastTrend[symbol] = "up";
        saveTrend();
        notify(`📈 Uptrend: ${symbol}`, `EMA-14 crossed ABOVE EMA-50`);
        placeTrade(symbol, "up");
    }

    if (prevF > prevS && currF < currS && lastTrend[symbol] !== "down") {
        if (openPos[symbol]?.direction === "down") return;
        if (openPos[symbol]) await closeTrade(symbol);
        lastTrend[symbol] = "down";
        saveTrend();
        notify(`📉 Downtrend: ${symbol}`, `EMA-14 crossed BELOW EMA-50`);
        placeTrade(symbol, "down");
    }
}

/* === WebSocket Stream === */
function streamSymbol(symbol) {
    const wsURL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
    const sub = {
        ticks_history: symbol,
        style: "candles",
        granularity: TIMEFRAME,
        count: WIN,
        subscribe: 1,
        end: "latest",
    };

    (function connect() {
        try {
            const ws = new WebSocket(wsURL);

            ws.on("open", () => {
                ws.send(JSON.stringify(sub));
                console.log("📱 Subscribed:", symbol);
            });

            ws.on("message", async (raw) => {
                const msg = JSON.parse(raw);
                if (msg.candles) {
                    buffers[symbol] = msg.candles.map(c => ({
                        epoch: c.epoch,
                        open_time: c.epoch - TIMEFRAME,
                        close: +c.close,
                    }));
                    await checkCrossover(symbol);
                }

                if (msg.msg_type === "ohlc" && msg.ohlc) {
                    const { open_time, close, epoch } = msg.ohlc;
                    const buf = buffers[symbol];
                    if (buf.at(-1)?.open_time === open_time) buf.pop();
                    buf.push({ epoch, open_time, close: +close });
                    if (buf.length > WIN) buf.shift();
                    await checkCrossover(symbol);
                }
            });

            ws.on("close", () => {
                console.log(`🔌 Connection closed for ${symbol}, reconnecting...`);
                setTimeout(connect, 3000);
            });

            ws.on("error", (err) => {
                console.error(`⚠️ WebSocket error (${symbol}):`, err.message);
                setTimeout(connect, 5000);
            });
        } catch (err) {
            console.error(`⚠️ Failed to connect for ${symbol}:`, err.message);
            setTimeout(connect, 5000);
        }
    })();
}

/* === Start Bot === */
(async () => {
    await notify("🤖 EMA Bot Online", "Bot is now monitoring EMA-14 vs EMA-50.");
    SYMBOLS.forEach(streamSymbol);
})();
