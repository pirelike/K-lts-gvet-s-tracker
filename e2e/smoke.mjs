// Végigpróbálás böngészőben (Playwright + Chromium): az éles buildet ellenőrzi végponttól végpontig.
//
//   npm run build
//   python3 -m http.server 4173 --directory build &     # vagy bármilyen statikus szerver a build/ mappán
//   npm install --no-save playwright                    # csak egyszer; Chromium is kell hozzá
//   BASE_URL=http://localhost:4173/ npm run e2e
//
// Opcionális: CHROMIUM_PATH=/út/a/chromiumhoz (ha a Playwright saját böngészője nincs telepítve).
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const BASE = process.env.BASE_URL ?? 'http://localhost:4173/';
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'koltsegvetes-e2e-')) + path.sep;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'hu-HU', timezoneId: 'Europe/Budapest', acceptDownloads: true });
const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

let failed = 0;
const ok = (cond, msg) => { console.log(cond ? '  ✓' : '  ✗ FAIL:', msg); if (!cond) failed++; };
const step = (s) => console.log('•', s);
const nb = (s) => s.replace(/ /g, ' ').replace(/−/g, '-');
const hash = () => new URL(page.url()).hash;
// Telefonos nézetben az alsó sávban csak 5 elem van; a többi oldal a „Több" menün át érhető el.
const settled = () => page.waitForFunction(() => !document.documentElement.dataset.vt);
const goMore = async (label) => {
	await page.click('nav a:has-text("Több")');
	await page.waitForSelector('h1:has-text("Több")');
	await settled(); // az oldalváltás animációja alatt a kattintás nem érne célba
	await page.click(`ul.list a:has-text("${label}")`);
	await settled();
};

await page.goto(BASE);
await page.waitForSelector('#pin');
await page.fill('#pin', '1234'); await page.fill('#pin2', '1234');
await page.check('input[type=checkbox]');
await page.click('text=Kezdjük');
await page.waitForSelector('text=Kiadások kategóriánként');

// ---------- 1. gyors felvitel ----------
step('új tétel: FAB → űrlap');
await page.click('a.fab');
await page.waitForSelector('#amount');
ok(await page.locator('a.fab').count() === 0, 'az űrlapon nincs + gomb');
ok(hash() === '#/new', `hash-útvonal: ${hash()}`);
ok(await page.evaluate(() => document.activeElement?.id) === 'amount', 'az összegmező kapja a fókuszt');
await page.screenshot({ path: SHOTS + '03-new.png', fullPage: true });

await page.fill('#amount', '1200+850');
ok(nb(await page.locator('#amount-help').innerText()).includes('= 2 050 Ft'), 'összeg-előnézet: 1200+850 = 2 050 Ft');
await page.fill('#amount', '12k');
ok(nb(await page.locator('#amount-help').innerText()).includes('12 000 Ft'), '12k = 12 000 Ft');

step('üres leírás → hiba');
await page.click('button[type=submit].btn.primary');
ok((await page.locator('#description ~ .error').textContent())?.includes('mire költöttél'), 'kötelező leírás kiadásnál');

step('autocomplete + kategóriajavaslat');
await page.fill('#amount', '890');
await page.fill('#description', 'kav');
await page.waitForSelector('.suggest');
const sugg = await page.locator('.suggest li').allInnerTexts();
ok(sugg.some((t) => t.includes('Kávé')), `javaslatok: ${sugg.map(nb).join(' | ')}`);
ok(await page.getAttribute('#description', 'aria-expanded') === 'true', 'combobox: aria-expanded=true');
await page.locator('.suggest [role=option]', { hasText: 'Kávé' }).click();
ok((await page.inputValue('#description')) === 'Kávé', 'a javaslat kitölti a leírást');
ok(await page.locator('input[name=category]:checked').evaluate((el) => el.closest('label').innerText.includes('Étel')), 'kategória: Étel (korábbi használat alapján)');
ok(await page.locator('legend:has-text("Kategória") .badge').count() === 1, '„javasolt" jelzés látszik');
ok((await page.inputValue('#amount')) === '890', 'a már beírt összeg megmarad');

step('autocomplete billentyűzettel: ↓ + Enter választ, Esc bezár');
await page.fill('#description', 'kav');
await page.waitForSelector('.suggest');
await page.press('#description', 'ArrowDown');
ok(await page.getAttribute('#description', 'aria-activedescendant') === 'desc-opt-0', '↓ az első javaslatra lép');
ok(await page.locator('.suggest [role=option][aria-selected=true]').count() === 1, 'a kijelölt sor látszik');
await page.press('#description', 'Escape');
await page.waitForSelector('.suggest', { state: 'detached' });
ok(true, 'Esc bezárja a listát');
await page.press('#description', 'ArrowDown');
await page.waitForSelector('.suggest');
const firstSugg = await page.locator('.suggest [role=option]').first().locator('span').first().innerText();
await page.press('#description', 'Enter');
ok((await page.inputValue('#description')) === firstSugg, `Enter kiválasztja: ${firstSugg}`);
ok(hash() === '#/new', 'Enter a javaslaton nem küldi el az űrlapot');
await page.fill('#description', 'Kávé');

step('mentés → főoldal + toast');
await page.click('button[type=submit].btn.primary');
await page.waitForSelector('.toast');
ok(nb(await page.locator('.toast').innerText()).includes('Mentve: 890 Ft'), 'toast: Mentve: 890 Ft');
ok(hash() === '' || hash() === '#/', `visszakerült a főoldalra (${hash()})`);

step('mentés és új: mezők törlődnek, számla/kategória megmarad');
await page.click('a.fab');
await page.fill('#amount', '9500');
await page.fill('#description', 'Havi bérlet teszt');
await page.locator('label.chip:has-text("Közlekedés")').click();
await page.locator('label.chip:has-text("Bankkártya")').click();
await page.click('button[data-again="1"]');
await page.waitForFunction(() => document.querySelector('#amount').value === '');
ok(hash() === '#/new', 'az űrlap nyitva maradt');
ok((await page.inputValue('#description')) === '', 'a leírás törölve');
await page.click('button:has-text("Mégse")');

// ---------- 2. lista + keresés ----------
step('tételek: élő keresés');
await page.click('nav a:has-text("Tételek")');
await page.waitForSelector('[data-testid=result-summary]');
const before = nb(await page.locator('[data-testid=result-summary]').innerText());
console.log('  alapnézet:', before.replace(/\n/g, ' '));
await page.fill('#q', 'kave');
await page.waitForFunction(() => document.querySelector('.seg-btn.active')?.textContent.trim() === 'Összes');
const res = nb(await page.locator('[data-testid=result-summary]').innerText());
console.log('  keresés (kave):', res.replace(/\n/g, ' '));
ok(/^\d+ tétel/.test(res) && Number(res.match(/^(\d+)/)[1]) > 3, 'a kávé-keresés (ékezet nélkül) találatot ad, több hónapon át');
ok(await page.locator('.seg-btn.active').innerText() === 'Összes', 'kereséskor az időszak automatikusan „Összes"');
const rows = await page.locator('.tx-title').allInnerTexts();
ok(rows.every((r) => /kávé/i.test(r)), 'minden találat kávé');
await page.screenshot({ path: SHOTS + '04-search.png', fullPage: true });
await page.fill('#q', '');
await page.waitForFunction(() => !location.hash.includes('q='));

step('szűrők: kategória + típus + hónap marad');
await page.locator('button.seg-btn:has-text("Hónap")').click();
await page.waitForFunction(() => document.querySelector('.seg-btn.active')?.textContent.trim() === 'Hónap');
await page.locator('a:has-text("Kiadás")').first().click();
await page.waitForFunction(() => location.hash.includes('type=expense'));
await page.waitForTimeout(300);
ok(hash().includes('type=expense'), `típusszűrő az URL-ben: ${hash()}`);
ok(await page.locator('.seg a.active').innerText() === 'Kiadás', 'a Kiadás szűrő aktív');
ok(await page.locator('.tx-amount.inc').count() === 0, 'csak kiadás látszik');
ok(await page.locator('.seg-btn.active').innerText() === 'Hónap', 'a típusszűrő nem vált időszakot');

// ---------- 3. szerkesztés, törlés, visszavonás ----------
step('szerkesztés');
await page.waitForSelector('.tx');
ok(await page.locator('nav a.active').innerText() === 'Tételek', 'a menüben a Tételek az aktív');
const firstTitle = await page.locator('.tx-title').first().innerText();
await page.locator('.tx').first().click();
await page.waitForSelector('text=Tétel szerkesztése');
const oldAmount = await page.inputValue('#amount');
await page.fill('#amount', '4321');
await page.click('button:has-text("Módosítások mentése")');
await page.waitForSelector('.tx');
ok(nb(await page.locator('.tx').first().innerText()).includes('4 321 Ft'), `módosított összeg látszik a listában (${firstTitle}: ${oldAmount} → 4321)`);

step('mentetlen módosítás: Mégse előtt rákérdez');
await page.locator('.tx').first().click();
await page.waitForSelector('text=Tétel szerkesztése');
await page.click('button:has-text("Mégse")');
await page.waitForSelector('[data-testid=result-summary]');
ok(true, 'változtatás nélkül a Mégse kérdés nélkül visszalép');
await page.locator('.tx').first().click();
await page.waitForSelector('text=Tétel szerkesztése');
await page.fill('#amount', '777');
let dialogs = [];
page.once('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
await page.click('button:has-text("Mégse")');
await page.waitForTimeout(400);
ok(dialogs.length === 1 && dialogs[0].includes('nincsenek mentve'), `rákérdez: ${dialogs[0]}`);
ok((await page.locator('h1').innerText()) === 'Tétel szerkesztése' && hash().startsWith('#/transactions/'), 'a „Mégse" a kérdés elutasításakor az űrlapon marad');
ok((await page.inputValue('#amount')) === '777', 'a beírt érték megmaradt');
page.once('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
await page.click('nav a:has-text("Tételek")');
await page.waitForSelector('[data-testid=result-summary]');
ok(dialogs.length === 2, 'a kérdés elfogadása után elnavigál (a módosítás elvetve)');

step('törlés + visszavonás');
const countText = async () => Number(nb(await page.locator('[data-testid=result-summary]').innerText()).match(/^(\d+)/)[1]);
const n0 = await countText();
await page.locator('.tx').first().click();
await page.waitForSelector('text=Tétel szerkesztése');
await page.click('button:has-text("Törlés")');
await page.waitForSelector('.toast button:has-text("Visszavonás")');
await page.waitForSelector('[data-testid=result-summary]');
ok((await countText()) === n0 - 1, `törlés után eggyel kevesebb tétel (${n0} → ${n0 - 1})`);
await page.hover('.toast:has-text("Tétel törölve")');
ok(await page.locator('.toast.paused').count() === 1, 'a toast időzítője megáll, amíg rajta van az egér');
await page.locator('.toast button:has-text("Visszavonás")').click();
await page.waitForFunction((n) => /^(\d+)/.exec(document.querySelector('[data-testid=result-summary]').innerText)[1] == n, n0);
ok((await countText()) === n0, 'visszavonás után újra megvan');

step('aktív szűrők chipként, egyenként törölhetően');
await page.click('nav a:has-text("Tételek")');
await page.waitForSelector('[data-testid=result-summary]');
await page.click('summary:has-text("Szűrők")');
await page.selectOption('#f-acc', { label: 'Készpénz' });
await page.waitForSelector('button.chip.removable');
await page.fill('input[aria-label="Minimum összeg"]', '1000');
await page.press('input[aria-label="Minimum összeg"]', 'Tab');
await page.waitForFunction(() => document.querySelectorAll('button.chip.removable').length === 2);
const chipTexts = (await page.locator('button.chip.removable').allInnerTexts()).map(nb);
ok(chipTexts.includes('Készpénz') && chipTexts.includes('Min. 1 000 Ft'), `chipek: ${chipTexts.join(' | ')}`);
await page.click('button.chip.removable:has-text("Készpénz")');
await page.waitForFunction(() => !location.hash.includes('acc='));
ok((await page.locator('button.chip.removable').allInnerTexts()).map(nb).join() === 'Min. 1 000 Ft', 'a × csak azt az egy szűrőt törli');
await page.fill('#q', 'nincs ilyen tétel sehol');
await page.waitForSelector('.empty a:has-text("Szűrők törlése")');
await page.click('.empty a:has-text("Szűrők törlése")');
await page.waitForFunction(() => !location.hash.includes('q=') && !location.hash.includes('min='));
ok(await page.locator('button.chip.removable').count() === 0 && (await page.inputValue('#q')) === '', 'üres találatnál a „Szűrők törlése" mindent töröl');

step('csúszó jelölő a választókon');
// A jelölő (::before) a kijelölt elem alatt van: helye és szélessége egyezik (±1 px).
const pillFits = () => page.locator('.seg[aria-label="Típus szűrő"]').evaluate((seg) => {
	const a = seg.querySelector('a.active').getBoundingClientRect();
	const s = seg.getBoundingClientRect();
	const x = parseFloat(seg.style.getPropertyValue('--seg-x'));
	const w = parseFloat(seg.style.getPropertyValue('--seg-w'));
	return Math.abs(a.left - s.left - x) <= 1 && Math.abs(a.width - w) <= 1;
});
ok(await pillFits(), 'a jelölő a „Mind" alatt');
await page.locator('.seg[aria-label="Típus szűrő"] a:has-text("Átvezetés")').click();
await page.waitForFunction(() => location.hash.includes('type=transfer'));
ok(await pillFits(), 'a jelölő átcsúszott az „Átvezetés" alá');

// ---------- 4. átvezetés ----------
step('átvezetés: egyenleg változik, havi kiadás nem');
await page.click('nav a:has-text("Főoldal")');
await page.waitForSelector('.stats');
const expBefore = nb(await page.locator('.stat').nth(1).innerText());
await goMore('Számlák');
await page.waitForSelector('[data-testid^=balance-]');
const bal = async (n) => nb(await page.locator(`[data-testid="balance-${n}"]`).innerText());
const cashBefore = await bal('Készpénz'); const cardBefore = await bal('Bankkártya');
await page.click('a:has-text("Átvezetés")');
await page.waitForSelector('legend:has-text("Honnan")');
await page.fill('#amount', '10k');
await page.locator('fieldset:has(legend:has-text("Honnan")) label.chip:has-text("Bankkártya")').click();
await page.locator('fieldset:has(legend:has-text("Hová")) label.chip:has-text("Készpénz")').click();
// azonos számla → hiba
await page.locator('fieldset:has(legend:has-text("Hová")) label.chip:has-text("Bankkártya")').click();
await page.click('button[type=submit].btn.primary');
ok((await page.locator('.error').first().textContent())?.includes('nem lehet ugyanaz'), 'azonos forrás- és célszámla → hiba');
await page.locator('fieldset:has(legend:has-text("Hová")) label.chip:has-text("Készpénz")').click();
await page.click('button[type=submit].btn.primary');
await page.waitForSelector('.stats');
ok(nb(await page.locator('.stat').nth(1).innerText()) === expBefore, 'a havi kiadás nem változott az átvezetéstől');
await goMore('Számlák');
await page.waitForSelector('[data-testid^=balance-]');
const num = (s) => Number(s.replace(/[^\d-]/g, ''));
ok(num(await bal('Készpénz')) === num(cashBefore) + 10000, `készpénz +10 000 (${cashBefore} → ${await bal('Készpénz')})`);
ok(num(await bal('Bankkártya')) === num(cardBefore) - 10000, `bankkártya −10 000 (${cardBefore} → ${await bal('Bankkártya')})`);
await page.screenshot({ path: SHOTS + '05-accounts.png', fullPage: true });

// ---------- 5. kategóriák ----------
step('kategóriák: létrehozás, használt nem törölhető');
await goMore('Kategóriák');
await page.waitForSelector('text=Új kiadási kategória');
await page.click('summary:has-text("Új kiadási kategória")');
await page.fill('details input[type=text][maxlength="40"]', 'Ajándék');
await page.click('button:has-text("Hozzáadás")');
await page.waitForSelector('strong:has-text("Ajándék")');
ok(true, 'új kategória megjelent');
await page.locator('li:has(strong:has-text("Ajándék")) button:has-text("Szerkesztés")').click();
ok(await page.locator('li:has(strong:has-text("Ajándék")) button:has-text("Törlés")').count() === 1, 'használaton kívüli kategórián van Törlés');
await page.locator('li:has(strong:has-text("Ajándék")) button:has-text("Törlés")').click();
await page.locator('li:has(strong:has-text("Ajándék")) button:has-text("Igen, törlöm")').click();
await page.waitForFunction(() => !document.body.innerText.includes('Ajándék'));
ok(true, 'két lépésben törölve');
await page.locator('li:has(strong:has-text("Étel")) button:has-text("Szerkesztés")').first().click();
ok(await page.locator('li:has(strong:has-text("Étel")) button:has-text("Törlés")').count() === 0, 'használt kategórián nincs Törlés');
ok(await page.locator('li:has(strong:has-text("Étel")) button:has-text("Archiválás")').count() === 1, 'helyette Archiválás van');
await page.screenshot({ path: SHOTS + '06-categories.png', fullPage: true });

// ---------- 6. mentés / visszatöltés ----------
step('biztonsági mentés export → import');
await goMore('Beállítások');
await page.waitForSelector('text=Adatok és biztonsági mentés');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Mentés letöltése")')]);
const file = path.join(SHOTS, 'backup-test.json');
await dl.saveAs(file);
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(backup.app === 'koltsegvetes-tracker' && backup.transactions.length > 100, `JSON mentés: ${backup.transactions.length} tétel, ${backup.categories.length} kategória, ${backup.accounts.length} számla`);
ok(dl.suggestedFilename().startsWith('koltsegvetes-mentes-'), `fájlnév: ${dl.suggestedFilename()}`);
await page.setInputFiles('input[type=file]', file);
await page.waitForSelector('text=felülírja a mostani adatokat');
await page.click('.notice button:has-text("Visszatöltés")');
await page.click('button:has-text("Igen, visszatöltöm")');
await page.waitForSelector('.toast:has-text("visszatöltve")');
ok(true, 'visszatöltés sikeres');
await page.setInputFiles('input[type=file]', { name: 'rossz.json', mimeType: 'application/json', buffer: Buffer.from('{"nem":"jo"}') });
await page.waitForSelector('text=nem ennek az appnak');
ok(true, 'idegen JSON elutasítva');

step('példaadatok törlése egy gombbal');
await page.click('button:has-text("Példaadatok törlése")');
await page.click('button:has-text("Igen, törlöm")');
await page.waitForSelector('button:has-text("Példaadatok betöltése")');
await page.click('nav a:has-text("Főoldal")');
await page.waitForSelector('.stats');
ok(true, 'példaadatok törölve, a főoldal betölt');
console.log('  főoldal:', nb(await page.locator('main').innerText()).replace(/\n+/g, ' ').slice(0, 200));

// ---------- 7. zárolás ----------
step('zárolás, rossz és jó PIN');
await page.click('button:has-text("Zárolás")');
await page.waitForSelector('text=Add meg a PIN-kódot');
ok((await page.locator('main').innerText()).includes('Elfelejtett PIN?'), 'zárolt állapot');
await page.fill('#pin', '0000');
await page.click('button:has-text("Feloldás")');
await page.waitForSelector('[role=alert]:has-text("Hibás PIN")');
ok(true, 'hibás PIN elutasítva');
await page.fill('#pin', '1234');
await page.click('button:has-text("Feloldás")');
await page.waitForSelector('.stats');
ok(true, 'jó PIN feloldja');

step('újratöltés után is zárolt, az adat megmaradt');
await page.reload();
await page.waitForSelector('text=Add meg a PIN-kódot');
await page.fill('#pin', '1234');
await page.click('button:has-text("Feloldás")');
await page.waitForSelector('.stats');
ok(true, 'PIN újraindítás után is él');

// ---------- 8. offline ----------
step('offline: service worker');
await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r?.active; }, null, { timeout: 15000 });
await page.waitForTimeout(1500);
const cached = await page.evaluate(async () => (await caches.keys()).length);
ok(cached >= 1, `gyorsítótár létrejött (${cached})`);
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('text=Add meg a PIN-kódot', { timeout: 10000 });
ok(true, 'internet nélkül is betölt az app');
await page.fill('#pin', '1234');
await page.click('button:has-text("Feloldás")');
await page.waitForSelector('.stats');
await page.click('a.fab');
await page.fill('#amount', '1500');
await page.fill('#description', 'Offline kávé');
await page.click('button[type=submit].btn.primary');
await page.waitForSelector('.toast:has-text("Mentve")');
ok(true, 'offline is felvihető tétel');
await ctx.setOffline(false);

console.log('\nPROBLEMS', JSON.stringify(problems, null, 1));
console.log(`Képernyőképek: ${SHOTS}`);
console.log(failed ? `\n${failed} ELLENŐRZÉS SIKERTELEN` : '\nMINDEN ELLENŐRZÉS OK');
await browser.close();
process.exit(failed ? 1 : 0);
