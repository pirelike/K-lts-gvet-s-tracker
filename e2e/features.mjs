// Az új funkciók végigpróbálása böngészőben (Playwright + Chromium) az éles buildre.
//
//   npm run build
//   python3 -m http.server 4173 --directory build &
//   npm install --no-save playwright
//   BASE_URL=http://localhost:4173/ npm run e2e:features
//
// Opcionális: CHROMIUM_PATH=/út/a/chromiumhoz
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173/';
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'koltsegvetes-features-')) + path.sep;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 2,
	locale: 'hu-HU',
	timezoneId: 'Europe/Budapest',
	acceptDownloads: true,
	permissions: ['notifications']
});
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

let failed = 0;
const ok = (cond, msg) => { console.log(cond ? '  ✓' : '  ✗ FAIL:', msg); if (!cond) failed++; };
const step = (s) => console.log('•', s);
const nb = (s) => s.replace(/\u00a0/g, ' ').replace(/\u2212/g, '-');
const hash = () => new URL(page.url()).hash;
const shot = (name) => page.screenshot({ path: SHOTS + name + '.png', fullPage: true });
const settled = () => page.waitForFunction(() => !document.documentElement.dataset.vt);
const goMore = async (label) => {
	await page.click('nav a:has-text("Több")');
	await page.waitForSelector('h1:has-text("Több")');
	await settled(); // az oldalváltás animációja alatt a kattintás nem érne célba
	await page.click(`ul.list a:has-text("${label}")`);
	await settled();
};
const nav = async (label) => {
	await page.click(`nav a:has-text("${label}")`);
	await settled();
};
const SAVE = 'button[type=submit].btn.primary';
const num = (s) => Number(nb(s).replace(/[^\d-]/g, ''));
const optionIndex = async (select, text) => (await select.locator('option').allInnerTexts()).findIndex((t) => t.includes(text));
/** A főoldal „Kiadás" csempéje számként (előjellel: kiadás negatív). */
const monthExpense = async () => {
	await nav('Főoldal');
	await page.waitForSelector('.stats');
	const t = nb(await page.locator('.stat').nth(1).locator('.value').innerText());
	return t.startsWith('+') ? num(t) : -Math.abs(num(t));
};

await page.goto(BASE);
await page.waitForSelector('#pin');
await page.fill('#pin', '1234'); await page.fill('#pin2', '1234');
await page.check('input[type=checkbox]');
await page.click('text=Kezdjük');
await page.waitForSelector('text=Kiadások kategóriánként');

// ---------- gyorsbevitel ----------
step('természetes nyelvű gyorsbevitel: kávé 891 tegnap');
const quick = page.locator('[data-testid=quick-entry] input[type=text]');
await quick.fill('kávé 891 tegnap');
await page.waitForSelector('[data-testid=quick-preview] strong');
const prev = nb(await page.locator('[data-testid=quick-preview]').innerText());
ok(prev.includes('891 Ft') && prev.includes('28.') && prev.includes('Kávé'), `előnézet: ${prev.replace(/\n/g, ' ')}`);
await quick.press('Enter');
await page.waitForSelector('.toast:has-text("Mentve: 891 Ft")');
ok(await quick.inputValue() === '', 'a mező kiürült mentés után');
await nav('Tételek');
await page.fill('#q', 'kave');
await page.waitForFunction(() => document.body.innerText.includes('891'));
ok(nb(await page.locator('.tx').first().innerText()).includes('891 Ft') || (await page.locator('.tx:has-text("891")').count()) > 0, 'a tétel megjelent a listában');
await page.fill('#q', '');

// ---------- keretek ----------
step('havi keret + figyelmeztetés a főoldalon');
await goMore('Havi keretek');
await page.waitForSelector('text=Összes havi keret');
await page.fill('#total-budget', '50000');
await page.click('button:has-text("Mentés")');
await page.waitForSelector('.toast:has-text("Összes havi keret mentve")');
const foodInput = page.locator('li:has(label:has-text("Étel")) input.budget-input');
await foodInput.fill('10000');
await foodInput.press('Tab');
await page.waitForSelector('.toast:has-text("Keret mentve")');
await shot('01-budgets');
await nav('Főoldal');
await page.waitForSelector('[data-testid=budget-bars]');
ok(await page.locator('[role=progressbar]').count() >= 2, 'sávok a főoldalon (összes + Étel)');
const alertText = nb(await page.locator('[data-testid=budget-alerts]').innerText());
ok(/Túllépted/.test(alertText) && /Étel/.test(alertText), `figyelmeztetés: ${alertText.replace(/\n/g, ' | ')}`);
const foodBar = page.locator('[role=progressbar][aria-label="Étel havi keret"]');
ok(Number(await foodBar.getAttribute('aria-valuenow')) === 100, 'az Étel sáv 100%-ra telt (túllépve)');
await shot('02-home');

step('keret átlépése mentéskor toast-ot ad');
await goMore('Havi keretek');
await page.fill('#total-budget', '');
await page.click('button:has-text("Mentés")');
await page.waitForSelector('.toast:has-text("törölve")');
await foodInput.fill('');
await foodInput.press('Tab');
const cat = page.locator('li:has(label:has-text("Egyéb")) input.budget-input').first();
const eSpent = num(await page.locator('li:has(label:has-text("Egyéb")) .hint').first().innerText());
await cat.fill(String(eSpent + 1000));
await cat.press('Tab');
await page.waitForSelector('.toast:has-text("Keret mentve")');
await page.click('a.fab');
await page.fill('#amount', '900');
await page.fill('#description', 'Egyéb teszt');
await page.locator('label.chip:has-text("Egyéb")').first().click();
await page.click(SAVE);
await page.waitForSelector('.toast:has-text("keret 9")');
ok(true, 'a mentés után jelzi, hogy a keret 90%-án jársz');

// ---------- jóváírás ----------
step('jóváírás: csökkenti a kiadást, nem számít bevételnek');
await page.click('a.fab');
await page.fill('#amount', '15000');
await page.fill('#description', 'Kabát');
await page.locator('label.chip:has-text("Ruházat")').click();
await page.click(SAVE);
await page.waitForSelector('.stats');
const afterBuy = await monthExpense();
const incomeBefore = num(await page.locator('.stat').nth(0).locator('.value').innerText());
await page.click('a.fab');
await page.locator('.seg.four label:has-text("Jóváírás")').click();
await page.waitForSelector('text=csökkenti a kiválasztott kategória költését');
await page.fill('#amount', '6000');
await page.fill('#description', 'Kabát visszavíve');
await page.locator('label.chip:has-text("Ruházat")').click();
await shot('03-refund-form');
await page.click(SAVE);
await page.waitForSelector('.stats');
const afterRefund = await monthExpense();
ok(afterRefund === afterBuy + 6000, `a havi kiadás 6000-rel csökkent (${afterBuy} → ${afterRefund})`);
ok(num(await page.locator('.stat').nth(0).locator('.value').innerText()) === incomeBefore, 'a bevétel nem változott');
ok(nb(await page.locator('.stat').nth(1).innerText()).includes('jóváírással'), 'a csempe jelzi, hogy jóváírással csökkent');

// ---------- felosztás ----------
step('egy tétel több kategóriára bontása');
await page.click('a.fab');
await page.fill('#amount', '5000');
await page.fill('#description', 'Lidl bevásárlás teszt');
await page.click('button:has-text("Felosztás több kategóriára")');
const rowsSel = page.locator('[data-testid=split-editor] select');
await rowsSel.nth(0).selectOption({ index: await optionIndex(rowsSel.nth(0), 'Étel') });
await rowsSel.nth(1).selectOption({ index: await optionIndex(rowsSel.nth(1), 'Egyéb') });
await page.locator('[data-testid=split-editor] input').nth(1).fill('2000');
ok(nb(await page.locator('[data-testid=split-editor]').innerText()).includes('Elosztatlan: 3 000 Ft'), 'a maradék kijelzése (az üres rész kapja)');
await shot('04-split-form');
await page.click(SAVE);
await page.waitForSelector('.stats');
await nav('Tételek');
await page.fill('#q', 'lidl bevasarlas teszt');
await page.waitForSelector('.tx:has-text("Lidl bevásárlás teszt")');
ok(nb(await page.locator('.tx:has-text("Lidl bevásárlás teszt") .tx-sub').innerText()).includes('Étel + Egyéb'), 'a sor mindkét kategóriát mutatja');
await page.fill('#q', '');
// rossz összeg → hiba
await page.locator('.tx:has-text("Lidl bevásárlás teszt")').first().click().catch(() => {});

// ---------- ismétlődő tételek ----------
step('ismétlődő tétel: esedékes lista, egy érintéses jóváhagyás');
await goMore('Ismétlődő tételek');
await page.waitForSelector('text=Új ismétlődő tétel');
const form = page.locator('details:has(summary:has-text("Új ismétlődő tétel"))');
await form.locator('input[placeholder="pl. albérlet, Netflix"]').fill('Albérlet teszt');
await form.locator('input[placeholder="pl. 90 000"]').fill('90000');
const catSel = form.locator('select').first();
await catSel.selectOption({ index: await optionIndex(catSel, 'Lakhatás') });
const start = await page.evaluate(() => { const d = new Date(); d.setMonth(d.getMonth() - 2); d.setDate(5); return d.toISOString().slice(0, 10); });
await form.locator('input[type=date]').first().fill(start);
await form.locator('button:has-text("Hozzáadás")').click();
await page.waitForSelector('.toast:has-text("Ismétlődő tétel létrehozva")');
await page.waitForSelector('[data-testid=due-list]');
const dueText = nb(await page.locator('[data-testid=due-list]').innerText());
ok(/Esedékes tételek \(3\)/.test(dueText), `3 esedékes előfordulás (felzárkózás): ${dueText.slice(0, 40).replace(/\n/g, ' ')}`);
await shot('05-recurring');
await page.locator('[data-testid=due-list] button:has-text("Kifizetve")').click();
await page.waitForSelector('.toast:has-text("Jóváhagyva")');
await page.waitForFunction(() => /Esedékes tételek \(2\)/.test(document.querySelector('[data-testid=due-list]')?.innerText ?? ''));
ok(true, 'jóváhagyás után 2 maradt');
await page.locator('[data-testid=due-list] button:has-text("Kihagy")').click();
await page.waitForFunction(() => /Esedékes tételek \(1\)/.test(document.querySelector('[data-testid=due-list]')?.innerText ?? ''));
ok(true, 'a kihagyás is előreléptet');
await page.locator('[data-testid=due-list] input.due-amount').fill('91500');
await page.locator('[data-testid=due-list] button:has-text("Kifizetve")').click();
await page.waitForFunction(() => !document.querySelector('[data-testid=due-list]'));
ok(true, 'a lista eltűnt, ha nincs több esedékes');
await nav('Tételek');
await page.fill('#q', 'alberlet teszt');
await page.waitForFunction(() => document.querySelectorAll('.tx').length === 2 && document.body.innerText.includes('Albérlet teszt'));
const rec = (await page.locator('.tx:has-text("Albérlet teszt")').allInnerTexts()).map(nb);
ok(rec.length === 2 && rec.some((t) => t.includes('91 500 Ft')) && rec.every((t) => t.includes('↻')), `2 létrejött tétel ismétlődő jelzéssel, a módosított összeggel: ${rec.map((t) => t.replace(/\n/g, ' ')).join(' | ')}`);
await page.fill('#q', '');

// ---------- egyenleg-egyeztetés ----------
step('egyenleg-egyeztetés korrekciós tétellel');
await goMore('Számlák');
const cashCard = page.locator('li.card:has(strong:has-text("Készpénz"))');
await cashCard.locator('button:has-text("Egyenleg egyeztetése")').click();
await cashCard.locator('input[placeholder="pl. 41 200"]').fill('50000');
await page.waitForSelector('[data-testid=reconcile-panel] :text("különbség")');
await shot('06-reconcile');
await cashCard.locator('button:has-text("Korrekciós tétel létrehozása")').click();
await page.waitForSelector('.toast:has-text("Korrekciós tétel")');
ok(nb(await page.locator('[data-testid="balance-Készpénz"]').innerText()) === '50 000 Ft', 'a készpénz egyenlege a valós 50 000 Ft');
ok(nb(await cashCard.innerText()).includes('Kezdőegyenleg: 0 Ft'), 'a kezdőegyenleg nem változott');

// ---------- sablonok ----------
step('sablon mentése és használata');
await nav('Főoldal');
await page.waitForSelector('.stats');
await page.click('a.fab');
await page.fill('#amount', '890');
await page.fill('#description', 'Reggeli kávé');
await page.click('summary:has-text("Mentés sablonként")');
await page.fill('input[aria-label="Sablon neve"]', 'Reggeli kávé');
await page.click('details:has(summary:has-text("Mentés sablonként")) button:has-text("Mentés")');
await page.waitForSelector('.toast:has-text("Sablon mentve")');
page.once('dialog', (d) => void d.accept()); // mentetlen módosítás: az elvetés megerősítése
await page.click('button:has-text("Mégse")');
await page.waitForSelector('.stats');
await page.click('a.fab');
await page.waitForSelector('[aria-label="Sablonok"] button:has-text("Reggeli kávé")');
await page.click('[aria-label="Sablonok"] button:has-text("Reggeli kávé")');
ok((await page.inputValue('#amount')) === '890' && (await page.inputValue('#description')) === 'Reggeli kávé', 'a sablon kitölti az űrlapot');
page.once('dialog', (d) => void d.accept());
await page.click('button:has-text("Mégse")');

// ---------- csoportos műveletek ----------
step('csoportos műveletek: kijelölés, címke, törlés + visszavonás');
await nav('Tételek');
await page.waitForSelector('[data-testid=result-summary]');
await page.click('button:has-text("Kijelölés")');
await page.locator('label.tx.selectable').nth(0).click();
await page.locator('label.tx.selectable').nth(1).click();
ok(nb(await page.locator('[data-testid=bulk-bar]').innerText()).includes('2 kijelölve'), '2 tétel kijelölve');
await page.fill('[data-testid=bulk-bar] input[aria-label="Címke hozzáadása"]', 'teszt');
await page.click('[data-testid=bulk-bar] button:has-text("+ Címke")');
await page.waitForSelector('.toast:has-text("címke hozzáadva")');
ok(await page.locator('.tx-sub:has-text("#teszt")').count() === 2, 'mindkét tételen megjelent a #teszt címke');
await shot('07-bulk');
await page.locator('.toast button:has-text("Visszavonás")').click();
await page.waitForFunction(() => document.querySelectorAll('.tx-sub').length && ![...document.querySelectorAll('.tx-sub')].some((e) => e.textContent.includes('#teszt')));
ok(true, 'a címkézés visszavonható');
const total0 = Number(nb(await page.locator('[data-testid=result-summary]').innerText()).match(/^(\d+)/)[1]);
await page.click('[data-testid=bulk-bar] button:has-text("Törlés"):not(.ghost)');
await page.waitForSelector('.toast:has-text("2 tétel törölve")');
const total1 = Number(nb(await page.locator('[data-testid=result-summary]').innerText()).match(/^(\d+)/)[1]);
ok(total1 === total0 - 2, `2 tétel törölve (${total0} → ${total1})`);
await page.locator('.toast:has-text("2 tétel törölve") button:has-text("Visszavonás")').click();
await page.waitForFunction((n) => Number(document.querySelector('[data-testid=result-summary]').innerText.match(/^(\d+)/)[1]) === n, total0);
ok(true, 'a csoportos törlés visszavonható');
ok(await page.locator('[data-testid=bulk-bar]').count() === 0, 'törlés után a kijelölés módból kilép');

// ---------- mentett szűrő + Továbbiak betöltése ----------
step('mentett szűrő');
await page.fill('#q', 'kave');
await page.waitForFunction(() => location.hash.includes('q=kave'));
await page.click('summary:has-text("Szűrők")');
await page.fill('#filter-name', 'Kávék');
await page.click('details:has(#filter-name) button:has-text("Mentés")');
await page.waitForSelector('[data-testid=saved-filters]:has-text("Kávék")');
await page.fill('#q', '');
await page.waitForFunction(() => !location.hash.includes('q='));
await page.click('[data-testid=saved-filters] a:has-text("Kávék")');
await page.waitForFunction(() => location.hash.includes('q=kave'));
ok(await page.locator('.chip.saved.active').count() === 1, 'a mentett szűrő alkalmazódik és aktívként látszik');
await page.fill('#q', '');

step('„Továbbiak betöltése" a 500-as levágás helyett');
await page.click('button.seg-btn:has-text("Összes")');
await page.waitForSelector('[data-testid=load-more]');
const c1 = await page.locator('.tx').count();
await page.click('[data-testid=load-more]');
const c2 = await page.locator('.tx').count();
ok(c1 === 100 && c2 > c1, `100 tétel látszik, a gomb után ${c2}`);

// ---------- elemzés + naptár ----------
step('elemzés: grafikonok, összevetés, top költések');
await nav('Elemzés');
await page.waitForSelector('svg[role=group]');
ok(await page.locator('figure.viz svg').count() >= 3, `grafikonok: ${await page.locator('figure.viz svg').count()} db`);
await page.locator('.viz .hit').first().hover();
await page.waitForSelector('.viz-tip');
ok(nb(await page.locator('.viz-tip').first().innerText()).includes('Bevétel'), 'rámutatásra tooltip jelenik meg');
ok(await page.locator('text=Mire költöttem a legtöbbet?').count() === 1, 'a „mire költöttem" szakasz megvan');
ok(await page.locator('.cmp tbody tr').count() > 0, 'kategóriánkénti összevetés az előző hónappal');
ok(await page.locator('details.viz-table').count() >= 3, 'minden grafikonhoz van táblázatos nézet');
await shot('08-stats');
await page.click('button:has-text("6 hó")').catch(() => {});

step('naptár');
await nav('Naptár');
await page.waitForSelector('[data-testid=calendar]');
await page.locator('[data-testid=calendar] button.day:not(.selected)').nth(3).click();
await page.waitForSelector('#day-title');
ok(await page.locator('.day.selected').count() === 1, 'a kiválasztott nap kiemelve');
ok((await page.locator('a:has-text("Tétel erre a napra")').getAttribute('href')).includes('date='), 'új tétel a kiválasztott napra');
await shot('09-calendar');

// ---------- billentyűparancsok ----------
step('billentyűparancsok');
await nav('Főoldal');
await page.waitForSelector('.stats');
await page.keyboard.press('?');
await page.waitForSelector('dialog[open]');
ok(await page.locator('dialog[open] kbd').count() > 5, 'a ? gomb megnyitja a súgót');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('dialog[open]'));
await page.keyboard.press('g'); await page.keyboard.press('t');
await page.waitForFunction(() => location.hash.startsWith('#/transactions'));
ok(true, 'g, t → tételek');
await page.keyboard.press('n');
await page.waitForFunction(() => location.hash.startsWith('#/new'));
ok(true, 'n → új tétel');
await page.fill('#amount', 'n');
ok((await page.inputValue('#amount')) === 'n', 'beviteli mezőben a gyorsgomb nem vesz el betűt');
await page.fill('#amount', '');
await page.click('button:has-text("Mégse")');
await page.keyboard.press('g'); await page.keyboard.press('c');
await page.waitForSelector('[data-testid=calendar]');
await page.keyboard.press(']');
await page.waitForFunction(() => location.hash.includes('month='));
ok(true, '] → következő hónap');

// ---------- CSV export / import ----------
step('CSV-export és -import');
await goMore('Beállítások');
await page.waitForSelector('text=CSV-export és -import');
const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Exportálás (CSV)")')]);
const csvFile = path.join(SHOTS, 'export.csv');
await csvDl.saveAs(csvFile);
const csv = fs.readFileSync(csvFile, 'utf8');
ok(csv.startsWith('﻿Dátum;Típus;Összeg;Pénznem;'), 'BOM-os, pontosvesszős, magyar fejléc');
const lines = csv.trim().split(/\r?\n/);
ok(lines.length > 150, `${lines.length - 1} tételsor`);
ok(lines.some((l) => l.includes('Visszatérítés')) && lines.some((l) => l.includes('Átvezetés')), 'jóváírás és átvezetés is szerepel');
await goMore('CSV-import');
await page.setInputFiles('input[type=file]', csvFile);
await page.waitForSelector('[data-testid=import-summary]');
const sum1 = nb(await page.locator('[data-testid=import-summary]').innerText());
ok(/duplikátum kimarad/.test(sum1), `a meglévő tételek kimaradnak: ${sum1.split('\n').slice(1, 3).join(' ')}`);
await page.uncheck('label:has-text("Már meglévő tételek kihagyása") input');
const sum2 = nb(await page.locator('[data-testid=import-summary]').innerText());
const imp = Number(sum2.match(/(\d+) tétel importálható/)[1]);
ok(imp === lines.length - 1, `a duplikátum-szűrés nélkül minden sor importálható (${imp})`);
await shot('10-import');
await page.click(`button:has-text("${imp} tétel importálása")`);
await page.waitForSelector('.toast:has-text("tétel importálva")');
await nav('Tételek');
await page.click('button.seg-btn:has-text("Összes")');
await page.waitForFunction(() => document.querySelector('.tx'));
await page.goto(BASE).catch(() => {});
await page.waitForSelector('#pin');
await page.fill('#pin', '1234');
await page.click('button:has-text("Feloldás")');
await page.waitForSelector('.stats');
ok(true, 'import után az app hibátlanul újraindul');

// ---------- jelszavas mentés ----------
step('jelszóval védett mentés: letöltés, rossz és jó jelszó');
await goMore('Beállítások');
await page.click('button:has-text("Jelszóval védett mentés…")');
await page.fill('#enc1', 'rövid');
await page.fill('#enc2', 'rövid');
await page.click('button:has-text("Titkosított mentés letöltése")');
await page.waitForSelector('.error:has-text("legalább 8")');
await page.fill('#enc1', 'titkos-jelszo-1');
await page.fill('#enc2', 'titkos-jelszo-1');
const [encDl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Titkosított mentés letöltése")')]);
const encFile = path.join(SHOTS, 'enc.json');
await encDl.saveAs(encFile);
const encText = fs.readFileSync(encFile, 'utf8');
const env = JSON.parse(encText);
ok(env.encrypted === true && env.cipher.name === 'AES-GCM' && !encText.includes('Albérlet') && !encText.includes('Kávé'), 'a fájl titkosított, nincs benne olvasható adat');
await page.setInputFiles('input[type=file]', encFile);
await page.waitForSelector('[data-testid=unlock-backup]');
await page.fill('[data-testid=unlock-backup] input', 'rossz-jelszo-99');
await page.click('[data-testid=unlock-backup] button:has-text("Feloldás")');
await page.waitForSelector('.error:has-text("Hibás jelszó")');
await page.fill('[data-testid=unlock-backup] input', 'titkos-jelszo-1');
await page.click('[data-testid=unlock-backup] button:has-text("Feloldás")');
await page.waitForSelector('text=felülírja a mostani adatokat');
ok(true, 'a jó jelszó feloldja, a visszatöltés megerősítést kér');
await page.click('.notice button:has-text("Visszatöltés")');
await page.click('button:has-text("Igen, visszatöltöm")');
await page.waitForSelector('.toast:has-text("visszatöltve")');

// ---------- emlékeztetők ----------
step('emlékeztetők beállítása');
await page.locator('label:has-text("Emlékeztető-értesítések bekapcsolása") input').check();
await page.waitForSelector('#daily-time');
ok(await page.locator('label:has-text("Emlékeztető-értesítések bekapcsolása") input').isChecked(), 'bekapcsolva (az engedély megadva)');
await page.fill('#daily-time', '21:30');
await page.locator('#daily-time').dispatchEvent('change');
await page.reload();
await page.waitForSelector('#pin');
await page.fill('#pin', '1234');
await page.click('button:has-text("Feloldás")');
await goMore('Beállítások');
ok((await page.inputValue('#daily-time')) === '21:30', 'az emlékeztető ideje újraindítás után is megvan');

// ---------- pénznemváltás ----------
step('pénznemváltás: HUF → EUR');
await page.waitForSelector('#cur-rate');
await page.fill('#cur-rate', '395');
await page.uncheck('label:has-text("Mentés letöltése az átváltás előtt") input');
ok(nb(await page.locator('#cur-rate ~ .hint').innerText()).includes('2,53'), 'előnézet: 1 000 Ft = 2,53 €');
await page.click('button:has-text("Pénznem átváltása")');
await page.click('button:has-text("Igen, átváltom")');
await page.waitForSelector('.toast:has-text("Pénznem átváltva: EUR")');
await nav('Főoldal');
await page.waitForSelector('.stats');
const homeText = nb(await page.locator('.stats').innerText());
ok(/€/.test(homeText) && !/Ft/.test(homeText), `a főoldal euróban mutat: ${homeText.replace(/\n/g, ' ')}`);
await shot('11-eur-home');
await page.click('a.fab');
await page.fill('#amount', '12,5');
ok(nb(await page.locator('#amount-help').innerText()).includes('12,50 €'), 'az összegmező főegységben, tizedessel értelmezi az eurót');
await page.click('button:has-text("Mégse")');

// ---------- elavult „ma" ----------
step('hónapfordulón a háttérből visszahozott app nem az előző hónapot mutatja');
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'hu-HU', timezoneId: 'Europe/Budapest' });
const p2 = await ctx2.newPage();
p2.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await p2.clock.install({ time: new Date('2026-09-30T23:59:30+02:00') });
await p2.goto(BASE);
await p2.waitForSelector('#pin');
await p2.fill('#pin', '1234'); await p2.fill('#pin2', '1234');
await p2.click('text=Kezdjük');
await p2.waitForSelector('.pager .label');
ok((await p2.locator('.pager .label').innerText()).includes('szeptember'), 'éjfél előtt: szeptember');
await p2.clock.fastForward(60_000); // átlép október 1-re, az app „háttérben volt"
await p2.waitForFunction(() => document.querySelector('.pager .label')?.textContent.includes('október'));
ok(true, 'éjfél után magától októberre vált (újratöltés nélkül)');
await ctx2.close();

console.log('\nPROBLEMS', JSON.stringify(problems, null, 1));
console.log(`Képernyőképek: ${SHOTS}`);
console.log(failed ? `\n${failed} ELLENŐRZÉS SIKERTELEN` : '\nMINDEN ELLENŐRZÉS OK');
await browser.close();
process.exit(failed ? 1 : 0);
