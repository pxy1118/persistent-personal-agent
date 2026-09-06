import { paths } from './config.js';

// Set Pi's process-local home before importing the SDK (some upstream paths are module constants).
process.env.PI_CODING_AGENT_DIR = paths().agent;
process.env.PI_OFFLINE = process.argv[2] === 'setup-tools' ? '' : '1';
await import('./main.js');
