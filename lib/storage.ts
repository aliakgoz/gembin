import fs from 'fs';
import path from 'path';
import { kv } from '@vercel/kv';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');

// Check if we are in an environment with Vercel KV configured
const USE_KV = !!process.env.KV_REST_API_URL;

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
    [key: string]: string;
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

// --- Local FS Helper Functions ---

function readDataLocal(): StorageData {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return { trades: [], settings: {}, portfolio_snapshots: [], logs: [] };
        }
        const content = fs.readFileSync(DATA_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.warn("Failed to read local storage (expected on Vercel if KV not set up):", error);
        return { trades: [], settings: {}, portfolio_snapshots: [], logs: [] };
    }
}

function writeDataLocal(data: StorageData) {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        // On Vercel, writing to filesystem will fail. We catch this to prevent app crash.
        // The user should set up Vercel KV to fix persistence.
        console.warn("Failed to write to local storage (expected on Vercel if KV not set up):", error);
    }
}

// --- KV Helper Functions ---

async function getKVData(): Promise<StorageData> {
    try {
        const [trades, settings, snapshots, logs] = await Promise.all([
            kv.get<Trade[]>('trades'),
            kv.get<Settings>('settings'),
            kv.get<Snapshot[]>('portfolio_snapshots'),
            kv.get<Log[]>('logs')
        ]);
        return {
            trades: trades || [],
            settings: settings || {},
            portfolio_snapshots: snapshots || [],
            logs: logs || []
        };
    } catch (error) {
        console.error("Failed to read from KV:", error);
        return { trades: [], settings: {}, portfolio_snapshots: [], logs: [] };
    }
}

// --- Unified Storage Interface ---

export const storage = {
    // --- Trades ---
    getTrades: async (limit?: number): Promise<Trade[]> => {
        let trades: Trade[] = [];
        if (USE_KV) {
            trades = (await kv.get<Trade[]>('trades')) || [];
        } else {
            trades = readDataLocal().trades;
        }
        trades.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        if (limit) trades = trades.slice(0, limit);
        return trades;
    },

    getOpenTrades: async (): Promise<Trade[]> => {
        let trades: Trade[] = [];
        if (USE_KV) {
            trades = (await kv.get<Trade[]>('trades')) || [];
        } else {
            trades = readDataLocal().trades;
        }
        return trades.filter(t => t.status === 'open');
    },

    addTrade: async (trade: Omit<Trade, 'id' | 'timestamp'>) => {
        const newTrade: Trade = {
            ...trade,
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date().toISOString()
        };

        if (USE_KV) {
            const trades = (await kv.get<Trade[]>('trades')) || [];
            trades.push(newTrade);
            await kv.set('trades', trades);
        } else {
            const data = readDataLocal();
            data.trades.push(newTrade);
            writeDataLocal(data);
        }
        return newTrade;
    },

    updateTradeStatus: async (symbol: string, status: 'open' | 'closed') => {
        if (USE_KV) {
            const trades = (await kv.get<Trade[]>('trades')) || [];
            let updated = false;
            trades.forEach(t => {
                if (t.symbol === symbol && t.status === 'open') {
                    t.status = status;
                    updated = true;
                }
            });
            if (updated) await kv.set('trades', trades);
        } else {
            const data = readDataLocal();
            let updated = false;
            data.trades.forEach(t => {
                if (t.symbol === symbol && t.status === 'open') {
                    t.status = status;
                    updated = true;
                }
            });
            if (updated) writeDataLocal(data);
        }
    },

    closeTradeById: async (id: string) => {
        if (USE_KV) {
            const trades = (await kv.get<Trade[]>('trades')) || [];
            const trade = trades.find(t => t.id === id);
            if (trade) {
                trade.status = 'closed';
                await kv.set('trades', trades);
            }
        } else {
            const data = readDataLocal();
            const trade = data.trades.find(t => t.id === id);
            if (trade) {
                trade.status = 'closed';
                writeDataLocal(data);
            }
        }
    },

    // --- Settings ---
    getSettings: async (key: string): Promise<string | null> => {
        if (USE_KV) {
            const settings = (await kv.get<Settings>('settings')) || {};
            return settings[key] || null;
        } else {
            return readDataLocal().settings[key] || null;
        }
    },

    setSettings: async (key: string, value: string) => {
        if (USE_KV) {
            const settings = (await kv.get<Settings>('settings')) || {};
            settings[key] = value;
            await kv.set('settings', settings);
        } else {
            const data = readDataLocal();
            data.settings[key] = value;
            writeDataLocal(data);
        }
    },

    // --- Snapshots ---
    getLatestSnapshot: async (): Promise<Snapshot | null> => {
        let snapshots: Snapshot[] = [];
        if (USE_KV) {
            snapshots = (await kv.get<Snapshot[]>('portfolio_snapshots')) || [];
        } else {
            snapshots = readDataLocal().portfolio_snapshots;
        }
        if (snapshots.length === 0) return null;
        return snapshots.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
    },

    getSnapshots: async (limit?: number) => {
        let snapshots: Snapshot[] = [];
        if (USE_KV) {
            snapshots = (await kv.get<Snapshot[]>('portfolio_snapshots')) || [];
        } else {
            snapshots = readDataLocal().portfolio_snapshots;
        }
        snapshots.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        if (limit) snapshots = snapshots.slice(0, limit);
        return snapshots;
    },

    getSnapshotsSince: async (since: Date) => {
        let snapshots: Snapshot[] = [];
        if (USE_KV) {
            snapshots = (await kv.get<Snapshot[]>('portfolio_snapshots')) || [];
        } else {
            snapshots = readDataLocal().portfolio_snapshots;
        }
        return snapshots.filter(s => new Date(s.timestamp) > since).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    },

    addSnapshot: async (snapshot: Omit<Snapshot, 'timestamp'>) => {
        const newSnapshot = { ...snapshot, timestamp: new Date().toISOString() };
        if (USE_KV) {
            const snapshots = (await kv.get<Snapshot[]>('portfolio_snapshots')) || [];
            snapshots.push(newSnapshot);
            // Optional: Limit size in KV to prevent infinite growth
            if (snapshots.length > 1000) snapshots.shift();
            await kv.set('portfolio_snapshots', snapshots);
        } else {
            const data = readDataLocal();
            data.portfolio_snapshots.push(newSnapshot);
            writeDataLocal(data);
        }
    },

    // --- Logs ---
    addLog: async (level: string, message: string, meta?: string) => {
        const newLog = { level, message, meta, timestamp: new Date().toISOString() };
        if (USE_KV) {
            const logs = (await kv.get<Log[]>('logs')) || [];
            logs.push(newLog);
            if (logs.length > 1000) logs.splice(0, logs.length - 1000);
            await kv.set('logs', logs);
        } else {
            const data = readDataLocal();
            data.logs.push(newLog);
            if (data.logs.length > 1000) {
                data.logs = data.logs.slice(-1000);
            }
            writeDataLocal(data);
        }
    },

    // --- Helpers ---
    getTradesSince: async (since: Date) => {
        let trades: Trade[] = [];
        if (USE_KV) {
            trades = (await kv.get<Trade[]>('trades')) || [];
        } else {
            trades = readDataLocal().trades;
        }
        return trades.filter(t => new Date(t.timestamp) > since);
    },

    getWinRateStats: async () => {
        let trades: Trade[] = [];
        if (USE_KV) {
            trades = (await kv.get<Trade[]>('trades')) || [];
        } else {
            trades = readDataLocal().trades;
        }
        const closedTrades = trades.filter(t => t.status === 'closed');
        const wins = closedTrades.filter(t => (t.price * t.amount) > t.cost).length;
        return { wins, total: closedTrades.length };
    },

    getUniqueTradedPairsCount: async (since: Date) => {
        let trades: Trade[] = [];
        if (USE_KV) {
            trades = (await kv.get<Trade[]>('trades')) || [];
        } else {
            trades = readDataLocal().trades;
        }
        const recentTrades = trades.filter(t => new Date(t.timestamp) > since);
        const unique = new Set(recentTrades.map(t => t.symbol));
        return unique.size;
    }
};
