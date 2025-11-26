import { db } from "./db";

export type StrategyConfig = {
    name: string;
    pairs: string[];
    allocationPerTrade: number; // fraction of available USDT
    minTradeUsd: number;
    lookback: number;
    rsiBuy: number;
    rsiSell: number;
    bbPeriod: number;
    bbStdDev: number;
};

const DEFAULT_CONFIG: StrategyConfig = {
    name: "DynamicTrend",
    pairs: ["BTC/USDT", "ETH/USDT", "BNB/USDT", "SOL/USDT", "XRP/USDT"],
    allocationPerTrade: 0.1,
    minTradeUsd: 10,
    lookback: 100,
    rsiBuy: 35,
    rsiSell: 70,
    bbPeriod: 20,
    bbStdDev: 2,
};

function mergeConfig(raw: any): StrategyConfig {
    if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;

    const merged: StrategyConfig = {
        ...DEFAULT_CONFIG,
        ...raw,
        pairs: Array.isArray(raw.pairs) && raw.pairs.length > 0 ? raw.pairs : DEFAULT_CONFIG.pairs,
    };

    // Clamp numeric fields to avoid unsafe values
    merged.allocationPerTrade = clamp(merged.allocationPerTrade, 0.01, 0.5);
    merged.minTradeUsd = clamp(merged.minTradeUsd, 5, 1000);
    merged.lookback = Math.max(50, Math.min(merged.lookback || DEFAULT_CONFIG.lookback, 500));
    merged.rsiBuy = clamp(merged.rsiBuy, 5, 60);
    merged.rsiSell = clamp(merged.rsiSell, 50, 95);
    merged.bbPeriod = Math.max(10, Math.min(merged.bbPeriod || DEFAULT_CONFIG.bbPeriod, 100));
    merged.bbStdDev = clamp(merged.bbStdDev, 0.5, 5);

    return merged;
}

function clamp(value: any, min: number, max: number) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(n)) return min;
    return Math.min(Math.max(n, min), max);
}

export async function getStrategyConfig(): Promise<StrategyConfig> {
    const res = await db.query("SELECT value FROM settings WHERE key = 'strategy_config'");
    const raw = res.rows[0]?.value ? safeParse(res.rows[0].value) : null;
    return mergeConfig(raw);
}

export async function saveStrategyConfig(config: StrategyConfig) {
    const merged = mergeConfig(config);
    await db.query(
        "INSERT INTO settings (key, value) VALUES ('strategy_config', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP",
        [JSON.stringify(merged)]
    );
    return merged;
}

function safeParse(value: string) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export { DEFAULT_CONFIG };
