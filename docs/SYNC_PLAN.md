# Terv: eszközök közötti szinkron (Google Drive, 2. opcióként Dropbox)

> Ez a dokumentum egy **új Claude Code session** munkaterve. Önmagában érthető: a sessionnek
> ebből és a kódból kell dolgoznia. A végén van egy indító prompt (lásd *11. Indító prompt*).

## 1. Cél és keretek

- A felhasználó bejelentkezik egy harmadik fél tárhelyére (**Google Drive**, vagy második
  lehetőségként **Dropbox**), és az adatai szinkronban maradnak a laptop és a telefon között.
- **Nincs saját szerver**, és nincs bérelt backend (Firebase/Supabase) sem. Az app továbbra is
  statikus fájlokból áll (GitHub Pages), minden a böngészőben fut.
- **Offline-first marad**: szinkron nélkül és internet nélkül is minden úgy működik, mint most.
  A szinkron egy opcionális réteg a meglévő IndexedDB fölött.
- A felhőben **titkosított** fájl van (AES-256-GCM, a meglévő `src/lib/db/crypto.ts` mintájára).
  Alapból bekapcsolt szinkronjelszóval, amit eszközönként egyszer kell megadni.
- A futásidejű kódba továbbra se kerüljön npm-függőség. A Google Identity Services szkriptet
  csak akkor töltjük be dinamikusan, amikor a felhasználó a Google-t választja.

## 2. Jelenlegi állapot (a lényeg, amire építünk)

| Fájl | Mit csinál | Mi a teendő vele |
| --- | --- | --- |
| `src/lib/db/idb.ts` | IndexedDB séma, `DB_VERSION = 2`, `MIGRATIONS` tömb; minden adattároló `autoIncrement` `id`-val | v3 migráció (`updatedAt` visszatöltése), a `meta` store marad |
| `src/lib/db/repo.ts` | `LedgerRepo`: `add`/`addMany` (a DB oszt id-t), `put`, `remove`, `replaceAll`, `seedDefaultsIfNeeded` | explicit id-k, törlési jelölők (tombstone) írása |
| `src/lib/ledger.svelte.ts` | Svelte-állapot + üzleti szabályok; minden írás után `notify()` → `BroadcastChannel('koltsegvetes-sync')` | `updatedAt` minden rekordon; a `notify()` indítja a szinkront is |
| `src/lib/db/backup.ts` | `makeBackup`/`parseBackup`, `BACKUP_VERSION = 2`, verziómigrációk, szigorú validáció | `BACKUP_VERSION = 3` (`updatedAt`), a merge után ezzel validálunk |
| `src/lib/db/crypto.ts` | jelszó → PBKDF2 → AES-GCM; minden hívás új sót generál | kulcsos változat (tartós, nem kinyerhető `CryptoKey`) |
| `src/lib/auth.svelte.ts` | DB megnyitása, PIN, zárolás, `afterUnlock()` | a szinkron feloldáskor indul, zároláskor leáll |
| `src/service-worker.ts` | csak a saját origin GET kéréseit szolgálja ki | nincs teendő (a külső API-hívásokba nem nyúl bele) |
| `src/routes/settings/+page.svelte` | beállítások, mentés/visszatöltés | új „Szinkronizálás" szekció |
| `tests/*.test.ts` | vitest + `fake-indexeddb` | új tesztek (lásd *9.*) |

### Ami miatt nem lehet csak úgy fájlt másolgatni

1. **Ütköző azonosítók.** Az `autoIncrement` miatt két eszköz ugyanazt az `id`-t adja két különböző
   tételnek, és összefésüléskor az egyik felülírná a másikat.
2. **A törlés nyomtalan.** Emiatt összefésüléskor a törölt tétel „visszajönne" a másik eszközről.
3. **`updatedAt` csak a tranzakciókon van**, így a többi rekordtípusnál nem dönthető el, melyik az újabb.
4. **Alapértelmezett adatok.** Mindkét eszköz létrehozza az alap kategóriákat és számlákat, amiből
   szinkron után duplikátumok lennének.
5. **Ismétlődő tételek.** Ha ugyanazt az előfordulást mindkét eszközön jóváhagyják, dupla tétel keletkezne.
6. **Pénznemváltás** (`switchCurrency`) minden összeget átír. Egy régi pénznemben módosított,
   még nem szinkronizált rekord összefésülés után hibás összeget adna.

## 3. Architektúra

```
┌──────────── böngésző (laptop / telefon) ─────────────┐
│ UI ─ ledger.svelte.ts ─ LedgerRepo ─ IndexedDB        │
│                  │ notify()                          │
│                  ▼                                   │
│   sync/engine.svelte.ts  (ütemezés, zár, állapot)    │
│      │  merge.ts (tiszta függvény)                   │
│      │  format.ts (titkosítás, fájlformátum)         │
│      ▼                                               │
│   SyncProvider ── gdrive.ts  |  dropbox.ts            │
└──────────────────────┼───────────────────────────────┘
                       ▼  HTTPS (fetch, OAuth token)
        Google Drive appDataFolder  /  Dropbox App folder
                 egyetlen fájl: ledger.sync.json
```

- **Egyetlen fájl** a felhőben: `ledger.sync.json`. Tartalma: a teljes állapot + a törlési jelölők,
  titkosítva. Egy magánszemély adataihoz (néhány ezer tétel, néhány száz kB) ez bőven elég, és így
  a Drive és a Dropbox ugyanazzal a kóddal kezelhető.
- **A szinkron lépései:** letöltés → visszafejtés → összefésülés a helyi állapottal → validálás →
  helyi `replaceAll` (ha változott) → feltöltés (ha a távoli fájl eltér az eredménytől).
- **Konvergencia:** az összefésülés rekordonként „az újabb nyer" (LWW) elven működik, a törlési
  jelölőkkel együtt. Kommutatív és idempotens, ezért ha egy feltöltés versenyhelyzet miatt elveszne,
  a következő szinkron helyreállítja: a lemaradt eszköz megőrzi a saját változásait, és újra feltölti őket.

## 4. Adatmodell-változások (1. fázis, szolgáltató nélkül)

### 4.1 Azonosítók

- Új `src/lib/sync/ids.ts`:
  - `newId(): number`: véletlen egész `[2^32, 2^53 − 1]` között (`crypto.getRandomValues`).
    A `2^32` alsó határ miatt nem ütközik a régi, kis sorszámú id-kkel.
  - `recurringTxId(ruleId, date): Promise<number>`: SHA-256(`${ruleId}|${date}`) első 53 bitje
    (az alsó határ ugyanúgy érvényes). Így ha ugyanazt az előfordulást két eszközön hagyják jóvá,
    **ugyanaz az id** keletkezik, és összefésüléskor egy tétel marad belőle.
- `LedgerRepo.add`/`addMany` **explicit id-t ír** (`put` vagy `add` kulccsal). Az autoIncrement store
  elfogadja a kívülről megadott kulcsot. A store-okat nem kell újra létrehozni.
- Minden `db.add`/`db.addMany` hívás a `ledger.svelte.ts`-ben (tranzakció, kategória, számla,
  ismétlődő, sablon, cél, szűrő, demo, CSV-import) ezt használja. Az `applyRecurring` a
  `recurringTxId`-t használja.
- **A meglévő id-k maradnak**, nem kell átszámozni. A hivatkozások (`categoryId`, `accountId`, …)
  továbbra is számok, így a típusok és a validáció nem változik.
- **Alapadatok:** a `seedDefaultsIfNeeded` **fix id-kat** ad (`DEFAULT_ACCOUNTS`: 1…n,
  `DEFAULT_CATEGORIES`: 101…), és `updatedAt: 0`-t. Két friss eszköz így ugyanazokat az alapelemeket
  hozza létre, és nem keletkeznek duplikátumok. (A régi telepítéseken az alapelemek id-je 1…N volt;
  ez nem baj, lásd a *4.5* első csatlakozás szabályait.)

### 4.2 `updatedAt` mindenhol

- `Account`, `Category`, `Recurring`, `Template`, `Goal`, `SavedFilter` kap egy `updatedAt: number` mezőt.
- Minden módosító metódus (`update*`, `set*Archived`, `move*`, `rename*`, `addToGoal`,
  `setCategoryBudget`, a `deleteCategory`/`deleteAccount` hivatkozás-kiürítése, `handleRecurring`
  a szabályon) beállítja.
- **DB v3 migráció** (`idb.ts` → `MIGRATIONS[2]`): a hiányzó `updatedAt` = `createdAt`.
  A meglévő lépésekhez nem nyúlunk (ez a fájl szabálya).
- **Mentés v3** (`backup.ts`): `BACKUP_VERSION = 3`, `MIGRATIONS[2]` beállítja az `updatedAt`-et,
  a `parseBackup` átveszi (hiány esetén `createdAt`).
- A `Prefs` mellé kerül a `prefsUpdatedAt` (a `meta.prefs` értékében).

### 4.3 Törlési jelölők

- `meta` kulcs: `tombstones`, értéke `Record<string, number>`: kulcs `${store}:${id}`, érték a törlés ideje.
- A `LedgerRepo.remove`/`removeMany` **ugyanabban az IDB-tranzakcióban** írja a jelölőt is.
- A visszaállítás (`restoreTx`, `restoreTxs`, `put` egy jelölt id-ra) törli a jelölőt, és frissíti az `updatedAt`-et.
- **Takarítás:** 180 napnál régebbi jelölők törlése szinkronkor. Dokumentálni kell, hogy egy
  180 napnál tovább offline eszköz visszahozhat törölt elemeket.
- A `wipeAll` és a teljes visszatöltés (`importBackup`) egy **új korszakot** (epoch) indít, lásd *4.4*.

### 4.4 Korszak (epoch): pénznemváltás, teljes visszatöltés, teljes törlés

- `meta.syncEpoch`: `{ id: number, at: number }`. Akkor kap új értéket, amikor az adatok egésze
  egyszerre cserélődik: `switchCurrency`, `importBackup`, „Minden adat törlése", példaadatok betöltése vagy törlése.
- Összefésüléskor, **ha az epoch eltér**, nincs rekordszintű merge: a **későbbi** `at` nyer egészben.
  A vesztes oldal nem szinkronizált változásairól a felhasználó figyelmeztetést kap
  („A másik eszközön pénznemet váltottál / mentést töltöttél vissza; az itteni, még nem szinkronizált
  N módosítás elveszett.") és felajánljuk, hogy előtte letölti helyi JSON-mentésként (a meglévő
  mentés-letöltés kódjával).

### 4.5 Első csatlakozás egy eszközön

1. A felhőben **nincs fájl** → a helyi állapot feltöltése, új epoch-kal, ha még nem volt.
2. **Van fájl, és helyben nincs saját adat** (csak alapadatok vagy demo, nincs saját tranzakció)
   → a távoli állapot átvétele egészben (a helyi epoch felülíródik).
3. **Mindkét oldalon van saját adat** → választás:
   - „A felhőben lévő adatok használata (az itteniek törlődnek)", előtte automatikus helyi JSON-mentéssel,
   - „Összefésülés" (rekordszintű merge; a régi, kis sorszámú id-k ütközhetnek, ezért ilyenkor a
     **helyi** régi id-kat (`< 2^32`) előbb átszámozzuk `newId()`-ra, a hivatkozásokkal együtt; ez
     egy tiszta függvény a `merge.ts`-ben, `remapIds`),
   - „Mégse".

## 5. Összefésülés (`src/lib/sync/merge.ts`, tiszta függvények)

```ts
interface SyncState {
  epoch: { id: number; at: number };
  prefs: Prefs; prefsUpdatedAt: number;
  data: LedgerData;                    // mind a 7 tároló
  tombstones: Record<string, number>;
}
function mergeStates(local: SyncState, remote: SyncState): {
  state: SyncState;
  localChanged: boolean;   // kell-e replaceAll
  remoteChanged: boolean;  // kell-e feltöltés
  report: { added: number; updated: number; removed: number; repaired: string[]; epochLost?: number };
}
```

Szabályok:
1. Eltérő epoch → *4.4*.
2. Tárolónként, id szerint egyesítés: ha csak az egyik oldalon van, marad; ha mindkettőn,
   a nagyobb `updatedAt` nyer (egyenlőségnél determinisztikusan a `JSON.stringify` szerinti nagyobb,
   hogy mindkét eszköz ugyanazt válassza).
3. Törlési jelölők: a két térkép uniója (kulcsonként max). Egy rekord akkor törlődik, ha a jelölő
   ideje ≥ a rekord `updatedAt`-je. (Ha törlés után valaki szerkesztette, a szerkesztés nyer.)
4. **Ismétlődő szabály `lastHandled`**: mezőszinten a nagyobb dátum marad, függetlenül attól,
   melyik rekord nyert. Így nem kínál fel újra egy már feldolgozott előfordulást.
5. **`prefs`**: a nagyobb `prefsUpdatedAt` nyer.
6. **Hivatkozások javítása** a merge után: ha egy élő tranzakció vagy ismétlődő szabály törölt
   kategóriára vagy számlára mutat, a hivatkozott elem **visszaéled** (a jelölő törlődik, a rekord
   a vesztes oldalról visszakerül). Sablonok és célok hivatkozása `null` lesz (ahogy a `parseBackup` teszi).
   Minden javítás bekerül a `report.repaired`-be.
7. Az eredményt a `makeBackup` + `parseBackup` lánccal validáljuk. Ha érvénytelen, **nem írunk semmit**,
   a hibát megjelenítjük, és a hibás állapotból nem töltünk fel semmit.
8. Ismert, elfogadott korlát: a `Goal.saved` párhuzamos növelésénél (`addToGoal` két eszközön offline)
   az egyik növelés elvész (LWW). Ezt dokumentálni kell a README-ben.

## 6. Szinkronfájl-formátum (`src/lib/sync/format.ts`)

```jsonc
{
  "app": "koltsegvetes-tracker",
  "kind": "sync",
  "format": 1,
  "encrypted": true,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 310000, "salt": "<b64>" },
  "cipher": { "name": "AES-GCM", "iv": "<b64>" },   // minden íráskor új IV
  "data": "<b64>"                                    // titkosított JSON: { schema: 3, writtenAt, deviceId, ...SyncState }
}
```

- `encrypted: false` esetén a `data` helyén `state` van, sima JSON-ként. Ez csak akkor fordul elő,
  ha a felhasználó kifejezetten kikapcsolja a jelszót.
- **Kulcs:** a só **a fájlban** van, így minden eszköz ugyanazt a kulcsot származtatja. Csatlakozáskor
  a jelszóból egyszer `CryptoKey`-t származtatunk (`extractable: false`), és **a `meta.syncKey`-be
  mentjük** (az IndexedDB tudja tárolni a `CryptoKey`-t). A jelszót magát sehol nem tároljuk.
- A `crypto.ts` kap egy `deriveBackupKey(password, salt, iterations)` exportot (a meglévő `deriveKey`
  kivezetése), és `encryptWithKey`/`decryptWithKey` párt. A meglévő `encryptBackup`/`decryptBackup`
  viselkedése nem változik.
- Rossz jelszó: a GCM visszafejtés hibát ad → „Hibás szinkronjelszó". A kulcsot ilyenkor nem mentjük el.
- **Jelszócsere:** új só, új kulcs, azonnali újrafeltöltés. A többi eszköz a következő szinkronnál
  „Hibás szinkronjelszó" hibát kap, és újra bekéri a jelszót.

## 7. Szolgáltatók

### 7.1 Közös interfész (`src/lib/sync/provider.ts`)

```ts
interface RemoteFile { text: string; rev: string }
interface SyncProvider {
  readonly id: 'gdrive' | 'dropbox' | 'memory';
  readonly label: string;                         // „Google Drive"
  available(): boolean;                           // van-e beállított kliens-ID a buildben
  connect(): Promise<{ account: string }>;        // felhasználói gesztusból hívandó (popup/átirányítás)
  ensureToken(interactive: boolean): Promise<boolean>;
  read(): Promise<RemoteFile | null>;             // null = még nincs fájl
  write(text: string, prevRev: string | null): Promise<{ ok: true; rev: string } | { ok: false; conflict: true }>;
  disconnect(): Promise<void>;                    // token visszavonása + helyi adatok törlése
}
```

- A kapcsolat adatai (szolgáltató, fiók e-mail/név, tokenek, utolsó `rev`) a `meta.sync` kulcsba
  kerülnek, **eszközönként**. Nem részei a JSON-mentésnek.
- A `memory` szolgáltató (csak dev buildben, vagy `?syncProvider=memory` alatt tesztben) egy
  `localStorage` kulcsot használ. Ezzel két böngészőkontextus közötti e2e teszt futtatható valódi fiók nélkül.

### 7.2 Google Drive (elsődleges)

- **Bejelentkezés:** Google Identity Services, *token model*
  (`google.accounts.oauth2.initTokenClient`). A szkriptet (`https://accounts.google.com/gsi/client`)
  dinamikusan töltjük be az első csatlakozáskor. Popupot nyit, átirányítás nincs, így a hash-alapú
  útválasztás sem sérül.
- **Scope:** `https://www.googleapis.com/auth/drive.appdata` (csak az app saját, rejtett mappája),
  plusz `openid email` a fiók megjelenítéséhez. Az e-mail a `https://www.googleapis.com/oauth2/v3/userinfo`
  végpontról jön.
- **Token:** kb. 1 óráig él, böngészőben **nincs refresh token**.
  - A lejárat előtt csendes megújítás: `requestAccessToken({ prompt: '' })`. Ez felhasználói
    gesztusból megbízható: a PIN-feloldás gombnyomásakor indítjuk, **még az első `await` előtt**.
  - Ha nem sikerül (popupblokkoló, nincs gesztus), az állapotjelző ezt mutatja: „Szinkron szünetel –
    koppints a folytatáshoz". Egy koppintás megoldja. Adat nem vész el, a helyi módosítások megmaradnak.
- **REST hívások** (`fetch`, `Authorization: Bearer …`):
  - keresés: `GET https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name='ledger.sync.json'&fields=files(id,version,modifiedTime)`
  - letöltés: `GET https://www.googleapis.com/drive/v3/files/{id}?alt=media`
  - létrehozás: `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
    metadata `{ name: 'ledger.sync.json', parents: ['appDataFolder'] }`
  - frissítés: `PATCH https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=media`
  - `rev` = a fájl `version` mezője.
- **Ütközéskezelés:** a Drive v3 nem ad megbízható feltételes írást. A megoldás: írás előtt
  újra lekérjük a `version`-t. Ha az eltér a letöltéskoritól, `conflict`, és a motor újra lefut
  (legfeljebb 3-szor). A maradék kis versenyablakot a merge konvergenciája fedi le (*3.*).
- **Ha több fájl van** (két eszköz egyszerre hozott létre fájlt): mindet letöltjük, összefésüljük,
  a legrégebbit megtartjuk, a többit töröljük.
- **Kijelentkezés:** `google.accounts.oauth2.revoke(token)`, és a `meta.sync` + `meta.syncKey` törlése.
  A felhőben lévő fájl megmarad. Külön gomb: „Felhőben tárolt adatok törlése".

### 7.3 Dropbox (2. opció)

- **Bejelentkezés:** OAuth 2 **PKCE**, átirányítással, SDK nélkül:
  `https://www.dropbox.com/oauth2/authorize?client_id=…&response_type=code&code_challenge=…&code_challenge_method=S256&token_access_type=offline&redirect_uri=…&state=…`
  - A `redirect_uri` az app gyökér URL-je (pl. `https://<user>.github.io/<repo>/`). A kód
    **query-stringben** jön vissza (`?code=…&state=…`), ami nem ütközik a `#/…` útvonalakkal.
    Induláskor (`auth.init`) ezt feldolgozzuk, majd `history.replaceState`-tel eltüntetjük az URL-ből.
  - A `code_verifier`-t és a `state`-et a `sessionStorage` tárolja az átirányítás idejére.
  - Az átirányítás miatt az app újratölt, és újra PIN-t kér. Ezt elfogadjuk; a csatlakozás a feloldás után fejeződik be.
- **Token:** `POST https://api.dropboxapi.com/oauth2/token`, először
  `grant_type=authorization_code` (`code`, `code_verifier`, `client_id`, `redirect_uri`), később
  `grant_type=refresh_token`. **Van refresh token**, tehát nem kell újra bejelentkezni. A refresh
  tokent a `meta.sync` tárolja (ugyanazon a szinten védve, mint a helyi adatok).
- **App típusa:** *Scoped access → App folder*, jogosultságok: `files.content.read`,
  `files.content.write`, `account_info.read`.
- **REST hívások:**
  - letöltés: `POST https://content.dropboxapi.com/2/files/download`, fejléc
    `Dropbox-API-Arg: {"path":"/ledger.sync.json"}`; a `rev` a `Dropbox-API-Result` fejlécből
    jön. 409 `path/not_found` → `null`.
  - feltöltés: `POST https://content.dropboxapi.com/2/files/upload`,
    `Dropbox-API-Arg: {"path":"/ledger.sync.json","mode":{".tag":"update","update":"<rev>"},"mute":true}`
    (első írásnál `"mode":"add"`). **Ez valódi feltételes írás**: 409 `path/conflict` → `conflict`.
  - fiók: `POST https://api.dropboxapi.com/2/users/get_current_account`.
  - Figyelem: a `Dropbox-API-Arg` fejlécben a nem ASCII karaktereket `\uXXXX`-re kell escape-elni.
    A fájlnév ASCII, de legyen rá segédfüggvény.
- **Kijelentkezés:** `POST https://api.dropboxapi.com/2/auth/token/revoke`, majd a helyi kapcsolat törlése.

### 7.4 Konfiguráció a buildben

- `VITE_GOOGLE_CLIENT_ID`, `VITE_DROPBOX_APP_KEY` (`import.meta.env`). Ezek **nem titkok**
  (nyilvános kliens-azonosítók).
- A `.github/workflows/pages.yml` build lépése a repó *Variables* közül adja át őket
  (`${{ vars.GOOGLE_CLIENT_ID }}`, `${{ vars.DROPBOX_APP_KEY }}`).
- Ha valamelyik hiányzik, az a szolgáltató nem jelenik meg. Ha egyik sincs, a „Szinkronizálás"
  szekció egy rövid beállítási útmutatót mutat (README-link).

## 8. Szinkronmotor és UI

### 8.1 `src/lib/sync/engine.svelte.ts`

- Állapot (Svelte `$state`): `status: 'off' | 'idle' | 'syncing' | 'paused' | 'error'`,
  `lastSyncAt`, `error`, `account`, `provider`, `pendingLocalChanges` (van-e feltöltetlen módosítás).
- **Indítók:**
  - PIN-feloldás után (`auth.afterUnlock`),
  - `ledger.notify()` után 4 mp-es debounce-szal,
  - `visibilitychange` → látható, legfeljebb 30 mp-enként,
  - `online` esemény,
  - „Szinkron most" gomb,
  - az oldal elrejtésekor (`visibilitychange` → rejtett) egy utolsó, gyors feltöltés, ha van függő módosítás.
- **Kizárás:** egyszerre egy futás. Lapok között Web Locks API-val
  (`navigator.locks.request('koltsegvetes-sync', …)`), ha nem elérhető, lapon belüli mutexszel.
  Futás után a `BroadcastChannel` értesíti a többi lapot (a meglévő mechanizmussal).
- Zárolt állapotban (`phase !== 'unlocked'`) nem fut. Zároláskor a folyamatban lévő futás befejeződik,
  de az eredményt nem tölti be a memóriába.
- **Hibák:** hálózati hibánál exponenciális visszalépés (30 mp → 10 perc), 401 → `ensureToken`,
  ha az sem megy → `paused`. Validációs hibánál `error`, és nem írunk semmit.
- Siker után `auth.lastBackupAt` frissül, így a „régen volt mentés" figyelmeztetés nem jelenik meg,
  amíg a szinkron működik. (A beállítás szövegében ezt jelezni kell.)

### 8.2 UI

- **Beállítások → „Szinkronizálás"** szekció (`src/routes/settings/+page.svelte`, új komponens:
  `src/lib/components/SyncPanel.svelte`):
  - kikapcsolt állapotban: „Bejelentkezés Google-fiókkal" (elsődleges gomb), „Dropbox" (másodlagos gomb),
  - csatlakozás után: szinkronjelszó bekérése. Ha a felhőben még nincs fájl: „Új jelszó + megerősítés";
    ha van: „A másik eszközön megadott jelszó". Opcionálisan „Titkosítás nélkül" kapcsoló, figyelmeztetéssel.
  - bekapcsolt állapotban: fiók, utolsó szinkron ideje, „Szinkron most", „Szinkronjelszó cseréje",
    „Kijelentkezés", „Felhőben tárolt adatok törlése".
- **Állapotjelző** a `NavBar`-ban: kis ikon (felhő / forgó / felkiáltójel / szünet). Koppintásra a
  `paused` állapotban újra-hitelesít, egyébként a beállításokhoz visz.
- **Első indítás** (`SetupScreen.svelte`): a PIN beállítása után új választás: „Már használod
  másik eszközön? Csatlakozás Google-lel / Dropboxszal", az eddigi „üresen" / „példaadatokkal"
  gombok mellett.
- **Toastok** (`toast.svelte.ts`): a merge `report` alapján, csak ha érdemi változás történt
  („3 új tétel érkezett a másik eszközről"), és javítás/epoch-veszteség esetén.
- Minden szöveg magyarul, a meglévő stílusban.

## 9. Tesztelés

- **Egységtesztek (vitest):**
  - `tests/sync-ids.test.ts`: tartomány, `recurringTxId` determinisztikus.
  - `tests/sync-merge.test.ts` (**a legfontosabb**): egyoldali hozzáadás; két oldali szerkesztés
    (LWW, egyenlőség); törlés kontra szerkesztés mindkét sorrendben; jelölő-takarítás; `lastHandled`
    max; ugyanazon előfordulás kétoldali jóváhagyása → 1 tétel; hivatkozás-javítás (törölt kategória
    + új tétel rá); epoch-eltérés; `remapIds`; **tulajdonság-tesztek**: `merge(a,b)` ≡ `merge(b,a)`,
    `merge(a,a)` ≡ `a`, `merge(merge(a,b),c)` ≡ `merge(a,merge(b,c))` véletlen műveletsorokon (saját
    kis generátor, függőség nélkül).
  - `tests/sync-format.test.ts`: kódolás/visszafejtés, rossz jelszó, sérült fájl, titkosítatlan változat.
  - `tests/migration.test.ts` bővítése: DB v2 → v3, mentés v2 → v3.
  - `tests/ledger*.test.ts` bővítése: minden módosító metódus frissíti az `updatedAt`-et,
    a törlések jelölőt írnak, az új id-k a várt tartományban vannak, az alapadatok fix id-t kapnak.
  - `tests/sync-gdrive.test.ts`, `tests/sync-dropbox.test.ts`: `fetch` mockkal a kérések URL-je,
    fejlécei, a 401/409/404 kezelése, conflict → újrapróbálás.
  - `tests/sync-engine.test.ts`: `memory` szolgáltatóval, két `LedgerRepo` (két `fake-indexeddb`
    példány) között valós forgatókönyvek.
- **E2E** (`e2e/sync.mjs`, a meglévő `smoke.mjs` mintájára, Playwright): két böngészőkontextus,
  `memory` szolgáltató; A-n felvett tétel megjelenik B-n; B-n törölt tétel eltűnik A-n; offline
  módosítás, majd újracsatlakozás.
- Minden fázis végén: `npm run check`, `npm test`, `npm run build`, és ahol érintett, `npm run e2e`.

## 10. Fázisok (mindegyik külön commit, zöld tesztekkel)

| # | Tartalom | Kész, ha |
| --- | --- | --- |
| 1 | `ids.ts`, explicit id-k a repóban, fix id-s alapadatok, `recurringTxId` | minden meglévő teszt zöld, új id-tesztek zöldek |
| 2 | `updatedAt` minden típuson, DB v3 és mentés v3 migráció | migrációs tesztek zöldek, régi v1/v2 mentés betölthető |
| 3 | törlési jelölők, epoch | ledger-tesztek igazolják a jelölőket és az epoch-váltást |
| 4 | `merge.ts` + tulajdonság-tesztek | *9.* merge-tesztjei zöldek |
| 5 | `format.ts`, kulcsos titkosítás | formátumtesztek zöldek |
| 6 | `provider.ts`, `memory` szolgáltató, `engine.svelte.ts` | motor-tesztek + e2e két kontextussal zöld |
| 7 | UI: `SyncPanel`, NavBar-jelző, SetupScreen-bővítés | kézzel és e2e-ben végigkattintható a `memory` szolgáltatóval |
| 8 | `gdrive.ts` + GIS lusta betöltés | mock-tesztek zöldek; valós próba a felhasználó kliens-ID-jével (lásd *12.*) |
| 9 | `dropbox.ts` (PKCE, átirányítás-kezelés) | mock-tesztek zöldek; valós próba |
| 10 | README („Szinkronizálás" fejezet, beállítási útmutató, korlátok), `pages.yml` változók | a README adat-táblázata („Nincs szinkron eszközök között") frissítve |

Az 1–7. fázis valódi fiók nélkül elkészíthető és tesztelhető. A 8–9. fázis valós kipróbálásához
a felhasználó kliens-azonosítói kellenek.

## 11. Indító prompt az új sessionhöz

> Olvasd el a `docs/SYNC_PLAN.md`-t, és valósítsd meg fázisonként, a 10. pont táblázata szerint.
> Minden fázis után futtasd az `npm run check`, `npm test` és `npm run build` parancsokat,
> és csak zöld állapotot commitolj, fázisonként külön commitban, a `claude/sync` ágon.
> A meglévő kódstílust és magyar kommenteket kövesd. Ha a terv és a kód ellentmond egymásnak,
> a kódot vizsgáld meg, döntsd el, melyik a helyes, és a döntést írd be a terv „Eltérések"
> szakaszába. A 8–9. fázisnál a valós kipróbáláshoz kérd el tőlem a Google kliens-ID-t és a Dropbox app key-t.

## 12. Amit a felhasználónak kézzel kell beállítania (egyszer)

### Google (kb. 10 perc)
1. <https://console.cloud.google.com/> → új projekt (pl. „Költségvetés").
2. *APIs & Services → Library* → **Google Drive API** engedélyezése.
3. *OAuth consent screen* (Google Auth Platform): *External*, alkalmazásnév, e-mail. Scope: `drive.appdata`,
   `openid`, `email`. Amíg az app *Testing* állapotú, **add hozzá a saját Google-fiókodat tesztfelhasználóként**.
   Hogy a `drive.appdata` scope-hoz kell-e Google-ellenőrzés az éles (*In production*) állapothoz,
   azt a konzol a scope hozzáadásakor jelzi. Saját használatra a *Testing* állapot is elég.
4. *Credentials → Create credentials → OAuth client ID → Web application*.
   *Authorized JavaScript origins*: `https://<felhasználó>.github.io` (és fejlesztéshez `http://localhost:5173`).
5. A kapott **Client ID**-t add meg a repóban: *Settings → Secrets and variables → Actions →
   Variables* → `GOOGLE_CLIENT_ID`.

### Dropbox (kb. 5 perc)
1. <https://www.dropbox.com/developers/apps> → *Create app* → *Scoped access* → *App folder* → név.
2. *Permissions*: `files.content.read`, `files.content.write`, `account_info.read` → *Submit*.
3. *Settings → OAuth 2 → Redirect URIs*: `https://<felhasználó>.github.io/<repo-neve>/`
   (és `http://localhost:5173/`). *Allow public clients (Implicit Grant & PKCE)*: engedélyezve.
4. Az **App key**-t add meg a repóban: *Variables* → `DROPBOX_APP_KEY`.
   (Fejlesztői állapotban az app 50 felhasználóig használható, ez saját célra bőven elég.)

## Eltérések

*(Az implementáló session ide írja, ha a tervtől el kellett térni, és miért.)*

Az alábbi pontokban a megvalósítás eltér a tervtől, vagy kiegészíti azt. Mindegyiket a kód megvizsgálása
után döntöttem el; a tervezett viselkedés (ütközésmentes id-k, LWW, jelölők) ezekkel együtt is teljesül.

### 1–3. fázis

- **Sorrend az id helyett `createdAt` szerint.** A terv nem számolt azzal, hogy az autoIncrement `id` eddig
  egyben létrehozási sorrend is volt. `compareTx` (legújabb elöl), az ismert leírások „legutóbbi" választása,
  a „legnagyobb tételek" döntetlenfeloldása és a `LedgerRepo.loadAll` rendezése az `id` helyett
  `(createdAt, id)` szerint megy. Ezért a memória sorrendje betöltés után ugyanaz, mint korábban.
- **`sync/stamp.ts`: szigorúan növekvő időbélyeg.** Egy millisecundumon belüli két módosítás korábban
  ugyanazt a `Date.now()` értéket kapta, amit az `id` döntött el. Most a `createdAt`/`updatedAt` a főkönyvben
  mindig szigorúan nő (a példaadatoké és a tömeges műveleteké is). A merge LWW-szabályának is ez kell.
- **`add`/`addMany` a repóban hívja a `newId()`-t** (nem a `ledger.svelte.ts` minden hívási helyén), így nem
  maradhat ki egy hívási hely. Ütközésnél (ConstraintError) új id-val újrapróbál.
- **`applyRecurring`**: az id-t (`recurringTxId`, Web Crypto) a tranzakció megnyitása előtt számolja ki,
  különben az IndexedDB-tranzakció a `await` alatt lezárulna. A tételt `put`-tal írja (idempotens).
- **A visszavonások is új `updatedAt`-et adnak** (`restoreTx`, `restoreTxs`, `replaceTxs`), nem csak a
  visszaállítás: különben egy, már szinkronizált módosítás visszavonása elveszne az összefésülésnél.
- **Törlési jelző ideje** = `max(stamp(), a törölt sor updatedAt + 1)`. Így a törlés az általa törölt
  változatot óra-eltérés esetén is legyőzi. Nem létező sor törlése nem ír jelölőt.
- **`replaceAll` alapból új korszakot indít** (és törli a jelölőket), ezért a `switchCurrency` és az
  `importBackup` nem kellett külön módosítani. A szinkron a saját korszakát és az összefésült jelölőket egy
  negyedik paraméterben adja át. A példaadatok betöltése/törlése a `startEpoch()`-ot hívja.
- **`wipeAll` nem indít új korszakot**, mert a teljes törlés a `meta` tárolót is üríti, vagyis a szinkron-
  kapcsolatot (`meta.sync`) is. Az eszköz lecsatlakozik; a korszak az újracsatlakozáskor jön létre
  (`ensureEpoch`), a *4.5* szabályai szerint. A felhőbeli fájlt a törlés nem érinti.
- **Ismert, korábbról meglévő hiba:** az `e2e/features.mjs` „természetes nyelvű gyorsbevitel: kávé 891 tegnap"
  lépése a `main`-en, a szinkron-változtatások nélkül is elbukik. Nem ehhez a munkához tartozik.

### 4. fázis (`merge.ts`)

- **Az asszociativitás a rekordszintű részre igaz, egy ismert kivétellel.** A `merge(merge(a,b),c) ≡
  merge(a,merge(b,c))` tulajdonságot a véletlen műveletsoros teszt a hivatkozás-javítás nélküli összefésülésre
  (`mergeStates(..., { repair: false })`) ellenőrzi. Kivétel: ha egy köztes összefésülés egy ismétlődő szabályt
  a törlési jelölő miatt eldob, majd a szabályt később újraszerkesztik, az eldobott `lastHandled` elveszhet.
  Következménye legfeljebb egy újra felkínált előfordulás, amit a determinisztikus tétel-azonosító
  (`recurringTxId`) miatt nem lehet megduplázni. A hivatkozás-javítás (visszaélesztés) eleve nem asszociatív,
  mert attól függ, hogy a hivatkozó tétel az összefésülés pillanatában él-e.
- **Konvergencia felhő-közvetített szinkronnál** (`merge(felhő, helyi)`, majd mindkettő az eredmény): a teszt
  4000 véletlen magon futott, mindig megállt. Ritkán (1/4000) három elcsendesedési kör kell két helyett, ha egy
  visszaélesztett kategória jelölőjét egy elmaradt eszköz még tartalmazza. Végtelen körforgás nem alakul ki.
- **`report` kibővítve**: `transactions` (a tételek külön számlálója az értesítésekhez) és `epochWinner`
  (eltérő korszaknál melyik oldal nyert). Az `epochLost` az `opts.syncedAt` (az utolsó sikeres szinkron ideje)
  óta módosított helyi rekordok, jelölők és a beállítás száma.
- **`remapIds` kiegészítés:** opcionális `match` (a másik oldal adatai). Egy átszámozandó régi számla vagy
  kategória, ha típus és név szerint egyezik egy ottanival, annak az azonosítóját kapja (elsőként az azonos
  id + név). Így a két oldal alapelemeiből (pl. „Étel") nem lesz duplikátum. Egy távoli azonosítóra legfeljebb
  egy helyi elem képződik.
- **`hasOwnData`** (a *4.5* 2. pontjához): a saját tétel, a szerkesztett vagy létrehozott elem, az ismétlődő,
  sablon, cél, mentett szűrő és a beállított keret is „saját adat". Az érintetlen alapelemek (`updatedAt` = 0)
  és a példaadatok nem. Óvatos: gyanús esetben a felhasználó dönt.
- **`validateState`** a `makeBackup` + `parseBackup` láncot futtatja, és csak `ok`/hibaüzenetet ad vissza.

### 5. fázis (`format.ts`, kulcsos titkosítás)

- **`setMetaRaw` a repóban.** A `setMeta` JSON-kerülőt használ, ami a `CryptoKey`-t `{}`-vá tenné. A
  szinkronkulcsot (`meta.syncKey`) ezért a nyers, structured clone-os `setMetaRaw` írja; a `getMeta` változatlan.
- **`peekSyncFile`**: a fejléc vizsgálata visszafejtés nélkül. Csatlakozáskor kell, mert a kulcshoz a fájl
  sója és iterációszáma szükséges, még mielőtt a jelszóból kulcs lenne.
- **A beérkező állapot ellenőrzése a formátumrétegben történik** (`parseSyncPayload`): a `parseBackup`
  ellenőrzi és normalizálja az adatokat, a törlési jelölők közül az ismeretlen tárolóra vagy hibás időre
  vonatkozókat eldobja. Így a motor (6. fázis) már csak érvényes `SyncState`-et kap.
- **A hibakódok** (`invalid`, `unsupported`, `needsPassword`, `wrongPassword`, `badState`) a felületnek szólnak.
  Jelszócsere után a régi kulcs sója eltér a fájlétól, ezért azonnal „Hibás szinkronjelszó" a válasz, a
  visszafejtési kísérlet nélkül.
- Az iterációszám felső korlátja (5 000 000) a `crypto.ts`-ben közös konstans lett (`MAX_KDF_ITERATIONS`).

### 6. fázis (`provider.ts`, `memory.ts`, `core.ts`, `engine.svelte.ts`)

- **Két réteg: `core.ts` és `engine.svelte.ts`.** Egyetlen szinkronfutás (`syncOnce`: letöltés → összefésülés →
  validálás → helyi csere → feltöltés) a Svelte- és időzítés-mentes `core.ts`-ben van, így két `LedgerRepo`
  között is tesztelhető. A motor (`SyncEngine`) az ütemezést, a zárat, az állapotot és a csatlakozást adja.
  A motor nem importálja az `auth`-ot és a `ledger`-t (import-ciklus lenne): az `auth.init` köti be a
  `SyncHost` felületen át (`repo`, `reload`, `unlocked`, `onSynced`, `onEvent`), és a `ledger.onChange` horoggal.
- **A helyi csere védett** (`LedgerRepo.replaceAllGuarded`): ugyanabban az IndexedDB-tranzakcióban ellenőrzi, hogy
  a helyi adat még az, amiből az összefésülés készült. A terv ezt nem mondta ki, de enélkül a szinkron
  hálózati ideje alatt (másodpercek) végzett szerkesztés elveszne. Eltérés esetén a futás újrakezdődik
  (legfeljebb háromszor, a felhő-`conflict`-tal közös számlálóval).
- **`SyncProvider.removeFile()`** új metódus a „Felhőben tárolt adatok törlése" gombhoz (a terv felületén nem
  szerepelt). A tokenek tárolására `ProviderStorage` került, amit a motor a `meta.sync.tokens` mezőre képez le.
- **Az `epoch`-vesztés mentése tartós:** eltérő korszaknál a helyi oldal felülírása előtt a helyi adatok JSON-
  mentése a `meta.lostBackup` alá kerül (és a `sync.lostBackup` állapotba), amíg a felhasználó le nem tölti
  vagy el nem veti. A terv „felajánljuk, hogy előtte letölti" szövegét így oldottam meg: háttérszinkron
  közben nem ugorhat fel modális ablak, és az automatikus letöltést a böngésző blokkolhatja.
- **Első csatlakozás** (`applyFirstConnect`): az átvétel/összefésülés a helyi adatra történik (védetten), a
  feltöltést a rákövetkező `syncOnce` végzi el. A `completeConnect` rossz jelszónál semmit nem ment el.
- **`writeKey` a `syncOnce`-ban:** jelszócserénél a letöltött fájlt még a régi kulccsal nyitjuk, és az újjal írjuk.
- **A szinkron órája `stamp()`** (nem `Date.now()`): az utolsó szinkron ideje így pontosan elválasztja a
  korábbi és a későbbi módosításokat (az `epochLost` számolásához).
- **Időzítők injektálhatók** (`Timers`), hogy az ütemezés (debounce, visszalépés) kézzel léptethető órával
  tesztelhető legyen; a fake-indexeddb saját időzítőit így nem zavarja semmi.
- **Memória-szolgáltató:** a terv `localStorage`-t ír. Az két elszigetelt böngészőkontextus (két „eszköz") között
  nem közös, ezért a `MemoryBackend` cserélhető: alapból `localStorage`, de az e2e-teszt a
  `window.__syncMemoryBackend` horgonyon át Node-oldali, közös tárat köt be.
- **Az e2e (`e2e/sync.mjs`) a 7. fázisban készül**, mert a csatlakozás végigkattintásához a felület kell.

### 7. fázis (felület, `e2e/sync.mjs`)

- **Az állapotjelző (`SyncBadge`) a `NavBar` mellett, rögzített helyen** van (telefonon jobb felül, oldalsávos
  elrendezésnél a márkanév mellett), nem az alsó sáv egyik elemeként: az alsó sávban öt hely van, és a szinkron
  csak akkor jelenik meg, ha be van kapcsolva. Ikonok: felhő (szinkronban / feltöltésre vár / nincs kapcsolat),
  forgó nyilak, felkiáltójel, szünet. Kapcsolat nélkül nem hibajelzés, hanem „nincs kapcsolat" (az app offline-first).
  Szüneteléskor koppintásra újra-hitelesít, egyébként a Beállításokhoz visz.
- **Első indítás (`SetupScreen`):** a „Már használod másik eszközön?" gombok a PIN-ellenőrzés után előbb a
  bejelentkezést indítják (a felugró ablak csak a gombnyomás gesztusából nyílhat), majd beállítják a PIN-t, és
  a Beállítások szinkron-szekciójába visznek, ahol a szinkronjelszó megadásával fejeződik be a csatlakozás.
  A motor `probe` állapota tartja meg a félbehagyott csatlakozást.
- **Toastok (`sync/notify.ts`):** a `report` alapján, csak érdemi változásnál („3 új tétel érkezett a másik
  eszközről"), hivatkozás-javításnál és korszak-veszteségnél; az utóbbin „Mentés letöltése" gomb.
- **Az e2e hash-navigációja:** a `location.hash = …` a SvelteKit hash-routerében (lekérdezőszöveggel az URL-ben)
  teljes újratöltést okoz, és az app zárolna. Az e2e ezért linkkattintást szimulál, ahogy a felhasználó navigál.
- **A `start()` már utólag is bekötheti a figyelőket** (láthatóság, `online`): a kapcsolat a feloldás után jön
  létre, így a figyelőket nem lehetett a `start()`-ban egyszer, feltétel nélkül bekötni. Az e2e találta meg.
- A `?syncProvider=memory` az URL lekérdezőszövegében marad meg, a hash-router nem bántja.

### 8–9. fázis (`gdrive.ts`, `dropbox.ts`)

- **Valós kipróbálás nem történt.** A két szolgáltató a hamis `fetch`-csel és hamis GIS-szel írt mock-tesztekkel
  (URL-ek, fejlécek, 401/403/404/409/429/5xx, conflict → újrapróbálás) van lefedve. A Google kliens-azonosító és a
  Dropbox app key nélkül a tényleges bejelentkezés nem próbálható ki; az útmutató a *12.* pontban van.
- **Több felhőfájl (Drive):** a `RemoteFile` új, opcionális `extra` mezője a további példányokat adja, a
  `SyncProvider.discardCopy(ref)` törli őket. A `syncOnce` az azonos kulccsal olvasható példányokat a legrégebbi
  fájlba fésüli, feltölt, és csak utána törli a többletet. Amit nem tud beolvasni (pl. más jelszó), azt nem
  törli. A terv szerint ez a szolgáltatón belül dőlt volna el, de az összefésüléshez a kulcs és a `mergeStates`
  kell, ezért a mag végzi. A keresés a `createdTime` mezőt is kéri, ebből következik a „legrégebbi".
- **`ensureToken` kivételt dobhat** (`SyncNetworkError`): a Dropbox tokenfrissítése és a GIS-szkript betöltése
  hálózat nélkül nem „szünetel", hanem „nincs kapcsolat". A motor ezt hálózati hibaként kezeli (visszalépés).
- **Google-bejelentkezés:** az első `requestAccessToken` `prompt` nélkül fut (a GIS dönt a fiókválasztóról), a
  megújítás `prompt: ''`-vel. A hozzáférési token (lejárattal és e-mail címmel) a `meta.sync.tokens` alatt él,
  hogy egy órán belüli újraindításnál ne kelljen új ablak. Csendes megújítást időtúllépés zár le (15 mp).
- **Dropbox átirányítás:** `consumeDropboxRedirect` az indulásnál (`sync.attach`) cseréli a kódot tokenre és
  tisztítja az URL-t, a token a feloldásig `sessionStorage`-ban vár; a `SyncProvider.resume()` és a
  `SyncEngine.resumeConnect()` (az `+layout.svelte` hívja feloldás után) zárja le a csatlakozást a jelszó-lépésnél.
  Ha a Dropboxot az első indításról indítják, a PIN-t az átirányítás után újra be kell állítani, mert az app
  újratölt; a token ezt kivárja. A hibák (megtagadott hozzáférés, nem egyező `state`) is a felhasználóhoz jutnak.
- Az `available()` mindkét szolgáltatónál a build `VITE_*` változójától függ; nélküle a szolgáltató nem jelenik
  meg, és a felület a beállítási útmutatót mutatja.

### 10. fázis (README, `pages.yml`)

- A README új „Szinkronizálás" fejezete a működést, a bekapcsolást, a Google/Dropbox beállítás lépéseit, a
  korlátokat (Google-token lejárat, `Goal.saved` LWW, 180 napos jelölők, korszakváltás, jelszócsere) és a
  memória-szolgáltatós kipróbálást tartalmazza. Az adat-táblázat „Nincs szinkron eszközök között" sora és a „Még
  nem szerepel" lista frissült; a séma- és mentésverzió-szakasz az új azonosító- és rendezési szabályt is leírja.
- A `pages.yml` build lépése a repó `GOOGLE_CLIENT_ID` és `DROPBOX_APP_KEY` *Variables* értékét adja át
  `VITE_GOOGLE_CLIENT_ID` és `VITE_DROPBOX_APP_KEY` néven. A repóban új a `.env.example` helyi fejlesztéshez.

### Állapot

| Fázis | Állapot |
| --- | --- |
| 1–7 | kész, valódi fiók nélkül tesztelve (egységtesztek, tulajdonság-tesztek, motor-tesztek, `e2e/sync.mjs`) |
| 8–9 | kész, mock-tesztekkel; **a valós próbához a felhasználó Google kliens-azonosítója és Dropbox app key-e kell** |
| 10 | kész |
