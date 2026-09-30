import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { decryptBackup, deriveBackupKey, decryptWithKey, encryptBackup, encryptWithKey } from '../src/lib/db/crypto';
import { openLedgerDb } from '../src/lib/db/idb';
import { fromB64, toB64 } from '../src/lib/db/pin';
import { LedgerRepo, emptyData } from '../src/lib/db/repo';
import {
	SYNC_FILE_NAME,
	createSyncKey,
	decodeSyncFile,
	deriveSyncKey,
	encodeSyncFile,
	parseSyncPayload,
	peekSyncFile,
	type EncryptedSyncFile
} from '../src/lib/sync/format';
import { ID_MIN } from '../src/lib/sync/ids';
import { sameState, type SyncState } from '../src/lib/sync/merge';
import { tombstoneKey } from '../src/lib/sync/tombstones';

// A PBKDF2 lassú: a tesztekben kevés iterációval dolgozunk (a formátum az iterációszámot a fájlból olvassa).
const ITER = 1000;

function state(): SyncState {
	return {
		epoch: { id: ID_MIN + 5, at: 1234 },
		prefs: { currency: 'EUR', totalBudget: 50000 },
		prefsUpdatedAt: 777,
		tombstones: { [tombstoneKey('transactions', ID_MIN + 9)]: 900 },
		data: {
			...emptyData(),
			accounts: [{ id: 1, name: 'Készpénz', type: 'cash', initialBalance: 1000, archived: false, sortOrder: 1, createdAt: 1, updatedAt: 5 }],
			categories: [{ id: 101, name: 'Étel', type: 'expense', color: '#f97316', icon: '🍽️', monthlyBudget: 30000, archived: false, sortOrder: 1, createdAt: 1, updatedAt: 6 }],
			transactions: [
				{ id: ID_MIN + 1, type: 'expense', amount: 890, date: '2026-09-28', description: 'Kávé', categoryId: 101, accountId: 1, toAccountId: null, note: 'x', tags: ['egyetem'], createdAt: 10, updatedAt: 11 },
				{ id: ID_MIN + 2, type: 'expense', amount: 5000, date: '2026-09-29', description: 'Lidl', categoryId: 101, accountId: 1, toAccountId: null, note: '', tags: [], splits: [{ categoryId: 101, amount: 3000 }, { categoryId: 101, amount: 2000 }], createdAt: 12, updatedAt: 13 }
			].map((t) => ({ ...t })) as SyncState['data']['transactions']
		}
	};
}

const PASSWORD = 'helyes-lo-elem-tuzelo';

describe('szinkronfájl: titkosított formátum', () => {
	it('kódolás → visszafejtés ugyanazt az állapotot adja', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const text = await encodeSyncFile(state(), { key, deviceId: 'laptop', writtenAt: 4242 });
		const r = await decodeSyncFile(text, key);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(sameState(r.state, state())).toBe(true);
		expect(r).toMatchObject({ writtenAt: 4242, deviceId: 'laptop', encrypted: true });
	});

	it('a fájl fejléce a terv szerinti, a tartalma nem olvasható benne', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const text = await encodeSyncFile(state(), { key, deviceId: 'd' });
		const f = JSON.parse(text) as EncryptedSyncFile;
		expect(f).toMatchObject({
			app: 'koltsegvetes-tracker',
			kind: 'sync',
			format: 1,
			encrypted: true,
			kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER },
			cipher: { name: 'AES-GCM' }
		});
		expect(f.kdf.salt).toBe(key.salt);
		expect(fromB64(f.kdf.salt)).toHaveLength(16);
		expect(fromB64(f.cipher.iv)).toHaveLength(12);
		expect(text).not.toContain('Kávé');
		expect(text).not.toContain('Készpénz');
		expect(SYNC_FILE_NAME).toBe('ledger.sync.json');
	});

	it('minden íráskor új IV készül (a só ugyanaz), így két kódolás sosem egyezik', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const a = JSON.parse(await encodeSyncFile(state(), { key, deviceId: 'd', writtenAt: 1 })) as EncryptedSyncFile;
		const b = JSON.parse(await encodeSyncFile(state(), { key, deviceId: 'd', writtenAt: 1 })) as EncryptedSyncFile;
		expect(a.cipher.iv).not.toBe(b.cipher.iv);
		expect(a.data).not.toBe(b.data);
		expect(a.kdf.salt).toBe(b.kdf.salt);
	});

	it('másik eszköz a jelszóból és a fájlban lévő sóból ugyanazt a kulcsot származtatja', async () => {
		const laptop = await createSyncKey(PASSWORD, { iterations: ITER });
		const text = await encodeSyncFile(state(), { key: laptop, deviceId: 'laptop' });
		const head = peekSyncFile(text);
		expect(head).toMatchObject({ ok: true, encrypted: true, kdf: { salt: laptop.salt, iterations: ITER } });
		if (!head.ok || !head.encrypted) return;
		const phone = await deriveSyncKey(PASSWORD, head.kdf);
		const r = await decodeSyncFile(text, phone);
		expect(r.ok && sameState(r.state, state())).toBe(true);
		// és a telefon írása visszaolvasható a laptopon
		const back = await decodeSyncFile(await encodeSyncFile(state(), { key: phone, deviceId: 'phone' }), laptop);
		expect(back.ok).toBe(true);
	});

	it('rossz jelszó: „Hibás szinkronjelszó", nem szivárog adat', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const text = await encodeSyncFile(state(), { key, deviceId: 'd' });
		const head = peekSyncFile(text);
		if (!head.ok || !head.encrypted) throw new Error('fejléc');
		const wrong = await deriveSyncKey('teljesen-mas-jelszo', head.kdf);
		const r = await decodeSyncFile(text, wrong);
		expect(r).toEqual({ ok: false, code: 'wrongPassword', error: 'Hibás szinkronjelszó' });
	});

	it('jelszócsere után (új só) a régi kulcs hibás jelszóként jelentkezik', async () => {
		const oldKey = await createSyncKey(PASSWORD, { iterations: ITER });
		const newKey = await createSyncKey('uj-jelszo-12345', { iterations: ITER });
		expect(newKey.salt).not.toBe(oldKey.salt);
		const text = await encodeSyncFile(state(), { key: newKey, deviceId: 'laptop' });
		expect(await decodeSyncFile(text, oldKey)).toMatchObject({ ok: false, code: 'wrongPassword' });
		expect((await decodeSyncFile(text, newKey)).ok).toBe(true);
	});

	it('kulcs nélkül a titkosított fájl jelszót kér', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const text = await encodeSyncFile(state(), { key, deviceId: 'd' });
		expect(await decodeSyncFile(text, null)).toMatchObject({ ok: false, code: 'needsPassword' });
	});

	it('módosított titkosított adat (GCM hitelesítés) elutasítva', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const f = JSON.parse(await encodeSyncFile(state(), { key, deviceId: 'd' })) as EncryptedSyncFile;
		const bytes = fromB64(f.data);
		bytes[Math.floor(bytes.length / 2)] ^= 0x01;
		const r = await decodeSyncFile(JSON.stringify({ ...f, data: toB64(bytes) }), key);
		expect(r).toMatchObject({ ok: false, code: 'wrongPassword' });
	});

	it('a kulcs nem kinyerhető, és az IndexedDB-ben tartósan tárolható (a jelszó nem)', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		expect(key.key.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('raw', key.key)).rejects.toThrow();

		const repo = new LedgerRepo(await openLedgerDb('sync-key-store'));
		await repo.setMetaRaw('syncKey', key); // nyersen: a setMeta JSON-kerülője elpusztítaná a CryptoKey-t
		const stored = { value: (await repo.getMeta<typeof key>('syncKey'))! };
		repo.close();
		expect(JSON.stringify(stored)).not.toContain(PASSWORD);
		// A visszaolvasott kulcs ugyanúgy visszafejt.
		const text = await encodeSyncFile(state(), { key, deviceId: 'd' });
		expect((await decodeSyncFile(text, stored.value)).ok).toBe(true);
	});
});

describe('szinkronfájl: titkosítatlan változat', () => {
	it('sima JSON, a `data` helyén `state`; visszaolvasható kulcs nélkül', async () => {
		const text = await encodeSyncFile(state(), { key: null, deviceId: 'd', writtenAt: 9 });
		const f = JSON.parse(text);
		expect(f).toMatchObject({ app: 'koltsegvetes-tracker', kind: 'sync', format: 1, encrypted: false });
		expect(f.data).toBeUndefined();
		expect(f.state.data.transactions).toHaveLength(2);
		expect(peekSyncFile(text)).toEqual({ ok: true, encrypted: false });
		const r = await decodeSyncFile(text, null);
		expect(r.ok && sameState(r.state, state())).toBe(true);
		expect(r).toMatchObject({ encrypted: false, deviceId: 'd', writtenAt: 9 });
	});

	it('kulccsal is beolvasható (a másik eszköz kikapcsolta a titkosítást)', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const text = await encodeSyncFile(state(), { key: null, deviceId: 'd' });
		expect((await decodeSyncFile(text, key)).ok).toBe(true);
	});
});

describe('szinkronfájl: sérült és idegen fájlok', () => {
	const bad = async (text: string, key = null as Awaited<ReturnType<typeof createSyncKey>> | null) => decodeSyncFile(text, key);

	it('nem JSON, idegen JSON, más típusú fájl', async () => {
		expect(await bad('nem json')).toMatchObject({ ok: false, code: 'invalid' });
		expect(await bad('{"app":"masik"}')).toMatchObject({ ok: false, code: 'invalid' });
		expect(await bad('[]')).toMatchObject({ ok: false, code: 'invalid' });
		// egy sima JSON-mentés nem szinkronfájl
		expect(await bad(JSON.stringify({ app: 'koltsegvetes-tracker', version: 3 }))).toMatchObject({ ok: false, code: 'invalid' });
		// egy titkosított JSON-mentés sem (nincs `kind: sync`)
		expect(await bad(await encryptBackup('{}', 'jelszo-12345'))).toMatchObject({ ok: false, code: 'invalid' });
	});

	it('újabb formátumú fájl: frissítést kér', async () => {
		const r = await bad(JSON.stringify({ app: 'koltsegvetes-tracker', kind: 'sync', format: 2, encrypted: false }));
		expect(r).toMatchObject({ ok: false, code: 'unsupported' });
	});

	it('hibás titkosítási fejléc (iterációszám, só, név)', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const f = JSON.parse(await encodeSyncFile(state(), { key, deviceId: 'd' })) as EncryptedSyncFile;
		for (const kdf of [
			{ ...f.kdf, iterations: 0 },
			{ ...f.kdf, iterations: 5_000_001 },
			{ ...f.kdf, iterations: 1.5 },
			{ ...f.kdf, salt: 5 },
			{ ...f.kdf, name: 'scrypt' },
			{ ...f.kdf, hash: 'SHA-1' }
		]) {
			expect(await bad(JSON.stringify({ ...f, kdf }), key)).toMatchObject({ ok: false, code: 'invalid' });
			expect(peekSyncFile(JSON.stringify({ ...f, kdf })).ok).toBe(false);
		}
		expect(await bad(JSON.stringify({ ...f, cipher: { name: 'AES-GCM' } }), key)).toMatchObject({ ok: false, code: 'invalid' });
		expect(await bad(JSON.stringify({ ...f, data: 5 }), key)).toMatchObject({ ok: false, code: 'invalid' });
	});

	it('a titkosított rész nem base64 vagy rövid: hibás jelszóként/hibás fájlként jelentkezik, kivétel nélkül', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const f = JSON.parse(await encodeSyncFile(state(), { key, deviceId: 'd' })) as EncryptedSyncFile;
		for (const data of ['', '###', 'AAAA']) {
			const r = await bad(JSON.stringify({ ...f, data }), key);
			expect(r.ok).toBe(false);
		}
	});

	it('visszafejthető, de nem JSON tartalom', async () => {
		const key = await createSyncKey(PASSWORD, { iterations: ITER });
		const { iv, data } = await encryptWithKey(key.key, 'ez nem json');
		const f = { app: 'koltsegvetes-tracker', kind: 'sync', format: 1, encrypted: true, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: key.salt }, cipher: { name: 'AES-GCM', iv }, data };
		expect(await bad(JSON.stringify(f), key)).toMatchObject({ ok: false, code: 'invalid' });
	});

	it('ismeretlen sémaverzió, hibás korszak, hibás beállítások', () => {
		const good = { schema: 3, writtenAt: 1, deviceId: 'd', ...state() };
		expect(parseSyncPayload(good).ok).toBe(true);
		expect(parseSyncPayload({ ...good, schema: 4 })).toMatchObject({ ok: false, code: 'unsupported' });
		expect(parseSyncPayload({ ...good, schema: 2 })).toMatchObject({ ok: false, code: 'unsupported' });
		expect(parseSyncPayload({ ...good, schema: undefined })).toMatchObject({ ok: false, code: 'invalid' });
		expect(parseSyncPayload({ ...good, epoch: { id: 'x', at: 1 } })).toMatchObject({ ok: false, code: 'invalid' });
		expect(parseSyncPayload({ ...good, epoch: undefined })).toMatchObject({ ok: false, code: 'invalid' });
		expect(parseSyncPayload({ ...good, prefsUpdatedAt: -1 })).toMatchObject({ ok: false, code: 'invalid' });
		expect(parseSyncPayload({ ...good, prefs: null })).toMatchObject({ ok: false, code: 'invalid' });
		expect(parseSyncPayload({ ...good, tombstones: [] })).toMatchObject({ ok: false, code: 'invalid' });
		expect(parseSyncPayload(null)).toMatchObject({ ok: false, code: 'invalid' });
	});

	it('érvénytelen adat (hivatkozás nélküli tétel, negatív összeg) nem jut át: badState', () => {
		const s = state();
		const dangling = { ...s, data: { ...s.data, transactions: [{ ...s.data.transactions[0], categoryId: 999 }] } };
		expect(parseSyncPayload({ schema: 3, writtenAt: 1, deviceId: 'd', ...dangling })).toMatchObject({ ok: false, code: 'badState' });
		const negative = { ...s, data: { ...s.data, transactions: [{ ...s.data.transactions[0], amount: -5 }] } };
		expect(parseSyncPayload({ schema: 3, writtenAt: 1, deviceId: 'd', ...negative })).toMatchObject({ ok: false, code: 'badState' });
		const dup = { ...s, data: { ...s.data, accounts: [s.data.accounts[0], s.data.accounts[0]] } };
		expect(parseSyncPayload({ schema: 3, writtenAt: 1, deviceId: 'd', ...dup })).toMatchObject({ ok: false, code: 'badState' });
	});

	it('az ismeretlen tárolóra vonatkozó vagy hibás jelölőket eldobja, a többit megtartja', () => {
		const good = state();
		const r = parseSyncPayload({
			schema: 3, writtenAt: 1, deviceId: 'd', ...good,
			tombstones: { 'goals:5': 10, 'jovo:7': 10, 'goals:x': 10, 'goals:6': -1, 'goals:7': 1.5, rossz: 3 }
		});
		expect(r.ok && r.value.state.tombstones).toEqual({ 'goals:5': 10 });
	});

	it('a normalizálás a mentés-beolvasás szabályait követi (hiányzó mezők alapértéket kapnak)', () => {
		const good = state();
		const slim = JSON.parse(JSON.stringify(good));
		delete slim.data.transactions[0].note;
		delete slim.data.transactions[0].tags;
		const r = parseSyncPayload({ schema: 3, writtenAt: 1, deviceId: 'd', ...slim });
		expect(r.ok && r.value.state.data.transactions[0]).toMatchObject({ note: '', tags: [] });
	});
});

describe('crypto.ts: kulcsos változatok', () => {
	it('az encryptWithKey/decryptWithKey oda-vissza működik, és a régi jelszavas mentés változatlan marad', async () => {
		const key = await deriveBackupKey('valami-jelszo', new Uint8Array(16), ITER);
		const { iv, data } = await encryptWithKey(key, 'árvíztűrő tükörfúrógép');
		expect(await decryptWithKey(key, iv, data)).toBe('árvíztűrő tükörfúrógép');
		const other = await deriveBackupKey('mas-jelszo', new Uint8Array(16), ITER);
		await expect(decryptWithKey(other, iv, data)).rejects.toThrow();

		// A JSON-mentés titkosítása továbbra is ugyanúgy működik.
		const enc = await encryptBackup('{"a":1}', 'jelszo-12345');
		expect(await decryptBackup(enc, 'jelszo-12345')).toEqual({ ok: true, json: '{"a":1}' });
		expect((await decryptBackup(enc, 'rossz-jelszo-1')).ok).toBe(false);
	});
});
