const { test, expect } = require('@playwright/test');

function baseUrl() {
  const base = process.env.JIRA_BASE_URL;
  expect(base).toBeTruthy();
  return base.replace(/\/$/, '');
}

test('authenticated Jira shell is reachable', async ({ page }) => {
  await page.goto(`${baseUrl()}/jira/your-work`, { waitUntil: 'domcontentloaded' });
  await expect(page).not.toHaveURL(/login|id\.atlassian/i);
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/Something went wrong|Failed to load|Log in to continue/i);
});
