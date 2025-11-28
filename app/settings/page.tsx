import { storage } from "@/lib/storage";
import { revalidatePath } from "next/cache";

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
    const isEnabled = (await storage.getSettings('bot_enabled')) === 'true';
    const lastHeartbeat = await storage.getHeartbeat();

    return (
        <div className="flex-1 space-y-4 p-8 pt-6">
            <div className="flex items-center justify-between space-y-2">
                <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
            </div>

            <div className="p-4 border rounded-lg bg-card text-card-foreground">
                <h3 className="text-lg font-medium mb-4">Bot Status</h3>
                <div className="flex items-center space-x-4">
                    <div className={`h-3 w-3 rounded-full ${isEnabled ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span>{isEnabled ? 'Running' : 'Stopped'}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                    The bot is designed to run continuously.
                </p>
                {lastHeartbeat && (
                    <p className="text-xs text-muted-foreground mt-1">
                        Last Run: {new Date(lastHeartbeat).toLocaleString()}
                    </p>
                )}
            </div>
        </div>
    );
}
