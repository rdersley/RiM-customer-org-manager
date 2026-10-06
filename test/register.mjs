// Maps @forge/* imports to the in-memory mocks in ./mocks so resolver code can run under `node --test`.
import { register } from 'node:module';

const mocksDir = new URL('./mocks/', import.meta.url).href;

register('data:text/javascript,' + encodeURIComponent(`
  const mocks = { '@forge/api': 'api.mjs', '@forge/resolver': 'resolver.mjs', '@forge/kvs': 'kvs.mjs' };
  export async function resolve(specifier, context, next) {
    if (mocks[specifier]) return { url: new URL(mocks[specifier], ${JSON.stringify(mocksDir)}).href, shortCircuit: true };
    return next(specifier, context);
  }
`));
