import fs from 'fs';
import path from 'path';
import { put, list } from '@vercel/blob';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');
const BLOB_FILENAME = 'storage.json';

// Check if we are in an environment with Vercel Blob configured
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

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
    highest_price?: number; // For Trailing SL
    timestamp: string;
};

export type Settings = {
    expected_status?: 'running' | 'stopped';
    last_heartbeat?: string;
    economic_calendar?: string; // JSON string of EconomicEvent[]
    [key: string]: string | undefined;
};

export type EconomicEvent = {
    date: string;
    event: string;
    impact: 'HIGH' | 'MEDIUM' | 'LOW';
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
        console.warn("Failed to read local storage:", error);
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
        console.warn("Failed to write local storage:", error);
    }
}

// --- Blob Helper Functions ---

async function readDataBlob(): Promise<StorageData> {
    try {
        // 1. List blobs to find our file
        const { blobs } = await list({ prefix: BLOB_FILENAME, limit: 1 });
        const blob = blobs.find(b => b.pathname === BLOB_FILENAME);

        if (!blob) {
            return { trades: [], settings: {}, portfolio_snapshots: [], logs: [] };
        }

        // 2. Fetch the content
        const response = await fetch(blob.url);
        if (!response.ok) throw new Error('Failed to fetch blob');
        return await response.json();

    } catch (error) {
        console.error("Failed to read from Blob:", error);
        return { trades: [], settings: {}, portfolio_snapshots: [], logs: [] };
    }
}

async function writeDataBlob(data: StorageData) {
    try {
        // Overwrite the file. addRandomSuffix: false ensures we keep the same filename.
        await put(BLOB_FILENAME, JSON.stringify(data), {
            access: 'public',
            addRandomSuffix: false,
            token: process.env.BLOB_READ_WRITE_TOKEN,
            // @ts-ignore
            allowOverwrite: true
        });
    } catch (error) {
        console.error("Failed to write to Blob:", error);
    }
}

// --- Unified Storage Interface ---

// Helper to get data from the correct source
async function getData(): Promise<StorageData> {
    if (USE_BLOB) {
        return await readDataBlob();
    } else {
        return readDataLocal();
    }
}

// Helper to save data to the correct source
async function saveData(data: StorageData) {
    if (USE_BLOB) {
        await writeDataBlob(data);
    } else {
        writeDataLocal(data);
    }
}

export const storage = {
    getTrades: async (limit?: number): Promise<Trade[]> => {
        const data = await getData();
        let trades = data.trades.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        if (limit) trades = trades.slice(0, limit);
        return trades;
    },

    getOpenTrades: async (): Promise<Trade[]> => {
        const data = await getData();
        return data.trades.filter(t => t.status === 'open');
    },

    addTrade: async (trade: Omit<Trade, 'id' | 'timestamp'>) => {
        const data = await getData();
        const newTrade: Trade = {
            ...trade,
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date().toISOString()
        };
        data.trades.push(newTrade);
        await saveData(data);
        return newTrade;
    },

    updateTradeStatus: async (symbol: string, status: 'open' | 'closed') => {
        const data = await getData();
        let updated = false;
        data.trades.forEach(t => {
            if (t.symbol === symbol && t.status === 'open') {
                t.status = status;
                updated = true;
            }
        });
        if (updated) await saveData(data);
    },

    closeTradeById: async (id: string) => {
        const data = await getData();
        const trade = data.trades.find(t => t.id === id);
        if (trade) {
            trade.status = 'closed';
            await saveData(data);
        }
    },

    updateTrades: async (updates: Partial<Trade>[]) => {
        if (updates.length === 0) return;
        const data = await getData();
        let changed = false;

        for (const update of updates) {
            if (!update.id) continue;
            const trade = data.trades.find(t => t.id === update.id);
            if (trade) {
                Object.assign(trade, update);
                changed = true;
            }
        }

        if (changed) await saveData(data);
    },

    // Deprecated: Use updateTrades for batching
    updateTradeHighestPrice: async (id: string, price: number) => {
        await storage.updateTrades([{ id, highest_price: price }]);
    },

    getSettings: async (key: string): Promise<string | null> => {
        const data = await getData();
        return data.settings[key] || null;
    },

    setSettings: async (key: string, value: string) => {
        const data = await getData();
        data.settings[key] = value;
        await saveData(data);
    },

    updateHeartbeat: async () => {
        const data = await getData();
        data.settings.last_heartbeat = new Date().toISOString();
        await saveData(data);
    },

    getHeartbeat: async (): Promise<string | null> => {
        const data = await getData();
        return data.settings.last_heartbeat || null;
    },

    getLatestSnapshot: async (): Promise<Snapshot | null> => {
        const data = await getData();
        if (data.portfolio_snapshots.length === 0) return null;
        return data.portfolio_snapshots.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
    },

    getSnapshots: async (limit?: number) => {
        const data = await getData();
        let snapshots = data.portfolio_snapshots.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        if (limit) snapshots = snapshots.slice(0, limit);
        return snapshots;
    },

    getSnapshotsSince: async (since: Date) => {
        const data = await getData();
        return data.portfolio_snapshots.filter(s => new Date(s.timestamp) > since).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    },

    addSnapshot: async (snapshot: Omit<Snapshot, 'timestamp'>) => {
        const data = await getData();
        const newSnapshot = { ...snapshot, timestamp: new Date().toISOString() };
        data.portfolio_snapshots.push(newSnapshot);

        // Limit snapshots to save bandwidth/storage
        if (data.portfolio_snapshots.length > 500) {
            data.portfolio_snapshots = data.portfolio_snapshots.slice(-500);
        }

        await saveData(data);
    },

    addLog: async (level: string, message: string, meta?: string) => {
        const data = await getData();
        const newLog = { level, message, meta, timestamp: new Date().toISOString() };
        data.logs.push(newLog);

        // Keep logs size manageable
        if (data.logs.length > 200) {
            data.logs = data.logs.slice(-200);
        }

        await saveData(data);
    },

    getTradesSince: async (since: Date) => {
        const data = await getData();
        return data.trades.filter(t => new Date(t.timestamp) > since);
    },

    getWinRateStats: async () => {
        const data = await getData();
        const closedTrades = data.trades.filter(t => t.status === 'closed');
        const wins = closedTrades.filter(t => (t.price * t.amount) > t.cost).length;
        return { wins, total: closedTrades.length };
    },

    getUniqueTradedPairsCount: async (since: Date) => {
        const data = await getData();
        const trades = data.trades.filter(t => new Date(t.timestamp) > since);
        const unique = new Set(trades.map(t => t.symbol));
        return unique.size;
    }
};
