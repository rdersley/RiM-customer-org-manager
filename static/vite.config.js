import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The app version shown in the header pill and footer comes from the root package.json.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) }
});
