// Copies the default baseline next to the compiled code, so `flarewall init` finds it in dist/.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/baseline', { recursive: true });
copyFileSync('src/baseline/default.yaml', 'dist/baseline/default.yaml');
