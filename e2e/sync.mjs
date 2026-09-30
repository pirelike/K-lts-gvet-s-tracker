// Szinkron végigpróbálása két elszigetelt böngészőkontextussal (két „eszköz"), valódi fiók nélkül.
// A memória-szolgáltatót az URL `?syncProvider=memory` paramétere kapcsolja be; a „felhő" egyetlen, Node-oldali
// fájl, amelyet mindkét kontextus a `window.__syncMemoryBackend` horgonyon át ér el.
//
//   npm run build
//   python3 -m http.server 4173 --directory build &
//   npm install --no-save playwright                    # csak egyszer; Chromium is kell hozzá
//   BASE_URL=http://localhost:4173/ npm run e2e:sync
//
// Opcionális: CHROMIUM_PATH=/út/a/chromiumhoz
import { chromium } from 'playwright';
const BASE = (process.env.BASE_URL ?? 'http://localhost:4173/') + '?syncProvider=memory';
const PASSWORD = 'helyes-lo-elem-tuzelo';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// ---------- a közös „felhő" ----------
const cloud = { file: null, counter: 0, offline: false };
async function installCloud(ctx) {
	const guard = () => {
		if (cloud.offline) throw new Error('offline');
	};
	await ctx.exposeFunction('__memRead', () => (guard(), cloud.file ? { ...cloud.file } : null));
	await ctx.exposeFunction('__memWrite', (text, prevRev) => {
		guard();
		if ((cloud.file?.rev ?? null) !== prevRev) return { ok: false, conflict: true };
		cloud.file = { text, rev: String(++cloud.counter) };
		return { ok: true, rev: cloud.file.rev };
	});
	await ctx.exposeFunction('__memRemove', () => (guard(), void (cloud.file = null)));
	await ctx.addInitScript(() => {
		window.__syncMemoryBackend = {
			read: () => window.__memRead(),
			write: (text, prevRev) => window.__memWrite(text, prevRev),
			remove: () => window.__memRemove()
		};
	});
}

const problems = [];
async function device(name) {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'hu-HU', timezoneId: 'Europe/Budapest' });
	await installCloud(ctx);
	const page = await ctx.newPage();
	page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${name}:${m.type()}] ${m.text()}`); });
	page.on('pageerror', (e) => problems.push(`[${name}:pageerror] ${e.message}`));
	return { name, ctx, page };
}

let failed = 0;
const ok = (cond, msg) => { console.log(cond ? '  ✓' : '  ✗ FAIL:', msg); if (!cond) failed++; };
const step = (s) => console.log('•', s);

// Hash-átállítás helyett (`location.hash = …` a SvelteKit hash-routerében teljes újratöltést okoz, és az app zárolna)
// egy link kattintását szimuláljuk, ahogy a felhasználó is navigálna.
const goto = async (page, path) => {
	await page.evaluate((p) => {
		const a = document.createElement('a');
		a.href = '#' + p;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}, path);
	await page.waitForFunction(() => !document.documentElement.dataset.vt);
};
const status = (page) => page.locator('[data-testid=sync-status]').getAttribute('data-status');
const waitStatus = (page, s, timeout = 15000) =>
	page.waitForFunction((want) => document.querySelector('[data-testid=sync-badge]')?.getAttribute('data-status') === want, s, { timeout });

async function addTx(page, description, amount) {
	await page.click('a.fab');
	await page.waitForSelector('#amount');
	await page.fill('#amount', String(amount));
	await page.fill('#description', description);
	await page.click('button[type=submit].btn.primary');
	await page.waitForSelector('.toast:has-text("Mentve")');
}
const listHas = async (page, text) => {
	await goto(page, '/transactions');
	await page.waitForSelector('[data-testid=result-summary]');
	return (await page.locator('.tx', { hasText: text }).count()) > 0;
};
const syncNow = async (page) => {
	await goto(page, '/settings');
	await page.waitForSelector('[data-testid=sync-status]');
	await page.click('button:has-text("Szinkron most")');
	await page.waitForFunction(() => document.querySelector('[data-testid=sync-status]')?.getAttribute('data-status') === 'idle');
};

// ---------- A eszköz: első indítás, csatlakozás új fájllal ----------
const A = await device('A');
await A.page.goto(BASE);
await A.page.waitForSelector('#pin');
step('A: az első indításon megvan a másik eszközön használás blokkja');
ok((await A.page.locator('[data-testid=setup-connect] button[data-provider=memory]').count()) === 1, 'a „Már használod másik eszközön?" blokk látszik');
await A.page.fill('#pin', '1234'); await A.page.fill('#pin2', '1234');
await A.page.click('text=Kezdjük');
await A.page.waitForSelector('a.fab');
await addTx(A.page, 'Kávé', 890);

step('A: csatlakozás a felhőhöz, új szinkronjelszóval');
await goto(A.page, '/settings');
await A.page.waitForSelector('button[data-provider=memory]');
ok((await A.page.locator('[data-testid=sync-badge]').count()) === 0, 'kikapcsolt szinkronnál nincs állapotjelző');
await A.page.click('button[data-provider=memory]');
await A.page.waitForSelector('#sync-pw');
await A.page.click('button:has-text("Csatlakozás")');
ok((await A.page.locator('.error[role=alert]').innerText()).includes('legalább'), 'túl rövid jelszót elutasít');
await A.page.fill('#sync-pw', PASSWORD); await A.page.fill('#sync-pw2', 'mas-jelszo-123');
await A.page.click('button:has-text("Csatlakozás")');
ok((await A.page.locator('.error[role=alert]').innerText()).includes('nem egyezik'), 'eltérő jelszavakat elutasít');
await A.page.fill('#sync-pw2', PASSWORD);
await A.page.click('button:has-text("Csatlakozás")');
await A.page.waitForSelector('[data-testid=sync-status][data-status=idle]');
ok(cloud.file !== null, 'a felhőben létrejött a szinkronfájl');
ok(!cloud.file.text.includes('Kávé') && JSON.parse(cloud.file.text).encrypted === true, 'a fájl titkosított, a tartalma nem olvasható');
ok((await A.page.locator('[data-testid=sync-badge]').getAttribute('data-status')) === 'idle', 'az állapotjelző megjelent (szinkronban)');

// ---------- B eszköz: első indítás, csatlakozás a meglévő fájlhoz ----------
step('B: az első indításon „másik eszközön már használom", rossz, majd jó jelszó');
const B = await device('B');
await B.page.goto(BASE);
await B.page.waitForSelector('#pin');
await B.page.fill('#pin', '4321'); await B.page.fill('#pin2', '4321');
await B.page.click('[data-testid=setup-connect] button[data-provider=memory]');
await B.page.waitForSelector('#sync-pw');
ok(hashOf(B.page) === '#/settings', 'a PIN beállítása után a Beállítások szinkron-szekciójában folytatódik');
await B.page.fill('#sync-pw', 'teljesen-mas-jelszo');
await B.page.click('button:has-text("Csatlakozás")');
await B.page.waitForSelector('.error[role=alert]:has-text("Hibás szinkronjelszó")');
ok(true, 'rossz jelszó: „Hibás szinkronjelszó", a csatlakozás nem történt meg');
await B.page.fill('#sync-pw', PASSWORD);
await B.page.click('button:has-text("Csatlakozás")');
await B.page.waitForSelector('[data-testid=sync-status][data-status=idle]');
ok(await listHas(B.page, 'Kávé'), 'B-n megjelent az A-n felvett „Kávé"');
function hashOf(page) { return new URL(page.url()).hash; }

// ---------- kétirányú szinkron, törlés ----------
step('B felvesz egy tételt → A-n megjelenik (és értesítés jön)');
await addTx(B.page, 'Ebéd', 2400);
await syncNow(B.page);
await syncNow(A.page);
await A.page.waitForSelector('.toast:has-text("új tétel érkezett")');
ok(await listHas(A.page, 'Ebéd'), 'A-n megjelent a B-n felvett „Ebéd"');

step('B törli a „Kávé"-t → A-n eltűnik');
await goto(B.page, '/transactions');
await B.page.locator('.tx', { hasText: 'Kávé' }).first().click();
await B.page.waitForSelector('text=Tétel szerkesztése');
await B.page.click('button:has-text("Törlés")');
await B.page.waitForSelector('.toast:has-text("Tétel törölve")');
await syncNow(B.page);
await syncNow(A.page);
ok(!(await listHas(A.page, 'Kávé')), 'A-n a törölt tétel eltűnt (nem támad fel)');
ok(await listHas(A.page, 'Ebéd'), 'az „Ebéd" megmaradt');

// ---------- automatikus szinkron a késleltetés után ----------
step('automatikus szinkron: a módosítás magától feltöltődik (4 mp)');
await addTx(A.page, 'Auto tétel', 500);
await waitStatus(A.page, 'idle', 3000).catch(() => {}); // közben még függő lehet
await A.page.waitForFunction(() => document.querySelector('[data-testid=sync-badge]')?.classList.contains('ok'), null, { timeout: 15000 });
ok(true, 'a jelző visszaállt „szinkronban" állapotra magától');
await syncNow(B.page);
ok(await listHas(B.page, 'Auto tétel'), 'B-n megjelent az automatikusan feltöltött tétel');

// ---------- offline módosítás, majd újracsatlakozás ----------
step('offline módosítás, majd újra online');
cloud.offline = true;
await addTx(A.page, 'Offline tétel', 700);
await waitStatus(A.page, 'error', 15000);
ok((await A.page.locator('[data-testid=sync-badge]').getAttribute('class')).includes('off'), 'kapcsolat nélkül nem hibajelzés, hanem „nincs kapcsolat" állapot');
ok(await listHas(A.page, 'Offline tétel'), 'a tétel offline is felvehető és látszik');
cloud.offline = false;
await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
await A.page.waitForFunction(() => document.querySelector('[data-testid=sync-badge]')?.classList.contains('ok'), null, { timeout: 15000 });
ok(true, 'az `online` esemény után a feltöltés lefutott');
await syncNow(B.page);
ok(await listHas(B.page, 'Offline tétel'), 'B-n megjelent az offline felvett tétel');

// ---------- jelszócsere ----------
step('jelszócsere: a másik eszköz jelszót kér');
await goto(A.page, '/settings');
await A.page.click('button:has-text("Szinkronjelszó cseréje")');
await A.page.fill('#sync-new1', 'uj-jelszo-12345'); await A.page.fill('#sync-new2', 'uj-jelszo-12345');
await A.page.click('button:has-text("Jelszó módosítása")');
await A.page.waitForSelector('.toast:has-text("megváltozott")');
await goto(B.page, '/settings');
await B.page.click('button:has-text("Szinkron most")');
await B.page.waitForSelector('[data-testid=sync-password-retry]');
ok(true, 'B a következő szinkronnál jelszót kér');
await B.page.fill('[data-testid=sync-password-retry] input', 'uj-jelszo-12345');
await B.page.click('[data-testid=sync-password-retry] button:has-text("Folytatás")');
await B.page.waitForSelector('[data-testid=sync-status][data-status=idle]');
ok(true, 'az új jelszóval B folytatja');

// ---------- kijelentkezés ----------
step('kijelentkezés: a helyi adat és a felhőfájl megmarad');
await goto(A.page, '/settings');
await A.page.click('button:has-text("Kijelentkezés")');
await A.page.click('button:has-text("Igen, kijelentkezem")');
await A.page.waitForSelector('button[data-provider=memory]');
ok(cloud.file !== null, 'a felhőfájl megmaradt');
ok(await listHas(A.page, 'Ebéd'), 'a helyi adat megmaradt');
ok((await A.page.locator('[data-testid=sync-badge]').count()) === 0, 'az állapotjelző eltűnt');

console.log('\nPROBLEMS', JSON.stringify(problems.filter((p) => !/offline|Failed to load resource/.test(p)), null, 1));
await browser.close();
console.log(failed ? `\n${failed} ELLENŐRZÉS SIKERTELEN` : '\nMINDEN ELLENŐRZÉS OK');
process.exit(failed ? 1 : 0);
