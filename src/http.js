// Jira requests that back off when Jira rate-limits the app (429) or is briefly unavailable (503).
// On a busy live site, bursts (a health check, a bulk correction, normal ticket traffic) can hit Jira's
// limits; retrying straight away only makes that worse. We wait for Retry-After (capped), or 1s, 2s, 4s.

const RETRYABLE = new Set([429, 503]);
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 10000;
let sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tests replace the delay so they don't wait.
export function setSleepForTests(fn) { sleep = fn; }

function waitFor(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  const seconds = header == null || String(header).trim() === '' ? NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
}

// Wraps api.asUser() / api.asApp() so requestJira retries 429/503 responses.
export function retrying(client) {
  return {
    async requestJira(path, options) {
      let response;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        response = await client.requestJira(path, options);
        if (!RETRYABLE.has(response.status) || attempt === MAX_RETRIES) return response;
        await sleep(waitFor(response, attempt));
      }
      return response;
    }
  };
}

export const RATE_LIMITED_MESSAGE = 'Jira is busy right now and asked the app to slow down. Wait a minute, then try again.';
