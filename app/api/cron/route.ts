import { NextResponse } from 'next/server';
import { binance, getBalance, calculateTotalBalanceUsdt, getTicker } from '@/lib/binance';
import { analyzeMarket, StrategyResult } from '@/lib/strategy';
import { storage } from '@/lib/storage';
import { autoTuneStrategy } from '@/lib/autoTune';
import { getStrategyConfig, StrategyConfig } from '@/lib/strategyConfig';
import { selectTradablePairs } from '@/lib/pairSelection';

export const dynamic = 'force-dynamic'; // static by default, unless reading the request

export async function GET(request: Request) {
    // Verify Cron Secret
    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 1. Check if Bot is Enabled
        const isEnabled = (await storage.getSettings('bot_enabled')) === 'true';
        if (!isEnabled) return NextResponse.json({ message: 'Bot is disabled' });

        // 2. Load Config & State
        const config = await getStrategyConfig();
        const pairs = await selectTradablePairs(config);

        // 3. Get Portfolio State
        const balance = await getBalance();
        const { totalUsdt, assets } = await calculateTotalBalanceUsdt(balance);
        let currentUsdt = Number((balance as any)?.total?.USDT ?? (balance as any)?.free?.USDT ?? 0);

        // Daily Drawdown Check
        const ddLimit = config.risk.maxDailyDrawdown;
        const dd = await computeDailyDrawdown();
        if (dd !== null && dd <= -ddLimit) {
            await storage.addLog('warn', 'Daily drawdown limit hit', JSON.stringify({ dd, limit: ddLimit }));
            return NextResponse.json({ message: 'Daily drawdown limit hit', dd });
        }

        // 4. Safety Check: Manage Open Positions (SL/TP)
        // This runs first to protect capital
        await checkOpenPositions(config);

        // 5. Pass 1: Analyze All Pairs
        const analysisMap = new Map<string, StrategyResult>();
        const buySignals: StrategyResult[] = [];
        const sellSignals: StrategyResult[] = [];

        for (const symbol of pairs) {
            try {
                const analysis = await analyzeMarket(symbol, config);
                analysisMap.set(symbol, analysis);

                if (analysis.action === 'BUY') {
                    buySignals.push(analysis);
                } else if (analysis.action === 'SELL') {
                    sellSignals.push(analysis);
                }
            } catch (e: any) {
                console.error(`Error analyzing ${symbol}:`, e);
            }
        }

        const results = [];

        // 6. Pass 2: Execution

        // Step A: Execute SELL signals first to free up capital
        for (const analysis of sellSignals) {
            const baseAsset = analysis.symbol.split('/')[0];
            const assetData = assets.find(a => a.asset === baseAsset);

            if (assetData && assetData.usdtValue > config.minTradeUsd) {
                try {
                    const order = await executeSell(analysis.symbol, assetData.amount, analysis.price, 'DynamicTrend');
                    currentUsdt += order.cost; // Update available USDT
                    results.push({ symbol: analysis.symbol, action: 'SELL', order });
                } catch (e: any) {
                    results.push({ symbol: analysis.symbol, action: 'FAIL_SELL', error: e.message });
                }
            }
        }

        // Step B: Execute BUY signals with Rebalancing
        // Sort buys by confidence (highest first)
        buySignals.sort((a, b) => b.confidence - a.confidence);

        for (const analysis of buySignals) {
            // Calculate target position size based on TOTAL Portfolio Value (not just free USDT)
            const targetSize = totalUsdt * config.allocationPerTrade;

            // Check if we already hold this asset
            const baseAsset = analysis.symbol.split('/')[0];
            const currentPosition = assets.find(a => a.asset === baseAsset);
            const currentVal = currentPosition ? currentPosition.usdtValue : 0;

            // If we already have enough, skip
            if (currentVal >= targetSize * 0.9) {
                results.push({ symbol: analysis.symbol, action: 'HOLD', reason: 'Already at target allocation' });
                continue;
            }

            let neededUsdt = targetSize - currentVal;
            // Clamp to max risk per trade if needed, though allocationPerTrade usually handles this

            if (neededUsdt < config.minTradeUsd) continue;

            // If we don't have enough USDT, try to liquidate weak positions
            if (currentUsdt < neededUsdt) {
                // Find funding candidates: Assets we hold that are NOT in buySignals
                // and have low confidence or HOLD signal
                const candidates = assets.filter(a => {
                    if (a.asset === 'USDT') return false;
                    const sym = `${a.asset}/USDT`;
                    // Don't sell what we are trying to buy
                    if (sym === analysis.symbol) return false;
                    // Don't sell other strong buys
                    if (buySignals.find(b => b.symbol === sym)) return false;
                    return true;
                });

                // Sort candidates by confidence (lowest first) to sell junk first
                // We need analysis for these assets. If not in 'pairs', we might not have analysis.
                // For now, assume we only trade pairs in our list.
                const scoredCandidates = candidates.map(c => {
                    const sym = `${c.asset}/USDT`;
                    const anal = analysisMap.get(sym);
                    return {
                        asset: c,
                        confidence: anal ? anal.confidence : 0,
                        symbol: sym
                    };
                }).sort((a, b) => a.confidence - b.confidence);

                for (const cand of scoredCandidates) {
                    if (currentUsdt >= neededUsdt) break; // We have enough now

                    if (cand.asset.usdtValue > config.minTradeUsd) {
                        try {
                            // Sell this asset to fund the buy
                            const order = await executeSell(cand.symbol, cand.asset.amount, 0, 'Rebalance'); // 0 price = market
                            currentUsdt += order.cost;
                            results.push({ symbol: cand.symbol, action: 'LIQUIDATE', target: analysis.symbol, order });
                        } catch (e) {
                            console.error(`Failed to liquidate ${cand.symbol}`, e);
                        }
                    }
                }
            }

            // Now check if we can buy
            // Use available USDT, capped by needed amount
            const amountToInvest = Math.min(currentUsdt, neededUsdt);

            if (amountToInvest > config.minTradeUsd) {
                try {
                    const amount = amountToInvest / analysis.price;
                    const order = await executeBuy(analysis.symbol, amount, analysis.price, analysis.sl, analysis.tp, 'DynamicTrend');
                    currentUsdt -= order.cost;
                    results.push({ symbol: analysis.symbol, action: 'BUY', order });
                } catch (e: any) {
                    results.push({ symbol: analysis.symbol, action: 'FAIL_BUY', error: e.message });
                }
            } else {
                results.push({ symbol: analysis.symbol, action: 'SKIP', reason: 'Insufficient funds after rebalance' });
            }
        }

        // 7. Snapshot & Auto-Tune
        await storage.addSnapshot({
            total_balance_usdt: totalUsdt,
            positions: JSON.stringify(assets)
        });

        const advisoryWindow = await pickAdvisoryWindow();
        const tuneResult = await autoTuneStrategy(advisoryWindow);

        return NextResponse.json({ success: true, results, tuneResult });

    } catch (error: any) {
        console.error('Cron failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// Helper functions for execution to keep main logic clean
async function executeBuy(symbol: string, amount: number, price: number, sl: number | undefined, tp: number | undefined, strategy: string) {
    const binanceOrder = await binance.createMarketBuyOrder(symbol, amount);
    const order = {
        id: binanceOrder.id,
        symbol,
        side: 'buy' as const,
        amount: binanceOrder.amount,
        price: binanceOrder.price || price,
        cost: binanceOrder.cost,
        status: 'open' as const
    };

    await storage.addTrade({
        symbol,
        side: 'buy',
        amount: order.amount,
        price: order.price,
        cost: order.cost,
        sl_price: sl,
        tp_price: tp,
        strategy,
        status: 'open',
        order_id: order.id
    });
    return order;
}

async function executeSell(symbol: string, amount: number, price: number, strategy: string) {
    const binanceOrder = await binance.createMarketSellOrder(symbol, amount);
    const order = {
        id: binanceOrder.id,
        symbol,
        side: 'sell' as const,
        amount: binanceOrder.amount,
        price: binanceOrder.price || price,
        cost: binanceOrder.cost,
        status: 'closed' as const
    };

    await storage.addTrade({
        symbol,
        side: 'sell',
        amount: order.amount,
        price: order.price,
        cost: order.cost,
        strategy,
        status: 'closed',
        order_id: order.id
    });

    await storage.updateTradeStatus(symbol, 'closed');
    return order;
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
                const binanceOrder = await binance.createMarketSellOrder(trade.symbol, amount);

                const order = {
                    id: binanceOrder.id,
                    symbol: trade.symbol,
                    side: 'sell' as const,
                    amount: binanceOrder.amount,
                    price: binanceOrder.price || currentPrice,
                    cost: binanceOrder.cost,
                    status: 'closed' as const
                };

                await storage.addTrade({
                    symbol: trade.symbol,
                    side: 'sell',
                    amount: order.amount,
                    price: order.price,
                    cost: order.cost,
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
