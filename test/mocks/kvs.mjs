// In-memory @forge/kvs: enough of the API for the resolvers (get/set/delete and prefix queries).
export const store = new Map();
// The SetOptions (e.g. ttl) passed with each key's latest write.
export const setOptions = new Map();
export const MAX_VALUE_BYTES = 240 * 1024;

export function resetStore() {
  store.clear();
  setOptions.clear();
}

export const WhereConditions = {
  beginsWith: (prefix) => ({ type: 'beginsWith', prefix })
};

export const kvs = {
  async get(key) {
    return store.has(key) ? structuredClone(store.get(key)) : undefined;
  },
  async set(key, value, options) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_VALUE_BYTES) throw new Error(`KVS value for ${key} is ${bytes} bytes (limit ${MAX_VALUE_BYTES})`);
    store.set(key, structuredClone(value));
    setOptions.set(key, options);
  },
  async delete(key) {
    store.delete(key);
    setOptions.delete(key);
  },
  query() {
    let condition = null;
    let max = 20;
    const q = {
      where(_field, cond) { condition = cond; return q; },
      limit(n) { max = n; return q; },
      async getMany() {
        const results = [...store.entries()]
          .filter(([key]) => !condition || key.startsWith(condition.prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, max)
          .map(([key, value]) => ({ key, value: structuredClone(value) }));
        return { results };
      }
    };
    return q;
  }
};
