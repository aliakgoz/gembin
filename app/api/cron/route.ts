import { NextResponse } from 'next/server';
import { binance, getBalance, calculateTotalBalanceUsdt, getTicker } from '@/lib/binance';
import { analyzeMarket } from '@/lib/strategy';
import { storage } from '@/lib/storage';
import { autoTuneStrategy } from '@/lib/autoTune';
import { getStrategyConfig, StrategyConfig } from '@/lib/strategyConfig';
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
        const isEnabled = (await storage.getSettings('bot_enabled')) === 'true';

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
            await storage.addLog('warn', 'Daily drawdown limit hit, skipping trades', JSON.stringify({ dd, limit: ddLimit }));
            return NextResponse.json({ message: 'Daily drawdown limit hit, trades paused', dd, limit: ddLimit }, { status: 200 });
        }

        // 3. Manage Open Positions (SL/TP)
        await checkOpenPositions(config);

        // 4. Analyze & Execute New Trades
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
                        const order = { id: 'paper_' + Date.now(), symbol, side: 'buy', amount, price: analysis.price, cost: tradeAmountUSDT, status: 'open' };

                        await storage.addTrade({
                            symbol,
                            side: 'buy',
                            amount,
                            price: analysis.price,
                            cost: tradeAmountUSDT,
                            sl_price: analysis.sl,
                            tp_price: analysis.tp,
                            strategy: 'DynamicTrend',
                            status: 'open',
                            order_id: order.id
                        });
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

                        await storage.addTrade({
                            symbol,
                            side: 'sell',
                            amount: assetBalance,
                            price: analysis.price,
                            cost: assetBalance * analysis.price,
                            strategy: 'DynamicTrend',
                            status: 'closed',
                            order_id: order.id
                        });
                        // Close any open buy trades for this symbol
                        await storage.updateTradeStatus(symbol, 'closed');

                        results.push({ symbol, action: 'SELL', order, analysis });
                    }
                } else {
                    results.push({ symbol, action: 'HOLD', analysis });
                }

            } catch (e: any) {
                console.error(`Error processing ${symbol}:`, e);
                await storage.addLog('error', `Error processing ${symbol}`, JSON.stringify({ error: e.message }));
            }
        }

        // 5. Take Snapshot
        const totalBalance = await getBalance();
        const { totalUsdt, assets } = await calculateTotalBalanceUsdt(totalBalance);

        await storage.addSnapshot({
            total_balance_usdt: totalUsdt,
            positions: JSON.stringify(assets)
        });

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
    const snapshots = await storage.getSnapshotsSince(new Date(new Date().setHours(0, 0, 0, 0)));
    if (!snapshots.length) return null;
    const balances = snapshots.map((r: any) => Number(r.total_balance_usdt));
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

    const lastAm = await storage.getSettings('last_gpt_consult_am');
    const lastPm = await storage.getSettings('last_gpt_consult_pm');
    const amDone = isSameDay(lastAm);
    const pmDone = isSameDay(lastPm);

    if (windowNow === "AM" && !amDone) return "AM";
    if (windowNow === "PM" && !pmDone) return "PM";
    if (!amDone) return "AM";
    if (!pmDone) return "PM";
    return "ADHOC";
}

function isSameDay(dateStr?: string | null) {
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

async function checkOpenPositions(config: StrategyConfig) {
    const openTrades = await storage.getOpenTrades();

    for (const trade of openTrades) {
        try {
            const ticker = await getTicker(trade.symbol);
            const currentPrice = ticker.last;
            if (!currentPrice) continue;

            let action = null;
            let reason = '';

            // Check SL
            if (trade.sl_price && currentPrice <= Number(trade.sl_price)) {
                action = 'sell';
                reason = 'Stop Loss Hit';
            }
            // Check TP
            else if (trade.tp_price && currentPrice >= Number(trade.tp_price)) {
                action = 'sell';
                reason = 'Take Profit Hit';
            }

            if (action === 'sell') {
                const amount = Number(trade.amount);
                // Execute Sell
                // await binance.createMarketSellOrder(trade.symbol, amount);
                const order = { id: 'paper_sl_tp_' + Date.now(), symbol: trade.symbol, side: 'sell', amount, price: currentPrice, cost: amount * currentPrice, status: 'closed' };

                await storage.addTrade({
                    symbol: trade.symbol,
                    side: 'sell',
                    amount,
                    price: currentPrice,
                    cost: amount * currentPrice,
                    strategy: 'RiskManager',
                    status: 'closed',
                    order_id: order.id
                });

                // Close the original trade
                await storage.closeTradeById(trade.id);

                await storage.addLog('info', `Risk Manager: ${reason} for ${trade.symbol}`, JSON.stringify({ trade, currentPrice, reason }));
            }
        } catch (error: any) {
            console.error(`Error checking position for ${trade.symbol}`, error);
        }
    }
}
