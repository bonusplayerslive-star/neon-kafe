
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

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Bağlantısı Başarılı"))
    .catch(err => console.error("❌ Veritabanı Hatası:", err));

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function rakamlariGuncelle() {
    try {
        const raporlar = await Rapor.find();
        let ciro = 0, kar = 0;
        raporlar.forEach(r => { ciro += r.tutar || 0; kar += r.kar || 0; });
        io.emit('rakamGuncelleme', { ciro, kar });
    } catch (err) { console.error(err); }
}

app.get(['/', '/menu/:masaNo'], async (req, res) => {
    const masaNo = req.params.masaNo || '0';
    const urunler = await Urun.find({ stok: { $gt: 0 } });
    res.render('menu', { masaNo, urunler });
});

app.get('/admin', async (req, res) => {
    const urunler = await Urun.find();
    const siparisler = await Siparis.find().sort({ _id: -1 });
    res.render('admin', { urunler, siparisler, adminPass: ADMIN_PASS });
});

app.post('/admin/urun-ekle', async (req, res) => {
    try {
        await Urun.create({ ...req.body, fiyat: parseFloat(req.body.fiyat), maliyet: parseFloat(req.body.maliyet), stok: parseInt(req.body.stok) });
        res.redirect('/admin');
    } catch (err) { res.redirect('/admin'); }
});

io.on('connection', (socket) => {
    socket.on('admin_giris', async () => {
        await rakamlariGuncelle();
        const aktifler = await Siparis.find();
        aktifler.forEach(s => {
            const data = s.toObject();
            data.id = s._id.toString();
            socket.emit('yeniSiparisBildirimi', data);
        });
        const doluMasalar = [...new Set(aktifler.map(s => s.masaNo))];
        doluMasalar.forEach(mNo => socket.emit('masa_durum_guncelle', { masaNo: mNo, durum: 'dolu' }));
    });

    socket.on('yeni_siparis', async (data) => {
        const { masa, urunler } = data;
        for (const item of urunler) {
            const urunDb = await Urun.findOne({ ad: item.ad });
            if (urunDb) {
                if (urunDb.stok > 0) { urunDb.stok -= 1; await urunDb.save(); }
                const yeni = await Siparis.create({
                    masaNo: masa, urunAd: item.ad, fiyat: urunDb.fiyat,
                    maliyet: urunDb.maliyet, durum: 'bekliyor'
                });
                const emitData = yeni.toObject();
                emitData.id = yeni._id.toString();
                io.emit('yeniSiparisBildirimi', emitData);
                io.emit('masa_durum_guncelle', { masaNo: masa, durum: 'dolu' });
            }
        }
    });

    socket.on('siparis_teslim_edildi', async (id) => {
        if (!id || id.length !== 24) return;
        await Siparis.findByIdAndUpdate(id, { durum: 'teslim_edildi' });
        io.emit('siparis_teslim_onayi', id);
    });

    socket.on('masa_detay_iste', async (masaNo) => {
        const siparisler = await Siparis.find({ masaNo: masaNo.toString() });
        socket.emit('masa_detay_verisi', { masaNo, siparisler });
    });

    socket.on('hesap_kapat', async (masaNo) => {
        const siparisler = await Siparis.find({ masaNo: masaNo.toString() });
        for (const s of siparisler) {
            await Rapor.create({
                saat: new Date().toLocaleTimeString('tr-TR'),
                masa: s.masaNo, urun: s.urunAd, tutar: s.fiyat,
                kar: s.fiyat - (s.maliyet || 0)
            });
        }
        await Siparis.deleteMany({ masaNo: masaNo.toString() });
        await rakamlariGuncelle();
        io.emit('masa_sifirla', masaNo);
        io.emit('masa_durum_guncelle', { masaNo, durum: 'bos' });
    });

    socket.on('urun_sil', async (id) => { await Urun.findByIdAndDelete(id); });
    socket.on('stok_guncelle', async (data) => { await Urun.findByIdAndUpdate(data.id, { stok: data.stok }); });
});

http.listen(process.env.PORT || 3000, () => console.log("🚀 Sistem Aktif"));
