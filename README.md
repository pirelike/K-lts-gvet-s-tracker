# Költségvetés-követő

Személyes, egyfelhasználós költségvetés-követő. Minden bevételt és kiadást **kézzel viszel fel**, és nem csak az összeget látod, hanem azt is, **mire** ment el a pénz (szabad szöveges leírás), visszakereshetően.

**Teljesen offline és szerver nélküli:** nincs backend, nincs fiók, nincs bankintegráció. Az app statikus fájlokból áll, az adataid alapból **kizárólag ezen az eszközön, a böngészőben** (IndexedDB) tárolódnak; ha kéred, a **saját Google Drive-odon vagy Dropboxodon, titkosítva** eljutnak a többi eszközödre is (lásd *Szinkronizálás*). Első betöltés után internet nélkül is fut (service worker), telefonra telepíthető (PWA). Az első indításkor **te állítod be a saját PIN-kódodat**, ami helyben, hash-elve tárolódik.

- Magyar felület; alapból HUF (egész számok, ezres tagolás), átváltható más pénznemre (EUR, USD …)
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
- **Automatikus kiadás GitHub Pages-re:** a `.github/workflows/pages.yml` a főágra (`main`/`master`) érkező minden push után lefuttatja a típusellenőrzést és a teszteket, buildel, és kiadja az appot. Egyszeri beállítás: a repóban *Settings → Pages → Source: **GitHub Actions*** (ne a „Deploy from a branch"): utóbbi esetén a Pages az app helyett csak a README-t jeleníti meg. A cím: `https://<felhasználó>.github.io/<repo-neve>/`.
- Az útválasztás hash-alapú (`/#/tetelek`), ezért **nem kell** szerveroldali átirányítás (SPA fallback).
- Ha almappából szolgálod ki (pl. GitHub Pages: `https://user.github.io/repo/`), build előtt add meg: `BASE_PATH=/repo npm run build`.
- Telefonon a böngésző menüjéből: „Hozzáadás a főképernyőhöz" / „Alkalmazás telepítése".
- Új verzió kiadásakor az app a háttérben letölti a frissítést, és „Új verzió érhető el – Frissítés" értesítést mutat.

## Adatok és biztonság

| Mi | Hogyan |
| --- | --- |
| Hol vannak az adatok? | Böngésző IndexedDB, alapból csak az adott eszközön/böngészőprofilban. Opcionálisan a saját Google Drive / Dropbox tárhelyed egyetlen, **titkosított** fájlján keresztül szinkronban tarthatók több eszköz között (lásd *Szinkronizálás*). Saját szerver nincs. |
| Biztonsági mentés | Beállítások → *Mentés letöltése (JSON)*, *Mentés küldése…* (telefonon a megosztó lap: Drive, e-mail …) vagy *Jelszóval védett mentés…* (AES-256-GCM, a kulcs a jelszóból PBKDF2-vel készül; elfelejtett jelszóval a fájl nem nyitható meg). Visszatöltés: *Mentés visszatöltése…* (ellenőrzi a fájlt, felülírja a mostani adatokat; a régebbi verziójú mentések is betölthetők). A főoldal figyelmeztet, ha régen volt mentés. |
| Tartós tárhely | Az app kéri a böngészőtől (`storage.persist()`), hogy tárhelyhiány esetén se törölje az adatokat; a Beállításokban látszik az eredmény. |
| PIN | Sózott PBKDF2-SHA256 hash (210 000 iteráció), a PIN maga nem tárolódik. 5 hibás próba után növekvő várakozás (30 mp … 15 perc). Automatikus zárolás állítható (azonnal … 30 perc / soha). |
| Elfelejtett PIN | Nincs visszaállítás az adatok megtartásával, csak *minden adat törlése* után induló újrakezdés (majd JSON-mentés visszatöltése). |

Szinkron bekapcsolva a felhőben lévő fájl **AES-256-GCM** titkosítású (a kulcs a szinkronjelszóból PBKDF2-vel készül, a jelszót senki nem tárolja; elfelejtett jelszóval a felhőfájl nem nyitható meg, de a helyi adatok megmaradnak). A szinkron egyben mentésnek is számít, így a „régen volt mentés" emlékeztető nem jelenik meg, amíg működik.

**Fontos korlát:** a PIN *alkalmazászár* a véletlen belenézés ellen, **nem titkosítás**. Az adatok a böngészőprofilban titkosítatlanul vannak, és mivel minden kliensoldali, egy technikailag jártas támadó a böngészőeszközökkel megkerülheti. Az eszköz zárolása és a böngészőprofil védelme továbbra is szükséges. A böngészőadatok törlése az összes adatot elviszi, ezért érdemes időnként JSON-mentést készíteni.

## Szinkronizálás

A laptopod és a telefonod adatai szinkronban tarthatók a **saját Google Drive-od** vagy **Dropboxod** használatával. **Nincs saját szerver**, és nincs bérelt backend sem: az app továbbra is statikus fájlokból áll, minden a böngészőben fut. Az app **offline-first marad**: szinkron nélkül és internet nélkül is minden úgy működik, mint eddig; a szinkron egy opcionális réteg a helyi adatbázis fölött.

**Hogyan működik**

- A felhőben egyetlen fájl van (`ledger.sync.json`, a Google Drive rejtett *appDataFolder* mappájában, illetve a Dropbox *App folder* mappájában): a teljes állapot és a törlési jelölők, **titkosítva**.
- Minden eszköz letölti, **rekordonként összefésüli** a sajátjával (az újabb módosítás nyer), és feltölti az eredményt. Az összefésülés kommutatív és idempotens, ezért ha egy feltöltés versenyhelyzet miatt elveszne, a következő szinkron helyreállítja.
- A szinkron a feloldás után, módosítás után (rövid késleltetéssel), az app előtérbe kerülésekor, újra online állapotkor és a *Szinkron most* gombra fut. Kapcsolat nélkül a módosítások megmaradnak, és később feltöltődnek; az állapotjelző (jobb felül) mutatja, mi a helyzet.
- Az azonosítók véletlen 53 bites számok, így két eszköz nem adhat ugyanazt az azonosítót két különböző tételnek. Az ismétlődő tételek egy előfordulása minden eszközön ugyanazt az azonosítót kapja, így ha mindkét eszközön jóváhagyod, egy tétel lesz belőle.

**Bekapcsolás:** *Beállítások → Szinkronizálás → Bejelentkezés Google-fiókkal / Dropbox*. Új felhőfájlnál új **szinkronjelszót** kell megadni, meglévőnél azt, amit a másik eszközön beállítottál (eszközönként egyszer). A jelszót az app nem tárolja, csak a belőle képzett, nem kinyerhető kulcsot. A **másik eszköz első indításán** is választható a *Már használod másik eszközön?* csatlakozás.

Ha az új eszközön még nincs saját adat, a felhőben lévő adatok átkerülnek rá. Ha **mindkét oldalon vannak adatok**, választhatsz: a *felhőben lévő adatok használata* (előtte az itteni adatokról mentés töltődik le), az *összefésülés* (mindkét oldal megmarad), vagy *mégse*.

**Beállítás a saját fiókoddal (egyszeri, kb. 10 perc)**

A szinkronhoz egy nyilvános kliens-azonosítóra van szükség (ez **nem titok**). Az azonosítót a build kapja meg, ha nincs beállítva, az adott szolgáltató nem jelenik meg.

*Google*
1. <https://console.cloud.google.com/> → új projekt (pl. „Költségvetés").
2. *APIs & Services → Library* → **Google Drive API** engedélyezése.
3. *OAuth consent screen* (Google Auth Platform): *External*, alkalmazásnév, e-mail. Scope: `drive.appdata`, `openid`, `email`. Amíg az app *Testing* állapotú, **add hozzá a saját Google-fiókodat tesztfelhasználóként**. Saját használatra a *Testing* állapot is elég.
4. *Credentials → Create credentials → OAuth client ID → Web application*. *Authorized JavaScript origins*: `https://<felhasználó>.github.io` (fejlesztéshez `http://localhost:5173`).
5. A **Client ID**-t add meg a repóban: *Settings → Secrets and variables → Actions → Variables* → `GOOGLE_CLIENT_ID`. Helyi fejlesztéshez másold a `.env.example`-t `.env.local` néven, és töltsd ki a `VITE_GOOGLE_CLIENT_ID` sort.

*Dropbox*
1. <https://www.dropbox.com/developers/apps> → *Create app* → *Scoped access* → *App folder* → név.
2. *Permissions*: `files.content.read`, `files.content.write`, `account_info.read` → *Submit*.
3. *Settings → OAuth 2 → Redirect URIs*: `https://<felhasználó>.github.io/<repo-neve>/` (és `http://localhost:5173/`). *Allow public clients (Implicit Grant & PKCE)*: engedélyezve.
4. Az **App key**-t add meg a repóban: *Variables* → `DROPBOX_APP_KEY` (helyben: `VITE_DROPBOX_APP_KEY`). Fejlesztői állapotban az app 50 felhasználóig használható, ez saját célra bőven elég.

A Pages-kiadás a repó *Variables* értékeit adja át a buildnek (`.github/workflows/pages.yml`).

**Korlátok, amiket érdemes tudni**

- **Google:** a böngészőben nincs refresh token, a hozzáférés kb. 1 óráig él. A megújítás a PIN-feloldás gombnyomásakor csendben megtörténik; ha nem sikerül (popup-blokkoló), az állapotjelző *„Szinkron szünetel – koppints a folytatáshoz"* üzenetet mutat, egy koppintás megoldja, adat nem vész el. **Dropbox:** van refresh token, nem kell újra bejelentkezni; a bejelentkezés átirányítással történik, az app újratölt és újra PIN-t kér, a csatlakozás a feloldás után fejeződik be.
- **Egyszerre módosított cél:** ha egy megtakarítási cél *befizetett* összegét két eszközön egyszerre, offline növeled, az egyik növelés elvész (az újabb módosítás nyer; nincs összegzés).
- **Törlés és a 180 nap:** a törlési jelölők 180 napig élnek. Egy ennél tovább offline eszköz, amikor újra szinkronizál, **visszahozhat már törölt elemeket**.
- **Pénznemváltás, mentés visszatöltése, példaadatok betöltése/törlése** az adatok egészét cserélik, ezért új „korszakot" indítanak. Ha másik eszközön ilyen történt, az itteni, még nem szinkronizált módosítások elvesznek. Erről figyelmeztetést kapsz, és az előző állapotról mentés marad (letölthető).
- **Ha egy törölt kategória/számlát egy másik eszközön közben használnak** (új tétel rá), az elem visszaéled, és erről értesítést kapsz.
- **Szinkronjelszó cseréjekor** a többi eszköz a következő szinkronnál *„Hibás szinkronjelszó"* üzenetet kap, és az újat kell megadnia.
- A szinkron **nem visszavonható archívum**: egy hibás módosítás is átmegy a többi eszközre. A JSON-mentés ettől függetlenül érdemes időnként.
- Csak a JSON-mentésben lévő adatok szinkronizálódnak. Az eszközönkénti beállítások (PIN, automatikus zárolás, emlékeztetők, a szinkron-kapcsolat) nem.

**Kipróbálás valódi fiók nélkül:** fejlesztői buildben vagy az URL-hez fűzött `?syncProvider=memory` paraméterrel megjelenik egy memória-szolgáltató, amivel a teljes folyamat végigpróbálható (`npm run e2e:sync` két böngészőkontextussal).

## Funkciók

### Alap

1. **Gyors felvitel**: összeg, típus (kiadás / bevétel / jóváírás / átvezetés), dátum (alapból ma), kategória, leírás, számla, címkék, megjegyzés.
   - Összegmező kifejezéssel: `1200+850`, `2*450`, `12k` / `3e` (= ezer), `1,5k`, `12 000`; élő előnézettel és gyorsbillentő gombokkal (`+ − × k`).
   - Leírás-autocomplete a korábbi tételekből; választáskor a kategória, számla és összeg is kitöltődik. Kategóriajavaslat, okos alapértelmezések.
   - Mentés és új tétel (`Ctrl+Enter`), másolás, törlés utáni **Visszavonás** (7 mp). Mentetlen változtatásnál rákérdez.
   - **Sablonok**: az űrlap alján „Mentés sablonként"; az új tétel űrlapján a sablon-chipek egy érintéssel kitöltik a mezőket. Kezelés: *Több → Sablonok* (átnevezés, sorrend, „Rögzítés most").
   - **Természetes nyelvű gyorsbevitel** a főoldalon: `kávé 890 tegnap`, `lidl 4 500 péntek kártyával #hétvége`, `+48000 ösztöndíj`, `visszatérítés pulóver 6000`, `mozi 3200 szept 12`. Felismeri az összeget (`12 500`, `12k`, `1200+850`), a dátumot (ma, tegnap, tegnapelőtt, hétköznap, `múlt kedden`, `3 napja`, `szept 12`, `09.12.`, ISO), a típust (`+` jel, `bevétel`, `visszatérítés`), a számlát (név vagy `kártyával`, `készpénzzel`) és a `#címkéket`; a kategóriát a korábbi tételekből találja ki. Élő előnézet, Enter ment, vagy megnyitható az űrlapban.
2. **Tranzakciólista**: napok szerint csoportosítva, napi részösszeggel, havi lapozással; keresés (ékezet- és kisbetű-független) és szűrők (típus, kategória, számla, címke, dátum-időszak, összeghatár), aktív szűrők chipként.
   - **Továbbiak betöltése**: 100-asával töltődik, nincs kemény levágás.
   - **Mentett szűrők**: a szűrőt névvel el lehet menteni, a chipek egy érintéssel visszaállítják.
   - **Csoportos műveletek** (*Kijelölés*): kategória, számla módosítása, címke hozzáadása, törlés – mind visszavonható. A nem alkalmazható tételeket (pl. átvezetés kategóriával) kihagyja, és megmondja, hányat.
   - **CSV-export** a jelenlegi találatokról.
3. **Jóváírás (visszatérítés)**: ha visszaviszel egy ruhát, a jóváírás a *kiadási kategória költségét csökkenti* (és a számlára pénz érkezik), nem számít bevételnek. A havi kiadás, a kategóriabontás és a keretek is a jóváírással csökkentett (nettó) összeggel számolnak.
4. **Egy tétel több kategóriára bontása** (egy Lidl-blokk → Étel + Háztartás): az űrlapon „Felosztás több kategóriára"; az üresen hagyott rész megkapja a maradékot. A statisztikák, keretek, szűrők a részek kategóriája szerint számolnak.
5. **Havi keretek**: kategóriánként és/vagy összesen (*Több → Havi keretek*, vagy a kategória szerkesztőjében). A főoldalon sáv mutatja a kihasználtságot és a hónap eddig eltelt részét; **80% felett figyelmeztetés, 100% felett túllépés**. Mentéskor toast jelzi, ha a tétel átlépett egy szintet.
6. **Számlák**: számlatípus (készpénz / folyószámla / hitelkártya / megtakarítás), egyenleg, **átvezetés**, **átrendezés** (▲▼), archiválás. **Egyenleg-egyeztetés**: a „Valós egyenleg" megadásakor az app megmutatja a különbséget, és *korrekciós tételt* készít (az „Egyenleg-egyeztetés" kategóriába) – a kezdőegyenleg és a múlt nem változik.
7. **Kategóriák**: létrehozás, átnevezés, ikon, szín, havi keret, **átrendezés**, archiválás.
8. **Megtakarítási célok**: számla egyenlegéhez kötött vagy kézzel (befizetéssel) követett cél, határidővel: megmutatja a havonta félretenni valót.

### Ismétlődő tételek

Albérlet, előfizetések, ösztöndíj: *Több → Ismétlődő tételek* (hetente / havonta / évente, minden n-edik, kezdő- és záródátum). Szerver nincs, ezért **nem jönnek létre maguktól**: az esedékes előfordulások az app megnyitásakor a főoldalon „Esedékes tételek" listaként várnak, egy érintéssel jóváhagyhatók (az összeg előtte módosítható) vagy kihagyhatók; „Mind jóváhagyása" is van. A havi ismétlés a kezdőnaphoz igazodik (jan. 31. → feb. 28. → márc. 31.). Ha a kezdőnap a múltban van, a kimaradt előfordulások is felzárkózásként megjelennek. Két lapon nem lehet ugyanazt az előfordulást kétszer jóváhagyni.

### Elemzés

- **Elemzés** oldal: az elmúlt 6 vagy 12 hónap bevétel/kiadás **oszlopdiagramja**, a hónap napról napra kumulált költése az előző hónappal, a kerettel és az **előrejelzéssel** összevetve, **kategóriánkénti összevetés az előző hónappal** (▲▼ %), és a **„Mire költöttem a legtöbbet?"** (időszak: hónap / 3 / 6 / 12 hó / év / összes): kategóriák, helyek és tételek leírás szerint, legnagyobb egyedi kiadások, hétköznapi átlag, címkék.
- **Előrejelzés**: a hátralévő napokra a *változó* költések (az ismétlődő szabályból nem származók) napi átlagát vetíti, ehhez adja a hátralévő ismétlődő tételeket. A napi átlag az előző hónapok átlagából indul, és a hónap 10. napjára áll át teljesen a folyó hónap ütemére. A főoldalon és az Elemzésben is látszik (várható havi kiadás, várható hó végi összegyenleg).
- **Naptár**: hónapnézet napi kiadással (hőtérkép-árnyalat + szám, így nem csak színnel érthető), bevétel- és esedékes-jelölővel; a nap kiválasztásával megjelennek a tételei, és felvihető új tétel arra a napra.
- A grafikonok függőségmentes SVG-k: tooltip rámutatásra és billentyűzetes fókuszra, alattuk táblázatos nézet. A két sorozat színe (kék/narancs) színtévesztés-biztos.

### Adatok

- **CSV-export** (*Beállítások* vagy a Tételek oldal): pontosvesszős, UTF-8 BOM-os, tizedesvesszős – a magyar Excel jól nyitja. A kiadás negatív, a felosztott tétel részenként egy sor; a `=`, `+`, `-`, `@` jellel kezdődő szövegek elé aposztróf kerül (képlet-injektálás ellen).
- **CSV-import** (*Több → CSV-import*): elválasztó és kódolás (UTF-8 / windows-1250) felismerése, oszlop-hozzárendelés (a saját exportod formátuma, banki „Terhelés/Jóváírás" oszlopok, előjeles összeg is), élő összegzés hibás sorokkal, hiányzó kategóriák/számlák létrehozása, duplikátumok kiszűrése, közös `import` címke (az egész import egyben megtalálható és törölhető).
- **Pénznemváltás** (*Beállítások → Pénznem*): az összes összeg (tételek, felosztások, egyenlegek, keretek, célok, ismétlődők, sablonok) az általad megadott árfolyammal átszámolódik; az összegek a pénznem legkisebb egységében (HUF: Ft, EUR: cent) vannak tárolva. Az átváltás a kerekítés miatt nem tökéletesen visszafordítható, ezért alapból mentést tölt le előtte. (Nem tételenkénti többpénznemű követés: egy időben egy pénznemben vezetsz.)
- **Jelszavas mentés, megosztás**: lásd fent.

### Kényelem

- **Billentyűparancsok** (`?` mutatja): `N` új tétel, `/` keresés, `[` `]` előző/következő hónap, `G` majd `H/T/C/S/B/R/G/M/K/A/I/O` oldalváltás, `G` majd `L` zárolás, `Ctrl+Enter` mentés és új. Beviteli mezőben gépelés közben nem aktívak.
- **Emlékeztető-értesítések** (*Beállítások → Emlékeztetők*): napi emlékeztető megadott órában, esedékes ismétlődő tételek, keret 80% / 100%, régi mentés. **Korlát:** szerver nincs, ezért az értesítések helyiek – akkor érkeznek, ha az app (akár háttérben) fut; Chromium alapú, telepített appnál a napi emlékeztetőt a böngésző időnként akkor is elküldheti, ha az app zárva van (Periodic Background Sync). iOS-en ez korlátozott. Az értesítések szövege nem tartalmaz összegeket.
- **Reaktív „ma"**: a dátum nem csak betöltéskor számolódik – háttérből visszahozott vagy éjfélen átfutó app is az aktuális napot/hónapot mutatja.
- **PWA-gyorsparancsok**: telepített appon a hosszú érintés menüje: Új tétel, Tételek, Naptár.

Az előre létrehozott alap kategóriák szerkeszthetők: *Étel, Közlekedés, Lakhatás/kollégium, Tanulás, Szórakozás, Ruházat, Egészség, Előfizetések, Egyéb*; bevétel: *Ösztöndíj, Fizetés/munka, Családtól, Egyéb*. Alap számlák: *Készpénz (készpénz), Bankkártya (folyószámla), Megtakarítás (megtakarítás)*.

### Üzleti szabályok (tesztelve)

- Az összeg mindig pozitív egész (a pénznem legkisebb egységében), az előjelet a típus adja: kiadás −, bevétel és jóváírás +.
- Kiadásnál a leírás kötelező, bevételnél és jóváírásnál ajánlott.
- A **jóváírás** kiadási kategóriát kap, csökkenti annak költését és a havi kiadást; a **bevétel** továbbra is csak bevételi kategóriát kaphat.
- Az **átvezetés** nem számít bevételnek/kiadásnak a statisztikákban, de mozgatja a számlaegyenlegeket; a két számla nem lehet ugyanaz.
- A felosztott tétel részei pozitív egészek, összegük a tétel összege, legalább két rész, kategóriánként egy.
- **Kategória/számla csak akkor törölhető, ha nincs hozzá tétel (és ismétlődő szabály)**, különben archiválható. A törlés kétlépéses, a tételé nem (ott a visszavonás van). A megszűnt kategória/számla kiürül a sablonokból és a célokból.
- Archivált kategória/számla új tételhez nem választható, a régi tételeken és a szűrőkben megmarad.
- Az ismétlődő tétel előfordulásai időrendben dolgozhatók fel; egy előfordulás csak egyszer hagyható jóvá.
- A dátum bármikor visszamenőleg módosítható.

### Még nem szerepel

Bankintegráció, tételenkénti többpénznemű követés, valódi (szerver-alapú) push értesítés, hitelkártya-limit és kamatszámítás. Ezek szerver nélkül nem, vagy csak nagy kompromisszummal oldhatók meg. (A több eszköz közötti szinkron megvan, de opcionális, és a saját Google Drive / Dropbox tárhelyedet használja.)

## Felépítés

```
src/
  app.html, app.css              alap HTML, design-tokenek, sötét mód
  service-worker.ts              offline gyorsítótár + emlékeztető-értesítések
  lib/
    money.ts, currency.ts        összegkifejezés-értékelő, formázás, pénznemek és átváltás
    dates.ts, text.ts            dátumok (YYYY-MM-DD), ékezetmentes normalizálás
    validation.ts                űrlap-validáció (tétel, felosztás, kategória, számla, ismétlődő, cél)
    queries.ts                   szűrés, összesítők, egyenlegek, autocomplete – tiszta függvények
    budget.ts, recurring.ts      havi keretek; ismétlődő tételek előfordulásai
    forecast.ts, stats.ts        előrejelzés; trend, összevetés, „mire költöttem", naptár
    goals.ts, quick.ts           célok haladása; természetes nyelvű gyorsbevitel elemzője
    csv.ts, csvImport.ts, csvExport.ts   CSV olvasás/írás, import terv, export
    shortcuts.ts, notify.ts      billentyűparancsok; emlékeztetők logikája
    types.ts                     adatmodell
    db/
      idb.ts, repo.ts            IndexedDB burkoló (verziónkénti migráció) és CRUD
      pin.ts, crypto.ts          PIN hash; jelszavas mentés (AES-GCM)
      backup.ts, defaults.ts, demo.ts   JSON-mentés (szigorú ellenőrzés, verzió-migráció), alap adatok, példaadatok
    sync/                        szinkron: ids, stamp, tombstones, merge (tiszta összefésülés), format (titkosított
                                 fájl), core (egy futás), engine.svelte (ütemezés, csatlakozás), provider,
                                 gdrive, dropbox, memory (teszt)
    ledger.svelte.ts             memóriabeli főkönyv (Svelte állapot) + üzleti szabályok
    clock.svelte.ts              reaktív „ma"
    auth.svelte.ts               indítás, PIN-beállítás, zárolás, beállítások
    components/                  űrlapok, navigáció, toast, keret-sávok, grafikonok (charts/) …
  routes/                        / · new · transactions · calendar · stats · budgets · recurring · goals
                                 templates · categories · accounts · import · more · settings
static/                          manifest, ikonok, favicon
tests/                           Vitest egység- és integrációs tesztek
e2e/smoke.mjs, features.mjs,
  sync.mjs                       végponttól végpontig böngészős ellenőrzés (Playwright; a sync.mjs két eszközzel)
scripts/make-icons.mjs           PNG ikonok újragenerálása (npm run icons, Playwright kell hozzá)
```

**Stack:** SvelteKit (Svelte 5, TypeScript) statikus SPA-ként (`adapter-static`, hash-router), IndexedDB tárolással, kézzel írt CSS-sel és SVG-grafikonokkal. Futásidejű függőség nincs. Egy személyes költségvetés (évi pár ezer tétel) mellett a szűrés/összesítés memóriában, JS-ben történik, ami gyors és egyszerű.

### Séma- és mentésverziók (fejlesztőknek)

- **IndexedDB**: a `DB_VERSION` (`src/lib/db/idb.ts`) emelésekor a `MIGRATIONS` tömbbe új lépést kell írni (az i. elem az (i+1). verzióra lép; a régieket soha ne módosítsd). Az upgrade verziónként fut, így a régi telepítések adatvesztés nélkül frissülnek (tesztelve egy valódi 1-es verziójú adatbázison). Ha egy régi lap nyitva marad, az új lap nem hibát mutat, hanem várakozik és jelzi; az új verziójú lapok `onversionchange`-nél maguktól lezárják a kapcsolatukat.
- **Szinkron és azonosítók**: az új sorok azonosítója `newId()` (véletlen, `>= 2^32`), az alap számláké (1…3) és kategóriáké (101…) fix. A **sorrend ezért nem az azonosítóból, hanem a `createdAt`-ből** jön (`compareTx`, `LedgerRepo.loadAll`). A `createdAt` és az `updatedAt` a `stamp()`-ből (szigorúan növekvő) származik. Új rekordtípus vagy mező felvételekor: `updatedAt` minden módosításnál, a törlés a `LedgerRepo.remove*`-on át (törlési jelölő), és az összefésülés (`sync/merge.ts`) szabályainak bővítése.
- **JSON-mentés**: a `BACKUP_VERSION` (`src/lib/db/backup.ts`) emelésekor a `MIGRATIONS[régi]` lépés hozza az előző verzió nyers JSON-ját az eggyel újabb alakra; az ellenőrzés mindig a legújabb alakon fut. Az 1-es és 2-es verziójú mentések így továbbra is betölthetők (számlatípus a névből, üres ismétlődők/sablonok/célok/szűrők, HUF, a hiányzó `updatedAt` a `createdAt`).

## Tesztek

```bash
npm test             # 400+ egység-, tulajdonság- és integrációs teszt (Vitest, fake-indexeddb)
npm run check        # svelte-check / TypeScript
```

A tesztek lefedik az összegkifejezéseket és pénznemeket, dátumokat, validációt (felosztás, jóváírás), szűrést/összesítést, számlaegyenlegeket, az IndexedDB-réteget és a **séma-migrációt** (1-es verziójú adatbázis, blokkolt frissítés, lezáródó kapcsolat), a mentés export→import körét, a **régi (v1) mentések betöltését**, a jelszavas mentést, a PIN-t, a kereteket, az ismétlődő tételeket, az előrejelzést, az elemzéseket, a naptárt, a célokat, a gyorsbevitel elemzőjét, a CSV-t (olvasás, írás, import terv, export→import kör), a billentyűparancsokat, az emlékeztetőket, a reaktív „ma"-t és az üzleti szabályokat (pl. használt kategória nem törölhető, egyenleg-egyeztetés, csoportos módosítás, pénznemváltás).

A szinkronhoz külön tesztek tartoznak: az **összefésülés tulajdonság-tesztjei** véletlen műveletsorokon (kommutativitás, idempotencia, asszociativitás rekordszinten, érvényesség, felhő-közvetített konvergencia), a kódolás/titkosítás, két „eszköz" közötti valós forgatókönyvek (versenyhelyzet, szinkron közbeni szerkesztés, korszakváltás, jelszócsere, ütemezés) és a két szolgáltató `fetch`-mockkal.

Böngészős végigpróbálás az éles buildre. A `smoke.mjs` az alapfolyamatokat (PIN, felvitel, keresés, szerkesztés, törlés+visszavonás, átvezetés, kategóriák, mentés, zárolás, **offline újraindítás**), a `features.mjs` az újabb funkciókat próbálja végig (gyorsbevitel, keretek, jóváírás, felosztás, ismétlődők, egyeztetés, sablonok, csoportos műveletek, mentett szűrők, elemzés, naptár, billentyűparancsok, CSV-kör, jelszavas mentés, emlékeztetők, pénznemváltás, hónapforduló):

```bash
npm run build
python3 -m http.server 4173 --directory build &
npm install --no-save playwright   # egyszer; Chromium is kell
BASE_URL=http://localhost:4173/ npm run e2e
BASE_URL=http://localhost:4173/ npm run e2e:features
BASE_URL=http://localhost:4173/ npm run e2e:sync      # két böngészőkontextus, memória-szolgáltatóval
```

## Ismert megjegyzések

- Ha a címsorban kézzel átírod a `#/…` részt, a SvelteKit hash-routere teljes újratöltést csinál, így az app újra PIN-t kér. A linkek, a vissza gomb és a telepített app normálisan működnek.
- iOS Safarin a nem telepített oldal adatait a böngésző hosszabb használaton kívüliség után törölheti; a főképernyőre telepített változat és a rendszeres JSON-mentés védi ezt ki.
- A PWA-ikonok a `static/icons/` alatt vannak (`npm run icons` újragenerálja).
- Az összegmezőben az ezres tagolás és a tizedes elválasztó félreérthető lehet tizedes pénznemnél (EUR): az `1.500` ezres tagolásnak számít (1500), a tizedes jel a vessző vagy egy nem hármas tagolású pont (`1,5`, `12.5`).
- Ismétlődő tételnél az első alkalom múltbeli dátuma felzárkózásként több esedékes tételt hoz létre (legfeljebb 36-ot szabályonként listázunk egyszerre).
