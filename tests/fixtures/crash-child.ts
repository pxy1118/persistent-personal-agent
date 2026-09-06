import { writeFileSync } from 'node:fs';
import { Store } from '../../src/store.js';
import { Actions } from '../../src/actions.js';

const [db, marker, stage] = process.argv.slice(2);
const store = new Store(db); const actions = new Actions(store);
const actionId = await actions.begin('crash-call', 'crash-session', 'fixture', { marker }, process.cwd(), async () => true);
if (stage !== 'before') actions.dispatch(actionId);
if (stage === 'after-effect') writeFileSync(marker, 'one effect');
// Deliberately bypass graceful disposal, mirroring an abruptly terminated host.
process.exit(77);
