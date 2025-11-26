import { db } from "./db";

export type TimeframeSet = {
    high: string;
    mid: string;
    low: string;
    lookback: number;
};

export type RiskGuardrails = {
    maxRiskPerTrade: number; // fraction of equity
    minRiskPerTrade: number; // fraction of equity
    maxDailyDrawdown: number; // fraction
    maxOpenPositions: number;
    maxPairs: number;
    minTradeUsd: number;
    slAtrMultiplier: number;
    tpAtrMultiplier: number;
};

export type IndicatorParams = {
    rsiBuy: number;
    rsiSell: number;
    bbPeriod: number;
    bbStdDev: number;
    stochK: number;
    stochD: number;
    macdFast: number;
    macdSlow: number;
    macdSignal: number;
};

export type StrategyConfig = {
    name: string;
    pairs: string[];
    allocationPerTrade: number; // fraction of available USDT
    minTradeUsd: number;
    timeframe: TimeframeSet;
    risk: RiskGuardrails;
    indicators: IndicatorParams;
    regime: {
        volLow: number;
        volHigh: number;
        trendThresh: number;
        confidenceFloor: number;
    };
};

const DEFAULT_CONFIG: StrategyConfig = {
    name: "DynamicTrend",
    pairs: ["BTC/USDT", "ETH/USDT", "BNB/USDT", "SOL/USDT", "XRP/USDT"],
    allocationPerTrade: 0.1,
    minTradeUsd: 10,
    timeframe: {
        high: "4h",
        mid: "1h",
        low: "15m",
        lookback: 200,
    },
    risk: {
        maxRiskPerTrade: 0.018,
        minRiskPerTrade: 0.0035,
        maxDailyDrawdown: 0.05,
        maxOpenPositions: 6,
        maxPairs: 8,
        minTradeUsd: 12,
        slAtrMultiplier: 1.9,
        tpAtrMultiplier: 2.4,
    },
    indicators: {
        rsiBuy: 35,
        rsiSell: 70,
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
};

function mergeConfig(raw: any): StrategyConfig {
    if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;

    const merged: StrategyConfig = {
        ...DEFAULT_CONFIG,
        ...raw,
        pairs: Array.isArray(raw.pairs) && raw.pairs.length > 0 ? raw.pairs : DEFAULT_CONFIG.pairs,
        timeframe: {
            ...DEFAULT_CONFIG.timeframe,
            ...(raw.timeframe || {}),
        },
        risk: {
            ...DEFAULT_CONFIG.risk,
            ...(raw.risk || {}),
        },
        indicators: {
            ...DEFAULT_CONFIG.indicators,
            ...(raw.indicators || {}),
        },
        regime: {
            ...DEFAULT_CONFIG.regime,
            ...(raw.regime || {}),
        },
    };

    // Clamp numeric fields to avoid unsafe values
    merged.allocationPerTrade = clamp(merged.allocationPerTrade, 0.01, 0.5);
    merged.minTradeUsd = clamp(merged.minTradeUsd, 5, 1000);

    merged.timeframe.lookback = clampInt(merged.timeframe.lookback, 50, 600);

    merged.risk.maxRiskPerTrade = clamp(merged.risk.maxRiskPerTrade, 0.005, 0.02);
    merged.risk.minRiskPerTrade = clamp(merged.risk.minRiskPerTrade, 0.002, merged.risk.maxRiskPerTrade);
    merged.risk.maxDailyDrawdown = clamp(merged.risk.maxDailyDrawdown, 0.02, 0.08);
    merged.risk.maxOpenPositions = clampInt(merged.risk.maxOpenPositions, 1, 15);
    merged.risk.maxPairs = clampInt(merged.risk.maxPairs, 1, 20);
    merged.risk.minTradeUsd = clamp(merged.risk.minTradeUsd, 5, 1000);
    merged.risk.slAtrMultiplier = clamp(merged.risk.slAtrMultiplier, 1.0, 3.0);
    merged.risk.tpAtrMultiplier = clamp(merged.risk.tpAtrMultiplier, 1.5, 4.0);

    merged.indicators.rsiBuy = clamp(merged.indicators.rsiBuy, 5, 60);
    merged.indicators.rsiSell = clamp(merged.indicators.rsiSell, 50, 95);
    merged.indicators.bbPeriod = clampInt(merged.indicators.bbPeriod, 10, 120);
    merged.indicators.bbStdDev = clamp(merged.indicators.bbStdDev, 0.5, 5);
    merged.indicators.stochK = clampInt(merged.indicators.stochK, 5, 50);
    merged.indicators.stochD = clampInt(merged.indicators.stochD, 2, 20);
    merged.indicators.macdFast = clampInt(merged.indicators.macdFast, 5, 20);
    merged.indicators.macdSlow = clampInt(merged.indicators.macdSlow, 15, 40);
    merged.indicators.macdSignal = clampInt(merged.indicators.macdSignal, 5, 15);

    merged.regime.volLow = clamp(merged.regime.volLow, 0.1, 2.0);
    merged.regime.volHigh = clamp(merged.regime.volHigh, merged.regime.volLow, 5.0);
    merged.regime.trendThresh = clamp(merged.regime.trendThresh, 0.2, 1.0);
    merged.regime.confidenceFloor = clamp(merged.regime.confidenceFloor, 0.1, 0.8);

    return merged;
}

function clamp(value: any, min: number, max: number) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(n)) return min;
    return Math.min(Math.max(n, min), max);
}

function clampInt(value: any, min: number, max: number) {
    return Math.round(clamp(value, min, max));
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
