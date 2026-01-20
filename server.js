const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Socket bağlantı hatalarını önlemek için
});

// --- VERİTABANI MODELLERİ ---
const urunSchema = new mongoose.Schema({
    ad: String, fiyat: Number, maliyet: Number, stok: Number
});
const Urun = mongoose.model('Urun', urunSchema);

const siparisSchema = new mongoose.Schema({
    masaNo: String,
    urunAd: String,
    fiyat: Number,
    maliyet: Number,
    durum: { type: String, default: 'bekliyor' }, 
    zaman: { type: String, default: () => new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) },
    tarih: { type: Date, default: Date.now }
});
const Siparis = mongoose.model('Siparis', siparisSchema);

const raporSchema = new mongoose.Schema({
    tarih: { type: Date, default: Date.now },
    toplamCiro: Number, toplamKar: Number, siparisSayisi: Number
});
const Rapor = mongoose.model('Rapor', raporSchema);

// --- CONFIG & MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// MongoDB Atlas Bağlantısı
const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/neonKafe';
mongoose.connect(mongoURI)
    .then(() => console.log("✅ MongoDB Bağlantısı Başarılı"))
    .catch(err => console.error("❌ Bağlantı Hatası:", err));

// --- ROUTER ---
app.get('/admin', async (req, res) => {
    try {
        const urunler = await Urun.find();
        // Tamamlanmamış tüm siparişleri çek (Bekleyen ve Teslim edilenler dahil)
        const aktifSiparisler = await Siparis.find({ durum: { $ne: 'tamamlandi' } }).sort({ tarih: -1 });
        res.render('admin', { urunler, siparisler: aktifSiparisler, adminPass: "12345" });
    } catch (err) { res.status(500).send("Sistem Hatası"); }
});

app.post('/admin/urun-ekle', async (req, res) => {
    try { await Urun.create(req.body); res.redirect('/admin'); } catch (err) { res.send(err); }
});

// --- SOCKET.IO MANTIĞI ---
io.on('connection', (socket) => {
    const rakamlariGuncelle = async () => {
        const bugun = new Date(); bugun.setHours(0,0,0,0);
        const siparisler = await Siparis.find({ tarih: { $gte: bugun }, durum: { $ne: 'iptal' } });
        const ciro = siparisler.reduce((sum, s) => sum + (s.fiyat || 0), 0);
        const kar = siparisler.reduce((sum, s) => sum + ((s.fiyat || 0) - (s.maliyet || 0)), 0);
        io.emit('rakamGuncelleme', { ciro, kar });
    };

    socket.on('yeni_siparis', async (data) => {
        for (let item of data.urunler) {
            const urun = await Urun.findOne({ ad: item.ad });
            if (urun) {
                const yeni = await Siparis.create({
                    masaNo: data.masa, urunAd: urun.ad, fiyat: urun.fiyat,
                    maliyet: urun.maliyet, durum: 'bekliyor'
                });
                io.emit('yeniSiparisBildirimi', yeni);
                await Urun.updateOne({ _id: urun._id }, { $inc: { stok: -1 } });
            }
        }
        rakamlariGuncelle();
    });

    socket.on('siparis_teslim_edildi', async (id) => {
        await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
        io.emit('siparis_teslim_onayi', id);
    });

    socket.on('masa_detay_iste', async (masaNo) => {
        const adisyon = await Siparis.find({ masaNo, durum: { $ne: 'tamamlandi' } });
        socket.emit('masa_detay_verisi', { masaNo, siparisler: adisyon });
    });

    socket.on('hesap_kapat', async (masaNo) => {
        await Siparis.updateMany({ masaNo, durum: { $ne: 'tamamlandi' } }, { durum: 'tamamlandi' });
        io.emit('masa_sifirla', masaNo);
        rakamlariGuncelle();
    });

    // Günü Kapatma ve Raporlama
    socket.on('gunu_kapat_onay', async () => {
        const aktifler = await Siparis.find({ durum: { $ne: 'tamamlandi' } });
        if(aktifler.length > 0) {
            const ciro = aktifler.reduce((s, a) => s + a.fiyat, 0);
            const kar = aktifler.reduce((s, a) => s + (a.fiyat - a.maliyet), 0);
            await Rapor.create({ toplamCiro: ciro, toplamKar: kar, siparisSayisi: aktifler.length });
            await Siparis.updateMany({ durum: { $ne: 'tamamlandi' } }, { durum: 'tamamlandi' });
        }
        io.emit('ekrani_temizle');
        rakamlariGuncelle();
    });

    rakamlariGuncelle();
});

server.listen(process.env.PORT || 3000);