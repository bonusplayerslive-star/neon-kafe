// Path: server.js
const ADMIN_USER = process.env.ADMIN_USER || ;
const ADMIN_PASS = process.env.ADMIN_PASS || ;
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');

// --- VERİTABANI AYARLARI (Lowdb) ---
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('db.json');
const db = low(adapter);

// Veritabanı Varsayılan Yapısı
db.defaults({ urunler: [], siparisler: [], raporlar: [] }).write();

app.set('view engine', 'ejs');

// --- MIDDLEWARE ---
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- YARDIMCI FONKSİYONLAR ---
function rakamlariGuncelle() {
    const raporlar = db.get('raporlar').value() || [];
    let toplamCiro = 0;
    let toplamKar = 0;

    raporlar.forEach(r => {
        toplamCiro += parseFloat(r.tutar || 0);
        toplamKar += parseFloat(r.kar || 0);
    });

    io.emit('rakamGuncelleme', { ciro: toplamCiro, kar: toplamKar });
}

// --- ROTALAR ---
app.get('/', (req, res) => res.redirect('/admin'));

app.get('/admin', (req, res) => {
    const urunler = db.get('urunler').value();
    const siparisler = db.get('siparisler').value();
    res.render('admin', { urunler, siparisler });
});

app.get('/menu/:masaNo', (req, res) => {
    const tumUrunler = db.get('urunler').value();
    const gecerliUrunler = tumUrunler.filter(u => u.ad && u.fiyat > 0);
    res.render('menu', { masaNo: req.params.masaNo, urunler: gecerliUrunler });
});

app.post('/admin/urun-ekle', (req, res) => {
    const { ad, fiyat, maliyet, stok } = req.body;
    if (!ad) return res.redirect('/admin');
    db.get('urunler').push({ 
        id: Date.now().toString(), 
        ad: ad, 
        fiyat: parseFloat(fiyat) || 0, 
        maliyet: parseFloat(maliyet) || 0, 
        stok: parseInt(stok) || 0 
    }).write();
    res.redirect('/admin');
});

// --- SOCKET.IO İLETİŞİMİ ---
io.on('connection', (socket) => {
    
    // Admin girişi
    socket.on('admin_giris', () => {
        rakamlariGuncelle();
        const aktifler = db.get('siparisler').value() || [];
        aktifler.forEach(s => socket.emit('yeniSiparisBildirimi', s));
        
        const doluMasalar = [...new Set(aktifler.map(s => s.masaNo))];
        doluMasalar.forEach(mNo => {
            socket.emit('masa_durum_guncelle', { masaNo: mNo, durum: 'dolu' });
        });
    });

    // Ürün Silme
    socket.on('urun_sil', (id) => {
        db.get('urunler').remove({ id: id }).write();
    });

    // Stok Güncelleme
    socket.on('stok_guncelle', (data) => {
        db.get('urunler').find({ id: data.id }).assign({ stok: data.stok }).write();
    });

    // Müşteriden gelen sipariş
    socket.on('yeni_siparis', (data) => {
        const { masa, urunler: sepet } = data;
        
        sepet.forEach(item => {
            const urunDb = db.get('urunler').find({ ad: item.ad }).value();
            if (urunDb) {
                if (urunDb.stok > 0) {
                    db.get('urunler').find({ ad: item.ad }).assign({ stok: urunDb.stok - 1 }).write();
                }

                const yeniSiparis = { 
                    id: (Date.now() + Math.random()).toString(), 
                    masaNo: masa, 
                    urunAd: item.ad,
                    fiyat: urunDb.fiyat,
                    maliyet: urunDb.maliyet,
                    zaman: new Date().toLocaleTimeString('tr-TR'),
                    durum: 'bekliyor'
                };

                db.get('siparisler').push(yeniSiparis).write();
                io.emit('yeniSiparisBildirimi', yeniSiparis);
                io.emit('masa_durum_guncelle', { masaNo: masa, durum: 'dolu' });
            }
        });
    });

    socket.on('siparis_teslim_edildi', (id) => {
        db.get('siparisler').find({ id: id }).assign({ durum: 'teslim_edildi' }).write();
    });

    socket.on('masa_detay_iste', (masaNo) => {
        const masaninSiparisleri = db.get('siparisler').filter({ masaNo: masaNo.toString() }).value();
        socket.emit('masa_detay_verisi', { masaNo, siparisler: masaninSiparisleri });
    });

    socket.on('hesap_kapat', (masaNo) => {
        const masaninSiparisleri = db.get('siparisler').filter({ masaNo: masaNo.toString() }).value();
        if (masaninSiparisleri.length > 0) {
            masaninSiparisleri.forEach(s => {
                db.get('raporlar').push({
                    tarih: new Date().toLocaleDateString('tr-TR'),
                    saat: new Date().toLocaleTimeString('tr-TR'),
                    masa: s.masaNo,
                    urun: s.urunAd,
                    tutar: parseFloat(s.fiyat),
                    kar: parseFloat(s.fiyat) - parseFloat(s.maliyet || 0)
                }).write();
            });
            db.get('siparisler').remove({ masaNo: masaNo.toString() }).write();
            rakamlariGuncelle();
            io.emit('masa_sifirla', masaNo);
            io.emit('masa_durum_guncelle', { masaNo: masaNo, durum: 'bos' });
        }
    });

    socket.on('gunu_kapat', () => {
        const tumRaporlar = db.get('raporlar').value();
        if (!tumRaporlar || tumRaporlar.length === 0) return;

        const simdi = new Date();
        const dosyaAdi = `Rapor-${simdi.getDate()}-${simdi.getMonth() + 1}-${simdi.getFullYear()}.txt`;
        const klasorYolu = path.join(__dirname, 'hesap');

        if (!fs.existsSync(klasorYolu)) fs.mkdirSync(klasorYolu);

        let icerik = `--- GÜN SONU RAPORU ---\n\n`;
        let ciro = 0, kar = 0;
        tumRaporlar.forEach(r => {
            icerik += `[${r.saat}] Masa ${r.masa}: ${r.urun} | ${r.tutar} TL\n`;
            ciro += r.tutar; kar += r.kar;
        });
        icerik += `\nTOPLAM CİRO: ${ciro.toFixed(2)} TL\nTOPLAM KAR: ${kar.toFixed(2)} TL`;

        fs.writeFileSync(path.join(klasorYolu, dosyaAdi), icerik);
        db.set('raporlar', []).write();
        db.set('siparisler', []).write();
        rakamlariGuncelle();
        io.emit('gun_kapatildi_onayi');
        io.emit('tum_masalari_temizle');
    });
});

// --- RENDER PORT AYARI ---
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Sistem Hazır: Port ${PORT}`);
});