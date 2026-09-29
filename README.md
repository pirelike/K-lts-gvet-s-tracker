# Költségvetés-követő

Személyes, egyfelhasználós költségvetés-követő. Minden bevételt és kiadást **kézzel viszel fel**, és nem csak az összeget látod, hanem azt is, **mire** ment el a pénz (szabad szöveges leírás), visszakereshetően.

**Teljesen offline és szerver nélküli:** nincs backend, nincs fiók, nincs bankintegráció. Az app statikus fájlokból áll, az adataid **kizárólag ezen az eszközön, a böngészőben** (IndexedDB) tárolódnak. Első betöltés után internet nélkül is fut (service worker), telefonra telepíthető (PWA). Az első indításkor **te állítod be a saját PIN-kódodat**, ami helyben, hash-elve tárolódik.

- Magyar felület, HUF (egész számok, ezres tagolás)
- Mobil-first, reszponzív, sötét mód a rendszerbeállítás szerint
- Visszafogott animációk (nyomásra összehúzódó gombok, csúszó választók, oldal- és hónapváltás View Transitionnel); csökkentett mozgás beállításnál kikapcsolnak
- Függőségmentes futásidő: a build kimenete csak HTML/JS/CSS

## Gyors indulás

Szükséges: Node.js 22.12+.

```bash
npm install
npm run dev          # fejlesztői szerver: http://localhost:5173
```

Éles build kipróbálása (statikus fájlok a `build/` mappában):

```bash
npm run build
npm run preview      # http://localhost:4173
```

Első megnyitáskor a köszöntő képernyőn beállítod a PIN-t (4–8 számjegy), és választhatsz: üresen indulsz, vagy **példaadatokkal** (az elmúlt 2–3 hónap kitalált tételei). A példaadatok a Beállításokban egy gombbal törölhetők, a saját tételeid megmaradnak.

> **HTTPS vagy localhost kell.** A PIN-hash-eléshez használt Web Crypto, a service worker (offline mód) és a telepíthetőség csak biztonságos környezetben működik. `http://192.168.x.x` címen a böngésző ezeket letiltja, az app ilyenkor ezt ki is írja. Telefonos kipróbáláshoz használj HTTPS-t (lásd lent).

## Telepítés telefonra / üzemeltetés

Mivel nincs szerveroldali kód, az `build/` mappa **bármilyen statikus tárhelyre** feltölthető, de HTTPS-en kell kiszolgálni:

- GitHub Pages, Netlify, Cloudflare Pages, saját szerver (Caddy / nginx + HTTPS)
- **Ingyenes hosting:** a GitHub Pages (publikus repónál ingyenes), a Netlify, a Cloudflare Pages és a Vercel ingyenes csomagja is bőven elég egy statikus, néhány száz kB-os apphoz.
- **Automatikus kiadás GitHub Pages-re:** a `.github/workflows/pages.yml` a főágra (`main`/`master`) érkező minden push után lefuttatja a típusellenőrzést és a teszteket, buildel, és kiadja az appot. Egyszeri beállítás: a repóban *Settings → Pages → Source: GitHub Actions*. A cím: `https://<felhasználó>.github.io/<repo-neve>/`.
- Az útválasztás hash-alapú (`/#/tetelek`), ezért **nem kell** szerveroldali átirányítás (SPA fallback).
- Ha almappából szolgálod ki (pl. GitHub Pages: `https://user.github.io/repo/`), build előtt add meg: `BASE_PATH=/repo npm run build`.
- Telefonon a böngésző menüjéből: „Hozzáadás a főképernyőhöz" / „Alkalmazás telepítése".
- Új verzió kiadásakor az app a háttérben letölti a frissítést, és „Új verzió érhető el – Frissítés" értesítést mutat.

## Adatok és biztonság

| Mi | Hogyan |
| --- | --- |
| Hol vannak az adatok? | Böngésző IndexedDB, csak az adott eszközön/böngészőprofilban. Nincs szinkron eszközök között. |
| Biztonsági mentés | Beállítások → *Mentés letöltése (JSON)*. Visszatöltés: *Mentés visszatöltése…* (ellenőrzi a fájlt, felülírja a mostani adatokat). A főoldal figyelmeztet, ha régen volt mentés. |
| Tartós tárhely | Az app kéri a böngészőtől (`storage.persist()`), hogy tárhelyhiány esetén se törölje az adatokat; a Beállításokban látszik az eredmény. |
| PIN | Sózott PBKDF2-SHA256 hash (210 000 iteráció), a PIN maga nem tárolódik. 5 hibás próba után növekvő várakozás (30 mp … 15 perc). Automatikus zárolás állítható (azonnal … 30 perc / soha). |
| Elfelejtett PIN | Nincs visszaállítás az adatok megtartásával, csak *minden adat törlése* után induló újrakezdés (majd JSON-mentés visszatöltése). |

**Fontos korlát:** a PIN *alkalmazászár* a véletlen belenézés ellen, **nem titkosítás**. Az adatok a böngészőprofilban titkosítatlanul vannak, és mivel minden kliensoldali, egy technikailag jártas támadó a böngészőeszközökkel megkerülheti. Az eszköz zárolása és a böngészőprofil védelme továbbra is szükséges. A böngészőadatok törlése az összes adatot elviszi, ezért érdemes időnként JSON-mentést készíteni.

## Funkciók (MVP)

1. **Gyors felvitel**: összeg, típus (kiadás / bevétel / átvezetés), dátum (alapból ma), kategória, leírás, számla, címkék, megjegyzés.
   - Összegmező kifejezéssel: `1200+850`, `2*450`, `12k` / `3e` (= ezer), `1,5k`, `12 000`; élő előnézettel és gyorsbillentő gombokkal (`+ − × k`).
   - Leírás-autocomplete a korábbi tételekből (nyilakkal és Enterrel is választható); választáskor a kategória, számla és összeg is kitöltődik.
   - Kategóriajavaslat a leírás alapján (pl. korábban „Lidl" → Étel), okos alapértelmezések (utolsónak használt számla és kategória).
   - Mentés és új tétel, másolás (csak az összeg/dátum módosul), törlés utáni **Visszavonás** (7 mp, fogyó sávval; érintés vagy egérmutató alatt az idő megáll).
   - Mentetlen változtatásnál (Mégse, vissza gomb, menü) az app rákérdez, mielőtt eldobná.
2. **Tranzakciólista**: napok szerint csoportosítva, napi részösszeggel, havi lapozással; szerkeszthető és törölhető.
3. **Havi összesítő** a főoldalon: bevétel, kiadás, egyenleg, kiadások/bevételek kategóriánkénti bontása (százalék + sáv), az összes számla egyenlege, utolsó 5 tétel.
4. **Keresés és szűrés**: élő keresés a leírásban és megjegyzésben (ékezet- és kisbetű-független, „kave" megtalálja a „Kávé"-t, több szó ÉS kapcsolattal), típus, kategória, számla, címke, dátum-időszak, összeghatár. A találatok összegével („23 tétel −19 600 Ft"). Az aktív szűrők chipként látszanak a lista felett, egyenként ×-szel törölhetők. Keresés/szűrés közben az időszak automatikusan „Összes"-re vált, kézzel visszakapcsolható „Hónap"-ra.
5. **Kategóriakezelés**: létrehozás, átnevezés, ikon és szín, archiválás.
6. **Számlák és egyenleg**: számlánkénti aktuális egyenleg (kezdőegyenleg + bevételek − kiadások ± átvezetések), **átvezetés** számlák között.
7. **Beállítások**: PIN módosítása, automatikus zárolás, JSON-mentés/visszatöltés, példaadatok betöltése/törlése, minden adat törlése.

Az előre létrehozott alap kategóriák szerkeszthetők: *Étel, Közlekedés, Lakhatás/kollégium, Tanulás, Szórakozás, Ruházat, Egészség, Előfizetések, Egyéb*; bevétel: *Ösztöndíj, Fizetés/munka, Családtól, Egyéb*. Alap számlák: *Készpénz, Bankkártya, Megtakarítás*.

### Üzleti szabályok (tesztelve)

- Az összeg mindig pozitív egész, az előjelet a típus adja.
- Kiadásnál a leírás kötelező, bevételnél ajánlott.
- Az **átvezetés** nem számít bevételnek/kiadásnak a statisztikákban, de mozgatja a számlaegyenlegeket; a két számla nem lehet ugyanaz.
- **Kategória/számla csak akkor törölhető, ha nincs hozzá tétel**, különben archiválható. A törlés kétlépéses, a tételé nem (ott a visszavonás van).
- Archivált kategória/számla új tételhez nem választható, a régi tételeken és a szűrőkben megmarad.
- A dátum bármikor visszamenőleg módosítható.

### Szándékosan még nem szerepel (következő lépcső, jóváhagyásra vár)

Havi keretek és progress bar, grafikonok, ismétlődő tételek, „mire költöttem a legtöbbet" elemzés, CSV export/import, természetes nyelvű gyorsbevitel (`kávé 890 tegnap`), billentyűparancsok, sablonok, naptárnézet, csoportos műveletek, pénznemváltás, mentett szűrők, előrejelzés, emlékeztető-értesítések. (A `monthly_budget` mező már része az adatmodellnek, felület még nincs hozzá.)

## Felépítés

```
src/
  app.html, app.css              alap HTML, design-tokenek, sötét mód
  service-worker.ts              offline gyorsítótár (előtöltött app-héj)
  lib/
    money.ts                     összegkifejezés-értékelő, HUF formázás
    dates.ts, text.ts            dátumok (YYYY-MM-DD), ékezetmentes normalizálás
    validation.ts                űrlap-validáció (tiszta függvények)
    queries.ts                   szűrés, összesítők, egyenlegek, autocomplete – tiszta függvények
    types.ts                     adatmodell
    db/
      idb.ts, repo.ts            IndexedDB burkoló és CRUD (tesztelhető Node alatt is)
      pin.ts                     PIN hash / ellenőrzés / próbálkozás-korlát
      backup.ts, defaults.ts, demo.ts   JSON-mentés (szigorú ellenőrzéssel), alap adatok, példaadatok
    ledger.svelte.ts             memóriabeli főkönyv (Svelte állapot) + üzleti szabályok
    auth.svelte.ts               indítás, PIN-beállítás, zárolás
    route.svelte.ts              hash-útvonal és paraméterek olvasása
    components/                  űrlapok, navigáció, toast, PIN-képernyők …
  routes/                        / · new · transactions · transactions/[id] · categories · accounts · settings
static/                          manifest, ikonok, favicon
tests/                           Vitest egység- és integrációs tesztek
e2e/smoke.mjs                    végponttól végpontig böngészős ellenőrzés (Playwright)
scripts/make-icons.mjs           PNG ikonok újragenerálása (npm run icons, Playwright kell hozzá)
```

**Stack:** SvelteKit (Svelte 5, TypeScript) statikus SPA-ként (`adapter-static`, hash-router), IndexedDB tárolással, kézzel írt CSS-sel. Futásidejű függőség nincs. Egy személyes költségvetés (évi pár ezer tétel) mellett a szűrés/összesítés memóriában, JS-ben történik, ami gyors és egyszerű.

## Tesztek

```bash
npm test             # 72 egység- és integrációs teszt (Vitest, fake-indexeddb)
npm run check        # svelte-check / TypeScript
```

A tesztek lefedik az összegkifejezéseket, dátumokat, validációt, szűrést/összesítést, számlaegyenlegeket (átvezetéssel), az IndexedDB-réteget, a mentés export→import kört és a hibás mentések elutasítását, a PIN-t, a példaadatokat és az üzleti szabályokat (pl. használt kategória nem törölhető).

Böngészős végigpróbálás az éles buildre (PIN-beállítás, felvitel, autocomplete, keresés, szerkesztés, törlés+visszavonás, átvezetés, kategória-szabályok, mentés, zárolás, **offline újraindítás**):

```bash
npm run build
python3 -m http.server 4173 --directory build &
npm install --no-save playwright   # egyszer; Chromium is kell
BASE_URL=http://localhost:4173/ npm run e2e
```

## Ismert megjegyzések

- Ha a címsorban kézzel átírod a `#/…` részt, a SvelteKit hash-routere teljes újratöltést csinál, így az app újra PIN-t kér. A linkek, a vissza gomb és a telepített app normálisan működnek.
- iOS Safarin a nem telepített oldal adatait a böngésző hosszabb használaton kívüliség után törölheti; a főképernyőre telepített változat és a rendszeres JSON-mentés védi ezt ki.
- A PWA-ikonok a `static/icons/` alatt vannak (`npm run icons` újragenerálja).
