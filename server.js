const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { Urun, Siparis, Rapor } = require('./models/Kafe');

// --- AYARLAR ---
const ADMIN_PASS = process.env.ADMIN_PASS || '12345';
const MONGO_URI = "mongodb+srv://neon_admin:Kafe2026@bonus.x39zlzq.mongodb.net/NeonKafe?retryWrites=true&w=majority";

// --- MONGODB BAĞLANTISI ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Atlas Bağlantısı Başarılı"))
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

    // Admin Paneli Açıldığında: Mevcut bekleyen siparişleri tek tek gönderir
    socket.on('admin_giris', async () => {
        try {
            await rakamlariGuncelle();
            
            // Sadece teslim edilmemiş (bekleyen) siparişleri getiriyoruz
            const bekleyenSiparisler = await Siparis.find({ durum: 'bekliyor' }).sort({ _id: 1 });
            
            bekleyenSiparisler.forEach(s => {
                const siparisData = s.toObject();
                siparisData.id = s._id.toString(); 
                socket.emit('yeniSiparisBildirimi', siparisData);
            });

            // Masaların doluluk durumunu belirle
            const aktifSiparisler = await Siparis.find();
            const doluMasalar = [...new Set(aktifSiparisler.map(s => s.masaNo))];
            doluMasalar.forEach(mNo => {
                socket.emit('masa_durum_guncelle', { masaNo: mNo, durum: 'dolu' });
            });
        } catch (err) {
            console.error("Admin giriş yükleme hatası:", err);
        }
    });

    // Müşteri Menüsünden Yeni Sipariş Geldiğinde: Her ürünü ayrı bir sipariş kartı olarak basar
    socket.on('yeni_siparis', async (data) => {
        const { masa, urunler: sepet } = data;

        for (const item of sepet) {
            const urunDb = await Urun.findOne({ ad: item.ad });
            if (urunDb) {
                // Stok düşümü
                if (urunDb.stok > 0) {
                    urunDb.stok -= 1;
                    await urunDb.save();
                }

                // Siparişi veritabanına kaydet
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

                // Tüm adminlere "yeni bir kart ekle" komutu gönderir
                io.emit('yeniSiparisBildirimi', emitData);
                io.emit('masa_durum_guncelle', { masaNo: masa, durum: 'dolu' });
            }
        }
    });

    // Mutfak "Teslim Et"e bastığında kartı akıştan kaldırır ama adisyonda tutar
    socket.on('siparis_teslim_edildi', async (id) => {
        if (!id || id.length !== 24) return;
        try {
            await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
            io.emit('siparis_teslim_onayi', id); 
        } catch (err) {
            console.error("Teslimat hatası:", err);
        }
    });

    socket.on('masa_detay_iste', async (masaNo) => {
        const masaninSiparisleri = await Siparis.find({ masaNo: masaNo.toString() });
        socket.emit('masa_detay_verisi', { masaNo, siparisler: masaninSiparisleri });
    });

    // Hesap kapatıldığında siparişleri rapora aktarır ve temizler
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

    socket.on('urun_sil', async (id) => { await Urun.findByIdAndDelete(id); });
    socket.on('stok_guncelle', async (data) => { await Urun.findByIdAndUpdate(data.id, { stok: data.stok }); });

    // Gün sonu tüm verileri sıfırlar
    socket.on('gunu_kapat', async () => {
        try {
            await Rapor.deleteMany({});
            await Siparis.deleteMany({});
            await rakamlariGuncelle();
            io.emit('gun_kapatildi_onayi');
            for(let i=1; i<=24; i++) {
                io.emit('masa_durum_guncelle', { masaNo: i, durum: 'bos' });
            }
        } catch (err) { console.error(err); }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Sistem Hazır: Port ${PORT}`);
});