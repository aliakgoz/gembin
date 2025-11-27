import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');

export type Trade = {
    id: string;
    symbol: string;
    side: 'buy' | 'sell';
    amount: number;
    price: number;
    cost: number;
    strategy: string;
    status: 'open' | 'closed';
    order_id?: string;
    sl_price?: number;
    tp_price?: number;
    timestamp: string;
};

export type Settings = {
    [key: string]: string; // value is stored as string
};

export type Snapshot = {
    total_balance_usdt: number;
    positions: string; // JSON string
    timestamp: string;
};

export type Log = {
    level: string;
    message: string;
    meta?: string;
    timestamp: string;
};

type StorageData = {
    trades: Trade[];
    settings: Settings;
    portfolio_snapshots: Snapshot[];
    logs: Log[];
};

function readData(): StorageData {
    if (!fs.existsSync(DATA_FILE)) {
        return { trades: [], settings: {}, portfolio_snapshots: [], logs: [] };
    }
    try {
        const content = fs.readFileSync(DATA_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.error("Failed to read storage file:", error);
        return { trades: [], settings: {}, portfolio_snapshots: [], logs: [] };
    }
}

function writeData(data: StorageData) {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error("Failed to write storage file:", error);
    }
}

export const storage = {
    getTrades: (limit?: number) => {
        const data = readData();
        let trades = data.trades.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        if (limit) trades = trades.slice(0, limit);
        return trades;
    },

    getOpenTrades: () => {
        const data = readData();
        return data.trades.filter(t => t.status === 'open');
    },

    addTrade: (trade: Omit<Trade, 'id' | 'timestamp'>) => {
        const data = readData();
        const newTrade: Trade = {
            ...trade,
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date().toISOString()
        };
        data.trades.push(newTrade);
        writeData(data);
        return newTrade;
    },

    updateTradeStatus: (symbol: string, status: 'open' | 'closed') => {
        const data = readData();
        let updated = false;
        data.trades.forEach(t => {
            if (t.symbol === symbol && t.status === 'open') {
                t.status = status;
                updated = true;
            }
        });
        if (updated) writeData(data);
    },

    closeTradeById: (id: string) => {
        const data = readData();
        const trade = data.trades.find(t => t.id === id);
        if (trade) {
            trade.status = 'closed';
            writeData(data);
        }
    },

    getSettings: (key: string): string | null => {
        const data = readData();
        return data.settings[key] || null;
    },

    setSettings: (key: string, value: string) => {
        const data = readData();
        data.settings[key] = value;
        writeData(data);
    },

    getLatestSnapshot: () => {
        const data = readData();
        if (data.portfolio_snapshots.length === 0) return null;
        return data.portfolio_snapshots.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
    },

    getSnapshots: (limit?: number) => {
        const data = readData();
        let snapshots = data.portfolio_snapshots.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        if (limit) snapshots = snapshots.slice(0, limit);
        return snapshots;
    },

    getSnapshotsSince: (since: Date) => {
        const data = readData();
        return data.portfolio_snapshots.filter(s => new Date(s.timestamp) > since).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    },

    addSnapshot: (snapshot: Omit<Snapshot, 'timestamp'>) => {
        const data = readData();
        const newSnapshot = { ...snapshot, timestamp: new Date().toISOString() };
        data.portfolio_snapshots.push(newSnapshot);
        writeData(data);
    },

    addLog: (level: string, message: string, meta?: string) => {
        const data = readData();
        const newLog = { level, message, meta, timestamp: new Date().toISOString() };
        data.logs.push(newLog);
        // Keep logs size manageable
        if (data.logs.length > 1000) {
            data.logs = data.logs.slice(-1000);
        }
        writeData(data);
    },

    getTradesSince: (since: Date) => {
        const data = readData();
        return data.trades.filter(t => new Date(t.timestamp) > since);
    },

    getWinRateStats: () => {
        const data = readData();
        const closedTrades = data.trades.filter(t => t.status === 'closed');
        const wins = closedTrades.filter(t => (t.price * t.amount) > t.cost).length;
        return { wins, total: closedTrades.length };
    },

    getUniqueTradedPairsCount: (since: Date) => {
        const data = readData();
        const trades = data.trades.filter(t => new Date(t.timestamp) > since);
        const unique = new Set(trades.map(t => t.symbol));
        return unique.size;
    }
};
