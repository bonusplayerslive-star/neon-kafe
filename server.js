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
const MONGO_URI = "mongodb+srv://neon_admin:Kafe2026@bonus.x39zlzq.mongodb.net/NeonKafe?retryWrites=true&w=majority";
// --- MONGODB BAĞLANTISI ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Atlas Bağlantısı Başarılı"))
    .catch(err => console.error("❌ Veritabanı Hatası:", err));

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

// --- SOCKET.IO İLETİŞİMİ ---
io.on('connection', (socket) => {

    socket.on('admin_giris', async () => {
        await rakamlariGuncelle();
        const aktifler = await Siparis.find();
        
        aktifler.forEach(s => socket.emit('yeniSiparisBildirimi', s));

        const doluMasalar = [...new Set(aktifler.map(s => s.masaNo))];
        doluMasalar.forEach(mNo => {
            socket.emit('masa_durum_guncelle', { masaNo: mNo, durum: 'dolu' });
        });
    });

    socket.on('urun_sil', async (id) => {
        await Urun.findByIdAndDelete(id);
    });

    socket.on('stok_guncelle', async (data) => {
        await Urun.findByIdAndUpdate(data.id, { stok: data.stok });
    });

    socket.on('yeni_siparis', async (data) => {
        const { masa, urunler: sepet } = data;

        for (const item of sepet) {
            const urunDb = await Urun.findOne({ ad: item.ad });
            if (urunDb) {
                // Stok düşür
                if (urunDb.stok > 0) {
                    urunDb.stok -= 1;
                    await urunDb.save();
                }

                const yeniSiparis = await Siparis.create({
                    masaNo: masa,
                    urunAd: item.ad,
                    fiyat: urunDb.fiyat,
                    maliyet: urunDb.maliyet,
                    zaman: new Date().toLocaleTimeString('tr-TR'),
                    durum: 'bekliyor'
                });

                io.emit('yeniSiparisBildirimi', yeniSiparis);
                io.emit('masa_durum_guncelle', { masaNo: masa, durum: 'dolu' });
            }
        }
    });

    socket.on('siparis_teslim_edildi', async (id) => {
        await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
    });

    socket.on('masa_detay_iste', async (masaNo) => {
        const masaninSiparisleri = await Siparis.find({ masaNo: masaNo.toString() });
        socket.emit('masa_detay_verisi', { masaNo, siparisler: masaninSiparisleri });
    });

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
            await Siparis.deleteMany({ masaNo: masaNo.toString() });
            await rakamlariGuncelle();
            io.emit('masa_sifirla', masaNo);
            io.emit('masa_durum_guncelle', { masaNo: masaNo, durum: 'bos' });
        }
    });

    socket.on('gunu_kapat', async () => {
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
        
        // Verileri temizle
        await Rapor.deleteMany({});
        await Siparis.deleteMany({});
        
        await rakamlariGuncelle();
        io.emit('gun_kapatildi_onayi');
        io.emit('tum_masalari_temizle');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Sistem Hazır: Port ${PORT}`);
});
