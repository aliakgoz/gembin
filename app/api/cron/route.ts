import { NextResponse } from 'next/server';
import { binance, getBalance, calculateTotalBalanceUsdt } from '@/lib/binance';
import { analyzeMarket } from '@/lib/strategy';
import { db } from '@/lib/db';
import { autoTuneStrategy } from '@/lib/autoTune';
import { getStrategyConfig } from '@/lib/strategyConfig';
import { selectTradablePairs } from '@/lib/pairSelection';

export const dynamic = 'force-dynamic'; // static by default, unless reading the request

export async function GET(request: Request) {
    // Verify Cron Secret (optional but recommended)
    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 1. Check if Bot is Enabled
        const settingsRes = await db.query("SELECT value FROM settings WHERE key = 'bot_enabled'");
        const isEnabled = settingsRes.rows[0]?.value === 'true';

        if (!isEnabled) {
            console.log('Bot is disabled');
            return NextResponse.json({ message: 'Bot is disabled' });
        }

        // 2. Load strategy config (pairs, risk, thresholds)
        const config = await getStrategyConfig();
        const pairs = await selectTradablePairs(config);

        const results = [];
        // Single balance snapshot to reduce API calls
        const balance = await getBalance();
        const usdtBalance = Number((balance as any)?.total?.USDT ?? (balance as any)?.free?.USDT ?? 0);

        // Daily drawdown guardrail
        const ddLimit = config.risk.maxDailyDrawdown;
        const dd = await computeDailyDrawdown();
        if (dd !== null && dd <= -ddLimit) {
            await db.query("INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)", ['warn', 'Daily drawdown limit hit, skipping trades', JSON.stringify({ dd, limit: ddLimit })]);
            return NextResponse.json({ message: 'Daily drawdown limit hit, trades paused', dd, limit: ddLimit }, { status: 200 });
        }

        // 3. Analyze & Execute
        for (const symbol of pairs) {
            try {
                const analysis = await analyzeMarket(symbol, config);

                if (analysis.confidence < config.regime.confidenceFloor) {
                    results.push({ symbol, action: 'SKIP', reason: 'Low confidence', confidence: analysis.confidence });
                    continue;
                }

                if (analysis.action === 'BUY') {
                    // Risk Management from config
                    const riskPct = clamp(config.allocationPerTrade, config.risk.minRiskPerTrade, config.risk.maxRiskPerTrade);
                    const tradeAmountUSDT = usdtBalance * riskPct;

                    if (tradeAmountUSDT > config.minTradeUsd) { // Min trade size guard
                        const amount = tradeAmountUSDT / analysis.price;
                        // Execute Market Buy
                        // const order = await binance.createMarketBuyOrder(symbol, amount);
                        // For safety, we'll just log it as a "Paper Trade" for now until verified
                        const order = { id: 'paper_' + Date.now(), symbol, side: 'buy', amount, price: analysis.price, cost: tradeAmountUSDT, status: 'closed' };

                        await db.query(
                            "INSERT INTO trades (symbol, side, amount, price, cost, strategy, status, order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                            [symbol, 'buy', amount, analysis.price, tradeAmountUSDT, 'DynamicTrend', 'closed', order.id]
                        );
                        results.push({ symbol, action: 'BUY', order, analysis });
                    } else {
                        results.push({ symbol, action: 'SKIP', reason: 'Insufficient funds', analysis });
                    }

                } else if (analysis.action === 'SELL') {
                    // Check Asset Balance
                    const baseAsset = symbol.split('/')[0];
                    const balance = await getBalance();
                    const assetBalance = Number((balance as any)?.total?.[baseAsset] ?? (balance as any)?.free?.[baseAsset] ?? 0);

                    if (assetBalance * analysis.price > config.minTradeUsd) {
                        // Execute Market Sell (Sell all)
                        // const order = await binance.createMarketSellOrder(symbol, assetBalance);
                        const order = { id: 'paper_' + Date.now(), symbol, side: 'sell', amount: assetBalance, price: analysis.price, cost: assetBalance * analysis.price, status: 'closed' };

                        await db.query(
                            "INSERT INTO trades (symbol, side, amount, price, cost, strategy, status, order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                            [symbol, 'sell', assetBalance, analysis.price, assetBalance * analysis.price, 'DynamicTrend', 'closed', order.id]
                        );
                        results.push({ symbol, action: 'SELL', order, analysis });
                    }
                } else {
                    results.push({ symbol, action: 'HOLD', analysis });
                }

            } catch (e: any) {
                console.error(`Error processing ${symbol}:`, e);
                await db.query("INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)", ['error', `Error processing ${symbol}`, JSON.stringify({ error: e.message })]);
            }
        }

        // 4. Take Snapshot
        const totalBalance = await getBalance();
        const { totalUsdt, assets } = await calculateTotalBalanceUsdt(totalBalance);

        await db.query("INSERT INTO portfolio_snapshots (total_balance_usdt, positions) VALUES ($1, $2)", [totalUsdt, JSON.stringify(assets)]);

        // 5. Auto-tune via ChatGPT using latest metrics (AM/PM windows)
        const advisoryWindow = await pickAdvisoryWindow();
        const tuneResult = await autoTuneStrategy(advisoryWindow);

        return NextResponse.json({ success: true, results, tuneResult });

    } catch (error: any) {
        console.error('Cron failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

async function computeDailyDrawdown(): Promise<number | null> {
    const res = await db.query("SELECT total_balance_usdt, timestamp FROM portfolio_snapshots WHERE timestamp::date = CURRENT_DATE ORDER BY timestamp ASC");
    if (!res.rows.length) return null;
    const balances = res.rows.map((r: any) => Number(r.total_balance_usdt));
    const start = balances[0];
    let peak = start;
    let maxDD = 0;
    for (const b of balances) {
        if (b > peak) peak = b;
        const dd = peak ? (b - peak) / peak : 0;
        if (dd < maxDD) maxDD = dd;
    }
    return maxDD; // negative drawdown fraction
}

async function pickAdvisoryWindow(): Promise<"AM" | "PM" | "ADHOC"> {
    const now = new Date();
    const utc3Hour = (now.getUTCHours() + 3) % 24;
    const windowNow = utc3Hour >= 9 && utc3Hour <= 12 ? "AM" : utc3Hour >= 17 && utc3Hour <= 20 ? "PM" : null;

    const res = await db.query("SELECT key, value FROM settings WHERE key IN ('last_gpt_consult_am', 'last_gpt_consult_pm')");
    const lastAm = res.rows.find((r: any) => r.key === 'last_gpt_consult_am')?.value;
    const lastPm = res.rows.find((r: any) => r.key === 'last_gpt_consult_pm')?.value;
    const amDone = isSameDay(lastAm);
    const pmDone = isSameDay(lastPm);

    if (windowNow === "AM" && !amDone) return "AM";
    if (windowNow === "PM" && !pmDone) return "PM";
    if (!amDone) return "AM";
    if (!pmDone) return "PM";
    return "ADHOC";
}

function isSameDay(dateStr?: string) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getUTCFullYear() === now.getUTCFullYear() &&
        d.getUTCMonth() === now.getUTCMonth() &&
        d.getUTCDate() === now.getUTCDate();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}
