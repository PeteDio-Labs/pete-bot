import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.test' });

process.env.LOG_LEVEL = 'silent';
