const mongoose = require('mongoose');

// Ürün Şeması (Depo)
const UrunSchema = new mongoose.Schema({
    ad: { type: String, required: true },
    fiyat: { type: Number, default: 0 },
    maliyet: { type: Number, default: 0 },
    stok: { type: Number, default: 0 }
});

// Aktif Siparişler Şeması (Mutfak Akışı)
const SiparisSchema = new mongoose.Schema({
    masaNo: String,
    urunAd: String,
    fiyat: Number,
    maliyet: Number,
    zaman: { type: String, default: () => new Date().toLocaleTimeString('tr-TR') },
    durum: { type: String, default: 'bekliyor' } // bekliyor, teslim_edildi
});

// Günlük Rapor Şeması
const RaporSchema = new mongoose.Schema({
    tarih: { type: String, default: () => new Date().toLocaleDateString('tr-TR') },
    saat: String,
    masa: String,
    urun: String,
    tutar: Number,
    kar: Number
});

const Urun = mongoose.model('Urun', UrunSchema);
const Siparis = mongoose.model('Siparis', SiparisSchema);
const Rapor = mongoose.model('Rapor', RaporSchema);

module.exports = { Urun, Siparis, Rapor };
