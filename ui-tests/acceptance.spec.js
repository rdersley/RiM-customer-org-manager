const { test, expect } = require('@playwright/test');

const fatalError = /Something went wrong|Failed to load|Log in to continue|Internal server error|We can't find the page you're looking for|Error code:\s*404/i;
const managerName = 'Customer & Organisation Manager';

function baseUrl() {
  const base = process.env.JIRA_BASE_URL;
  expect(base).toBeTruthy();
  return base.replace(/\/$/, '');
}

function appUrl() {
  const appId = process.env.FORGE_APP_ID || 'ef946f9f-5a25-47d1-96ca-b1a11530f57c';
  const environmentId = process.env.FORGE_ENVIRONMENT_ID || '792afed1-f185-49b8-8bb3-e876d93a698c';
  return `${baseUrl()}/jira/settings/apps/${appId}/${environmentId}`;
}

async function expectHealthy(page) {
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(fatalError);
  await expect(page).not.toHaveURL(/login|id\.atlassian/i);
}

async function openManager(page) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded' });
  await expectHealthy(page);
  await expect(page.getByText(managerName, { exact: true }).first()).toBeVisible({ timeout: 30000 });

  const iframeSelector = 'iframe[data-forge-iframe="true"], iframe[data-testid="hosted-resources-iframe"]';
  const iframe = page.locator(iframeSelector).first();
  await expect(iframe).toBeVisible({ timeout: 30000 });
  const manager = page.frameLocator(iframeSelector).first();
  await expect(manager.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible({ timeout: 30000 });
  return manager;
}

test('Customer & Organisation Manager opens directly in Jira administration', async ({ page }) => {
  const manager = await openManager(page);
  await expect(manager.getByRole('tab', { name: 'Customers', exact: true })).toBeVisible();
  await expect(manager.getByRole('tab', { name: 'Organisations', exact: true })).toBeVisible();
  await expect(manager.getByRole('tab', { name: 'Import', exact: true })).toBeVisible();
  await expect(manager.getByRole('tab', { name: 'Import History', exact: true })).toBeVisible();
});

test('customer administration exposes working search controls', async ({ page }) => {
  const manager = await openManager(page);
  await expect(manager.getByPlaceholder('Search customers by name or email')).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Reset', exact: true })).toBeVisible();
});

test('selected service project customer retrieval succeeds without API 412', async ({ page }) => {
  const manager = await openManager(page);
  const body = manager.locator('body');
  await page.waitForTimeout(4000);
  await expect(body).not.toContainText(/Atlassian API error 412|There was an error invoking the function/i);
  await expect(manager.getByPlaceholder('Search customers by name or email')).toBeVisible();
  await manager.getByPlaceholder('Search customers by name or email').fill('qa-no-412-probe');
  await manager.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForTimeout(2000);
  await expect(body).not.toContainText(/Atlassian API error 412|There was an error invoking the function/i);
});

test('organisation administration exposes search', async ({ page }) => {
  const manager = await openManager(page);
  await manager.getByRole('tab', { name: 'Organisations', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'Organisations', exact: true })).toBeVisible();
  await expect(manager.getByPlaceholder('Search organisations')).toBeVisible();
});

test('import screen exposes Jira-aware preview workflow', async ({ page }) => {
  const manager = await openManager(page);
  await manager.getByRole('tab', { name: 'Import', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'Import', exact: true })).toBeVisible();
  await expect(manager.locator('body')).toContainText(/preview checks Jira before anything is changed/i);
  await expect(manager.locator('input[type="file"]')).toBeVisible();
});

test('16k valid CSV completes batched Jira comparison without API 412', async ({ page }) => {
  test.setTimeout(90000);
  const manager = await openManager(page);
  await manager.getByRole('tab', { name: 'Import', exact: true }).click();
  const csv = ['Email,Full Name,Organisation'];
  for (let i = 1; i <= 16413; i += 1) csv.push(`qa-large-${i}@example.invalid,QA Large ${i},QA Organisation`);
  await manager.locator('input[type="file"]').setInputFiles({
    name: 'large-import-16413-regression.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv.join('\n'))
  });
  await expect(manager.getByRole('heading', { name: 'Jira comparison complete', exact: true })).toBeVisible({ timeout: 75000 });
  await expect(manager.locator('body')).toContainText('All valid CSV rows have now been checked against Jira');
  await expect(manager.locator('body')).not.toContainText(/Atlassian API error 412|Preview failed|Large import comparison failed/i);
  await expect(manager.getByRole('button', { name: /Import 16,?413 customer changes/ })).toBeEnabled();
});

test('large mixed CSV excludes errors and enables valid customer changes', async ({ page }) => {
  test.setTimeout(90000);
  const manager = await openManager(page);
  await manager.getByRole('tab', { name: 'Import', exact: true }).click();
  const csv = ['Email,Full Name,Organisation'];
  for (let i = 1; i <= 501; i += 1) csv.push(`qa-mixed-${i}@example.invalid,QA Mixed ${i},QA Organisation`);
  csv.push('not-an-email,Bad Email,QA Organisation');
  csv.push('qa-mixed-1@example.invalid,Duplicate Email,QA Organisation');
  await manager.locator('input[type="file"]').setInputFiles({
    name: 'large-mixed-import-regression.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv.join('\n'))
  });
  await expect(manager.getByRole('heading', { name: 'Jira comparison complete', exact: true })).toBeVisible({ timeout: 75000 });
  await expect(manager.locator('body')).toContainText('2 rows will be excluded from this import');
  await expect(manager.locator('body')).toContainText(/Valid email required/);
  await expect(manager.locator('body')).toContainText(/Duplicate email in file/);
  await expect(manager.locator('body')).not.toContainText(/Import cannot continue|Atlassian API error 412|Preview failed|Large import comparison failed/i);
  await expect(manager.getByRole('button', { name: /Import 501 customer changes \(exclude 2 errors\)/ })).toBeEnabled();
});

test('import history exposes aggregate recovery sessions separately from bulk tasks', async ({ page }) => {
  const manager = await openManager(page);
  await manager.getByRole('tab', { name: 'Import History', exact: true }).click();
  await expect(manager.getByRole('heading', { name: 'Import History', exact: true })).toBeVisible();
  await expect(manager.getByRole('heading', { name: 'Import sessions', exact: true })).toBeVisible();
  await expect(manager.getByRole('heading', { name: 'Bulk task history', exact: true })).toBeVisible();
  await expect(manager.locator('body')).not.toContainText(/There was an error invoking the function|Atlassian API error 412/i);
});

test('manager remains healthy at compact desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const manager = await openManager(page);
  const dimensions = await manager.locator('html').evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 2);
});

test('manager keeps authenticated state after reload', async ({ page }) => {
  await openManager(page);
  const before = page.url();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectHealthy(page);
  await expect(page.getByText(managerName, { exact: true }).first()).toBeVisible();
  const iframeSelector = 'iframe[data-forge-iframe="true"], iframe[data-testid="hosted-resources-iframe"]';
  const iframe = page.locator(iframeSelector).first();
  await expect(iframe).toBeVisible({ timeout: 30000 });
  await expect(page.frameLocator(iframeSelector).first().getByRole('heading', { name: 'Customers', exact: true })).toBeVisible({ timeout: 30000 });
  expect(page.url()).toBe(before);
});
