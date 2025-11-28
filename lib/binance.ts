import ccxt from 'ccxt';

const binanceClient = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET_KEY,
    enableRateLimit: true,
    options: {
        defaultType: 'spot',
    },
});

// Set to Testnet if configured
if (process.env.BINANCE_USE_TESTNET === '1') {
    binanceClient.setSandboxMode(true);
}

export const binance = binanceClient;

export type Balance = {
    free: { [key: string]: string };
    locked: { [key: string]: string };
    total: { [key: string]: string };
};

export async function getBalance() {
    const balance = await binance.fetchBalance();
    return balance;
}

export async function getTicker(symbol: string) {
    return await binance.fetchTicker(symbol);
}

export async function calculateTotalBalanceUsdt(balance: any) {
    let totalUsdt = 0;
    const assets = [];

    // 1. Get all non-zero balances
    const nonZeroBalances: { asset: string; amount: number }[] = [];
    if (balance.total) {
        for (const [asset, amount] of Object.entries(balance.total)) {
            if (typeof amount === 'number' && amount > 0) {
                nonZeroBalances.push({ asset, amount });
            }
        }
    }

    // 2. Fetch all tickers to get current prices
    let tickers: any = {};
    try {
        tickers = await binance.fetchTickers();
    } catch (error) {
        console.error("Failed to fetch tickers, falling back to individual fetches", error);
    }

    // 3. Calculate value for each asset
    for (const { asset, amount } of nonZeroBalances) {
        let usdtValue = 0;
        let price = 0;

        if (asset === 'USDT') {
            usdtValue = amount;
            price = 1;
        } else {
            const symbol = `${asset}/USDT`;
            // Try to find the ticker
            const ticker = tickers[symbol];
            if (ticker) {
                price = ticker.last || 0;
                usdtValue = amount * price;
            } else {
                // Fallback: try to fetch individual ticker if not found in bulk
                try {
                    const t = await binance.fetchTicker(symbol);
                    price = t.last || 0;
                    usdtValue = amount * price;
                } catch (e) {
                    console.warn(`Could not find price for ${asset}`);
                }
            }
        }

        if (usdtValue > 0) {
            totalUsdt += usdtValue;
            assets.push({
                asset,
                amount,
                price,
                usdtValue
            });
        }
    }

    return {
        totalUsdt,
        assets
    };
}
