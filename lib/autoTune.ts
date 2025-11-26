import { db } from "./db";
import { getStrategyConfig, saveStrategyConfig, StrategyConfig, DEFAULT_CONFIG } from "./strategyConfig";

type AutoTuneResult = {
    updated: boolean;
    message: string;
    config: StrategyConfig;
    aiSuggestion?: any;
};

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export async function autoTuneStrategy(): Promise<AutoTuneResult> {
    const currentConfig = await getStrategyConfig();

    if (!process.env.OPENAI_API_KEY) {
        return {
            updated: false,
            message: "OPENAI_API_KEY not set; skipping auto-tune",
            config: currentConfig,
        };
    }

    // Gather performance data
    const [snapshotRes, tradesRes] = await Promise.all([
        db.query("SELECT * FROM portfolio_snapshots WHERE timestamp > NOW() - INTERVAL '7 days' ORDER BY timestamp ASC"),
        db.query("SELECT * FROM trades ORDER BY timestamp DESC LIMIT 50"),
    ]);

    const snapshots = snapshotRes.rows;
    const trades = tradesRes.rows;

    const startBalance = snapshots[0]?.total_balance_usdt ? Number(snapshots[0].total_balance_usdt) : null;
    const endBalance = snapshots[snapshots.length - 1]?.total_balance_usdt ? Number(snapshots[snapshots.length - 1].total_balance_usdt) : startBalance;
    const balanceChangePct = startBalance && endBalance ? ((endBalance - startBalance) / startBalance) * 100 : null;

    const wins = trades.filter((t: any) => t.status === "closed" && Number(t.price) * Number(t.amount) > Number(t.cost)).length;
    const closed = trades.filter((t: any) => t.status === "closed").length;
    const winRate = closed > 0 ? Math.round((wins / closed) * 100) : 0;

    const grossBuys = trades.filter((t: any) => t.side === "buy").reduce((acc: number, t: any) => acc + Number(t.cost), 0);
    const grossSells = trades.filter((t: any) => t.side === "sell").reduce((acc: number, t: any) => acc + Number(t.cost), 0);
    const approxPnl = grossSells - grossBuys;

    const payload = {
        config: currentConfig,
        performance: {
            snapshots: snapshots.map((s: any) => ({
                total_balance_usdt: Number(s.total_balance_usdt),
                timestamp: s.timestamp,
            })),
            balanceChangePct,
            winRate,
            approxPnl,
            tradeCount: trades.length,
        },
        trades,
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
                            "You are an automated trading strategy tuner.",
                            "Given performance stats, propose updated parameters.",
                            "Respond ONLY with a JSON object matching this shape:",
                            JSON.stringify({
                                strategyName: "DynamicTrend",
                                params: {
                                    pairs: ["BTC/USDT", "ETH/USDT"],
                                    allocationPerTrade: 0.1,
                                    minTradeUsd: 10,
                                    lookback: 100,
                                    rsiBuy: 35,
                                    rsiSell: 70,
                                    bbPeriod: 20,
                                    bbStdDev: 2,
                                },
                                notes: "Short rationale",
                            }),
                            "Use conservative risk settings (allocationPerTrade max 0.5, minTradeUsd between 5-1000).",
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

        await db.query(
            "INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)",
            ["info", "Strategy auto-tuned", JSON.stringify({ suggestion: parsed, saved })]
        );

        return {
            updated: true,
            message: "Strategy parameters updated from AI suggestion",
            config: saved,
            aiSuggestion: parsed,
        };
    } catch (error: any) {
        await db.query(
            "INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)",
            ["error", "Auto-tune failed", JSON.stringify({ error: error.message })]
        );
        return {
            updated: false,
            message: error.message || "Auto-tune failed",
            config: currentConfig,
        };
    }
}

function normalizeConfigFromAI(current: StrategyConfig, ai: any): StrategyConfig {
    const params = ai.params || {};
    const next: StrategyConfig = {
        name: ai.strategyName || current.name || DEFAULT_CONFIG.name,
        pairs: Array.isArray(params.pairs) && params.pairs.length > 0 ? params.pairs : current.pairs,
        allocationPerTrade: Number(params.allocationPerTrade ?? current.allocationPerTrade),
        minTradeUsd: Number(params.minTradeUsd ?? current.minTradeUsd),
        lookback: Number(params.lookback ?? current.lookback),
        rsiBuy: Number(params.rsiBuy ?? current.rsiBuy),
        rsiSell: Number(params.rsiSell ?? current.rsiSell),
        bbPeriod: Number(params.bbPeriod ?? current.bbPeriod),
        bbStdDev: Number(params.bbStdDev ?? current.bbStdDev),
    };
    return next;
}

function safeParse(value: string) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
