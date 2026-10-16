import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.POSTGRES_URL;

if (!connectionString) {
  throw new Error('POSTGRES_URL environment variable is not set');
}

const url = new URL(connectionString);

export const sql = postgres(connectionString, {
  port: url.port ? parseInt(url.port) : 5432,
  ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});