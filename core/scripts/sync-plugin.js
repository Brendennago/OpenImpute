// Copy the engine into the Claude plugin so the plugin is self-contained
// (plugins are installed as a folder copy and can't reach ../core).
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dest = fileURLToPath(new URL('../../claude-plugin/skills/openimpute/engine/', import.meta.url));
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(root + 'src', dest + 'src', { recursive: true });
cpSync(root + 'bin', dest + 'bin', { recursive: true });
writeFileSync(dest + 'package.json', JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');
writeFileSync(dest + 'README.md', 'Generated copy of /core. Do not edit; run `npm run sync-plugin` in core/.\n');
console.log('synced engine to', dest);
