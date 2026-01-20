// Path: server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { Urun, Siparis, Rapor } = require('./models/Kafe'); // Model dosyanız
// --- AYARLAR ---
const ADMIN_PASS = process.env.ADMIN_PASS || '12345';

// Senin yeni oluşturduğun neon_admin kullanıcısı ve şifresiyle güncellenmiş adres
const MONGO_URI = "mongodb+srv://neon_admin:Kafe2026@bonus.x39zlzq.mongodb.net/NeonKafe?retryWrites=true&w=majority";

// --- MONGODB BAĞLANTISI ---
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => {
    console.log("✅ MongoDB Atlas Bağlantısı Başarılı");
    console.log("📂 Veritabanı: NeonKafe");
})
.catch(err => {
    console.error("❌ Veritabanı Hatası:", err.message);
    console.log("👉 İpucu: Şifrenin veya IP izinlerinin (0.0.0.0/0) Atlas panelinde doğru olduğunu kontrol et.");
});
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- YARDIMCI FONKSİYONLAR ---
async function rakamlariGuncelle() {
    try {
        const raporlar = await Rapor.find();
        let toplamCiro = 0;
        let toplamKar = 0;

        raporlar.forEach(r => {
            toplamCiro += parseFloat(r.tutar || 0);
            toplamKar += parseFloat(r.kar || 0);
        });

        io.emit('rakamGuncelleme', { ciro: toplamCiro, kar: toplamKar });
    } catch (err) {
        console.error("Rakam güncelleme hatası:", err);
    }
}

// --- ROTALAR ---

// Ana Sayfa ve Masa Menüsü
app.get(['/', '/menu/:masaNo'], async (req, res) => {
    try {
        const masaNo = req.params.masaNo || '0';
        const gecerliUrunler = await Urun.find({ stok: { $gt: 0 } });
        res.render('menu', { masaNo, urunler: gecerliUrunler });
    } catch (err) {
        res.status(500).send("Sunucu Hatası");
    }
});

// Admin Paneli
app.get('/admin', async (req, res) => {
    try {
        const urunler = await Urun.find();
        const siparisler = await Siparis.find();
        res.render('admin', { urunler, siparisler, adminPass: ADMIN_PASS });
    } catch (err) {
        res.status(500).send("Admin Paneli Hatası");
    }
});

// Ürün Ekleme (Admin)
app.post('/admin/urun-ekle', async (req, res) => {
    const { ad, fiyat, maliyet, stok } = req.body;
    if (!ad) return res.redirect('/admin');

    try {
        await Urun.create({
            ad,
            fiyat: parseFloat(fiyat) || 0,
            maliyet: parseFloat(maliyet) || 0,
            stok: parseInt(stok) || 0
        });
        res.redirect('/admin');
    } catch (err) {
        console.error("Ürün ekleme hatası:", err);
        res.redirect('/admin');
    }
});

// --- SOCKET.IO İLETİŞİMİ GÜNCELLEME (TAM HALİ) ---
io.on('connection', (socket) => {

    // Admin Paneli Açıldığında veya Yenilendiğinde
    socket.on('admin_giris', async () => {
        try {
            await rakamlariGuncelle();
            
            // Veritabanındaki tüm aktif (henüz raporlanmamış) siparişleri getir
            const aktifler = await Siparis.find().sort({ _id: 1 });
            
            aktifler.forEach(s => {
                // MongoDB _id'sini frontend'in beklediği 'id' formatına çeviriyoruz
                const siparisData = s.toObject();
                siparisData.id = s._id.toString(); 
                socket.emit('yeniSiparisBildirimi', siparisData);
            });

            // Mevcut siparişlere göre masaların doluluk durumunu belirle
            const doluMasalar = [...new Set(aktifler.map(s => s.masaNo))];
            doluMasalar.forEach(mNo => {
                socket.emit('masa_durum_guncelle', { masaNo: mNo, durum: 'dolu' });
            });
        } catch (err) {
            console.error("Admin giriş yükleme hatası:", err);
        }
    });

    socket.on('urun_sil', async (id) => {
        await Urun.findByIdAndDelete(id);
    });

    socket.on('stok_guncelle', async (data) => {
        await Urun.findByIdAndUpdate(data.id, { stok: data.stok });
    });

    // Müşteri Menüsünden Yeni Sipariş Geldiğinde
    socket.on('yeni_siparis', async (data) => {
        const { masa, urunler: sepet } = data;

        for (const item of sepet) {
            const urunDb = await Urun.findOne({ ad: item.ad });
            if (urunDb) {
                // Stok Kontrolü ve Düşümü
                if (urunDb.stok > 0) {
                    urunDb.stok -= 1;
                    await urunDb.save();
                }

                // Siparişi MongoDB'ye Kaydet
                const yeniSiparis = await Siparis.create({
                    masaNo: masa.toString(),
                    urunAd: item.ad,
                    fiyat: urunDb.fiyat,
                    maliyet: urunDb.maliyet,
                    zaman: new Date().toLocaleTimeString('tr-TR'),
                    durum: 'bekliyor'
                });

                // Frontend için ID eşlemesi yapıp tüm adminlere gönder
                const emitData = yeniSiparis.toObject();
                emitData.id = yeniSiparis._id.toString();

                io.emit('yeniSiparisBildirimi', emitData);
                io.emit('masa_durum_guncelle', { masaNo: masa, durum: 'dolu' });
            }
        }
    });

// Mutfak "Teslim Et"e Bastığında
    socket.on('siparis_teslim_edildi', async (id) => {
        // --- BU KONTROLÜ EKLE (GÜVENLİK) ---
        if (!id || id === 'undefined' || id.length !== 24) {
            console.error("❌ Geçersiz ID engellendi:", id);
            return;
        }
        // ----------------------------------

        try {
            await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
            io.emit('siparis_teslim_onayi', id); 
        } catch (err) {
            console.error("Teslimat güncelleme hatası:", err);
        }
    });
    socket.on('masa_detay_iste', async (masaNo) => {
        const masaninSiparisleri = await Siparis.find({ masaNo: masaNo.toString() });
        socket.emit('masa_detay_verisi', { masaNo, siparisler: masaninSiparisleri });
    });

    // Hesap Kapatma (Siparişleri Rapora Aktarır ve Masayı Boşaltır)
    socket.on('hesap_kapat', async (masaNo) => {
        const masaninSiparisleri = await Siparis.find({ masaNo: masaNo.toString() });
        
        if (masaninSiparisleri.length > 0) {
            for (const s of masaninSiparisleri) {
                await Rapor.create({
                    tarih: new Date().toLocaleDateString('tr-TR'),
                    saat: new Date().toLocaleTimeString('tr-TR'),
                    masa: s.masaNo,
                    urun: s.urunAd,
                    tutar: parseFloat(s.fiyat),
                    kar: parseFloat(s.fiyat) - parseFloat(s.maliyet || 0)
                });
            }
            // Masadaki aktif siparişleri sil ve arayüzü güncelle
            await Siparis.deleteMany({ masaNo: masaNo.toString() });
            await rakamlariGuncelle();
            
            io.emit('masa_sifirla', masaNo);
            io.emit('masa_durum_guncelle', { masaNo: masaNo, durum: 'bos' });
        }
    });

    // Gün Sonu İşlemi
    socket.on('gunu_kapat', async () => {
        try {
            const tumRaporlar = await Rapor.find();
            if (tumRaporlar.length === 0) return;

            const simdi = new Date();
            const dosyaAdi = `Rapor-${simdi.getDate()}-${simdi.getMonth() + 1}-${simdi.getFullYear()}.txt`;
            const klasorYolu = path.join(__dirname, 'hesap');

            if (!fs.existsSync(klasorYolu)) fs.mkdirSync(klasorYolu);

            let icerik = `--- GÜN SONU RAPORU ---\n\n`;
            let ciro = 0, kar = 0;
            
            tumRaporlar.forEach(r => {
                icerik += `[${r.saat}] Masa ${r.masa}: ${r.urun} | ${r.tutar} TL\n`;
                ciro += r.tutar; 
                kar += r.kar;
            });
            
            icerik += `\nTOPLAM CİRO: ${ciro.toFixed(2)} TL\nTOPLAM KAR: ${kar.toFixed(2)} TL`;

            fs.writeFileSync(path.join(klasorYolu, dosyaAdi), icerik);
            
            // Tüm geçici verileri temizle
            await Rapor.deleteMany({});
            await Siparis.deleteMany({});
            
            await rakamlariGuncelle();
            io.emit('gun_kapatildi_onayi');
            // Tüm ekranlardaki masaları boşalt
            for(let i=1; i<=24; i++) {
                io.emit('masa_durum_guncelle', { masaNo: i, durum: 'bos' });
            }
        } catch (err) {
            console.error("Günü kapatma hatası:", err);
        }
    });
});
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Sistem Hazır: Port ${PORT}`);
});

