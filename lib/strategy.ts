import { binance } from './binance';
import { RSI, MACD, BollingerBands, Stochastic, ATR } from 'technicalindicators';
import { getStrategyConfig, StrategyConfig } from './strategyConfig';

type TimeframeData = {
    rsi: number;
    macdHist: number;
    stochK: number;
    stochD: number;
    bb: { upper: number; lower: number; middle: number };
    atrPct: number;
    last: number;
};

export interface StrategyResult {
    action: 'BUY' | 'SELL' | 'HOLD';
    symbol: string;
    reason: string;
    price: number;
    confidence: number;
    regime: string;
    signals: {
        trendScore: number;
        momentumScore: number;
        volatilityScore: number;
    };
    sl?: number;
    tp?: number;
}

export async function analyzeMarket(symbol: string, config?: StrategyConfig): Promise<StrategyResult> {
    const cfg = config || await getStrategyConfig();

    const [highTf, midTf, lowTf] = await Promise.all([
        fetchTf(symbol, cfg.timeframe.high, cfg.timeframe.lookback, cfg),
        fetchTf(symbol, cfg.timeframe.mid, cfg.timeframe.lookback, cfg),
        fetchTf(symbol, cfg.timeframe.low, cfg.timeframe.lookback, cfg),
    ]);

    if (!highTf || !midTf || !lowTf) {
        return {
            action: 'HOLD',
            symbol,
            reason: 'Insufficient data',
            price: 0,
            confidence: 0,
            regime: 'unknown',
            signals: { trendScore: 0, momentumScore: 0, volatilityScore: 0 },
        };
    }

    const price = lowTf.last;

    const trendScore = average([
        scoreTrend(highTf.macdHist),
        scoreTrend(midTf.macdHist),
        scoreTrend(lowTf.macdHist),
        price > lowTf.bb.middle ? 0.15 : -0.15,
    ]);

    const momentumScore = average([
        normalizeRSI(lowTf.rsi),
        normalizeRSI(midTf.rsi) * 0.8,
        normalizeStoch(lowTf.stochK, lowTf.stochD),
    ]);

    const volatilityScore = scoreVolatility(lowTf.atrPct, cfg);

    const confidence = clamp01(
        (trendScore * 0.4) +
        (momentumScore * 0.4) +
        (Math.max(0, 1 - Math.abs(volatilityScore)) * 0.2)
    );

    const regime = classifyRegime(lowTf.atrPct, trendScore, cfg);

    const buySignal =
        lowTf.rsi < cfg.indicators.rsiBuy &&
        lowTf.stochK < 45 && // Relaxed from 25
        // lowTf.macdHist > 0 && // Removed strict MACD check, rely on trendScore
        trendScore > cfg.regime.trendThresh &&
        confidence > cfg.regime.confidenceFloor;

    const sellSignal =
        lowTf.rsi > cfg.indicators.rsiSell &&
        // lowTf.macdHist < 0 && // Removed strict MACD check
        lowTf.stochK > 55 && // Relaxed from 75
        trendScore < -cfg.regime.trendThresh &&
        confidence > cfg.regime.confidenceFloor;

    if (buySignal) {
        const atr = lowTf.last * lowTf.atrPct;
        const sl = price - (atr * cfg.risk.slAtrMultiplier);
        const tp = price + (atr * cfg.risk.tpAtrMultiplier);

        return {
            action: 'BUY',
            symbol,
            reason: `MTF Bullish | RSI ${lowTf.rsi.toFixed(1)} Stoch ${lowTf.stochK.toFixed(1)} MACD ${lowTf.macdHist.toFixed(4)}`,
            price,
            confidence,
            regime,
            signals: { trendScore, momentumScore, volatilityScore },
            sl,
            tp
        };
    }

    if (sellSignal) {
        return {
            action: 'SELL',
            symbol,
            reason: `MTF Bearish | RSI ${lowTf.rsi.toFixed(1)} Stoch ${lowTf.stochK.toFixed(1)} MACD ${lowTf.macdHist.toFixed(4)}`,
            price,
            confidence,
            regime,
            signals: { trendScore, momentumScore, volatilityScore },
        };
    }

    return {
        action: 'HOLD',
        symbol,
        reason: 'No high-confidence signal',
        price,
        confidence,
        regime,
        signals: { trendScore, momentumScore, volatilityScore },
    };
}

async function fetchTf(symbol: string, timeframe: string, lookback: number, cfg: StrategyConfig): Promise<TimeframeData | null> {
    const candles = await binance.fetchOHLCV(symbol, timeframe, undefined, lookback);
    if (!candles || candles.length < 50) return null;

    const highs = candles.map(c => c[2]).filter(isNumber);
    const lows = candles.map(c => c[3]).filter(isNumber);
    const closes = candles.map(c => c[4]).filter(isNumber);
    const last = closes[closes.length - 1];

    const rsiArr = RSI.calculate({ values: closes, period: 14 });
    const rsi = lastValue(rsiArr) ?? 50;

    const macdArr = MACD.calculate({
        values: closes,
        fastPeriod: cfg.indicators.macdFast,
        slowPeriod: cfg.indicators.macdSlow,
        signalPeriod: cfg.indicators.macdSignal,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });
    const macd = macdArr[macdArr.length - 1];
    const macdHist = macd?.histogram ?? 0;

    const stochArr = Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: cfg.indicators.stochK,
        signalPeriod: cfg.indicators.stochD,
    });
    const stoch = stochArr[stochArr.length - 1];
    const stochK = stoch?.k ?? 50;
    const stochD = stoch?.d ?? 50;

    const bbArr = BollingerBands.calculate({
        values: closes,
        period: cfg.indicators.bbPeriod,
        stdDev: cfg.indicators.bbStdDev,
    });
    const bb = bbArr[bbArr.length - 1] ?? { upper: last, lower: last, middle: last };

    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr = lastValue(atrArr) ?? 0;
    const atrPct = last > 0 ? atr / last : 0;

    return { rsi, macdHist, stochK, stochD, bb, atrPct, last };
}

function normalizeRSI(value: number) {
    return clamp(-1, 1, (value - 50) / 50);
}

function normalizeStoch(k: number, d: number) {
    const avg = (k + d) / 2;
    return clamp(-1, 1, (avg - 50) / 50);
}

function scoreTrend(macdHist: number) {
    const cap = clamp(-1, 1, macdHist * 5); // amplify histogram modestly
    return cap;
}

function scoreVolatility(atrPct: number, cfg: StrategyConfig) {
    if (atrPct < cfg.regime.volLow) return (atrPct - cfg.regime.volLow) / cfg.regime.volLow; // negative small
    if (atrPct > cfg.regime.volHigh) return (atrPct - cfg.regime.volHigh) / cfg.regime.volHigh; // positive high means too volatile
    return 0;
}

function classifyRegime(atrPct: number, trendScore: number, cfg: StrategyConfig) {
    if (atrPct >= cfg.regime.volHigh) return "high-vol";
    if (atrPct <= cfg.regime.volLow * 0.8) return "low-vol";
    if (trendScore >= cfg.regime.trendThresh) return "trend-up";
    if (trendScore <= -cfg.regime.trendThresh) return "trend-down";
    return "range";
}

function average(nums: number[]) {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function isNumber(n: any): n is number {
    return typeof n === 'number' && Number.isFinite(n);
}

function lastValue<T>(arr: T[]): T | undefined {
    return arr[arr.length - 1];
}

function clamp(min: number, max: number, value: number) {
    return Math.min(Math.max(value, min), max);
}

function clamp01(value: number) {
    return clamp(0, 1, value);
}
