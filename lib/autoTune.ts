import { storage } from "./storage";
import { getStrategyConfig, saveStrategyConfig, StrategyConfig, DEFAULT_CONFIG } from "./strategyConfig";
import { selectTradablePairs } from "./pairSelection";
import { calculateTotalBalanceUsdt, getBalance } from "./binance";

type AutoTuneResult = {
    updated: boolean;
    message: string;
    config: StrategyConfig;
    aiSuggestion?: any;
    window?: "AM" | "PM" | "ADHOC";
    consulted?: boolean;
    calendarUpdated?: boolean;
};

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function autoTuneStrategy(window: "AM" | "PM" | "ADHOC" = "ADHOC"): Promise<AutoTuneResult> {
    const currentConfig = await getStrategyConfig();

    if (!process.env.OPENAI_API_KEY) {
        return {
            updated: false,
            consulted: false,
            window,
            message: "OPENAI_API_KEY not set; skipping auto-tune",
            config: currentConfig,
        };
    }

    // Gather performance data
    const [snapshots, trades] = await Promise.all([
        storage.getSnapshotsSince(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        storage.getTrades(200),
    ]);

    // const snapshots = snapshotRes.rows;
    // const trades = tradesRes.rows;

    const balanceStats = computeBalanceStats(snapshots);
    const tradeStats = computeTradeStats(trades);
    const { totalUsdt } = await calculateTotalBalanceUsdt(await getBalance());

    // Dynamic pair universe
    const allowedPairs = await selectTradablePairs(currentConfig);

    // Optional external news fetch (best-effort)
    const news = await fetchNewsDigest();

    // Macro Awareness: Check if we need to update Economic Calendar
    let calendarUpdated = false;
    const lastCalendarUpdate = await storage.getSettings('last_calendar_update');
    const shouldUpdateCalendar = !lastCalendarUpdate || (Date.now() - new Date(lastCalendarUpdate).getTime() > 24 * 60 * 60 * 1000);

    if (shouldUpdateCalendar) {
        try {
            await fetchEconomicCalendar();
            calendarUpdated = true;
        } catch (e) {
            console.error("Failed to update economic calendar", e);
        }
    }

    const payload = {
        config: currentConfig,
        performance: {
            totalUsdt,
            snapshots: snapshots.map((s: any) => ({
                total_balance_usdt: Number(s.total_balance_usdt),
                timestamp: s.timestamp,
            })),
            ...balanceStats,
            ...tradeStats,
        },
        trades,
        allowedPairs,
        news,
        guardrails: {
            allocationBounds: [0.01, 0.5],
            riskPerTrade: [currentConfig.risk.minRiskPerTrade, currentConfig.risk.maxRiskPerTrade],
            maxDailyDrawdown: currentConfig.risk.maxDailyDrawdown,
        },
    };

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                temperature: 0.2,
                response_format: { type: "json_object" },
                messages: [
                    {
                        role: "system",
                        content: [
                            "You are a high-performance algorithmic trading strategist.",
                            "Objective: Maximize capital growth with AGGRESSIVE strategies.",
                            "Target Frequency: At least 1 trade per hour.",
                            "Risk Profile: Aggressive. Use up to 25% allocation per trade.",
                            "Use only the provided allowedPairs list for symbols.",
                            "Stay within guardrails; never exceed risk bounds.",
                            "Respond ONLY with JSON in this shape:",
                            JSON.stringify({
                                strategyName: "DynamicTrend_Aggressive",
                                params: {
                                    pairs: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
                                    allocationPerTrade: 0.25,
                                    minTradeUsd: 12,
                                    timeframe: { high: "4h", mid: "1h", low: "15m", lookback: 200 },
                                    risk: {
                                        maxRiskPerTrade: 0.25,
                                        minRiskPerTrade: 0.05,
                                        maxDailyDrawdown: 0.15,
                                        maxOpenPositions: 4,
                                        maxPairs: 10,
                                        minTradeUsd: 12,
                                        slAtrMultiplier: 1.5,
                                        tpAtrMultiplier: 3.0,
                                    },
                                    indicators: {
                                        rsiBuy: 45,
                                        rsiSell: 55,
                                        bbPeriod: 20,
                                        bbStdDev: 2,
                                        stochK: 14,
                                        stochD: 3,
                                        macdFast: 12,
                                        macdSlow: 26,
                                        macdSignal: 9,
                                    },
                                    regime: {
                                        volLow: 0.5,
                                        volHigh: 2.5,
                                        trendThresh: 0.3,
                                        confidenceFloor: 0.2,
                                    },
                                },
                                notes: "Rationale for aggressive settings",
                                confidence: 0.9,
                            }),
                            "Do not include any non-JSON text.",
                        ].join(" "),
                    },
                    {
                        role: "user",
                        content: JSON.stringify(payload),
                    },
                ],
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`OpenAI API failed: ${response.status} ${text}`);
        }

        const completion = await response.json();
        const content = completion.choices?.[0]?.message?.content;
        const parsed = content ? safeParse(content) : null;

        if (!parsed || !parsed.params) {
            throw new Error("OpenAI response missing params");
        }

        const updatedConfig = normalizeConfigFromAI(currentConfig, parsed);
        const saved = await saveStrategyConfig(updatedConfig);

        await markConsult(window);

        await storage.addLog("info", "Strategy auto-tuned", JSON.stringify({ suggestion: parsed, saved, window }));

        return {
            updated: true,
            consulted: true,
            window,
            message: "Strategy parameters updated from AI suggestion",
            config: saved,
            aiSuggestion: parsed,
            calendarUpdated,
        };
    } catch (error: any) {
        await storage.addLog("error", "Auto-tune failed", JSON.stringify({ error: error.message, window }));
        return {
            updated: false,
            consulted: false,
            window,
            message: error.message || "Auto-tune failed",
            config: currentConfig,
        };
    }
}


function computeBalanceStats(rows: any[]) {
    if (!rows.length) return { balanceChangePct: null, maxDrawdown: null, sharpeLike: null };
    const balances = rows.map((r: any) => Number(r.total_balance_usdt));
    const start = balances[0];
    const end = balances[balances.length - 1];
    const balanceChangePct = start ? ((end - start) / start) * 100 : null;

    let peak = balances[0];
    let maxDD = 0;
    for (const v of balances) {
        if (v > peak) peak = v;
        const dd = peak ? (v - peak) / peak : 0;
        maxDD = Math.min(maxDD, dd);
    }

    const returns: number[] = [];
    for (let i = 1; i < balances.length; i++) {
        const prev = balances[i - 1];
        const curr = balances[i];
        if (prev > 0) returns.push((curr - prev) / prev);
    }
    const avg = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const std = returns.length
        ? Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / returns.length)
        : 0;
    const sharpeLike = std > 0 ? avg / std : null;

    return { balanceChangePct, maxDrawdown: maxDD, sharpeLike };
}

function computeTradeStats(trades: any[]) {
    const closed = trades.filter(t => t.status === "closed");
    const wins = closed.filter((t: any) => Number(t.price) * Number(t.amount) > Number(t.cost)).length;
    const winRate = closed.length > 0 ? wins / closed.length : 0;

    let grossWin = 0;
    let grossLoss = 0;
    for (const t of closed) {
        const pnl = Number(t.price) * Number(t.amount) - Number(t.cost);
        if (pnl >= 0) grossWin += pnl; else grossLoss += Math.abs(pnl);
    }
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;

    return {
        winRate,
        profitFactor,
        tradeCount: trades.length,
    };
}

function normalizeConfigFromAI(current: StrategyConfig, ai: any): StrategyConfig {
    const params = ai.params || {};
    const next: StrategyConfig = {
        ...current,
        name: ai.strategyName || current.name || DEFAULT_CONFIG.name,
        pairs: Array.isArray(params.pairs) && params.pairs.length > 0 ? params.pairs : current.pairs,
        allocationPerTrade: Number(params.allocationPerTrade ?? current.allocationPerTrade),
        minTradeUsd: Number(params.minTradeUsd ?? current.minTradeUsd),
        timeframe: {
            ...current.timeframe,
            ...(params.timeframe || {}),
        },
        risk: {
            ...current.risk,
            ...(params.risk || {}),
        },
        indicators: {
            ...current.indicators,
            ...(params.indicators || {}),
        },
        regime: {
            ...current.regime,
            ...(params.regime || {}),
        },
    };
    return next;
}

async function markConsult(window: "AM" | "PM" | "ADHOC") {
    if (window === "ADHOC") return;
    storage.setSettings(`last_gpt_consult_${window.toLowerCase()}`, new Date().toISOString());
}

async function fetchNewsDigest() {
    const url = process.env.NEWS_FEED_URL;
    if (!url) return [];

    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`news fetch failed ${res.status}`);
            const data = await res.json();
            return Array.isArray(data) ? data.slice(0, 10) : data.articles?.slice(0, 10) || [];
        } catch (error) {
            console.error(`News fetch attempt ${i + 1} failed`, error);
            if (i === 2) return [];
            await new Promise(r => setTimeout(r, 1000)); // wait 1s
        }
    }
    return [];
}

async function fetchEconomicCalendar() {
    if (!process.env.OPENAI_API_KEY) return;

    const today = new Date().toISOString().split('T')[0];
    const prompt = `
    You are a financial analyst.
    Identify CRITICAL high-impact economic events for the next 7 days starting from ${today}.
    Focus on: FOMC Meetings, CPI Releases, NFP (Non-Farm Payrolls), Fed Chair Speeches.
    Ignore minor events.
    
    Respond ONLY with a JSON array of objects:
    [
        { "date": "YYYY-MM-DD HH:MM", "event": "Event Name", "impact": "HIGH" }
    ]
    Times should be in UTC.
    `;

    for (let i = 0; i < 3; i++) {
        try {
            const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                    model: "gpt-4o",
                    temperature: 0.1,
                    response_format: { type: "json_object" },
                    messages: [{ role: "user", content: prompt }],
                }),
            });

            if (!response.ok) throw new Error("Calendar fetch failed");

            const completion = await response.json();
            const content = completion.choices?.[0]?.message?.content;
            const parsed = content ? JSON.parse(content) : null;

            if (parsed && Array.isArray(parsed.events || parsed)) {
                const events = Array.isArray(parsed.events) ? parsed.events : parsed;
                await storage.setSettings('economic_calendar', JSON.stringify(events));
                await storage.setSettings('last_calendar_update', new Date().toISOString());
                await storage.addLog('info', 'Economic Calendar Updated', JSON.stringify(events));
                return; // Success
            }
        } catch (e) {
            console.error(`Calendar fetch attempt ${i + 1} failed`, e);
            if (i === 2) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

function safeParse(value: string) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
