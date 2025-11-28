import { storage } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { revalidatePath } from "next/cache";

export const dynamic = 'force-dynamic';

async function toggleBot() {
    'use server';
    const current = (await storage.getSettings('bot_enabled')) === 'true';
    const newValue = (!current).toString();

    await storage.setSettings('bot_enabled', newValue);
    revalidatePath('/settings');
}

export default async function SettingsPage() {
    const isEnabled = (await storage.getSettings('bot_enabled')) === 'true';

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

                    <form action={toggleBot}>
                        <Button variant={isEnabled ? "destructive" : "default"}>
                            {isEnabled ? 'Stop Bot' : 'Start Bot'}
                        </Button>
                    </form>
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                    Controls the Vercel Cron execution. If stopped, the cron job will skip execution.
                </p>
            </div>
        </div>
    );
}
