// Minimal electron stub so proxy/control smoke tests can run under plain node
// (the proxy path never touches nativeImage/safeStorage).
module.exports = {
    nativeImage: { createFromBuffer: () => ({ resize: () => ({ toBitmap: () => Buffer.alloc(0) }), getSize: () => ({ width: 0, height: 0 }) }) },
    safeStorage: { isEncryptionAvailable: () => false },
};
