import { NextResponse } from 'next/server';
import { binance, getBalance, calculateTotalBalanceUsdt } from '@/lib/binance';
import { analyzeMarket } from '@/lib/strategy';
import { db } from '@/lib/db';
import { autoTuneStrategy } from '@/lib/autoTune';
import { getStrategyConfig } from '@/lib/strategyConfig';

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
        const pairs = config.pairs;

        const results = [];

        // 3. Analyze & Execute
        for (const symbol of pairs) {
            try {
                const analysis = await analyzeMarket(symbol, config);

                if (analysis.action === 'BUY') {
                    // Check Balance
                    const balance = await getBalance();
                    const usdtBalance = Number((balance as any)?.total?.USDT ?? (balance as any)?.free?.USDT ?? 0);

                    // Risk Management from config
                    const tradeAmountUSDT = usdtBalance * config.allocationPerTrade;

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
                        results.push({ symbol, action: 'BUY', order });
                    } else {
                        results.push({ symbol, action: 'SKIP', reason: 'Insufficient funds' });
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
                        results.push({ symbol, action: 'SELL', order });
                    }
                } else {
                    results.push({ symbol, action: 'HOLD' });
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

        // 5. Auto-tune via ChatGPT using latest metrics
        const tuneResult = await autoTuneStrategy();

        return NextResponse.json({ success: true, results, tuneResult });

    } catch (error: any) {
        console.error('Cron failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
