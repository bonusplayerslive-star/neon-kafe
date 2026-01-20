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
    pingTimeout: 60000 // Render için bağlantı süresini uzattık
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

// Admin Paneli
app.get('/admin', async (req, res) => {
    try {
        const urunler = await Urun.find();
        // Sadece ödemesi alınmamış (mutfak akışında durması gereken) siparişleri çek
        const aktifSiparisler = await Siparis.find({ durum: { $ne: 'tamamlandi' } }).sort({ tarih: -1 });
        res.render('admin', { urunler, siparisler: aktifSiparisler });
    } catch (err) {
        res.status(500).send("Admin Paneli Yüklenemedi: " + err.message);
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
    console.log('🔌 Yeni bir kullanıcı bağlandı:', socket.id);

    // Rakamları (Ciro/Kar) Güncelleyen Fonksiyon
    const rakamlariGuncelle = async () => {
        try {
            const bugun = new Date(); bugun.setHours(0,0,0,0);
            const siparisler = await Siparis.find({ tarih: { $gte: bugun }, durum: { $ne: 'iptal' } });
            const ciro = siparisler.reduce((sum, s) => sum + (s.fiyat || 0), 0);
            const kar = siparisler.reduce((sum, s) => sum + ((s.fiyat || 0) - (s.maliyet || 0)), 0);
            io.emit('rakamGuncelleme', { ciro, kar });
        } catch (e) { console.log("Rakam güncelleme hatası:", e); }
    };

    // YENİ SİPARİŞ GELDİĞİNDE
    socket.on('yeni_siparis', async (data) => {
        console.log(`📩 Masa ${data.masa} sipariş gönderdi.`);
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
                
                // Mutfak akışına anlık gönder (Burada io.emit kullanıyoruz ki herkes görsün)
                io.emit('yeniSiparisBildirimi', yeni);
                console.log(`✅ ${item.ad} mutfağa iletildi.`);
                
                // Stok düşür
                if (urunBilgisi) {
                    await Urun.updateOne({ _id: urunBilgisi._id }, { $inc: { stok: -1 } });
                }
            }
            rakamlariGuncelle();
        } catch (err) {
            console.error("❌ Sipariş işleme hatası:", err);
        }
    });

    // SİPARİŞ TESLİM EDİLDİĞİNDE
    socket.on('siparis_teslim_edildi', async (id) => {
        try {
            if (!id || !mongoose.Types.ObjectId.isValid(id)) return;
            await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
            io.emit('siparis_teslim_onayi', id);
            console.log(`🚚 Sipariş teslim edildi: ${id}`);
        } catch (err) {
            console.error("Teslim hatası:", err);
        }
    });

    // MASA DETAYI (ADİSYON)
    socket.on('masa_detay_iste', async (masaNo) => {
        try {
            const siparisler = await Siparis.find({ masaNo, durum: { $ne: 'tamamlandi' } });
            socket.emit('masa_detay_verisi', { masaNo, siparisler });
        } catch (err) {
            console.error("Masa detay hatası:", err);
        }
    });

    // HESABI KAPAT
    socket.on('hesap_kapat', async (masaNo) => {
        try {
            await Siparis.updateMany({ masaNo, durum: { $ne: 'tamamlandi' } }, { durum: 'tamamlandi' });
            io.emit('masa_sifirla', masaNo);
            rakamlariGuncelle();
            console.log(`💰 Masa ${masaNo} hesabı kapatıldı.`);
        } catch (err) {
            console.error("Hesap kapatma hatası:", err);
        }
    });

    // GÜNÜ KAPAT
    socket.on('gunu_kapat_onay', async () => {
        try {
            await Siparis.updateMany({ durum: { $ne: 'tamamlandi' } }, { durum: 'tamamlandi' });
            io.emit('ekrani_temizle');
            rakamlariGuncelle();
        } catch (err) {
            console.error("Günü kapatma hatası:", err);
        }
    });

    rakamlariGuncelle();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu ${PORT} portunda aktif.`);
});