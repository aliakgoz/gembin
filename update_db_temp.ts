import { Pool } from 'pg';

const connectionString = 'postgresql://neondb_owner:npg_SG5tHiWYVAx9@ep-gentle-unit-adcmureu-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
    connectionString,
    ssl: {
        rejectUnauthorized: false,
    },
});

async function checkAndUpdate() {
    try {
        console.log('Connecting to database...');
        const client = await pool.connect();
        console.log('Connected.');

        // Check for columns
        const res = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'trades' AND column_name IN ('sl_price', 'tp_price');
    `);

        const existingColumns = res.rows.map(r => r.column_name);
        console.log('Existing columns found:', existingColumns);

        if (!existingColumns.includes('sl_price')) {
            console.log('Adding sl_price column...');
            await client.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS sl_price DECIMAL(20, 8);');
            console.log('sl_price added.');
        } else {
            console.log('sl_price already exists.');
        }

        if (!existingColumns.includes('tp_price')) {
            console.log('Adding tp_price column...');
            await client.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS tp_price DECIMAL(20, 8);');
            console.log('tp_price added.');
        } else {
            console.log('tp_price already exists.');
        }

        client.release();
        await pool.end();
        console.log('Database check/update complete.');
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkAndUpdate();
