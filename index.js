process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import fs from "fs";
import path from "path";
import WebSocket from "ws";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { EMA } from "technicalindicators";

dotenv.config();

// === Configuration ===
const BOT_TOKEN = "7550630369:AAHZM-GAPSsppbEawp14-d0KL5MFFShM_pc";
const CHAT_ID = "887640660";
const EMAIL = "thinking1242@gmail.com";
const APP_PASSWORD = "iqmpamea jici ncxb";
const API_TOKEN = "WX4non5pFnA9Dmg";
const APP_ID = "1089";
const SYMBOLS = ['BOOM500','BOOM1000','BOOM600','BOOM900','CRASH500','CRASH600','CRASH900','CRASH1000'];
const EMA_FAST = 14;
const EMA_SLOW = 21;
const TIMEFRAME = 1800;
const WIN = 100;
const TRADE_AMOUNT = 1;

const STATE = path.resolve("trend_state.json");
const POS_FILE = path.resolve("open_positions.json");

// === Telegram Notification ===
const sendTelegram = async (text) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.description);
        console.log("📨 Telegram sent:", text);
    } catch (err) {
        console.error("❌ Telegram error:", err.message);
    }
};

const notify = async (subject, body) => {
    await sendTelegram(`*${subject}*\n${body}`);
};

// === Email Notification ===
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: EMAIL, pass: APP_PASSWORD },
});

const sendMail = async (subject, body) => {
    try {
        console.log("📤 Sending mail:", subject);
        await transporter.sendMail({
            from: `"EMA Bot" <${EMAIL}>`,
            to: EMAIL,
            subject,
            text: body,
        });
        console.log("📧 Mail sent successfully");
    } catch (err) {
        console.error("❌ Email send error:", err.response || err.message);
    }
};

// === Trend & Position State Handling ===
const lastTrend = Object.fromEntries(SYMBOLS.map((s) => [s, null]));
const lastBarEp = Object.fromEntries(SYMBOLS.map((s) => [s, null]));
if (fs.existsSync(STATE)) Object.assign(lastTrend, JSON.parse(fs.readFileSync(STATE)));
const saveTrend = () => fs.writeFileSync(STATE, JSON.stringify(lastTrend, null, 2));

const buffers = Object.fromEntries(SYMBOLS.map((s) => [s, []]));

let openPos = {};
if (fs.existsSync(POS_FILE)) {
    try {
        openPos = JSON.parse(fs.readFileSync(POS_FILE, "utf8"));
        console.log("💾 Restored open positions:", openPos);
    } catch (e) {
        console.warn("⚠️ Could not parse open_positions.json – starting fresh.");
    }
}
if (!fs.existsSync(POS_FILE)) {
       fs.writeFileSync(POS_FILE, "{}");   // create an empty JSON object
       console.log("📁 open_positions.json created (empty).");
    }

const saveOpenPos = () => fs.writeFileSync(POS_FILE, JSON.stringify(openPos, null, 2));

// ✅ Update a symbol's open position
function updateOpenPosition(symbol, contractId, direction) {
    openPos[symbol] = { id: contractId, direction };
    saveOpenPos();
    console.log(`✅ Position updated: ${symbol}`, openPos[symbol]);
}

// ✅ Remove a symbol's open position
function removeOpenPosition(symbol) {
    if (openPos[symbol]) {
        delete openPos[symbol];
        saveOpenPos();
        console.log(`🗑️ Position removed: ${symbol}`);
    }
}

// === Trade Execution ===
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
                },
            };
            ws.send(JSON.stringify(contract));
        }

        if (msg.msg_type === "buy" && msg.buy?.contract_id) {
            const contractId = msg.buy.contract_id;
            updateOpenPosition(symbol, contractId, direction);
            ws.send(JSON.stringify({
                proposal_open_contract: 1,
                contract_id: contractId,
                subscribe: 1
            }));

            console.log(`✅ Trade placed: ${symbol} [${direction}] | ID: ${contractId}`);
            notify(`📅 Trade Executed: ${symbol}`, `Direction: ${direction}\nContract ID: ${contractId}`);
        }

        if (msg.msg_type === "proposal_open_contract" && msg.proposal_open_contract.is_sold) {
            removeOpenPosition(symbol);
            console.log(`📤 Position closed (natural): ${symbol}`);
        }
    });

    ws.on("error", (err) => {
        console.error(`⚠️ WebSocket trade error (${symbol}):`, err.message);
    });
}

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
            notify("❌ Trade Closed", `💰 Closed ${symbol} | sold_for=${msg.sell?.sold_for}`);
            console.log(`💰 Closed ${symbol} | sold_for=${msg.sell?.sold_for}`);
            removeOpenPosition(symbol);
            ws.close();
        }
    });
}

// === EMA Crossover Logic ===
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
        notify(`📈 Uptrend: ${symbol}`, `EMA-14 crossed ABOVE EMA-21`);
        placeTrade(symbol, "up");
    }

    if (prevF > prevS && currF < currS && lastTrend[symbol] !== "down") {
        if (openPos[symbol]?.direction === "down") return;
        if (openPos[symbol]) await closeTrade(symbol);
        lastTrend[symbol] = "down";
        saveTrend();
        notify(`📉 Downtrend: ${symbol}`, `EMA-14 crossed BELOW EMA-21`);
        placeTrade(symbol, "down");
    }
}

// === Stream Candle Data ===
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
            ws.on("open", () => ws.send(JSON.stringify(sub)));
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

            ws.on("close", () => setTimeout(connect, 3000));
            ws.on("error", () => setTimeout(connect, 5000));
        } catch (err) {
            setTimeout(connect, 5000);
        }
    })();
}

// === Detect Manual Closures ===
function verifyOpenContracts() {
    for (const [symbol, pos] of Object.entries(openPos)) {
        const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`);

        ws.on("open", () => ws.send(JSON.stringify({ authorize: API_TOKEN })));

        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.msg_type === "authorize") {
                ws.send(JSON.stringify({
                    proposal_open_contract: 1,
                    contract_id: pos.id,
                    subscribe: 1
                }));
            }

            if (msg.msg_type === "proposal_open_contract" && msg.proposal_open_contract.is_sold) {
                const profit = msg.proposal_open_contract.profit ?? 0;
                console.log(`🧾 Detected MANUAL close: ${symbol} ID=${pos.id} Profit=$${profit}`);
                notify("❌ Trade Manually Closed", `${symbol}\nProfit: $${profit.toFixed(2)}\nContract ID: \`${pos.id}\``);
                removeOpenPosition(symbol);
                ws.close();
            }
        });

        ws.on("error", () => ws.close());
    }
}

// === Start Monitoring ===
setInterval(verifyOpenContracts, 60000);

(async () => {
    await notify("🤖 EMA Bot Online", "Bot is now monitoring EMA-14 vs EMA-21.");
    SYMBOLS.forEach(streamSymbol);
})();
