const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- VERİTABANI MODELLERİ ---
const urunSchema = new mongoose.Schema({
    ad: String,
    fiyat: Number,
    maliyet: Number,
    stok: Number
});
const Urun = mongoose.model('Urun', urunSchema);

const siparisSchema = new mongoose.Schema({
    masaNo: String,
    urunAd: String,
    fiyat: Number,
    maliyet: Number,
    durum: { type: String, default: 'bekliyor' }, // bekliyor, teslim_edildi, tamamlandi
    zaman: { type: String, default: () => new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) },
    tarih: { type: Date, default: Date.now }
});
const Siparis = mongoose.model('Siparis', siparisSchema);

const raporSchema = new mongoose.Schema({
    tarih: { type: Date, default: Date.now },
    toplamCiro: Number,
    toplamKar: Number,
    siparisSayisi: Number
});
const Rapor = mongoose.model('Rapor', raporSchema);

// --- CONFIG & MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

mongoose.connect('mongodb://localhost:27017/neonKafe')
    .then(() => console.log("✅ MongoDB Bağlantısı Başarılı"))
    .catch(err => console.error("❌ Bağlantı Hatası:", err));

// --- ROUTER (SAYFALAR) ---

// Müşteri Menü Sayfası
app.get('/menu/:masaNo', async (req, res) => {
    try {
        const urunler = await Urun.find();
        res.render('menu', { 
            masaNo: req.params.masaNo, 
            urunler: urunler 
        });
    } catch (err) {
        res.status(500).send("Hata oluştu.");
    }
});

// Admin Paneli
app.get('/admin', async (req, res) => {
    try {
        const urunler = await Urun.find();
        const aktifSiparisler = await Siparis.find({ durum: { $ne: 'tamamlandi' } });
        res.render('admin', { 
            urunler: urunler, 
            siparisler: aktifSiparisler,
            adminPass: "12345" // Burayı değiştirebilirsin
        });
    } catch (err) {
        res.status(500).send("Hata oluştu.");
    }
});

// Ürün Ekleme (POST)
app.post('/admin/urun-ekle', async (req, res) => {
    try {
        await Urun.create(req.body);
        res.redirect('/admin');
    } catch (err) {
        res.send("Hata: " + err);
    }
});

// --- SOCKET.IO MANTIĞI (CANLI AKIŞ) ---

io.on('connection', (socket) => {
    console.log('Sinyal Bağlantısı:', socket.id);

    // Rakamları Admin'e Gönderen Yardımcı Fonksiyon
    const rakamlariGuncelle = async () => {
        const bugun = new Date();
        bugun.setHours(0,0,0,0);
        const siparisler = await Siparis.find({ tarih: { $gte: bugun } });
        const ciro = siparisler.reduce((sum, s) => sum + (s.fiyat || 0), 0);
        const kar = siparisler.reduce((sum, s) => sum + ((s.fiyat || 0) - (s.maliyet || 0)), 0);
        io.emit('rakamGuncelleme', { ciro, kar });
    };

    // 1. Yeni Sipariş Geldiğinde
    socket.on('yeni_siparis', async (data) => {
        for (let item of data.urunler) {
            const urunBilgi = await Urun.findOne({ ad: item.ad });
            if (urunBilgi) {
                const yeniSiparis = await Siparis.create({
                    masaNo: data.masa,
                    urunAd: urunBilgi.ad,
                    fiyat: urunBilgi.fiyat,
                    maliyet: urunBilgi.maliyet,
                    durum: 'bekliyor'
                });
                
                // Mutfak ekranına (Admin) gönder
                io.emit('yeniSiparisBildirimi', {
                    _id: yeniSiparis._id,
                    masaNo: yeniSiparis.masaNo,
                    urunAd: yeniSiparis.urunAd,
                    zaman: yeniSiparis.zaman
                });

                // Stok düş
                await Urun.updateOne({ _id: urunBilgi._id }, { $inc: { stok: -1 } });
            }
        }
        rakamlariGuncelle();
        io.emit('masa_durum_guncelle', { masaNo: data.masa, durum: 'dolu' });
    });

    // 2. Sipariş Teslim Edildiğinde
    socket.on('siparis_teslim_edildi', async (id) => {
        if (!mongoose.Types.ObjectId.isValid(id)) return; // ID Hatasını Önler
        await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
        io.emit('siparis_teslim_onayi', id);
    });

    // 3. Masa Detayı İsteği (Adisyon Açma)
    socket.on('masa_detay_iste', async (masaNo) => {
        const adisyon = await Siparis.find({ masaNo: masaNo, durum: { $ne: 'tamamlandi' } });
        socket.emit('masa_detay_verisi', { masaNo, siparisler: adisyon });
    });

    // 4. Hesap Kapatma (Arşivleme)
    socket.on('hesap_kapat', async (masaNo) => {
        await Siparis.updateMany({ masaNo: masaNo }, { durum: 'tamamlandi' });
        io.emit('masa_sifirla', masaNo);
        rakamlariGuncelle();
    });

    // 5. Ürün Silme
    socket.on('urun_sil', async (id) => {
        if (mongoose.Types.ObjectId.isValid(id)) {
            await Urun.findByIdAndDelete(id);
        }
    });

    // 6. Stok Güncelleme
    socket.on('stok_guncelle', async (data) => {
        if (mongoose.Types.ObjectId.isValid(data.id)) {
            await Urun.findByIdAndUpdate(data.id, { stok: data.stok });
        }
    });

    // İlk girişte rakamları gönder
    rakamlariGuncelle();
});

// --- SERVER BAŞLAT ---
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Neon Kafe Sistemi http://localhost:${PORT} üzerinde çalışıyor.`);
});