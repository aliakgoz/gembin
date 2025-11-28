import { storage } from "./storage";

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
    trailingSlMultiplier?: number;
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
    allocationPerTrade: 0.5,
    minTradeUsd: 10,
    timeframe: {
        high: "4h",
        mid: "1h",
        low: "15m",
        lookback: 200,
    },
    risk: {
        maxRiskPerTrade: 0.5,
        minRiskPerTrade: 0.05,
        maxDailyDrawdown: 0.15,
        maxOpenPositions: 3,
        maxPairs: 10,
        minTradeUsd: 12,
        slAtrMultiplier: 2.0, // Increased from 1.5 for breathing room
        tpAtrMultiplier: 4.0, // Increased from 3.0 to target larger moves
        trailingSlMultiplier: 2.0,
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
        volLow: 0.01,
        volHigh: 0.05,
        trendThresh: 0.3,
        confidenceFloor: 0.4, // Increased from 0.2 to reduce noise
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
    merged.allocationPerTrade = clamp(merged.allocationPerTrade, 0.01, 1.0);
    merged.minTradeUsd = clamp(merged.minTradeUsd, 5, 1000);

    merged.timeframe.lookback = clampInt(merged.timeframe.lookback, 50, 600);

    merged.risk.maxRiskPerTrade = clamp(merged.risk.maxRiskPerTrade, 0.01, 1.0);
    merged.risk.minRiskPerTrade = clamp(merged.risk.minRiskPerTrade, 0.002, merged.risk.maxRiskPerTrade);
    merged.risk.maxDailyDrawdown = clamp(merged.risk.maxDailyDrawdown, 0.05, 0.50);
    merged.risk.maxOpenPositions = clampInt(merged.risk.maxOpenPositions, 1, 20);
    merged.risk.maxPairs = clampInt(merged.risk.maxPairs, 1, 50);
    merged.risk.minTradeUsd = clamp(merged.risk.minTradeUsd, 5, 1000);
    merged.risk.slAtrMultiplier = clamp(merged.risk.slAtrMultiplier, 0.5, 5.0);
    merged.risk.tpAtrMultiplier = clamp(merged.risk.tpAtrMultiplier, 1.0, 10.0);

    merged.indicators.rsiBuy = clamp(merged.indicators.rsiBuy, 5, 80);
    merged.indicators.rsiSell = clamp(merged.indicators.rsiSell, 20, 95);
    merged.indicators.bbPeriod = clampInt(merged.indicators.bbPeriod, 5, 120);
    merged.indicators.bbStdDev = clamp(merged.indicators.bbStdDev, 0.5, 5);
    merged.indicators.stochK = clampInt(merged.indicators.stochK, 2, 50);
    merged.indicators.stochD = clampInt(merged.indicators.stochD, 2, 20);
    merged.indicators.macdFast = clampInt(merged.indicators.macdFast, 2, 50);
    merged.indicators.macdSlow = clampInt(merged.indicators.macdSlow, 10, 100);
    merged.indicators.macdSignal = clampInt(merged.indicators.macdSignal, 2, 30);

    merged.regime.volLow = clamp(merged.regime.volLow, 0.001, 5.0);
    merged.regime.volHigh = clamp(merged.regime.volHigh, merged.regime.volLow, 10.0);
    merged.regime.trendThresh = clamp(merged.regime.trendThresh, 0.1, 1.0);
    merged.regime.confidenceFloor = clamp(merged.regime.confidenceFloor, 0.1, 0.9);

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
    const value = await storage.getSettings('strategy_config');
    const raw = value ? safeParse(value) : null;
    return mergeConfig(raw);
}

export async function saveStrategyConfig(config: StrategyConfig) {
    const merged = mergeConfig(config);
    await storage.setSettings('strategy_config', JSON.stringify(merged));
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
