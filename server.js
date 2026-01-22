const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000 
});

// --- VERİTABANI BAĞLANTISI ---
const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/neonKafe';
mongoose.connect(mongoURI)
    .then(() => console.log("✅ MongoDB Bağlantısı Başarılı"))
    .catch(err => console.error("❌ MongoDB Bağlantı Hatası:", err));

// --- MODELLER ---
const urunSchema = new mongoose.Schema({
    ad: String, fiyat: Number, maliyet: Number, stok: { type: Number, default: 0 }
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

// --- MIDDLEWARE & VIEW ENGINE ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- ROUTES ---

// Admin Paneli (İlk Yükleme)
app.get('/admin', async (req, res) => {
    try {
        const urunler = await Urun.find();
        const aktifSiparisler = await Siparis.find({ durum: { $ne: 'tamamlandi' } }).sort({ tarih: -1 });
        res.render('admin', { urunler, siparisler: aktifSiparisler });
    } catch (err) {
        res.status(500).send("Admin Paneli Yüklenemedi.");
    }
});

// YEDEK API: Mutfak akışı için JSON veri sağlar
app.get('/admin-api/aktif-siparisler', async (req, res) => {
    try {
        const aktifSiparisler = await Siparis.find({ durum: { $ne: 'tamamlandi' } }).sort({ tarih: -1 });
        res.json(aktifSiparisler);
    } catch (err) {
        res.status(500).json({ hata: "Veri alınamadı" });
    }
});

// Menü Sayfası
app.get('/menu', async (req, res) => {
    try {
        const urunler = await Urun.find();
        res.render('menu', { urunler });
    } catch (err) {
        res.status(500).send("Menü Yüklenemedi.");
    }
});

// Ürün Ekleme (Admin)
app.post('/admin/urun-ekle', async (req, res) => {
    try {
        await Urun.create(req.body);
        res.redirect('/admin');
    } catch (err) {
        res.status(500).send("Ürün eklenemedi.");
    }
});

// --- SOCKET.IO AKIŞI ---
io.on('connection', (socket) => {
    const rakamlariGuncelle = async () => {
        try {
            const bugun = new Date(); bugun.setHours(0,0,0,0);
            const siparisler = await Siparis.find({ tarih: { $gte: bugun }, durum: { $ne: 'iptal' } });
            const ciro = siparisler.reduce((sum, s) => sum + (s.fiyat || 0), 0);
            const kar = siparisler.reduce((sum, s) => sum + ((s.fiyat || 0) - (s.maliyet || 0)), 0);
            io.emit('rakamGuncelleme', { ciro, kar });
        } catch (e) { console.log("Rakam hatası:", e); }
    };

    socket.on('yeni_siparis', async (data) => {
        try {
            for (let item of data.urunler) {
                const urunBilgisi = await Urun.findOne({ ad: item.ad });
                const yeni = await Siparis.create({
                    masaNo: data.masa,
                    urunAd: item.ad,
                    fiyat: item.fiyat || (urunBilgisi ? urunBilgisi.fiyat : 0),
                    maliyet: urunBilgisi ? urunBilgisi.maliyet : 0,
                    durum: 'bekliyor'
                });
                io.emit('yeniSiparisBildirimi', yeni);
                if (urunBilgisi) await Urun.updateOne({ _id: urunBilgisi._id }, { $inc: { stok: -1 } });
            }
            rakamlariGuncelle();
        } catch (err) { console.error("Sipariş hatası:", err); }
    });

    socket.on('siparis_teslim_edildi', async (id) => {
        try {
            await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
            io.emit('siparis_teslim_onayi', id);
        } catch (err) { console.error("Teslim hatası:", err); }
    });

    socket.on('masa_detay_iste', async (masaNo) => {
        try {
            const siparisler = await Siparis.find({ masaNo, durum: { $ne: 'tamamlandi' } });
            socket.emit('masa_detay_verisi', { masaNo, siparisler });
        } catch (err) { console.error("Masa detay hatası:", err); }
    });

    socket.on('hesap_kapat', async (masaNo) => {
        try {
            await Siparis.updateMany({ masaNo, durum: { $ne: 'tamamlandi' } }, { durum: 'tamamlandi' });
            io.emit('masa_sifirla', masaNo);
            rakamlariGuncelle();
        } catch (err) { console.error("Hesap hatası:", err); }
    });

    socket.on('gunu_kapat_onay', async () => {
        try {
            await Siparis.updateMany({ durum: { $ne: 'tamamlandi' } }, { durum: 'tamamlandi' });
            io.emit('ekrani_temizle');
            rakamlariGuncelle();
        } catch (err) { console.error("Günü kapatma hatası:", err); }
    });

    rakamlariGuncelle();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Sunucu aktif.`); });