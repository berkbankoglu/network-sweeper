/**
 * Network Sweeper — bağlantı temizleyici (Chrome eklentisi)
 * ----------------------------------------------------------
 * Bağlantılar sayfasına girildiğinde sağ altta panel açılır,
 * 5 saniyelik geri sayımdan sonra bağlantıları otomatik kaldırır.
 * Panelden istediğin an durdurabilir / yeniden başlatabilirsin.
 *
 * v1.1: LinkedIn'in yeni arayüzü basit click() çağrısını tanımıyor;
 * artık gerçek fare davranışını taklit eden tam olay dizisi
 * (pointerdown/mousedown/pointerup/mouseup/click) gönderiliyor.
 * v1.2: Panele "Hata Raporu" düğmesi eklendi — tüm hataları ve sayfa
 * yapısı özetini tek seferde panoya kopyalar.
 * v1.3: Onay düğmesi artık kalıptan bağımsız bulunuyor: tıklama öncesi/
 * sonrası karşılaştırılıp YENİ beliren "kaldır" düğmesine basılıyor.
 * Onay sormadan direkt kaldıran arayüzler de destekleniyor.
 * v1.4: Kayıt modu — "🎬 Kayıt Başlat"a bas, bir bağlantıyı ELLE kaldır,
 * "⏹ Kaydı Bitir"e bas: tıkladığın her elemanın tam detayı panoya
 * kopyalanır. Bu kaydı Claude'a yapıştırınca otomasyon birebir senin
 * adımlarına göre güncellenir.
 * v1.5: Kullanıcı kaydından çıkan gerçek yapıya göre ayarlandı:
 * tetikleyici #ConnectionsPage_ConnectionsList içindeki "diğer işlemler"
 * düğmesi, menü öğesi div[role="menuitem"], onay <dialog> içindeki
 * "Bağlantıyı kaldır" düğmesi.
 * v1.6: Hızlı mod — sabit beklemeler yerine 100 ms aralıklı akıllı
 * bekleme (element belirir belirmez devam); kaldırmalar arası bekleme
 * 0,25-0,7 sn'ye indirildi.
 * v1.7: Oturum limiti kaldırıldı — bağlantı bulabildiği sürece devam
 * eder (AYARLAR.maksKaldirma ile tekrar sınırlanabilir).
 */

(() => {
  'use strict';

  const AYARLAR = {
    maksKaldirma: Infinity, // sınırsız; sınır istersen sayı yaz (ör. 75)
    minBeklemeMs: 250,      // kaldırmalar arası bekleme (hızlı mod)
    maksBeklemeMs: 700,
    geriSayimSn: 5
  };

  const KALDIR_SECENEK = ['bağlantıyı kaldır', 'remove connection'];
  const ONAY_BUTON = ['kaldır', 'remove'];
  const DAHA_FAZLA = ['daha fazla', 'show more', 'load more'];
  const YASAK_DUGME = ['mesaj', 'message', 'takip', 'follow', 'bağlantı kur', 'connect', 'invite', 'davet'];

  const BAGLANTI_SAYFASI = /\/mynetwork\/invite-connect\/connections/;

  // ---- Durum ----
  let calisiyor = false;
  let durdurIstegi = false;
  let kaldirilan = 0;
  let toplamKaldirilan = 0;
  let geriSayimZamanlayici = null;
  let panel = null;
  const hataGunlugu = [];

  const hataKaydet = (msg) => {
    hataGunlugu.push({ zaman: new Date().toLocaleTimeString('tr-TR'), hata: msg });
    if (hataGunlugu.length > 50) hataGunlugu.shift();
  };

  // ---- Yardımcılar ----
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  const rastgeleBekle = () =>
    bekle(AYARLAR.minBeklemeMs + Math.random() * (AYARLAR.maksBeklemeMs - AYARLAR.minBeklemeMs));

  // Koşul sağlanana kadar 100 ms aralıklarla bekle (sabit bekleme yerine)
  const kosulBekle = async (fn, sureMs, aralikMs = 100) => {
    const son = Date.now() + sureMs;
    let sonuc = fn();
    while (!sonuc && Date.now() < son) {
      await bekle(aralikMs);
      sonuc = fn();
    }
    return sonuc;
  };

  const gorunur = (el) => !!el && el.getClientRects().length > 0;
  const metin = (el) => (el.innerText || el.textContent || '').trim().toLowerCase();
  const etiket = (el) => ((el.getAttribute && el.getAttribute('aria-label')) || '').toLowerCase();

  // Gerçek fare tıklamasını taklit eden tam olay dizisi
  const tamTikla = (el) => {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0
    };
    for (const tip of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown']) {
      el.dispatchEvent(tip.startsWith('pointer') ? new PointerEvent(tip, opts) : new MouseEvent(tip, opts));
    }
    try { el.focus(); } catch (e) { /* odaklanamayan eleman */ }
    for (const tip of ['pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(tip.startsWith('pointer') ? new PointerEvent(tip, opts) : new MouseEvent(tip, opts));
    }
  };

  // Açık kalmış menüleri Escape ile kapat
  const escBas = () => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
    if (document.activeElement) document.activeElement.dispatchEvent(ev);
    document.body.dispatchEvent(ev);
  };

  const dialogBul = () =>
    [...document.querySelectorAll('.artdeco-modal, [role="dialog"], [role="alertdialog"], dialog, [data-test-modal]')].filter(gorunur);

  // Sayfadaki görünür "kaldır/remove" metinli düğmeler, en kısa metinli
  // önde (eklentinin kendi paneli hariç)
  const onayAdaylari = () =>
    [...document.querySelectorAll('button, [role="button"], a')]
      .filter((el) => {
        if (!gorunur(el)) return false;
        if (panel && panel.contains(el)) return false;
        const t = metin(el);
        return t && t.length < 40 && ONAY_BUTON.some((m) => t.includes(m));
      })
      .sort((a, b) => metin(a).length - metin(b).length);

  // Onay sorulmadan kaldırıldı mı? (satır kayboldu ya da bildirim çıktı)
  const kaldirmaGerceklesti = (tetik) => {
    if (!document.contains(tetik) || !gorunur(tetik)) return true;
    return [...document.querySelectorAll('[role="alert"], [role="status"], .artdeco-toast-item')]
      .some((el) => gorunur(el) && /kaldırıldı|removed/i.test(metin(el)));
  };

  const metniUyusanBul = (kokler, secici, aranan) => {
    const adaylar = [];
    for (const kok of kokler) {
      if (!kok) continue;
      for (const el of kok.querySelectorAll(secici)) {
        if (!gorunur(el)) continue;
        const t = metin(el);
        if (t && t.length < 80 && aranan.some((m) => t.includes(m))) adaylar.push(el);
      }
    }
    if (!adaylar.length) return null;
    adaylar.sort((a, b) => metin(a).length - metin(b).length);
    const el = adaylar[0];
    return el.closest('button, [role="menuitem"], [role="button"], li, a, [tabindex]') || el;
  };

  const baglantiSatirinda = (btn) => {
    let el = btn;
    for (let i = 0; i < 8 && el; i++) {
      if (el.querySelector && el.querySelector('a[href*="/in/"]')) return true;
      el = el.parentElement;
    }
    return false;
  };

  const TETIK_SECICILER = [
    // Kayıttan bilinen güncel yapı (Tem 2026)
    '#ConnectionsPage_ConnectionsList button[aria-label*="diğer işlemler" i]',
    '#ConnectionsPage_ConnectionsList button[aria-label*="More actions" i]',
    // Eski arayüz yedekleri
    'button.artdeco-dropdown__trigger',
    'button[aria-label*="More actions" i]',
    'button[aria-label*="Diğer işlemler" i]',
    'button[aria-label*="diğer" i]',
    'button[id*="ellipsis" i]'
  ];

  const satirBul = (link) => {
    let el = link;
    for (let i = 0; i < 10 && el && el.parentElement; i++) {
      el = el.parentElement;
      if (el.querySelectorAll('a[href*="/in/"]').length > 3) return null;
      if (el.querySelector('button')) return el;
    }
    return null;
  };

  const overflowAdayi = (satir) => {
    const uygun = [...satir.querySelectorAll('button')].filter((b) => {
      if (!gorunur(b)) return false;
      const et = etiket(b) + ' ' + metin(b);
      return !YASAK_DUGME.some((y) => et.includes(y));
    });
    if (!uygun.length) return null;
    return (
      uygun.find((b) => /diğer|more|işlem|action/i.test(etiket(b))) ||
      uygun.find((b) => b.getAttribute('aria-haspopup') === 'true' || b.hasAttribute('aria-expanded')) ||
      uygun.filter((b) => !metin(b)).pop() ||
      null
    );
  };

  const karaListe = new Set();

  const tetikleyiciBul = () => {
    const kok = document.querySelector('main') || document.body;
    for (const secici of TETIK_SECICILER) {
      for (const b of kok.querySelectorAll(secici)) {
        if (gorunur(b) && !karaListe.has(b) && baglantiSatirinda(b)) return b;
      }
    }
    for (const link of kok.querySelectorAll('a[href*="/in/"]')) {
      if (!gorunur(link)) continue;
      const satir = satirBul(link);
      if (!satir) continue;
      const b = overflowAdayi(satir);
      if (b && !karaListe.has(b)) return b;
    }
    return null;
  };

  const dahaFazlaYukle = async () => {
    const btn = metniUyusanBul([document.querySelector('main') || document.body], 'button', DAHA_FAZLA);
    if (btn) { tamTikla(btn); } else { window.scrollTo(0, document.body.scrollHeight); }
    await bekle(1200);
  };

  const taniTopla = () => {
    const kok = document.querySelector('main') || document.body;
    return {
      url: location.href,
      profilLinkSayisi: [...kok.querySelectorAll('a[href*="/in/"]')].filter(gorunur).length,
      viewNames: [...new Set([...kok.querySelectorAll('[data-view-name]')].map((e) => e.getAttribute('data-view-name')))].slice(0, 30),
      butonlar: [...new Set(
        [...kok.querySelectorAll('button')].filter(gorunur)
          .map((b) => (b.getAttribute('aria-label') || metin(b) || '(ikon-only)').slice(0, 70))
      )].slice(0, 60)
    };
  };

  const taniModu = () => {
    const tani = taniTopla();
    window.TANI = tani;
    console.log('[Bağlantı Temizleyici] TANI:', JSON.stringify(tani, null, 2));
  };

  const panoyaKopyala = async (yazi) => {
    try {
      await navigator.clipboard.writeText(yazi);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = yazi;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) {
        return false;
      }
    }
  };

  const hataRaporuKopyala = async () => {
    const rapor = {
      eklentiSurumu: '1.7',
      zaman: new Date().toLocaleString('tr-TR'),
      buOturumKaldirilan: kaldirilan,
      toplamKaldirilan: toplamKaldirilan,
      calisiyor: calisiyor,
      hatalar: hataGunlugu.length ? hataGunlugu : ['(hata kaydı yok)'],
      sayfaYapisi: taniTopla()
    };
    const json = JSON.stringify(rapor, null, 2);
    console.log('[Bağlantı Temizleyici] HATA RAPORU:', json);
    const ok = await panoyaKopyala(json);
    durumYaz(ok
      ? 'Hata raporu panoya kopyalandı — Claude\'a yapıştır (Ctrl+V).'
      : 'Panoya kopyalanamadı; rapor konsolda (F12) duruyor.');
  };

  // ---- Kayıt modu: kullanıcının elle yaptığı tıklamaları kaydet ----
  let kayitAktif = false;
  const kayitAdimlari = [];

  const cssYolu = (el) => {
    const parcalar = [];
    let e = el;
    for (let i = 0; e && e !== document.body && i < 12; i++) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parcalar.unshift(p + '#' + e.id); break; }
      const sinif = [...e.classList].slice(0, 3).join('.');
      if (sinif) p += '.' + sinif;
      const anne = e.parentElement;
      if (anne) {
        const ayni = [...anne.children].filter((c) => c.tagName === e.tagName);
        if (ayni.length > 1) p += ':nth-of-type(' + (ayni.indexOf(e) + 1) + ')';
      }
      parcalar.unshift(p);
      e = anne;
    }
    return parcalar.join(' > ');
  };

  const elemanOzeti = (el) => ({
    tag: el.tagName ? el.tagName.toLowerCase() : String(el),
    id: el.id || undefined,
    class: (typeof el.className === 'string' && el.className) ? el.className.slice(0, 120) : undefined,
    role: el.getAttribute ? (el.getAttribute('role') || undefined) : undefined,
    ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || undefined) : undefined,
    href: el.getAttribute ? (el.getAttribute('href') || undefined) : undefined,
    viewName: el.getAttribute ? (el.getAttribute('data-view-name') || undefined) : undefined,
    text: metin(el).slice(0, 60) || undefined
  });

  const kayitDinleyici = (ev) => {
    if (!kayitAktif) return;
    const hedefEl = ev.target;
    if (!(hedefEl instanceof Element)) return;
    if (panel && panel.contains(hedefEl)) return;
    const atalar = [];
    let e = hedefEl.parentElement;
    for (let i = 0; e && e !== document.body && i < 6; i++) {
      atalar.push(elemanOzeti(e));
      e = e.parentElement;
    }
    kayitAdimlari.push({
      sira: kayitAdimlari.length + 1,
      olay: ev.type,
      zaman: new Date().toLocaleTimeString('tr-TR'),
      eleman: elemanOzeti(hedefEl),
      cssYolu: cssYolu(hedefEl),
      atalar
    });
    durumYaz('KAYIT: ' + kayitAdimlari.length + ' adım kaydedildi… Bitince "Kaydı Bitir"e bas.');
  };

  const kayitBaslat = () => {
    kayitAktif = true;
    kayitAdimlari.length = 0;
    durdurIstegi = true; // otomasyon çalışıyorsa dursun
    geriSayimIptal();
    window.addEventListener('pointerdown', kayitDinleyici, true);
    window.addEventListener('click', kayitDinleyici, true);
    durumYaz('KAYIT MODU: şimdi BİR bağlantıyı elle kaldır (üç nokta → Bağlantıyı kaldır → onay), sonra "Kaydı Bitir"e bas.');
  };

  const kayitBitir = async () => {
    kayitAktif = false;
    window.removeEventListener('pointerdown', kayitDinleyici, true);
    window.removeEventListener('click', kayitDinleyici, true);
    const rapor = {
      tur: 'kayit',
      eklentiSurumu: '1.7',
      zaman: new Date().toLocaleString('tr-TR'),
      url: location.href,
      adimSayisi: kayitAdimlari.length,
      adimlar: kayitAdimlari
    };
    const json = JSON.stringify(rapor, null, 2);
    console.log('[Bağlantı Temizleyici] KAYIT:', json);
    try { chrome.storage.local.set({ sonKayit: rapor }); } catch (e) { /* yoksay */ }
    const ok = await panoyaKopyala(json);
    durumYaz(ok
      ? 'Kayıt panoya kopyalandı (' + kayitAdimlari.length + ' adım) — Claude\'a yapıştır (Ctrl+V).'
      : 'Panoya kopyalanamadı; kayıt konsolda (F12) duruyor.');
  };

  // ---- Panel ----
  const stilEkle = (el, stiller) => Object.assign(el.style, stiller);

  const panelKur = () => {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'lbt-panel';
    stilEkle(panel, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: '99999',
      width: '270px', padding: '14px', borderRadius: '10px',
      background: '#1d2226', color: '#fff', fontFamily: 'system-ui, sans-serif',
      fontSize: '13px', boxShadow: '0 4px 18px rgba(0,0,0,.45)', lineHeight: '1.45'
    });
    panel.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;">🧹 Bağlantı Temizleyici</div>
      <div id="lbt-durum" style="min-height:34px;margin-bottom:8px;color:#c9d1d9;"></div>
      <div style="margin-bottom:10px;">
        Bu oturum: <b id="lbt-sayac">0</b>
        &nbsp;·&nbsp; Toplam: <b id="lbt-toplam">0</b>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="lbt-baslat" style="flex:1;padding:7px 0;border:0;border-radius:6px;background:#0a66c2;color:#fff;font-weight:600;cursor:pointer;">Başlat</button>
        <button id="lbt-durdur" style="flex:1;padding:7px 0;border:0;border-radius:6px;background:#5f6a72;color:#fff;font-weight:600;cursor:pointer;">Durdur</button>
      </div>
      <button id="lbt-rapor" style="width:100%;margin-top:8px;padding:7px 0;border:0;border-radius:6px;background:#8f5a1e;color:#fff;font-weight:600;cursor:pointer;">📋 Hata Raporu Kopyala</button>
      <button id="lbt-kayit" style="width:100%;margin-top:8px;padding:7px 0;border:0;border-radius:6px;background:#256029;color:#fff;font-weight:600;cursor:pointer;">🎬 Kayıt Başlat (elle göster)</button>
      <div style="margin-top:8px;font-size:11px;color:#8a949e;">Kaldırılan bağlantı geri alınamaz.</div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector('#lbt-baslat').addEventListener('click', () => {
      geriSayimIptal();
      calistir();
    });
    panel.querySelector('#lbt-durdur').addEventListener('click', () => {
      geriSayimIptal();
      durdurIstegi = true;
      durumYaz('Durduruldu. Devam etmek için Başlat\'a bas.');
    });
    panel.querySelector('#lbt-rapor').addEventListener('click', hataRaporuKopyala);
    panel.querySelector('#lbt-kayit').addEventListener('click', () => {
      const btn = panel.querySelector('#lbt-kayit');
      if (!kayitAktif) {
        kayitBaslat();
        btn.textContent = '⏹ Kaydı Bitir ve Kopyala';
        btn.style.background = '#8a1c1c';
      } else {
        kayitBitir();
        btn.textContent = '🎬 Kayıt Başlat (elle göster)';
        btn.style.background = '#256029';
      }
    });
  };

  const panelKaldir = () => {
    if (panel) { panel.remove(); panel = null; }
  };

  const durumYaz = (msg) => {
    const el = panel && panel.querySelector('#lbt-durum');
    if (el) el.textContent = msg;
  };

  const sayacGuncelle = () => {
    if (!panel) return;
    panel.querySelector('#lbt-sayac').textContent = String(kaldirilan);
    panel.querySelector('#lbt-toplam').textContent = String(toplamKaldirilan);
  };

  const toplamiYukle = () => {
    try {
      chrome.storage.local.get({ toplamKaldirilan: 0 }, (v) => {
        toplamKaldirilan = v.toplamKaldirilan || 0;
        sayacGuncelle();
      });
    } catch (e) { /* storage yoksa sorun değil */ }
  };

  const toplamiKaydet = () => {
    try { chrome.storage.local.set({ toplamKaldirilan }); } catch (e) { /* yoksay */ }
  };

  // ---- Geri sayım ve ana döngü ----
  const geriSayimIptal = () => {
    if (geriSayimZamanlayici) { clearInterval(geriSayimZamanlayici); geriSayimZamanlayici = null; }
  };

  const geriSayimBaslat = () => {
    if (calisiyor || geriSayimZamanlayici || kayitAktif) return;
    let kalan = AYARLAR.geriSayimSn;
    durumYaz(`Otomatik başlıyor: ${kalan} sn… (istemiyorsan Durdur'a bas)`);
    geriSayimZamanlayici = setInterval(() => {
      kalan--;
      if (kalan <= 0) {
        geriSayimIptal();
        calistir();
      } else {
        durumYaz(`Otomatik başlıyor: ${kalan} sn… (istemiyorsan Durdur'a bas)`);
      }
    }, 1000);
  };

  const calistir = async () => {
    if (calisiyor) return;
    calisiyor = true;
    durdurIstegi = false;
    let ustUsteHata = 0;
    let bosDeneme = 0;

    durumYaz('Çalışıyor…');

    while (kaldirilan < AYARLAR.maksKaldirma && !durdurIstegi && BAGLANTI_SAYFASI.test(location.pathname)) {
      escBas(); // önceki denemeden açık kalmış menü varsa kapat
      await bekle(80);

      const tetik = tetikleyiciBul();

      if (!tetik) {
        bosDeneme++;
        if (bosDeneme >= 3) {
          durumYaz('Kaldırılacak bağlantı bulunamadı — liste bitti ya da arayüz tanınamadı (konsolda TANI var).');
          hataKaydet('Tetikleyici bulunamadı: liste bitti ya da arayüz tanınamadı');
          taniModu();
          break;
        }
        durumYaz('Yeni bağlantılar yükleniyor…');
        await dahaFazlaYukle();
        continue;
      }
      bosDeneme = 0;

      try {
        tetik.scrollIntoView({ block: 'center' });
        await bekle(120);
        tamTikla(tetik);

        // Kayıttan bilinen yapı: menü öğesi div[role="menuitem"], metni
        // içindeki <p>'de. Belirir belirmez devam et (en fazla 3 sn bekle).
        const menuOgesiAra = () => {
          for (const mi of document.querySelectorAll('[role="menuitem"]')) {
            if (gorunur(mi) && KALDIR_SECENEK.some((m) => metin(mi).includes(m))) return mi;
          }
          return null;
        };
        let kaldirSecenegi = await kosulBekle(menuOgesiAra, 3000);
        if (!kaldirSecenegi) {
          kaldirSecenegi = metniUyusanBul(
            [document],
            'a, [role="button"], .artdeco-dropdown__content li, .artdeco-dropdown__item, button, li',
            KALDIR_SECENEK
          );
        }
        if (!kaldirSecenegi) {
          escBas();
          karaListe.add(tetik);
          throw new Error('"Bağlantıyı kaldır" seçeneği bulunamadı');
        }

        // Tıklamadan ÖNCE görünür "kaldır" düğmelerinin fotoğrafını çek;
        // tıklamadan sonra YENİ beliren düğme onay düğmesidir
        const oncekiOnaylar = new Set(onayAdaylari());

        // Tıklamanın işlediğini gösteren işaretler: eski/yeni tip onay
        // penceresi açıldı, YENİ bir "kaldır" düğmesi belirdi ya da menü
        // kapandı (öğe görünmez oldu)
        const secimIsledi = () =>
          dialogBul().length > 0 ||
          !!onayAdaylari().find((el) => !oncekiOnaylar.has(el)) ||
          !document.contains(kaldirSecenegi) ||
          !gorunur(kaldirSecenegi);

        // Tıkla; tutmadıysa elemanın kendi click() metodunu ve üst
        // elemanları dene (React bazen handler'ı sarmalayıcıya bağlıyor)
        let hedef = kaldirSecenegi;
        let secimBasarili = false;
        for (let i = 0; i < 4 && hedef; i++) {
          tamTikla(hedef);
          if (await kosulBekle(secimIsledi, 1200)) { secimBasarili = true; break; }
          if (typeof hedef.click === 'function') hedef.click();
          if (await kosulBekle(secimIsledi, 800)) { secimBasarili = true; break; }
          hedef = hedef.parentElement;
        }
        if (!secimBasarili) {
          escBas();
          karaListe.add(tetik);
          throw new Error('"Bağlantıyı kaldır" tıklaması işlemedi (hedef: <' +
            kaldirSecenegi.tagName.toLowerCase() + '> "' + metin(kaldirSecenegi).slice(0, 30) + '")');
        }

        // Onay penceresini bekle (en fazla ~4 sn). Kayıttan bilinen yapı:
        // <dialog> içinde "Bağlantıyı kaldır" düğmesi. Yedek: tıklama
        // sonrası YENİ beliren "kaldır" düğmesi. Bazı arayüzler onay
        // sormadan direkt kaldırıyor — onu da başarı say.
        let onayBtn = null;
        let onaysizKaldirildi = false;
        await kosulBekle(() => {
          const dialoglar = dialogBul();
          if (dialoglar.length) {
            onayBtn = metniUyusanBul(dialoglar, 'button, [role="button"]', ONAY_BUTON);
            if (onayBtn) return true;
          }
          onayBtn = onayAdaylari().find((el) => !oncekiOnaylar.has(el)) || null;
          if (onayBtn) return true;
          if (kaldirmaGerceklesti(tetik)) { onaysizKaldirildi = true; return true; }
          return false;
        }, 3000);
        if (onayBtn) {
          tamTikla(onayBtn);
          // Onay penceresi kapanana kadar bekle; tutmadıysa click() dene
          const onayIsledi = () =>
            !document.contains(onayBtn) || !gorunur(onayBtn) || kaldirmaGerceklesti(tetik);
          if (!(await kosulBekle(onayIsledi, 1500))) {
            if (typeof onayBtn.click === 'function') onayBtn.click();
            await kosulBekle(onayIsledi, 1000);
          }
        } else if (!onaysizKaldirildi && !kaldirmaGerceklesti(tetik)) {
          escBas();
          karaListe.add(tetik);
          throw new Error('Onay düğmesi bulunamadı (tıklama sonrası yeni düğme belirmedi)');
        }

        kaldirilan++;
        toplamKaldirilan++;
        ustUsteHata = 0;
        sayacGuncelle();
        toplamiKaydet();
        durumYaz(`Çalışıyor… son işlem: ${kaldirilan}. bağlantı kaldırıldı.`);
        await rastgeleBekle();
      } catch (hata) {
        ustUsteHata++;
        hataKaydet(hata.message);
        console.warn('[Bağlantı Temizleyici] Hata: ' + hata.message + ' (' + ustUsteHata + '/5)');
        durumYaz('Hata: ' + hata.message + ' (' + ustUsteHata + '/5)');
        if (ustUsteHata >= 5) {
          durumYaz('Üst üste 5 hata alındı, durduruldu. "Hata Raporu Kopyala"ya basıp Claude\'a yapıştır.');
          taniModu();
          break;
        }
        await bekle(800);
      }
    }

    if (Number.isFinite(AYARLAR.maksKaldirma) && kaldirilan >= AYARLAR.maksKaldirma) {
      durumYaz(`Oturum limiti doldu (${AYARLAR.maksKaldirma}).`);
    }
    calisiyor = false;
  };

  // ---- Sayfa takibi (LinkedIn SPA olduğu için URL'yi izle) ----
  let sonDurumAktif = false;
  setInterval(() => {
    const aktif = BAGLANTI_SAYFASI.test(location.pathname);
    if (aktif && !sonDurumAktif) {
      panelKur();
      toplamiYukle();
      sayacGuncelle();
      geriSayimBaslat();
    } else if (!aktif && sonDurumAktif) {
      durdurIstegi = true;
      geriSayimIptal();
      panelKaldir();
    }
    sonDurumAktif = aktif;
  }, 1000);
})();
