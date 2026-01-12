// Path: qr-uret.js
const QRCode = require('qrcode');
const fs = require('fs');

if (!fs.existsSync('./public/qrcodes')) {
    fs.mkdirSync('./public/qrcodes', { recursive: true });
}

const IP = '192.168.1.100'; // Senin sabit IP adresin
const PORT = 3000;

for (let i = 1; i <= 35; i++) {
    const link = `http://${IP}:${PORT}/menu/${i}`;
    QRCode.toFile(`./public/qrcodes/masa-${i}.png`, link, (err) => {
        if (err) console.log(err);
        console.log(`Masa ${i} QR Kodu Hazır!`);
    });
}