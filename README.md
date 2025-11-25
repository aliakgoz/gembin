# Binance Trading Bot (Vercel + Neon)

## Deployment Instructions

1. **Push to Git**:
   ```bash
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **Import to Vercel**:
   - Go to Vercel Dashboard -> Add New Project.
   - Import the repository you just pushed.
   - **Environment Variables**: Add the following variables in Vercel Project Settings:
     - `BINANCE_API_KEY`: Your Binance API Key.
     - `BINANCE_SECRET_KEY`: Your Binance Secret Key.
     - `DATABASE_URL`: Your Neon Database Connection String.
     - `CRON_SECRET`: A random string to protect your Cron Job (optional but recommended).

3. **Cron Job**:
   - Vercel will automatically detect `vercel.json` and set up the Cron Job to run every minute.
   - You can verify it in the "Cron Jobs" tab in Vercel.

## Features
- **Dashboard**: View portfolio value, active trades, and performance metrics.
- **Bot**: Runs every minute via Vercel Cron.
- **Strategy**: Dynamic Trend Follower (RSI + Bollinger Bands).
- **Database**: Stores all trade history and snapshots in Neon Postgres.
