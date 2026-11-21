// Recent projects -> Open, in a real browser: the other project opens even when the open project's file never
// finishes saving, and an open that fails says so and leaves the dialog up. (Run with: npm run e2e)
'use strict';
const { test, expect } = require('@playwright/test');

// Two projects saved in this browser: "E2E Alpha" (1 object) open, "E2E Bravo" (3 objects) in Recent projects.
async function twoProjects(page) {
  // nothing outside the app is needed (map tiles, live data): the tests do not depend on the network
  await page.route(url => !/^https?:\/\/localhost(:\d+)?\//.test(url.href), route => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => window.MB && MB.projects && MB.projects.ready && MB.projects.owns());
  const ids = await page.evaluate(async () => {
    const base = MB.serializeProject(), layerId = base.layers[0].id;
    const line = n => ({ id: MB.uid(), layerId, type: 'line', name: 'Line ' + n, style: Object.assign({}, MB.defaultStyle), latlngs: [[10 + n, 20], [11 + n, 21]] });
    const project = (name, count) => Object.assign({}, base, { id: MB.uid(), name, features: Array.from({ length: count }, (x, i) => line(i)) });
    const a = project('E2E Alpha', 1), b = project('E2E Bravo', 3);
    if (!(await MB.projects.putSaved(b))) throw new Error('Bravo was not saved');
    MB.loadProject(a);
    for (let i = 0; i < 100 && !(MB.projects.owns() && await MB.projects.flush()); i++) await new Promise(r => setTimeout(r, 50));
    if (!MB.projects.owns() || MB.projects.dirty()) throw new Error('Alpha was not saved');
    return { a: a.id, b: b.id };
  });
  await expect(page.locator('#projectName')).toHaveValue('E2E Alpha');
  expect(await objects(page)).toBe(1);
  return ids;
}
const objects = page => page.evaluate(() => Object.keys(MB.featureLayers).length);

// Menu -> Recent projects, as the menu item does it; the row's Open button for a project.
async function openRow(page, id) {
  await page.evaluate(() => { MB.projects.openDialog(); });
  const row = page.locator('#recentDialog [data-open="' + id + '"]');
  await expect(row).toBeVisible();
  return row;
}

test('Recent projects opens the other project even when the open project\'s file never finishes saving', async ({ page }) => {
  const ids = await twoProjects(page);
  await page.evaluate(() => { window.MB.browserFiles.writePending = () => new Promise(() => {}); });
  expect(await page.evaluate(() => MB.browserFiles.available)).toBe(true); // (the stalled write is on the way)
  const row = await openRow(page, ids.b);
  await row.click();
  // the wait for the file is given up on after 8 seconds: the switch completes
  await expect(page.locator('#projectName')).toHaveValue('E2E Bravo', { timeout: 15000 });
  await expect(page).toHaveTitle('E2E Bravo - GenGIS');
  expect(await page.evaluate(() => MB.state.projectId)).toBe(ids.b);
  expect(await objects(page)).toBe(3);
  await expect(page.locator('#recentDialog')).toBeHidden();
  await expect(page.locator('#mb-toast')).toHaveText('Could not finish saving the project file first; it is still saved in the app.');
});

test('Recent projects: a project that fails to open says so, and the dialog stays up to try again', async ({ page }) => {
  const ids = await twoProjects(page);
  await page.evaluate(() => {
    const real = MB.loadProject;
    MB.loadProject = () => { MB.loadProject = real; throw new Error('E2E: this one does not load'); }; // (once)
  });
  const row = await openRow(page, ids.b);
  await row.click();
  const toast = page.locator('#mb-toast.show');
  await expect(toast).toHaveText('Could not open "E2E Bravo": E2E: this one does not load');
  await expect(page.locator('#recentDialog')).toBeVisible();
  await expect(row).toBeEnabled();
  await expect(page.locator('#projectName')).toHaveValue('E2E Alpha');
  expect(await objects(page)).toBe(1);
  // what is on the map may be half a project: nothing is saved from it until one opens whole
  await expect(page.locator('#mb-readonly')).toContainText('A project did not open completely');
  expect(await page.evaluate(() => MB.projects.owns())).toBe(false);
  // and the same button then opens it, editable again
  await row.click();
  await expect(page.locator('#projectName')).toHaveValue('E2E Bravo');
  expect(await objects(page)).toBe(3);
  await expect(page.locator('#recentDialog')).toBeHidden();
  await expect(page.locator('#mb-readonly')).toHaveCount(0);
  await page.waitForFunction(() => MB.projects.owns());
});
