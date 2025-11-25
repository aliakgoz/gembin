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

export async function getBalance() {
    const balance = await binance.fetchBalance();
    return balance;
}

export async function getTicker(symbol: string) {
    return await binance.fetchTicker(symbol);
}
