    import fs from "fs";
    import path from "path";
    import WebSocket from "ws";

    import { EMA } from "technicalindicators";


    /* === EMAIL (Optional, Not used here but kept for fallback) === */
    const EMAIL = process.env.EMAIL;
    const APP_PASSWORD = process.env.APP_PASSWORD;

    /* === TELEGRAM SETTINGS === */
    const BOT_TOKEN = "7550630369:AAHZM-GAPSsppbEawp14-d0KL5MFFShM_pc";
    const CHAT_ID = "887640660";

    if (!BOT_TOKEN || !CHAT_ID) {
        console.error("❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
        process.exit(1);
    }

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

     const newSymbolls =  [
         'WLDAUD','frxAUDCAD','frxAUDCHF','frxAUDJPY','frxAUDNZD','frxAUDUSD','OTC_AS51',
         'cryBTCUSD','RDBEAR','BOOM300N','BOOM500','boom_600_index','boom_900_index','BOOM1000',
         'RDBULL','CRASH300N','CRASH500','CRASH600','crash_900_index','CRASH1000','cryETHUSD',
         'WLDEUR','frxEURAUD','frxEURCAD','frxEURCHF','frxEURGBP','frxEURJPY','frxEURNZD','frxEURUSD',
         'OTC_SX5E','OTC_FCHI','WLDGBP','frxGBPAUD','frxGBPCAD','frxGBPCHF','frxGBPJPY','frxGBPNOK',
         'frxGBPNZD','frxGBPUSD','OTC_GDAXI','WLDXAU','frxXAUUSD','OTC_HSI','OTC_N225','JD10','JD25',
         'JD50','JD75','JD100','frxNZDJPY','frxNZDUSD','OTC_AEX','frxXPDUSD','frxXPTUSD','frxXAGUSD',
         'stpRNG','stpRNG2','stpRNG3','stpRNG4','stpRNG5','OTC_SSMI','OTC_FTSE','OTC_SPC','OTC_NDX',
         'WLDUSD','frxUSDCAD','frxUSDCHF','frxUSDJPY','frxUSDMXN','frxUSDNOK','frxUSDPLN','frxUSDSEK',
         '1HZ10V','R_10','1HZ25V','R_25','1HZ50V','R_50','1HZ75V','R_75','1HZ100V','R_100','OTC_DJI'
     ];

    /* === BOT CONFIG === */
    const SYMBOLS = [

        'RDBEAR','BOOM300N','BOOM500','boom_600_index','boom_900_index','BOOM1000',
        'RDBULL','CRASH300N','CRASH500','CRASH600','crash_900_index','CRASH1000',
         'JD10','JD25',
        'JD50','JD75','JD100',
        'stpRNG','stpRNG2','stpRNG3','stpRNG4','stpRNG5',
        '1HZ10V','R_10','1HZ25V','R_25','1HZ50V','R_50','1HZ75V','R_75','1HZ100V','R_100',
    ];

    const EMA_FAST = 14;
    const EMA_SLOW = 50;
    const TIMEFRAME = 1800; // 30-minute candles
    const LABEL = "30 m";
    const WIN = 100;

    /* === STATE === */
    const STATE = path.resolve("trend_state.json");
    const lastTrend = Object.fromEntries(SYMBOLS.map(s => [s, null]));
    const lastBarEp = Object.fromEntries(SYMBOLS.map(s => [s, null]));

    if (fs.existsSync(STATE)) Object.assign(lastTrend, JSON.parse(fs.readFileSync(STATE)));
    const saveTrend = () => fs.writeFileSync(STATE, JSON.stringify(lastTrend));

    /* === BUFFERS === */
    const buffers = Object.fromEntries(SYMBOLS.map(s => [s, []]));

    /* === CROSSOVER CHECK === */
    function check(symbol) {
        const buf = buffers[symbol];
        if (buf.length < EMA_SLOW + 2) return;

        const closes = buf.map(b => b.close);
        const fast = EMA.calculate({ period: EMA_FAST, values: closes });
        const slow = EMA.calculate({ period: EMA_SLOW, values: closes });

        const currF = fast.at(-1), currS = slow.at(-1);
        const prevF = fast.at(-2), prevS = slow.at(-2);
        const epoch = buf.at(-1).epoch;

        if (epoch === lastBarEp[symbol]) return;
        lastBarEp[symbol] = epoch;

        if (lastTrend[symbol] === null) {
            lastTrend[symbol] = currF > currS ? "up" : "down";
            console.log(`🚦 [${symbol}] initial trend ${lastTrend[symbol]}`);
            saveTrend();
            return;
        }

        if (prevF < prevS && currF > currS && lastTrend[symbol] !== "up") {
            lastTrend[symbol] = "up";
            saveTrend();
            notify(`📈 Uptrend ${symbol}`,
                `EMA-${EMA_FAST} crossed *ABOVE* EMA-${EMA_SLOW} on ${symbol} (${LABEL})`);
        }

        if (prevF > prevS && currF < currS && lastTrend[symbol] !== "down") {
            lastTrend[symbol] = "down";
            saveTrend();
            notify(`📉 Downtrend ${symbol}`,
                `EMA-${EMA_FAST} crossed *BELOW* EMA-${EMA_SLOW} on ${symbol} (${LABEL})`);
        }
    }

    /* === STREAM === */
    function stream(symbol) {
        const url = "wss://ws.derivws.com/websockets/v3?app_id=1089";
        const sub = {
            ticks_history: symbol,
            style: "candles",
            granularity: TIMEFRAME,
            count: WIN,
            subscribe: 1,
            end: "latest",
        };

        (function connect() {
            const ws = new WebSocket(url);

            ws.on("open", () => {
                ws.send(JSON.stringify(sub));
                console.log("📡 subscribed:", symbol);
            });

            ws.on("message", raw => {
                const msg = JSON.parse(raw);

                if (msg.candles) {
                    buffers[symbol] = msg.candles.map(c => ({
                        epoch: c.epoch,
                        open_time: c.epoch - TIMEFRAME,
                        close: +c.close,
                    }));
                    check(symbol);
                }

                if (msg.msg_type === "ohlc" && msg.ohlc) {
                    const { open_time, close, epoch } = msg.ohlc;
                    const buf = buffers[symbol];

                    if (buf.at(-1)?.open_time === open_time) buf.pop();
                    buf.push({ epoch, open_time, close: +close });
                    if (buf.length > WIN) buf.shift();

                    check(symbol);
                }
            });

            ws.on("close", connect);
            ws.on("error", err => {
                console.error(`⚠️  ${symbol}:`, err.message);
                setTimeout(connect, 5000);
            });
        })();
    }

    /* === START === */
    (async () => {
        await notify("🤖 EMA bot online", `Monitoring EMA-${EMA_FAST}/EMA-${EMA_SLOW} on ${LABEL} candles.`);
        SYMBOLS.forEach(stream);
    })();
