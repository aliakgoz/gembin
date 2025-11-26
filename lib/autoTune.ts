import { db } from "./db";
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
    const [snapshotRes, tradesRes] = await Promise.all([
        db.query("SELECT * FROM portfolio_snapshots WHERE timestamp > NOW() - INTERVAL '30 days' ORDER BY timestamp ASC"),
        db.query("SELECT * FROM trades ORDER BY timestamp DESC LIMIT 200"),
    ]);

    const snapshots = snapshotRes.rows;
    const trades = tradesRes.rows;

    const balanceStats = computeBalanceStats(snapshots);
    const tradeStats = computeTradeStats(trades);
    const { totalUsdt } = await calculateTotalBalanceUsdt(await getBalance());

    // Dynamic pair universe
    const allowedPairs = await selectTradablePairs(currentConfig);

    // Optional external news fetch (best-effort)
    const news = await fetchNewsDigest();

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
                            "You are a hedge-fund grade strategy tuner.",
                            "Use only the provided allowedPairs list for symbols.",
                            "Stay within guardrails; never exceed risk bounds.",
                            "Respond ONLY with JSON in this shape:",
                            JSON.stringify({
                                strategyName: "DynamicTrend",
                                params: {
                                    pairs: ["BTC/USDT", "ETH/USDT"],
                                    allocationPerTrade: 0.1,
                                    minTradeUsd: 12,
                                    timeframe: { high: "4h", mid: "1h", low: "15m", lookback: 200 },
                                    risk: {
                                        maxRiskPerTrade: 0.015,
                                        minRiskPerTrade: 0.004,
                                        maxDailyDrawdown: 0.05,
                                        maxOpenPositions: 5,
                                        maxPairs: 8,
                                        minTradeUsd: 12,
                                        slAtrMultiplier: 1.8,
                                        tpAtrMultiplier: 2.5,
                                    },
                                    indicators: {
                                        rsiBuy: 32,
                                        rsiSell: 72,
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
                                        trendThresh: 0.6,
                                        confidenceFloor: 0.35,
                                    },
                                },
                                notes: "Short rationale",
                                confidence: 0.8,
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

        await db.query(
            "INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)",
            ["info", "Strategy auto-tuned", JSON.stringify({ suggestion: parsed, saved, window })]
        );

        return {
            updated: true,
            consulted: true,
            window,
            message: "Strategy parameters updated from AI suggestion",
            config: saved,
            aiSuggestion: parsed,
        };
    } catch (error: any) {
        await db.query(
            "INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)",
            ["error", "Auto-tune failed", JSON.stringify({ error: error.message, window })]
        );
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
    await db.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP",
        [`last_gpt_consult_${window.toLowerCase()}`, new Date().toISOString()]
    );
}

async function fetchNewsDigest() {
    const url = process.env.NEWS_FEED_URL;
    if (!url) return [];
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`news fetch failed ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data.slice(0, 10) : data.articles?.slice(0, 10) || [];
    } catch (error) {
        console.error("News fetch failed", error);
        return [];
    }
}

function safeParse(value: string) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
