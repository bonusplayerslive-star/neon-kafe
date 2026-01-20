const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { Urun, Siparis, Rapor } = require('./models/Kafe');

const ADMIN_PASS = process.env.ADMIN_PASS || '12345';
const MONGO_URI = "mongodb+srv://neon_admin:Kafe2026@bonus.x39zlzq.mongodb.net/NeonKafe?retryWrites=true&w=majority";

// MongoDB Bağlantısı (Güncel Driver uyarısı için seçenekler kaldırıldı)
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB Atlas Bağlantısı Başarılı");
        console.log("📂 Veritabanı: NeonKafe");
    })
    .catch(err => console.error("❌ Veritabanı Hatası:", err.message));

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
app.get(['/', '/menu/:masaNo'], async (req, res) => {
    try {
        const masaNo = req.params.masaNo || '0';
        const gecerliUrunler = await Urun.find({ stok: { $gt: 0 } });
        res.render('menu', { masaNo, urunler: gecerliUrunler });
    } catch (err) {
        res.status(500).send("Sunucu Hatası");
    }
});

app.get('/admin', async (req, res) => {
    try {
        const urunler = await Urun.find();
        const siparisler = await Siparis.find().sort({ _id: -1 });
        res.render('admin', { urunler, siparisler, adminPass: ADMIN_PASS });
    } catch (err) {
        res.status(500).send("Admin Paneli Hatası");
    }
});

app.post('/admin/urun-ekle', async (req, res) => {
    try {
        const { ad, fiyat, maliyet, stok } = req.body;
        await Urun.create({
            ad,
            fiyat: parseFloat(fiyat) || 0,
            maliyet: parseFloat(maliyet) || 0,
            stok: parseInt(stok) || 0
        });
        res.redirect('/admin');
    } catch (err) {
        res.redirect('/admin');
    }
});

// --- SOCKET.IO İLETİŞİMİ ---
io.on('connection', (socket) => {

    // Admin bağlandığında mutfak akışını doldur
    socket.on('admin_giris', async () => {
        try {
            await rakamlariGuncelle();
            
            // Sadece bekleyen siparişleri gönder
            const bekleyenler = await Siparis.find({ durum: 'bekliyor' }).sort({ _id: 1 });
            
            bekleyenler.forEach(s => {
                const siparisData = s.toObject();
                siparisData.id = s._id.toString(); 
                socket.emit('yeniSiparisBildirimi', siparisData);
            });

            // Dolu masaları işaretle
            const aktifSiparisler = await Siparis.find();
            const doluMasalar = [...new Set(aktifSiparisler.map(s => s.masaNo))];
            doluMasalar.forEach(mNo => {
                socket.emit('masa_durum_guncelle', { masaNo: mNo, durum: 'dolu' });
            });
        } catch (err) {
            console.error("Admin yükleme hatası:", err);
        }
    });

    // Yeni sipariş geldiğinde
    socket.on('yeni_siparis', async (data) => {
        try {
            const { masa, urunler: sepet } = data;
            for (const item of sepet) {
                const urunDb = await Urun.findOne({ ad: item.ad });
                if (urunDb) {
                    if (urunDb.stok > 0) {
                        urunDb.stok -= 1;
                        await urunDb.save();
                    }

                    const yeniSiparis = await Siparis.create({
                        masaNo: masa.toString(),
                        urunAd: item.ad,
                        fiyat: urunDb.fiyat,
                        maliyet: urunDb.maliyet,
                        zaman: new Date().toLocaleTimeString('tr-TR'),
                        durum: 'bekliyor'
                    });

                    const emitData = yeniSiparis.toObject();
                    emitData.id = yeniSiparis._id.toString();

                    io.emit('yeniSiparisBildirimi', emitData);
                    io.emit('masa_durum_guncelle', { masaNo: masa, durum: 'dolu' });
                }
            }
        } catch (err) {
            console.error("Sipariş kayıt hatası:", err);
        }
    });

    // HATA VEREN KRİTİK NOKTA DÜZELTİLDİ
    socket.on('siparis_teslim_edildi', async (id) => {
        // ID kontrolü: undefined veya geçersiz format gelirse işlemi durdur
        if (!id || id === "undefined" || id.length !== 24) {
            console.log("⚠️ Geçersiz Sipariş ID'si: ", id);
            return;
        }

        try {
            const guncel = await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
            if (guncel) {
                io.emit('siparis_teslim_onayi', id);
            }
        } catch (err) {
            console.error("Teslimat veritabanı hatası:", err.message);
        }
    });

    socket.on('masa_detay_iste', async (masaNo) => {
        try {
            const masaninSiparisleri = await Siparis.find({ masaNo: masaNo.toString() });
            socket.emit('masa_detay_verisi', { masaNo, siparisler: masaninSiparisleri });
        } catch (err) { console.error(err); }
    });

    socket.on('hesap_kapat', async (masaNo) => {
        try {
            const masaninSiparisleri = await Siparis.find({ masaNo: masaNo.toString() });
            if (masaninSiparisleri.length > 0) {
                for (const s of masaninSiparisleri) {
                    await Rapor.create({
                        tarih: new Date().toLocaleDateString('tr-TR'),
                        saat: new Date().toLocaleTimeString('tr-TR'),
                        masa: s.masaNo,
                        urun: s.urunAd,
                        tutar: s.fiyat,
                        kar: s.fiyat - (s.maliyet || 0)
                    });
                }
                await Siparis.deleteMany({ masaNo: masaNo.toString() });
                await rakamlariGuncelle();
                io.emit('masa_sifirla', masaNo);
                io.emit('masa_durum_guncelle', { masaNo: masaNo, durum: 'bos' });
            }
        } catch (err) { console.error(err); }
    });

    socket.on('urun_sil', async (id) => { 
        if (id && id.length === 24) await Urun.findByIdAndDelete(id); 
    });

    socket.on('stok_guncelle', async (data) => { 
        if (data.id && data.id.length === 24) await Urun.findByIdAndUpdate(data.id, { stok: data.stok }); 
    });
});

const PORT = process.env.PORT || 10000;
http.listen(PORT, () => {
    console.log(`🚀 Sistem Hazır: Port ${PORT}`);
});